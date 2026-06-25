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

// ─────────────────────── characterization tests ───────────────────────
//
// Lock the CURRENT observable behavior of collectProblems / validateTree /
// parseLayout so that a structural refactor cannot silently change any branch.
// Each test pins an exact problem string or throw message captured from the
// running implementation.

/** Cast an arbitrary value as a LayoutTree without the type system complaining. */
function raw(root: unknown): LayoutTree {
	return { version: 1, root } as unknown as LayoutTree
}

describe('validateTree — top-level guards (exact messages)', () => {
	it('returns [tree is not an object] for a null tree', () => {
		expect(validateTree(null as unknown as LayoutTree, new Set())).toEqual([
			'tree is not an object',
		])
	})

	it('returns [unsupported version: 2] for version 2', () => {
		const t = { version: 2, root: tabs('g1', ['p'], 'p') } as unknown as LayoutTree
		expect(validateTree(t, new Set(['p']))).toEqual(['unsupported version: 2'])
	})

	it('returns [unsupported version: undefined] for a tree with no version field', () => {
		const t = { root: tabs('g1', ['p'], 'p') } as unknown as LayoutTree
		expect(validateTree(t, new Set(['p']))).toEqual(['unsupported version: undefined'])
	})
})

describe('parseLayout — exact throw messages', () => {
	it('message: parseLayout: input is not valid JSON', () => {
		expect(() => parseLayout('}{bad')).toThrow('parseLayout: input is not valid JSON')
	})

	it('message: parseLayout: top-level value is not an object', () => {
		expect(() => parseLayout('"hello"')).toThrow(
			'parseLayout: top-level value is not an object',
		)
	})

	it('message: parseLayout: unsupported version 2', () => {
		expect(() =>
			parseLayout(JSON.stringify({ version: 2, root: tabs('g', ['p'], 'p') })),
		).toThrow('parseLayout: unsupported version 2')
	})

	it('message: parseLayout: missing root — null root', () => {
		expect(() => parseLayout(JSON.stringify({ version: 1, root: null }))).toThrow(
			'parseLayout: missing root',
		)
	})

	it('message: parseLayout: missing root — absent root', () => {
		expect(() => parseLayout(JSON.stringify({ version: 1 }))).toThrow(
			'parseLayout: missing root',
		)
	})
})

describe('collectProblems — non-object node branch', () => {
	it('number child of split → "node is not an object: 42"', () => {
		const t = raw(
			split('s', 'row', [tabs('g1', ['p1'], 'p1'), tabs('g2', ['p2'], 'p2')]),
		)
		// Inject a non-object second child via a double-cast to bypass the readonly typed array.
		;(t.root as unknown as { children: unknown[] }).children[1] = 42
		expect(validateTree(t, new Set(['p1', 'p2']))).toEqual(['node is not an object: 42'])
	})

	it('null child of split → "node is not an object: null"', () => {
		const t = raw(
			split('s', 'row', [tabs('g1', ['p1'], 'p1'), tabs('g2', ['p2'], 'p2')]),
		)
		;(t.root as unknown as { children: unknown[] }).children[1] = null
		expect(validateTree(t, new Set(['p1', 'p2']))).toEqual(['node is not an object: null'])
	})

	it('undefined child of split → "node is not an object: undefined"', () => {
		const t = raw(
			split('s', 'row', [tabs('g1', ['p1'], 'p1'), tabs('g2', ['p2'], 'p2')]),
		)
		;(t.root as unknown as { children: unknown[] }).children[1] = undefined
		expect(validateTree(t, new Set(['p1', 'p2']))).toEqual([
			'node is not an object: undefined',
		])
	})
})

describe('collectProblems — missing / duplicate node id', () => {
	it('tabs node with no id → "node missing string id (kind=tabs)"', () => {
		const t = raw({ kind: 'tabs', panels: ['p1'], active: 'p1' })
		expect(validateTree(t, new Set(['p1']))).toContain('node missing string id (kind=tabs)')
	})

	it('split node with no id → "node missing string id (kind=split)"', () => {
		const t = raw({
			kind: 'split',
			orientation: 'row',
			children: [tabs('g1', ['p1'], 'p1'), tabs('g2', ['p2'], 'p2')],
			sizes: [1, 1],
		})
		expect(validateTree(t, new Set(['p1', 'p2']))).toContain(
			'node missing string id (kind=split)',
		)
	})
})

describe('collectProblems — tabs node: panels validation', () => {
	it('panels is not an array → "tabs g: panels is not an array"', () => {
		const t = raw({ kind: 'tabs', id: 'g', panels: 'bad', active: 'p1' })
		expect(validateTree(t, new Set(['p1']))).toEqual(['tabs g: panels is not an array'])
	})

	it('non-string panel id in array → "tabs g: non-string panel id"', () => {
		const t = raw({ kind: 'tabs', id: 'g', panels: [42, 'p1'], active: 'p1' })
		expect(validateTree(t, new Set(['p1']))).toContain('tabs g: non-string panel id')
	})

	it('tabs active is non-string → "tabs g: active 42 not in panels"', () => {
		const t = raw({ kind: 'tabs', id: 'g', panels: ['p1'], active: 42 })
		expect(validateTree(t, new Set(['p1']))).toEqual(['tabs g: active 42 not in panels'])
	})

	it('duplicate panel id within same group → "duplicate panel id across groups: p1"', () => {
		// The panelOwners map triggers even within the same tabgroup on the second occurrence.
		const t = raw({ kind: 'tabs', id: 'g', panels: ['p1', 'p1'], active: 'p1' })
		expect(validateTree(t, new Set(['p1']))).toContain('duplicate panel id across groups: p1')
	})
})

