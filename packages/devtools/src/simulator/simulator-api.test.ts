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
 */

import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import type { MiniAppContext } from './types'
import { getWindowInfo, getSystemInfoSync } from './simulator-api'

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
        safeArea: {
          width: 300,
          height: 556, // 600 - 44
          top: 44,
          bottom: 600,
          left: 0,
          right: 300,
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
        safeArea: {
          width: 300,
          height: 522,            // 600 - 44 - 34
          top: 44,
          bottom: 566,            // 600 - 34
          left: 0,
          right: 300,
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
