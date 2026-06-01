import type { LayoutState } from '../controllers/use-layout-store'
import type {
  Cell,
  CellId,
  Frame,
  FrameChild,
  FrameColumn,
  FrameLeaf,
  FrameRow,
  OuterSize,
  ProjectWindowLayout,
} from './types'

/**
 * Pure compile pass that turns `LayoutState` into a `ProjectWindowLayout`.
 *
 * The shape is built in three steps:
 *
 *   1. `buildModeFrame(state)` — pick one of the six base frames (3
 *      `devtoolsPosition` × 2 `simulatorAlignment`) assuming all three
 *      cells are visible. This is the only place where the renderer's
 *      "physical layout" decisions are encoded.
 *
 *   2. `collapseInvisibleCells(frame, cells)` — generic recursive pass
 *      that prunes leaves whose cell `present === false`, drops empty
 *      containers, and dissolves single-child containers (promoting the
 *      surviving child while inheriting the dissolved container's
 *      `outerSize`). This keeps mode-specific logic out of visibility
 *      handling.
 *
 *   3. `collapseRoot(...)` — if the root becomes a single leaf or a
 *      single-child container, promote its `outerSize` to `flex` so it
 *      fills the window. Without this, a leftover `fixed-px-with-splitter`
 *      sim column would render at a fixed width with empty space beside
 *      it (the dead-zone bug class).
 *
 * Slot id convention:
 *   - Leaf children use their `cellId` as `slotId` (`'simulator'`,
 *     `'editor'`, `'debug'`).
 *   - Container children use a composite slot id that names the parent
 *     context (e.g. `'in-editor-column'`, `'below-sim-column'`,
 *     `'right-of-sim-row'`).
 *   This makes `Panel id` collisions impossible within one compile output
 *   and makes mode transitions explicit (different mode ⇒ different slot
 *   ids ⇒ different Group key ⇒ fresh `defaultSize` applied).
 */
export function compileProjectWindowLayout(
  state: LayoutState,
): ProjectWindowLayout {
  const cells: Record<CellId, Cell> = {
    simulator: { id: 'simulator', present: state.simulatorVisible },
    editor: { id: 'editor', present: state.editorVisible },
    debug: { id: 'debug', present: state.debugVisible },
  }

  // Defensive fallback: the store's `load()` already sanitizes "all
  // false" to DEFAULT_LAYOUT_STATE before reaching here, but compile() is
  // a pure function that anyone could call. If the caller hands us a
  // state with no visible cell, fall back to a single editor leaf so the
  // window doesn't render an empty `flex` row.
  //
  // Critically, mark `editor.present = true` in the cells registry to
  // match the fallback frame — the collapse helpers (`collapseInvisibleCells`
  // / `leafOfFirstPresent`) key off `cells[id].present`, so a registry that
  // disagrees with the rendered frame would mis-collapse the layout
  // (codex round-7 #3, internal consistency). The editor is a plain
  // in-renderer <MonacoEditor/> with no overlay/bounds, so this flag only
  // affects layout topology, nothing in the main process.
  if (
    !state.simulatorVisible &&
    !state.editorVisible &&
    !state.debugVisible
  ) {
    const fallback: FrameLeaf = { kind: 'leaf', cellId: 'editor' }
    return {
      root: fallback,
      cells: {
        simulator: { id: 'simulator', present: false },
        editor: { id: 'editor', present: true },
        debug: { id: 'debug', present: false },
      },
      signature: signatureOf(fallback),
    }
  }

  const base = buildModeFrame(state)
  const collapsed = collapseInvisibleCells(base, cells) ?? leafOfFirstPresent(cells)
  const demoted = demoteOrphanFixedPx(collapsed)
  const root = collapseRoot(demoted)
  return {
    root,
    cells,
    signature: signatureOf(root),
  }
}

// ── Base frame construction (assumes all three cells visible) ─────────

