import { describe, expect, expectTypeOf, it } from 'vitest'
import { deviceInfoToHostEnv, makeHostEnvUpdateMessage } from './bridge-channels.js'
import type { HostEnvSnapshot } from './bridge-channels.js'
import type { DeviceOrientation, NativeDeviceInfo } from './runtime-types.js'

describe('deviceInfoToHostEnv', () => {
  it('carries a landscape Android device through to the snapshot unchanged', () => {
    const info: NativeDeviceInfo = {
      device: 'Pixel 8',
      brand: 'Google',
      model: 'Pixel 8',
      system: 'Android 14',
      platform: 'android',
      orientation: 'landscape',
      pixelRatio: 2.625,
      // Already the current-orientation (landscape) values: width/height swapped,
      // insets are the landscape set (left/right widen for the notch cutout).
      screenWidth: 852,
      screenHeight: 393,
      statusBarHeight: 24,
      safeAreaInsets: { top: 0, right: 59, bottom: 0, left: 59 },
    }

    const snapshot = deviceInfoToHostEnv(info)

    expect(snapshot.brand).toBe('Google')
    expect(snapshot.model).toBe('Pixel 8')
    expect(snapshot.system).toBe('Android 14')
    expect(snapshot.platform).toBe('android')
    expect(snapshot.pixelRatio).toBe(2.625)
    expect(snapshot.screenWidth).toBe(852)
    expect(snapshot.screenHeight).toBe(393)
    expect(snapshot.windowWidth).toBe(852)
    // Window height is the screen minus the vertical safe-area insets (both 0
    // here) — the status bar overlays the page rather than shrinking it.
    expect(snapshot.windowHeight).toBe(393)
    expect(snapshot.statusBarHeight).toBe(24)
    expect(snapshot.safeAreaInsets).toEqual({ top: 0, right: 59, bottom: 0, left: 59 })
    expect(snapshot.deviceOrientation).toBe('landscape')
  })
})

describe('NativeDeviceInfo shape', () => {
  it('no longer carries notchType — cutout geometry is looked up from the devices table by name', () => {
    expectTypeOf<NativeDeviceInfo>().not.toHaveProperty('notchType')
  })

  it('carries an orientation the current-orientation screen/inset values are already resolved against', () => {
    expectTypeOf<NativeDeviceInfo>().toHaveProperty('orientation')
    expectTypeOf<NativeDeviceInfo['orientation']>().toEqualTypeOf<DeviceOrientation>()
  })
})

// The window metrics every mini-program surface reads (sync getWindowInfo /
// getSystemInfoSync, async getSystemInfo, the per-spawn host-env) are derived
// here and nowhere else, matching what dimina's native containers report:
// the page area is the screen minus the vertical safe-area insets, and
// `safeArea` is a screen-coordinate rect (right/bottom measured from the
// screen origin, not from the far edge).
const IPHONE_15: NativeDeviceInfo = {
  device: 'iPhone 15',
  brand: 'Apple',
  model: 'iPhone 15',
  system: 'iOS 17.0',
  platform: 'ios',
  orientation: 'portrait',
  pixelRatio: 3,
  screenWidth: 393,
  screenHeight: 852,
  statusBarHeight: 54,
  safeAreaInsets: { top: 59, right: 0, bottom: 34, left: 0 },
}

/** No cutout and no gesture bar: every inset is 0, so the page area is the
 *  whole screen even though a status bar is drawn over it. */
const ANDROID_NO_NOTCH: NativeDeviceInfo = {
  device: 'Galaxy A54',
  brand: 'Samsung',
  model: 'Galaxy A54',
  system: 'Android 13',
  platform: 'android',
  orientation: 'portrait',
  pixelRatio: 2.625,
  screenWidth: 412,
  screenHeight: 915,
  statusBarHeight: 24,
  safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
}

/** Gesture navigation bar at the bottom, no top cutout. */
const ANDROID_GESTURE_BAR: NativeDeviceInfo = {
  device: 'Pixel 7',
  brand: 'Google',
  model: 'Pixel 7',
  system: 'Android 13',
  platform: 'android',
  orientation: 'portrait',
  pixelRatio: 2.625,
  screenWidth: 412,
  screenHeight: 915,
  statusBarHeight: 24,
  safeAreaInsets: { top: 0, right: 0, bottom: 24, left: 0 },
}

