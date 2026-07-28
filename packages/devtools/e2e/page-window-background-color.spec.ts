/**
 * Page-transition white-flash fix: `window.backgroundColor` (page.json ∪
 * app.json, see `resolvePageWindowConfig` in bridge-router.ts) must prime the
 * render-host guest's background BEFORE its own document paints — WeChat /
 * Android (`WebView.setBackgroundColor`) / Harmony (`DMPPageContainer` Column
 * backgroundColor) parity. Two independent primers are pinned:
 *   1. The host-side `<webview>` DOM element's own CSS `background-color`
 *      (device-shell.tsx) — painted by the HOST compositor, ahead of the
 *      guest's first composited frame.
 *   2. The guest's own document background (render-host/preload.cjs sets
 *      `document.documentElement`/`body` style before pageFrame.css or
 *      @dimina/render load).
 *
 * Also guards a real bug this fix surfaced along the way:
 * `resolvePageWindowConfig` was reading `modules[path].window`, but the
 * compiler's actual `app-config.json` has each page's window-config fields
 * FLAT on `modules[path]` (no `.window` wrapper) — so EVERY per-page window
 * override (title, nav-bar color, backgroundColor, homeButton, …) was
 * silently falling back to the app-level default. The nav-bar-title
 * assertion below pins that this now resolves correctly.
 *
 * The computed-style checks below prove the primer VALUES are wired
 * correctly at steady state — they don't by themselves prove no transient
 * white frame was ever actually composited during the gap between the two
 * primers running and the previous page's guest being swapped out. The
 * second assertion block captures REAL presented compositor frames
 * (`webContents.beginFrameSubscription()` — every frame, not a poll loop
 * that could land between two async `capturePage()` snapshots) through an
 * A→B transition where NEITHER page is white (`#123456` → `#00aa55`), so any
 * captured near-white frame during the transition is unambiguous proof of a
 * flash.
 */
import path from 'path'
import { fileURLToPath } from 'url'
import { test, expect } from './fixtures'
import { openProjectInUI, evalInWebContentsByUrl, evalInSimulator, pollUntil } from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'page-stack-app')

// pages/a/a.json sets "backgroundColor": "#123456"; app.json has no
// window.backgroundColor, so pages/home/home (no override) resolves to the
// #ffffff default (Android/Harmony parity default). pages/b/b.json sets
// "backgroundColor": "#00aa55" — used by the pixel-capture test below.
const CONFIGURED_BG_RGB = 'rgb(18, 52, 86)' // #123456
const DEFAULT_BG_RGB = 'rgb(255, 255, 255)' // #ffffff

