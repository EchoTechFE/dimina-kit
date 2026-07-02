// Native-host render-guest inspector. Bundled to a self-contained IIFE
// (dist/render-host/render-inspect.js) and INJECTED by the main process into
// each render-host <webview>'s main world via `renderWc.executeJavaScript`.
//
// Why injection rather than the render-host preload: the page's Vue tree
// (`document.body.__vue_app__`) and geometry live in the guest MAIN world, and
// `executeJavaScript` (no worldId) runs there too — so injecting keeps the
// inspector, the DOM it reads, and the sid registry all in one realm. It also
// avoids the preload `require()`-a-sibling sandbox caveat and duplicating the
// ~250-line walk logic (we reuse wxml-extract verbatim through the bundle).
//
// The exposed surface mirrors the iframe-path `__simulatorData`
// (getWxml/highlightElement/unhighlightElement) + `elementFor`, so the WXML
// panel and element-inspect resolve sids against ONE registry per guest.
// `highlightElement` only MEASURES (rect + computed style); the visual highlight
// is drawn natively by the main process via CDP `Overlay.highlightNode` over the
// guest's debugger session — the same overlay the embedded Chrome Elements panel
// uses. `elementFor` returns the live element so main can grab a CDP objectId for
// that command. Idempotent: re-injection keeps the first registry (synthetic
// sids minted during getWxml must survive until the following highlight).
import type { ElementInspection } from '../shared/ipc-channels.js'
import { findElementBySid, type WxmlNode } from '../preload/shared/sid-registry.js'
import { walkInstance, type ComponentInstance } from '../preload/instrumentation/wxml-extract.js'

interface RenderInspectApi {
  getWxml(): WxmlNode | null
  /**
   * Measure the element with `sid`: its bounding rect + computed style. The
   * visual highlight is drawn natively by the main process via CDP
   * `Overlay.highlightNode` over the guest's debugger session (the same overlay
   * the embedded Chrome Elements panel uses), so this only returns data — it
   * does NOT paint anything in the guest.
   */
  highlightElement(sid: string): ElementInspection | null
  /** Resolve the sid to its live DOM element so main can grab a CDP objectId. */
  elementFor(sid: string): HTMLElement | null
  unhighlightElement(): void
  /**
   * Start/stop watching the page DOM. While on, a debounced MutationObserver
   * posts a `wxmlChanged` message over `DiminaRenderBridge` on every DOM change
   * (setData re-render), so main re-pulls the WXML tree — keeping the panel live
   * without polling. Main only turns this on while the WXML panel is visible.
   */
  setWxmlObserving(on: boolean): void
}

/** Coalesce a burst of setData-driven mutations into one notify per frame-ish. */
const WXML_MUTATION_DEBOUNCE_MS = 200

const g = globalThis as unknown as {
  __diminaRenderInspect?: RenderInspectApi
  DiminaRenderBridge?: { invoke(msg: { type: string; target: string; body: unknown }): void }
}

if (!g.__diminaRenderInspect) {
  // Mirror wxml.ts getVueAppFromIframe, but the guest's own `document` IS the
  // page document (no iframe hop) — render.js mounts createApp().mount(document.body).
  const getVueApp = (): ComponentInstance | null => {
    try {
      const body = document.body as unknown as Record<string, unknown> | null
      const app = body?.__vue_app__ as Record<string, unknown> | undefined
      if (!app) return null
      if (app._instance) return app._instance as ComponentInstance
      const container = app._container as Record<string, unknown> | undefined
      const vnode = container?._vnode as Record<string, unknown> | undefined
      return (vnode?.component as ComponentInstance | null) ?? null
    } catch {
      return null
    }
  }

  const getWxml = (): WxmlNode | null => {
    const instance = getVueApp()
    if (!instance) return null
    const tree = walkInstance(instance, 0)
    if (!tree) return null
    return Array.isArray(tree)
      ? { tagName: '#fragment', attrs: {}, children: tree }
      : tree
  }

  const elementFor = (sid: string): HTMLElement | null => {
    if (!sid) return null
    return findElementBySid(document, sid)
  }

  const highlightElement = (sid: string): ElementInspection | null => {
    const el = elementFor(sid)
    if (!el) return null
    const rect = el.getBoundingClientRect()
    const style = el.ownerDocument.defaultView?.getComputedStyle(el)
    if (!style) return null
    return {
      sid,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      style: {
        display: style.display,
        position: style.position,
        boxSizing: style.boxSizing,
        margin: style.margin,
        padding: style.padding,
        color: style.color,
        backgroundColor: style.backgroundColor,
        fontSize: style.fontSize,
      },
    }
  }

  // The native Overlay is cleared by the main process via CDP
  // `Overlay.hideHighlight`; the guest has no div to hide, so this is a no-op
  // kept for the iframe-path API parity the surface comment documents.
  const unhighlightElement = (): void => {}

  // ── Live WXML: watch the page DOM and notify main on mutation ──────────────
  // `getWxml`/`highlightElement` are read-only (highlight paints via CDP Overlay,
  // not DOM), so the observer never re-triggers itself. Debounced so a setData
  // burst coalesces into a single `wxmlChanged` post; main re-pulls the tree.
  let observer: MutationObserver | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  const notifyMutated = (): void => {
    debounceTimer = null
    g.DiminaRenderBridge?.invoke({ type: 'wxmlChanged', target: 'container', body: {} })
  }

  const setWxmlObserving = (on: boolean): void => {
    if (on) {
      if (observer) return
      observer = new MutationObserver(() => {
        if (debounceTimer !== null) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(notifyMutated, WXML_MUTATION_DEBOUNCE_MS)
      })
      // Main may enable observing before the guest DOM is up (SetActive can fire
      // before the page's `document.body` exists). Observing a null body throws,
      // so defer to DOMContentLoaded when needed — but bail if observing was
      // turned off again before the body arrived.
      const begin = (): void => {
        if (!observer || !document.body) return
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        })
      }
      if (document.body) begin()
      else document.addEventListener('DOMContentLoaded', begin, { once: true })
    } else {
      if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null }
      observer?.disconnect()
      observer = null
    }
  }

  g.__diminaRenderInspect = { getWxml, highlightElement, elementFor, unhighlightElement, setWxmlObserving }
}
