/**
 * E2E (native-host only): config-driven page orientation. `pageOrientation` on a page's own json (falling back to app.json's `window`) picks the page's fixed orientation ('portrait' default, 'landscape') or lets it follow the simulated device ('auto').
 *
 * Contract pinned here (plus route linkage — the subset this file was scoped to cover):
 *
 *   1. A `pageOrientation: 'landscape'` page reports windowWidth >
 * windowHeight via `wx.getSystemInfoSync()` — the AUTHORITATIVE channel the mini-app's own code reads (see readServiceSystemInfo below) — and NEVER fires `Page.onResize` while the underlying device rotates under it (fixed orientation => no dispatch).
 *   2. A `pageOrientation: 'auto'` page follows the device: rotating it
 * fires exactly one `Page.onResize` with `{ size: { windowWidth, windowHeight }, deviceOrientation }`, and the reported dims are landscape.
 *   3. Device-shell chrome: the status bar (`.device-statusbar`, see
 * status-bar.tsx) is NOT RENDERED at all in landscape — device-shell.tsx gates it with `!embedded && statusBarHeight > 0 && <StatusBar .../>`, so the DOM node itself is absent, not merely collapsed to zero height; the nav bar (`.nav-bar`, see navigation-bar.tsx) stays mounted and visible.
 *   4. Route linkage: `navigateTo` into a fixed-landscape page flips the
 * screen to landscape; `navigateBack` restores the orientation the previous (portrait) page had.
 *   5. Second-interaction regression (repo CLAUDE.md "操作后的二次交互"):
 * two CONSECUTIVE device rotations on an auto page each fire their own `onResize` (not swallowed/coalesced across rotations); entering the fixed-landscape page, going back, then entering it again reaches the correct orientation BOTH times.
 *
 * Observation channels:
 *   - GEOMETRY: `wx.getSystemInfoSync()` inside the service-host window
 * (service.html) — the same channel native-host-device.spec.ts uses.
 * It is the actual `wx` the mini-app's own code calls, so it is the most authoritative read available; it also carries `deviceOrientation` alongside window dims in one round trip. (The alternative DOM-measure channel — evalInSimulator against the device-shell `<webview>`'s own rect — was NOT used for geometry assertions: it measures the HOST's layout of the render-guest container, one layer further from what the mini-app's own JS actually observes, and this harness's session never resizes its WebContentsView bounds in response to orientation anyway — see native-host-device.spec.ts's doc comment on the same tradeoff.
 * DOM measurement IS used below for the chrome checks (status bar / nav bar), where there is no `wx` API equivalent to read.)
 *   - EVENTS: `Page.onResize` — the fixture pages
 * (fixtures/landscape-app/pages/{landscape-page,auto-page}) record call count + last argument into `data`, read back through `getPageData` (the same App-data-tap mechanism native-host-navigate-data.spec.ts uses for page data assertions).
 *   - CHROME: `evalInSimulator` DOM queries against the device-shell's own
 *     `.device-statusbar` / `.nav-bar` elements.
 *
 * Rotation-driving mechanism: `hooks.rotateDevice()`, added to electron-entry.js alongside the pre-existing `setDevice` hook.
 * It broadcasts DEVICE_CHANGE to the mounted DeviceShell(s) ONLY, deliberately skipping the raw `service-host:host-env:update` push `setDevice` also does — see rotateDeviceHook's doc comment in electron-entry.js for why: that push is orientation-unaware and never gates through DeviceShell's own dispatch logic, so it cannot stand in for a real rotation in tests that assert onResize dispatch/gating.
 */
import { test, expect, useSharedProject } from './fixtures'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  evalInSimulator,
  pollUntil,
  callWxMethod,
  getCurrentPage,
  getPageData,
  waitForServicePageReady,
} from './helpers'
import type { ElectronApplication } from '@playwright/test'
import type { NativeDeviceInfo } from '@dimina-kit/electron-runtime'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'landscape-app')
const APP_ID = 'devtools_landscape_fixture' // fixtures/landscape-app/project.config.json appid

const HOME_ROUTE = 'pages/home/home'
const LANDSCAPE_ROUTE = 'pages/landscape-page/landscape-page'
const AUTO_ROUTE = 'pages/auto-page/auto-page'

// ── Device rotation (see the module doc comment for why this bypasses `setDevice`'s raw host-env push and only exercises the DEVICE_CHANGE -> DeviceShell wire) ──

