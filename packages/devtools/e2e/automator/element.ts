/**
 * Element — represents a DOM element in the mini program page iframe.
 *
 * All queries and interactions happen inside the page iframe (pageFrame.html),
 * not the simulator top window.
 */

import type { ElectronApplication, Page as PwPage } from '@playwright/test'
import { evalInSimulator } from '../helpers'

/**
 * Helper: wrap an expression to run inside the active page iframe.
 * Dimina creates a new iframe per page in the navigation stack.
 * The last iframe is always the currently active page.
 */
function inIframe(expression: string): string {
  return `(() => {
    const iframes = document.querySelectorAll('iframe')
    const iframe = iframes[iframes.length - 1]
    if (!iframe || !iframe.contentDocument) throw new Error('No page iframe found')
    const _doc = iframe.contentDocument
    const _win = iframe.contentWindow
    return (function() { ${expression} }).call(_win)
  })()`
}

export class Element {
  readonly electronApp: ElectronApplication
  readonly mainWindow: PwPage
  readonly selector: string
  readonly index: number

  constructor(
    electronApp: ElectronApplication,
    mainWindow: PwPage,
    selector: string,
    index: number,
  ) {
    this.electronApp = electronApp
    this.mainWindow = mainWindow
    this.selector = selector
    this.index = index
  }

  /** Helper: get a reference expression for this element in the iframe. */
  private elRef(): string {
    const escaped = this.selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    return `_doc.querySelectorAll('${escaped}')[${this.index}]`
  }

  // ── Properties ──────────────────────────────────────────────────────

  /** Get the text content of the element. */
  async text(): Promise<string> {
    return evalInSimulator<string>(
      this.electronApp,
      inIframe(`const el = ${this.elRef()}; return el ? el.textContent || '' : ''`),
    )
  }

  /** Get an HTML attribute value. */
  async attribute(name: string): Promise<string | null> {
    return evalInSimulator<string | null>(
      this.electronApp,
      inIframe(`const el = ${this.elRef()}; return el ? el.getAttribute('${name}') : null`),
    )
  }

  /** Get a DOM property value. */
  async property<T = unknown>(name: string): Promise<T> {
    return evalInSimulator<T>(
      this.electronApp,
      inIframe(`const el = ${this.elRef()}; return el ? el['${name}'] : undefined`),
    )
  }

  /** Get the outer HTML of the element. */
  async html(): Promise<string> {
    return evalInSimulator<string>(
      this.electronApp,
      inIframe(`const el = ${this.elRef()}; return el ? el.outerHTML : ''`),
    )
  }

  /** Get the inner HTML of the element. */
  async innerHTML(): Promise<string> {
    return evalInSimulator<string>(
      this.electronApp,
      inIframe(`const el = ${this.elRef()}; return el ? el.innerHTML : ''`),
    )
  }

  /** Get the tag name (lowercase). */
  async tagName(): Promise<string> {
    return evalInSimulator<string>(
      this.electronApp,
      inIframe(`const el = ${this.elRef()}; return el ? el.tagName.toLowerCase() : ''`),
    )
  }

  /** Get the value (for input elements). */
  async value(): Promise<string> {
    return evalInSimulator<string>(
      this.electronApp,
      inIframe(`const el = ${this.elRef()}; return el ? (el.value || '') : ''`),
    )
  }

  /** Check whether the element exists in the DOM. */
  async exists(): Promise<boolean> {
    return evalInSimulator<boolean>(
      this.electronApp,
      inIframe(`return ${this.elRef()} != null`),
    )
  }

  /** Get the CSS class list as an array. */
  async classList(): Promise<string[]> {
    return evalInSimulator<string[]>(
      this.electronApp,
      inIframe(`const el = ${this.elRef()}; return el ? Array.from(el.classList) : []`),
    )
  }

  /** Get bounding rect. */
  async boundingRect(): Promise<{ x: number; y: number; width: number; height: number }> {
    return evalInSimulator(
      this.electronApp,
      inIframe(`
        const el = ${this.elRef()}
        if (!el) return { x: 0, y: 0, width: 0, height: 0 }
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      `),
    )
  }

  /** Get all data-* attributes (excluding Vue scoped data-v-xxx). */
  async dataAttributes(): Promise<Record<string, string>> {
    return evalInSimulator<Record<string, string>>(
      this.electronApp,
      inIframe(`
        const el = ${this.elRef()}
        if (!el) return {}
        const attrs = {}
        for (const attr of el.attributes) {
          if (attr.name.startsWith('data-') && !attr.name.startsWith('data-v-')) {
            attrs[attr.name.replace('data-', '')] = attr.value
          }
        }
        return attrs
      `),
    )
  }

  // ── Interactions ────────────────────────────────────────────────────

  /** Tap (click) the element. */
  async tap(): Promise<void> {
    await evalInSimulator(
      this.electronApp,
      inIframe(`
        const el = ${this.elRef()}
        if (!el) throw new Error('Element not found: ${this.selector}')
        el.click()
      `),
    )
  }

  /** Long press the element. */
  async longpress(duration = 500): Promise<void> {
    await evalInSimulator(
      this.electronApp,
      inIframe(`
        const el = ${this.elRef()}
        if (!el) throw new Error('Element not found')
        el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true }))
        return new Promise(resolve => {
          setTimeout(() => {
            el.dispatchEvent(new TouchEvent('touchend', { bubbles: true }))
            resolve()
          }, ${duration})
        })
      `),
    )
  }

  /** Trigger a custom event on the element. */
  async trigger(eventName: string, detail?: Record<string, unknown>): Promise<void> {
    const detailJson = detail ? JSON.stringify(detail) : '{}'
    await evalInSimulator(
      this.electronApp,
      inIframe(`
        const el = ${this.elRef()}
        if (!el) throw new Error('Element not found')
        el.dispatchEvent(new CustomEvent('${eventName}', { detail: ${detailJson}, bubbles: true }))
      `),
    )
  }

  /** Set input value and dispatch input/change events. */
  async input(value: string): Promise<void> {
    const escaped = JSON.stringify(value)
    await evalInSimulator(
      this.electronApp,
      inIframe(`
        const el = ${this.elRef()}
        if (!el) throw new Error('Element not found')
        el.value = ${escaped}
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      `),
    )
  }

  /** Scroll the element into view. */
  async scrollIntoView(): Promise<void> {
    await evalInSimulator(
      this.electronApp,
      inIframe(`
        const el = ${this.elRef()}
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      `),
    )
  }

  // ── Child queries ───────────────────────────────────────────────────

  /** Find the first child element matching a selector. */
  async $(childSelector: string): Promise<Element | null> {
    const escaped = childSelector.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const exists = await evalInSimulator<boolean>(
      this.electronApp,
      inIframe(`
        const parent = ${this.elRef()}
        return parent ? parent.querySelector('${escaped}') !== null : false
      `),
    )
    if (!exists) return null
    const combinedSelector = `${this.selector} ${childSelector}`
    return new Element(this.electronApp, this.mainWindow, combinedSelector, 0)
  }

  /** Find all child elements matching a selector. */
  async $$(childSelector: string): Promise<Element[]> {
    const escaped = childSelector.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const count = await evalInSimulator<number>(
      this.electronApp,
      inIframe(`
        const parent = ${this.elRef()}
        return parent ? parent.querySelectorAll('${escaped}').length : 0
      `),
    )
    const combinedSelector = `${this.selector} ${childSelector}`
    const elements: Element[] = []
    for (let i = 0; i < count; i++) {
      elements.push(new Element(this.electronApp, this.mainWindow, combinedSelector, i))
    }
    return elements
  }
}
