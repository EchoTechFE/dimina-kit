import type { ElementRef } from './shared.js'

// ── Element Registry ──────────────────────────────────────────────────
// miniprogram-automator references elements by elementId. Since we execute
// JS in the simulator via executeJavaScript (no persistent references),
// we store the CSS selector path for each elementId so subsequent calls
// can re-locate the element.

export const elementRegistry = new Map<string, ElementRef>()
export let nextElementId = 1

export function registerElement(selector: string, index: number, pageId: number): string {
  const id = `el_${nextElementId++}`
  elementRegistry.set(id, { selector, index, pageId })
  return id
}

export function getElementRef(params: Record<string, unknown>): ElementRef {
  const id = params.elementId as string
  const ref = elementRegistry.get(id)
  if (!ref) throw new Error(`Element not found: ${id} (stale reference)`)
  return ref
}
