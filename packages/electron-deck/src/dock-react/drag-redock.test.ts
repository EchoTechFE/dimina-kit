/**
 * FAILING TDD spec for the NOT-YET-WRITTEN drag-to-redock geometry layer.
 *
 * The implementer reads THIS file as the contract for the pure module
 * `./drag-redock` (re-exported from `./index`). This module is PURE TS — it must
 * NOT import react/electron, so it can run under the node `vitest.config.ts`
 * suite (this file is `*.test.ts`). We import it DIRECTLY from `./drag-redock.js`
 * (not via `./index.js`, which re-exports the react `<DockView>` and would pull
 * react into the node suite). The react-side re-export from `./index` is asserted
 * in the jsdom Layer-2 spec instead.
 *
 * ─────────────────────────── locked contract ───────────────────────────
 *
 * type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center'
 *
 * computeDropZone(
 *   rect: { width: number; height: number },
 *   point: { x: number; y: number },   // RELATIVE to rect top-left; (0,0) = corner
 *   edgeFraction = 0.25,
 * ): DropZone
 *
 *   - band thickness = edgeFraction * min(width, height).
 *   - left band   : x <  band
 *     right band  : x >  width  - band
 *     top band    : y <  band
 *     bottom band : y >  height - band
 *     interior (in no band)              => 'center'
 *   - CORNER (two bands overlap) tie-break: pick the edge with the SMALLER
 *     NORMALIZED distance, where
 *         dLeft = x / width,   dRight = (width - x) / width,
 *         dTop  = y / height,  dBottom = (height - y) / height.
 *     The smallest of the ACTIVE-band distances wins. On an exact tie,
 *     HORIZONTAL (left/right) beats VERTICAL (top/bottom). (left vs right and
 *     top vs bottom cannot both be active simultaneously for a sane rect.)
 *   - OUT-OF-RECT clamp: a point outside the rect clamps to the nearest edge
 *     zone. x < 0 => 'left'; x > width => 'right'; y < 0 => 'top';
 *     y > height => 'bottom'. If out on BOTH axes (a diagonal corner outside),
 *     compare the per-axis overshoot magnitudes; the axis with the LARGER
 *     overshoot wins, HORIZONTAL breaking an exact tie.
 *
 * type RedockMutation =
 *   | { kind: 'move';  panelId: string; destGroupId: string }
 *   | { kind: 'split'; atPanelId: string; dir: 'row' | 'column';
 *       side: 'before' | 'after'; newPanelId: string }
 *
 * dropZoneToMutation(
 *   zone: DropZone,
 *   dragged: string,                                   // the dragged panelId
 *   target: { groupId: string; panelId: string },      // panel/group under pointer
 * ): RedockMutation
 *
 *   center => { kind:'move',  panelId: dragged,        destGroupId: target.groupId }
 *   left   => { kind:'split', atPanelId: target.panelId, dir:'row',    side:'before', newPanelId: dragged }
 *   right  => { kind:'split', atPanelId: target.panelId, dir:'row',    side:'after',  newPanelId: dragged }
 *   top    => { kind:'split', atPanelId: target.panelId, dir:'column', side:'before', newPanelId: dragged }
 *   bottom => { kind:'split', atPanelId: target.panelId, dir:'column', side:'after',  newPanelId: dragged }
 *
 * isNoopRedock(dragged, target, zone): boolean
 *   true IFF zone === 'center' AND dragged === target.panelId
 *   (dropping a panel onto its OWN tab, center of its own group => no-op).
 *
 * APPLYING the descriptor against a real tree (the caller's job, exercised here):
 *   - 'move'  => movePanel(t, panelId, { groupId: destGroupId })
 *   - split   => because splitPanel throws if newPanelId already exists, an
 *     EXISTING dragged panel must be extractPanel'd FIRST, then splitPanel'd:
 *       extractPanel(t, dragged) -> splitPanel(t', atPanelId, dir, dragged, side)
 *     The descriptor only NAMES the intent; these tests prove that the
 *     extract-then-split sequence lands the dragged panel adjacent to the target
 *     in the right orientation/side and that it appears EXACTLY ONCE.
 *
 * These tests MUST fail right now with "cannot find module ./drag-redock"
 * (the module does not exist yet). They must NOT fail from test-infra issues.
 */
