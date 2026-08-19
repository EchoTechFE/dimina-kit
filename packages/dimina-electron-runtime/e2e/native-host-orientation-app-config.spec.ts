/**
 * E2E (native-host only): app-level `window.pageOrientation` resolution and its interaction with the cold-start seed and exit/reopen recovery.
 *
 * Contract pinned here (see docs/landscape-support.md and bridge-router.ts's `resolvePageWindowConfig` / cold-start seed):
 *
 *   1. A page with no `pageOrientation` of its own inherits app.json's
 * `window.pageOrientation`.
 * When that app-level value is a fixed orientation, the ROOT page must already report that orientation on its very first frame — the cold-start seed uses the root page's EFFECTIVE orientation, not the raw device orientation, because DeviceShell only sends its first authoritative PAGE_RESIZE after the spawn already resolved.
 * This is asserted from a SYNCHRONOUS `wx.getSystemInfoSync()` call the fixture itself makes from App.onLaunch and the entry page's own onLoad (see fixtures/orientation-app-landscape/app.js and pages/entry/entry.js) — polling the geometry via a later snapshot would pass even if the seed were broken and the page only turned landscape after a subsequent PAGE_RESIZE corrected it.
 *   2. A page-level `pageOrientation` overrides the app-level one, in both
 * directions: a page-level 'auto' escapes an app-level fixed orientation and follows the device again; a page-level fixed value overrides an app-level fixed value with its own.
 *   3. The simulated device's own orientation is never written back to by a
 * mini-app's forced orientation, at the APP level exactly as at the page level: closing the session and reopening it must show the device's real, untouched orientation.
 * Because the entry page here is itself fixed by app-level config, the exit-recovery assertion routes through an 'auto' page instead of the entry page — only an 'auto' page can reveal what the device orientation actually is.
 *
 * Fixtures:
 *   - e2e/fixtures/orientation-app-landscape — app.json's window carries
 * `pageOrientation: "landscape"`. pages/entry (no page-level config, inherits the app's landscape), pages/autopage ('auto', escapes the app-level landscape and follows the device), pages/portraitpage ('portrait', overrides the app-level landscape).
 *   - e2e/fixtures/landscape-app — a wholly UNCONFIGURED app (no
 * window.pageOrientation) whose home page also carries no page-level config, so both levels resolve to the DEFAULT_PAGE_ORIENTATION fallback ('portrait').
 * Reused as-is (not modified) to cover the all-default corner of the config matrix combined with exit-recovery.
 *
 * Driving mechanism: `__diminaE2eHooks.rotateDevice()`, not `setDevice()` — see native-host-orientation-config.spec.ts's module doc comment for why `setDevice`'s raw host-env push cannot stand in for a real rotation. `wx.navigateTo`/`navigateBack` go through `callWxMethod`, matching native-host-orientation-config.spec.ts; no fixture button taps are needed.
 *
 * Geometry is read from the SERVICE host's own `wx.getSystemInfoSync()` (`readServiceSystemInfo`) — the authoritative channel the mini-app's own code observes, exactly as the sibling orientation specs do.
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import {
  openProject,
  waitForSimulatorWebview,
  closeProject,
  pollUntil,
  evalInSimulator,
  getCurrentPage,
  getPageData,
  waitForServicePageReady,
  callWxMethod,
} from './helpers'
import type { NativeDeviceInfo } from '@dimina-kit/electron-runtime'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_LANDSCAPE_DIR = path.resolve(__dirname, 'fixtures', 'orientation-app-landscape')
const DEFAULT_APP_DIR = path.resolve(__dirname, 'fixtures', 'landscape-app')

const ENTRY_ROUTE = 'pages/entry/entry'
const AUTO_ROUTE = 'pages/autopage/autopage'
const PORTRAIT_ROUTE = 'pages/portraitpage/portraitpage'
const DEFAULT_AUTO_ROUTE = 'pages/auto-page/auto-page'

let electronApp: ElectronApplication
let mainWindow: PwPage

// ── Device rotation (see the module doc comment for why this goes through rotateDevice, not setDevice) ─────────────────────────────────────────

function device(orientation: 'portrait' | 'landscape'): NativeDeviceInfo {
  return {
    brand: 'Apple',
    model: 'iPhone SE',
    system: 'iOS 15.0',
    platform: 'ios',
    pixelRatio: 2,
    screenWidth: 375,
    screenHeight: 667,
    statusBarHeight: 20,
    notchType: 'none',
    safeAreaInsets: { top: 20, right: 0, bottom: 0, left: 0 },
    deviceOrientation: orientation,
  }
}

async function rotateDevice(app: ElectronApplication, orientation: 'portrait' | 'landscape'): Promise<void> {
  await app.evaluate((_electron, d) => {
    const hooks = (globalThis as Record<string, unknown>).__diminaE2eHooks as { rotateDevice: (device: unknown) => void }
    hooks.rotateDevice(d)
  }, device(orientation))
}

// ── Geometry (service-host wx.getSystemInfoSync()) ────────────────────

interface ReportedInfo {
  windowWidth?: number
  windowHeight?: number
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
        return { windowWidth: i.windowWidth, windowHeight: i.windowHeight }
      })()`)
    }).catch(() => ({}) as ReportedInfo),
    (info) =>
      typeof info.windowWidth === 'number' && Number.isFinite(info.windowWidth)
      && typeof info.windowHeight === 'number' && Number.isFinite(info.windowHeight),
    20_000,
    400,
  )
}

/** Poll until the reported viewport matches `expected` — orientation changes
 * are asynchronous, so a single snapshot right after a triggering action can race a not-yet-landed update. */
