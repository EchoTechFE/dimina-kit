/**
 * GAP #4 — serialize / parse / validate: acyclicity + structural integrity.
 *
 * parseLayout MUST throw on every illegal tree below; validateTree MUST return
 * a non-empty problem list for the same. A valid tree round-trips through
 * serialize -> parse and validateTree returns [].
 */
import { describe, expect, it } from 'vitest'
import type { LayoutNode, LayoutTree, SplitNode } from './types.js'
import { parseLayout, serializeLayout, validateTree } from './index.js'
import { allPanels, expectRejects, split, tabs, tree } from './_fixtures.js'

// A canonical valid tree: a row split of two tabgroups.
function validTree(): LayoutTree {
	return tree(
		split('s0', 'row', [
			tabs('g1', ['p1', 'p2'], 'p1'),
			tabs('g2', ['p3'], 'p3'),
		]),
	)
}

const knownOf = (t: LayoutTree): ReadonlySet<string> => new Set(allPanels(t))

describe('serializeLayout / parseLayout — happy path', () => {
	it('serialize produces JSON; parse round-trips to an equal tree', () => {
		const t = validTree()
		const json = serializeLayout(t)
		expect(typeof json).toBe('string')
		expect(() => JSON.parse(json)).not.toThrow()
		const back = parseLayout(json)
		expect(back).toEqual(t)
	})

	it('parsed tree preserves version 1', () => {
		const back = parseLayout(serializeLayout(validTree()))
		expect(back.version).toBe(1)
	})
})

describe('validateTree — happy path', () => {
	it('returns [] for a valid tree with matching knownPanelIds', () => {
		const t = validTree()
		expect(validateTree(t, knownOf(t))).toEqual([])
	})
})

// ───────────────────────── illegal trees ─────────────────────────
//
// For each, both: parseLayout(JSON) throws, and validateTree returns non-empty.

/** Build a raw object then force-cast (bypasses the readonly type guards). */
function bad(root: unknown): LayoutTree {
	return { version: 1, root } as unknown as LayoutTree
}

function expectRejected(t: LayoutTree, known: ReadonlySet<string>): void {
	// validateTree: non-empty problem list.
	expect(validateTree(t, known).length).toBeGreaterThan(0)
	// parseLayout: throws on the serialized form. Some bad trees (cycles, shared
	// refs) can't go through JSON.stringify, so serialize them defensively.
	let json: string
	try {
		json = JSON.stringify(t)
	}
	catch {
		// Cyclic structure — JSON can't represent it, so parseLayout can't receive
		// it as a string. The validateTree assertion above already pins rejection.
		return
	}
	expectRejects(() => parseLayout(json))
}

