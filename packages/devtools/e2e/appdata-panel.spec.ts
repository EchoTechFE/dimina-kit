import type { Page } from '@playwright/test'
import { test, expect, useSharedProject } from './fixtures'
import {
  DEMO_APP_DIR,
  evalInSimulator,
  pollUntil,
} from './helpers'

/**
 * UI-level e2e for the AppData right panel.
 *
 * Exercises the three behaviours users care about most:
 *  1. Initial page state is visible without any setData call (the page's
 *     declared `data: {...}` should reach the panel via the
 *     `page_<uuid>` init message).
 *  2. Each open page gets its own tab. The active tab follows the current
 *     route after navigateTo.
 *  3. Navigating back / destroying a page removes its tab promptly.
 *
 * Verification reads the rendered DOM of the AppData panel rather than the
 * React state, so it asserts what the user actually sees.
 */

async function selectAppDataTab(mainWindow: Page) {
  // Playwright's getByRole handles Radix Tabs activation correctly.
  await mainWindow.getByRole('tab', { name: 'AppData' }).click()
  // Panel header has a "↻ 刷新" button — wait for it.
  await mainWindow.getByRole('button', { name: /刷新/ }).waitFor({ state: 'visible', timeout: 5000 })
}

interface AppDataDom {
  tabs: string[]
  entryHeaders: string[]
  entryJsons: string[]
}

async function readPanel(mainWindow: Page): Promise<AppDataDom> {
  return mainWindow.evaluate(() => {
    const refreshBtn = Array.from(document.querySelectorAll('button'))
      .find((b) => b.textContent?.trim().includes('刷新'))
    const panel = refreshBtn?.closest('.flex.flex-col') as HTMLElement | null
    if (!panel) return { tabs: [], entryHeaders: [], entryJsons: [] }

    const tabs: string[] = []
    panel.querySelectorAll('button').forEach((btn) => {
      const t = btn.textContent?.trim() ?? ''
      if (t === '' || t.includes('刷新')) return
      tabs.push(t)
    })

    // Entry cards: each is a `<div class="border …">` with a `.bg-surface-3`
    // header (the route/moduleId) and a JsonView body. Walk from the headers
    // and read their parent card's full text as a proxy for the JSON body.
    const entryHeaders: string[] = []
    const entryJsons: string[] = []
    panel.querySelectorAll('.bg-surface-3').forEach((header) => {
      const card = header.parentElement as HTMLElement | null
      if (!card || !card.classList.contains('border')) return
      const headerText = (header as HTMLElement).textContent?.trim() ?? ''
      entryHeaders.push(headerText)
      // Card text contains header + JSON content; strip header for the body view.
      const fullText = card.textContent ?? ''
      entryJsons.push(fullText.replace(headerText, '').trim())
    })
    return { tabs, entryHeaders, entryJsons }
  })
}

