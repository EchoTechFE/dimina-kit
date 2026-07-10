/**
 * GAP #1 — mutation / tree-rewrite correctness.
 *
 * Pinned deterministic rules (the implementer MUST match these):
 *
 * 1. PURITY: every mutation returns a NEW tree; the input is never mutated.
 * 2. STRUCTURAL INVARIANTS hold after ANY mutation (see structuralProblems):
 *      - split.sizes.length === split.children.length
 *      - split has >= 2 children
 *      - tabgroup non-empty, active ∈ panels
 * 3. ACTIVE RE-SELECTION when the active panel is removed from a tabgroup:
 *      new active = panel now at index min(removedIndex, newLength - 1)
 *      (i.e. same slot, clamped to last). Tested explicitly.
 * 4. COLLAPSE on close/extract:
 *      - emptied tabgroup (0 panels) removed from its parent split
 *      - a split left with a SINGLE child is replaced by that child
 *      - collapse CASCADES upward
 *      - the ROOT is always a LayoutNode (never a bare panel string)
 * 5. splitPanel: extracts atPanelId into a new tabgroup, wraps it and a new
 *      tabgroup holding newPanelId inside a new split (orientation = dir).
 *      `side` decides order: 'before' => [newGroup, origGroup],
 *      'after' => [origGroup, newGroup]. Sizes = equal weights [1, 1].
 * 6. movePanel / insertPanel index handling:
 *      - undefined index => append to end of dest group
 *      - out-of-range index clamps into [0, len]
 *      - moving within the same group reorders
 */
import { describe, expect, it } from 'vitest'
import type { LayoutTree, SplitNode, TabGroupNode } from './types.js'
import {
	closePanel,
	extractPanel,
	insertPanel,
	movePanel,
	setActive,
	setConstraint,
	setSizes,
	splitGroup,
	splitPanel,
	validateTree,
	wrapRoot,
} from './index.js'
import {
	allNodes,
	allPanels,
	expectRejects,
	findGroup,
	groupOf,
	split,
	structuralProblems,
	tabs,
	tree,
} from './_fixtures.js'

// Canonical starting tree:
//   row split s0
//     ├─ g1: [p1, p2]  active p1
//     └─ g2: [p3, p4]  active p3
function base(): LayoutTree {
	return tree(
		split('s0', 'row', [
			tabs('g1', ['p1', 'p2'], 'p1'),
			tabs('g2', ['p3', 'p4'], 'p3'),
		]),
	)
}

// Deep-clone snapshot for purity checks (tree is plain JSON-able data).
function frozenCopy(t: LayoutTree): LayoutTree {
	return JSON.parse(JSON.stringify(t)) as LayoutTree
}

function expectStructurallySound(t: LayoutTree): void {
	expect(structuralProblems(t), structuralProblems(t).join('\n')).toEqual([])
}

// ───────────────────────── setSizes ─────────────────────────

describe('setSizes', () => {
	it('sets the sizes of the named split and returns a new tree', () => {
		const t = base()
		const before = frozenCopy(t)
		const out = setSizes(t, 's0', [3, 7])
		expect(out).not.toBe(t)
		expect(t).toEqual(before) // input untouched
		const s = out.root as SplitNode
		expect(s.sizes).toEqual([3, 7])
		expectStructurallySound(out)
	})

	it('rejects a sizes array whose length != children length', () => {
		const t = base()
		expectRejects(() => setSizes(t, 's0', [1]))
	})

	it('rejects non-finite sizes (NaN / Infinity / -Infinity)', () => {
		expectRejects(() => setSizes(base(), 's0', [NaN, 1]))
		expectRejects(() => setSizes(base(), 's0', [1, Infinity]))
		expectRejects(() => setSizes(base(), 's0', [-Infinity, 2]))
		// sanity: a finite pair still succeeds
		const out = setSizes(base(), 's0', [3, 7])
		expect((out.root as SplitNode).sizes).toEqual([3, 7])
		expectStructurallySound(out)
	})
})

// ───────────────────────── setActive ─────────────────────────

describe('setActive', () => {
	it('changes active to a panel within the group', () => {
		const out = setActive(base(), 'g1', 'p2')
		expect(findGroup(out, 'g1')!.active).toBe('p2')
		expectStructurallySound(out)
	})

	it('is pure — does not mutate the input tree', () => {
		const t = base()
		const before = frozenCopy(t)
		setActive(t, 'g1', 'p2')
		expect(t).toEqual(before)
	})

	it('throws when panel is not in the group', () => {
		expectRejects(() => setActive(base(), 'g1', 'p3'))
	})
})

// ───────────────────────── closePanel ─────────────────────────

