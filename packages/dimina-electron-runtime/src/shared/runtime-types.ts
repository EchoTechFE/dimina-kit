export type NotchType = 'none' | 'notch' | 'dynamic-island'

export interface SafeAreaInsets {
  top: number
  right: number
  bottom: number
  left: number
}

/** Logical device information mirrored into the mini-app host environment. */
export interface NativeDeviceInfo {
  brand: string
  model: string
  system: string
  platform: string
  pixelRatio: number
  screenWidth: number
  screenHeight: number
  statusBarHeight: number
  notchType: NotchType
  safeAreaInsets: SafeAreaInsets
}

/** Change emitted by synchronous storage APIs running in the service host. */
export type SyncStorageChange =
  | { op: 'set'; key: string; value: string }
  | { op: 'remove'; key: string }
  | { op: 'clear' }
