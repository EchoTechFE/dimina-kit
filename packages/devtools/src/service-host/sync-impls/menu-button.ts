import { getMenuCapsuleRect, type MenuButtonRect, type MenuPlatform } from '../../simulator/device-shell/menu-button-geometry.js'

interface SpawnContext {
  hostEnvSnapshot?: {
    platform?: string
    windowWidth?: number
    statusBarHeight?: number
  }
}

/**
 * wx.getMenuButtonBoundingClientRect() — synchronous, returns the capsule
 * geometry mirrored from dimina's native containers: width 87, height 32
 * on both platforms; top = statusBarHeight + 6 (iOS) / + 16 (Android), since
 * the nav bar content height differs (44 vs 64); right/left are absolute
 * pixel positions (right = windowWidth - 10). See menu-button-geometry.ts.
 *
 * Pulls platform + dimensions from spawn-time host env snapshot (delivered
 * via `?hostEnv=` URL query, see service-host/preload.cjs).
 */
export function getMenuButtonBoundingClientRect(this: SpawnContext): MenuButtonRect {
  const snapshot = this.hostEnvSnapshot ?? {}
  const platform: MenuPlatform = snapshot.platform === 'android' ? 'android' : 'ios'
  const windowWidth = typeof snapshot.windowWidth === 'number' ? snapshot.windowWidth : 390
  const statusBarHeight = typeof snapshot.statusBarHeight === 'number' ? snapshot.statusBarHeight : 44
  return getMenuCapsuleRect(platform, statusBarHeight, windowWidth)
}
