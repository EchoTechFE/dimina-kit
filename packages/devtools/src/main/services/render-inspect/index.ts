/**
 * RenderInspector — native-host element/WXML access into a render-host
 * <webview> guest.
 *
 * Injects the bundled `render-inspect` IIFE (dist/render-host/render-inspect.js,
 * exposing `window.__diminaRenderInspect`) into the guest's MAIN world via
 * `executeJavaScript`, then drives it to read the WXML tree and
 * highlight/unhighlight elements by sid. Injection is idempotent per
 * WebContents id (the guest IIFE also self-guards); the injected-set entry is
 * cleared when the wc is destroyed so a recycled id re-injects.
 *
 * The page's Vue tree + geometry live in the guest main world, and
 * executeJavaScript (no worldId) runs there too — so the inspector, the DOM it
 * reads, and the sid registry all share one realm. See render-inspect.ts.
 */
import type { WebContents } from 'electron'
import type { ConnectionRegistry } from '@dimina-kit/electron-deck/main'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { devtoolsPackageRoot } from '../../utils/paths.js'
import type { ElementInspection } from '../../../shared/ipc-channels.js'
import type { WxmlNode } from '@dimina-kit/inspect'
import { createCdpSessionBroker, type CdpSessionBroker } from '../cdp-session/index.js'

export interface RenderInspector {
  /** Inject (once per wc) the inspector IIFE, then read the WXML tree. */
  getWxml(wc: WebContents): Promise<WxmlNode | null>
  /** Inject (once per wc), then highlight the element with `sid`. */
  highlight(wc: WebContents, sid: string): Promise<ElementInspection | null>
  /** Clear any highlight overlay in the guest. */
  unhighlight(wc: WebContents): Promise<void>
  /**
   * Toggle the guest-side WXML MutationObserver. When on, the injected IIFE
   * watches `document.body` and posts a debounced `wxmlChanged` over
   * `DiminaRenderBridge` on every DOM mutation (setData), which bridge-router
   * turns into a `domMutated` render event so the WXML panel re-pulls. Only
   * enabled while the WXML panel is visible, so an unseen panel never drives a
   * full Vue-tree walk. Injects the IIFE first if needed; no-op on a dead guest.
   */
  setWxmlObserving(wc: WebContents, on: boolean): Promise<void>
}

export interface RenderInspectorOptions {
  /** Override the injected IIFE source (default: read the built bundle). Test seam. */
  loadSource?: () => string
  /**
   * Connection registry (see foundation.md's teardown-paths section). When provided, the per-wc
   * `injected` bookkeeping is torn down via the wc's connection (deterministic
   * with the rest of that webContents's resources) instead of a bespoke
   * `once('destroyed')`. Optional so focused unit tests can omit it (they fall
   * back to the direct `once('destroyed')`).
   */
  connections?: ConnectionRegistry
  /**
   * Shared CDP session broker (see cdp-session/index.ts) that owns every
   * render-guest debugger session's attach/detach lifecycle — safe-area,
   * elements-forward and network-forward acquire leases from the same
   * instance. Absent → a private broker is created (never explicitly torn
   * down here, matching this module's existing lack of a `dispose()`; the
   * shared instance IS disposed at the app-context level).
   */
  broker?: CdpSessionBroker
}

const DEFAULT_SOURCE_PATH = 'dist/render-host/render-inspect.js'

/**
 * Chrome DevTools' default Elements-panel highlight palette (content / padding /
 * border / margin tints + the size tooltip). Mirroring it makes the WXML panel's
 * hover box visually identical to the embedded Elements panel's.
 */
const HIGHLIGHT_CONFIG = {
  showInfo: true,
  showRulers: false,
  showExtensionLines: false,
  contentColor: { r: 111, g: 168, b: 220, a: 0.66 },
  paddingColor: { r: 147, g: 196, b: 125, a: 0.55 },
  borderColor: { r: 255, g: 229, b: 153, a: 0.66 },
  marginColor: { r: 246, g: 178, b: 107, a: 0.66 },
} as const

/** Object group for the per-hover `Runtime.evaluate` reference, released after the draw. */
const HOVER_OBJECT_GROUP = 'render-inspect-hover'

/**
 * Upper bound on awaiting the `DOM.enable → Overlay.enable` handshake before
 * highlighting. A hung `DOM.enable` then degrades to a missed paint instead of a
 * stuck hover.
 */
const ENABLE_HANDSHAKE_TIMEOUT_MS = 500

/** Resolve when `p` settles or `ms` elapses, whichever comes first (never rejects). */
function withTimeout(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    p.then(() => { clearTimeout(timer); resolve() }, () => { clearTimeout(timer); resolve() })
  })
}

