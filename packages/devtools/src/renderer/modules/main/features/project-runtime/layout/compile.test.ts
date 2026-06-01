import { describe, expect, it } from 'vitest'
import type {
  Frame,
  FrameChild,
  FrameColumn,
  FrameLeaf,
  FrameRow,
} from './types'
import { compileProjectWindowLayout, signatureOf } from './compile'
import type {
  DevtoolsPosition,
  LayoutState,
  SimulatorAlignment,
} from '../controllers/use-layout-store'

// ── Helpers ────────────────────────────────────────────────────────────

const ALL_POSITIONS: DevtoolsPosition[] = [
  'inEditor',
  'belowSimulator',
  'rightOfSimulator',
]
const ALL_ALIGNMENTS: SimulatorAlignment[] = ['left', 'right']

function allStates(): LayoutState[] {
  const out: LayoutState[] = []
  for (const devtoolsPosition of ALL_POSITIONS) {
    for (const simulatorAlignment of ALL_ALIGNMENTS) {
      for (let mask = 0; mask < 8; mask++) {
        out.push({
          devtoolsPosition,
          simulatorAlignment,
          simulatorVisible: Boolean(mask & 0b001),
          editorVisible: Boolean(mask & 0b010),
          debugVisible: Boolean(mask & 0b100),
        })
      }
    }
  }
  return out
}

function visibleCount(s: LayoutState): number {
  return (
    (s.simulatorVisible ? 1 : 0) +
    (s.editorVisible ? 1 : 0) +
    (s.debugVisible ? 1 : 0)
  )
}

/** Collect every leaf cellId reachable from the root. */
function collectLeafCells(frame: Frame): string[] {
  if (frame.kind === 'leaf') return [frame.cellId]
  return frame.children.flatMap((c) => collectLeafCells(c.frame))
}

/** Walk every container in the tree, asserting it has at least 2 children. */
function assertNoSingleChildContainers(frame: Frame): void {
  if (frame.kind === 'leaf') return
  expect(
    frame.children.length,
    `container ${frame.kind} should have ≥2 children (collapse pass should have dissolved single-child containers)`,
  ).toBeGreaterThanOrEqual(2)
  for (const child of frame.children) {
    assertNoSingleChildContainers(child.frame)
  }
}

function findFirstChild(
  frame: Frame,
  predicate: (c: FrameChild) => boolean,
): FrameChild | null {
  if (frame.kind === 'leaf') return null
  for (const child of frame.children) {
    if (predicate(child)) return child
    const inner = findFirstChild(child.frame, predicate)
    if (inner) return inner
  }
  return null
}

// ── 48-combination well-formedness ────────────────────────────────────

describe('compileProjectWindowLayout — 48 combinations are well-formed', () => {
  it.each(allStates())(
    'compile(devtoolsPosition=$devtoolsPosition, alignment=$simulatorAlignment, sim=$simulatorVisible, editor=$editorVisible, debug=$debugVisible) is well-formed',
    (state) => {
      const layout = compileProjectWindowLayout(state)

      // cells covers all 3 ids
      expect(Object.keys(layout.cells).sort()).toEqual([
        'debug',
        'editor',
        'simulator',
      ])

      const leafIds = collectLeafCells(layout.root)
      const visible = visibleCount(state)

      if (visible > 0) {
        // Normal flow: cells.present mirrors the LayoutState booleans.
        expect(layout.cells.simulator.present).toBe(state.simulatorVisible)
        expect(layout.cells.editor.present).toBe(state.editorVisible)
        expect(layout.cells.debug.present).toBe(state.debugVisible)
      }

      if (visible === 0) {
        // Compile fallback: defaults to a single editor leaf so the
        // window never renders an empty layout. The cells registry
        // MUST be consistent: editor.present=true so the leaf in the
        // frame matches what useViewAnchor expects (codex r7 #3).
        expect(layout.root.kind).toBe('leaf')
        expect(leafIds).toEqual(['editor'])
        expect(layout.cells.editor.present).toBe(true)
        expect(layout.cells.simulator.present).toBe(false)
        expect(layout.cells.debug.present).toBe(false)
      } else {
        // Every present cell appears exactly once as a leaf.
        for (const id of ['simulator', 'editor', 'debug'] as const) {
          const expected = layout.cells[id].present ? 1 : 0
          expect(
            leafIds.filter((x) => x === id).length,
            `cell ${id} should appear ${expected} time(s) in the frame`,
          ).toBe(expected)
        }
        // No present=false cell appears in the frame.
        for (const id of ['simulator', 'editor', 'debug'] as const) {
          if (!layout.cells[id].present) {
            expect(leafIds).not.toContain(id)
          }
        }
        // No single-child containers (collapse pass invariant).
        assertNoSingleChildContainers(layout.root)
      }

      // Signature is a non-empty string and deterministic.
      expect(typeof layout.signature).toBe('string')
      expect(layout.signature.length).toBeGreaterThan(0)
      expect(layout.signature).toBe(compileProjectWindowLayout(state).signature)
    },
  )
})

