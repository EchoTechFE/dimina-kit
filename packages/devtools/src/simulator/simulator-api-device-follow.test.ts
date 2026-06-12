/**
 * TDD RED-phase contract tests for Bug A: forwarded async wx.getSystemInfo /
 * wx.getWindowInfo report a hardcoded 375x812 instead of the selected device.
 *
 * The REAL bug each test catches
 * ──────────────────────────────
 * The authoritative device info rides the hostEnvSnapshot (sync
 * wx.getSystemInfoSync in the service host is correct: bridge-router layers
 * the live `currentDevice` on spawn, and SetDeviceInfo pushes HostEnvUpdate).
 * But an ASYNC wx.getSystemInfo is forwarded by the bridge-router
 * (`forwardApiCallToSimulator`) into the simulator window, where the handler
 * in simulator-api.ts resolves metrics via `readWindowMetrics`:
 *   - `window.__deviceInfo` → never written in production → always `{}`
 *   - `miniApp.parent?.el` rect → SimulatorMiniApp has no `parent` field
 *   - final fallback → hardcoded `{ width: 375, height: 812 }`
 * So the async path answers 375x812 / statusBarHeight 0 forever, regardless of
 * which device is selected, and never follows a DEVICE_CHANGE.
 *
 * Contract locked here (implementation strategy is left open):
 * after `spawn()`, the simulator-resident API surface — invoked through
 * `runApiAsync`, the exact seam the production API_CALL listener uses
 * (device-shell.tsx) — must report metrics that reflect the CURRENT device:
 *   ① no device selected → the boot host-env snapshot values (390x844 / 44),
 *     never the 375x812 hardcode;
 *   ② a device delivered at boot (native-host bridge `device`) is reflected;
 *   ③ after a SIMULATOR_EVENTS.DEVICE_CHANGE (the only observable carrier of
 *     "device changed" inside the simulator window — main pushes it via
 *     `bridge.setDevice` → `wc.send(E.DEVICE_CHANGE)` → preload
 *     `onSimulatorEvent`), subsequent calls follow the NEW device;
 *   ④ statusBarHeight / safeArea follow the device too.
 *
 * The subscription is pinned at the SimulatorMiniApp level (not DeviceShell):
 * the listener registered through the mocked native-host bridge is the only
 * thing fired here, so the implementation must track DEVICE_CHANGE from the
 * miniApp/spawn seam (e.g. keep a `currentDevice` field, or maintain
 * `window.__deviceInfo` + fix the 375x812 rect fallback to the device dims).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { SIMULATOR_EVENTS } from '../shared/bridge-channels'
import type { NativeDeviceInfo } from '../shared/ipc-channels'
import { SimulatorMiniApp } from './simulator-mini-app'
import { simulatorApis } from './simulator-api'
import { runApiAsync, type ApiRunVerdict } from './run-api-async'

// ─── device fixtures ──────────────────────────────────────────────────────────

const IPHONE_14: NativeDeviceInfo = {
  brand: 'Apple',
  model: 'iPhone 14',
  system: 'iOS 16.0',
  platform: 'ios',
  pixelRatio: 3,
  screenWidth: 390,
  screenHeight: 844,
  statusBarHeight: 47,
  safeAreaBottom: 34,
  notchType: 'notch',
  safeAreaInsets: { top: 47, right: 0, bottom: 34, left: 0 },
}

const PIXEL_7: NativeDeviceInfo = {
  brand: 'Google',
  model: 'Pixel 7',
  system: 'Android 13',
  platform: 'android',
  pixelRatio: 2.625,
  screenWidth: 412,
  screenHeight: 915,
  statusBarHeight: 24,
  safeAreaBottom: 0,
  notchType: 'none',
  safeAreaInsets: { top: 24, right: 0, bottom: 0, left: 0 },
}

const IPHONE_15_PRO: NativeDeviceInfo = {
  brand: 'Apple',
  model: 'iPhone 15 Pro',
  system: 'iOS 17.0',
  platform: 'ios',
  pixelRatio: 3,
  screenWidth: 393,
  screenHeight: 852,
  statusBarHeight: 59,
  safeAreaBottom: 34,
  notchType: 'dynamic-island',
  safeAreaInsets: { top: 59, right: 0, bottom: 34, left: 0 },
}

// ─── native-host bridge mock ─────────────────────────────────────────────────
//
// Mirrors the production preload bridge shape (window.__diminaNativeHost, see
// simulator-mini-app.ts NativeHostBridge). `onSimulatorEvent` records listeners
// per channel so the test can fire DEVICE_CHANGE exactly the way main does.

type SimEventListener = (payload: unknown) => void

function installNativeHostMock(device?: NativeDeviceInfo) {
  const listeners = new Map<string, Set<SimEventListener>>()

  const host = {
    enabled: true,
    device,
    spawn: async () => ({
      appSessionId: 'app-session-1',
      bridgeId: 'bridge-1',
      resourceBaseUrl: 'http://localhost:7788/',
      serviceWcId: 1,
      manifest: { pages: ['pages/index/index'], entryPagePath: 'pages/index/index' },
      rootWindowConfig: {},
    }),
    dispose: () => {},
    openPage: async () => ({ bridgeId: 'bridge-2', windowConfig: {} }),
    closePage: () => {},
    notifyLifecycle: () => {},
    notifyNavCallback: () => {},
    notifyApiResponse: () => {},
    notifyActivePage: () => {},
    notifyPageStack: () => {},
    createRenderHostUrl: () => 'about:blank',
    renderPreloadUrl: 'about:blank',
    onSimulatorEvent: (channel: string, listener: SimEventListener) => {
      let set = listeners.get(channel)
      if (!set) {
        set = new Set()
        listeners.set(channel, set)
      }
      set.add(listener)
      return () => { set!.delete(listener) }
    },
  }

  window.__diminaNativeHost = host as unknown as Window['__diminaNativeHost']

  return {
    /** Fire DEVICE_CHANGE the way main's bridge.setDevice does. */
    emitDeviceChange(next: NativeDeviceInfo): void {
      const set = listeners.get(SIMULATOR_EVENTS.DEVICE_CHANGE)
      for (const fn of set ?? []) fn(next)
    },
    /**
     * Update the boot-config device on the bridge the way a new session boot
     * does (the renderer pushes SetDeviceInfo before AttachNative — see
     * SimulatorMiniApp.getInitialDevice), WITHOUT firing DEVICE_CHANGE.
     */
    setBootDevice(next: NativeDeviceInfo): void {
      host.device = next
    },
  }
}

