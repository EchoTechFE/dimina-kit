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

/**
 * NATIVE-HOST ONLY. Translate the renderer-measured simulator panel REGION rect
 * (CSS px from the main window content top-left — the flex:1 placeholder slot)
 * into the params needed to overlay the simulator `WebContentsView` on it.
 *
 * The renderer reports `getBoundingClientRect()` of the panel region. Because
 * the simulator is a top-level overlay WebContentsView (not a nested guest),
 * that CSS-px rect maps directly to `setBounds` DIP — no conversion. We just
 * round to integers (setBounds rejects fractionals) and clamp width/height
 * non-negative. The WCV fills the region as a plain rectangle (no native border
 * radius); DeviceShell draws the rounded phone and scrolls it inside. `zoomFactor`
 * feeds `webContents.setZoomFactor`.
 */
export function computeNativeSimulatorViewParams(
  rect: { x: number; y: number; width: number; height: number },
  zoomPercent: number,
): { bounds: Bounds; zoomFactor: number } {
  const zoomFactor = zoomPercent / 100
  return {
    bounds: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.max(0, Math.round(rect.width)),
      height: Math.max(0, Math.round(rect.height)),
    },
    zoomFactor,
  }
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