/**
 * screenWidth/screenHeight stay PORTRAIT-baseline (see NativeDeviceInfo's own doc comment) — only `deviceOrientation` changes between calls, mirroring exactly what a real rotate action changes on the device state.
 */
function device(orientation: 'portrait' | 'landscape'): NativeDeviceInfo {
  return {
    brand: 'Apple',
    model: 'iPhone 14 Pro',
    system: 'iOS 16.3',
    platform: 'ios',
    pixelRatio: 3,
    screenWidth: 393,
    screenHeight: 852,
    statusBarHeight: 54,
    notchType: 'dynamic-island',
    safeAreaInsets: { top: 54, right: 0, bottom: 34, left: 0 },
    deviceOrientation: orientation,
  }
}

async function rotateDevice(app: ElectronApplication, orientation: 'portrait' | 'landscape'): Promise<void> {
  await app.evaluate((_electron, d) => {
    const hooks = (globalThis as Record<string, unknown>).__diminaE2eHooks as { rotateDevice: (device: unknown) => void }
    hooks.rotateDevice(d)
  }, device(orientation))
}

// ── Geometry (service-host wx.getSystemInfoSync(), see the module doc comment) ──

interface ReportedInfo {
  windowWidth?: number
  windowHeight?: number
  deviceOrientation?: string
}

async function readServiceSystemInfo(app: ElectronApplication): Promise<ReportedInfo> {
  return pollUntil<ReportedInfo>(
    () => app.evaluate(async ({ webContents }) => {
      const svc = webContents.getAllWebContents().find(
        (wc) => !wc.isDestroyed() && wc.getURL().includes('/service-host/service.html'),
      )
      if (!svc) throw new Error('service.html not found')
      return svc.executeJavaScript(`(() => {
        const w = globalThis.wx
        if (!w || typeof w.getSystemInfoSync !== 'function') throw new Error('wx.getSystemInfoSync missing')
        const i = w.getSystemInfoSync()
        return { windowWidth: i.windowWidth, windowHeight: i.windowHeight, deviceOrientation: i.deviceOrientation }
      })()`)
    }).catch(() => ({}) as ReportedInfo),
    (info) =>
      typeof info.windowWidth === 'number' && Number.isFinite(info.windowWidth)
      && typeof info.windowHeight === 'number' && Number.isFinite(info.windowHeight),
    20_000,
    400,
  )
}

// ── Page data (onResize count/payload, see fixtures/landscape-app pages) ──

async function getData(app: ElectronApplication): Promise<Record<string, unknown>> {
  const data = await getPageData(app, APP_ID)
  return (data && typeof data === 'object') ? (data as Record<string, unknown>) : {}
}

async function waitForRoute(app: ElectronApplication, route: string): Promise<void> {
  await pollUntil(
    () => getCurrentPage(app, APP_ID).catch(() => null),
    (r) => !!r && typeof r.path === 'string' && r.path.includes(route),
    15_000,
    500,
  )
}

// ── Chrome (device-shell status bar / nav bar DOM, see status-bar.tsx / navigation-bar.tsx) ──

interface ChromeProbe {
  present: boolean
  height: number
}

async function probeStatusBar(app: ElectronApplication): Promise<ChromeProbe> {
  return evalInSimulator<ChromeProbe>(app, `(() => {
    const el = document.querySelector('.device-statusbar')
    if (!el) return { present: false, height: 0 }
    return { present: true, height: el.getBoundingClientRect().height }
  })()`)
}

async function probeNavBar(app: ElectronApplication): Promise<ChromeProbe> {
  return evalInSimulator<ChromeProbe>(app, `(() => {
    const el = document.querySelector('.nav-bar')
    if (!el) return { present: false, height: 0 }
    return { present: true, height: el.getBoundingClientRect().height }
  })()`)
}