// ── Specific topology assertions per mode (all-visible) ───────────────

describe('compileProjectWindowLayout — base modes (all visible)', () => {
  function fullyVisible(
    devtoolsPosition: DevtoolsPosition,
    simulatorAlignment: SimulatorAlignment,
  ): LayoutState {
    return {
      devtoolsPosition,
      simulatorAlignment,
      simulatorVisible: true,
      editorVisible: true,
      debugVisible: true,
    }
  }

  it('inEditor / left = Row[ sim(fixed-px), Column[editor, debug] ]', () => {
    const { root } = compileProjectWindowLayout(fullyVisible('inEditor', 'left'))
    expect(root.kind).toBe('row')
    const row = root as FrameRow
    expect(row.children).toHaveLength(2)

    const sim = row.children[0]!
    expect(sim.outerSize.kind).toBe('fixed-px-with-splitter')
    if (sim.outerSize.kind === 'fixed-px-with-splitter') {
      expect(sim.outerSize.splitterSide).toBe('trailing')
    }
    expect((sim.frame as FrameLeaf).cellId).toBe('simulator')

    const right = row.children[1]!
    expect(right.outerSize.kind).toBe('flex')
    expect(right.frame.kind).toBe('column')
    const col = right.frame as FrameColumn
    expect((col.children[0]!.frame as FrameLeaf).cellId).toBe('editor')
    expect((col.children[1]!.frame as FrameLeaf).cellId).toBe('debug')
  })

  it('inEditor / right places sim child last and sets splitterSide=leading', () => {
    const { root } = compileProjectWindowLayout(fullyVisible('inEditor', 'right'))
    const row = root as FrameRow
    expect(row.children).toHaveLength(2)
    expect((row.children[1]!.frame as FrameLeaf).cellId).toBe('simulator')
    const sim = row.children[1]!
    expect(sim.outerSize.kind).toBe('fixed-px-with-splitter')
    if (sim.outerSize.kind === 'fixed-px-with-splitter') {
      expect(sim.outerSize.splitterSide).toBe('leading')
    }
  })

  it('belowSimulator / left = Row[ Column[sim, debug](fixed-px), editor(flex) ]', () => {
    const { root } = compileProjectWindowLayout(
      fullyVisible('belowSimulator', 'left'),
    )
    const row = root as FrameRow
    const leftSlot = row.children[0]!
    expect(leftSlot.outerSize.kind).toBe('fixed-px-with-splitter')
    expect(leftSlot.frame.kind).toBe('column')
    const inner = leftSlot.frame as FrameColumn
    expect((inner.children[0]!.frame as FrameLeaf).cellId).toBe('simulator')
    expect((inner.children[1]!.frame as FrameLeaf).cellId).toBe('debug')
    expect(inner.children[0]!.outerSize.kind).toBe('resizable')
    expect(inner.children[1]!.outerSize.kind).toBe('resizable')

    expect((row.children[1]!.frame as FrameLeaf).cellId).toBe('editor')
    expect(row.children[1]!.outerSize.kind).toBe('flex')
  })

  it('rightOfSimulator / left = Row[ sim(fixed-px), Row[debug, editor](flex) ]', () => {
    const { root } = compileProjectWindowLayout(
      fullyVisible('rightOfSimulator', 'left'),
    )
    const row = root as FrameRow
    expect((row.children[0]!.frame as FrameLeaf).cellId).toBe('simulator')
    expect(row.children[0]!.outerSize.kind).toBe('fixed-px-with-splitter')

    const inner = row.children[1]!
    expect(inner.outerSize.kind).toBe('flex')
    expect(inner.frame.kind).toBe('row')
    const innerRow = inner.frame as FrameRow
    expect((innerRow.children[0]!.frame as FrameLeaf).cellId).toBe('debug')
    expect((innerRow.children[1]!.frame as FrameLeaf).cellId).toBe('editor')
  })
})

