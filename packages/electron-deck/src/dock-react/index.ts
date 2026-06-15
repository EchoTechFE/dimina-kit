/**
 * dock-react public entry.
 *
 * `<DockView>` renders a docking layout from a `LayoutModel` (observable) +
 * `PanelRegistry` (panelId -> descriptor). See `dock-view.test.tsx` for the
 * `data-*` contract.
 */
export { DockView, computeFlexiblePercentages } from './dock-view.js'
export type { DockViewProps } from './dock-view.js'

// Pure drag-to-redock geometry + descriptor layer (no react/electron import),
// surfaced from the react entry so a host can reach it without a deep import.
export { computeDropZone, dropZoneToMutation, isNoopRedock } from './drag-redock.js'
export type { DropZone, RedockMutation } from './drag-redock.js'
