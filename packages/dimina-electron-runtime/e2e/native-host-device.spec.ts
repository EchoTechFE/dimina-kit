/**
 * E2E (native-host only): device selection and zoom must drive the mini-app's
 * reported viewport.
 *
 * Contract (the behaviour the user cares about — the mini-app's own
 * `wx.getSystemInfoSync()` sees the right screen/window size):
 *   1. Selecting a NON-default device makes the mini-app report THAT device's
 *      logical size (screenWidth ≈ W, screenHeight ≈ H), not a fixed default.
 *   2. Changing the device AFTER launch updates those dims live (no relaunch).
 *   3. Changing zoom changes the displayed scale but NOT the LOGICAL reported
 *      dims (getSystemInfo screen/window size is invariant across zoom levels).
 *
 * Observation channel: the SERVICE HOST `wx.getSystemInfoSync()`. That is the
 * authoritative `wx` the running mini-app actually calls (the service bundle
 * runs in the hidden `service.html` window; native-host.spec.ts already
 * confirms `globalThis.wx.getSystemInfoSync` is a function there). It reads
 * the spawn context's host-env snapshot, so it reflects exactly what the
 * mini-app's own code observes.
 *
 * devtools' original version of this spec ALSO pinned the render-host guest's
 * (`__frame__.html`) actual `window.innerWidth` as a secondary check. That is
 * NOT reproduced here: the guest's rendered viewport is bounded by whatever
 * size the HOST gives the embedded session (`session.setBounds()` /
 * devtools' own view-manager resizing the WebContentsView in response to a
 * device change) — a HOST responsibility per the embedding contract, not
 * something `runtime.setDevice()` itself controls. This minimal harness never
 * resizes its session bounds in response to device selection (out of scope —
 * it isn't testing host window/view management), so that secondary pin would
 * only measure this harness's own fixed bounds, not runtime behavior.
 *
 * Driving mechanism: devtools' original version of this spec drove a device/
 * zoom dropdown in its own renderer UI. This harness has no such UI — it
 * drives the exact same underlying behaviour directly against the runtime's
 * public surface: `__diminaE2eHooks.setDevice()` (-> `runtime.setDevice()`,
 * plus the same service-host host-env push devtools' own device-select
 * handler does — see electron-entry.js) for device selection, and
 * `webContents.setZoomFactor()` directly on the simulator WebContents for
 * zoom (what devtools' own zoom dropdown ultimately calls under the hood).
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
} from './helpers'
import type { NativeDeviceInfo } from '@dimina-kit/electron-runtime'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')

// Mirrors the presets this spec needs from devtools' own device list
// (the @devicekit/devices table, as devtools' own use-device.ts consumes it) — only the
// entries actually exercised here, converted to NativeDeviceInfo shape the
// way devtools' own use-device.ts does (brand: 'Apple', platform: 'ios').
function device(model: string, width: number, height: number, pixelRatio: number, statusBarHeight: number, system: string): NativeDeviceInfo {
  return {
    device: model,
    brand: 'Apple',
    model,
    system,
    platform: 'ios',
    orientation: 'portrait',
    pixelRatio,
    screenWidth: width,
    screenHeight: height,
    statusBarHeight,
    safeAreaInsets: { top: statusBarHeight, right: 0, bottom: 34, left: 0 },
  }
}

// The simulator boots on the FIRST preset (iPhone SE, 375×667). Pick presets
// that differ from it on BOTH axes AND from the service-host fallback default
// (390×844 — see sync-impls/system-info.ts) so a "stuck at a fixed size" bug
// can NEVER coincidentally satisfy these assertions.
const DEFAULT_DEVICE = device('iPhone SE', 375, 667, 2, 20, 'iOS 15.0') // boot device
const TARGET_DEVICE = device('iPhone 14 Pro', 393, 852, 3, 54, 'iOS 16.3')
const LIVE_DEVICE = device('iPhone 16 Pro', 402, 874, 3, 59, 'iOS 18.0')
const ZOOM_OPTIONS = [100, 85, 75, 50]

// Sizes that must NOT be reported back if device selection truly wired through:
// the boot device and the system-info fallback default. Used to make the
// failure message explicit about *why* a stuck value is wrong.
const FALLBACK_DEFAULT = { width: 390, height: 844 }

let electronApp: ElectronApplication
let mainWindow: PwPage

interface ReportedInfo {
  screenWidth?: number
  screenHeight?: number
  windowWidth?: number
  windowHeight?: number
  pixelRatio?: number
}

/**
 * Read the AUTHORITATIVE system info the mini-app sees: call
 * `wx.getSystemInfoSync()` inside the service-host window (`service.html`),
 * exactly as the running service bundle would. Polls because the service host
 * spins up asynchronously after spawn.
 */
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
        return {
          screenWidth: i.screenWidth,
          screenHeight: i.screenHeight,
          windowWidth: i.windowWidth,
          windowHeight: i.windowHeight,
          pixelRatio: i.pixelRatio,
        }
      })()`)
    }).catch(() => ({} as ReportedInfo)),
    (info) =>
      typeof info.screenWidth === 'number' && Number.isFinite(info.screenWidth)
      && typeof info.screenHeight === 'number' && Number.isFinite(info.screenHeight),
    30_000,
    400,
  )
}

/** Drive device selection via the runtime's public facade (no UI in this harness). */
async function selectDevice(app: ElectronApplication, deviceInfo: NativeDeviceInfo): Promise<void> {
  await app.evaluate((_electron, d) => {
    const hooks = (globalThis as Record<string, unknown>).__diminaE2eHooks as { setDevice: (d: NativeDeviceInfo) => void }
    hooks.setDevice(d)
  }, deviceInfo)
}

/**
 * Drive zoom directly on the simulator WebContents (what devtools' own zoom
 * dropdown calls under the hood). Fails loudly instead of silently no-oping
 * if the simulator webContents is missing or `setZoomFactor` doesn't actually
 * apply — req3 below only asserts INVARIANCE of the logical dims across a
 * zoom change, so a silent no-op here would make it pass without ever
 * exercising the thing it's meant to guard.
 */
async function selectZoom(app: ElectronApplication, zoomPercent: number): Promise<void> {
  const applied = await app.evaluate(({ webContents }, percent) => {
    const sim = webContents.getAllWebContents().find((wc) => wc.getURL().includes('simulator.html'))
    if (!sim) return null
    sim.setZoomFactor(percent / 100)
    return sim.getZoomFactor()
  }, zoomPercent)
  if (applied === null) throw new Error('[e2e] simulator.html webContents not found for selectZoom')
  const expected = zoomPercent / 100
  if (Math.abs(applied - expected) > 0.001) {
    throw new Error(`[e2e] setZoomFactor(${expected}) did not apply: getZoomFactor() returned ${applied}`)
  }
}

test.describe('native-host device sizing e2e', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'electron-runtime-e2e'),
      'userdata',
      `nh-device-${process.pid}`,
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

    // DeviceShell must mount (native-host render path) before any device-driven
    // assertion is meaningful.
    await pollUntil(
      () => evalInSimulator<boolean>(
        electronApp,
        `(() => !!document.querySelector('.device-shell-root'))()`,
      ).catch(() => false),
      (ok) => ok === true,
      25000,
      300,
    )
  })

  test.afterAll(async () => {
    await closeProject(electronApp).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('req1: selecting a non-default device makes the mini-app report THAT device size', async () => {
    // Sanity: the target preset differs from the boot default AND the fallback
    // default on BOTH axes, so a stuck value cannot accidentally match.
    expect(TARGET_DEVICE.screenWidth).not.toBe(DEFAULT_DEVICE.screenWidth)
    expect(TARGET_DEVICE.screenHeight).not.toBe(DEFAULT_DEVICE.screenHeight)
    expect(TARGET_DEVICE.screenWidth).not.toBe(FALLBACK_DEFAULT.width)
    expect(TARGET_DEVICE.screenHeight).not.toBe(FALLBACK_DEFAULT.height)

    await selectDevice(electronApp, TARGET_DEVICE)

    // Allow the selection a generous window to flow to the spawn host-env
    // snapshot, then read whatever the service host ACTUALLY reports. We do NOT
    // poll-until-match here — that would hide a stuck value behind a timeout;
    // we want the assertion to print the real reported number on failure.
    await new Promise((r) => setTimeout(r, 4000))
    const info = await readServiceSystemInfo(electronApp)

    // Logical screen size must equal the selected device — chrome-independent.
    expect(
      info.screenWidth,
      `screenWidth should reflect ${TARGET_DEVICE.model} (=${TARGET_DEVICE.screenWidth}); `
      + `a stuck default (375 boot / 390 fallback) means device selection had no effect`,
    ).toBe(TARGET_DEVICE.screenWidth)
    expect(
      info.screenHeight,
      `screenHeight should reflect ${TARGET_DEVICE.model} (=${TARGET_DEVICE.screenHeight})`,
    ).toBe(TARGET_DEVICE.screenHeight)
    // windowWidth has no horizontal chrome, so it equals the logical width.
    expect(info.windowWidth, 'windowWidth should equal the device logical width').toBe(TARGET_DEVICE.screenWidth)
    // windowHeight = screenHeight minus system chrome — bound it sensibly.
    expect(info.windowHeight!, 'windowHeight should be <= device screenHeight').toBeLessThanOrEqual(TARGET_DEVICE.screenHeight)
    expect(info.windowHeight!, 'windowHeight should be a meaningful fraction of the device height').toBeGreaterThan(TARGET_DEVICE.screenHeight * 0.6)
  })

  test('req2: changing the device after launch updates the reported dims live', async () => {
    expect(LIVE_DEVICE.screenWidth).not.toBe(TARGET_DEVICE.screenWidth)
    expect(LIVE_DEVICE.screenHeight).not.toBe(TARGET_DEVICE.screenHeight)

    await selectDevice(electronApp, LIVE_DEVICE)

    // Capture the ACTUAL reported value after a live re-select (no relaunch).
    await new Promise((r) => setTimeout(r, 4000))
    const info = await readServiceSystemInfo(electronApp)
    expect(
      info.screenWidth,
      `live device change to ${LIVE_DEVICE.model} should update screenWidth to ${LIVE_DEVICE.screenWidth} without relaunch`,
    ).toBe(LIVE_DEVICE.screenWidth)
    expect(
      info.screenHeight,
      `live device change to ${LIVE_DEVICE.model} should update screenHeight to ${LIVE_DEVICE.screenHeight} without relaunch`,
    ).toBe(LIVE_DEVICE.screenHeight)
    expect(info.windowWidth, 'live device change should update windowWidth').toBe(LIVE_DEVICE.screenWidth)
  })

  test('req3: changing zoom does NOT change the logical reported dims', async () => {
    // GUARD test: zoom is a DISPLAY-only scale; it must never feed the logical
    // system-info. This is order-independent — it reads its OWN baseline
    // (whatever dims are currently reported) and asserts pure INVARIANCE across
    // a zoom change, so it neither depends on nor presumes the device-sizing
    // fix from req1/req2. It should pass today and keep passing after the fix.
    await selectDevice(electronApp, LIVE_DEVICE)
    await selectZoom(electronApp, 100)
    await new Promise((r) => setTimeout(r, 2000))
    const baseline = await readServiceSystemInfo(electronApp)
    expect(typeof baseline.screenWidth, 'baseline screenWidth should be readable').toBe('number')
    expect(typeof baseline.screenHeight, 'baseline screenHeight should be readable').toBe('number')

    // Pick a zoom DIFFERENT from 100%.
    const newZoom = ZOOM_OPTIONS.find((z) => z !== 100)! // e.g. 85
    await selectZoom(electronApp, newZoom)
    await new Promise((r) => setTimeout(r, 2000))
    const afterZoom = await readServiceSystemInfo(electronApp)

    // Logical dims must be IDENTICAL to the baseline — zoom only scales display.
    expect(
      afterZoom.screenWidth,
      `zoom ${newZoom}% must NOT change logical screenWidth (was ${baseline.screenWidth})`,
    ).toBe(baseline.screenWidth)
    expect(
      afterZoom.screenHeight,
      `zoom ${newZoom}% must NOT change logical screenHeight (was ${baseline.screenHeight})`,
    ).toBe(baseline.screenHeight)
    expect(afterZoom.windowWidth, 'zoom must NOT change windowWidth').toBe(baseline.windowWidth)
    expect(afterZoom.windowHeight, 'zoom must NOT change windowHeight').toBe(baseline.windowHeight)

    // Restore zoom for any later tests.
    await selectZoom(electronApp, 85).catch(() => {})
  })
})
