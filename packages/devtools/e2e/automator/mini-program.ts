/**
 * MiniProgram — controls the mini program instance running in the devtools simulator.
 *
 * Architecture:
 *   - The simulator is a webview containing an iframe (pageFrame.html)
 *   - The mini program page renders inside the iframe via Vue
 *   - Page route is encoded in the simulator's location.hash
 *   - Navigation works by clicking DOM elements or IPC
 *   - wx object is on the simulator top window (storage/system APIs only)
 *   - No getCurrentPages/getApp - those are in the service layer
 */

import type { ElectronApplication, Page as PwPage } from '@playwright/test'
import { Page } from './page'
import { evalInSimulator, ipcInvoke, closeProject, pollUntil } from '../helpers'

export class MiniProgram {
  readonly electronApp: ElectronApplication
  readonly mainWindow: PwPage
  readonly projectPath: string

  constructor(
    electronApp: ElectronApplication,
    mainWindow: PwPage,
    projectPath: string,
  ) {
    this.electronApp = electronApp
    this.mainWindow = mainWindow
    this.projectPath = projectPath
  }

  // ── Navigation ──────────────────────────────────────────────────────

  /**
   * Get the current page route from the simulator's URL hash.
   * New format: #appid|page1|page2 — last segment is current page
   * Legacy format: #appid/pages/xxx/xxx?query
   */
  async currentPagePath(): Promise<string> {
    const hash = await evalInSimulator<string>(this.electronApp, `location.hash`)
    const clean = hash.replace(/^#/, '').replace(/\?.*$/, '')
    // New format: #appid|page1|page2 — last segment is current page
    if (clean.includes('|')) {
      const parts = clean.split('|')
      return parts[parts.length - 1] ?? ''
    }
    // Legacy format: #appid/pagePath
    const slashIndex = clean.indexOf('/')
    return slashIndex >= 0 ? clean.substring(slashIndex + 1) : clean
  }

  /** Get the current active page. */
  async currentPage(): Promise<Page> {
    const pagePath = await this.currentPagePath()
    return new Page(this.electronApp, this.mainWindow, pagePath)
  }

  /**
   * Navigate to a page by clicking a menu item with matching data-path,
   * or by triggering the dimina navigation through the active page iframe's
   * bindtap handler. Falls back to hash change + wait.
   *
   * Dimina creates a new iframe for each navigateTo, keeping old pages alive
   * (just like WeChat's page stack).
   */
  async navigateTo(url: string): Promise<Page> {
    const cleanUrl = url.startsWith('/') ? url : `/${url}`

    // Count iframes before
    const iframeCountBefore = await evalInSimulator<number>(
      this.electronApp,
      `document.querySelectorAll('iframe').length`,
    )

    // Try clicking a DOM element with matching data-path first
    const clicked = await evalInSimulator<boolean>(
      this.electronApp,
      `(() => {
        const iframes = document.querySelectorAll('iframe')
        const iframe = iframes[iframes.length - 1]
        if (!iframe || !iframe.contentDocument) return false
        const item = iframe.contentDocument.querySelector('[data-path="${cleanUrl}"]')
        if (item) { item.click(); return true }
        return false
      })()`,
    )

    if (!clicked) {
      // Fallback: change hash directly
      const hash = await evalInSimulator<string>(this.electronApp, `location.hash`)
      const clean = hash.replace(/^#/, '')
      // New format: #appid|page1|page2; Legacy: #appid/page
      const appId = clean.includes('|') ? clean.split('|')[0] : clean.split('/')[0]
      // New format appends page as a |segment; strip leading /
      const pageSeg = cleanUrl.replace(/^\//, '')
      await evalInSimulator(
        this.electronApp,
        `location.hash = '#${appId}|${pageSeg}'`,
      )
    }

    // Wait for a new iframe to appear (dimina creates one per page)
    await pollUntil(
      () => evalInSimulator<number>(
        this.electronApp,
        `document.querySelectorAll('iframe').length`,
      ),
      (count) => count > iframeCountBefore,
      10000,
      300,
    ).catch(() => {})

    // Give the new page time to render
    await this.mainWindow.waitForTimeout(1500)
    return this.currentPage()
  }

  /** Close all pages and navigate to the specified page (reloads simulator). */
  async reLaunch(url: string): Promise<Page> {
    const cleanUrl = url.startsWith('/') ? url : `/${url}`
    const hash = await evalInSimulator<string>(this.electronApp, `location.hash`)
    const clean = hash.replace(/^#/, '')
    const appId = clean.includes('|') ? clean.split('|')[0] : clean.split('/')[0]
    const pageSeg = cleanUrl.replace(/^\//, '')

    // Reload the simulator with the target page
    await evalInSimulator(
      this.electronApp,
      `location.href = location.pathname + '#${appId}|${pageSeg}'`,
    )

    // Wait for iframe to appear
    await pollUntil(
      () => evalInSimulator<number>(
        this.electronApp,
        `document.querySelectorAll('iframe').length`,
      ),
      (count) => count >= 1,
      15000,
      500,
    )

    // Wait for content to render
    await this.mainWindow.waitForTimeout(2000)
    return this.currentPage()
  }

  /** Close current page and navigate to a page. */
  async redirectTo(url: string): Promise<Page> {
    return this.reLaunch(url)
  }

  /** Navigate back by going to history.back(). */
  async navigateBack(): Promise<Page> {
    await evalInSimulator(this.electronApp, `history.back()`)
    await this.mainWindow.waitForTimeout(1500)
    return this.currentPage()
  }

  // ── Evaluate ────────────────────────────────────────────────────────

  /**
   * Evaluate a JavaScript expression in the simulator top window context.
   * Has access to: wx object, __simulatorHook, DOM, iframe.
   */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    return evalInSimulator<T>(this.electronApp, expression)
  }

  /**
   * Evaluate a JavaScript expression in the active page iframe context.
   * This is where the actual mini program page DOM lives.
   * Available variables: _doc (iframe contentDocument), _win (iframe contentWindow).
   */
  async evaluateInPage<T = unknown>(expression: string): Promise<T> {
    return evalInSimulator<T>(
      this.electronApp,
      `(() => {
        const iframes = document.querySelectorAll('iframe')
        const iframe = iframes[iframes.length - 1]
        if (!iframe || !iframe.contentDocument) throw new Error('No page iframe found')
        const _doc = iframe.contentDocument
        const _win = iframe.contentWindow
        return (function() { return ${expression} }).call(_win)
      })()`,
    )
  }

  // ── wx API calls ────────────────────────────────────────────────────

  /**
   * Call a synchronous wx method (e.g. getSystemInfoSync, getStorageSync).
   * Only storage and system APIs are available.
   */
  async callWxMethodSync<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    const argsStr = args.map((a) => JSON.stringify(a)).join(', ')
    return evalInSimulator<T>(this.electronApp, `wx.${method}(${argsStr})`)
  }

  /**
   * Set a storage item via wx.setStorageSync.
   */
  async setStorage(key: string, value: string): Promise<void> {
    await evalInSimulator(
      this.electronApp,
      `wx.setStorageSync(${JSON.stringify(key)}, ${JSON.stringify(value)})`,
    )
  }

  /**
   * Get a storage item via wx.getStorageSync.
   */
  async getStorage(key: string): Promise<string> {
    return evalInSimulator<string>(
      this.electronApp,
      `wx.getStorageSync(${JSON.stringify(key)})`,
    )
  }

  /**
   * Remove a storage item via wx.removeStorageSync.
   */
  async removeStorage(key: string): Promise<void> {
    await evalInSimulator(
      this.electronApp,
      `wx.removeStorageSync(${JSON.stringify(key)})`,
    )
  }

  /**
   * Get system info via wx.getSystemInfoSync.
   */
  async getSystemInfo(): Promise<Record<string, unknown>> {
    return evalInSimulator(this.electronApp, `wx.getSystemInfoSync()`)
  }

  // ── DevTools Hook ───────────────────────────────────────────────────

  /**
   * Trigger the appData hook to send data to devtools.
   */
  async triggerAppDataHook(body?: unknown): Promise<void> {
    const bodyStr = body ? JSON.stringify(body) : ''
    await evalInSimulator(
      this.electronApp,
      `__simulatorHook.appData(${bodyStr})`,
    )
  }

  // ── IPC helpers ─────────────────────────────────────────────────────

  /** Invoke a devtools IPC handler from the renderer process. */
  async ipcInvoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
    return ipcInvoke<T>(this.mainWindow, channel, ...args)
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

  // ── Lifecycle ───────────────────────────────────────────────────────

  /** Wait for a specific amount of time. */
  async waitFor(ms: number): Promise<void> {
    await this.mainWindow.waitForTimeout(ms)
  }

  /** Close the mini program and the devtools app. */
  async close(): Promise<void> {
    await closeProject(this.mainWindow).catch(() => {})
    await this.electronApp.close().catch(() => {})
  }
}
