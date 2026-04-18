/** Layout constants (px) */
export let HEADER_H = 40
export const SPLITTER_W = 4

/**
 * Override the header height used for layout calculations.
 * Call this before any views are positioned (e.g. in onSetup).
 */
export function setHeaderHeight(h: number): void {
  HEADER_H = h
}

/**
 * X coordinate where the right panel starts (simulator width + splitter).
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
  simWidth: number
): Bounds {
  const x = getRightX(simWidth)
  return {
    x,
    y: HEADER_H,
    width: Math.max(1, contentWidth - x),
    height: Math.max(1, contentHeight - HEADER_H),
  }
}

/**
 * Compute bounds for DevTools view (same as right panel, overlays it).
 */
export function computeSimulatorBounds(
  contentWidth: number,
  contentHeight: number,
  simWidth: number
): Bounds {
  return computeRightPanelBounds(contentWidth, contentHeight, simWidth)
}

export const SETTINGS_W = 320

export function computeSettingsBounds(
  contentWidth: number,
  contentHeight: number
): Bounds {
  return {
    x: Math.max(0, contentWidth - SETTINGS_W),
    y: HEADER_H,
    width: SETTINGS_W,
    height: Math.max(1, contentHeight - HEADER_H),
  }
}

export function computePopoverBounds(
  contentWidth: number,
  contentHeight: number
): Bounds {
  return {
    x: 0,
    y: HEADER_H,
    width: contentWidth,
    height: contentHeight - HEADER_H,
  }
}
