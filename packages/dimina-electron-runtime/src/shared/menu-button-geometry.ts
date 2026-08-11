/**
 * Pure-function geometry for the WeChat capsule. Lives in a standalone module
 * so the service-host sync impl (no React) and the DeviceShell React component
 * can share it without bundling React into service.html.
 *
 * Constants mirror dimina's native containers so the simulator's capsule
 * matches what actually renders on-device — see:
 * - Android: dimina/android/dimina/src/main/kotlin/com/didi/dimina/common/MenuButtonGeometry.kt
 * - iOS: dimina/iOS/dimina/DiminaKit/Container/Api/UI/MenuAPI.swift
 * Both platforms use the same capsule size and trailing spacing; only the
 * nav-bar content height (and therefore the capsule's vertical centering)
 * differs.
 */
export type MenuPlatform = 'ios' | 'android'

export const MENU_CAPSULE_WIDTH = 87
export const MENU_CAPSULE_HEIGHT = 32
export const MENU_CAPSULE_TRAILING_SPACING = 10

const NAV_BAR_CONTENT_HEIGHT: Record<MenuPlatform, number> = {
  ios: 44,
  android: 64,
}

export function getMenuCapsuleTopOffset(platform: MenuPlatform): number {
  return (NAV_BAR_CONTENT_HEIGHT[platform] - MENU_CAPSULE_HEIGHT) / 2
}

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
  const width = MENU_CAPSULE_WIDTH
  const height = MENU_CAPSULE_HEIGHT
  const top = statusBarHeight + getMenuCapsuleTopOffset(platform)
  const right = Math.max(windowWidth - MENU_CAPSULE_TRAILING_SPACING, width)
  const left = right - width
  return { width, height, top, right, bottom: top + height, left }
}
