import type { Orientation } from './page-orientation.js'

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
  /**
   * Orientation of the simulated device itself, which the user controls and which survives across mini-app sessions. `screenWidth`/`screenHeight` stay portrait-baseline regardless; consumers derive the rotated metrics through `orientedDeviceMetrics`.
   */
  deviceOrientation?: Orientation
}

/** Change emitted by synchronous storage APIs running in the service host. */
export type SyncStorageChange =
  | { op: 'set'; key: string; value: string }
  | { op: 'remove'; key: string }
  | { op: 'clear' }
