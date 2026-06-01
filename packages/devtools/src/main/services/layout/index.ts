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
 * NATIVE-HOST ONLY. Bounds for the simulator CONTENT view (the DeviceShell
 * host WebContentsView) — the region LEFT of the splitter, below the header.
 *
 * PART-2 TODO (layout fidelity): this fills the whole simulator-panel column.
 * It does NOT yet reproduce the renderer `<webview>` chrome — the device bezel
 * / rounded corners (44px radius shell), the device-select + zoom toolbar
 * (~40px tall, top), the current-page footer (~30px tall, bottom), centering
 * inside an `overflow:auto` area, or `setZoomFactor` scaling. The view is
 * positioned roughly so nested render webviews attach + render; exact pixel
 * fidelity (bezel, zoom, scroll, splitter-drag) is deferred to Part 2.
 */
export function computeNativeSimulatorBounds(
  contentWidth: number,
  contentHeight: number,
  simWidth: number,
  headerHeight: number
): Bounds {
  return {
    x: 0,
    y: headerHeight,
    width: Math.max(1, Math.min(simWidth, contentWidth)),
    height: Math.max(1, contentHeight - headerHeight),
  }
}

/**
 * Inner-screen corner radius (px) of the device bezel at 100% zoom — mirrors
 * the renderer `borderRadius: 36` on the black inner screen div in
 * `simulator-panel.tsx`. Scaled by the zoom factor in
 * `computeNativeSimulatorViewParams` so the WebContentsView corners stay flush
 * with the scaled bezel.
 */
export const INNER_SCREEN_RADIUS = 36

/**
 * NATIVE-HOST ONLY. Translate a renderer-measured inner-screen rect (CSS px
 * from the main window content top-left) into the params needed to overlay the
 * simulator `WebContentsView` on it.
 *
 * The renderer reports `getBoundingClientRect()` of the bezel's inner black
 * screen div. Because the simulator is a top-level overlay WebContentsView (not
 * a nested guest), that CSS-px rect maps directly to `setBounds` DIP — no
 * conversion. We just round to integers (setBounds rejects fractionals) and
 * clamp width/height non-negative. `zoomFactor` feeds
 * `webContents.setZoomFactor`; `borderRadius` scales with zoom so the rounded
 * corners line up with the scaled bezel.
 */
export function computeNativeSimulatorViewParams(
  rect: { x: number; y: number; width: number; height: number },
  zoomPercent: number,
): { bounds: Bounds; borderRadius: number; zoomFactor: number } {
  const zoomFactor = zoomPercent / 100
  return {
    bounds: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.max(0, Math.round(rect.width)),
      height: Math.max(0, Math.round(rect.height)),
    },
    borderRadius: Math.max(0, Math.round(INNER_SCREEN_RADIUS * zoomFactor)),
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