// ── Collapse: outerSize inheritance ────────────────────────────────────

describe('compileProjectWindowLayout — collapse preserves seam outerSize', () => {
  it('belowSimulator + debug hidden keeps sim as fixed-px at the row seam', () => {
    const { root } = compileProjectWindowLayout({
      devtoolsPosition: 'belowSimulator',
      simulatorAlignment: 'left',
      simulatorVisible: true,
      editorVisible: true,
      debugVisible: false,
    })
    // Expected: Row[ sim leaf at slot 0 (fixed-px), editor leaf at slot 1 (flex) ]
    const row = root as FrameRow
    expect(row.kind).toBe('row')
    expect(row.children).toHaveLength(2)
    const sim = row.children[0]!
    expect((sim.frame as FrameLeaf).cellId).toBe('simulator')
    expect(sim.outerSize.kind).toBe('fixed-px-with-splitter')
    const editor = row.children[1]!
    expect((editor.frame as FrameLeaf).cellId).toBe('editor')
    expect(editor.outerSize.kind).toBe('flex')
  })

  it('inEditor + debug hidden keeps editor as the flex slot, no debug', () => {
    const { root } = compileProjectWindowLayout({
      devtoolsPosition: 'inEditor',
      simulatorAlignment: 'left',
      simulatorVisible: true,
      editorVisible: true,
      debugVisible: false,
    })
    // Expected: Row[ sim(fixed-px), editor(flex) ]
    const row = root as FrameRow
    expect(row.children).toHaveLength(2)
    expect((row.children[0]!.frame as FrameLeaf).cellId).toBe('simulator')
    expect((row.children[1]!.frame as FrameLeaf).cellId).toBe('editor')
    expect(row.children[1]!.outerSize.kind).toBe('flex')
  })

  it('inEditor + editor hidden keeps debug as the flex slot', () => {
    const { root } = compileProjectWindowLayout({
      devtoolsPosition: 'inEditor',
      simulatorAlignment: 'left',
      simulatorVisible: true,
      editorVisible: false,
      debugVisible: true,
    })
    // Inner Column collapses to debug leaf which inherits the row's flex slot.
    const row = root as FrameRow
    expect((row.children[0]!.frame as FrameLeaf).cellId).toBe('simulator')
    expect((row.children[1]!.frame as FrameLeaf).cellId).toBe('debug')
    expect(row.children[1]!.outerSize.kind).toBe('flex')
  })

  it('only sim visible (any mode) collapses root to a sim leaf', () => {
    for (const dp of ALL_POSITIONS) {
      for (const al of ALL_ALIGNMENTS) {
        const layout = compileProjectWindowLayout({
          devtoolsPosition: dp,
          simulatorAlignment: al,
          simulatorVisible: true,
          editorVisible: false,
          debugVisible: false,
        })
        expect(
          layout.root.kind,
          `${dp}/${al} sim-only should collapse root to a leaf`,
        ).toBe('leaf')
        expect((layout.root as FrameLeaf).cellId).toBe('simulator')
      }
    }
  })

  it('only editor visible (any mode) collapses root to an editor leaf', () => {
    for (const dp of ALL_POSITIONS) {
      const layout = compileProjectWindowLayout({
        devtoolsPosition: dp,
        simulatorAlignment: 'left',
        simulatorVisible: false,
        editorVisible: true,
        debugVisible: false,
      })
      expect(layout.root.kind).toBe('leaf')
      expect((layout.root as FrameLeaf).cellId).toBe('editor')
    }
  })

  it('only debug visible (any mode) collapses root to a debug leaf', () => {
    for (const dp of ALL_POSITIONS) {
      const layout = compileProjectWindowLayout({
        devtoolsPosition: dp,
        simulatorAlignment: 'left',
        simulatorVisible: false,
        editorVisible: false,
        debugVisible: true,
      })
      expect(layout.root.kind).toBe('leaf')
      expect((layout.root as FrameLeaf).cellId).toBe('debug')
    }
  })

  it('belowSimulator + sim hidden: no orphan fixed-px slot survives', () => {
    // When the simulator is hidden, the only justification for a
    // `fixed-px-with-splitter` slot (iPhone shell centering) disappears.
    // `demoteOrphanFixedPx` rewrites the slot to `flex`. We assert the
    // weaker "no orphan fixed-px" property — convergence with
    // rightOfSimulator is intentionally NOT structural equality because
    // the two modes still use different inner sizing strategies
    // (belowSimulator's leftover debug becomes a flex sibling; rightOf
    // keeps resizable defaults that happen to be visually similar).
    const layout = compileProjectWindowLayout({
      devtoolsPosition: 'belowSimulator',
      simulatorAlignment: 'left',
      simulatorVisible: false,
      editorVisible: true,
      debugVisible: true,
    })
    function walk(f: Frame): void {
      if (f.kind === 'leaf') return
      for (const child of f.children) {
        expect(child.outerSize.kind).not.toBe('fixed-px-with-splitter')
        walk(child.frame)
      }
    }
    walk(layout.root)
  })
})