function buildModeFrame(state: LayoutState): Frame {
  const sim: FrameLeaf = { kind: 'leaf', cellId: 'simulator' }
  const editor: FrameLeaf = { kind: 'leaf', cellId: 'editor' }
  const debug: FrameLeaf = { kind: 'leaf', cellId: 'debug' }

  const simChild = (): FrameChild => ({
    frame: sim,
    outerSize: simFixedPx(state.simulatorAlignment),
    slotId: 'simulator',
  })

  if (state.devtoolsPosition === 'inEditor') {
    // Row[ sim(fixed-px) , Column[ editor(resizable), debug(resizable) ](flex) ]
    const editorDebugColumn: FrameColumn = {
      kind: 'column',
      children: [
        { frame: editor, outerSize: resizable(70, 20), slotId: 'editor' },
        { frame: debug, outerSize: resizable(30, 10), slotId: 'debug' },
      ],
    }
    const rightSide: FrameChild = {
      frame: editorDebugColumn,
      outerSize: flex(),
      slotId: 'in-editor-column',
    }
    return alignedRow(simChild(), rightSide, state.simulatorAlignment)
  }

  if (state.devtoolsPosition === 'belowSimulator') {
    // Row[ Column[ sim(resizable), debug(resizable) ](fixed-px) , editor(flex) ]
    const simDebugColumn: FrameColumn = {
      kind: 'column',
      children: [
        { frame: sim, outerSize: resizable(70, 20), slotId: 'below-sim-top' },
        {
          frame: debug,
          outerSize: resizable(30, 10),
          slotId: 'below-sim-bottom',
        },
      ],
    }
    const leftSide: FrameChild = {
      frame: simDebugColumn,
      outerSize: simFixedPx(state.simulatorAlignment),
      slotId: 'below-sim-column',
    }
    const rightSide: FrameChild = {
      frame: editor,
      outerSize: flex(),
      slotId: 'editor',
    }
    return alignedRow(leftSide, rightSide, state.simulatorAlignment)
  }

  // rightOfSimulator
  // Row[ sim(fixed-px) , Row[ debug(resizable), editor(resizable) ](flex) ]
  const debugEditorRow: FrameRow = {
    kind: 'row',
    children: [
      { frame: debug, outerSize: resizable(40, 15), slotId: 'debug' },
      { frame: editor, outerSize: resizable(60, 20), slotId: 'editor' },
    ],
  }
  const rightSide: FrameChild = {
    frame: debugEditorRow,
    outerSize: flex(),
    slotId: 'right-of-sim-row',
  }
  return alignedRow(simChild(), rightSide, state.simulatorAlignment)
}

/**
 * Compose a top-level row from the "sim side" and the "rest side". When
 * `alignment === 'right'` the sim child appears as the row's last child;
 * we **rebuild the children array in compile** rather than reversing at
 * render time so that downstream collapse logic sees the final order.
 */
function alignedRow(
  simSide: FrameChild,
  restSide: FrameChild,
  alignment: 'left' | 'right',
): FrameRow {
  if (alignment === 'left') {
    return { kind: 'row', children: [simSide, restSide] }
  }
  return { kind: 'row', children: [restSide, simSide] }
}

function simFixedPx(alignment: 'left' | 'right'): OuterSize {
  return {
    kind: 'fixed-px-with-splitter',
    key: 'simPanelWidth',
    splitterSide: alignment === 'left' ? 'trailing' : 'leading',
  }
}

function resizable(defaultSize: number, minSize: number): OuterSize {
  return { kind: 'resizable', defaultSize, minSize }
}

function flex(): OuterSize {
  return { kind: 'flex' }
}

// ── Collapse pass ──────────────────────────────────────────────────────

/**
 * Returns the rewritten frame, or null if the entire subtree should be
 * pruned (leaf with `present=false`, or container whose every child was
 * pruned).
 *
 * Single-child containers dissolve: the surviving child replaces the
 * container in the parent's children list. The parent's slot keeps its
 * own `outerSize` — the container's inner sizing is irrelevant once it
 * dissolves.
 *
 * Worked example: `belowSimulator + debug hidden`:
 *   `Row[ Column(slot=fixed-px)[sim(resizable), debug(resizable)], editor(flex) ]`
 *   →  in the Column, debug prunes, sim survives.
 *   →  Column dissolves, sim leaf replaces it in the Row.
 *   →  Row's child 0 slot still has outerSize=fixed-px (from build),
 *      sim leaf inherits that slot.
 *   Result: `Row[ sim(slot=fixed-px), editor(flex) ]`. sim keeps its
 *   fixed-px column width — codex #4 fix.
 */
