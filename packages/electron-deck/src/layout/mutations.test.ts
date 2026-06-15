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
	setSizes,
	splitPanel,
	validateTree,
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
