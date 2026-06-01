/** Layout constants (px) */
export const SPLITTER_W = 4

/**
 * X coordinate where the legacy right-side overlay starts.
 */
export function getRightX(simWidth: number): number {
  return simWidth + SPLITTER_W
}

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export function computeRightPanelBounds(
  contentWidth: number,
  contentHeight: number,
  simWidth: number,
  headerHeight: number,
): Bounds {
  const x = getRightX(simWidth)
  return {
    x,
    y: headerHeight,
    width: Math.max(1, contentWidth - x),
    height: Math.max(1, contentHeight - headerHeight),
  }
}

/**
 * Compute bounds for DevTools view (same as right panel, overlays it).
 */
export function computeSimulatorBounds(
  contentWidth: number,
  contentHeight: number,
  simWidth: number,
  headerHeight: number,
): Bounds {
  return computeRightPanelBounds(contentWidth, contentHeight, simWidth, headerHeight)
}

export const SETTINGS_W = 320

export function computeSettingsBounds(
  contentWidth: number,
  contentHeight: number,
  headerHeight: number,
): Bounds {
  return {
    x: Math.max(0, contentWidth - SETTINGS_W),
    y: headerHeight,
    width: Math.min(SETTINGS_W, Math.max(1, contentWidth)),
    height: Math.max(1, contentHeight - headerHeight),
  }
}

export function computePopoverBounds(
  contentWidth: number,
  contentHeight: number,
  headerHeight: number,
): Bounds {
  return {
    x: 0,
    y: headerHeight,
    width: Math.max(1, contentWidth),
    height: contentHeight - headerHeight,
  }
}