import { describe, it, expect } from 'vitest'
import {
	createLayoutModel,
	extractPanel,
	movePanel,
	splitPanel,
	type LayoutNode,
	type LayoutTree,
	type SplitNode,
	type TabGroupNode,
} from '../layout/index.js'

// Honest point of failure: the pure module does not exist yet.
import {
	computeDropZone,
	// FAILING: `computeReorderIndex` is not yet exported from the pure module.
	computeReorderIndex,
	dropZoneToMutation,
	isNoopRedock,
	type DropZone,
	type RedockMutation,
} from './drag-redock.js'

// ───────────────────────── tree helpers ─────────────────────────

/** root split[row] -> [ g-left(a) | g-right(b,c) ] */
function makeTree(): LayoutTree {
	return {
		version: 1,
		root: {
			kind: 'split',
			id: 'root',
			orientation: 'row',
			sizes: [1, 1],
			children: [
				{ kind: 'tabs', id: 'g-left', panels: ['a'], active: 'a' },
				{ kind: 'tabs', id: 'g-right', panels: ['b', 'c'], active: 'b' },
			],
		},
	}
}

function findGroupOf(root: LayoutNode, panelId: string): TabGroupNode | null {
	let found: TabGroupNode | null = null
	const walk = (n: LayoutNode): void => {
		if (found) return
		if (n.kind === 'tabs') {
			if (n.panels.includes(panelId)) found = n
		}
		else n.children.forEach(walk)
	}
	walk(root)
	return found
}

/** Count occurrences of a panel id across all groups. */
function countPanel(root: LayoutNode, panelId: string): number {
	let n = 0
	const walk = (node: LayoutNode): void => {
		if (node.kind === 'tabs') n += node.panels.filter((p) => p === panelId).length
		else node.children.forEach(walk)
	}
	walk(root)
	return n
}

/** Find the innermost split that directly holds the groups owning both panels. */
function findCommonSplit(root: LayoutNode, p1: string, p2: string): SplitNode | null {
	let result: SplitNode | null = null
	const directlyOwns = (split: SplitNode, panel: string): number => {
		for (let i = 0; i < split.children.length; i++) {
			const c = split.children[i]!
			const g = findGroupOf(c, panel)
			if (g) return i
		}
		return -1
	}
	const walk = (node: LayoutNode): void => {
		if (node.kind !== 'split') return
		const i1 = directlyOwns(node, p1)
		const i2 = directlyOwns(node, p2)
		if (i1 !== -1 && i2 !== -1 && i1 !== i2) result = node
		node.children.forEach(walk)
	}
	walk(root)
	return result
}

// ───────────────────────── Layer 1a: computeDropZone ─────────────────────────

describe('computeDropZone — band zones', () => {
	const rect = { width: 400, height: 400 } // band = 0.25 * 400 = 100px

	// BUG: impl swaps axes or mislabels a band, so dragging to the left edge docks
	// on the wrong side (right/top/bottom) — the single most user-visible failure.
	it('classifies a point in the left band as left', () => {
		expect(computeDropZone(rect, { x: 20, y: 200 })).toBe('left')
	})
	it('classifies a point in the right band as right', () => {
		expect(computeDropZone(rect, { x: 380, y: 200 })).toBe('right')
	})
	it('classifies a point in the top band as top', () => {
		expect(computeDropZone(rect, { x: 200, y: 20 })).toBe('top')
	})
	it('classifies a point in the bottom band as bottom', () => {
		expect(computeDropZone(rect, { x: 200, y: 380 })).toBe('bottom')
	})

	// BUG: impl treats the whole rect as an edge (no interior) so a center drop
	// can never JOIN a tab group — it always splits.
	it('classifies the dead-center point as center', () => {
		expect(computeDropZone(rect, { x: 200, y: 200 })).toBe('center')
	})

	// BUG: off-by-one at the band boundary. band=100: x=120 is INSIDE the interior
	// horizontally (>100 and <300) and centered vertically => center, not left.
	it('a point just inside the interior (past the band edge) is center', () => {
		expect(computeDropZone(rect, { x: 120, y: 200 })).toBe('center')
	})

	// BUG: impl uses a fixed pixel band instead of edgeFraction*min(w,h), so a
	// custom edgeFraction is ignored. With edgeFraction=0.1, band=40: x=60 is
	// interior (center), whereas with the default 0.25 (band 100) it would be left.
	it('honors a custom edgeFraction', () => {
		expect(computeDropZone(rect, { x: 60, y: 200 }, 0.1)).toBe('center')
		expect(computeDropZone(rect, { x: 60, y: 200 }, 0.25)).toBe('left')
	})

	// BUG: impl uses min(w,h) wrong (uses width or height alone) for a non-square
	// rect. width=1000,height=200 => band = 0.25*200 = 50. x=60 is interior (center),
	// NOT left (which it would be if band were 0.25*1000=250).
	it('band thickness uses min(width,height) for non-square rects', () => {
		const wide = { width: 1000, height: 200 }
		expect(computeDropZone(wide, { x: 60, y: 100 })).toBe('center')
		expect(computeDropZone(wide, { x: 40, y: 100 })).toBe('left')
	})
})