afterEach(() => {
  delete (window as { __diminaNativeHost?: unknown }).__diminaNativeHost
  delete (window as { __deviceInfo?: unknown }).__deviceInfo
})

// ─── boot + invoke helpers (the production seams) ────────────────────────────

/** Same registration main.tsx (registerBuiltinApis) performs at boot. */
async function bootMiniApp(): Promise<SimulatorMiniApp> {
  const miniApp = new SimulatorMiniApp({
    appId: 'test-app',
    scene: 1001,
    pagePath: 'pages/index/index',
  })
  for (const [name, handler] of Object.entries(
    simulatorApis as Record<string, (...args: unknown[]) => unknown>,
  )) {
    miniApp.registerApi(name, handler)
  }
  await miniApp.spawn()
  return miniApp
}

interface SafeArea {
  width: number
  height: number
  top: number
  bottom: number
  left: number
  right: number
}

interface MetricsResult {
  pixelRatio: number
  screenWidth: number
  screenHeight: number
  windowWidth: number
  windowHeight: number
  statusBarHeight: number
  safeArea: SafeArea
}

/**
 * Invoke a forwarded wx.* API exactly the way the production API_CALL listener
 * does (device-shell.tsx → runApiAsync) and return the success result.
 */
async function callForwardedApi(miniApp: SimulatorMiniApp, name: string): Promise<MetricsResult> {
  let verdict: ApiRunVerdict | null = null
  await runApiAsync(miniApp, name, {}, (v) => { verdict = v })
  expect(verdict, `${name} should produce a verdict`).not.toBeNull()
  expect((verdict as unknown as ApiRunVerdict).ok, `${name} should succeed`).toBe(true)
  return (verdict as unknown as ApiRunVerdict).result as MetricsResult
}

// ─── ① default (no device selected) ──────────────────────────────────────────

