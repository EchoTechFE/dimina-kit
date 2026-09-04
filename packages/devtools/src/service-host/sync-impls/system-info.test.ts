/**
 * getSystemInfoSync's safeArea/orientation derivation from the host-env
 * snapshot the device picker pushes (screen/window size, statusBarHeight,
 * safeAreaInsets, deviceOrientation).
 */
import { describe, it, expect } from 'vitest'
import { getSystemInfoSync } from './system-info'

interface FakeSpawnContext {
  hostEnvSnapshot: Record<string, unknown>
}

function callWith(hostEnvSnapshot: Record<string, unknown>) {
  const ctx: FakeSpawnContext = { hostEnvSnapshot }
  return getSystemInfoSync.call(ctx as unknown as ThisParameterType<typeof getSystemInfoSync>)
}

describe('getSystemInfoSync: a snapshot carrying safeAreaInsets and deviceOrientation', () => {
  it('reports the pushed orientation and derives safeArea from the per-edge insets', () => {
    const info = callWith({
      screenWidth: 852,
      screenHeight: 393,
      windowWidth: 852,
      windowHeight: 393,
      statusBarHeight: 0,
      safeAreaInsets: { top: 0, right: 59, bottom: 21, left: 59 },
      deviceOrientation: 'landscape',
    })

    expect(info.deviceOrientation).toBe('landscape')
    expect(info.safeArea).toEqual({
      left: 59,
      top: 0,
      right: 793,
      bottom: 372,
      width: 734,
      height: 372,
    })
  })
})

describe('getSystemInfoSync: a snapshot with no safeAreaInsets', () => {
  it('keeps the existing derivation (top=statusBarHeight, bottom=windowHeight, left 0, right=windowWidth) and stays portrait', () => {
    const info = callWith({
      screenWidth: 390,
      screenHeight: 844,
      windowWidth: 390,
      windowHeight: 844,
      statusBarHeight: 47,
    })

    expect(info.deviceOrientation).toBe('portrait')
    expect(info.safeArea).toEqual({
      top: 47,
      bottom: 844,
      left: 0,
      right: 390,
      width: 390,
      height: 797,
    })
  })
})

// A snapshot minted by the runtime's deviceInfoToHostEnv already carries the
// resolved window metrics (windowWidth/windowHeight/safeArea/screenTop). That
// snapshot is the single source of truth for those numbers — recomputing them
// here would let the sync path disagree with the async and per-spawn paths.
describe('getSystemInfoSync: a snapshot that already carries resolved window metrics', () => {
  const IPHONE_15_SNAPSHOT = {
    brand: 'Apple',
    model: 'iPhone 15',
    system: 'iOS 17.0',
    platform: 'ios',
    pixelRatio: 3,
    screenWidth: 393,
    screenHeight: 852,
    windowWidth: 393,
    windowHeight: 759,
    statusBarHeight: 54,
    safeAreaInsets: { top: 59, right: 0, bottom: 34, left: 0 },
    safeArea: { left: 0, top: 59, right: 393, bottom: 818, width: 393, height: 759 },
    screenTop: 54,
    deviceOrientation: 'portrait',
  }

  it('passes the snapshot safeArea through untouched instead of re-deriving it from the insets', () => {
    const info = callWith(IPHONE_15_SNAPSHOT)

    expect(info.safeArea).toEqual(IPHONE_15_SNAPSHOT.safeArea)
  })

  it('reports the snapshot window size and screenTop', () => {
    const info = callWith(IPHONE_15_SNAPSHOT)

    expect(info.windowWidth).toBe(393)
    expect(info.windowHeight).toBe(759)
    expect((info as unknown as Record<string, unknown>).screenTop).toBe(54)
    expect(info.deviceOrientation).toBe('portrait')
  })
})
