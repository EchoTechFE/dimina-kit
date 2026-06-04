/**
 * Pure-function geometry for the WeChat capsule. Lives in a standalone module
 * so the service-host sync impl (no React) and the DeviceShell React component
 * can share it without bundling React into service.html.
 */
export type MenuPlatform = 'ios' | 'android'

export interface MenuButtonRect {
  width: number
  height: number
  top: number
  right: number
  bottom: number
  left: number
}

export function getMenuCapsuleRect(
  platform: MenuPlatform,
  statusBarHeight: number,
  windowWidth: number,
): MenuButtonRect {
  const width = platform === 'ios' ? 87 : 95
  const height = 32
  const top = statusBarHeight + (platform === 'ios' ? 4 : 6)
  const right = platform === 'ios' ? 7 : 10
  const left = windowWidth - right - width
  return { width, height, top, right, bottom: top + height, left }
}
