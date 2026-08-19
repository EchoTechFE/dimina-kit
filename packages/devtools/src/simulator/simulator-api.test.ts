/**
 * Characterization tests for getWindowInfo and getSystemInfoSync.
 *
 * Purpose: pin the CURRENT complete output of both functions so that the P7
 * refactor (extracting shared wb/di helpers) cannot silently change behavior.
 * These tests are GREEN now and must remain GREEN after refactoring.
 *
 * Key semantic divergence that is intentionally NOT fixed here:
 *   - When __deviceInfo is absent/empty:
 *       getWindowInfo.statusBarHeight  → falls back to parent.getStatusBarRect().height
 *       getSystemInfoSync.statusBarHeight → falls back to 0
 *   - safeArea.height and safeArea.bottom differ accordingly.
 * The tests pin these divergent values as-is (characterization, not bug fix).
 *
 * `__deviceInfo` / `getDeviceMetrics()` state the PORTRAIT baseline; the reported screen geometry is that baseline resolved for the orientation the page is showing, which the mocked `.dimina-native-webview__root` rect (`WB`) states — see `resolveScreenGeometry` in simulator-api.ts.
 * Scenes A and B are both portrait, so the baseline passes through; the landscape suites below pin the re-orientation.
 */

import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import type { DeviceMetrics, MiniAppContext } from './types'
import { getSystemSetting, getWindowInfo, getSystemInfoSync } from './simulator-api'

// ─── shared mock helpers ──────────────────────────────────────────────────────

/** A bounding box returned by the .dimina-native-webview__root element. */
const WB = { width: 300, height: 600 }

/** Height returned by parent.getStatusBarRect() when __deviceInfo is absent. */
const FALLBACK_STATUS_BAR_HEIGHT = 20

function makeMockThis(): MiniAppContext {
  return {
    appId: 'test-app',
    createCallbackFunction: (fn: unknown) => (fn ? (fn as (...a: unknown[]) => void) : undefined),
    parent: {
      el: {
        querySelector: (_sel: string) => ({
          getBoundingClientRect: () => ({ ...WB }),
        }),
      } as unknown as Element,
      getStatusBarRect: () => ({ height: FALLBACK_STATUS_BAR_HEIGHT }),
    },
  } as unknown as MiniAppContext
}

// ─── Scene A: __deviceInfo fully populated ────────────────────────────────────

const DEVICE_INFO_A = {
  statusBarHeight: 44,
  safeAreaInsets: { top: 44, right: 0, bottom: 34, left: 0 },
  pixelRatio: 3,
  screenWidth: 390,
  screenHeight: 844,
  brand: 'Apple',
  model: 'iPhone 14',
  system: 'iOS 16.0',
  platform: 'ios',
}

// ─── Scene B: __deviceInfo is an empty object ─────────────────────────────────
//
// jsdom sets window.devicePixelRatio = 1; the functions do `|| 2` only when the
// value is falsy, so pixelRatio = 1 in this environment.

describe('getWindowInfo', () => {
  let mockThis: MiniAppContext

  beforeEach(() => {
    mockThis = makeMockThis()
  })

  afterEach(() => {
    // clean up the global stub
    delete (window as Window & { __deviceInfo?: unknown }).__deviceInfo
  })

  describe('Scene A – __deviceInfo fully populated', () => {
    it('returns complete info object using __deviceInfo values', () => {
      ;(window as Window & { __deviceInfo?: unknown }).__deviceInfo = DEVICE_INFO_A

      const result = getWindowInfo.call(mockThis)

      expect(result).toEqual({
        pixelRatio: 3,
        screenWidth: 390,
        screenHeight: 844,
        windowWidth: 300,
        windowHeight: 600,
        statusBarHeight: 44,
        // Portrait-baseline device dims + insets (__deviceInfo.screenWidth/ screenHeight/safeAreaInsets), NOT the mocked viewport rect (WB).
        safeArea: {
          width: 390,
          height: 766, // 844 - 44 - 34
          top: 44,
          bottom: 810, // 844 - 34
          left: 0,
          right: 390,
        },
      })
    })
  })

  describe('Scene B – __deviceInfo absent/empty', () => {
    it('falls back: statusBarHeight from parent.getStatusBarRect().height', () => {
      ;(window as Window & { __deviceInfo?: unknown }).__deviceInfo = {}

      const result = getWindowInfo.call(mockThis)

      expect(result).toEqual({
        pixelRatio: 1,           // window.devicePixelRatio in jsdom
        screenWidth: 300,         // falls back to wb.width
        screenHeight: 600,        // falls back to wb.height
        windowWidth: 300,
        windowHeight: 600,
        statusBarHeight: 20,      // from parent.getStatusBarRect().height
        safeArea: {
          width: 300,
          height: 580,            // 600 - 20
          top: 20,
          bottom: 600,
          left: 0,
          right: 300,
        },
      })
    })
  })
})

// ─── Landscape: the page is showing the long edge ─────────────────────────────
//
// The device stays a portrait-baseline iPhone; only the viewport says the page turned.
// Both this path and the native-host one (shared/page-resize-host-env.ts) must answer with the same coordinate system — the notch moves from the top edge to both sides, the top frees up, and the home indicator thins to 21.

const NOTCHED_DEVICE: DeviceMetrics = {
  pixelRatio: 3,
  screenWidth: 390,
  screenHeight: 844,
  statusBarHeight: 44,
  safeAreaInsets: { top: 44, right: 0, bottom: 34, left: 0 },
  hasNotch: true,
  deviceOrientation: 'portrait',
}