describe('computeDropZone — corner tie-break', () => {
	const rect = { width: 400, height: 400 } // band = 100

	// BUG: impl picks an arbitrary band when two overlap, so corner drops are
	// non-deterministic. Top-left corner with the point CLOSER to the top edge
	// (y smaller than x) must resolve to top.
	it('top-left corner closer to the TOP edge resolves to top', () => {
		// x=80 (dLeft=0.20), y=30 (dTop=0.075). top is nearer => top.
		expect(computeDropZone(rect, { x: 80, y: 30 })).toBe('top')
	})

	// BUG: same corner, point closer to the LEFT edge must resolve to left.
	it('top-left corner closer to the LEFT edge resolves to left', () => {
		// x=20 (dLeft=0.05), y=90 (dTop=0.225). left is nearer => left.
		expect(computeDropZone(rect, { x: 20, y: 90 })).toBe('left')
	})

	// BUG: impl has no deterministic tie rule, so an exactly-equidistant corner
	// flickers. On an exact tie HORIZONTAL must win: x=50 (dLeft=0.125),
	// y=50 (dTop=0.125) => tie => left (horizontal).
	it('exact-tie corner resolves to the HORIZONTAL zone (left over top)', () => {
		expect(computeDropZone(rect, { x: 50, y: 50 })).toBe('left')
	})

	// BUG: bottom-right corner mis-resolves. x=370 (dRight=0.075), y=320
	// (dBottom=0.20) => right is nearer => right.
	it('bottom-right corner closer to the RIGHT edge resolves to right', () => {
		expect(computeDropZone(rect, { x: 370, y: 320 })).toBe('right')
	})
})

describe('computeDropZone — out-of-rect clamp', () => {
	const rect = { width: 400, height: 400 }

	// BUG: impl returns center / throws / NaN for points outside the rect (pointer
	// dragged past the panel). A point left of x=0 must clamp to left.
	it('clamps a point left of the rect to left', () => {
		expect(computeDropZone(rect, { x: -30, y: 200 })).toBe('left')
	})
	it('clamps a point right of the rect to right', () => {
		expect(computeDropZone(rect, { x: 430, y: 200 })).toBe('right')
	})
	it('clamps a point above the rect to top', () => {
		expect(computeDropZone(rect, { x: 200, y: -10 })).toBe('top')
	})
	it('clamps a point below the rect to bottom', () => {
		expect(computeDropZone(rect, { x: 200, y: 460 })).toBe('bottom')
	})

	// BUG: a diagonally-outside corner has no rule. Out on both axes: x=-60
	// (overshoot 60) vs y=-10 (overshoot 10) => x overshoot larger => left.
	it('diagonal-outside corner picks the axis with the larger overshoot', () => {
		expect(computeDropZone(rect, { x: -60, y: -10 })).toBe('left')
		expect(computeDropZone(rect, { x: -10, y: -60 })).toBe('top')
	})
})

describe('computeDropZone — non-finite rect dimensions (N1)', () => {
	// BUG (N1): the degenerate guard checks `Number.isFinite(x/y)` for the POINT
	// but only `width > 0` / `height > 0` for the RECT — NOT finiteness. A
	// non-finite width/height (e.g. Infinity) satisfies `> 0` and slips through,
	// then `band = edgeFraction * min(Infinity, h)` produces a finite band and the
	// point is misclassified as an EDGE zone. A rect with a non-finite dimension is
	// degenerate (no meaningful geometry) → it must be the interior ('center').
	//
	// On HEAD: width Infinity + x=20 → band = 0.25*min(Infinity,100)=25, x=20<25 →
	// 'left'. height Infinity → band derived from width → an edge zone. Both wrong.

	it('a rect with non-finite WIDTH is degenerate → center', () => {
		expect(computeDropZone({ width: Infinity, height: 100 }, { x: 20, y: 50 })).toBe('center')
	})

	it('a rect with non-finite HEIGHT is degenerate → center', () => {
		expect(computeDropZone({ width: 100, height: Infinity }, { x: 50, y: 20 })).toBe('center')
	})

	it('a rect with NaN width or height is degenerate → center', () => {
		expect(computeDropZone({ width: Number.NaN, height: 100 }, { x: 20, y: 50 })).toBe('center')
		expect(computeDropZone({ width: 100, height: Number.NaN }, { x: 50, y: 20 })).toBe('center')
	})
})

