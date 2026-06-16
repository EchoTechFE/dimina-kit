/**
 * E2E (native-host only): device-dropdown selection and zoom must drive the
 * mini-app's reported viewport.
 *
 * Contract (the behaviour the user cares about — the mini-app's own
 * `wx.getSystemInfoSync()` sees the right screen/window size):
 *   1. Selecting a NON-default device makes the mini-app report THAT device's
 *      logical size (screenWidth ≈ W, screenHeight ≈ H), not a fixed default.
 *   2. Changing the device AFTER launch updates those dims live (no relaunch).
 *   3. Changing zoom changes the displayed scale but NOT the LOGICAL reported
 *      dims (getSystemInfo screen/window size is invariant across zoom levels).
 *
 * Observation channel — chosen (a): the SERVICE HOST `wx.getSystemInfoSync()`.
 * That is the authoritative `wx` the running mini-app actually calls (the
 * service bundle runs in the hidden `service.html` window; native-host.spec.ts
 * already confirms `globalThis.wx.getSystemInfoSync` is a function there). It
 * reads the spawn context's host-env snapshot, so it reflects exactly what the
 * mini-app's own code observes — strictly more behaviour-level than measuring a
 * DOM rect. As a secondary pin we ALSO read `window.innerWidth/innerHeight`
 * inside the active render-host guest (`pageFrame.html`, option b): the real
 * rendered viewport. Under correct device sizing BOTH equal the device's
 * logical size and BOTH stay fixed across zoom.
 *
 * Why it fails today: native-host renders at a hard-coded fixed size and the
 * device dropdown / zoom selection do not flow into the spawn host-env snapshot
 * (or the render-host webview size), so a non-default device yields a MISMATCH.
 *
 * NOTE: DIMINA_NATIVE_HOST is scoped to THIS spec's electron launch (below),
 * never `process.env` — a module-top mutation poisons the shared --workers=1
 * runner, flipping every other spec into native-host mode.
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import {
  openProjectInUI,
  waitForSimulatorWebview,
  closeProject,
  ipcInvoke,
  pollUntil,
  evalInSimulator,
} from './helpers'
import { AutomationChannel } from '../src/shared/ipc-channels'
import { DEVICES, ZOOM_OPTIONS } from '../src/renderer/shared/constants'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')

// The simulator boots on the FIRST preset (iPhone SE, 375×667). Pick presets
// that differ from it on BOTH axes AND from the service-host fallback default
// (390×844 — see sync-impls/system-info.ts) so a "stuck at a fixed size" bug
// can NEVER coincidentally satisfy these assertions.
const DEFAULT_DEVICE = DEVICES[0] // iPhone SE 375×667 (boot device)
const TARGET_DEVICE = DEVICES.find((d) => d.name === 'iPhone 14 Pro')! // 393×852
const LIVE_DEVICE = DEVICES.find((d) => d.name === 'iPhone 16 Pro')! // 402×874

// Sizes that must NOT be reported back if device selection truly wired through:
// the boot device and the system-info fallback default. Used to make the
// failure message explicit about *why* a stuck value is wrong.
const FALLBACK_DEFAULT = { width: 390, height: 844 }

// Tolerance: windowHeight is screenHeight minus system chrome (nav/status/tab),
// so we assert screenWidth/screenHeight EXACTLY (logical, chrome-independent)
// and assert windowWidth EXACTLY (width has no chrome). windowHeight we only
// bound to be <= screenHeight and clearly device-specific.
const EXACT = 0

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

/**
 * Secondary pin: the actual rendered viewport of the active render-host guest
 * (`pageFrame.html`). This is the page the mini-app paints into; its
 * innerWidth/innerHeight is what layout actually gets. Returns null if no
 * render guest is reachable (so the test can degrade to the service-host
 * assertion only rather than hard-error on a harness gap).
 */
async function readActiveGuestViewport(app: ElectronApplication): Promise<{ width: number; height: number } | null> {
  return app.evaluate(async ({ webContents }) => {
    const guests = webContents.getAllWebContents().filter(
      (wc) => !wc.isDestroyed() && wc.getURL().includes('pageFrame.html'),
    )
    if (guests.length === 0) return null
    // Prefer a guest that is actually laid out (innerWidth > 0).
    for (const g of guests) {
      try {
        const r = await g.executeJavaScript('({ width: window.innerWidth, height: window.innerHeight })')
        if (r && r.width > 0) return r as { width: number; height: number }
      } catch { /* try next */ }
    }
    return null
  }).catch(() => null)
}

