/**
 * E2E (native-host only): a page must get onShow/onReady WITHOUT any back
 * navigation — for the launch page and for a freshly `navigateTo`'d page
 * alike.
 *
 * Today it does not (see DESIGN.md's root-cause section): the simulator
 * shell's page-stack reducer only emits `pageShow` for a page restored from a
 * tab cache (navigateBack, switchTab-from-cache), never for a page that is
 * merely newly opened — so service's runtime.js never calls onShow, and
 * onReady (which onShow triggers once onLoad has already fired) never fires
 * either. The unit-level suites (page-stack-controller-fresh-show.test.ts,
 * miniapp-frame-fresh-page-show.test.tsx) pin the same contract at the
 * reducer/component layer; this spec pins it end-to-end through a real
 * Electron process, native-host style — no devtools UI involved.
 *
 * Fixture (e2e/fixtures/page-stack-app): pages = home (tab, entry), explore
 * (tab), a, b, c. Each page's `record()` helper (see pages/home/home.js)
 * appends `{page, hook, ts, stack}` to wx storage key `__pageStackLog`; this
 * spec added onReady/onResize logging to home.js and a.js (the two pages it
 * drives) alongside the pre-existing onLoad/onShow/onHide/onUnload logging —
 * see those files for the shared `record`/`snapshotStack` pattern.
 *
 * A device/orientation switch driving `Page.onResize` is pinned too, since
 * `__diminaE2eHooks.setDevice` exists (native-host-device.spec.ts already
 * drives it). The resize assertion also checks that `wx.getSystemInfoSync()`
 * (captured by the fixture page's own onResize handler as `systemInfo`)
 * reports the same new geometry the `pageResize` event carries — both must
 * come from the one device switch, not just the event payload.
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
  callWxMethod,
} from './helpers'
import type { NativeDeviceInfo } from '@dimina-kit/electron-runtime'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'page-stack-app')

const NAV_TARGET = 'pages/a/a'

interface LogEntry {
  page: string
  hook: string
  ts: number
  size?: { windowWidth?: number; windowHeight?: number; screenWidth?: number; screenHeight?: number } | null
  deviceOrientation?: string
  systemInfo?: { windowWidth?: number; windowHeight?: number } | null
}

/**
 * Read `__pageStackLog` straight out of the service host's own `wx` — the
 * SAME storage the fixture pages write to from their own lifecycle hooks
 * (see pages/home/home.js's `record()`). `wx.getStorageSync` auto-parses
 * JSON, so this can come back either as an already-parsed array or (if the
 * key isn't set yet) `''`/`undefined`; normalize both.
 */
async function readPageStackLog(app: ElectronApplication): Promise<LogEntry[]> {
  const { result } = await callWxMethod(app, 'getStorageSync', ['__pageStackLog'])
  if (Array.isArray(result)) return result as LogEntry[]
  if (typeof result === 'string' && result) {
    try {
      const parsed = JSON.parse(result)
      if (Array.isArray(parsed)) return parsed as LogEntry[]
    } catch {
      /* fall through to empty */
    }
  }
  return []
}

function hooksFor(log: LogEntry[], page: string): string[] {
  return log.filter((e) => e.page === page).map((e) => e.hook)
}

function device(width: number, height: number, statusBarHeight: number): NativeDeviceInfo {
  return {
    brand: 'Apple',
    model: 'iPhone 14 Pro',
    system: 'iOS 16.3',
    platform: 'ios',
    pixelRatio: 3,
    screenWidth: width,
    screenHeight: height,
    statusBarHeight,
    notchType: 'dynamic-island',
    safeAreaInsets: { top: statusBarHeight, right: 0, bottom: 34, left: 0 },
  }
}

// Boot device is whatever the simulator defaults to; this only needs to
// differ from it on both axes so a stuck/never-fired onResize can't
// coincidentally read as a pass.
const LANDSCAPE_DEVICE = device(852, 393, 0)

let electronApp: ElectronApplication
let mainWindow: PwPage

test.describe('native-host page lifecycle — onShow/onReady without a back navigation', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'electron-runtime-e2e'),
      'userdata',
      `nh-page-lifecycle-${process.pid}`,
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

    await openProject(electronApp, FIXTURE_DIR)
    await waitForSimulatorWebview(electronApp)

    await pollUntil(
      () => evalInSimulator<number>(
        electronApp,
        `(() => document.querySelectorAll('.device-shell__webview').length)()`,
      ).catch(() => 0),
      (n) => n >= 1,
      25000,
      300,
    )
  })

  test.afterAll(async () => {
    await closeProject(electronApp).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('the launch page gets onShow and onReady with no back navigation involved', async () => {
    const log = await pollUntil(
      () => readPageStackLog(electronApp),
      (l) => hooksFor(l, 'home').includes('onReady'),
      20000,
      500,
    )
    const homeHooks = hooksFor(log, 'home')
    expect(homeHooks, 'launch page should have recorded onShow').toContain('onShow')
    expect(homeHooks, 'launch page should have recorded onReady').toContain('onReady')
    // onReady only fires once onShow has (service's runtime.js gates it on
    // `state.shown`) — pin the order, not just membership.
    expect(homeHooks.indexOf('onShow')).toBeLessThan(homeHooks.indexOf('onReady'))
  })

  test('a freshly navigateTo\'d page gets onShow and onReady without navigating back', async () => {
    await callWxMethod(electronApp, 'navigateTo', [{ url: `/${NAV_TARGET}` }])

    const log = await pollUntil(
      () => readPageStackLog(electronApp),
      (l) => hooksFor(l, 'a').includes('onReady'),
      20000,
      500,
    )
    const aHooks = hooksFor(log, 'a')
    expect(aHooks, 'navigateTo target should have recorded onLoad').toContain('onLoad')
    expect(aHooks, 'navigateTo target should have recorded onShow').toContain('onShow')
    expect(aHooks, 'navigateTo target should have recorded onReady').toContain('onReady')
    expect(aHooks.indexOf('onLoad')).toBeLessThan(aHooks.indexOf('onShow'))
    expect(aHooks.indexOf('onShow')).toBeLessThan(aHooks.indexOf('onReady'))
  })

  test('switching to a landscape device fires onResize on the visible page with matching size/orientation', async () => {
    await electronApp.evaluate((_electron, d) => {
      const hooks = (globalThis as Record<string, unknown>).__diminaE2eHooks as { setDevice: (d: NativeDeviceInfo) => void }
      hooks.setDevice(d)
    }, LANDSCAPE_DEVICE)

    const log = await pollUntil(
      () => readPageStackLog(electronApp),
      (l) => hooksFor(l, 'a').includes('onResize'),
      20000,
      500,
    )
    const resize = [...log].reverse().find((e) => e.page === 'a' && e.hook === 'onResize')
    expect(resize, 'the currently visible page ("a") should have recorded an onResize').toBeTruthy()
    expect(resize?.deviceOrientation, 'a wider-than-tall device should report landscape').toBe('landscape')
    expect(resize?.size?.screenWidth).toBe(LANDSCAPE_DEVICE.screenWidth)
    expect(resize?.size?.screenHeight).toBe(LANDSCAPE_DEVICE.screenHeight)
    expect(resize?.systemInfo?.windowWidth, 'wx.getSystemInfoSync() should match the pageResize event').toBe(
      resize?.size?.windowWidth,
    )
    expect(resize?.systemInfo?.windowHeight, 'wx.getSystemInfoSync() should match the pageResize event').toBe(
      resize?.size?.windowHeight,
    )
  })
})
