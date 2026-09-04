export type DeviceOrientation = 'portrait' | 'landscape'

export interface SafeAreaInsets {
  top: number
  right: number
  bottom: number
  left: number
}

/** Logical device information mirrored into the mini-app host environment. */
export interface NativeDeviceInfo {
  /** Name in the @devicekit/devices table; absent for custom devices. */
  device?: string
  brand: string
  model: string
  system: string
  /** 'ios' | 'android' | 'harmony' (kept as string so electron-runtime doesn't depend on devices). */
  platform: string
  orientation: DeviceOrientation
  pixelRatio: number
  /** All of the below are already resolved for the CURRENT orientation: width/height
   * are swapped and insets are the landscape set when orientation is 'landscape'. */
  screenWidth: number
  screenHeight: number
  statusBarHeight: number
  safeAreaInsets: SafeAreaInsets
}

/** Change emitted by synchronous storage APIs running in the service host. */
export type SyncStorageChange =
  | { op: 'set'; key: string; value: string }
  | { op: 'remove'; key: string }
  | { op: 'clear' }