/** Drive the real device dropdown in the renderer main window. */
async function selectDevice(win: PwPage, deviceName: string): Promise<void> {
  // The device <select> is the one whose options carry device names as values.
  const deviceSelect = win.locator('select', { has: win.locator(`option[value="${deviceName}"]`) }).first()
  await deviceSelect.selectOption(deviceName)
}

/** Drive the real zoom dropdown in the renderer main window. */
async function selectZoom(win: PwPage, zoom: number): Promise<void> {
  const zoomSelect = win.locator('select', { has: win.locator(`option[value="${zoom}"]`) }).first()
  await zoomSelect.selectOption(String(zoom))
}

test.describe('native-host device sizing e2e', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e'),
      'userdata',
      `nh-device-${process.pid}`,
    )
    fs.mkdirSync(userDataDir, { recursive: true })

    electronApp = await _electron.launch({
      args: [appPath, 'auto', '--auto-port', '0', `--user-data-dir=${userDataDir}`],
      env: { ...process.env, NODE_ENV: 'test', DIMINA_NATIVE_HOST: '1', DIMINA_E2E_USER_DATA_DIR: userDataDir },
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

    // Wait for the automation server (proves the app reached the workbench).
    await pollUntil(
      () => ipcInvoke<number | null>(mainWindow, AutomationChannel.GetPort),
      (val) => typeof val === 'number' && val > 0,
      10000,
      100,
    )

    await openProjectInUI(mainWindow, FIXTURE_DIR, { waitMs: 20000 })
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
    await closeProject(mainWindow).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('req1: selecting a non-default device makes the mini-app report THAT device size', async () => {
    // Sanity: the target preset differs from the boot default AND the fallback
    // default on BOTH axes, so a stuck value cannot accidentally match.
    expect(TARGET_DEVICE.width).not.toBe(DEFAULT_DEVICE.width)
    expect(TARGET_DEVICE.height).not.toBe(DEFAULT_DEVICE.height)
    expect(TARGET_DEVICE.width).not.toBe(FALLBACK_DEFAULT.width)
    expect(TARGET_DEVICE.height).not.toBe(FALLBACK_DEFAULT.height)

    await selectDevice(mainWindow, TARGET_DEVICE.name)

    // Allow the selection a generous window to flow to the spawn host-env
    // snapshot, then read whatever the service host ACTUALLY reports. We do NOT
    // poll-until-match here — that would hide a stuck value behind a timeout;
    // we want the assertion to print the real reported number on failure.
    await new Promise((r) => setTimeout(r, 4000))
    const info = await readServiceSystemInfo(electronApp)

    // Logical screen size must equal the selected device — chrome-independent.
    expect(
      info.screenWidth,
      `screenWidth should reflect ${TARGET_DEVICE.name} (=${TARGET_DEVICE.width}); `
      + `a stuck default (375 boot / 390 fallback) means device selection had no effect`,
    ).toBe(TARGET_DEVICE.width)
    expect(
      info.screenHeight,
      `screenHeight should reflect ${TARGET_DEVICE.name} (=${TARGET_DEVICE.height})`,
    ).toBe(TARGET_DEVICE.height)
    // windowWidth has no horizontal chrome, so it equals the logical width.
    expect(info.windowWidth, 'windowWidth should equal the device logical width').toBe(TARGET_DEVICE.width)
    // windowHeight = screenHeight minus system chrome — bound it sensibly.
    expect(info.windowHeight!, 'windowHeight should be <= device screenHeight').toBeLessThanOrEqual(TARGET_DEVICE.height + EXACT)
    expect(info.windowHeight!, 'windowHeight should be a meaningful fraction of the device height').toBeGreaterThan(TARGET_DEVICE.height * 0.6)

    // Secondary pin: the actual rendered viewport matches the device width too.
    const vp = await readActiveGuestViewport(electronApp)
    if (vp) {
      expect(
        vp.width,
        `active render guest innerWidth should equal the device logical width (${TARGET_DEVICE.width})`,
      ).toBe(TARGET_DEVICE.width)
    }
  })

  test('req2: changing the device after launch updates the reported dims live', async () => {
    expect(LIVE_DEVICE.width).not.toBe(TARGET_DEVICE.width)
    expect(LIVE_DEVICE.height).not.toBe(TARGET_DEVICE.height)

    await selectDevice(mainWindow, LIVE_DEVICE.name)

    // Capture the ACTUAL reported value after a live re-select (no relaunch).
    await new Promise((r) => setTimeout(r, 4000))
    const info = await readServiceSystemInfo(electronApp)
    expect(
      info.screenWidth,
      `live device change to ${LIVE_DEVICE.name} should update screenWidth to ${LIVE_DEVICE.width} without relaunch`,
    ).toBe(LIVE_DEVICE.width)
    expect(
      info.screenHeight,
      `live device change to ${LIVE_DEVICE.name} should update screenHeight to ${LIVE_DEVICE.height} without relaunch`,
    ).toBe(LIVE_DEVICE.height)
    expect(info.windowWidth, 'live device change should update windowWidth').toBe(LIVE_DEVICE.width)

    const vp = await readActiveGuestViewport(electronApp)
    if (vp) {
      expect(vp.width, `render guest innerWidth should follow the live device change (${LIVE_DEVICE.width})`).toBe(LIVE_DEVICE.width)
    }
  })

  test('req3: changing zoom does NOT change the logical reported dims', async () => {
    // GUARD test: zoom is a DISPLAY-only scale; it must never feed the logical
    // system-info. This is order-independent — it reads its OWN baseline
    // (whatever dims are currently reported) and asserts pure INVARIANCE across
    // a zoom change, so it neither depends on nor presumes the device-sizing
    // fix from req1/req2. It should pass today and keep passing after the fix.
    await selectDevice(mainWindow, LIVE_DEVICE.name)
    await selectZoom(mainWindow, 100)
    await new Promise((r) => setTimeout(r, 2000))
    const baseline = await readServiceSystemInfo(electronApp)
    expect(typeof baseline.screenWidth, 'baseline screenWidth should be readable').toBe('number')
    expect(typeof baseline.screenHeight, 'baseline screenHeight should be readable').toBe('number')

    // Pick a zoom DIFFERENT from 100%.
    const newZoom = ZOOM_OPTIONS.find((z) => z !== 100)! // e.g. 85
    await selectZoom(mainWindow, newZoom)
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

    const vp = await readActiveGuestViewport(electronApp)
    if (vp && typeof baseline.screenWidth === 'number') {
      // The render guest LOGICAL innerWidth must also be ~zoom-invariant, BUT it
      // cannot be asserted EXACTLY here the way the authoritative service-host
      // dims above are. The render guest is a native Electron <webview> whose
      // bounds are INTEGER device pixels and whose display zoom is applied via
      // webContents.setZoomFactor(scale). Under a FRACTIONAL zoom `scale`,
      //   innerWidth (CSS px) = round(deviceWidth * scale) / scale
      // so its error vs deviceWidth is bounded by ~0.5/scale px and EXACT
      // equality is generally unachievable. At a fractional zoom, the nearest
      // integer backing bounds can land slightly off the logical device width
      // after dividing by scale. So we bound the render-guest viewport to
      // ⌈1/scale⌉+1 px of the device width (tight: a genuinely broken zoom where
      // setZoomFactor was NOT applied would give innerWidth = deviceWidth*scale
      // ≈ 100 or = deviceWidth/scale ≈ 1600, both far outside this band and so
      // still FAIL). The authoritative service-host LOGICAL dims above remain
      // asserted EXACTLY and ARE truly zoom-invariant — that is the contract the
      // mini-app's own wx.getSystemInfoSync() relies on.
      const scale = newZoom / 100
      const pxTolerance = Math.ceil(1 / scale) + 1
      expect(
        Math.abs(vp.width - baseline.screenWidth),
        `zoom must NOT change the render guest LOGICAL innerWidth beyond display rounding `
        + `(was ${baseline.screenWidth}, got ${vp.width}, tolerance ${pxTolerance}px at ${newZoom}% zoom)`,
      ).toBeLessThanOrEqual(pxTolerance)
    }

    // Restore zoom for any later tests.
    await selectZoom(mainWindow, 85).catch(() => {})
  })
})
