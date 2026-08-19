import { describe, expect, it } from 'vitest'
import {
  computedOrientationConfig,
  canUserRotate,
  EMPTY_RESIZE_BASELINE,
  effectiveOrientation,
  isPageOrientationConfig,
  normalizeDeviceOrientation,
  orientedDeviceMetrics,
  orientedSafeAreaInsets,
  resolvePageOrientationState,
  shouldDispatchResize,
  type PageOrientationState,
} from './page-orientation.js'

// Baseline phone device metrics (portrait reference), reused across geometry tests.
const device = { screenWidth: 375, screenHeight: 667, statusBarHeight: 20 }

describe('isPageOrientationConfig', () => {
  it('accepts the three documented values', () => {
    expect(isPageOrientationConfig('portrait')).toBe(true)
    expect(isPageOrientationConfig('auto')).toBe(true)
    expect(isPageOrientationConfig('landscape')).toBe(true)
  })

  it('rejects values outside the enum, matching the WeChat devtools validator', () => {
    expect(isPageOrientationConfig('Portrait')).toBe(false)
    expect(isPageOrientationConfig('LANDSCAPE')).toBe(false)
    expect(isPageOrientationConfig('')).toBe(false)
    expect(isPageOrientationConfig('vertical')).toBe(false)
    expect(isPageOrientationConfig(undefined)).toBe(false)
    expect(isPageOrientationConfig(null)).toBe(false)
    expect(isPageOrientationConfig(0)).toBe(false)
    expect(isPageOrientationConfig({})).toBe(false)
  })
})

describe('resolvePageOrientationState', () => {
  it('treats an unknown pageOrientation value as portrait', () => {
    expect(resolvePageOrientationState('sideways')).toEqual({
      originalPageOrientation: 'portrait',
    })
  })

  it('treats a missing pageOrientation value as portrait', () => {
    expect(resolvePageOrientationState(undefined)).toEqual({
      originalPageOrientation: 'portrait',
    })
  })

  it('treats null as portrait', () => {
    expect(resolvePageOrientationState(null)).toEqual({
      originalPageOrientation: 'portrait',
    })
  })

  it('is case-sensitive: a differently-cased value is still dirty and falls back to portrait', () => {
    expect(resolvePageOrientationState('Auto')).toEqual({
      originalPageOrientation: 'portrait',
    })
  })

  it('resolves "auto" from the config', () => {
    expect(resolvePageOrientationState('auto')).toEqual({
      originalPageOrientation: 'auto',
    })
  })

  it('resolves a fixed "landscape" config', () => {
    expect(resolvePageOrientationState('landscape')).toEqual({
      originalPageOrientation: 'landscape',
    })
  })

  it('resolves a fixed "portrait" config', () => {
    expect(resolvePageOrientationState('portrait')).toEqual({
      originalPageOrientation: 'portrait',
    })
  })
})

describe('computedOrientationConfig', () => {
  it('returns the resolved originalPageOrientation', () => {
    const state: PageOrientationState = {
      originalPageOrientation: 'landscape',
    }
    expect(computedOrientationConfig(state)).toBe('landscape')
  })
})

describe('effectiveOrientation', () => {
  it('resolves to the device orientation when computed config is "auto"', () => {
    const state: PageOrientationState = { originalPageOrientation: 'auto' }
    expect(effectiveOrientation(state, 'landscape')).toBe('landscape')
    expect(effectiveOrientation(state, 'portrait')).toBe('portrait')
  })

  it('resolves to the fixed computed config, ignoring the device orientation', () => {
    const state: PageOrientationState = { originalPageOrientation: 'landscape' }
    expect(effectiveOrientation(state, 'portrait')).toBe('landscape')
  })
})

describe('canUserRotate', () => {
  it('allows manual rotation when the computed config is "auto"', () => {
    const state: PageOrientationState = { originalPageOrientation: 'auto' }
    expect(canUserRotate(state)).toBe(true)
  })

  it('disables manual rotation for a fixed "landscape" page', () => {
    const state: PageOrientationState = { originalPageOrientation: 'landscape' }
    expect(canUserRotate(state)).toBe(false)
  })

  it('disables manual rotation for a fixed "portrait" page', () => {
    const state: PageOrientationState = { originalPageOrientation: 'portrait' }
    expect(canUserRotate(state)).toBe(false)
  })
})

describe('orientedDeviceMetrics', () => {
  it('returns the device metrics unchanged in portrait', () => {
    expect(orientedDeviceMetrics(device, 'portrait')).toEqual({
      screenWidth: 375,
      screenHeight: 667,
      statusBarHeight: 20,
    })
  })

  it('swaps width and height in landscape', () => {
    const result = orientedDeviceMetrics(device, 'landscape')
    expect(result.screenWidth).toBe(667)
    expect(result.screenHeight).toBe(375)
  })

  it('zeroes the status bar height in landscape, matching phone devtools semantics', () => {
    const result = orientedDeviceMetrics(device, 'landscape')
    expect(result.statusBarHeight).toBe(0)
  })

  it('keeps the original status bar height in portrait even when it is 0', () => {
    const notch = { screenWidth: 390, screenHeight: 844, statusBarHeight: 0 }
    expect(orientedDeviceMetrics(notch, 'portrait').statusBarHeight).toBe(0)
  })
})