describe('closePanel — active re-selection rule', () => {
	it('removing a NON-active panel keeps active unchanged', () => {
		// g1 = [p1,p2] active p1; close p2 -> active stays p1
		const out = closePanel(base(), 'p2')
		const g1 = findGroup(out, 'g1')!
		expect(g1.panels).toEqual(['p1'])
		expect(g1.active).toBe('p1')
		expectStructurallySound(out)
	})

	it('removing the active panel selects the panel now at the same (clamped) index', () => {
		// g2 = [p3,p4] active p3 (index 0). Close p3 -> active = panel now at
		// index min(0, 1-1)=0 => p4.
		const out = closePanel(base(), 'p3')
		const g2 = findGroup(out, 'g2')!
		expect(g2.panels).toEqual(['p4'])
		expect(g2.active).toBe('p4')
	})

	it('removing the LAST active panel clamps to the new last index', () => {
		// g = [a,b,c] active c (index 2). Close c -> active = panel at
		// min(2, 3-1=2 -> after removal len 2, last index 1) => b.
		const t = tree(
			split('s', 'row', [
				tabs('g', ['a', 'b', 'c'], 'c'),
				tabs('h', ['z'], 'z'),
			]),
		)
		const out = closePanel(t, 'c')
		const g = findGroup(out, 'g')!
		expect(g.panels).toEqual(['a', 'b'])
		expect(g.active).toBe('b') // clamped to last
	})
})

describe('closePanel — collapse', () => {
	it('emptied tabgroup is removed and the single-child split collapses to the sibling', () => {
		// Close p3 and p4 -> g2 empties -> removed -> s0 has single child g1 ->
		// collapse: root becomes g1 (a tabgroup, NOT a panel string).
		let out = closePanel(base(), 'p3')
		out = closePanel(out, 'p4')
		expect(out.root.kind).toBe('tabs')
		expect((out.root as TabGroupNode).id).toBe('g1')
		expect((out.root as TabGroupNode).panels).toEqual(['p1', 'p2'])
		expectStructurallySound(out)
	})

	it('collapse cascades upward through nested splits', () => {
		// column s0
		//   ├─ g1 [p1]
		//   └─ row s1
		//        ├─ g2 [p2]
		//        └─ g3 [p3]
		// Close p3 -> g3 empties -> s1 single-child -> collapse to g2 ->
		// s0 = [g1, g2]. Then close p2 -> g2 empties -> s0 single-child ->
		// collapse to g1 -> root = g1.
		const t = tree(
			split('s0', 'column', [
				tabs('g1', ['p1'], 'p1'),
				split('s1', 'row', [
					tabs('g2', ['p2'], 'p2'),
					tabs('g3', ['p3'], 'p3'),
				]),
			]),
		)
		let out = closePanel(t, 'p3')
		// s1 collapsed away; s0 now holds g1 + g2.
		const s0 = out.root as SplitNode
		expect(s0.kind).toBe('split')
		expect(s0.children.map(c => c.id).sort()).toEqual(['g1', 'g2'])
		expect(s0.sizes.length).toBe(s0.children.length)
		expectStructurallySound(out)

		out = closePanel(out, 'p2')
		expect(out.root.kind).toBe('tabs')
		expect((out.root as TabGroupNode).id).toBe('g1')
		expectStructurallySound(out)
	})

	it('does NOT collapse the root into a panel string when one tabgroup remains', () => {
		// Single tabgroup root, multiple panels. Close all but one -> root stays
		// a tabgroup with the surviving panel, never a bare string.
		const t = tree(tabs('only', ['p1', 'p2'], 'p1'))
		const out = closePanel(t, 'p2')
		expect(out.root.kind).toBe('tabs')
		expect((out.root as TabGroupNode).panels).toEqual(['p1'])
		expectStructurallySound(out)
	})

	it('throws when closing an unknown panel', () => {
		expectRejects(() => closePanel(base(), 'ghost'))
	})

	it('is pure', () => {
		const t = base()
		const before = frozenCopy(t)
		closePanel(t, 'p2')
		expect(t).toEqual(before)
	})
})