function collapseInvisibleCells(
  frame: Frame,
  cells: Record<CellId, Cell>,
): Frame | null {
  if (frame.kind === 'leaf') {
    return cells[frame.cellId].present ? frame : null
  }

  const survivors: FrameChild[] = []
  for (const child of frame.children) {
    const sub = collapseInvisibleCells(child.frame, cells)
    if (sub === null) continue
    // Parent slot keeps its own outerSize. Container dissolution inside
    // `sub` doesn't propagate sizing — the seam is owned by `this`
    // container, not by the dissolved descendant.
    survivors.push({
      frame: sub,
      outerSize: child.outerSize,
      slotId: child.slotId,
    })
  }

  if (survivors.length === 0) return null
  if (survivors.length === 1) {
    const sole = survivors[0]!
    // Special case: the sole survivor's slot carries the simulator's
    // fixed-px-with-splitter contract AND its subtree still bundles the
    // simulator with at least one sibling (e.g. belowSimulator with the
    // editor hidden: the Row dissolves onto `Column[sim, debug]`).
    //
    // A naive dissolve here drops `sole.outerSize` (the fixed-px contract
    // lives on the dissolving Row slot, not on the sim leaf inside the
    // column), so the surviving simulator would render full-width — the
    // belowSimulator dead-zone bug. Instead, hoist the simulator leaf out
    // and rebuild a 2-child Row[ sim(fixed-px), rest(flex) ], reusing the
    // same alignment encoding (splitterSide) the build step emitted. This
    // converges belowSimulator with inEditor / rightOfSimulator, whose sim
    // slot is already fixed-px at the row seam.
    if (
      sole.outerSize.kind === 'fixed-px-with-splitter' &&
      sole.frame.kind !== 'leaf' &&
      subtreeHasSimulator(sole.frame)
    ) {
      const rest = removeSimulatorLeaf(sole.frame)
      if (rest !== null) {
        const alignment =
          sole.outerSize.splitterSide === 'trailing' ? 'left' : 'right'
        const simSide: FrameChild = {
          frame: { kind: 'leaf', cellId: 'simulator' },
          outerSize: sole.outerSize,
          slotId: 'simulator',
        }
        const restSide: FrameChild = {
          frame: rest,
          outerSize: flex(),
          slotId: sole.slotId,
        }
        return alignedRow(simSide, restSide, alignment)
      }
    }
    // Container dissolves into its sole surviving child. The parent (one
    // level up) will keep its own slot's outerSize for this child.
    return sole.frame
  }
  return { ...frame, children: survivors }
}

/**
 * Returns `frame` with the simulator leaf pruned out, dissolving any
 * single-child container left behind (mirrors `collapseInvisibleCells`'s
 * dissolve rule). Returns null if the simulator was the only leaf.
 *
 * Used by `collapseInvisibleCells` to split a dissolving fixed-px
 * sim-bearing container into its `sim` leaf and the `rest` subtree.
 */
function removeSimulatorLeaf(frame: Frame): Frame | null {
  if (frame.kind === 'leaf') {
    return frame.cellId === 'simulator' ? null : frame
  }
  const survivors: FrameChild[] = []
  for (const child of frame.children) {
    const sub = removeSimulatorLeaf(child.frame)
    if (sub === null) continue
    survivors.push({ frame: sub, outerSize: child.outerSize, slotId: child.slotId })
  }
  if (survivors.length === 0) return null
  if (survivors.length === 1) return survivors[0]!.frame
  return { ...frame, children: survivors }
}

