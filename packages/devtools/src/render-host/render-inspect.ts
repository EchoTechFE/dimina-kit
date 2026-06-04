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
// (highlightElement/unhighlightElement) + the WXML source's tree computation,
// so the WXML panel and element-inspect resolve sids against ONE registry per
// guest. Idempotent: re-injection keeps the first registry (synthetic sids
// minted during getWxml must survive until the following highlight).
import type { ElementInspection } from '../shared/ipc-channels.js'
import { findElementBySid, type WxmlNode } from '../preload/shared/sid-registry.js'
import { walkInstance, type ComponentInstance } from '../preload/instrumentation/wxml-extract.js'

interface RenderInspectApi {
  getWxml(): WxmlNode | null
  highlightElement(sid: string): ElementInspection | null
  unhighlightElement(): void
}

const g = globalThis as unknown as { __diminaRenderInspect?: RenderInspectApi }

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

  let overlay: HTMLDivElement | null = null
  const ensureOverlay = (): HTMLDivElement => {
    if (overlay && overlay.ownerDocument === document) return overlay
    overlay = document.createElement('div')
    overlay.id = '__simulator-highlight'
    overlay.style.cssText =
      'position:fixed;pointer-events:none;z-index:999999;' +
      'border:2px solid #1a73e8;background:rgba(26,115,232,0.12);' +
      'transition:all 0.1s ease;display:none;border-radius:2px;box-sizing:border-box;'
    document.body.appendChild(overlay)
    return overlay
  }

  const highlightElement = (sid: string): ElementInspection | null => {
    if (!sid) return null
    const el = findElementBySid(document, sid)
    if (!el) return null
    const rect = el.getBoundingClientRect()
    const box = ensureOverlay()
    box.style.left = `${rect.left}px`
    box.style.top = `${rect.top}px`
    box.style.width = `${rect.width}px`
    box.style.height = `${rect.height}px`
    box.style.display = 'block'
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

  const unhighlightElement = (): void => {
    if (overlay) overlay.style.display = 'none'
  }

  g.__diminaRenderInspect = { getWxml, highlightElement, unhighlightElement }
}