// ───────────────────────── Layer 1a': computeReorderIndex ─────────────────────────
//
// FAILING TDD spec for the NOT-YET-WRITTEN pure helper:
//
//   computeReorderIndex(
//     tabRects: readonly { left: number; width: number }[],
//     pointerX: number,
//   ): number
//
// Maps a pointer x over a HORIZONTAL tab strip to an INSERTION index:
//   - pointer left of the first tab            => 0
//   - within the LEFT half of tab i            => i
//   - within the RIGHT half of tab i           => i + 1
//   - past the last tab                        => tabRects.length
//   - empty strip                              => 0
//   - non-finite pointerX (guard)              => 0
//
// Style mirrors computeDropZone's exhaustive boundary tests above.
describe('computeReorderIndex — tab-strip insertion index', () => {
	// A 3-tab strip, each 100px wide, contiguous: [0..100) [100..200) [200..300).
	// midpoints: 50, 150, 250.
	const tabs3 = [
		{ left: 0, width: 100 },
		{ left: 100, width: 100 },
		{ left: 200, width: 100 },
	] as const

	// BUG: impl forgets the before-first case and clamps negatively or returns 1,
	// so dropping a tab to the very front lands it in the wrong slot.
	it('a pointer left of the first tab => 0', () => {
		expect(computeReorderIndex(tabs3, -50)).toBe(0)
		expect(computeReorderIndex(tabs3, 0)).toBe(0)
	})

	// BUG: impl uses the tab START instead of its MIDPOINT, so the left half of a
	// tab wrongly inserts AFTER it.
	it('within the LEFT half of tab i => i', () => {
		expect(computeReorderIndex(tabs3, 10)).toBe(0) // left half of tab 0
		expect(computeReorderIndex(tabs3, 120)).toBe(1) // left half of tab 1
		expect(computeReorderIndex(tabs3, 220)).toBe(2) // left half of tab 2
	})

	// BUG: impl uses the tab END instead of its MIDPOINT, so the right half of a
	// tab wrongly inserts BEFORE it.
	it('within the RIGHT half of tab i => i + 1', () => {
		expect(computeReorderIndex(tabs3, 90)).toBe(1) // right half of tab 0
		expect(computeReorderIndex(tabs3, 190)).toBe(2) // right half of tab 1
		expect(computeReorderIndex(tabs3, 290)).toBe(3) // right half of tab 2
	})

	// BUG: off-by-one exactly AT the midpoint. The contract: the LEFT half is the
	// half that maps to i; AT the midpoint the point is no longer in the left half,
	// so it maps to i + 1. Pin the boundary deterministically.
	it('exactly at a tab midpoint maps to the right half (i + 1)', () => {
		expect(computeReorderIndex(tabs3, 50)).toBe(1) // midpoint of tab 0
		expect(computeReorderIndex(tabs3, 150)).toBe(2) // midpoint of tab 1
		expect(computeReorderIndex(tabs3, 250)).toBe(3) // midpoint of tab 2
	})

	// BUG: impl clamps to length-1 instead of length, so a drop past the last tab
	// can't append to the very end.
	it('past the last tab => tabRects.length', () => {
		expect(computeReorderIndex(tabs3, 500)).toBe(3)
		expect(computeReorderIndex(tabs3, 300)).toBe(3) // right at the trailing edge
	})

	// BUG: empty strip throws / returns NaN instead of the only valid index, 0.
	it('an empty strip => 0', () => {
		expect(computeReorderIndex([], 123)).toBe(0)
		expect(computeReorderIndex([], -5)).toBe(0)
	})

	// BUG: a non-finite pointer (a stray NaN/Infinity from a 0-geometry dragover)
	// produces NaN index downstream; the guard must pin it to 0.
	it('a non-finite pointerX => 0 (guard)', () => {
		expect(computeReorderIndex(tabs3, Number.NaN)).toBe(0)
		expect(computeReorderIndex(tabs3, Infinity)).toBe(0)
		expect(computeReorderIndex(tabs3, -Infinity)).toBe(0)
	})

	// Single-tab strip: left half => 0, right half => 1. Pins the degenerate small
	// strip the same way the 3-tab cases pin the general one.
	it('single-tab strip: left half => 0, right half => 1', () => {
		const one = [{ left: 0, width: 80 }] as const
		expect(computeReorderIndex(one, -10)).toBe(0)
		expect(computeReorderIndex(one, 10)).toBe(0) // left half
		expect(computeReorderIndex(one, 70)).toBe(1) // right half
		expect(computeReorderIndex(one, 200)).toBe(1) // past end
	})
})

