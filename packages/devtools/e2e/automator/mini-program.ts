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

    // Snapshot iframe topology before navigation so we can detect when the
    // new page's iframe is actually attached. Dimina pushes a new iframe per
    // page in the navigation stack; either the count goes up or the existing
    // last iframe gets replaced (and its bodyHTML length changes).
    const before = await evalInSimulator<{ count: number; lastLen: number }>(
      this.electronApp,
      `(() => {
        const fs = document.querySelectorAll('iframe')
        const last = fs[fs.length - 1]
        const len = last && last.contentDocument && last.contentDocument.body
          ? last.contentDocument.body.innerHTML.length : 0
        return { count: fs.length, lastLen: len }
      })()`,
    )

    // Inject targets through JSON.stringify to avoid string-injection in the
    // remotely-evaluated script (the URL is user-controlled in the public
    // SDK API).
    const cleanUrlJson = JSON.stringify(cleanUrl)
    const targetSeg = cleanUrl.replace(/^\//, '').split('?')[0]
    const targetSegJson = JSON.stringify(targetSeg)

    // Try clicking a DOM element with matching data-path. The element may
    // not exist yet if the source page hasn't finished its initial render —
    // poll for up to 8s before falling back. dimina's router is bound to the
    // wx.navigateTo handler invoked by the click; setting location.hash
    // directly does NOT trigger navigation, so the click path is required.
    const clicked = await pollUntil<boolean>(
      () => evalInSimulator<boolean>(
        this.electronApp,
        `(() => {
          const iframes = document.querySelectorAll('iframe')
          const iframe = iframes[iframes.length - 1]
          if (!iframe || !iframe.contentDocument) return false
          const item = iframe.contentDocument.querySelector('[data-path=' + JSON.stringify(${cleanUrlJson}) + ']')
          if (item) { item.click(); return true }
          return false
        })()`,
      ),
      (ok) => ok === true,
      8000,
      200,
    ).catch(() => false)

    if (!clicked) {
      // Last-resort fallback: invoke dimina's router via wx APIs. dimina
      // injects `wx` only into the entry-page iframe (typically the first
      // iframe = index); child page iframes have no wx on their
      // contentWindow, so we scan all iframes for one that exposes wx.
      // Pick navigateBack vs reLaunch based on whether target is on the
      // stack:
      //   - target already on stack → navigateBack to pop to it
      //   - target not on stack → reLaunch (works regardless of stack state)
      // A bare location.hash = ... is NOT enough — the dimina runtime does
      // not bind hashchange for navigation.
      await evalInSimulator(
        this.electronApp,
        `(() => {
          const iframes = Array.from(document.querySelectorAll('iframe'))
          let win = null
          for (const f of iframes) {
            try {
              if (f.contentWindow && f.contentWindow.wx) { win = f.contentWindow; break }
            } catch (_) {}
          }
          if (!win) return
          const hash = location.hash.replace(/^#/, '')
          const segs = hash.includes('|') ? hash.split('|').slice(1).map(s => s.split('?')[0]) : []
          const targetIdx = segs.indexOf(${targetSegJson})
          try {
            if (targetIdx >= 0 && targetIdx < segs.length - 1 && typeof win.wx.navigateBack === 'function') {
              win.wx.navigateBack({ delta: segs.length - 1 - targetIdx })
            } else if (typeof win.wx.reLaunch === 'function') {
              win.wx.reLaunch({ url: ${cleanUrlJson} })
            } else if (typeof win.wx.navigateTo === 'function') {
              win.wx.navigateTo({ url: ${cleanUrlJson} })
            }
          } catch (e) {}
        })()`,
      )
    }

    // Wait until current page is the target — match exact segment, not
    // substring (`/pages/login` would falsely satisfy `pages/log`).
    await pollUntil(
      () => this.currentPagePath(),
      (p) => {
        const norm = p.replace(/^\//, '').split('?')[0]
        return norm === targetSeg || norm.endsWith('/' + targetSeg) || ('/' + norm) === ('/' + targetSeg)
      },
      10000,
      200,
    )

    // Hash changed — now wait for the iframe topology to reflect the new page.
    // Either iframe count increased (page pushed) or the last iframe's body
    // changed (page replaced in same frame). Polling on this avoids returning
    // before dimina actually mounts the new page's DOM.
    await pollUntil(
      () => evalInSimulator<{ count: number; lastLen: number }>(
        this.electronApp,
        `(() => {
          const fs = document.querySelectorAll('iframe')
          const last = fs[fs.length - 1]
          const len = last && last.contentDocument && last.contentDocument.body
            ? last.contentDocument.body.innerHTML.length : 0
          return { count: fs.length, lastLen: len }
        })()`,
      ),
      (now) => now.count > before.count || now.lastLen !== before.lastLen,
      8000,
      150,
    )

    // Final settle for late wx:for / setData renders inside the new page
    await this.mainWindow.waitForTimeout(500)
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
