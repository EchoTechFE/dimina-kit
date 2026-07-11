// Native-host render-guest inspector. Bundled to a self-contained IIFE
// (dist/render-host/render-inspect.js) and INJECTED by the main process into
// each render-host <webview>'s main world via `renderWc.executeJavaScript`.
//
// Why injection rather than the render-host preload: the page's Vue tree
// (`document.body.__vue_app__`) and geometry live in the guest MAIN world, and
// `executeJavaScript` (no worldId) runs there too — so injecting keeps the
// inspector, the DOM it reads, and the sid registry all in one realm. It also
// avoids the preload `require()`-a-sibling sandbox caveat. The walk/measure/
// observe logic lives in @dimina-kit/inspect (shared across hosts) and is
// reused through the bundle — this file only wires it to the Electron-side
// transport (`DiminaRenderBridge`).
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
import { createWxmlInspector, type WxmlNode } from '@dimina-kit/inspect'

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

const g = globalThis as unknown as {
  __diminaRenderInspect?: RenderInspectApi
  DiminaRenderBridge?: { invoke(msg: { type: string; target: string; body: unknown }): void }
}

if (!g.__diminaRenderInspect) {
  // The guest's own `document` IS the page document (no iframe hop) —
  // render.js mounts createApp().mount(document.body).
  const inspector = createWxmlInspector({
    onMutated: () => g.DiminaRenderBridge?.invoke({ type: 'wxmlChanged', target: 'container', body: {} }),
  })

  // The native Overlay is cleared by the main process via CDP
  // `Overlay.hideHighlight`; the guest has no div to hide, so this is a no-op
  // kept for the iframe-path API parity the surface comment documents.
  const unhighlightElement = (): void => {}

  g.__diminaRenderInspect = {
    getWxml: inspector.getWxml,
    highlightElement: inspector.highlightElement,
    elementFor: inspector.elementFor,
    unhighlightElement,
    setWxmlObserving: inspector.setObserving,
  }
}