async function waitForOrientation(app: ElectronApplication, expected: 'portrait' | 'landscape'): Promise<ReportedInfo> {
  return pollUntil<ReportedInfo>(
    () => readServiceSystemInfo(app),
    (info) => {
      const w = info.windowWidth ?? -1
      const h = info.windowHeight ?? -1
      return expected === 'landscape' ? w > h : w < h
    },
    15_000,
    400,
  )
}

async function waitForRoute(app: ElectronApplication, appId: string, route: string): Promise<void> {
  await pollUntil(
    () => getCurrentPage(app, appId).catch(() => null),
    (r) => !!r && typeof r.path === 'string' && r.path.includes(route),
    15_000,
    500,
  )
}

// ── Cold-start seed snapshot (fixtures/orientation-app-landscape's entry page) ──

interface EntryLoadSnapshot {
  onLoadWindowWidth?: number
  onLoadWindowHeight?: number
  onLaunchWindowWidth?: number
  onLaunchWindowHeight?: number
}

async function getEntryLoadData(app: ElectronApplication, appId: string): Promise<EntryLoadSnapshot> {
  const data = await getPageData(app, appId)
  return (data && typeof data === 'object') ? (data as EntryLoadSnapshot) : {}
}

/**
 * Poll only until the entry page's onLoad/onLaunch snapshot has been WRITTEN — those fields are each a synchronous read taken exactly once (App.onLaunch, Page.onLoad) and never change again afterwards, so polling their VALUE the way `waitForOrientation` does would defeat the point: a broken cold-start seed that only self-corrects after a later PAGE_RESIZE would still eventually satisfy a value-based poll.
 * Only the snapshot's ARRIVAL is legitimately async (the page needs to instantiate first); the comparison itself must run on the one value that was captured.
 */
async function waitForEntryLoadSnapshot(app: ElectronApplication, appId: string): Promise<EntryLoadSnapshot> {
  return pollUntil<EntryLoadSnapshot>(
    () => getEntryLoadData(app, appId),
    (d) => typeof d.onLoadWindowWidth === 'number' && typeof d.onLaunchWindowWidth === 'number',
    15_000,
    300,
  )
}

