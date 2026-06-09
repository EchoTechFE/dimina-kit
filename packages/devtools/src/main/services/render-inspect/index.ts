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

export function createRenderInspector(options: RenderInspectorOptions = {}): RenderInspector {
  const loadSource =
    options.loadSource ??
    (() => readFileSync(path.join(devtoolsPackageRoot, DEFAULT_SOURCE_PATH), 'utf8'))
  let cachedSource: string | null = null
  const injected = new Set<number>()

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
    if (options.connections) {
      options.connections.acquire(wc).own(() => injected.delete(wc.id))
    } else {
      wc.once('destroyed', () => injected.delete(wc.id))
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
    try {
      const result = await wc.executeJavaScript(
        `window.__diminaRenderInspect ? window.__diminaRenderInspect.highlightElement(${JSON.stringify(sid)}) : null`,
      )
      return (result as ElementInspection | null) ?? null
    } catch {
      return null
    }
  }

  async function unhighlight(wc: WebContents): Promise<void> {
    if (wc.isDestroyed()) return
    if (!(await ensureInjected(wc))) return
    try {
      await wc.executeJavaScript(
        'window.__diminaRenderInspect && window.__diminaRenderInspect.unhighlightElement && window.__diminaRenderInspect.unhighlightElement()',
      )
    } catch {
      // best-effort
    }
  }

  return { getWxml, highlight, unhighlight }
}