describe('collectProblems — split: orientation', () => {
	it('invalid orientation → "split s: invalid orientation diagonal"', () => {
		const t = raw({
			kind: 'split',
			id: 's',
			orientation: 'diagonal',
			children: [tabs('g1', ['p1'], 'p1'), tabs('g2', ['p2'], 'p2')],
			sizes: [1, 1],
		})
		expect(validateTree(t, new Set(['p1', 'p2']))).toContain(
			'split s: invalid orientation diagonal',
		)
	})
})

describe('collectProblems — split: sizes', () => {
	it('sizes absent → "split s: sizes missing != children 2"', () => {
		const t = raw({
			kind: 'split',
			id: 's',
			orientation: 'row',
			children: [tabs('g1', ['p1'], 'p1'), tabs('g2', ['p2'], 'p2')],
		})
		expect(validateTree(t, new Set(['p1', 'p2']))).toContain(
			'split s: sizes missing != children 2',
		)
	})
})

describe('collectProblems — split: constraints validation', () => {
	it('constraints is not an array → "split s: constraints is not an array"', () => {
		const t = raw({
			kind: 'split',
			id: 's',
			orientation: 'row',
			children: [tabs('g1', ['p1'], 'p1'), tabs('g2', ['p2'], 'p2')],
			sizes: [1, 1],
			constraints: 'bad',
		})
		expect(validateTree(t, new Set(['p1', 'p2']))).toEqual([
			'split s: constraints is not an array',
		])
	})

	it('constraint entry is a number → "split s: constraint is not null nor an object: 42"', () => {
		const t = raw({
			kind: 'split',
			id: 's',
			orientation: 'row',
			children: [tabs('g1', ['p1'], 'p1'), tabs('g2', ['p2'], 'p2')],
			sizes: [1, 1],
			constraints: [null, 42],
		})
		expect(validateTree(t, new Set(['p1', 'p2']))).toEqual([
			"split s: constraint is not null nor an object: 42",
		])
	})

	it('constraint has both fixedPx and minPx → exact wrong-keys message', () => {
		const t = raw({
			kind: 'split',
			id: 's',
			orientation: 'row',
			children: [tabs('g1', ['p1'], 'p1'), tabs('g2', ['p2'], 'p2')],
			sizes: [1, 1],
			constraints: [null, { fixedPx: 100, minPx: 50 }],
		})
		expect(validateTree(t, new Set(['p1', 'p2']))).toEqual([
			"split s: constraint must have exactly one of 'fixedPx' or 'minPx', got [fixedPx, minPx]",
		])
	})

	it('constraint is {} → two problems: wrong-keys + undefined value', () => {
		const t = raw({
			kind: 'split',
			id: 's',
			orientation: 'row',
			children: [tabs('g1', ['p1'], 'p1'), tabs('g2', ['p2'], 'p2')],
			sizes: [1, 1],
			constraints: [null, {}],
		})
		expect(validateTree(t, new Set(['p1', 'p2']))).toEqual([
			"split s: constraint must have exactly one of 'fixedPx' or 'minPx', got []",
			"split s: constraint minPx must be a finite number > 0, got undefined",
		])
	})

	it('constraint has unknown key → two problems: wrong-keys + undefined value', () => {
		const t = raw({
			kind: 'split',
			id: 's',
			orientation: 'row',
			children: [tabs('g1', ['p1'], 'p1'), tabs('g2', ['p2'], 'p2')],
			sizes: [1, 1],
			constraints: [null, { badKey: 100 }],
		})
		expect(validateTree(t, new Set(['p1', 'p2']))).toEqual([
			"split s: constraint must have exactly one of 'fixedPx' or 'minPx', got [badKey]",
			"split s: constraint minPx must be a finite number > 0, got undefined",
		])
	})

	it('constraint fixedPx extra key → wrong-keys message (value check skipped because wrong key count)', () => {
		const t = raw({
			kind: 'split',
			id: 's',
			orientation: 'row',
			children: [tabs('g1', ['p1'], 'p1'), tabs('g2', ['p2'], 'p2')],
			sizes: [1, 1],
			constraints: [null, { fixedPx: 100, extra: 'bad' }],
		})
		expect(validateTree(t, new Set(['p1', 'p2']))).toEqual([
			"split s: constraint must have exactly one of 'fixedPx' or 'minPx', got [fixedPx, extra]",
		])
	})

	it('constraint fixedPx is negative → "split s: constraint fixedPx must be a finite number > 0, got -1"', () => {
		const t = raw({
			kind: 'split',
			id: 's',
			orientation: 'row',
			children: [tabs('g1', ['p1'], 'p1'), tabs('g2', ['p2'], 'p2')],
			sizes: [1, 1],
			constraints: [null, { fixedPx: -1 }],
		})
		expect(validateTree(t, new Set(['p1', 'p2']))).toEqual([
			'split s: constraint fixedPx must be a finite number > 0, got -1',
		])
	})

	it('constraint minPx is zero → "split s: constraint minPx must be a finite number > 0, got 0"', () => {
		const t = raw({
			kind: 'split',
			id: 's',
			orientation: 'row',
			children: [tabs('g1', ['p1'], 'p1'), tabs('g2', ['p2'], 'p2')],
			sizes: [1, 1],
			constraints: [null, { minPx: 0 }],
		})
		expect(validateTree(t, new Set(['p1', 'p2']))).toEqual([
			'split s: constraint minPx must be a finite number > 0, got 0',
		])
	})

	it('constraint fixedPx is NaN → "split s: constraint fixedPx must be a finite number > 0, got NaN"', () => {
		const t = raw({
			kind: 'split',
			id: 's',
			orientation: 'row',
			children: [tabs('g1', ['p1'], 'p1'), tabs('g2', ['p2'], 'p2')],
			sizes: [1, 1],
			constraints: [null, { fixedPx: Number.NaN }],
		})
		expect(validateTree(t, new Set(['p1', 'p2']))).toEqual([
			'split s: constraint fixedPx must be a finite number > 0, got NaN',
		])
	})

	it('all children fixedPx → all-px-sized guard fires', () => {
		const t = raw({
			kind: 'split',
			id: 's',
			orientation: 'row',
			children: [tabs('g1', ['p1'], 'p1'), tabs('g2', ['p2'], 'p2')],
			sizes: [1, 1],
			constraints: [{ fixedPx: 100 }, { fixedPx: 200 }],
		})
		expect(validateTree(t, new Set(['p1', 'p2']))).toEqual([
			'split s: all children are px-sized constraints; at least one must be weight-sized',
		])
	})

	it('all children minPx also triggers all-px-sized guard (minPx is also px-sized)', () => {
		const t = raw({
			kind: 'split',
			id: 's',
			orientation: 'row',
			children: [tabs('g1', ['p1'], 'p1'), tabs('g2', ['p2'], 'p2')],
			sizes: [1, 1],
			constraints: [{ minPx: 100 }, { minPx: 200 }],
		})
		expect(validateTree(t, new Set(['p1', 'p2']))).toEqual([
			'split s: all children are px-sized constraints; at least one must be weight-sized',
		])
	})

	it('one null among fixedPx constraints disarms the all-px guard → no problems', () => {
		const t = raw({
			kind: 'split',
			id: 's',
			orientation: 'row',
			children: [tabs('g1', ['p1'], 'p1'), tabs('g2', ['p2'], 'p2'), tabs('g3', ['p3'], 'p3')],
			sizes: [1, 1, 1],
			constraints: [{ fixedPx: 100 }, { fixedPx: 200 }, null],
		})
		expect(validateTree(t, new Set(['p1', 'p2', 'p3']))).toEqual([])
	})

	it('constraints length < children length → "split s: constraints 1 != children 2"', () => {
		const t = raw({
			kind: 'split',
			id: 's',
			orientation: 'row',
			children: [tabs('g1', ['p1'], 'p1'), tabs('g2', ['p2'], 'p2')],
			sizes: [1, 1],
			constraints: [null],
		})
		expect(validateTree(t, new Set(['p1', 'p2']))).toContain(
			'split s: constraints 1 != children 2',
		)
	})

	it('empty constraints array (0) with 2 children → "split s: constraints 0 != children 2"', () => {
		const t = raw({
			kind: 'split',
			id: 's',
			orientation: 'row',
			children: [tabs('g1', ['p1'], 'p1'), tabs('g2', ['p2'], 'p2')],
			sizes: [1, 1],
			constraints: [],
		})
		expect(validateTree(t, new Set(['p1', 'p2']))).toContain(
			'split s: constraints 0 != children 2',
		)
	})

	it('[null, {minPx: 100}] is valid — no problems', () => {
		const t = raw({
			kind: 'split',
			id: 's',
			orientation: 'row',
			children: [tabs('g1', ['p1'], 'p1'), tabs('g2', ['p2'], 'p2')],
			sizes: [1, 1],
			constraints: [null, { minPx: 100 }],
		})
		expect(validateTree(t, new Set(['p1', 'p2']))).toEqual([])
	})

	it('[null, {fixedPx: 100}] is valid — no problems', () => {
		const t = raw({
			kind: 'split',
			id: 's',
			orientation: 'row',
			children: [tabs('g1', ['p1'], 'p1'), tabs('g2', ['p2'], 'p2')],
			sizes: [1, 1],
			constraints: [null, { fixedPx: 100 }],
		})
		expect(validateTree(t, new Set(['p1', 'p2']))).toEqual([])
	})
})