describe('async getSystemInfo — no device selected (pre-selection default)', () => {
  it('reports the boot host-env defaults (390x844 / statusBar 44), not the 375x812 hardcode', async () => {
    // BUG CAUGHT: with no device, readWindowMetrics falls through
    // __deviceInfo={} → no parent.el → hardcoded {375, 812}, statusBarHeight 0.
    // The authoritative source for the no-device boot is getHostEnvSnapshot()
    // (iPhone-14-class defaults), which the sync service-host path already
    // reports — the async path must agree with it instead of inventing 375x812.
    installNativeHostMock(undefined)
    const miniApp = await bootMiniApp()
    const snap = miniApp.getHostEnvSnapshot()

    const info = await callForwardedApi(miniApp, 'getSystemInfo')

    expect(info.screenWidth, 'screenWidth must come from the host-env, not 375').toBe(snap.screenWidth)
    expect(info.screenHeight, 'screenHeight must come from the host-env, not 812').toBe(snap.screenHeight)
    expect(info.windowWidth, 'windowWidth must follow the emulated device width').toBe(snap.screenWidth)
    expect(info.statusBarHeight, 'statusBarHeight must come from the host-env (44 for ios), not 0').toBe(snap.statusBarHeight)
    // windowHeight: exact chrome accounting (full screen vs screen-minus-status-bar)
    // is implementation freedom — but it must derive from the device height,
    // never from the 812 hardcode.
    expect(
      [snap.screenHeight, snap.screenHeight - snap.statusBarHeight],
      'windowHeight must derive from the device height (812 hardcode is the bug)',
    ).toContain(info.windowHeight)
  })
})

// ─── ② device delivered at boot ───────────────────────────────────────────────

describe('async getSystemInfo — device selected at boot (bridge config device)', () => {
  it('reflects the boot device dims instead of 375x812', async () => {
    // BUG CAUGHT: even with a selected device riding the native-host bridge
    // config (miniApp.getInitialDevice()), the async handler still answers the
    // 375x812 hardcode because nothing routes the device into readWindowMetrics.
    installNativeHostMock(IPHONE_14)
    const miniApp = await bootMiniApp()

    const info = await callForwardedApi(miniApp, 'getSystemInfo')

    expect(info.screenWidth).toBe(IPHONE_14.screenWidth)   // 390, today 375
    expect(info.screenHeight).toBe(IPHONE_14.screenHeight) // 844, today 812
    expect(info.windowWidth).toBe(IPHONE_14.screenWidth)
    expect(info.pixelRatio).toBe(IPHONE_14.pixelRatio)
    expect(info.statusBarHeight).toBe(IPHONE_14.statusBarHeight) // 47, today 0
  })
})

// ─── ③ DEVICE_CHANGE follow ───────────────────────────────────────────────────

describe('async getSystemInfo — follows DEVICE_CHANGE', () => {
  it('subsequent calls report the NEW device after a DEVICE_CHANGE', async () => {
    // BUG CAUGHT: the metrics are constant. After the toolbar switches the
    // device (main → DEVICE_CHANGE simulator event), the sync service-host path
    // updates (HostEnvUpdate) but the async simulator path keeps answering the
    // same hardcoded values forever.
    const { emitDeviceChange } = installNativeHostMock(IPHONE_14)
    const miniApp = await bootMiniApp()

    emitDeviceChange(PIXEL_7)
    const after = await callForwardedApi(miniApp, 'getSystemInfo')

    expect(after.screenWidth, 'screenWidth must follow the new device').toBe(PIXEL_7.screenWidth)   // 412
    expect(after.screenHeight, 'screenHeight must follow the new device').toBe(PIXEL_7.screenHeight) // 915
    expect(after.windowWidth).toBe(PIXEL_7.screenWidth)
    expect(after.pixelRatio).toBe(PIXEL_7.pixelRatio)
    expect(
      [PIXEL_7.screenHeight, PIXEL_7.screenHeight - PIXEL_7.statusBarHeight],
      'windowHeight must scale with the new device',
    ).toContain(after.windowHeight)
  })

  it('statusBarHeight and safeArea follow the new device (wx screen-coordinate semantics)', async () => {
    // BUG CAUGHT: statusBarHeight stays 0 and safeArea is computed off the
    // 375x812 rect, so the safe area never matches the selected bezel
    // (notch/dynamic-island devices report a plainly wrong inset).
    const { emitDeviceChange } = installNativeHostMock(PIXEL_7)
    const miniApp = await bootMiniApp()

    emitDeviceChange(IPHONE_15_PRO)
    const info = await callForwardedApi(miniApp, 'getSystemInfo')

    const d = IPHONE_15_PRO
    expect(info.statusBarHeight).toBe(d.statusBarHeight) // 59, today 0
    expect(info.safeArea.top).toBe(d.statusBarHeight)
    expect(info.safeArea.width).toBe(d.screenWidth)
    expect(info.safeArea.bottom).toBe(d.screenHeight - d.safeAreaBottom) // 818
    expect(info.safeArea.height).toBe(d.screenHeight - d.safeAreaBottom - d.statusBarHeight) // 759
  })
})