test.describe('AppData panel — per-page tabs & lifecycle', () => {
  test.describe.configure({ mode: 'serial' })

  useSharedProject(test, DEMO_APP_DIR, { openOptions: { waitForWebview: true } })

  test('initial page data shows without any setData call', async ({ mainWindow, electronApp }) => {
    await selectAppDataTab(mainWindow)

    // demo-app/pages/index/index.js declares `data: { menuItems: [...], deviceInfo: {} }`
    // and only calls setData inside loadDeviceInfo (onLoad). To prove that
    // the panel sees INITIAL data (not only post-setData), wait for any
    // entry header to render — that requires the `page_<uuid>` init path.
    const dom = await pollUntil(
      () => readPanel(mainWindow),
      (d) => d.entryHeaders.length > 0,
      8000,
      300,
    )

    // Header should be the route, not a `page_<uuid>` opaque id.
    const header = dom.entryHeaders[0] ?? ''
    expect(header).toMatch(/pages\/index\/index/)
    // The JSON should contain at least the menuItems / deviceInfo keys.
    const json = dom.entryJsons[0] ?? ''
    expect(json).toContain('menuItems')
    expect(json).toContain('deviceInfo')

    // Sanity: the simulator-side bridge state actually contains a page entry.
    const cacheKeys = await evalInSimulator<string[]>(
      electronApp,
      `Object.keys(window.__simulatorData?.getAppdata() || {})`,
    )
    expect(cacheKeys.some((k) => k.includes('page_'))).toBe(true)
  })

  test('navigateTo opens a second tab and the active follows the new route', async ({ mainWindow, electronApp }) => {
    await selectAppDataTab(mainWindow)

    // Wait for first page (home) entry to be visible.
    await pollUntil(
      () => readPanel(mainWindow),
      (d) => d.entryHeaders.length > 0,
      8000,
      300,
    )

    // Drive navigation through the home page's "tap" handler — dimina binds
    // wx.navigateTo to the matching menuItem element. Tapping the DOM is the
    // pattern the existing automator helper uses (see e2e/automator/mini-program.ts).
    const clicked = await pollUntil<boolean>(
      () => evalInSimulator<boolean>(
        electronApp,
        `(() => {
          const iframes = document.querySelectorAll('iframe')
          const iframe = iframes[iframes.length - 1]
          if (!iframe || !iframe.contentDocument) return false
          const item = iframe.contentDocument.querySelector('[data-path="/pages/component-test/component-test"]')
          if (item) { item.click(); return true }
          return false
        })()`,
      ),
      (ok) => ok === true,
      8000,
      200,
    ).catch(() => false)
    if (!clicked) throw new Error('Failed to click navigation menu item')

    // After navigation, two bridges should be present → tab bar renders with 2 tabs.
    const dom = await pollUntil(
      () => readPanel(mainWindow),
      (d) => d.tabs.length >= 2
        && d.tabs.some((t) => t.includes('component-test'))
        && d.entryHeaders.some((h) => h.includes('component-test')),
      10000,
      400,
    )
    expect(dom.tabs.some((t) => t.includes('pages/index/index'))).toBe(true)
    expect(dom.tabs.some((t) => t.includes('component-test'))).toBe(true)
    // Active entries should be the NEW page (auto-switched on page_* init).
    expect(dom.entryHeaders.some((h) => h.includes('component-test'))).toBe(true)
  })

  test('navigateBack removes the popped page tab', async ({ mainWindow, electronApp }) => {
    await selectAppDataTab(mainWindow)

    // Confirm we still have 2 tabs from the previous test.
    await pollUntil(
      () => readPanel(mainWindow),
      (d) => d.tabs.length >= 2,
      5000,
      300,
    )

    // navigateBack via the dimina runtime — find any iframe that exposes wx.
    await evalInSimulator(
      electronApp,
      `(() => {
        const iframes = Array.from(document.querySelectorAll('iframe'))
        for (const f of iframes) {
          try {
            if (f.contentWindow && f.contentWindow.wx) {
              f.contentWindow.wx.navigateBack({ delta: 1 })
              return
            }
          } catch (_) {}
        }
      })()`,
    )

    // After back, the second page's bridge is destroyed → tab vanishes.
    // bridges.length drops to 1 → tab bar may even hide entirely (we only
    // show it when length > 1). Either way, no tab labelled "component-test".
    const dom = await pollUntil(
      () => readPanel(mainWindow),
      (d) => !d.tabs.some((t) => t.includes('component-test'))
        && !d.entryHeaders.some((h) => h.includes('component-test')),
      8000,
      400,
    )
    // Home page entries still there.
    expect(dom.entryHeaders.some((h) => h.includes('pages/index/index'))).toBe(true)
  })

  test('navigateBack from a page whose onUnload runs setData leaves no ghost bridge tab', async ({ mainWindow, electronApp }) => {
    await selectAppDataTab(mainWindow)
    await pollUntil(
      () => readPanel(mainWindow),
      (d) => d.entryHeaders.length > 0,
      8000,
      300,
    )

    // console-test's onUnload calls stopTimer → setData({timerRunning:false}).
    // The late `ub` that produces would, pre-fix, resurrect the just-unloaded
    // bridge as a tab labelled `bridge_<uuid>` (no pagePath). Verify it does
    // NOT come back.
    const clicked = await pollUntil<boolean>(
      () => evalInSimulator<boolean>(
        electronApp,
        `(() => {
          const iframes = document.querySelectorAll('iframe')
          const iframe = iframes[iframes.length - 1]
          if (!iframe || !iframe.contentDocument) return false
          const item = iframe.contentDocument.querySelector('[data-path="/pages/console-test/console-test"]')
          if (item) { item.click(); return true }
          return false
        })()`,
      ),
      (ok) => ok === true,
      8000,
      200,
    ).catch(() => false)
    expect(clicked).toBe(true)

    // Wait for console-test to be visible in the panel.
    await pollUntil(
      () => readPanel(mainWindow),
      (d) => d.tabs.some((t) => t.includes('console-test')),
      8000,
      300,
    )
    // Let dimina's enter animation settle so navigateBack isn't no-op'd by the
    // webviewAnimaEnd guard.
    await new Promise((r) => setTimeout(r, 800))

    // navigateBack — click the dimina nav bar back button (same pattern as
    // resetSimulatorState in helpers.ts; more reliable than wx.navigateBack
    // from the render-side proxy).
    await evalInSimulator(
      electronApp,
      `(() => {
        const webviews = document.querySelectorAll('.dimina-native-view')
        const top = webviews[webviews.length - 1]
        const backBtn = top?.querySelector('.dimina-native-webview__navigation-left-btn')
        if (backBtn) backBtn.click()
      })()`,
    )

    // Poll until console-test tab actually disappears. Also gives the late
    // onUnload→setData ub time to arrive.
    const dom = await pollUntil(
      () => readPanel(mainWindow),
      (d) => !d.tabs.some((t) => t.includes('console-test')),
      8000,
      400,
    )
    // No ghost: no tab labelled bridge_<...>, no console-test entry.
    expect(dom.tabs.filter((t) => t.startsWith('bridge_'))).toEqual([])
    expect(dom.tabs.some((t) => t.includes('console-test'))).toBe(false)
    expect(dom.entryHeaders.some((h) => h.includes('console-test'))).toBe(false)
    // Home still visible.
    expect(dom.entryHeaders.some((h) => h.includes('pages/index/index'))).toBe(true)
  })
})