describe('closePanel — last-panel no-op guard', () => {
	// BUG: closing the ONLY panel left in the whole tree currently THROWS
	// "mutation would empty the entire layout"; the new contract makes it a
	// NO-OP that returns the tree unchanged, so the host never has to special-case
	// "this is the last panel" before wiring a close button.
	it('closing the only panel in a single-group tree is a NO-OP (returns the tree, no throw)', () => {
		const t = tree(tabs('only', ['solo'], 'solo'))
		const out = closePanel(t, 'solo')
		// not a throw, not an empty tree — the solo panel survives.
		expect(out.root.kind).toBe('tabs')
		expect((out.root as TabGroupNode).id).toBe('only')
		expect((out.root as TabGroupNode).panels).toEqual(['solo'])
		expect((out.root as TabGroupNode).active).toBe('solo')
		expectStructurallySound(out)
	})

	// BUG: a last-panel close that previously threw would corrupt callers that
	// expect a usable tree back; the no-op must yield a structurally identical
	// (deep-equal) tree, not a partially-collapsed or empty one.
	it('the last-panel no-op returns a tree deep-equal to the input', () => {
		const t = tree(tabs('only', ['solo'], 'solo'))
		const out = closePanel(t, 'solo')
		expect(out).toEqual(t)
	})

	// BUG: collapse could whittle a multi-group tree down to its final panel and
	// then THROW on that final close; the last close in a sequence must instead
	// no-op once a single panel remains across the WHOLE tree.
	it('closing down to the final panel across multiple groups no-ops on the last close', () => {
		// row s0 with g1:[p1] and g2:[p2]. Close p1 -> collapse to g2:[p2].
		const t = tree(
			split('s0', 'row', [
				tabs('g1', ['p1'], 'p1'),
				tabs('g2', ['p2'], 'p2'),
			]),
		)
		const out = closePanel(t, 'p1')
		// other panel (p2) still existed when p1 closed -> normal collapse path.
		expect(out.root.kind).toBe('tabs')
		expect((out.root as TabGroupNode).panels).toEqual(['p2'])
		expectStructurallySound(out)

		// now p2 is the ONLY panel in the whole tree -> closing it must NO-OP.
		const afterLast = closePanel(out, 'p2')
		expect(afterLast.root.kind).toBe('tabs')
		expect((afterLast.root as TabGroupNode).panels).toEqual(['p2'])
		expectStructurallySound(afterLast)
	})

	// BUG: a permissive last-panel guard must NOT also swallow genuinely-invalid
	// closes — closing an unknown panel id (even when only one panel exists) must
	// still throw, so typos/stale ids aren't silently ignored.
	it('closing an UNKNOWN panel id still throws even when only one panel exists', () => {
		const t = tree(tabs('only', ['solo'], 'solo'))
		expectRejects(() => closePanel(t, 'ghost'))
	})

	// BUG: the no-op path must not regress the normal multi-panel close — when
	// OTHER panels still exist anywhere, closing one must remove it (collapse +
	// active re-derivation) exactly as before, not no-op.
	it('with other panels present, closing one still removes it (no spurious no-op)', () => {
		// g1=[p1,p2] active p1; close p1 -> p1 gone, active clamps to p2.
		const out = closePanel(base(), 'p1')
		const g1 = findGroup(out, 'g1')!
		expect(g1.panels).toEqual(['p2'])
		expect(g1.active).toBe('p2')
		expectStructurallySound(out)
	})
})

// ───────────────────────── extractPanel ─────────────────────────

describe('extractPanel', () => {
	it('removes the panel from the tree and returns its id', () => {
		const { tree: out, extracted } = extractPanel(base(), 'p4')
		expect(extracted).toBe('p4')
		expect(allPanels(out)).not.toContain('p4')
		expect(findGroup(out, 'g2')!.panels).toEqual(['p3'])
		expectStructurallySound(out)
	})

	it('collapses just like closePanel when it empties a group', () => {
		// g2 = [p3] only. Extract p3 -> g2 empties -> collapse -> root = g1.
		const t = tree(
			split('s0', 'row', [
				tabs('g1', ['p1', 'p2'], 'p1'),
				tabs('g2', ['p3'], 'p3'),
			]),
		)
		const { tree: out } = extractPanel(t, 'p3')
		expect(out.root.kind).toBe('tabs')
		expect((out.root as TabGroupNode).id).toBe('g1')
		expectStructurallySound(out)
	})

	it('is pure', () => {
		const t = base()
		const before = frozenCopy(t)
		extractPanel(t, 'p4')
		expect(t).toEqual(before)
	})
})

// ───────────────────────── insertPanel ─────────────────────────

describe('insertPanel — index handling', () => {
	it('undefined index appends to the end of the dest group', () => {
		const out = insertPanel(base(), 'pNew', { groupId: 'g1' })
		expect(findGroup(out, 'g1')!.panels).toEqual(['p1', 'p2', 'pNew'])
		expectStructurallySound(out)
	})

	it('explicit index inserts at that position', () => {
		const out = insertPanel(base(), 'pNew', { groupId: 'g2', index: 1 })
		expect(findGroup(out, 'g2')!.panels).toEqual(['p3', 'pNew', 'p4'])
	})

	it('out-of-range index clamps to the end', () => {
		const out = insertPanel(base(), 'pNew', { groupId: 'g1', index: 999 })
		expect(findGroup(out, 'g1')!.panels).toEqual(['p1', 'p2', 'pNew'])
	})

	it('negative index clamps to 0', () => {
		const out = insertPanel(base(), 'pNew', { groupId: 'g1', index: -5 })
		expect(findGroup(out, 'g1')!.panels).toEqual(['pNew', 'p1', 'p2'])
	})

	it('throws for an unknown dest group', () => {
		expectRejects(() => insertPanel(base(), 'pNew', { groupId: 'nope' }))
	})

	it('rejects inserting a panel id that already exists in the tree', () => {
		// p1 already lives in g1; inserting it again into g2 must throw.
		expectRejects(() => insertPanel(base(), 'p1', { groupId: 'g2' }))
		// sanity: a fresh id still succeeds
		const out = insertPanel(base(), 'pNew', { groupId: 'g2' })
		expect(findGroup(out, 'g2')!.panels).toEqual(['p3', 'p4', 'pNew'])
		expectStructurallySound(out)
	})

	it('is pure', () => {
		const t = base()
		const before = frozenCopy(t)
		insertPanel(t, 'pNew', { groupId: 'g1' })
		expect(t).toEqual(before)
	})
})

