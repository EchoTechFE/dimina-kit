/**
 * Page — represents a mini program page in the simulator.
 *
 * The actual page content renders inside an iframe (pageFrame.html) within the
 * simulator webview. All DOM queries and interactions target the iframe's document.
 *
 * Page data is not directly accessible (no getCurrentPages). Instead we inspect
 * the rendered DOM which reflects the data through Vue bindings.
 */

import type { ElectronApplication, Page as PwPage } from '@playwright/test'
import { Element } from './element'
import { evalInSimulator, pollUntil } from '../helpers'

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

export class Page {
  readonly electronApp: ElectronApplication
  readonly mainWindow: PwPage
  readonly path: string

  constructor(
    electronApp: ElectronApplication,
    mainWindow: PwPage,
    path: string,
  ) {
    this.electronApp = electronApp
    this.mainWindow = mainWindow
    this.path = path
  }

  // ── DOM queries (inside iframe) ─────────────────────────────────────

  /**
   * Find the first element matching a CSS selector in the page iframe.
   * Returns null if not found.
   */
  async $(selector: string): Promise<Element | null> {
    const escaped = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const exists = await evalInSimulator<boolean>(
      this.electronApp,
      inIframe(`return _doc.querySelector('${escaped}') !== null`),
    )
    if (!exists) return null
    return new Element(this.electronApp, this.mainWindow, selector, 0)
  }

  /**
   * Find all elements matching a CSS selector in the page iframe.
   */
  async $$(selector: string): Promise<Element[]> {
    const escaped = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const count = await evalInSimulator<number>(
      this.electronApp,
      inIframe(`return _doc.querySelectorAll('${escaped}').length`),
    )
    const elements: Element[] = []
    for (let i = 0; i < count; i++) {
      elements.push(new Element(this.electronApp, this.mainWindow, selector, i))
    }
    return elements
  }

  // ── DOM inspection helpers ──────────────────────────────────────────

  /** Get the full inner HTML of the page body. */
  async bodyHTML(): Promise<string> {
    return evalInSimulator<string>(
      this.electronApp,
      inIframe(`return _doc.body ? _doc.body.innerHTML : ''`),
    )
  }

  /** Get the text content of an element matching the selector. */
  async getTextContent(selector: string): Promise<string> {
    const escaped = selector.replace(/'/g, "\\'")
    return evalInSimulator<string>(
      this.electronApp,
      inIframe(`
        const el = _doc.querySelector('${escaped}')
        return el ? el.textContent || '' : ''
      `),
    )
  }

  /**
   * Get the rendered data-* attributes from an element.
   * Useful for inspecting data bindings rendered by Vue.
   */
  async getDataAttributes(selector: string): Promise<Record<string, string>> {
    const escaped = selector.replace(/'/g, "\\'")
    return evalInSimulator<Record<string, string>>(
      this.electronApp,
      inIframe(`
        const el = _doc.querySelector('${escaped}')
        if (!el) return {}
        const attrs = {}
        for (const attr of el.attributes) {
          if (attr.name.startsWith('data-') && !attr.name.startsWith('data-v-')) {
            attrs[attr.name] = attr.value
          }
        }
        return attrs
      `),
    )
  }

  // ── Wait helpers ────────────────────────────────────────────────────

  /** Wait for a specified amount of time (ms). */
  async waitFor(ms: number): Promise<void>
  /** Wait for a selector to appear in the page iframe DOM. */
  async waitFor(selector: string): Promise<void>
  /** Wait for a predicate function to return true. */
  async waitFor(predicate: () => Promise<boolean>): Promise<void>
  async waitFor(arg: number | string | (() => Promise<boolean>)): Promise<void> {
    if (typeof arg === 'number') {
      await this.mainWindow.waitForTimeout(arg)
    } else if (typeof arg === 'string') {
      await this.waitForSelector(arg)
    } else {
      await pollUntil(arg, (v) => v === true, 15000, 300)
    }
  }

  /** Wait for a CSS selector to appear in the page iframe DOM. */
  async waitForSelector(selector: string, timeout = 15000): Promise<Element> {
    const escaped = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    await pollUntil(
      () => evalInSimulator<boolean>(
        this.electronApp,
        inIframe(`return _doc.querySelector('${escaped}') !== null`),
      ),
      (found) => found === true,
      timeout,
      300,
    )
    return new Element(this.electronApp, this.mainWindow, selector, 0)
  }

  // ── Evaluate in iframe ──────────────────────────────────────────────

  /** Evaluate JS in the page iframe context. */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    return evalInSimulator<T>(this.electronApp, inIframe(`return ${expression}`))
  }

  // ── Screenshot ──────────────────────────────────────────────────────

  /** Take a screenshot of the simulator. Returns a PNG buffer. */
  async screenshot(): Promise<Buffer> {
    const base64 = await this.electronApp.evaluate(async ({ webContents }) => {
      const all = webContents.getAllWebContents()
      const sim = all.find((wc) => wc.getType() === 'webview')
      if (!sim) throw new Error('No webview found')
      const img = await sim.capturePage()
      return img.toPNG().toString('base64')
    })
    return Buffer.from(base64, 'base64')
  }
}