test.describe('page window.backgroundColor primes the render guest', () => {
  test('unconfigured page defaults to #ffffff; page with window.backgroundColor override uses it, on both primers', async ({ electronApp, mainWindow }) => {
    await openProjectInUI(mainWindow, FIXTURE_DIR, { waitMs: 8000 })
    await new Promise((r) => setTimeout(r, 1500))

    // Home page (no per-page override) — both primers should be the default.
    const homeWebviewBg = await evalInSimulator<string>(
      electronApp,
      `(() => getComputedStyle(document.querySelector('.device-shell__webview')).backgroundColor)()`,
    )
    expect(homeWebviewBg).toBe(DEFAULT_BG_RGB)

    const homeGuestBg = await evalInWebContentsByUrl<string>(
      electronApp,
      'pageFrame.html',
      '(getComputedStyle(document.documentElement).backgroundColor)',
    )
    expect(homeGuestBg).toBe(DEFAULT_BG_RGB)

    // Navigate to page A (backgroundColor: #123456) via a real tap — bindtap="goA".
    const clicked = await evalInWebContentsByUrl<boolean>(electronApp, 'pageFrame.html', `(() => {
      const el = document.querySelector('[data-path="/pages/a/a"]')
      if (!el) return false
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return true
    })()`)
    expect(clicked).toBe(true)

    // Regression guard for the window-config merge bug this fix surfaced:
    // page A's own navigationBarTitleText ("A") must win over the app-level
    // default ("PageStack Fixture"), proving resolvePageWindowConfig now
    // reads the page's actual per-page override.
    const navTitle = await pollUntil(
      () => evalInSimulator<string | null>(
        electronApp,
        `(() => { const el = document.querySelector('.nav-bar__title-text'); return el ? el.textContent : null })()`,
      ),
      (title) => title === 'A',
      10000,
      300,
    )
    expect(navTitle).toBe('A')

    const aWebviewBg = await pollUntil(
      () => evalInSimulator<string>(
        electronApp,
        `(() => {
          const nodes = document.querySelectorAll('.device-shell__webview')
          const last = nodes[nodes.length - 1]
          return last ? getComputedStyle(last).backgroundColor : ''
        })()`,
      ),
      (bg) => bg === CONFIGURED_BG_RGB,
      10000,
      300,
    )
    expect(aWebviewBg).toBe(CONFIGURED_BG_RGB)

    const aGuestBg = await pollUntil(
      () => evalInWebContentsByUrl<string>(electronApp, 'pages%2Fa%2Fa', '(getComputedStyle(document.documentElement).backgroundColor)'),
      (bg) => bg === CONFIGURED_BG_RGB,
      10000,
      300,
    )
    expect(aGuestBg).toBe(CONFIGURED_BG_RGB)

    // ── Real pixel capture: A(#123456) -> B(#00aa55), neither page white ──
    // Continues in the SAME test/session (rather than a second `test()`) so
    // there's no cross-test ordering hazard from the shared worker-scoped
    // `electronApp` — this reuses the already-navigated-to-A state above
    // instead of re-opening the project and racing a fresh page stack.
    //
    // Sample the visible render-host `<webview>`'s on-screen rect (ratio of
    // the simulator window, so the capture doesn't need device-pixel-ratio
    // math — `beginFrameSubscription()`'s frames are scaled by the same ratio).
    const rectRatio = await evalInSimulator<{ xRatio: number; yRatio: number }>(
      electronApp,
      `(() => {
        const nodes = document.querySelectorAll('.device-shell__webview')
        const visible = Array.from(nodes).find((n) => getComputedStyle(n).display !== 'none')
        const r = visible.getBoundingClientRect()
        return { xRatio: (r.left + r.width / 2) / window.innerWidth, yRatio: (r.top + r.height / 2) / window.innerHeight }
      })()`,
    )

    // Subscribe to EVERY presented compositor frame (`beginFrameSubscription`)
    // rather than polling `capturePage()` — a poll loop can miss a one-frame
    // flash entirely if it lands between two async capture calls, since each
    // `capturePage()` is itself a snapshot-on-demand, not a presentation
    // event. The subscription callback fires for every frame Chromium
    // actually composites, so there is no sampling gap to miss a flash in.
    const subStarted = await electronApp.evaluate(({ webContents }, ratio) => {
      const all = webContents.getAllWebContents()
      const sim = all.find((wc) => wc.getURL().includes('simulator.html')) ?? all.find((wc) => wc.getType() === 'webview')
      if (!sim) return false
      const g = globalThis as unknown as { __bgFrameSamples?: Array<{ r: number; g: number; b: number }>; __bgFrameSub?: typeof sim }
      g.__bgFrameSamples = []
      g.__bgFrameSub = sim
      sim.beginFrameSubscription(false, (image: Electron.NativeImage) => {
        try {
          const { width, height } = image.getSize()
          if (width === 0 || height === 0) return
          const x = Math.min(width - 1, Math.max(0, Math.round(ratio.xRatio * width)))
          const y = Math.min(height - 1, Math.max(0, Math.round(ratio.yRatio * height)))
          const bitmap = image.toBitmap()
          const offset = (y * width + x) * 4
          // Channel order (BGRA/RGBA) is platform-dependent — irrelevant here:
          // "near-white" is (255,255,255) regardless of channel order, so
          // checking all three non-alpha-adjacent bytes is order-independent.
          g.__bgFrameSamples!.push({ r: bitmap[offset] ?? 0, g: bitmap[offset + 1] ?? 0, b: bitmap[offset + 2] ?? 0 })
        } catch { /* transient capture error on a mid-teardown frame — skip it */ }
      })
      return true
    }, rectRatio)
    expect(subStarted).toBe(true)

    // try/finally: the app is worker-scoped (shared across later tests in
    // this worker) — if the click or the readiness wait below throws, the
    // subscription and its growing sample array must still be torn down, or
    // they'd leak a live callback + accumulating global state into whatever
    // test runs next in this worker.
    let count: number
    let whiteCount: number
    try {
      // Fire the A -> B navigation with the subscription already live, so the
      // very first presented frame of the transition is captured.
      const clickedB = await evalInWebContentsByUrl<boolean>(electronApp, 'pages%2Fa%2Fa', `(() => {
        const el = document.querySelector('[data-path="/pages/b/b"]')
        if (!el) return false
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        return true
      })()`)
      expect(clickedB).toBe(true)

      // Wait for B's own guest to actually finish loading (not just the title
      // flip, which can race ahead of the new guest's first composited frame —
      // see device-shell.tsx's title/webview state landing in the same React
      // commit), then a little more for a couple of trailing presented frames.
      await pollUntil(
        () => evalInWebContentsByUrl<string>(electronApp, 'pages%2Fb%2Fb', '(document.readyState)'),
        (state) => state === 'complete',
        10000,
        300,
      )
      await new Promise((r) => setTimeout(r, 500))
    } finally {
      const result = await electronApp.evaluate(() => {
        const g = globalThis as unknown as {
          __bgFrameSamples?: Array<{ r: number; g: number; b: number }>
          __bgFrameSub?: { endFrameSubscription(): void }
        }
        try {
          g.__bgFrameSub?.endFrameSubscription()
        } catch { /* subscribed WebContents already destroyed — nothing to end */ }
        const samples = g.__bgFrameSamples ?? []
        const NEAR_WHITE = 250
        const white = samples.filter((s) => s.r > NEAR_WHITE && s.g > NEAR_WHITE && s.b > NEAR_WHITE)
        delete g.__bgFrameSub
        delete g.__bgFrameSamples
        return { count: samples.length, whiteCount: white.length }
      })
      count = result.count
      whiteCount = result.whiteCount
    }
    expect(count).toBeGreaterThan(0)
    expect(whiteCount, `${whiteCount}/${count} presented frames during A(#123456)->B(#00aa55) were near-white`).toBe(0)

    const bGuestBg = await pollUntil(
      () => evalInWebContentsByUrl<string>(electronApp, 'pages%2Fb%2Fb', '(getComputedStyle(document.documentElement).backgroundColor)'),
      (bg) => bg === 'rgb(0, 170, 85)',
      10000,
      300,
    )
    expect(bGuestBg).toBe('rgb(0, 170, 85)')
  })
})
