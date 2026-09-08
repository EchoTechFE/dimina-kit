/**
 * E2E (native-host): the simulator machine body is `<device-frame>`
 * (the shared @devicekit/frame package), driven by the toolbar's device picker
 * through the SAME `setNativeDeviceInfo` IPC path
 * that feeds the mini-app's own `wx.getSystemInfoSync()`.
 *
 * This pins the real user path end to end:
 *   toolbar device picker -> DeviceShell's <device-frame> attributes/shadow
 *   DOM (bezel, status bar, nav bar) AND -> main process host-env snapshot ->
 *   service-host `wx.getSystemInfoSync()` AND -> CDP
 *   `Emulation.setSafeAreaInsetsOverride` on the render-host guest's
 *   `env(safe-area-inset-*)`.
 *
 * Expected numbers come straight from the @devicekit/devices table (the same
 * table both the frame and the toolbar consume) instead of being hand-copied,
 * so a change to the table can never silently desync this spec from product
 * behavior.
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import {
  openProjectInUI,
  waitForSimulatorWebview,
  waitSimulatorReady,
  closeProject,
  ipcInvoke,
  pollUntil,
  evalInSimulator,
  evalInWebContentsByUrl,
  findMainWindow,
  installConsoleCollector,
  readConsoleErrors,
  devicePickerToolbarButton,
  selectDeviceInPicker,
} from './helpers'
import { AutomationChannel } from '../src/shared/ipc-channels'
import {
  DEVICE_NAMES,
  findDevice,
  resolveDevice,
  orientedScreen,
  safeAreaInsetsFor,
  statusBarHeightFor,
  type Orientation,
} from '@devicekit/devices'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')

let electronApp: ElectronApplication
let mainWindow: PwPage
let workbench: PwPage

// ── Expected-value derivation (mirrors status-bar-layout.ts's modeFor — this
// spec has no access to the frame's internals, only its declared `data-layout`
// attribute contract, so it re-derives the expected mode from the SAME
// @devicekit/devices table the frame itself resolves against). ──────────
function expectedLayoutMode(deviceName: string, orientation: Orientation): string {
  const profile = findDevice(deviceName)
  if (!profile) throw new Error(`[e2e] unknown device preset: ${deviceName}`)
  const resolved = resolveDevice(profile)
  if (resolved.os === 'ios') {
    const screen = orientedScreen(profile, orientation)
    const shortSide = Math.min(screen.width, screen.height)
    if (shortSide >= 744) return 'ipad'
    return resolved.cutout ? 'ios-cutout' : 'ios-classic'
  }
  return 'android'
}

// ── Toolbar driving ────────────────────────────────────────────────────
async function selectDevice(win: PwPage, deviceName: string): Promise<void> {
  await selectDeviceInPicker(win, electronApp, deviceName)
}

// ── Frame / shadow-DOM readback ────────────────────────────────────────
interface FrameSnapshot {
  device: string | null
  orientation: string | null
  layout: string | null
  screenWidth: number
  screenHeight: number
  navBarClass: string | null
}

async function readFrameSnapshot(app: ElectronApplication): Promise<FrameSnapshot | null> {
  return evalInSimulator<FrameSnapshot | null>(app, `(() => {
    const el = document.querySelector('device-frame')
    if (!el || !el.shadowRoot) return null
    const sb = el.shadowRoot.querySelector('.status-bar')
    const screen = el.shadowRoot.querySelector('.screen')
    if (!screen) return null
    const rect = screen.getBoundingClientRect()
    const navBar = document.querySelector('.nav-bar')
    return {
      device: el.getAttribute('device'),
      orientation: el.getAttribute('orientation'),
      layout: sb ? sb.getAttribute('data-layout') : null,
      screenWidth: rect.width,
      screenHeight: rect.height,
      navBarClass: navBar ? navBar.className : null,
    }
  })()`)
}

// ── service-host wx.getSystemInfoSync() readback ───────────────────────
interface ServiceSystemInfo {
  platform?: string
  screenWidth?: number
  screenHeight?: number
  statusBarHeight?: number
  deviceOrientation?: string
  safeAreaTop?: number
}

async function readServiceSystemInfo(app: ElectronApplication): Promise<ServiceSystemInfo> {
  return evalInWebContentsByUrl<ServiceSystemInfo>(app, 'service-host/service.html', `(() => {
    const w = globalThis.wx
    if (!w || typeof w.getSystemInfoSync !== 'function') throw new Error('wx.getSystemInfoSync missing')
    const i = w.getSystemInfoSync()
    return {
      platform: i.platform,
      screenWidth: i.screenWidth,
      screenHeight: i.screenHeight,
      statusBarHeight: i.statusBarHeight,
      deviceOrientation: i.deviceOrientation,
      safeAreaTop: i.safeArea ? i.safeArea.top : undefined,
    }
  })()`)
}

test.describe('device-frame integration e2e', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e'),
      'userdata',
      `device-frame-${process.pid}`,
    )
    fs.mkdirSync(userDataDir, { recursive: true })

    // NOTE: DIMINA_NATIVE_HOST scoped to THIS spec's own launch, never
    // `process.env` at module scope — a top-level mutation would poison the
    // shared --workers=1 runner and flip every other spec into native-host
    // mode (see native-host-current-page.spec.ts for the same guard).
    electronApp = await _electron.launch({
      args: [appPath, 'auto', '--auto-port', '0', `--user-data-dir=${userDataDir}`],
      env: { ...process.env, NODE_ENV: 'test', DIMINA_NATIVE_HOST: '1', DIMINA_E2E_USER_DATA_DIR: userDataDir },
    })

    mainWindow = await findMainWindow(electronApp)
    await mainWindow.waitForLoadState('domcontentloaded')
    // Install before opening the project, so preload/bridge/frame errors from
    // the simulator, render-host guests and service-host window are captured
    // from their first paint onward (assertion 7).
    await installConsoleCollector(electronApp)

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

    await pollUntil(
      () => ipcInvoke<number | null>(mainWindow, AutomationChannel.GetPort),
      (val) => typeof val === 'number' && val > 0,
      10000,
      100,
    )

    workbench = await openProjectInUI(electronApp, FIXTURE_DIR, { waitMs: 20000 })
    await waitForSimulatorWebview(electronApp)
    await pollUntil(
      () => evalInSimulator<boolean>(
        electronApp,
        `(() => !!document.querySelector('.device-shell-root'))()`,
      ).catch(() => false),
      (ok) => ok === true,
      25000,
      300,
    )
    await waitSimulatorReady(electronApp)
  })

  test.afterAll(async () => {
    await closeProject(electronApp).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('1. boots with device-frame reflecting the toolbar default device', async () => {
    // Fresh per-run userDataDir (mkdir'd above under this process's pid) — no
    // persisted device setting to override the boot default.
    // The toolbar button's label IS the selected device's name.
    const toolbarDevice = (await devicePickerToolbarButton(workbench).innerText()).trim()
    await expect(workbench.getByRole('option', { name: '竖屏' })).toHaveCount(0)
    await expect(workbench.getByRole('option', { name: '横屏' })).toHaveCount(0)

    const snap = await pollUntil(
      () => readFrameSnapshot(electronApp),
      (s) => s !== null && s.device === toolbarDevice,
      8000,
      300,
    )
    expect(snap, 'device-frame should be present in the simulator DOM').not.toBeNull()
    expect(snap!.device).toBe(toolbarDevice)
    expect(snap!.layout).toBe(expectedLayoutMode(toolbarDevice, 'portrait'))

    const expectedScreen = orientedScreen(findDevice(toolbarDevice)!, 'portrait')
    expect(Math.round(snap!.screenWidth)).toBe(expectedScreen.width)
    expect(Math.round(snap!.screenHeight)).toBe(expectedScreen.height)
  })

  test('1b. the page webview fills the screen and the nav bar starts at the screen top (frame content slot must be immersive/flex, not the default block slot)', async () => {
    const snap = await evalInSimulator<{
      screenY: number
      screenBottom: number
      webviewY: number | null
      webviewHeight: number | null
      webviewBottom: number | null
      navBarY: number | null
      navBarBottom: number | null
      tabBarY: number | null
    } | null>(electronApp, `(() => {
      const frame = document.querySelector('device-frame')
      if (!frame || !frame.shadowRoot) return null
      const screen = frame.shadowRoot.querySelector('.screen')
      if (!screen) return null
      const screenRect = screen.getBoundingClientRect()
      const webviews = Array.from(document.querySelectorAll('.device-shell__webview'))
      const visible = webviews.find((el) => getComputedStyle(el).display !== 'none')
      const webviewRect = visible ? visible.getBoundingClientRect() : null
      const navBar = document.querySelector('header.nav-bar')
      const navBarRect = navBar ? navBar.getBoundingClientRect() : null
      const tabBar = document.querySelector('.dmb-tab-bar')
      const tabBarRect = tabBar ? tabBar.getBoundingClientRect() : null
      return {
        screenY: screenRect.y,
        screenBottom: screenRect.y + screenRect.height,
        webviewY: webviewRect ? webviewRect.y : null,
        webviewHeight: webviewRect ? webviewRect.height : null,
        webviewBottom: webviewRect ? webviewRect.y + webviewRect.height : null,
        navBarY: navBarRect ? navBarRect.y : null,
        navBarBottom: navBarRect ? navBarRect.y + navBarRect.height : null,
        tabBarY: tabBarRect ? tabBarRect.y : null,
      }
    })()`)

    expect(snap, 'device-frame .screen and the page webview should both be present').not.toBeNull()
    expect(snap!.webviewHeight, 'visible .device-shell__webview height').not.toBeNull()
    expect(snap!.webviewHeight!).toBeGreaterThan(0)
    expect(snap!.navBarY, 'header.nav-bar rect').not.toBeNull()
    // Nav bar starts at the screen top: it covers the status-bar band itself.
    expect(Math.abs(snap!.navBarY! - snap!.screenY)).toBeLessThanOrEqual(1)
    // The page fills everything between the nav bar and the tab bar (or the
    // screen bottom on a page without one) — no gap, no zero-height viewport.
    expect(Math.abs(snap!.webviewY! - snap!.navBarBottom!)).toBeLessThanOrEqual(1)
    const pageBottom = snap!.tabBarY ?? snap!.screenBottom
    expect(Math.abs(snap!.webviewBottom! - pageBottom)).toBeLessThanOrEqual(1)
  })

  test('2. selecting iPhone 15 renders ios-cutout and the service-host wx reports iOS dims', async () => {
    await selectDevice(workbench, DEVICE_NAMES.iPhone_15)

    const snap = await pollUntil(
      () => readFrameSnapshot(electronApp),
      (s) => s !== null && s.device === DEVICE_NAMES.iPhone_15,
      8000,
      300,
    )
    expect(snap!.device).toBe(DEVICE_NAMES.iPhone_15)
    expect(snap!.layout).toBe('ios-cutout')

    const expectedScreen = orientedScreen(findDevice(DEVICE_NAMES.iPhone_15)!, 'portrait')
    expect(Math.round(snap!.screenWidth)).toBe(expectedScreen.width)
    expect(Math.round(snap!.screenHeight)).toBe(expectedScreen.height)

    const resolved = resolveDevice(findDevice(DEVICE_NAMES.iPhone_15)!)
    const expectedStatusBar = statusBarHeightFor(resolved, 'portrait')
    const expectedSafeArea = safeAreaInsetsFor(resolved, 'portrait')

    const info = await pollUntil(
      () => readServiceSystemInfo(electronApp),
      (i) => i.platform === 'ios' && i.screenWidth === expectedScreen.width,
      8000,
      300,
    )
    expect(info.platform).toBe('ios')
    expect(info.screenWidth).toBe(expectedScreen.width)
    expect(info.screenHeight).toBe(expectedScreen.height)
    expect(info.statusBarHeight).toBe(expectedStatusBar)
    expect(info.deviceOrientation).toBe('portrait')
    expect(info.safeAreaTop).toBe(expectedSafeArea.top)
  })

  test('3. selecting Pixel 8 switches the frame + nav bar to Android styling', async () => {
    await selectDevice(workbench, DEVICE_NAMES.Pixel_8)

    const snap = await pollUntil(
      () => readFrameSnapshot(electronApp),
      (s) => s !== null && s.device === DEVICE_NAMES.Pixel_8,
      8000,
      300,
    )
    expect(snap!.layout).toBe('android')
    // NavigationBar carries a platform modifier class (nav-bar--ios /
    // nav-bar--android — navigation-bar.tsx) independent of the frame's own
    // shadow DOM; android-only proof the DeviceShell's platform plumbing
    // (not just the frame) followed the device switch.
    expect(
      snap!.navBarClass,
      'NavigationBar should carry the android modifier class (nav-bar--android)',
    ).toContain('nav-bar--android')

    const expectedScreen = orientedScreen(findDevice(DEVICE_NAMES.Pixel_8)!, 'portrait')
    const info = await pollUntil(
      () => readServiceSystemInfo(electronApp),
      (i) => i.platform === 'android' && i.screenWidth === expectedScreen.width,
      8000,
      300,
    )
    expect(info.platform).toBe('android')
    expect(info.screenWidth).toBe(412)
  })

  test('4. selecting a different device after prior switches keeps portrait state correct', async () => {
    await selectDevice(workbench, DEVICE_NAMES.iPhone_15)

    const snap = await pollUntil(
      () => readFrameSnapshot(electronApp),
      (s) => s !== null && s.device === DEVICE_NAMES.iPhone_15 && s.orientation === 'portrait',
      8000,
      300,
    )
    expect(snap!.device).toBe(DEVICE_NAMES.iPhone_15)
    expect(snap!.orientation).toBe('portrait')
    expect(snap!.layout).toBe('ios-cutout')

    const expectedScreen = orientedScreen(findDevice(DEVICE_NAMES.iPhone_15)!, 'portrait')
    expect(Math.round(snap!.screenWidth)).toBe(expectedScreen.width)
    expect(Math.round(snap!.screenHeight)).toBe(expectedScreen.height)

    const info = await pollUntil(
      () => readServiceSystemInfo(electronApp),
      (i) => i.platform === 'ios' && i.deviceOrientation === 'portrait' && i.screenWidth === expectedScreen.width,
      8000,
      300,
    )
    expect(info.platform).toBe('ios')
    expect(info.deviceOrientation).toBe('portrait')
    expect(info.screenWidth).toBe(expectedScreen.width)
  })

  test('5. no device-frame / device-info / safe-area console errors were logged across the whole run', async () => {
    const errors = await readConsoleErrors(electronApp)
    const pattern = /device-frame|DeviceFrame|setNativeDeviceInfo|setSafeAreaInsetsOverride/
    const relevant = errors.filter((e) => pattern.test(e.message) || pattern.test(e.source))
    expect(relevant, `unexpected device-frame related console errors:\n${JSON.stringify(relevant, null, 2)}`).toEqual([])
  })
})