test.describe('native-host config-driven page orientation', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  useSharedProject(test, FIXTURE_DIR)

  // DeviceShell must be MOUNTED (its DEVICE_CHANGE listener subscribed) before anything below is meaningful — a rotation broadcast before mount is simply missed (no catch-up/replay for DEVICE_CHANGE).
  // This has to run in `beforeAll` — BEFORE `beforeEach` below ever rotates the device — because Playwright always finishes every `beforeAll` before the first `beforeEach` of the first test, whereas a wait placed inside test 1's own body would run AFTER that first `beforeEach` already fired.
  test.beforeAll(async ({ _workerElectron }) => {
    await pollUntil(
      () => evalInSimulator<number>(
        _workerElectron.app,
        `(() => document.querySelectorAll('.device-shell__webview').length)()`,
      ).catch(() => 0),
      (n) => n >= 1,
      25_000,
      300,
    )
    // The route APIs resolve against the SERVICE host's own page stack, which is still empty for a few hundred ms after the render guest mounts.
    // Navigating inside that window throws in the mini-app framework.
    await waitForServicePageReady(_workerElectron.app)
  })

  // Device orientation is NOT part of useSharedProject's afterEach reset (that only unwinds the page stack + clears storage), so pin a known baseline before every test regardless of what the previous test rotated to.
  test.beforeEach(async ({ electronApp }) => {
    await rotateDevice(electronApp, 'portrait')
  })

  test('landscape-orientation page reports a landscape viewport and never fires onResize on device rotation', async ({ electronApp }) => {
    await callWxMethod(electronApp, 'navigateTo', [{ url: '/' + LANDSCAPE_ROUTE }])
    await waitForRoute(electronApp, LANDSCAPE_ROUTE)

    const info = await readServiceSystemInfo(electronApp)
    expect(
      info.windowWidth!,
      `fixed-landscape page should report windowWidth > windowHeight (got ${info.windowWidth}x${info.windowHeight})`,
    ).toBeGreaterThan(info.windowHeight!)

    // Rotate the underlying device twice (both directions) — a fixed page must never dispatch onResize regardless of device rotation.
    await rotateDevice(electronApp, 'landscape')
    await new Promise((r) => setTimeout(r, 1000))
    await rotateDevice(electronApp, 'portrait')
    await new Promise((r) => setTimeout(r, 1000))

    const data = await getData(electronApp)
    expect(
      data.resizeCount ?? 0,
      'fixed-orientation page must never receive Page.onResize, even across two device rotations',
    ).toBe(0)

    await callWxMethod(electronApp, 'navigateBack', [{ delta: 1 }])
    await waitForRoute(electronApp, HOME_ROUTE)
  })

  test('auto-orientation page follows device rotation and fires exactly one onResize', async ({ electronApp }) => {
    await callWxMethod(electronApp, 'navigateTo', [{ url: '/' + AUTO_ROUTE }])
    await waitForRoute(electronApp, AUTO_ROUTE)

    const before = await getData(electronApp)
    expect(before.resizeCount ?? 0, 'auto page should have received no resize calls before any rotation').toBe(0)

    await rotateDevice(electronApp, 'landscape')

    const after = await pollUntil(
      () => getData(electronApp),
      (d) => Number(d.resizeCount ?? 0) > 0,
      15_000,
      500,
    )
    expect(after.resizeCount, 'one rotation should dispatch exactly one onResize (coalesced, not doubled)').toBe(1)

    const last = after.lastResize as { size?: { windowWidth?: number; windowHeight?: number }; deviceOrientation?: string } | null
    expect(last?.deviceOrientation, 'onResize payload should report the new device orientation').toBe('landscape')
    expect(
      last?.size?.windowWidth,
      `onResize size should be landscape (got ${JSON.stringify(last?.size)})`,
    ).toBeGreaterThan(last?.size?.windowHeight ?? Number.POSITIVE_INFINITY)

    await callWxMethod(electronApp, 'navigateBack', [{ delta: 1 }])
    await waitForRoute(electronApp, HOME_ROUTE)
  })

  test('landscape hides the status bar chrome but keeps the nav bar', async ({ electronApp }) => {
    await callWxMethod(electronApp, 'navigateTo', [{ url: '/' + LANDSCAPE_ROUTE }])
    await waitForRoute(electronApp, LANDSCAPE_ROUTE)

    const statusBar = await probeStatusBar(electronApp)
    // device-shell.tsx renders `<StatusBar>` behind `statusBarHeight > 0` — in landscape (phone) that's false, so the `.device-statusbar` node is entirely absent, not merely collapsed to height 0.
    expect(
      statusBar.present,
      `phone landscape must not render the status bar node at all — got present=${statusBar.present} height=${statusBar.height}`,
    ).toBe(false)

    const navBar = await probeNavBar(electronApp)
    expect(navBar.present, 'nav bar must stay mounted in landscape (nav bar height does not change with orientation)').toBe(true)
    expect(navBar.height, 'nav bar must keep a non-zero rendered height in landscape').toBeGreaterThan(0)

    await callWxMethod(electronApp, 'navigateBack', [{ delta: 1 }])
    await waitForRoute(electronApp, HOME_ROUTE)
  })

  test('navigateTo a landscape page flips the screen; navigateBack restores portrait', async ({ electronApp }) => {
    const beforeInfo = await readServiceSystemInfo(electronApp)
    expect(
      beforeInfo.windowHeight!,
      `home page (default portrait) should start taller than wide (got ${beforeInfo.windowWidth}x${beforeInfo.windowHeight})`,
    ).toBeGreaterThan(beforeInfo.windowWidth!)

    await callWxMethod(electronApp, 'navigateTo', [{ url: '/' + LANDSCAPE_ROUTE }])
    await waitForRoute(electronApp, LANDSCAPE_ROUTE)
    const duringInfo = await readServiceSystemInfo(electronApp)
    expect(duringInfo.windowWidth!, 'navigateTo a fixed-landscape page should flip the screen to landscape').toBeGreaterThan(duringInfo.windowHeight!)

    await callWxMethod(electronApp, 'navigateBack', [{ delta: 1 }])
    await waitForRoute(electronApp, HOME_ROUTE)
    const afterInfo = await readServiceSystemInfo(electronApp)
    expect(
      afterInfo.windowHeight!,
      'navigateBack should restore the portrait viewport the entry page had before routing away',
    ).toBeGreaterThan(afterInfo.windowWidth!)
  })

  test('two consecutive rotations on an auto page each fire their own onResize', async ({ electronApp }) => {
    await callWxMethod(electronApp, 'navigateTo', [{ url: '/' + AUTO_ROUTE }])
    await waitForRoute(electronApp, AUTO_ROUTE)

    await rotateDevice(electronApp, 'landscape')
    const first = await pollUntil(
      () => getData(electronApp),
      (d) => Number(d.resizeCount ?? 0) >= 1,
      15_000,
      500,
    )
    expect(first.resizeCount, 'first rotation should fire the first onResize').toBe(1)

    await rotateDevice(electronApp, 'portrait')
    const second = await pollUntil(
      () => getData(electronApp),
      (d) => Number(d.resizeCount ?? 0) >= 2,
      15_000,
      500,
    )
    expect(second.resizeCount, 'a second, consecutive rotation must fire a second onResize — not be swallowed or coalesced across rotations').toBe(2)
    const last = second.lastResize as { deviceOrientation?: string } | null
    expect(last?.deviceOrientation, 'the second onResize payload should report the second rotation\'s orientation').toBe('portrait')

    await callWxMethod(electronApp, 'navigateBack', [{ delta: 1 }])
    await waitForRoute(electronApp, HOME_ROUTE)
  })

  test('enter the landscape page, go back, and enter it again — geometry is correct both times', async ({ electronApp }) => {
    await callWxMethod(electronApp, 'navigateTo', [{ url: '/' + LANDSCAPE_ROUTE }])
    await waitForRoute(electronApp, LANDSCAPE_ROUTE)
    const first = await readServiceSystemInfo(electronApp)
    expect(first.windowWidth!, 'first entry into the landscape page should flip landscape').toBeGreaterThan(first.windowHeight!)

    await callWxMethod(electronApp, 'navigateBack', [{ delta: 1 }])
    await waitForRoute(electronApp, HOME_ROUTE)
    const backHome = await readServiceSystemInfo(electronApp)
    expect(backHome.windowHeight!, 'back on the entry page should restore portrait').toBeGreaterThan(backHome.windowWidth!)

    await callWxMethod(electronApp, 'navigateTo', [{ url: '/' + LANDSCAPE_ROUTE }])
    await waitForRoute(electronApp, LANDSCAPE_ROUTE)
    const second = await readServiceSystemInfo(electronApp)
    expect(
      second.windowWidth!,
      're-entering the landscape page a second time should flip landscape again (not get stuck on the first exit\'s restored portrait)',
    ).toBeGreaterThan(second.windowHeight!)

    await callWxMethod(electronApp, 'navigateBack', [{ delta: 1 }])
    await waitForRoute(electronApp, HOME_ROUTE)
  })
})
