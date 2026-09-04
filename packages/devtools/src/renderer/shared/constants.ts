export const ZOOM_OPTIONS = [100, 85, 75, 50] as const

/** Sentinel selection for the simulator's auto-fit zoom mode. */
export const AUTO_ZOOM = 'auto' as const

/** The simulator zoom dropdown's value: a fixed percent, or auto-fit. */
export type ZoomSetting = typeof ZOOM_OPTIONS[number] | typeof AUTO_ZOOM

// Fixed toolbar header height — re-exported from the cross-process shared
// module so main (view layout) and renderer (toolbar/popover) can't drift.
export { HEADER_H } from '../../shared/constants'
// Fixed host-sidebar default-content width — re-exported so the rail
// component and main (which no longer pins width mode) share one value.
export { HOST_SIDEBAR_DEFAULT_WIDTH } from '../../shared/constants'
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
