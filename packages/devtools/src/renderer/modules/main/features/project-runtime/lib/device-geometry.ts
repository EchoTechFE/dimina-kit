import { orientedDeviceMetrics, type Orientation } from '@dimina-kit/electron-runtime/shared/page-orientation'
import { SIM_PANEL_PADDING, MIN_PANEL_WIDTH_PX } from '@/shared/constants'

/**
 * Device width/height at the given display orientation — landscape swaps them, matching how device-shell renders the phone.
 * Single source of truth (`orientedDeviceMetrics`) shared with the simulator shell and main; panel sizing only needs the screen dimensions, not the status-bar split.
 */
export function orientedDeviceSize(
  device: { width: number; height: number; statusBarHeight: number },
  orientation: Orientation,
): { width: number; height: number } {
  const m = orientedDeviceMetrics(
    { screenWidth: device.width, screenHeight: device.height, statusBarHeight: device.statusBarHeight },
    orientation,
  )
  return { width: m.screenWidth, height: m.screenHeight }
}

/** Calculate simulator panel width from device width. */
export function computeSimPanelWidth(deviceWidth: number): number {
  return deviceWidth + SIM_PANEL_PADDING * 2
}

/** Clamp a panel width to valid bounds. */
export function clampPanelWidth(width: number, windowWidth: number): number {
  return Math.max(MIN_PANEL_WIDTH_PX, Math.min(windowWidth - MIN_PANEL_WIDTH_PX, width))
}