test.describe('native-host app-level window.pageOrientation resolution + exit-recovery e2e', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)

  test.beforeAll(async () => {
    test.setTimeout(180_000)
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'electron-runtime-e2e'),
      'userdata',
      `nh-orientation-app-config-${process.pid}`,
    )
    fs.mkdirSync(userDataDir, { recursive: true })

    electronApp = await _electron.launch({
      args: [appPath, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, NODE_ENV: 'test', DIMINA_E2E_USER_DATA_DIR: userDataDir },
    })

    mainWindow = await electronApp.firstWindow()
    await mainWindow.waitForLoadState('domcontentloaded')

    await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win && !win.isVisible()) {
        await new Promise<void>((resolve) => {
          win.once('show', resolve)
          setTimeout(resolve, 5000)
        })
      }
      if (win) {
        win.setPosition(-2000, -2000)
        win.blur()
      }
    })
  })

  test.afterEach(async () => {
    await closeProject(electronApp).catch(() => {})
  })

  test.afterAll(async () => {
    await closeProject(electronApp).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  async function openFixtureAndWait(dir: string): Promise<string> {
    const { appId } = await openProject(electronApp, dir)
    await waitForSimulatorWebview(electronApp)
    await pollUntil(
      () => evalInSimulator<boolean>(
        electronApp,
        `(() => !!document.querySelector('.device-shell-root'))()`,
      ).catch(() => false),
      (ok) => ok === true,
      25_000,
      300,
    )
    await pollUntil(
      () => getCurrentPage(electronApp, appId).catch(() => null),
      (r) => !!r && typeof r.path === 'string' && r.path.includes('pages/'),
      20_000,
      500,
    )
    await waitForServicePageReady(electronApp, appId)
    return appId
  }

  /** Set the device before opening (persists into the session spawn), open, then re-sync the now-live session. */
  async function openFixture(dir: string, initialOrientation: 'portrait' | 'landscape'): Promise<string> {
    await rotateDevice(electronApp, initialOrientation)
    const appId = await openFixtureAndWait(dir)
    await rotateDevice(electronApp, initialOrientation)
    await new Promise((r) => setTimeout(r, 1000))
    return appId
  }

  test('portrait device + app-level landscape: entry page renders landscape on the very first frame; exit and reopen leave the device portrait', async () => {
    const appId = await openFixture(APP_LANDSCAPE_DIR, 'portrait')

    // No polling on the VALUE here — see waitForEntryLoadSnapshot's doc comment.
    // Both a page's own onLoad and App.onLaunch are synchronous calls that ran once, before this test could have observed any later PAGE_RESIZE correction.
    const snapshot = await waitForEntryLoadSnapshot(electronApp, appId)
    expect(
      snapshot.onLoadWindowWidth!,
      `entry's own synchronous wx.getSystemInfoSync() call in onLoad must already read landscape — the cold-start seed exists precisely so this call does not need a later PAGE_RESIZE to correct it (got ${snapshot.onLoadWindowWidth}x${snapshot.onLoadWindowHeight})`,
    ).toBeGreaterThan(snapshot.onLoadWindowHeight!)
    expect(
      snapshot.onLaunchWindowWidth!,
      `App.onLaunch's own (even earlier) synchronous read must also already be landscape (got ${snapshot.onLaunchWindowWidth}x${snapshot.onLaunchWindowHeight})`,
    ).toBeGreaterThan(snapshot.onLaunchWindowHeight!)

    await closeProject(electronApp)

    // Reopen WITHOUT touching the device — the entry page's forced landscape must not have overwritten the device's real (portrait) orientation.
    const reopenedAppId = await openFixtureAndWait(APP_LANDSCAPE_DIR)
    await callWxMethod(electronApp, 'navigateTo', [{ url: '/' + AUTO_ROUTE }])
    await waitForRoute(electronApp, reopenedAppId, AUTO_ROUTE)
    const afterReopen = await waitForOrientation(electronApp, 'portrait')
    expect(
      afterReopen.windowHeight!,
      'the auto page must show the device is still portrait after exit — the entry page\'s forced landscape must not have been written back',
    ).toBeGreaterThan(afterReopen.windowWidth!)
  })

  test('landscape device + app-level landscape: entry page renders landscape', async () => {
    await openFixture(APP_LANDSCAPE_DIR, 'landscape')
    const info = await waitForOrientation(electronApp, 'landscape')
    expect(
      info.windowWidth!,
      `device and app-level config agree on landscape (got ${info.windowWidth}x${info.windowHeight})`,
    ).toBeGreaterThan(info.windowHeight!)
  })

  test('landscape device + a wholly unconfigured app: home page renders portrait (the default fallback); exit and reopen leave the device landscape', async () => {
    await openFixture(DEFAULT_APP_DIR, 'landscape')
    const info = await waitForOrientation(electronApp, 'portrait')
    expect(
      info.windowHeight!,
      `an app with no window.pageOrientation and a page with no pageOrientation of its own must resolve to the 'portrait' default, even under a landscape device (got ${info.windowWidth}x${info.windowHeight})`,
    ).toBeGreaterThan(info.windowWidth!)

    await closeProject(electronApp)

    const reopenedAppId = await openFixtureAndWait(DEFAULT_APP_DIR)
    await callWxMethod(electronApp, 'navigateTo', [{ url: '/' + DEFAULT_AUTO_ROUTE }])
    await waitForRoute(electronApp, reopenedAppId, DEFAULT_AUTO_ROUTE)
    const afterReopen = await waitForOrientation(electronApp, 'landscape')
    expect(
      afterReopen.windowWidth!,
      'the auto page must show the device is still landscape after exit — the home page\'s default-resolved portrait must not have been written back',
    ).toBeGreaterThan(afterReopen.windowHeight!)
  })

  test('app-level landscape + page-level auto: navigating to the auto page under a portrait device shows portrait, escaping the app-level landscape', async () => {
    const appId = await openFixture(APP_LANDSCAPE_DIR, 'portrait')
    await callWxMethod(electronApp, 'navigateTo', [{ url: '/' + AUTO_ROUTE }])
    await waitForRoute(electronApp, appId, AUTO_ROUTE)
    const info = await waitForOrientation(electronApp, 'portrait')
    expect(
      info.windowHeight!,
      `pageOrientation:'auto' must override the app-level 'landscape' and follow the (portrait) device (got ${info.windowWidth}x${info.windowHeight})`,
    ).toBeGreaterThan(info.windowWidth!)
  })

  test('app-level landscape + page-level portrait: navigateTo flips portrait; navigateBack restores the entry page\'s own (app-inherited) landscape', async () => {
    const appId = await openFixture(APP_LANDSCAPE_DIR, 'portrait')
    await callWxMethod(electronApp, 'navigateTo', [{ url: '/' + PORTRAIT_ROUTE }])
    await waitForRoute(electronApp, appId, PORTRAIT_ROUTE)
    const during = await waitForOrientation(electronApp, 'portrait')
    expect(
      during.windowHeight!,
      `pageOrientation:'portrait' must override the app-level 'landscape' (got ${during.windowWidth}x${during.windowHeight})`,
    ).toBeGreaterThan(during.windowWidth!)

    await callWxMethod(electronApp, 'navigateBack', [{ delta: 1 }])
    await waitForRoute(electronApp, appId, ENTRY_ROUTE)
    const after = await waitForOrientation(electronApp, 'landscape')
    expect(
      after.windowWidth!,
      'navigateBack must restore the entry page\'s own orientation (the app-inherited landscape), not stay stuck on the portrait page it left',
    ).toBeGreaterThan(after.windowHeight!)
  })
})
