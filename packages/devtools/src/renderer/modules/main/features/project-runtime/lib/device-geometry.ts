import { SIM_PANEL_PADDING, MIN_PANEL_WIDTH_PX } from '@/shared/constants'

/** Calculate simulator panel width from device width. */
export function computeSimPanelWidth(deviceWidth: number): number {
  return deviceWidth + SIM_PANEL_PADDING * 2
}

/** Clamp a panel width to valid bounds. */
export function clampPanelWidth(width: number, windowWidth: number): number {
  return Math.max(MIN_PANEL_WIDTH_PX, Math.min(windowWidth - MIN_PANEL_WIDTH_PX, width))
}
