export interface Bounds {
  x: number
  y: number
  width: number
  height: number
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

/** Renderer-side width of the settings PANEL (the opaque right strip). The
 * settings WebContentsView itself spans the full content area (see
 * `computeSettingsBounds`) as a transparent backdrop; the panel is positioned
 * inside it at this width by `settings.tsx`. */
export const SETTINGS_W = 320

/**
 * The settings overlay is a FULL-content-area transparent backdrop (header
 * excluded), identical to the popover region — NOT a right-edge strip. The
 * renderer paints a transparent backdrop over the whole area and an opaque
 * `SETTINGS_W`-wide panel on the right; a click on the transparent backdrop
 * closes the overlay (clicks outside the panel must reach the backdrop, which is
 * only possible when the view spans the whole area rather than just the strip).
 */
export function computeSettingsBounds(
  contentWidth: number,
  contentHeight: number,
  headerHeight: number,
): Bounds {
  return {
    x: 0,
    y: headerHeight,
    width: Math.max(1, contentWidth),
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