describe('GAP #4 — validateTree + parseLayout reject illegal structure', () => {
	it('unknown kind (default-DENY)', () => {
		const t = bad({ kind: 'frobnicate', id: 'x' })
		expect(validateTree(t, new Set()).length).toBeGreaterThan(0)
		expectRejects(() => parseLayout(JSON.stringify(t)))
	})

	it('split with sizes.length !== children.length', () => {
		const root: SplitNode = {
			kind: 'split',
			id: 's',
			orientation: 'row',
			children: [tabs('g1', ['p1']), tabs('g2', ['p2'])],
			sizes: [1], // wrong: only one weight for two children
		}
		expectRejected(bad(root), new Set(['p1', 'p2']))
	})

	it('split with a NaN size element', () => {
		const root = bad({
			kind: 'split',
			id: 's',
			orientation: 'row',
			children: [tabs('g1', ['p1']), tabs('g2', ['p2'])],
			sizes: [NaN, 1], // non-finite element
		})
		expectRejected(root, new Set(['p1', 'p2']))
	})

	it('split with an Infinity size element', () => {
		const root = bad({
			kind: 'split',
			id: 's',
			orientation: 'row',
			children: [tabs('g1', ['p1']), tabs('g2', ['p2'])],
			sizes: [Infinity, 1], // non-finite element
		})
		expectRejected(root, new Set(['p1', 'p2']))
	})

	it('split with a non-number (string) size element', () => {
		const root = bad({
			kind: 'split',
			id: 's',
			orientation: 'row',
			children: [tabs('g1', ['p1']), tabs('g2', ['p2'])],
			sizes: ['bad', null], // not numbers at all
		})
		expectRejected(root, new Set(['p1', 'p2']))
	})

	it('tabgroup with active not in panels', () => {
		const root = bad({ kind: 'tabs', id: 'g', panels: ['p1', 'p2'], active: 'pX' })
		expectRejected(root, new Set(['p1', 'p2']))
	})

	it('empty tabgroup', () => {
		const root = bad({ kind: 'tabs', id: 'g', panels: [], active: '' })
		expectRejected(root, new Set())
	})

	it('split with < 2 children', () => {
		const root = bad({
			kind: 'split',
			id: 's',
			orientation: 'row',
			children: [tabs('g1', ['p1'])],
			sizes: [1],
		})
		expectRejected(root, new Set(['p1']))
	})

	it('duplicate node id (two different nodes share an id)', () => {
		const root = split('dup', 'row', [
			tabs('dup', ['p1'], 'p1'), // same id 'dup' as the split
			tabs('g2', ['p2'], 'p2'),
		])
		expectRejected(bad(root), new Set(['p1', 'p2']))
	})

	it('duplicate panel id across two tabgroups (a panel lives in exactly one group)', () => {
		const root = split('s', 'row', [
			tabs('g1', ['shared', 'p1'], 'shared'),
			tabs('g2', ['shared', 'p2'], 'shared'),
		])
		expectRejected(bad(root), new Set(['shared', 'p1', 'p2']))
	})

	it('shared node reference (same node object appears twice)', () => {
		const shared = tabs('g1', ['p1'], 'p1')
		const root = split('s', 'row', [shared, shared])
		// Note: duplicate ids will also trip, but the SHARED-REF invariant is the point.
		expectRejected(bad(root), new Set(['p1']))
	})

	it('cycle (a node reachable from itself)', () => {
		const a = split('a', 'row', [tabs('g1', ['p1'], 'p1'), tabs('g2', ['p2'], 'p2')])
		// Force a back-edge: a's first child points back to a.
		;(a.children as LayoutNode[])[0] = a
		expectRejected(bad(a), new Set(['p1', 'p2']))
	})

	it('excessive depth: depth > 64 is rejected', () => {
		// Build a deeply-left-nested chain of splits. Each split needs >= 2
		// children, so pair the deep chain with a sibling tabgroup at each level.
		let node: LayoutNode = tabs('leaf', ['pLeaf'], 'pLeaf')
		const panels = new Set<string>(['pLeaf'])
		for (let i = 0; i < 70; i++) {
			const sibId = `sib${i}`
			panels.add(sibId)
			node = split(`d${i}`, 'row', [node, tabs(`gs${i}`, [sibId], sibId)])
		}
		expectRejected(bad(node), panels)
	})

	it('orphan panel: a panel in the tree not in knownPanelIds', () => {
		const t = validTree() // panels p1,p2,p3
		const known = new Set(['p1', 'p2']) // p3 missing -> orphan
		const problems = validateTree(t, known)
		expect(problems.length).toBeGreaterThan(0)
		expect(problems.join('\n')).toContain('p3')
	})

	it('valid tree with a SUPERSET knownPanelIds is still ok (extra known panels allowed)', () => {
		const t = validTree()
		const known = new Set([...allPanels(t), 'extra-not-in-tree'])
		expect(validateTree(t, known)).toEqual([])
	})
})

describe('parseLayout — input hardening', () => {
	it('throws on non-JSON input', () => {
		expectRejects(() => parseLayout('}{not json'))
	})

	it('throws on wrong version', () => {
		const t = { version: 2, root: tabs('g', ['p'], 'p') }
		expectRejects(() => parseLayout(JSON.stringify(t)))
	})

	it('throws when root is missing', () => {
		expectRejects(() => parseLayout(JSON.stringify({ version: 1 })))
	})
})
