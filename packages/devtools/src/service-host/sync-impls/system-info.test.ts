import { describe, expect, it } from 'vitest'
import { getSystemInfoSync, getWindowInfo } from './system-info'

describe('getSystemInfoSync safeArea', () => {
  it('reads the portrait-baseline safeAreaInsets snapshot verbatim in portrait', () => {
    const info = getSystemInfoSync.call({
      hostEnvSnapshot: {
        screenWidth: 390,
        screenHeight: 844,
        statusBarHeight: 47,
        deviceOrientation: 'portrait',
        safeAreaInsets: { top: 47, right: 0, bottom: 34, left: 0 },
      },
    })
    expect(info.safeArea).toEqual({
      left: 0,
      top: 47,
      right: 390,
      bottom: 810, // 844 - 34
      width: 390,
      height: 763, // 844 - 47 - 34
    })
  })

  it('measures the landscape rect against the landscape screen — oriented insets pair with the oriented size, never with the portrait one', () => {
    const info = getSystemInfoSync.call({
      hostEnvSnapshot: {
        // deviceInfoToHostEnv already swapped these for landscape.
        screenWidth: 844,
        screenHeight: 390,
        windowWidth: 844,
        windowHeight: 390,
        statusBarHeight: 0,
        deviceOrientation: 'landscape',
        // Landscape insets: the notch moved off the top and onto both sides, and the home indicator is thinner (orientedSafeAreaInsets).
        safeAreaInsets: { top: 0, right: 47, bottom: 21, left: 47 },
      },
    })
    expect(info.safeArea).toEqual({
      left: 47,
      top: 0,
      right: 797,
      bottom: 369,
      width: 750,
      height: 369,
    })
    // Un-swapping back to portrait would have produced a rect wider than the screen is tall and edges on the wrong axis.
    expect(info.safeArea.right).toBeLessThanOrEqual(info.screenWidth)
    expect(info.safeArea.bottom).toBeLessThanOrEqual(info.screenHeight)
  })

  it('getWindowInfo reports the same safeArea rect as getSystemInfoSync — the raw host-env snapshot the service would otherwise pick from carries only safeAreaInsets', () => {
    const snapshot = {
      screenWidth: 390,
      screenHeight: 844,
      windowWidth: 390,
      windowHeight: 753,
      statusBarHeight: 47,
      deviceOrientation: 'portrait',
      safeAreaInsets: { top: 47, right: 0, bottom: 34, left: 0 },
    }
    const win = getWindowInfo.call({ hostEnvSnapshot: snapshot })
    expect(win.safeArea).toEqual(getSystemInfoSync.call({ hostEnvSnapshot: snapshot }).safeArea)
    expect(win.safeArea).toEqual({
      left: 0,
      top: 47,
      right: 390,
      bottom: 810,
      width: 390,
      height: 763,
    })
  })

  it('getWindowInfo carries the window geometry and nothing from the device/app-info groups', () => {
    const win = getWindowInfo.call({
      hostEnvSnapshot: {
        model: 'iPhone 14',
        pixelRatio: 3,
        screenWidth: 844,
        screenHeight: 390,
        windowWidth: 844,
        windowHeight: 346,
        statusBarHeight: 0,
        deviceOrientation: 'landscape',
        safeAreaInsets: { top: 0, right: 47, bottom: 21, left: 47 },
      },
    })
    expect(win).toEqual({
      pixelRatio: 3,
      screenWidth: 844,
      screenHeight: 390,
      windowWidth: 844,
      windowHeight: 346,
      statusBarHeight: 0,
      safeArea: { left: 47, top: 0, right: 797, bottom: 369, width: 750, height: 369 },
    })
  })

  it('falls back to {top: statusBarHeight, right/bottom/left: 0} when the snapshot has no safeAreaInsets', () => {
    const info = getSystemInfoSync.call({
      hostEnvSnapshot: { screenWidth: 390, screenHeight: 844, statusBarHeight: 47 },
    })
    expect(info.safeArea).toEqual({
      left: 0,
      top: 47,
      right: 390,
      bottom: 844,
      width: 390,
      height: 797, // 844 - 47
    })
  })
})