/** A context whose viewport rect and device metrics are both explicit. */
function makeDeviceMockThis(
  viewport: { width: number; height: number },
  device: DeviceMetrics,
): MiniAppContext {
  return {
    appId: 'test-app',
    createCallbackFunction: (fn: unknown) => (fn ? (fn as (...a: unknown[]) => void) : undefined),
    parent: {
      el: {
        querySelector: (_sel: string) => ({ getBoundingClientRect: () => ({ ...viewport }) }),
      } as unknown as Element,
      getStatusBarRect: () => ({ height: device.statusBarHeight }),
    },
    getDeviceMetrics: () => device,
  } as unknown as MiniAppContext
}

describe('screen geometry follows the orientation the page is showing', () => {
  afterEach(() => {
    delete (window as Window & { __deviceInfo?: unknown }).__deviceInfo
  })

  it('rotates the device baseline and rebuilds safeArea for a landscape viewport', () => {
    const result = getSystemInfoSync.call(makeDeviceMockThis({ width: 844, height: 390 }, NOTCHED_DEVICE))

    expect(result).toMatchObject({
      screenWidth: 844,
      screenHeight: 390,
      statusBarHeight: 0,
      deviceOrientation: 'landscape',
      safeArea: {
        top: 0,
        left: 44,          // the notch's own depth, now on the side edges
        right: 800,        // 844 - 44
        bottom: 369,       // 390 - 21 home indicator
        width: 756,        // 844 - 44 - 44
        height: 369,
      },
    })
  })

  it('reports the same landscape rect through getWindowInfo', () => {
    const result = getWindowInfo.call(makeDeviceMockThis({ width: 844, height: 390 }, NOTCHED_DEVICE))

    expect(result).toMatchObject({
      screenWidth: 844,
      screenHeight: 390,
      statusBarHeight: 0,
      safeArea: { top: 0, left: 44, right: 800, bottom: 369, width: 756, height: 369 },
    })
  })

  it('keeps a page pinned to portrait in portrait while the simulated device is rotated', () => {
    // DeviceShell sizes the shell from the top page's EFFECTIVE orientation, so a portrait-pinned page keeps a portrait viewport on a rotated device.
    // Reading the toolbar's device rotation instead would report landscape geometry for a page that never turned.
    const rotatedDevice: DeviceMetrics = { ...NOTCHED_DEVICE, deviceOrientation: 'landscape' }
    const context = makeDeviceMockThis({ width: 390, height: 844 }, rotatedDevice)

    expect(getSystemInfoSync.call(context)).toMatchObject({
      screenWidth: 390,
      screenHeight: 844,
      statusBarHeight: 44,
      deviceOrientation: 'portrait',
      safeArea: { top: 44, left: 0, right: 390, bottom: 810, width: 390, height: 766 },
    })
    expect(getSystemSetting.call(context)).toMatchObject({ deviceOrientation: 'portrait' })
  })

  it('leaves a notch-less device with no side insets in landscape', () => {
    const flatDevice: DeviceMetrics = {
      ...NOTCHED_DEVICE,
      hasNotch: false,
      statusBarHeight: 24,
      safeAreaInsets: { top: 24, right: 0, bottom: 0, left: 0 },
    }

    expect(getSystemInfoSync.call(makeDeviceMockThis({ width: 844, height: 390 }, flatDevice))).toMatchObject({
      safeArea: { top: 0, left: 0, right: 844, bottom: 390, width: 844, height: 390 },
    })
  })
})

describe('getSystemInfoSync', () => {
  let mockThis: MiniAppContext

  beforeEach(() => {
    mockThis = makeMockThis()
  })

  afterEach(() => {
    delete (window as Window & { __deviceInfo?: unknown }).__deviceInfo
  })

  describe('Scene A – __deviceInfo fully populated', () => {
    it('returns complete system info using __deviceInfo values', () => {
      ;(window as Window & { __deviceInfo?: unknown }).__deviceInfo = DEVICE_INFO_A

      const result = getSystemInfoSync.call(mockThis)

      expect(result).toEqual({
        brand: 'Apple',
        model: 'iPhone 14',
        pixelRatio: 3,
        screenWidth: 390,
        screenHeight: 844,
        windowWidth: 300,
        windowHeight: 600,
        statusBarHeight: 44,
        language: 'zh_CN',
        version: '8.0.5',
        system: 'iOS 16.0',
        platform: 'ios',
        fontSizeSetting: 16,
        SDKVersion: '3.0.0',
        deviceOrientation: 'portrait',
        // Portrait-baseline device dims + insets, NOT the mocked viewport rect.
        safeArea: {
          width: 390,
          height: 766,             // 844 - 44 - 34
          top: 44,
          bottom: 810,             // 844 - 34
          left: 0,
          right: 390,
        },
      })
    })
  })

  describe('Scene B – __deviceInfo absent/empty', () => {
    it('falls back: statusBarHeight=0 (NOT from parent.getStatusBarRect)', () => {
      ;(window as Window & { __deviceInfo?: unknown }).__deviceInfo = {}

      const result = getSystemInfoSync.call(mockThis)

      // Key divergence: statusBarHeight=0 (hardcoded fallback), NOT 20
      expect(result).toEqual({
        brand: 'devtools',
        model: 'devtools',
        pixelRatio: 1,           // window.devicePixelRatio in jsdom
        screenWidth: 300,
        screenHeight: 600,
        windowWidth: 300,
        windowHeight: 600,
        statusBarHeight: 0,      // diverges from getWindowInfo's fallback of 20
        language: 'zh_CN',
        version: '8.0.5',
        system: 'iOS 16.0',
        platform: 'ios',
        fontSizeSetting: 16,
        SDKVersion: '3.0.0',
        deviceOrientation: 'portrait',
        safeArea: {
          width: 300,
          height: 600,           // 600 - 0 - 0
          top: 0,
          bottom: 600,           // 600 - 0
          left: 0,
          right: 300,
        },
      })
    })
  })
})
