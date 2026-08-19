/**
 * The host-env fields a `PAGE_RESIZE` replaces — the page-driven counterpart to `deviceInfoToHostEnv` (shared/bridge-channels.ts), which answers the same question for a device change.
 */
import type { HostEnvSnapshot } from './bridge-channels.js'
import type { NativeDeviceInfo } from './runtime-types.js'
import { orientedDeviceMetrics, orientedSafeAreaInsets, type Orientation } from './page-orientation.js'

/**
 * Every field is resolved against the orientation the resized page is SHOWING rather than the device's own — a page pinned to landscape on a portrait phone reports landscape metrics.
 *
 * The safe-area insets travel with those metrics: `getSystemInfoSync` builds its `safeArea` rect by measuring the insets against the screen dimensions in the same snapshot (devtools service-host/sync-impls/system-info.ts), so leaving the device's portrait insets next to landscape dimensions would reserve a top edge for a status bar that is not drawn and put the notch on the wrong axis.
 * Without a selected device only the size and the orientation are known.
 */
export function pageResizeHostEnv(
  resize: { size: { windowWidth: number, windowHeight: number }, deviceOrientation: Orientation },
  device: NativeDeviceInfo | null,
): Partial<HostEnvSnapshot> {
  const patch: Partial<HostEnvSnapshot> = {
    windowWidth: resize.size.windowWidth,
    windowHeight: resize.size.windowHeight,
    deviceOrientation: resize.deviceOrientation,
  }
  if (!device) return patch
  const metrics = orientedDeviceMetrics(device, resize.deviceOrientation)
  patch.screenWidth = metrics.screenWidth
  patch.screenHeight = metrics.screenHeight
  patch.statusBarHeight = metrics.statusBarHeight
  patch.safeAreaInsets = orientedSafeAreaInsets(
    { statusBarHeight: device.statusBarHeight, hasNotch: device.notchType !== 'none', safeAreaInsets: device.safeAreaInsets },
    resize.deviceOrientation,
  )
  return patch
}
