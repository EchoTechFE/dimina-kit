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
import type { WxmlNode } from '../../../preload/shared/sid-registry.js'

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
   * Connection registry (foundation.md §4 / P2). When provided, the per-wc
   * `injected` bookkeeping is torn down via the wc's connection (deterministic
   * with the rest of that webContents's resources) instead of a bespoke
   * `once('destroyed')`. Optional so focused unit tests can omit it (they fall
   * back to the direct `once('destroyed')`).
   */
  connections?: ConnectionRegistry
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
  // Debugger sessions THIS service attached itself (nobody else owned one). Only
  // these are detached on guest-destroy; sessions safe-area / Elements-forward
  // own are never touched (single-owner per wc).
  const selfAttached = new Set<number>()
  // Per-wc `DOM.enable → Overlay.enable` handshake, started once and reused so a
  // burst of hovers shares one enable. Cleared when the guest is destroyed.
  const enablePromises = new Map<number, Promise<void>>()

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
    // (foundation.md §4 / P2) when a registry is available; fall back to the
    // bespoke `once('destroyed')` only when omitted (focused unit tests).
    const forget = (): void => {
      injected.delete(wc.id)
      enablePromises.delete(wc.id)
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
      const result: WxmlNode | null = (await wc.executeJavaScript(
        'window.__diminaRenderInspect ? window.__diminaRenderInspect.getWxml() : null',
      )) as WxmlNode | null
      return result ?? null
    } catch {
      return null
    }
  }

  async function highlight(wc: WebContents, sid: string): Promise<ElementInspection | null> {
    if (wc.isDestroyed()) return null
    if (!(await ensureInjected(wc))) return null
    let inspection: ElementInspection | null
    try {
      const result: ElementInspection | null = (await wc.executeJavaScript(
        `window.__diminaRenderInspect ? window.__diminaRenderInspect.highlightElement(${JSON.stringify(sid)}) : null`,
      )) as ElementInspection | null
      inspection = result ?? null
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
   * hover box matches it exactly. Reuses the guest's existing debugger session
   * (single-owner per wc; safe-area / Elements-forward has usually already
   * attached it) and only attaches itself when nobody has.
   *
   * `Overlay.highlightNode` paints only while the Overlay domain is enabled, and
   * Chromium rejects `Overlay.enable` with "DOM should be enabled first" unless
   * DOM is enabled first. On a cold/self-attached session (WXML hovered without
   * the Elements panel ever enabling Overlay) the highlight would silently no-op
   * if the command raced ahead of the enable, so we AWAIT the `DOM.enable →
   * Overlay.enable` handshake before highlighting — but only up to
   * `ENABLE_HANDSHAKE_TIMEOUT_MS`, so a hung `DOM.enable` degrades to a missed
   * paint rather than a stuck hover.
   *
   * The `Runtime.evaluate` runs in a named object group whose remote references
   * are released in `finally`; otherwise every hover would leak a live DOM
   * wrapper into the guest's execution context.
   */
  async function drawNativeHighlight(wc: WebContents, sid: string): Promise<void> {
    if (wc.isDestroyed()) return
    if (!ensureGuestDebugger(wc)) return
    await withTimeout(ensureDomainsEnabled(wc), ENABLE_HANDSHAKE_TIMEOUT_MS)
    if (wc.isDestroyed()) return
    const expression = `window.__diminaRenderInspect && window.__diminaRenderInspect.elementFor(${JSON.stringify(sid)})`
    try {
      const evaluated: { result?: { objectId?: string } } | null = (await wc.debugger.sendCommand('Runtime.evaluate', {
        expression,
        returnByValue: false,
        objectGroup: HOVER_OBJECT_GROUP,
      })) as { result?: { objectId?: string } } | null
      const objectId = evaluated?.result?.objectId
      if (!objectId) return
      await wc.debugger.sendCommand('Overlay.highlightNode', {
        objectId,
        highlightConfig: HIGHLIGHT_CONFIG,
      })
    } finally {
      // Drop the hover's remote DOM reference so repeated hovers don't accumulate
      // live wrappers in the guest context.
      wc.debugger
        .sendCommand('Runtime.releaseObjectGroup', { objectGroup: HOVER_OBJECT_GROUP })
        .catch(() => { /* guest gone */ })
    }
  }

  /**
   * Ensure the guest's debugger is usable WITHOUT opening a second session: a
   * webContents debugger is single-owner, so reuse the already-attached session
   * (Elements-forward / safe-area) and only `attach('1.3')` when nobody has. The
   * sessions we open ourselves are tracked so guest-destroy detaches only ours.
   * Returns false when the debugger can't be made usable.
   */
  function ensureGuestDebugger(wc: WebContents): boolean {
    try {
      if (wc.debugger.isAttached()) return true
    } catch {
      return false
    }
    try {
      wc.debugger.attach('1.3')
      trackSelfAttached(wc)
      return true
    } catch {
      // A concurrent attach (race) leaves it usable; anything else is a failure.
      try { return wc.debugger.isAttached() } catch { return false }
    }
  }

  /** Record a self-attached session and detach it when the guest is destroyed. */
  function trackSelfAttached(wc: WebContents): void {
    if (selfAttached.has(wc.id)) return
    selfAttached.add(wc.id)
    const detach = (): void => {
      selfAttached.delete(wc.id)
      try {
        if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach()
      } catch { /* already gone */ }
    }
    if (options.connections) options.connections.acquire(wc).own(detach)
    else { try { wc.once('destroyed', () => selfAttached.delete(wc.id)) } catch { /* fake wc */ } }
  }

  /**
   * Enable the DOM + Overlay render domains in dependency order, ONCE per guest
   * (the promise is cached + reused across hovers). `Overlay.enable` is sent ONLY
   * AFTER `DOM.enable` resolves (Chromium rejects it otherwise). Resolves when
   * Overlay is enabled; a rejection at any step is swallowed (the guest may be
   * mid-teardown) and the cache entry is dropped so a later hover can retry.
   */
  function ensureDomainsEnabled(wc: WebContents): Promise<void> {
    const cached = enablePromises.get(wc.id)
    if (cached) return cached
    wc.debugger.sendCommand('CSS.enable').catch(() => { /* guest mid-destroy */ })
    const handshake = wc.debugger
      .sendCommand('DOM.enable')
      .then(() => {
        if (wc.isDestroyed()) return
        return wc.debugger.sendCommand('Overlay.enable')
      })
      .then(() => undefined)
      .catch(() => {
        // Allow a retry on the next hover (e.g. the guest was mid-destroy).
        enablePromises.delete(wc.id)
      })
    enablePromises.set(wc.id, handshake)
    return handshake
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
