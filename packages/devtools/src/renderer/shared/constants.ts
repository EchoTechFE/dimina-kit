/**
 * Device presets for simulator preview.
 *
 * `safeAreaInsets` is the canonical per-device safe area (portrait); its `top`
 * doubles as the status-bar height (`statusBarHeight` kept for back-compat).
 * `notchType` drives the bezel cutout visual — 'notch' for the X–13 family,
 * 'dynamic-island' for 14 Pro and newer, 'none' for the home-button SE class.
 */
export const DEVICES = [
  { name: 'iPhone SE', width: 375, height: 667, pixelRatio: 2, statusBarHeight: 20, system: 'iOS 15.0', safeAreaBottom: 0, notchType: 'none', safeAreaInsets: { top: 20, right: 0, bottom: 0, left: 0 } },
  { name: 'iPhone X', width: 375, height: 812, pixelRatio: 3, statusBarHeight: 44, system: 'iOS 16.0', safeAreaBottom: 34, notchType: 'notch', safeAreaInsets: { top: 44, right: 0, bottom: 34, left: 0 } },
  { name: 'iPhone 14', width: 390, height: 844, pixelRatio: 3, statusBarHeight: 47, system: 'iOS 16.0', safeAreaBottom: 34, notchType: 'notch', safeAreaInsets: { top: 47, right: 0, bottom: 34, left: 0 } },
  { name: 'iPhone 14 Pro', width: 393, height: 852, pixelRatio: 3, statusBarHeight: 54, system: 'iOS 16.3', safeAreaBottom: 34, notchType: 'dynamic-island', safeAreaInsets: { top: 54, right: 0, bottom: 34, left: 0 } },
  { name: 'iPhone 16 Pro', width: 402, height: 874, pixelRatio: 3, statusBarHeight: 59, system: 'iOS 18.0', safeAreaBottom: 34, notchType: 'dynamic-island', safeAreaInsets: { top: 59, right: 0, bottom: 34, left: 0 } },
  { name: 'iPhone 17 Pro', width: 402, height: 874, pixelRatio: 3, statusBarHeight: 59, system: 'iOS 19.0', safeAreaBottom: 34, notchType: 'dynamic-island', safeAreaInsets: { top: 59, right: 0, bottom: 34, left: 0 } },
] as const

export const ZOOM_OPTIONS = [25, 50, 75, 100] as const

export const HEADER_H = 40
export const SIM_PANEL_PADDING = 24

/** Timeout for save/action feedback messages. */
export const FEEDBACK_TIMEOUT_MS = 2000

/** Timeout for copy-to-clipboard feedback. */
export const COPY_FEEDBACK_TIMEOUT_MS = 1500

/** Minimum width for the simulator or workbench panel (px). */
export const MIN_PANEL_WIDTH_PX = 200

/** Vertical offset for popover positioning relative to trigger element (px). */
export const POPOVER_OFFSET_PX = 6

/** Width of the compile config popover (px). */
export const POPOVER_WIDTH_PX = 340

/** Margin to keep popover within viewport (px). */
export const POPOVER_MARGIN_PX = 8