// ───────────────────────── movePanel ─────────────────────────

describe('movePanel', () => {
	it('moves a panel to another group at the given index', () => {
		// move p1 (in g1) -> g2 index 0
		const out = movePanel(base(), 'p1', { groupId: 'g2', index: 0 })
		expect(findGroup(out, 'g1')!.panels).toEqual(['p2'])
		expect(findGroup(out, 'g2')!.panels).toEqual(['p1', 'p3', 'p4'])
		expectStructurallySound(out)
	})

	it('undefined index appends in the destination group', () => {
		const out = movePanel(base(), 'p1', { groupId: 'g2' })
		expect(findGroup(out, 'g2')!.panels).toEqual(['p3', 'p4', 'p1'])
	})

	it('moving the active panel out re-derives the source active by the clamp rule', () => {
		// g1 = [p1,p2] active p1 (index 0). Move p1 out -> g1 = [p2],
		// active = panel at min(0, 0) => p2.
		const out = movePanel(base(), 'p1', { groupId: 'g2' })
		expect(findGroup(out, 'g1')!.active).toBe('p2')
	})

	it('moving the LAST panel out of a group empties it and collapses', () => {
		// g2 = [p3] only; move p3 to g1 -> g2 empties -> collapse -> root = g1.
		const t = tree(
			split('s0', 'row', [
				tabs('g1', ['p1', 'p2'], 'p1'),
				tabs('g2', ['p3'], 'p3'),
			]),
		)
		const out = movePanel(t, 'p3', { groupId: 'g1' })
		expect(out.root.kind).toBe('tabs')
		expect((out.root as TabGroupNode).id).toBe('g1')
		expect((out.root as TabGroupNode).panels).toEqual(['p1', 'p2', 'p3'])
		expectStructurallySound(out)
	})

	it('reorders within the same group when dest is the same group', () => {
		// g1 = [p1,p2]; move p1 to index 1 within g1 -> [p2,p1]
		const out = movePanel(base(), 'p1', { groupId: 'g1', index: 1 })
		expect(findGroup(out, 'g1')!.panels).toEqual(['p2', 'p1'])
		expectStructurallySound(out)
	})

	// ── same-group reorder hardening ─────────────────────────────────────────
	// Pins the exact `panels` order for a same-group reorder to each boundary
	// index (front / middle / end) and that reorder to the CURRENT index is a
	// stable no-op-equivalent. This underwrites the dock-react `reorder-only`
	// drop policy, which must REORDER a pinned panel within its group instead of
	// letting it split out or no-op.
	//
	// Starting group g3 = [p1, p2, p3] active p1.
	function reorderTree(): LayoutTree {
		return tree(
			split('s0', 'row', [
				tabs('g3', ['p1', 'p2', 'p3'], 'p1'),
				tabs('g4', ['p4'], 'p4'),
			]),
		)
	}

	it('same-group reorder: move a panel to the FRONT (index 0)', () => {
		// g3 = [p1,p2,p3]; move p3 to index 0 -> [p3,p1,p2]
		const out = movePanel(reorderTree(), 'p3', { groupId: 'g3', index: 0 })
		expect(findGroup(out, 'g3')!.panels).toEqual(['p3', 'p1', 'p2'])
		expectStructurallySound(out)
	})

	it('same-group reorder: move a panel to a MIDDLE index', () => {
		// g3 = [p1,p2,p3]; move p1 to index 1 -> [p2,p1,p3]
		const out = movePanel(reorderTree(), 'p1', { groupId: 'g3', index: 1 })
		expect(findGroup(out, 'g3')!.panels).toEqual(['p2', 'p1', 'p3'])
		expectStructurallySound(out)
	})

	it('same-group reorder: move a panel to the END', () => {
		// g3 = [p1,p2,p3]; move p1 to the end -> [p2,p3,p1]
		const out = movePanel(reorderTree(), 'p1', { groupId: 'g3', index: 2 })
		expect(findGroup(out, 'g3')!.panels).toEqual(['p2', 'p3', 'p1'])
		expectStructurallySound(out)
	})

	it('same-group reorder: undefined index appends to the end of the same group', () => {
		// g3 = [p1,p2,p3]; move p1 with no index -> appended -> [p2,p3,p1]
		const out = movePanel(reorderTree(), 'p1', { groupId: 'g3' })
		expect(findGroup(out, 'g3')!.panels).toEqual(['p2', 'p3', 'p1'])
		expectStructurallySound(out)
	})

	it('same-group reorder to the CURRENT index is a stable no-op-equivalent (order unchanged)', () => {
		// p2 already sits at index 1 in [p1,p2,p3]; moving it to index 1 keeps order.
		const out = movePanel(reorderTree(), 'p2', { groupId: 'g3', index: 1 })
		expect(findGroup(out, 'g3')!.panels).toEqual(['p1', 'p2', 'p3'])
		expectStructurallySound(out)
	})

	it('throws for unknown panel or unknown dest group', () => {
		expectRejects(() => movePanel(base(), 'ghost', { groupId: 'g1' }))
		expectRejects(() => movePanel(base(), 'p1', { groupId: 'nope' }))
	})

	it('is pure', () => {
		const t = base()
		const before = frozenCopy(t)
		movePanel(t, 'p1', { groupId: 'g2' })
		expect(t).toEqual(before)
	})
})