export function createRenderInspector(options: RenderInspectorOptions = {}): RenderInspector {
  const loadSource =
    options.loadSource ??
    (() => readFileSync(path.join(devtoolsPackageRoot, DEFAULT_SOURCE_PATH), 'utf8'))
  let cachedSource: string | null = null
  const injected = new Set<number>()
  // Shared CDP session broker — owns attach/detach/enable-domain bookkeeping
  // (see cdp-session/index.ts); this module no longer tracks any of that itself.
  const broker = options.broker ?? createCdpSessionBroker({ connections: options.connections })

  function source(): string {
    if (cachedSource === null) cachedSource = loadSource()
    return cachedSource
  }

  /** Inject the IIFE once per live wc. Returns false if the guest is unusable. */
  async function ensureInjected(wc: WebContents): Promise<boolean> {
    if (wc.isDestroyed()) return false
    if (injected.has(wc.id)) return true
    let src: string
    try {
      src = source()
    } catch (e) {
      console.warn('[render-inspect] failed to load inspector source:', (e as Error).message)
      return false
    }
    try {
      await wc.executeJavaScript(src)
    } catch (e) {
      console.warn('[render-inspect] inject failed:', (e as Error).message)
      return false
    }
    injected.add(wc.id)
    // Consolidate the per-wc bookkeeping teardown onto the connection layer
    // (see foundation.md) when a registry is available; fall back to the
    // bespoke `once('destroyed')` only when omitted (focused unit tests).
    const forget = (): void => {
      injected.delete(wc.id)
    }
    if (options.connections) {
      options.connections.acquire(wc).own(forget)
    } else {
      wc.once('destroyed', forget)
    }
    return true
  }

  async function getWxml(wc: WebContents): Promise<WxmlNode | null> {
    if (wc.isDestroyed()) return null
    if (!(await ensureInjected(wc))) return null
    try {
      const result = await wc.executeJavaScript(
        'window.__diminaRenderInspect ? window.__diminaRenderInspect.getWxml() : null',
      )
      return (result as WxmlNode | null) ?? null
    } catch {
      return null
    }
  }

  async function highlight(wc: WebContents, sid: string): Promise<ElementInspection | null> {
    if (wc.isDestroyed()) return null
    if (!(await ensureInjected(wc))) return null
    let inspection: ElementInspection | null
    try {
      const result = await wc.executeJavaScript(
        `window.__diminaRenderInspect ? window.__diminaRenderInspect.highlightElement(${JSON.stringify(sid)}) : null`,
      )
      inspection = (result as ElementInspection | null) ?? null
    } catch {
      return null
    }
    // No geometry → nothing to draw; never touch the debugger.
    if (!inspection) return null
    // Draw the native overlay best-effort: the inspection data must survive even
    // if the CDP draw fails, so a rejected debugger step never propagates.
    await drawNativeHighlight(wc, sid).catch(() => { /* best-effort draw */ })
    return inspection
  }

  /**
   * Paint the Chrome-style native highlight over the guest via CDP — the same
   * `Overlay.highlightNode` the embedded Elements panel uses, so the WXML panel's
   * hover box matches it exactly. Acquires a lease from the shared broker (see
   * cdp-session/index.ts), which reuses the guest's existing debugger session
   * (safe-area / elements-forward has usually already attached it) and only
   * attaches itself when nobody has.
   *
   * `Overlay.highlightNode` paints only while the Overlay domain is enabled, and
   * Chromium rejects `Overlay.enable` with "DOM should be enabled first" unless
   * DOM is enabled first. On a cold/self-attached session (WXML hovered without
   * the Elements panel ever enabling Overlay) the highlight would silently no-op
   * if the command raced ahead of the enable, so we AWAIT the broker's
   * `ensureRenderDomains()` handshake before highlighting — but only up to
   * `ENABLE_HANDSHAKE_TIMEOUT_MS`, so a hung `DOM.enable` degrades to a missed
   * paint rather than a stuck hover.
   *
   * The `Runtime.evaluate` runs in a named object group whose remote references
   * are released in `finally`; otherwise every hover would leak a live DOM
   * wrapper into the guest's execution context.
   */
  async function drawNativeHighlight(wc: WebContents, sid: string): Promise<void> {
    if (wc.isDestroyed()) return
    const lease = broker.acquire(wc)
    if (!lease) return
    await withTimeout(lease.ensureRenderDomains(), ENABLE_HANDSHAKE_TIMEOUT_MS)
    if (wc.isDestroyed()) return
    const expression = `window.__diminaRenderInspect && window.__diminaRenderInspect.elementFor(${JSON.stringify(sid)})`
    try {
      const evaluated = await lease.send('Runtime.evaluate', {
        expression,
        returnByValue: false,
        objectGroup: HOVER_OBJECT_GROUP,
      })
      const objectId = (evaluated as { result?: { objectId?: string } } | null)?.result?.objectId
      if (!objectId) return
      await lease.send('Overlay.highlightNode', {
        objectId,
        highlightConfig: HIGHLIGHT_CONFIG,
      })
    } finally {
      // Drop the hover's remote DOM reference so repeated hovers don't accumulate
      // live wrappers in the guest context.
      lease
        .send('Runtime.releaseObjectGroup', { objectGroup: HOVER_OBJECT_GROUP })
        .catch(() => { /* guest gone */ })
    }
  }

  async function unhighlight(wc: WebContents): Promise<void> {
    if (wc.isDestroyed()) return
    try {
      await wc.debugger.sendCommand('Overlay.hideHighlight')
    } catch {
      // best-effort
    }
  }

  async function setWxmlObserving(wc: WebContents, on: boolean): Promise<void> {
    if (wc.isDestroyed()) return
    if (!(await ensureInjected(wc))) return
    try {
      await wc.executeJavaScript(
        `window.__diminaRenderInspect && window.__diminaRenderInspect.setWxmlObserving(${on ? 'true' : 'false'})`,
      )
    } catch {
      // best-effort: a guest mid-teardown just stops observing on its own.
    }
  }

  return { getWxml, highlight, unhighlight, setWxmlObserving }
}