describe('normalizeDeviceOrientation', () => {
  it('uses the supplied orientation when it is a valid value', () => {
    expect(normalizeDeviceOrientation({ windowWidth: 375, windowHeight: 667 }, 'landscape')).toBe('landscape')
    expect(normalizeDeviceOrientation({ windowWidth: 667, windowHeight: 375 }, 'portrait')).toBe('portrait')
  })

  it('falls back to width/height comparison when the orientation is missing', () => {
    expect(normalizeDeviceOrientation({ windowWidth: 667, windowHeight: 375 })).toBe('landscape')
    expect(normalizeDeviceOrientation({ windowWidth: 375, windowHeight: 667 })).toBe('portrait')
  })

  it('falls back to width/height comparison when the orientation value is invalid', () => {
    expect(normalizeDeviceOrientation({ windowWidth: 667, windowHeight: 375 }, 'undefined')).toBe('landscape')
    expect(normalizeDeviceOrientation({ windowWidth: 375, windowHeight: 667 }, 'sideways')).toBe('portrait')
    expect(normalizeDeviceOrientation({ windowWidth: 667, windowHeight: 375 }, null)).toBe('landscape')
    expect(normalizeDeviceOrientation({ windowWidth: 667, windowHeight: 375 }, 42)).toBe('landscape')
  })

  it('treats an exact square as portrait, since width is not strictly greater than height', () => {
    expect(normalizeDeviceOrientation({ windowWidth: 400, windowHeight: 400 })).toBe('portrait')
  })
})

describe('shouldDispatchResize', () => {
  const autoState: PageOrientationState = { originalPageOrientation: 'auto' }
  const fixedState: PageOrientationState = { originalPageOrientation: 'landscape' }

  const portrait = { windowWidth: 375, windowHeight: 667, deviceOrientation: 'portrait' as const }
  const landscape = { windowWidth: 667, windowHeight: 375, deviceOrientation: 'landscape' as const }

  it('leaves the window channel silent when the geometry did not move', () => {
    expect(
      shouldDispatchResize({ state: autoState, previous: portrait, next: { ...portrait } }),
    ).toEqual({ dispatchWindow: false, dispatchPage: true })
  })

  it('reports the page channel on a landing whose window never moved', () => {
    // A route commit names its landing page without comparing geometry, so a page returning into a window that rotated while it was hidden re-reads its own window instead of keeping a stale rpx basis.
    expect(
      shouldDispatchResize({ state: autoState, previous: landscape, next: { ...landscape } }),
    ).toEqual({ dispatchWindow: false, dispatchPage: true })
  })

  it('opens the window channel on the very first report, whose baseline is still empty', () => {
    expect(
      shouldDispatchResize({ state: autoState, previous: EMPTY_RESIZE_BASELINE, next: landscape }),
    ).toEqual({ dispatchWindow: true, dispatchPage: true })
  })

  it('suppresses both channels for a fixed-orientation page, even though the geometry moved', () => {
    expect(
      shouldDispatchResize({ state: fixedState, previous: portrait, next: landscape }),
    ).toEqual({ dispatchWindow: false, dispatchPage: false })
  })

  it('dispatches for an "auto" page when the device orientation changed', () => {
    expect(
      shouldDispatchResize({ state: autoState, previous: portrait, next: landscape }),
    ).toEqual({ dispatchWindow: true, dispatchPage: true })
  })

  it('dispatches for an "auto" page when only the window size changed but the orientation label did not', () => {
    expect(
      shouldDispatchResize({
        state: autoState,
        previous: portrait,
        next: { windowWidth: 390, windowHeight: 667, deviceOrientation: 'portrait' },
      }),
    ).toEqual({ dispatchWindow: true, dispatchPage: true })
  })
})

describe('orientedSafeAreaInsets', () => {
  // iPhone X profile: the numbers WeChat itself ships for this screen.
  const notched = {
    statusBarHeight: 44,
    hasNotch: true,
    safeAreaInsets: { top: 44, right: 0, bottom: 34, left: 0 },
  }
  const flat = {
    statusBarHeight: 20,
    hasNotch: false,
    safeAreaInsets: { top: 20, right: 0, bottom: 0, left: 0 },
  }

  it('returns the portrait insets untouched in portrait', () => {
    expect(orientedSafeAreaInsets(notched, 'portrait')).toEqual({ top: 44, right: 0, bottom: 34, left: 0 })
  })

  it('moves the notch from the top edge onto both sides in landscape', () => {
    expect(orientedSafeAreaInsets(notched, 'landscape')).toEqual({ top: 0, right: 44, bottom: 21, left: 44 })
  })

  it('leaves a device without a notch inset-free in landscape', () => {
    expect(orientedSafeAreaInsets(flat, 'landscape')).toEqual({ top: 0, right: 0, bottom: 0, left: 0 })
  })

  it('computes the landscape insets rather than transposing the portrait ones', () => {
    const landscape = orientedSafeAreaInsets(notched, 'landscape')
    // Transposing would have carried the portrait bottom (34) across; the real landscape home indicator is thinner, and the top frees up entirely.
    expect(landscape.bottom).not.toBe(notched.safeAreaInsets.bottom)
    expect(landscape.top).toBe(0)
  })
})
