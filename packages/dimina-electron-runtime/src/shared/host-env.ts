/**
 * The window information every mini-program surface reports, and the single
 * derivation that turns a selected device into it.
 *
 * Kept out of `bridge-channels.ts` so the sync service-host binding, the async
 * simulator handler and the per-spawn host-env all import the derivation from
 * one leaf module with no channel/protocol dependencies.
 */
import type { DeviceOrientation, NativeDeviceInfo, SafeAreaInsets } from './runtime-types.js'

/**
 * The page area as a SCREEN-coordinate rect: `right`/`bottom` are measured
 * from the screen origin (not from the far edge), matching WeChat's
 * `safeArea` and dimina's native containers (iOS `DMPUIManager.swift`).
 */
export interface SafeAreaRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export interface HostEnvSnapshot {
  brand: string
  model: string
  platform: string
  system: string
  version: string
  SDKVersion: string
  pixelRatio: number
  screenWidth: number
  screenHeight: number
  windowWidth: number
  windowHeight: number
  statusBarHeight: number
  language: string
  theme: string
  safeAreaInsets?: SafeAreaInsets
  deviceOrientation?: DeviceOrientation
  safeArea?: SafeAreaRect
  /** Screen-coordinate top of the window — the status bar height. Distinct
   *  from `safeArea.top`: a device can draw its status bar shorter than the
   *  cutout inset it sits in. */
  screenTop?: number
  [key: string]: unknown
}

/**
 * The ONE place a device's numbers become window metrics. Every mini-program
 * surface that answers `wx.getWindowInfo` / `getSystemInfo(Sync)` — the sync
 * service-host binding, the async simulator-resident handler, the per-spawn
 * host-env — carries this result rather than deriving its own, so the three
 * can't disagree.
 *
 * `windowHeight` is the screen minus BOTH vertical safe-area insets, which is
 * what dimina's native containers report (iOS `DMPUIManager.swift`, Android
 * `Utils.kt`, Harmony `DMPDeviceUtils.ets`); the status bar overlays the page
 * rather than shrinking it. `windowWidth` has no horizontal chrome. Zoom is
 * intentionally absent — it is a display scale, not a logical-size change.
 */
export function deviceInfoToHostEnv(d: NativeDeviceInfo): Partial<HostEnvSnapshot> {
  const insets = d.safeAreaInsets
  const windowHeight = Math.max(0, d.screenHeight - insets.top - insets.bottom)
  const left = insets.left
  const right = d.screenWidth - insets.right
  return {
    brand: d.brand,
    model: d.model,
    system: d.system,
    platform: d.platform,
    pixelRatio: d.pixelRatio,
    screenWidth: d.screenWidth,
    screenHeight: d.screenHeight,
    windowWidth: d.screenWidth,
    windowHeight,
    statusBarHeight: d.statusBarHeight,
    safeAreaInsets: insets,
    deviceOrientation: d.orientation,
    safeArea: {
      left,
      top: insets.top,
      right,
      bottom: d.screenHeight - insets.bottom,
      width: Math.max(0, right - left),
      height: windowHeight,
    },
    screenTop: d.statusBarHeight,
  }
}

/** Structurally a `MessageEnvelope` (bridge-channels.ts), spelled out here so
 *  this module stays a leaf the protocol file can re-export. */
export interface HostEnvUpdateMessage {
  type: 'hostEnvUpdate'
  target: 'service'
  body: { systemInfo: HostEnvSnapshot }
}

/**
 * The `hostEnvUpdate` envelope dimina's service runtime consumes
 * (`fe/packages/service/src/index.js` → `hostEnv.update(patch)`): the envelope
 * body IS the patch, so the full merged snapshot rides under `systemInfo`.
 * Pure — the caller owns storing the merged snapshot so a later spawn seeds
 * from the same values this pushed to the running service.
 */
export function makeHostEnvUpdateMessage(
  prev: HostEnvSnapshot,
  device: NativeDeviceInfo,
): HostEnvUpdateMessage {
  return {
    type: 'hostEnvUpdate',
    target: 'service',
    body: { systemInfo: { ...prev, ...deviceInfoToHostEnv(device) } },
  }
}