// ───────────────────────── splitPanel ─────────────────────────

describe('splitPanel', () => {
	it("'after' wraps origGroup then newGroup in a new split of the given orientation", () => {
		// Single root group g = [p1]. Split p1 column, newPanel q, side after.
		// Expect root replaced by a column split whose children are:
		//   [ tabgroup-with-p1 , tabgroup-with-q ]  (orig BEFORE new for 'after')
		// equal sizes [1,1].
		const t = tree(tabs('g', ['p1'], 'p1'))
		const out = splitPanel(t, 'p1', 'column', 'q', 'after')
		expect(out.root.kind).toBe('split')
		const s = out.root as SplitNode
		expect(s.orientation).toBe('column')
		expect(s.children.length).toBe(2)
		expect(s.sizes).toEqual([1, 1])
		// orig panel group first, new panel group second
		const first = s.children[0] as TabGroupNode
		const second = s.children[1] as TabGroupNode
		expect(first.panels).toContain('p1')
		expect(second.panels).toEqual(['q'])
		expect(second.active).toBe('q')
		expectStructurallySound(out)
	})

	it("'before' places the new panel group first", () => {
		const t = tree(tabs('g', ['p1'], 'p1'))
		const out = splitPanel(t, 'p1', 'row', 'q', 'before')
		const s = out.root as SplitNode
		expect(s.orientation).toBe('row')
		const first = s.children[0] as TabGroupNode
		const second = s.children[1] as TabGroupNode
		expect(first.panels).toEqual(['q'])
		expect(second.panels).toContain('p1')
		expectStructurallySound(out)
	})

	it('extracts atPanel from a multi-panel group into its own group', () => {
		// g = [p1,p2,p3] active p1. Split p2 'after' with newPanel q.
		// p2 is pulled out of g into its own group; g keeps [p1,p3]; new split
		// holds [groupWithP2, groupWithQ].
		const t = tree(tabs('g', ['p1', 'p2', 'p3'], 'p1'))
		const out = splitPanel(t, 'p2', 'row', 'q', 'after')
		// p2 no longer in g.
		const gAfter = groupOf(out, 'p1')!
		expect(gAfter.panels).not.toContain('p2')
		expect(gAfter.panels).toEqual(['p1', 'p3'])
		// p2 and q now live in (different) groups, both present in the tree.
		expect(allPanels(out).sort()).toEqual(['p1', 'p2', 'p3', 'q'])
		const gP2 = groupOf(out, 'p2')!
		const gQ = groupOf(out, 'q')!
		expect(gP2.id).not.toBe(gQ.id)
		expectStructurallySound(out)
	})

	it('throws when atPanelId does not exist', () => {
		expectRejects(() => splitPanel(base(), 'ghost', 'row', 'q', 'after'))
	})

	it('rejects a newPanelId that duplicates an existing panel', () => {
		// p1 already exists; reusing it as the new panel id must throw.
		expectRejects(() => splitPanel(base(), 'p1', 'row', 'p1', 'after'))
		// sanity: a genuinely new panel id still succeeds
		const out = splitPanel(base(), 'p1', 'row', 'q', 'after')
		expect(allPanels(out).sort()).toEqual(['p1', 'p2', 'p3', 'p4', 'q'])
		expectStructurallySound(out)
	})

	it('generates collision-free node ids even when the deterministic id is taken', () => {
		// The impl mints split/group ids off the original group's id with suffixes
		// (__split, __new, __sp, __outer). Pre-seed a node already named 'g__sp'
		// so a naive minting would collide.
		const out = tree(
			split('s0', 'row', [
				tabs('g', ['p1'], 'p1'),
				tabs('g__sp', ['x'], 'x'),
			]),
		)
		const result = splitPanel(out, 'p1', 'column', 'q', 'after')
		const ids = allNodes(result).map(n => n.id)
		expect(new Set(ids).size).toBe(ids.length) // all distinct
		expect(structuralProblems(result)).toEqual([])
		expect(validateTree(result, new Set(allPanels(result)))).toEqual([])
	})

	it('is pure', () => {
		const t = tree(tabs('g', ['p1'], 'p1'))
		const before = frozenCopy(t)
		splitPanel(t, 'p1', 'row', 'q', 'after')
		expect(t).toEqual(before)
	})
})

