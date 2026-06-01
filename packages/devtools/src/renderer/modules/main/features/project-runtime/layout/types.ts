/**
 * ProjectWindowLayout — the compiled layout description that drives the
 * three-region project window (simulator / editor / debug).
 *
 * Design intent (vs the previous ad-hoc `LayoutTree` branches):
 *
 *   1. A single pure compile step turns `LayoutState` into a Frame tree +
 *      cells registry. All topology decisions live in the compile pass,
 *      not in the renderer. Adding a new `devtoolsPosition` is a compile
 *      branch; adding a new `CellId` is a registry entry. The renderer
 *      never reads `devtoolsPosition` or `simulatorAlignment` directly.
 *
 *   2. `Cell.present` is the single source of truth for "should the
 *      main-process overlay be attached?" — independent of whether the
 *      cell's placeholder div happens to be mounted. The bounds-sync hook
 *      reads cells, not DOM lifecycle.
 *
 *   3. Sizing is parent-edge: a `FrameChild.outerSize` describes how the
 *      parent (Row → width / Column → height) sizes that child along its
 *      primary axis. Sizing is not an intrinsic property of the child
 *      frame; it's the contract between parent and child at the seam.
 *
 *   4. Panel slot ids (`PanelSlotId`) are distinct from cell ids
 *      (`CellId`). A cell id names a business panel (simulator / editor /
 *      debug); a slot id names a position inside a resizable Group and
 *      is used as the react-resizable-panels `Panel id` attribute. Slot
 *      ids may be layout-position-aware (e.g. `below-sim-column`) — they
 *      are not pretending to be stable across topology changes.
 */

/** Business cell identifiers — three for now: simulator / editor / debug. */
export type CellId = 'simulator' | 'editor' | 'debug'

/** Per-cell registry entry. `present === true` ⇒ the cell appears as a
 *  leaf somewhere in the frame tree; `present === false` ⇒ the cell does
 *  not appear, and any associated overlay should be detached. */
export interface Cell {
  id: CellId
  present: boolean
}

export type Frame = FrameRow | FrameColumn | FrameLeaf

export interface FrameRow {
  kind: 'row'
  children: FrameChild[]
}

export interface FrameColumn {
  kind: 'column'
  children: FrameChild[]
}

export interface FrameLeaf {
  kind: 'leaf'
  cellId: CellId
}

/**
 * Child entry inside a `FrameRow` / `FrameColumn`. The `outerSize` is the
 * sizing contract with the parent (Row → width; Column → height); the
 * `slotId` is used by react-resizable-panels as the Panel id when this
 * child lives inside a resizable Group.
 */
export interface FrameChild {
  frame: Frame
  outerSize: OuterSize
  slotId: PanelSlotId
}

/**
 * Parent-edge sizing policies. The renderer dispatches on `kind`:
 *
 *  - `fixed-px-with-splitter` — the parent renders this child at a fixed
 *    pixel width (only valid as a `Row` child, since width is the row's
 *    primary axis). The width itself comes from external state
 *    (`simPanelWidth` is the only key supported in v1). Drag direction
 *    inversion is encoded in `splitterSide`: `trailing` ⇒ splitter on the
 *    child's right edge, drag delta has positive sign; `leading` ⇒
 *    splitter on the child's left edge, drag delta is inverted.
 *
 *  - `flex` — the parent renders this child as `flex: 1 1 0`, occupying
 *    the remaining space on its primary axis. There can be more than one
 *    flex child in a group (they share remaining space equally), though
 *    in practice the compile output emits at most one per group.
 *
 *  - `resizable` — the parent renders this child inside a
 *    `react-resizable-panels` Group as a `<Panel>` with the given default
 *    and minimum sizes (the library's percentage units).
 */
export type OuterSize =
  | {
      kind: 'fixed-px-with-splitter'
      key: 'simPanelWidth'
      splitterSide: 'leading' | 'trailing'
    }
  | { kind: 'flex' }
  | { kind: 'resizable'; defaultSize: number; minSize: number }

/** Slot identifier — used as react-resizable-panels Panel id. Stable for
 *  the duration of one compile output, may differ across compile outputs.
 *  See `compile.ts` for the slot id convention. */
export type PanelSlotId = string

/**
 * Compiled layout description. The renderer consumes only this; it never
 * looks at the underlying `LayoutState`.
 *
 * - `root` is the top-level frame to render. When fully collapsed (only
 *   one cell visible) it may be a `FrameLeaf` directly.
 * - `cells` is the registry of all `CellId`s with their present flag,
 *   regardless of whether they appear in the tree. The bounds-sync hook
 *   reads this to decide whether to publish zero bounds.
 * - `signature` is a stable, deterministic serialization of the frame
 *   tree topology. It excludes data that affects rendered pixels without
 *   changing topology (`simPanelWidth`, `rightPane.selected`, etc.) —
 *   those are propagated through other channels.
 *
 *   Two `LayoutState`s that compile to the same frame tree have the same
 *   signature; conversely a signature change ⇒ topology change.
 *
 *   The signature is intended for use as a React effect dependency (e.g.
 *   to force `useViewAnchor` to re-emit after a topology flip). Do not
 *   rely on it for diffing — it is opaque.
 */
export interface ProjectWindowLayout {
  root: Frame
  cells: Record<CellId, Cell>
  signature: string
}