// ── Alignment: compile-time ordering, not render-time reverse ────────

describe('compileProjectWindowLayout — alignment ordering', () => {
  it('inEditor: left vs right swaps the order of sim and rest children', () => {
    const leftR = compileProjectWindowLayout({
      devtoolsPosition: 'inEditor',
      simulatorAlignment: 'left',
      simulatorVisible: true,
      editorVisible: true,
      debugVisible: true,
    }).root as FrameRow
    const rightR = compileProjectWindowLayout({
      devtoolsPosition: 'inEditor',
      simulatorAlignment: 'right',
      simulatorVisible: true,
      editorVisible: true,
      debugVisible: true,
    }).root as FrameRow

    expect((leftR.children[0]!.frame as FrameLeaf).cellId).toBe('simulator')
    expect((rightR.children[1]!.frame as FrameLeaf).cellId).toBe('simulator')

    // splitterSide flips with alignment.
    expect(
      (leftR.children[0]!.outerSize as Extract<typeof leftR.children[0]['outerSize'], { kind: 'fixed-px-with-splitter' }>).splitterSide,
    ).toBe('trailing')
    expect(
      (rightR.children[1]!.outerSize as Extract<typeof rightR.children[1]['outerSize'], { kind: 'fixed-px-with-splitter' }>).splitterSide,
    ).toBe('leading')
  })
})

// ── belowSimulator keeps the simulator at a fixed column width ────────