// ───────────────────────── splitGroup ─────────────────────────

describe('splitGroup', () => {
	it("'after' places the existing group first, the new panel group second", () => {
		const t = tree(tabs('g', ['p1'], 'p1'))
		const out = splitGroup(t, 'g', 'column', 'q', 'after')
		expect(out.root.kind).toBe('split')
		const s = out.root as SplitNode
		expect(s.orientation).toBe('column')
		expect(s.sizes).toEqual([1, 1])
		const first = s.children[0] as TabGroupNode
		const second = s.children[1] as TabGroupNode
		expect(first.id).toBe('g')
		expect(first.panels).toEqual(['p1'])
		expect(second.panels).toEqual(['q'])
		expect(second.active).toBe('q')
		expectStructurallySound(out)
	})

	it("'before' places the new panel group first", () => {
		const t = tree(tabs('g', ['p1'], 'p1'))
		const out = splitGroup(t, 'g', 'row', 'q', 'before')
		const s = out.root as SplitNode
		const first = s.children[0] as TabGroupNode
		const second = s.children[1] as TabGroupNode
		expect(first.panels).toEqual(['q'])
		expect(second.id).toBe('g')
		expect(second.panels).toEqual(['p1'])
		expectStructurallySound(out)
	})

	it('keeps a MULTI-panel group intact as a single unit — unlike splitPanel, no member is stripped out', () => {
		// This is the property that distinguishes splitGroup from splitPanel: the
		// group is resolved by id, not through one of its panels, so every panel it
		// held stays together in the SAME group after the split.
		const t = tree(tabs('g-debug', ['wxml', 'appdata', 'storage', 'console', 'compile'], 'wxml'))
		const out = splitGroup(t, 'g-debug', 'column', 'editor', 'before')
		const debugGroup = findGroup(out, 'g-debug')!
		expect(debugGroup.panels).toEqual(['wxml', 'appdata', 'storage', 'console', 'compile'])
		expect(debugGroup.active).toBe('wxml')
		expect(groupOf(out, 'editor')!.panels).toEqual(['editor'])
		expectStructurallySound(out)
	})

	it('preserves a multi-group tree — only the target group is repositioned', () => {
		const t = base() // row s0: g1[p1,p2], g2[p3,p4]
		const out = splitGroup(t, 'g1', 'column', 'q', 'before')
		// g2 untouched, still a direct sibling structure elsewhere in the tree.
		expect(groupOf(out, 'p3')!.panels).toEqual(['p3', 'p4'])
		expect(groupOf(out, 'p1')!.panels).toEqual(['p1', 'p2'])
		expect(allPanels(out).sort()).toEqual(['p1', 'p2', 'p3', 'p4', 'q'])
		expectStructurallySound(out)
	})

	it('throws when groupId does not exist', () => {
		expectRejects(() => splitGroup(base(), 'ghost', 'row', 'q', 'after'))
	})

	it('rejects a newPanelId that duplicates an existing panel', () => {
		expectRejects(() => splitGroup(base(), 'g1', 'row', 'p1', 'after'))
		// sanity: a genuinely new panel id still succeeds
		const out = splitGroup(base(), 'g1', 'row', 'q', 'after')
		expect(allPanels(out).sort()).toEqual(['p1', 'p2', 'p3', 'p4', 'q'])
		expectStructurallySound(out)
	})

	it('generates collision-free node ids even when the deterministic id is taken', () => {
		const t = tree(
			split('s0', 'row', [
				tabs('g', ['p1'], 'p1'),
				tabs('g__sp', ['x'], 'x'),
			]),
		)
		const out = splitGroup(t, 'g', 'column', 'q', 'after')
		const ids = allNodes(out).map(n => n.id)
		expect(new Set(ids).size).toBe(ids.length) // all distinct
		expect(structuralProblems(out)).toEqual([])
		expect(validateTree(out, new Set(allPanels(out)))).toEqual([])
	})

	it('is pure', () => {
		const t = tree(tabs('g', ['p1'], 'p1'))
		const before = frozenCopy(t)
		splitGroup(t, 'g', 'row', 'q', 'after')
		expect(t).toEqual(before)
	})
})

// ───────────────────────── wrapRoot ─────────────────────────