// ─── getWindowInfo: same family, same bug ─────────────────────────────────────

describe('async getWindowInfo — follows DEVICE_CHANGE', () => {
  it('reports the new device dims after a DEVICE_CHANGE, not 375x812', async () => {
    // BUG CAUGHT: getWindowInfo shares readWindowMetrics with getSystemInfo,
    // so the forwarded async wx.getWindowInfo is pinned to 375x812 too.
    const { emitDeviceChange } = installNativeHostMock(IPHONE_14)
    const miniApp = await bootMiniApp()

    emitDeviceChange(PIXEL_7)
    const info = await callForwardedApi(miniApp, 'getWindowInfo')

    expect(info.screenWidth).toBe(PIXEL_7.screenWidth)   // 412
    expect(info.screenHeight).toBe(PIXEL_7.screenHeight) // 915
    expect(info.windowWidth).toBe(PIXEL_7.screenWidth)
    expect(info.statusBarHeight).toBe(PIXEL_7.statusBarHeight) // 24
    expect(info.safeArea.top).toBe(PIXEL_7.statusBarHeight)
    // getWindowInfo's safeArea.bottom semantics historically diverge from
    // getSystemInfo's (see the characterization tests in simulator-api.test.ts);
    // only the device-following part is locked here.
  })
})

// ─── ROUND 2 — currentDevice must not stick across dispose() → spawn() ───────
//
// Regression test for the review finding: dispose() tears down the
// DEVICE_CHANGE subscription but leaves `currentDevice` populated. When the
// SAME SimulatorMiniApp instance is later spawned into a NEW session whose
// boot config carries a different device (the renderer pushes SetDeviceInfo
// before AttachNative on every boot, so the bridge `device` IS the latest
// authoritative selection), getDeviceMetrics() prefers the stale live value
// from the PREVIOUS session over getInitialDevice() — the new session renders
// and reports the wrong device until the user manually switches once.
//
// NOTE: the implementation comment on `currentDevice` (simulator-mini-app.ts)
// claims surviving dispose() is intentional ("a respawn must not forget" the
// selection). No test pins that behavior, and it conflicts with the boot
// config being re-delivered per session — this test locks the boot config as
// the source of truth for a fresh spawn.
describe('ROUND 2 — device metrics across dispose() → respawn', () => {
  it('after dispose + respawn with a new boot device (no DEVICE_CHANGE), metrics follow the NEW boot config, not the stale live device', async () => {
    const { emitDeviceChange, setBootDevice } = installNativeHostMock(IPHONE_14)
    const miniApp = await bootMiniApp()

    // Session #1: live toolbar switch — the live device wins, as designed.
    emitDeviceChange(PIXEL_7)
    expect(miniApp.getDeviceMetrics().screenWidth).toBe(PIXEL_7.screenWidth) // 412 — sanity

    // Session #1 ends; session #2 boots with a different selected device.
    miniApp.dispose()
    setBootDevice(IPHONE_15_PRO)
    await miniApp.spawn() // no DEVICE_CHANGE arrives this session

    // BUG CAUGHT: the stale `currentDevice` (PIXEL_7, dead session #1) shadows
    // the fresh boot config (IPHONE_15_PRO) delivered for session #2.
    const metrics = miniApp.getDeviceMetrics()
    expect(metrics.screenWidth, 'must be the new boot device width, not the stale 412').toBe(IPHONE_15_PRO.screenWidth)   // 393
    expect(metrics.screenHeight).toBe(IPHONE_15_PRO.screenHeight) // 852
    expect(metrics.pixelRatio).toBe(IPHONE_15_PRO.pixelRatio)
    expect(metrics.statusBarHeight, 'status bar must follow the new boot device').toBe(IPHONE_15_PRO.statusBarHeight) // 59
    expect(metrics.safeAreaBottom).toBe(IPHONE_15_PRO.safeAreaBottom)

    // And through the production forwarded-API seam (runApiAsync) too.
    const info = await callForwardedApi(miniApp, 'getSystemInfo')
    expect(info.screenWidth).toBe(IPHONE_15_PRO.screenWidth)
    expect(info.statusBarHeight).toBe(IPHONE_15_PRO.statusBarHeight)
  })
})
