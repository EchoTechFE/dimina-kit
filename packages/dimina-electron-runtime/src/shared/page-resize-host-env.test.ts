/**
 * The host-env patch a `PAGE_RESIZE` installs.
 *
 * Every geometry field it carries has to describe the SAME orientation — the one the page being resized is actually showing.
 * A page pinned to landscape on a portrait phone gets landscape screen metrics, so it must also get landscape safe-area insets; pairing them with the device's portrait insets would report a top inset for a status bar that is not drawn and put the notch on an edge it does not occupy.
 */
import { describe, expect, it } from 'vitest'
import { pageResizeHostEnv } from './page-resize-host-env.js'
import type { NativeDeviceInfo } from './runtime-types.js'

/** iPhone 14: notched, portrait baseline 390x844. */
const DEVICE: NativeDeviceInfo = {
  brand: 'Apple',
  model: 'iPhone 14',
  system: 'iOS 16.0',
  platform: 'ios',
  pixelRatio: 3,
  screenWidth: 390,
  screenHeight: 844,
  statusBarHeight: 47,
  notchType: 'dynamic-island',
  safeAreaInsets: { top: 47, right: 0, bottom: 34, left: 0 },
  deviceOrientation: 'portrait',
}

const LANDSCAPE_RESIZE = {
  size: { windowWidth: 844, windowHeight: 346 },
  deviceOrientation: 'landscape' as const,
}

const PORTRAIT_RESIZE = {
  size: { windowWidth: 390, windowHeight: 753 },
  deviceOrientation: 'portrait' as const,
}

describe('pageResizeHostEnv', () => {
  it('always carries the reported window size and orientation', () => {
    expect(pageResizeHostEnv(PORTRAIT_RESIZE, null)).toEqual({
      windowWidth: 390,
      windowHeight: 753,
      deviceOrientation: 'portrait',
    })
  })

  it('resolves the screen metrics against the resize orientation, not the device one', () => {
    const patch = pageResizeHostEnv(LANDSCAPE_RESIZE, DEVICE)
    expect(patch.screenWidth).toBe(844)
    expect(patch.screenHeight).toBe(390)
    expect(patch.statusBarHeight).toBe(0)
  })

  it('resolves the safe-area insets against the resize orientation too', () => {
    const patch = pageResizeHostEnv(LANDSCAPE_RESIZE, DEVICE)
    expect(patch.safeAreaInsets, 'a page drawn landscape must not keep the portrait insets')
      .toEqual({ top: 0, right: 47, bottom: 21, left: 47 })
  })

  it('keeps the portrait insets for a page drawn portrait on a rotated device', () => {
    const patch = pageResizeHostEnv(PORTRAIT_RESIZE, { ...DEVICE, deviceOrientation: 'landscape' })
    expect(patch.safeAreaInsets).toEqual({ top: 47, right: 0, bottom: 34, left: 0 })
    expect(patch.screenWidth).toBe(390)
    expect(patch.statusBarHeight).toBe(47)
  })

  it('leaves the insets alone when no device is selected', () => {
    expect(pageResizeHostEnv(LANDSCAPE_RESIZE, null)).not.toHaveProperty('safeAreaInsets')
  })
})