describe('compileProjectWindowLayout — belowSimulator + editor hidden keeps sim fixed-px', () => {
  /** A child whose subtree contains the simulator leaf. */
  const isSimChild = (c: FrameChild): boolean =>
    collectLeafCells(c.frame).includes('simulator')
  /** A child whose subtree contains the debug leaf. */
  const isDebugChild = (c: FrameChild): boolean =>
    collectLeafCells(c.frame).includes('debug')

  const belowSimSimAndDebug = (
    simulatorAlignment: SimulatorAlignment,
  ): LayoutState => ({
    devtoolsPosition: 'belowSimulator',
    simulatorAlignment,
    simulatorVisible: true,
    editorVisible: false,
    debugVisible: true,
  })

  it('left: Row[ sim(fixed-px, trailing), debug(flex) ] — sim is not full-width', () => {
    const { root } = compileProjectWindowLayout(belowSimSimAndDebug('left'))
    expect(root.kind).toBe('row')
    const row = root as FrameRow
    expect(row.children).toHaveLength(2)

    // Locate the sim-bearing child by predicate, not index (index moves
    // with alignment). findFirstChild walks the tree.
    const sim = findFirstChild(row, isSimChild)
    expect(sim).not.toBeNull()
    expect(sim!.outerSize.kind).toBe('fixed-px-with-splitter')
    if (sim!.outerSize.kind === 'fixed-px-with-splitter') {
      expect(sim!.outerSize.splitterSide).toBe('trailing')
    }

    const debug = findFirstChild(row, isDebugChild)
    expect(debug).not.toBeNull()
    expect(debug!.outerSize.kind).toBe('flex')
  })

  it('right: sim child last (leading splitter), debug is the flex sibling', () => {
    const { root } = compileProjectWindowLayout(belowSimSimAndDebug('right'))
    expect(root.kind).toBe('row')
    const row = root as FrameRow
    expect(row.children).toHaveLength(2)

    // sim sits in the trailing slot when aligned right.
    expect(isSimChild(row.children[1]!)).toBe(true)

    const sim = findFirstChild(row, isSimChild)
    expect(sim).not.toBeNull()
    expect(sim!.outerSize.kind).toBe('fixed-px-with-splitter')
    if (sim!.outerSize.kind === 'fixed-px-with-splitter') {
      expect(sim!.outerSize.splitterSide).toBe('leading')
    }

    const debug = findFirstChild(row, isDebugChild)
    expect(debug).not.toBeNull()
    expect(debug!.outerSize.kind).toBe('flex')
  })

  it('convergence: sim+debug (editor hidden) yields fixed-px sim across all three devtoolsPositions', () => {
    // Same visible set (sim + debug, editor hidden). Whether devtools is
    // inEditor, belowSimulator, or rightOfSimulator, the simulator-bearing
    // slot must be fixed-px-with-splitter — belowSimulator is no longer the
    // odd one out (it previously collapsed to a full-width resizable column).
    for (const devtoolsPosition of ALL_POSITIONS) {
      const { root } = compileProjectWindowLayout({
        devtoolsPosition,
        simulatorAlignment: 'left',
        simulatorVisible: true,
        editorVisible: false,
        debugVisible: true,
      })
      const sim = findFirstChild(root, isSimChild)
      expect(
        sim,
        `${devtoolsPosition}: expected a simulator-bearing child slot`,
      ).not.toBeNull()
      expect(
        sim!.outerSize.kind,
        `${devtoolsPosition}: simulator slot should be fixed-px-with-splitter`,
      ).toBe('fixed-px-with-splitter')
    }
  })
})

// ── Signature ─────────────────────────────────────────────────────────

describe('compileProjectWindowLayout — signature', () => {
  it('is deterministic for the same state', () => {
    const s: LayoutState = {
      devtoolsPosition: 'inEditor',
      simulatorAlignment: 'left',
      simulatorVisible: true,
      editorVisible: true,
      debugVisible: true,
    }
    expect(compileProjectWindowLayout(s).signature).toBe(
      compileProjectWindowLayout(s).signature,
    )
  })

  it('differs for different topologies', () => {
    const states: LayoutState[] = [
      {
        devtoolsPosition: 'inEditor',
        simulatorAlignment: 'left',
        simulatorVisible: true,
        editorVisible: true,
        debugVisible: true,
      },
      {
        devtoolsPosition: 'belowSimulator',
        simulatorAlignment: 'left',
        simulatorVisible: true,
        editorVisible: true,
        debugVisible: true,
      },
      {
        devtoolsPosition: 'rightOfSimulator',
        simulatorAlignment: 'left',
        simulatorVisible: true,
        editorVisible: true,
        debugVisible: true,
      },
      {
        devtoolsPosition: 'inEditor',
        simulatorAlignment: 'right',
        simulatorVisible: true,
        editorVisible: true,
        debugVisible: true,
      },
    ]
    const sigs = new Set(states.map((s) => compileProjectWindowLayout(s).signature))
    expect(sigs.size).toBe(states.length)
  })

  it('changes when a cell toggles off', () => {
    const base: LayoutState = {
      devtoolsPosition: 'inEditor',
      simulatorAlignment: 'left',
      simulatorVisible: true,
      editorVisible: true,
      debugVisible: true,
    }
    const off = { ...base, debugVisible: false }
    expect(compileProjectWindowLayout(base).signature).not.toBe(
      compileProjectWindowLayout(off).signature,
    )
  })

  it('signatureOf is exported and matches the layout signature', () => {
    const layout = compileProjectWindowLayout({
      devtoolsPosition: 'inEditor',
      simulatorAlignment: 'left',
      simulatorVisible: true,
      editorVisible: true,
      debugVisible: true,
    })
    expect(signatureOf(layout.root)).toBe(layout.signature)
  })
})