/**
 * When the entire layout collapsed to a single cell (or to a single
 * container whose root child is the only thing visible), the leftover
 * `outerSize` from the original construction can be `fixed-px` (e.g. sim
 * column at 375px while the rest is empty). Promote the root to flex so
 * it fills the window.
 *
 * We don't track outerSize on the root in `Frame` itself (root has no
 * parent seam to size against), but the dead-zone bug arises in the
 * renderer if a frame is rendered inside a "this row has a fixed-px
 * child" branch. So `collapseRoot` works at the frame level: if the
 * top-level frame is a Row whose only `survivor` (after collapse) is a
 * fixed-px child, unwrap the row entirely.
 *
 * The actual implementation here is simpler than that: after collapse,
 * if root is `FrameLeaf` or `FrameColumn`, we leave it alone (the
 * renderer fills the parent). If root is a `FrameRow` with one child,
 * we unwrap to that child. The single-child case is already caught by
 * `collapseInternal` for non-root nodes, but root needs the same
 * treatment.
 */
function collapseRoot(root: Frame): Frame {
  if (root.kind === 'leaf') return root
  if (root.children.length === 1) {
    return collapseRoot(root.children[0]!.frame)
  }
  return root
}

/**
 * After collapse, a child slot may still hold `fixed-px-with-splitter`
 * outerSize while the surviving leaf inside it is no longer a simulator
 * cell. The fixed-px policy exists for one reason: the iPhone shell
 * inside `SimulatorPanel` needs a stable column width that
 * react-resizable-panels can't override. With the simulator gone, that
 * reason is gone too — the slot should behave like `flex` so the
 * surviving leaf can fill the parent row.
 *
 * This pass walks the frame and demotes any `fixed-px-with-splitter`
 * child slot whose subtree does not contain a `simulator` leaf to
 * `flex`. It is the "sim-column reason-of-existence" check, encoded.
 */
function demoteOrphanFixedPx(frame: Frame): Frame {
  if (frame.kind === 'leaf') return frame
  const children = frame.children.map((c) => {
    const demotedChild = demoteOrphanFixedPx(c.frame)
    const needsDemote =
      c.outerSize.kind === 'fixed-px-with-splitter' &&
      !subtreeHasSimulator(demotedChild)
    return {
      frame: demotedChild,
      outerSize: needsDemote ? ({ kind: 'flex' } as OuterSize) : c.outerSize,
      slotId: c.slotId,
    }
  })
  return { ...frame, children }
}

function subtreeHasSimulator(frame: Frame): boolean {
  if (frame.kind === 'leaf') return frame.cellId === 'simulator'
  return frame.children.some((c) => subtreeHasSimulator(c.frame))
}

function leafOfFirstPresent(cells: Record<CellId, Cell>): FrameLeaf {
  // Fallback: collapse pruned the whole tree (shouldn't happen given
  // input invariants, but defensive). Pick the first present cell.
  const order: CellId[] = ['simulator', 'editor', 'debug']
  for (const id of order) {
    if (cells[id].present) return { kind: 'leaf', cellId: id }
  }
  // Truly nothing visible — pick editor (the function entry already
  // handled this branch, but TS doesn't know).
  return { kind: 'leaf', cellId: 'editor' }
}

// ── Signature ─────────────────────────────────────────────────────────

/**
 * Stable serialization of the frame topology. Used as a React effect
 * dependency for the bounds-sync hook to force re-emit on topology
 * change. Does NOT include `simPanelWidth`, `rightPane.selected`, device
 * dims, or `projectPath` — those are surfaced through other channels
 * (`useViewAnchor` deps / explicit projectPath arg / ResizeObserver
 * picking up DOM rect changes).
 */
export function signatureOf(frame: Frame): string {
  if (frame.kind === 'leaf') return `L:${frame.cellId}`
  const inner = frame.children
    .map((c) => `${outerSigOf(c.outerSize)}:${c.slotId}(${signatureOf(c.frame)})`)
    .join('|')
  return `${frame.kind[0]}[${inner}]`
}

function outerSigOf(o: OuterSize): string {
  if (o.kind === 'flex') return 'F'
  if (o.kind === 'fixed-px-with-splitter') return `P:${o.splitterSide[0]}`
  return `R:${o.defaultSize}:${o.minSize}`
}
