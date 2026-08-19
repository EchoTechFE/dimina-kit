import { describe, expect, it } from 'vitest'
import {
  NAV_BAR_HEIGHT,
  orientedDeviceMetrics,
  pageWindowSize,
  tabBarReservedHeight,
  withPageWindowSize,
} from './page-orientation.js'

/** iPhone 14 portrait baseline. */
const device = { screenWidth: 390, screenHeight: 844, statusBarHeight: 47 }
const BOTTOM_INSET = 34

describe('pageWindowSize', () => {
  it('reserves the status bar and the navigation bar on a default page', () => {
    expect(pageWindowSize(device, { isTab: false, bottomInset: BOTTOM_INSET })).toEqual({
      windowWidth: 390,
      windowHeight: 844 - 47 - NAV_BAR_HEIGHT,
    })
  })

  it('leaves the full screen height to a custom-navigation page', () => {
    const size = pageWindowSize(device, {
      navigationStyle: 'custom',
      isTab: false,
      bottomInset: BOTTOM_INSET,
    })
    expect(size).toEqual({ windowWidth: 390, windowHeight: 844 })
  })

  it('reserves the tab bar, its home-indicator padding and its border on a tab page', () => {
    expect(tabBarReservedHeight(BOTTOM_INSET)).toBe(85)
    const size = pageWindowSize(device, { isTab: true, bottomInset: BOTTOM_INSET })
    expect(size.windowHeight).toBe(844 - 47 - NAV_BAR_HEIGHT - 85)
  })

  it('drops the status bar but keeps the navigation bar in landscape', () => {
    const oriented = orientedDeviceMetrics(device, 'landscape')
    expect(pageWindowSize(oriented, { isTab: false, bottomInset: BOTTOM_INSET })).toEqual({
      windowWidth: 844,
      windowHeight: 390 - NAV_BAR_HEIGHT,
    })
  })

  it('never reports a negative height when the chrome exceeds the screen', () => {
    const tiny = { screenWidth: 100, screenHeight: 40, statusBarHeight: 47 }
    expect(pageWindowSize(tiny, { isTab: true, bottomInset: BOTTOM_INSET }).windowHeight).toBe(0)
  })
})

describe('withPageWindowSize', () => {
  /** A host-env seed carries the device's screen, so its window fields start as the whole screen minus the status bar. */
  const seed = {
    screenWidth: 390,
    screenHeight: 844,
    statusBarHeight: 47,
    windowWidth: 390,
    windowHeight: 844 - 47,
    model: 'iPhone 14',
  }

  it('replaces the window size with what the page chrome leaves', () => {
    const seeded = withPageWindowSize(seed, { isTab: false, bottomInset: BOTTOM_INSET })
    expect(seeded.windowHeight).toBe(844 - 47 - NAV_BAR_HEIGHT)
    expect(seeded.windowWidth).toBe(390)
  })

  it('agrees with the size the shell measures for the same page', () => {
    const chrome = { navigationStyle: 'default' as const, isTab: true, bottomInset: BOTTOM_INSET }
    const seeded = withPageWindowSize(seed, chrome)
    const measured = pageWindowSize(orientedDeviceMetrics(device, 'portrait'), chrome)
    expect({ windowWidth: seeded.windowWidth, windowHeight: seeded.windowHeight }).toEqual(measured)
  })

  it('keeps every other snapshot field untouched', () => {
    const seeded = withPageWindowSize(seed, { isTab: false, bottomInset: BOTTOM_INSET })
    expect(seeded.model).toBe('iPhone 14')
    expect(seeded.screenHeight).toBe(844)
    expect(seeded.statusBarHeight).toBe(47)
  })
})
