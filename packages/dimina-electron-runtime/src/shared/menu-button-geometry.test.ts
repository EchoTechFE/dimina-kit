import { describe, expect, it } from 'vitest'
import { getMenuCapsuleRect } from './menu-button-geometry'

describe('getMenuCapsuleRect', () => {
  it('uses the same 87x32 capsule size on iOS and Android (dimina native uses one size for both)', () => {
    const ios = getMenuCapsuleRect('ios', 44, 390)
    const android = getMenuCapsuleRect('android', 24, 393)
    expect(ios.width).toBe(87)
    expect(ios.height).toBe(32)
    expect(android.width).toBe(87)
    expect(android.height).toBe(32)
  })

  it('centers the capsule within iOS 44pt nav-bar content height (statusBarHeight + 6)', () => {
    const rect = getMenuCapsuleRect('ios', 44, 390)
    expect(rect.top).toBe(50)
  })

  it('centers the capsule within Android 64dp nav-bar content height (statusBarHeight + 16)', () => {
    const rect = getMenuCapsuleRect('android', 24, 393)
    expect(rect.top).toBe(40)
  })

  it('returns an absolute right edge (windowWidth - 10dp trailing spacing), matching wx.getMenuButtonBoundingClientRect()', () => {
    const rect = getMenuCapsuleRect('ios', 44, 390)
    expect(rect.right).toBe(380)
    expect(rect.left).toBe(293)
    expect(rect.bottom).toBe(rect.top + 32)
  })

  it('never reports a right edge narrower than the capsule width on tiny viewports', () => {
    const rect = getMenuCapsuleRect('android', 24, 50)
    expect(rect.right).toBe(87)
    expect(rect.left).toBe(0)
  })
})