describe('wrapRoot', () => {
	it("'before' places the new panel group first, wrapping the WHOLE existing tree as the other child", () => {
		const t = base() // row s0: g1[p1,p2], g2[p3,p4]
		const out = wrapRoot(t, 'q', 'row', 'before')
		expect(out.root.kind).toBe('split')
		const s = out.root as SplitNode
		expect(s.orientation).toBe('row')
		expect(s.children.length).toBe(2)
		expect(s.sizes).toEqual([1, 1])
		const first = s.children[0] as TabGroupNode
		expect(first.panels).toEqual(['q'])
		expect(first.active).toBe('q')
		// the OTHER child is the entire original tree, not just one of its groups.
		const second = s.children[1] as SplitNode
		expect(second.id).toBe('s0')
		expect(allPanels(tree(second)).sort()).toEqual(['p1', 'p2', 'p3', 'p4'])
		expectStructurallySound(out)
	})

	it("'after' wraps the existing tree then the new panel group", () => {
		const t = base()
		const out = wrapRoot(t, 'q', 'column', 'after')
		const s = out.root as SplitNode
		expect(s.orientation).toBe('column')
		const first = s.children[0] as SplitNode
		const second = s.children[1] as TabGroupNode
		expect(first.id).toBe('s0')
		expect(second.panels).toEqual(['q'])
		expectStructurallySound(out)
	})

	it('wraps a MULTI-group tree as a single unit — unlike splitPanel, no existing group loses panels', () => {
		// This is the property that distinguishes wrapRoot from splitPanel: the new
		// panel becomes a peer of EVERYTHING already in the tree, so every
		// pre-existing group keeps every panel it had.
		const t = base()
		const out = wrapRoot(t, 'q', 'row', 'before')
		expect(groupOf(out, 'p1')!.panels).toEqual(['p1', 'p2'])
		expect(groupOf(out, 'p3')!.panels).toEqual(['p3', 'p4'])
		expect(allPanels(out).sort()).toEqual(['p1', 'p2', 'p3', 'p4', 'q'])
		expectStructurallySound(out)
	})

	it('wraps a single-group tree same as splitPanel would (degenerate case)', () => {
		const t = tree(tabs('g', ['p1'], 'p1'))
		const out = wrapRoot(t, 'q', 'row', 'before')
		const s = out.root as SplitNode
		expect(s.children.map((c) => (c as TabGroupNode).panels)).toEqual([['q'], ['p1']])
		expectStructurallySound(out)
	})

	it('rejects a newPanelId that duplicates an existing panel', () => {
		expectRejects(() => wrapRoot(base(), 'p1', 'row', 'after'))
		// sanity: a genuinely new panel id still succeeds
		const out = wrapRoot(base(), 'q', 'row', 'after')
		expect(allPanels(out).sort()).toEqual(['p1', 'p2', 'p3', 'p4', 'q'])
		expectStructurallySound(out)
	})

	it('generates collision-free node ids even when the deterministic id is taken', () => {
		// The impl mints ids off the root's own id with `__new` / `__wrap` suffixes.
		// Pre-seed a node already named 's0__wrap' so a naive minting would collide.
		const t = tree(
			split('s0', 'row', [
				tabs('g1', ['p1'], 'p1'),
				tabs('s0__wrap', ['x'], 'x'),
			]),
		)
		const out = wrapRoot(t, 'q', 'column', 'after')
		const ids = allNodes(out).map((n) => n.id)
		expect(new Set(ids).size).toBe(ids.length) // all distinct
		expect(structuralProblems(out)).toEqual([])
		expect(validateTree(out, new Set(allPanels(out)))).toEqual([])
	})

	it('is pure', () => {
		const t = base()
		const before = frozenCopy(t)
		wrapRoot(t, 'q', 'row', 'before')
		expect(t).toEqual(before)
	})
})

// ───────────────────────── ORDER SENSITIVITY / composition ─────────────────────────

describe('operations compose without corrupting the tree (order sensitivity)', () => {
	// Starting tree:
	//   row s0
	//     ├─ g1 [p1, p2]  active p1
	//     └─ g2 [p3, p4]  active p3
	//
	// A) closePanel(p2) THEN movePanel(p1 -> g2)
	// B) movePanel(p1 -> g2) THEN closePanel(p2)
	// Both must yield structurally-sound trees; the panel SETs match but the
	// per-group arrangement differs, proving operations are order-sensitive yet
	// each correct (no corruption either way).
	it('closePanel then movePanel', () => {
		let out = closePanel(base(), 'p2') // g1 -> [p1]
		out = movePanel(out, 'p1', { groupId: 'g2' }) // g1 empties -> collapse
		expectStructurallySound(out)
		// g1 collapsed: root becomes g2 holding all of p3,p4,p1
		expect(out.root.kind).toBe('tabs')
		expect([...(out.root as TabGroupNode).panels].sort()).toEqual(['p1', 'p3', 'p4'])
	})

	it('movePanel then closePanel (different valid result, no corruption)', () => {
		let out = movePanel(base(), 'p1', { groupId: 'g2' }) // g1 -> [p2], g2 -> [p3,p4,p1]
		out = closePanel(out, 'p2') // g1 empties -> collapse -> root = g2
		expectStructurallySound(out)
		expect(out.root.kind).toBe('tabs')
		expect((out.root as TabGroupNode).id).toBe('g2')
		expect([...(out.root as TabGroupNode).panels].sort()).toEqual(['p1', 'p3', 'p4'])
	})

	it('the two orders both reach a sound tree with the same surviving panel set', () => {
		let a = closePanel(base(), 'p2')
		a = movePanel(a, 'p1', { groupId: 'g2' })
		let b = movePanel(base(), 'p1', { groupId: 'g2' })
		b = closePanel(b, 'p2')
		expect(allPanels(a).sort()).toEqual(allPanels(b).sort())
		expect(structuralProblems(a)).toEqual([])
		expect(structuralProblems(b)).toEqual([])
	})
})

