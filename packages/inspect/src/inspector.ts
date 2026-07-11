// Host-agnostic WXML inspector over a render-layer document. It owns the
// three read paths every host needs — Vue-tree walk (getWxml), sid → element
// resolution (elementFor), element measurement (highlightElement) — plus the
// visibility-gated DOM observer that debounces a setData burst into a single
// onMutated callback. Hosts wire the callback to their own transport
// (Electron bridge message, iframe postMessage, …) and draw any visual
// highlight themselves: every method here is strictly read-only on the page.
import { findElementBySid } from './sid-registry.js'
import { walkInstance, type ComponentInstance } from './wxml-extract.js'
import type { ElementInspection, WxmlNode } from './types.js'

export interface WxmlInspectorOptions {
  /** Document hosting the mounted Vue app. Defaults to `globalThis.document`. */
  document?: Document
  /** Called (debounced) on every DOM change while observing is on. */
  onMutated?: () => void
  /** Debounce window for mutation bursts. Defaults to 200ms. */
  debounceMs?: number
}

export interface WxmlInspector {
  /** Walk `document.body.__vue_app__` into a WxmlNode tree. Multiple roots are
   * wrapped in a synthetic `#fragment`; no app / empty tree → null. */
  getWxml(): WxmlNode | null
  /** Measure the element with `sid`: bounding rect + the computed-style subset
   * the panel footer shows. Read-only — drawing a highlight is the host's job. */
  highlightElement(sid: string): ElementInspection | null
  /** Resolve the sid to its live DOM element (synthetic registry or data-sid). */
  elementFor(sid: string): HTMLElement | null
  /** Start/stop watching the page DOM. Idempotent in both directions; turning
   * off cancels a pending debounced callback. */
  setObserving(on: boolean): void
  /** Stop observing; the instance produces no further callbacks. */
  dispose(): void
}

/** Coalesce a burst of setData-driven mutations into one notify per frame-ish. */
const DEFAULT_DEBOUNCE_MS = 200

export function createWxmlInspector(options: WxmlInspectorOptions = {}): WxmlInspector {
  const doc = options.document ?? globalThis.document
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const onMutated = options.onMutated

  const getVueApp = (): ComponentInstance | null => {
    try {
      const body = doc?.body as unknown as Record<string, unknown> | null
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
    return findElementBySid(doc, sid)
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

  // getWxml/highlightElement are read-only, so the observer never re-triggers
  // itself. Debounced so a setData burst coalesces into a single callback.
  let observer: MutationObserver | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  const notifyMutated = (): void => {
    debounceTimer = null
    onMutated?.()
  }

  const setObserving = (on: boolean): void => {
    if (on) {
      if (observer) return
      observer = new MutationObserver(() => {
        if (debounceTimer !== null) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(notifyMutated, debounceMs)
      })
      // The host may enable observing before the page DOM is up. Observing a
      // null body throws, so defer to DOMContentLoaded when needed — but bail
      // if observing was turned off again before the body arrived.
      const begin = (): void => {
        if (!observer || !doc.body) return
        observer.observe(doc.body, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        })
      }
      if (doc.body) begin()
      else doc.addEventListener('DOMContentLoaded', begin, { once: true })
    } else {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      observer?.disconnect()
      observer = null
    }
  }

  return {
    getWxml,
    highlightElement,
    elementFor,
    setObserving,
    dispose: () => setObserving(false),
  }
}
