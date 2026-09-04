/**
 * E2E (native-host): the simulator machine body is `<device-frame>`
 * (the shared @devicekit/frame package), driven by the toolbar's
 * device/orientation selects through the SAME `setNativeDeviceInfo` IPC path
 * that feeds the mini-app's own `wx.getSystemInfoSync()`.
 *
 * This pins the real user path end to end:
 *   toolbar <select> -> DeviceShell's <device-frame> attributes/shadow
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
  RENDER_GUEST_URL_MARKER,
  findMainWindow,
  installConsoleCollector,
  readConsoleErrors,
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
  const sel = win.locator('select', { has: win.locator(`option[value="${deviceName}"]`) }).first()
  await sel.selectOption(deviceName)
}

async function selectOrientation(win: PwPage, orientation: Orientation): Promise<void> {
  const sel = win.locator('select', { has: win.locator(`option[value="${orientation}"]`) }).first()
  await sel.selectOption(orientation)
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
    const deviceSelect = workbench.locator('select', { has: workbench.locator(`option[value="${DEVICE_NAMES.iPhone_X}"]`) }).first()
    const toolbarDevice = await deviceSelect.inputValue()

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

  test('4. switching Pixel 8 to landscape swaps both frame and service-host dims', async () => {
    await selectOrientation(workbench, 'landscape')

    const snap = await pollUntil(
      () => readFrameSnapshot(electronApp),
      (s) => s !== null && s.orientation === 'landscape',
      8000,
      300,
    )
    expect(snap!.orientation).toBe('landscape')
    const expectedScreen = orientedScreen(findDevice(DEVICE_NAMES.Pixel_8)!, 'landscape')
    expect(Math.round(snap!.screenWidth)).toBe(expectedScreen.width)
    expect(Math.round(snap!.screenHeight)).toBe(expectedScreen.height)

    const info = await pollUntil(
      () => readServiceSystemInfo(electronApp),
      (i) => i.deviceOrientation === 'landscape' && i.screenWidth === expectedScreen.width,
      8000,
      300,
    )
    expect(info.deviceOrientation).toBe('landscape')
    expect(info.screenWidth).toBe(expectedScreen.width)
    expect(info.screenHeight).toBe(expectedScreen.height)
  })

  test('5. iPhone 15 landscape pushes a non-zero env(safe-area-inset-left) into the render-host guest', async () => {
    await selectDevice(workbench, DEVICE_NAMES.iPhone_15)
    await selectOrientation(workbench, 'landscape')
    await pollUntil(
      () => readFrameSnapshot(electronApp),
      (s) => s !== null && s.device === DEVICE_NAMES.iPhone_15 && s.orientation === 'landscape',
      8000,
      300,
    )

    const resolved = resolveDevice(findDevice(DEVICE_NAMES.iPhone_15)!)
    const expectedLeft = safeAreaInsetsFor(resolved, 'landscape').left
    expect(expectedLeft, 'sanity: iPhone 15 landscape must have a non-zero left inset in the table').toBeGreaterThan(0)

    // Probe env(safe-area-inset-left) the same way a page's own CSS would:
    // a temporary element with `padding-left: env(...)`, read back via
    // getComputedStyle. This is the core hypothesis under test — whether the
    // main process's CDP `Emulation.setSafeAreaInsetsOverride` (issued against
    // the render-host guest, see safe-area/index.ts) actually reaches this
    // guest's env() resolution.
    const measure = () => evalInWebContentsByUrl<number | null>(
      electronApp,
      RENDER_GUEST_URL_MARKER,
      `(() => {
        const probe = document.createElement('div')
        probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;padding-left:env(safe-area-inset-left);'
        document.body.appendChild(probe)
        const value = parseFloat(getComputedStyle(probe).paddingLeft)
        probe.remove()
        return Number.isFinite(value) ? value : null
      })()`,
    )

    const paddingLeft = await pollUntil(measure, (v) => v !== null && v > 0, 8000, 400)
    expect(
      paddingLeft,
      `env(safe-area-inset-left) should reflect the CDP safe-area override (expected ${expectedLeft}px); `
      + 'a value stuck at 0 means the override never reached this render-host guest',
    ).not.toBeNull()
    expect(paddingLeft).toBe(expectedLeft)
  })

  test('6. switching back to portrait then to a different device (second interaction) keeps state correct', async () => {
    await selectOrientation(workbench, 'portrait')
    await selectDevice(workbench, DEVICE_NAMES.Pixel_8)

    const snap = await pollUntil(
      () => readFrameSnapshot(electronApp),
      (s) => s !== null && s.device === DEVICE_NAMES.Pixel_8 && s.orientation === 'portrait',
      8000,
      300,
    )
    expect(snap!.device).toBe(DEVICE_NAMES.Pixel_8)
    expect(snap!.orientation).toBe('portrait')
    expect(snap!.layout).toBe('android')

    const expectedScreen = orientedScreen(findDevice(DEVICE_NAMES.Pixel_8)!, 'portrait')
    expect(Math.round(snap!.screenWidth)).toBe(expectedScreen.width)
    expect(Math.round(snap!.screenHeight)).toBe(expectedScreen.height)

    const info = await pollUntil(
      () => readServiceSystemInfo(electronApp),
      (i) => i.platform === 'android' && i.deviceOrientation === 'portrait' && i.screenWidth === expectedScreen.width,
      8000,
      300,
    )
    expect(info.platform).toBe('android')
    expect(info.deviceOrientation).toBe('portrait')
    expect(info.screenWidth).toBe(expectedScreen.width)
  })

  test('7. no device-frame / device-info / safe-area console errors were logged across the whole run', async () => {
    const errors = await readConsoleErrors(electronApp)
    const pattern = /device-frame|DeviceFrame|setNativeDeviceInfo|setSafeAreaInsetsOverride/
    const relevant = errors.filter((e) => pattern.test(e.message) || pattern.test(e.source))
    expect(relevant, `unexpected device-frame related console errors:\n${JSON.stringify(relevant, null, 2)}`).toEqual([])
  })
})
