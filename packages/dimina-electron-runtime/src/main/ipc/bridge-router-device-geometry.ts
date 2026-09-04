/**
 * Pure geometry diff behind `bridge.setDevice()` (see DESIGN.md's root-cause
 * section). A device/orientation change only reaches a spawned service
 * through this: `ap.hostEnv` is otherwise set once at spawn and never
 * refreshed, so `wx.getSystemInfoSync()` and `Page.onResize` would both go
 * permanently stale after any later device switch.
 */
import { deviceInfoToHostEnv, deviceOrientationOf } from '../../shared/bridge-channels.js'
import type { HostEnvSnapshot, MessageEnvelope } from '../../shared/bridge-channels.js'
import type { NativeDeviceInfo } from '../../shared/runtime-types.js'

export interface DeviceGeometryUpdate {
  hostEnv: HostEnvSnapshot
  orientation: 'portrait' | 'landscape'
  /** Whether any window/screen dim or the orientation actually moved — the
   *  gate for whether `Page.onResize` fires at all. WeChat never resizes a
   *  page whose geometry didn't change, even if `setDevice` ran again. */
  geometryChanged: boolean
}

/**
 * Host-env a spawn reports: the simulator-supplied snapshot (built from the
 * device baked in at simulator BOOT time, so stale across a live device
 * change) with the currently selected device layered on top. No selection yet
 * → the snapshot alone.
 */
export function spawnHostEnvFor(
  snapshot: Partial<HostEnvSnapshot> | undefined,
  selectedDevice: NativeDeviceInfo | null,
): Partial<HostEnvSnapshot> {
  return { ...snapshot, ...(selectedDevice ? deviceInfoToHostEnv(selectedDevice) : {}) }
}

/** Orientation a hostEnv snapshot's physical screen dims imply (same rule as `deviceOrientationOf`). */
export function orientationOfHostEnv(
  env: Pick<HostEnvSnapshot, 'screenWidth' | 'screenHeight'>,
): 'portrait' | 'landscape' {
  return env.screenWidth > env.screenHeight ? 'landscape' : 'portrait'
}

export function computeDeviceGeometryUpdate(
  prevHostEnv: HostEnvSnapshot,
  prevOrientation: 'portrait' | 'landscape',
  device: NativeDeviceInfo,
): DeviceGeometryUpdate {
  const hostEnv = { ...prevHostEnv, ...deviceInfoToHostEnv(device) }
  const orientation = deviceOrientationOf(device)
  const geometryChanged =
    hostEnv.windowWidth !== prevHostEnv.windowWidth
    || hostEnv.windowHeight !== prevHostEnv.windowHeight
    || hostEnv.screenWidth !== prevHostEnv.screenWidth
    || hostEnv.screenHeight !== prevHostEnv.screenHeight
    || orientation !== prevOrientation
  return { hostEnv, orientation, geometryChanged }
}

/** The slice of an app session that a device change reads and rewrites. */
export interface DeviceGeometrySession {
  hostEnv: HostEnvSnapshot
  deviceOrientation: 'portrait' | 'landscape'
  visibleBridgeId: string | null
}

/**
 * Apply a device change to one session and return the service messages it
 * owes, in send order: `hostEnvUpdate` always (so `wx.getSystemInfoSync()`
 * stops reporting the spawn-time device), then `pageResize` only when the
 * geometry actually moved and a page is visible — WeChat never resizes a
 * hidden page, and a re-applied identical device is not a resize.
 * `hostEnvUpdate` goes first so `wx.getWindowInfo()` inside the page's
 * `onResize` handler already reads the new dims.
 */
export function applyDeviceToSession(
  session: DeviceGeometrySession,
  device: NativeDeviceInfo,
): MessageEnvelope[] {
  const { hostEnv, orientation, geometryChanged } = computeDeviceGeometryUpdate(
    session.hostEnv,
    session.deviceOrientation,
    device,
  )
  session.hostEnv = hostEnv
  session.deviceOrientation = orientation
  const messages: MessageEnvelope[] = [
    { type: 'hostEnvUpdate', target: 'service', body: { systemInfo: hostEnv } },
  ]
  if (geometryChanged && session.visibleBridgeId) {
    messages.push({
      type: 'pageResize',
      target: 'service',
      body: {
        bridgeId: session.visibleBridgeId,
        size: {
          size: {
            windowWidth: hostEnv.windowWidth,
            windowHeight: hostEnv.windowHeight,
            screenWidth: hostEnv.screenWidth,
            screenHeight: hostEnv.screenHeight,
          },
          deviceOrientation: orientation,
        },
      },
    })
  }
  return messages
}
