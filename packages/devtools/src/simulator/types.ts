import type { Orientation } from '@dimina-kit/electron-runtime/shared/page-orientation'

/** Callback type used by API functions */
export type Callback = (...args: unknown[]) => void

/**
 * Metric fallbacks derived from the CURRENTLY emulated device. Provided by
 * SimulatorMiniApp.getDeviceMetrics() so the simulator-resident wx.* handlers
 * (readWindowMetrics in simulator-api.ts) report the selected device instead
 * of a hardcoded rect when neither `window.__deviceInfo` nor a host DOM rect
 * is available.
 */
export interface DeviceMetrics {
  pixelRatio: number
  screenWidth: number
  screenHeight: number
  statusBarHeight: number
  /** Per-edge safe-area insets (portrait). Single source of truth for the
   *  bottom inset — there is no separate `safeAreaBottom` field. */
  safeAreaInsets: { top: number; right: number; bottom: number; left: number }
  /** Whether the screen has a notch/dynamic island: in landscape it moves to
   *  both side edges, which is the only thing the portrait insets cannot say. */
  hasNotch: boolean
  /** The simulated device's own orientation (user-controlled, not the mini-app's effective one). */
  deviceOrientation?: Orientation
}

/**
 * Context (`this`) available to each registered miniapp API handler.
 * Bound by AppManager.registerApi → MiniApp.invokeApi.
 */
export interface MiniAppContext {
  createCallbackFunction(fn: unknown): Callback | undefined
  appId: string
  parent?: {
    el?: Element
    getStatusBarRect?: () => { height: number }
  }
  /**
   * Current device metric fallbacks (SimulatorMiniApp implements this; legacy
   * or mock contexts without it keep the pre-device fallback behavior).
   */
  getDeviceMetrics?(): DeviceMetrics
}