// ───────────────────────── Layer 1b: dropZoneToMutation ─────────────────────────

describe('dropZoneToMutation — descriptor shape', () => {
	const target = { groupId: 'g-right', panelId: 'b' }

	// BUG: center must MOVE the dragged panel into the target's tab group, not
	// split. A wrong kind here re-docks the wrong way for every center drop.
	it('center => move into the target group', () => {
		const m = dropZoneToMutation('center', 'a', target)
		expect(m).toEqual({ kind: 'move', panelId: 'a', destGroupId: 'g-right' })
	})

	// BUG: left/right map to the wrong orientation or side, so a horizontal dock
	// produces a vertical split (or docks on the opposite side).
	it('left => split row before at the target panel', () => {
		expect(dropZoneToMutation('left', 'a', target)).toEqual({
			kind: 'split', atPanelId: 'b', dir: 'row', side: 'before', newPanelId: 'a',
		} satisfies RedockMutation)
	})
	it('right => split row after at the target panel', () => {
		expect(dropZoneToMutation('right', 'a', target)).toEqual({
			kind: 'split', atPanelId: 'b', dir: 'row', side: 'after', newPanelId: 'a',
		} satisfies RedockMutation)
	})

	// BUG: top/bottom map to row instead of column, so a vertical dock splits
	// horizontally.
	it('top => split column before at the target panel', () => {
		expect(dropZoneToMutation('top', 'a', target)).toEqual({
			kind: 'split', atPanelId: 'b', dir: 'column', side: 'before', newPanelId: 'a',
		} satisfies RedockMutation)
	})
	it('bottom => split column after at the target panel', () => {
		expect(dropZoneToMutation('bottom', 'a', target)).toEqual({
			kind: 'split', atPanelId: 'b', dir: 'column', side: 'after', newPanelId: 'a',
		} satisfies RedockMutation)
	})
})

describe('isNoopRedock', () => {
	// Center onto the panel's OWN tab (dragged === target.panelId) is a no-op.
	it('center onto the panel\'s OWN tab is a no-op', () => {
		expect(isNoopRedock('b', 'g-right', { groupId: 'g-right', panelId: 'b' }, 'center')).toBe(true)
	})

	// Center onto a DIFFERENT panel in ANOTHER group is a real tab-join.
	it('center onto a DIFFERENT panel in another group is NOT a no-op', () => {
		expect(isNoopRedock('a', 'g-left', { groupId: 'g-right', panelId: 'b' }, 'center')).toBe(false)
	})

	// M2: a center drop back into the dragged panel's OWN group (a DIFFERENT tab of
	// the same group) is a no-op — `movePanel` would re-append it and bump the
	// revision for no visible change.
	it('center back into the dragged panel\'s OWN group is a no-op (M2)', () => {
		expect(isNoopRedock('a', 'g-right', { groupId: 'g-right', panelId: 'b' }, 'center')).toBe(true)
	})

	// M1: a split onto the dragged panel ITSELF is a no-op — extract-then-split
	// would remove the very anchor it splits at and throw (self-collapse).
	it('a split onto the dragged panel ITSELF is a no-op (M1)', () => {
		expect(isNoopRedock('b', 'g-right', { groupId: 'g-right', panelId: 'b' }, 'left')).toBe(true)
	})

	// A split onto a DIFFERENT panel of the dragged panel's own group is still a
	// real re-dock (it splits the group around that sibling), NOT a no-op.
	it('a split onto a SIBLING of the own group is NOT a no-op', () => {
		expect(isNoopRedock('a', 'g-right', { groupId: 'g-right', panelId: 'b' }, 'left')).toBe(false)
	})
})