// ───────────────────── CONSTRAINT INVARIANT under mutation (M3) ─────────────────────
//
// THE BUG (M3): `validateTree` (serialize.ts) requires every split to keep >= 1
// FLEXIBLE (non-fixed) child — an all-fixed split has no weight-sized child to
// absorb leftover space (rrp v4.10), so `serializeLayout` writes a tree that
// `parseLayout` REJECTS on next launch → the persisted layout is silently lost.
// Two built-in mutations can manufacture exactly that all-fixed split:
//
//   (a) `setConstraint` can mark the LAST flexible child `fixedPx`, leaving a
//       split whose children are ALL fixed (no guard preserves a flexible one).
//   (b) child-removal `normalize` (mutations.ts ~line 44) RETAINS each survivor's
//       constraint, so closing / extracting / moving-away the SOLE flexible child
//       of a split with fixed siblings leaves a multi-child split where EVERY
//       remaining child is fixed.
//
// CONTRACT: NO built-in mutation may return a tree that `validateTree` rejects.
//
// All cases below assert that the mutation layer preserves >= 1 flexible child
// (so validateTree never reports the all-fixed problem).

const knownOf = (t: LayoutTree): ReadonlySet<string> => new Set(allPanels(t))

describe('M3 — no mutation may produce an all-fixed split that validateTree rejects', () => {
	// A 3-child row split: children 0 & 1 fixed, child 2 (g3/p3) the SOLE flexible.
	function twoFixedOneFlexible(): LayoutTree {
		return tree({
			kind: 'split',
			id: 's0',
			orientation: 'row',
			children: [
				tabs('g1', ['p1'], 'p1'),
				tabs('g2', ['p2'], 'p2'),
				tabs('g3', ['p3'], 'p3'),
			],
			sizes: [1, 1, 1],
			constraints: [{ fixedPx: 100 }, { fixedPx: 200 }, null],
		})
	}

	// (a) setConstraint fixing the LAST flexible child must NOT yield an all-fixed
	// split. On HEAD it writes `[{100},{200},{300}]` → validateTree rejects.
	it('setConstraint on the sole flexible child does not create an all-fixed split', () => {
		const t = twoFixedOneFlexible()
		const out = setConstraint(t, 's0', 2, { fixedPx: 300 })
		expect(validateTree(out, knownOf(out)), validateTree(out, knownOf(out)).join('\n')).toEqual([])
	})

	// (b1) closePanel'ing the sole flexible child leaves [g1(fixed), g2(fixed)] —
	// an all-fixed 2-child split on HEAD (normalize keeps both constraints).
	it('closePanel of the sole flexible child yields a validateTree-clean tree', () => {
		const t = twoFixedOneFlexible()
		const out = closePanel(t, 'p3')
		expect(validateTree(out, knownOf(out)), validateTree(out, knownOf(out)).join('\n')).toEqual([])
	})

	// (b2) extractPanel of the sole flexible child — same all-fixed survivor.
	it('extractPanel of the sole flexible child yields a validateTree-clean tree', () => {
		const t = twoFixedOneFlexible()
		const { tree: out } = extractPanel(t, 'p3')
		expect(validateTree(out, knownOf(out)), validateTree(out, knownOf(out)).join('\n')).toEqual([])
	})

	// (b3) movePanel of the sole flexible child OUT to another group leaves the
	// remaining split all-fixed. Move p3 into a separate flexible sibling group so
	// the source split collapses to [g1(fixed), g2(fixed)].
	it('movePanel of the sole flexible child away yields a validateTree-clean tree', () => {
		// Outer row split: [ inner(two-fixed-one-flex) | g-sink ]. Moving p3 into
		// g-sink empties g3 → inner split collapses to the two fixed children.
		const t = tree({
			kind: 'split',
			id: 'root',
			orientation: 'row',
			children: [
				{
					kind: 'split',
					id: 's0',
					orientation: 'row',
					children: [
						tabs('g1', ['p1'], 'p1'),
						tabs('g2', ['p2'], 'p2'),
						tabs('g3', ['p3'], 'p3'),
					],
					sizes: [1, 1, 1],
					constraints: [{ fixedPx: 100 }, { fixedPx: 200 }, null],
				},
				tabs('g-sink', ['p9'], 'p9'),
			],
			sizes: [1, 1],
		})
		const out = movePanel(t, 'p3', { groupId: 'g-sink' })
		expect(validateTree(out, knownOf(out)), validateTree(out, knownOf(out)).join('\n')).toEqual([])
	})
})