describe('deviceInfoToHostEnv window metrics', () => {
  it('excludes both vertical insets from windowHeight and reports safeArea in screen coordinates', () => {
    const snapshot = deviceInfoToHostEnv(IPHONE_15)

    expect(snapshot.windowWidth).toBe(393)
    expect(snapshot.windowHeight).toBe(852 - 59 - 34)
    expect(snapshot.safeArea).toEqual({
      left: 0,
      top: 59,
      right: 393,
      bottom: 818,
      width: 393,
      height: 759,
    })
    expect(snapshot.screenTop).toBe(54)
  })

  it('gives an inset-free device the full screen as its page area and safe area', () => {
    const snapshot = deviceInfoToHostEnv(ANDROID_NO_NOTCH)

    expect(snapshot.windowWidth).toBe(412)
    expect(snapshot.windowHeight).toBe(915)
    expect(snapshot.safeArea).toEqual({
      left: 0,
      top: 0,
      right: 412,
      bottom: 915,
      width: 412,
      height: 915,
    })
    expect(snapshot.screenTop).toBe(24)
  })

  it('subtracts a bottom-only inset while leaving the top of the safe area at the screen top', () => {
    const snapshot = deviceInfoToHostEnv(ANDROID_GESTURE_BAR)

    expect(snapshot.windowHeight).toBe(915 - 24)
    expect(snapshot.safeArea).toEqual({
      left: 0,
      top: 0,
      right: 412,
      bottom: 891,
      width: 412,
      height: 891,
    })
    expect(snapshot.screenTop).toBe(24)
  })

  it('keeps the device identity and raw insets alongside the derived metrics', () => {
    const snapshot = deviceInfoToHostEnv(IPHONE_15)

    expect(snapshot.brand).toBe('Apple')
    expect(snapshot.model).toBe('iPhone 15')
    expect(snapshot.system).toBe('iOS 17.0')
    expect(snapshot.platform).toBe('ios')
    expect(snapshot.pixelRatio).toBe(3)
    expect(snapshot.screenWidth).toBe(393)
    expect(snapshot.screenHeight).toBe(852)
    expect(snapshot.statusBarHeight).toBe(54)
    expect(snapshot.safeAreaInsets).toEqual({ top: 59, right: 0, bottom: 34, left: 0 })
    expect(snapshot.deviceOrientation).toBe('portrait')
  })
})

describe('makeHostEnvUpdateMessage', () => {
  const PREV: HostEnvSnapshot = {
    brand: 'Google',
    model: 'Pixel 7',
    platform: 'android',
    system: 'Android 13',
    version: '8.0.5',
    SDKVersion: '3.0.0',
    pixelRatio: 2.625,
    screenWidth: 412,
    screenHeight: 915,
    windowWidth: 412,
    windowHeight: 891,
    statusBarHeight: 24,
    language: 'zh-CN',
    theme: 'light',
  }

  it('builds the envelope the service host-env listener consumes', () => {
    const message = makeHostEnvUpdateMessage(PREV, IPHONE_15)

    expect(message.type).toBe('hostEnvUpdate')
    expect(message.target).toBe('service')
    expect(message.body).toEqual({ systemInfo: { ...PREV, ...deviceInfoToHostEnv(IPHONE_15) } })
  })

  it('keeps snapshot fields the device cannot supply and overwrites the ones it can', () => {
    const message = makeHostEnvUpdateMessage(PREV, IPHONE_15)
    const systemInfo = message.body.systemInfo

    // Not derivable from a device: carried over from the previous snapshot.
    expect(systemInfo.language).toBe('zh-CN')
    expect(systemInfo.version).toBe('8.0.5')
    expect(systemInfo.SDKVersion).toBe('3.0.0')
    expect(systemInfo.theme).toBe('light')
    // Device-derived: replaced wholesale, including the new safeArea/screenTop.
    expect(systemInfo.model).toBe('iPhone 15')
    expect(systemInfo.screenWidth).toBe(393)
    expect(systemInfo.windowHeight).toBe(759)
    expect(systemInfo.safeArea).toEqual({ left: 0, top: 59, right: 393, bottom: 818, width: 393, height: 759 })
    expect(systemInfo.screenTop).toBe(54)
  })

  it('does not mutate the snapshot it was given', () => {
    const prev = { ...PREV }
    makeHostEnvUpdateMessage(prev, IPHONE_15)
    expect(prev).toEqual(PREV)
  })
})