// ─────────── Layer 1c: applying the descriptor against a REAL tree ───────────
// These prove the descriptor's INTENT is realizable with the engine mutations:
// center => movePanel; split => extract-then-split (because splitPanel throws if
// the dragged panel already exists). They assert final placement + uniqueness.

describe('applying a redock descriptor to a real tree', () => {
	// BUG: a center descriptor that is applied with the wrong engine call (split
	// instead of move) leaves the dragged panel out of the target group. Prove
	// move lands 'a' in g-right exactly once.
	it('center move lands the dragged panel in the target group exactly once', () => {
		const model = createLayoutModel(makeTree())
		const m = dropZoneToMutation('center', 'a', { groupId: 'g-right', panelId: 'b' })
		expect(m.kind).toBe('move')
		if (m.kind !== 'move') throw new Error('expected move')
		model.apply((t) => movePanel(t, m.panelId, { groupId: m.destGroupId }))

		const root = model.get().root
		const home = findGroupOf(root, 'a')!
		expect(home.id).toBe('g-right')
		expect(home.panels).toContain('a')
		expect(countPanel(root, 'a')).toBe(1)
	})

	// BUG (the headline edge case): re-docking an EXISTING panel via a split must
	// extract it FIRST, else splitPanel throws "new panel already exists". Prove
	// the extract-then-split sequence (a) does not throw, (b) places 'a' adjacent
	// to the target 'b' in the correct orientation/side, (c) 'a' appears once.
	it('split-right of an EXISTING panel: extract-then-split places it after, exactly once', () => {
		const model = createLayoutModel(makeTree())
		const m = dropZoneToMutation('right', 'a', { groupId: 'g-right', panelId: 'b' })
		expect(m.kind).toBe('split')
		if (m.kind !== 'split') throw new Error('expected split')

		// Naive splitPanel WITHOUT extracting first must throw (the dragged panel
		// 'a' already exists) — this is exactly why the two-step op is required.
		expect(() =>
			model.get(),
		).not.toThrow()
		expect(() =>
			splitPanel(model.get(), m.atPanelId, m.dir, m.newPanelId, m.side),
		).toThrow()

		// Correct two-step application: extract dragged, then split target by it.
		expect(() => {
			model.apply((t) => {
				const { tree } = extractPanel(t, m.newPanelId)
				return splitPanel(tree, m.atPanelId, m.dir, m.newPanelId, m.side)
			})
		}).not.toThrow()

		const root = model.get().root
		// 'a' present exactly once.
		expect(countPanel(root, 'a')).toBe(1)
		// 'a' and 'b' now live under a common ROW split, with 'a' AFTER 'b'.
		const common = findCommonSplit(root, 'b', 'a')
		expect(common).not.toBeNull()
		expect(common!.orientation).toBe('row')
		const idxB = common!.children.findIndex((c) => findGroupOf(c, 'b'))
		const idxA = common!.children.findIndex((c) => findGroupOf(c, 'a'))
		expect(idxA).toBeGreaterThan(idxB) // 'after' => a sits to the right of b
	})

	// BUG: split-before / column variants get the side or orientation wrong. Prove
	// a top (column/before) dock puts the dragged panel ABOVE the target.
	it('split-top of an EXISTING panel places it before, under a column split', () => {
		const model = createLayoutModel(makeTree())
		const m = dropZoneToMutation('top', 'a', { groupId: 'g-right', panelId: 'b' })
		if (m.kind !== 'split') throw new Error('expected split')

		model.apply((t) => {
			const { tree } = extractPanel(t, m.newPanelId)
			return splitPanel(tree, m.atPanelId, m.dir, m.newPanelId, m.side)
		})

		const root = model.get().root
		expect(countPanel(root, 'a')).toBe(1)
		const common = findCommonSplit(root, 'b', 'a')
		expect(common).not.toBeNull()
		expect(common!.orientation).toBe('column')
		const idxB = common!.children.findIndex((c) => findGroupOf(c, 'b'))
		const idxA = common!.children.findIndex((c) => findGroupOf(c, 'a'))
		expect(idxA).toBeLessThan(idxB) // 'before' => a sits above b
	})
})

// Type-only guard: keep DropZone exhaustiveness honest (compile-time). If the
// impl drops a member or renames one, this stops compiling.
const _zones: DropZone[] = ['left', 'right', 'top', 'bottom', 'center']
void _zones
