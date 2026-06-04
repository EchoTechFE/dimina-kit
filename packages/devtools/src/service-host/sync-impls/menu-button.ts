import { getMenuCapsuleRect, type MenuButtonRect, type MenuPlatform } from '../../simulator/device-shell/menu-button-geometry.js'

interface SpawnContext {
  hostEnvSnapshot?: {
    platform?: string
    windowWidth?: number
    statusBarHeight?: number
  }
}

/**
 * wx.getMenuButtonBoundingClientRect() — synchronous, returns the WeChat
 * capsule geometry. iOS: width 87, Android: width 95, height 32, top =
 * statusBarHeight + (4|6), right = (7|10). See navigation-bar spec.
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
