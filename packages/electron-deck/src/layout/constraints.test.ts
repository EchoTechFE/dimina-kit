/**
 * T1 — per-child fixed-px size constraint on SplitNode.
 *
 * CONTRACT under test (the implementer MUST match these):
 *
 * - `SplitNode` gains an OPTIONAL field `constraints?: readonly (SizeConstraint | null)[]`.
 * - `SizeConstraint` is a new exported type `{ readonly fixedPx: number }` where
 *   `fixedPx` must be a finite number > 0.
 * - When present, `constraints` has the SAME length as `children` (and `sizes`).
 *     constraints[i] === null         => child i is weight-sized (uses sizes[i]).
 *     constraints[i] === {fixedPx:N}  => child i is locked to N pixels.
 *   Field ENTIRELY ABSENT (undefined) => legacy behavior; existing trees unaffected.
 *
 * - `setConstraint(t, splitId, childIndex, constraint)` is a new pure mutation.
 *
 * ALL-NULL CHOICE (item 4): we KEEP the array. After clearing the last non-null
 * constraint, `constraints` remains an all-null array of the same length (it is
 * NOT dropped to undefined). This is asserted explicitly below.
 *
 * These tests are RED until the feature exists (missing type / missing export).
 */
import { describe, expect, it } from 'vitest'
import type { LayoutTree, SplitNode } from './types.js'
import {
	closePanel,
	parseLayout,
	serializeLayout,
	setConstraint,
	setSizes,
	validateTree,
} from './index.js'
import { allPanels, expectRejects, split, structuralProblems, tabs, tree } from './_fixtures.js'

const knownOf = (t: LayoutTree): ReadonlySet<string> => new Set(allPanels(t))

function frozenCopy(t: LayoutTree): LayoutTree {
	return JSON.parse(JSON.stringify(t)) as LayoutTree
}

/**
 * Like `expectRejects`, but ALSO fails if the throw is merely
 * `setConstraint is not a function` — i.e. the function doesn't exist yet. This
 * stops the negative-path tests from false-greening against the absent feature:
 * they must throw a REAL domain rejection (split-not-found / index-out-of-range),
 * not a TypeError from calling `undefined`.
 */
function expectDomainRejects(fn: () => unknown): void {
	let thrown: unknown
	let didThrow = false
	try {
		fn()
	}
	catch (e) {
		didThrow = true
		thrown = e
	}
	if (!didThrow) {
		throw new Error('expected the call to throw, but it returned normally')
	}
	const msg = thrown instanceof Error ? thrown.message : String(thrown)
	if (/is not a function/.test(msg)) {
		throw new Error(`setConstraint is not implemented yet (got: ${msg})`)
	}
	if (msg === 'not-implemented') {
		throw new Error('still hitting the not-implemented stub — expected a real domain rejection')
	}
}

// A canonical two-child row split (no constraints — legacy shape).
function legacyTree(): LayoutTree {
	return tree(
		split('s0', 'row', [
			tabs('g1', ['p1', 'p2'], 'p1'),
			tabs('g2', ['p3'], 'p3'),
		]),
	)
}

/** A two-child split WITH a constraints field (child 0 fixed, child 1 weight). */
function constrainedSplit(): SplitNode {
	return {
		kind: 'split',
		id: 's0',
		orientation: 'row',
		children: [tabs('g1', ['p1'], 'p1'), tabs('g2', ['p2'], 'p2')],
		sizes: [1, 1],
		constraints: [{ fixedPx: 240 }, null],
	}
}

/** Build a raw root then force-cast (bypasses readonly type guards) — for the
 * deliberately-malformed validateTree cases. Mirrors serialize.test.ts `bad`. */
function bad(root: unknown): LayoutTree {
	return { version: 1, root } as unknown as LayoutTree
}

// ───────────────────────── 1. backward compat ─────────────────────────

describe('T1 constraints — backward compatibility (field absent)', () => {
	it('a legacy SplitNode round-trips identically and injects NO constraints key', () => {
		const t = legacyTree()
		const json = serializeLayout(t)
		// The serialized form must not mention constraints at all.
		expect(json).not.toContain('constraints')
		const back = parseLayout(json)
		expect(back).toEqual(t)
		// No constraints key materialized on the parsed split.
		const s = back.root as SplitNode
		expect('constraints' in s).toBe(false)
		expect(s.constraints).toBeUndefined()
	})

	it('validateTree still returns [] for a legacy tree (no constraints)', () => {
		const t = legacyTree()
		expect(validateTree(t, knownOf(t))).toEqual([])
	})
})

// ───────────────────────── 2. serialize / parse round-trip ─────────────────────────

describe('T1 constraints — serialize/parse round-trip (field present)', () => {
	it('a split WITH a mix of {fixedPx} and null survives serialize -> parse unchanged', () => {
		const t = tree(constrainedSplit())
		const back = parseLayout(serializeLayout(t))
		expect(back).toEqual(t)
		const s = back.root as SplitNode
		expect(s.constraints).toEqual([{ fixedPx: 240 }, null])
	})

	it('a parsed constrained tree validates clean', () => {
		const t = tree(constrainedSplit())
		const back = parseLayout(serializeLayout(t))
		expect(validateTree(back, knownOf(back))).toEqual([])
	})
})

// ───────────────────────── 3. validateTree on constrained trees ─────────────────────────

describe('T1 constraints — validateTree rules', () => {
	it('OK: constraints length == children length, each null or {fixedPx:finite>0}', () => {
		const t = tree({
			kind: 'split',
			id: 's0',
			orientation: 'row',
			children: [tabs('g1', ['p1'], 'p1'), tabs('g2', ['p2'], 'p2'), tabs('g3', ['p3'], 'p3')],
			sizes: [1, 1, 1],
			constraints: [{ fixedPx: 100 }, null, { fixedPx: 0.5 }],
		})
		expect(validateTree(t, knownOf(t))).toEqual([])
		// also survives a real parse (default-DENY path)
		expect(() => parseLayout(serializeLayout(t))).not.toThrow()
	})

	it('PROBLEM: constraints.length != children.length — message names the split id and "constraint"', () => {
		const t = bad({
			kind: 'split',
			id: 'sX',
			orientation: 'row',
			children: [tabs('g1', ['p1'], 'p1'), tabs('g2', ['p2'], 'p2')],
			sizes: [1, 1],
			constraints: [{ fixedPx: 100 }], // wrong length (1 != 2)
		})
		const problems = validateTree(t, new Set(['p1', 'p2']))
		expect(problems.length).toBeGreaterThan(0)
		const joined = problems.join('\n')
		expect(joined).toContain('sX')
		expect(joined).toContain('constraint')
		// default-DENY: parseLayout must reject the serialized form too.
		expectRejects(() => parseLayout(JSON.stringify(t)))
	})

	it('PROBLEM: a constraint with fixedPx <= 0', () => {
		const t = bad({
			kind: 'split',
			id: 'sZero',
			orientation: 'row',
			children: [tabs('g1', ['p1'], 'p1'), tabs('g2', ['p2'], 'p2')],
			sizes: [1, 1],
			constraints: [{ fixedPx: 0 }, null],
		})
		const problems = validateTree(t, new Set(['p1', 'p2']))
		expect(problems.length).toBeGreaterThan(0)
		expect(problems.join('\n')).toContain('sZero')
		expect(problems.join('\n')).toContain('constraint')
		expectRejects(() => parseLayout(JSON.stringify(t)))
	})

	it('PROBLEM: a constraint with negative fixedPx', () => {
		const t = bad({
			kind: 'split',
			id: 'sNeg',
			orientation: 'row',
			children: [tabs('g1', ['p1'], 'p1'), tabs('g2', ['p2'], 'p2')],
			sizes: [1, 1],
			constraints: [null, { fixedPx: -10 }],
		})
		const problems = validateTree(t, new Set(['p1', 'p2']))
		expect(problems.length).toBeGreaterThan(0)
		expect(problems.join('\n')).toContain('constraint')
		expectRejects(() => parseLayout(JSON.stringify(t)))
	})

	it('PROBLEM: a constraint with non-finite fixedPx (NaN / Infinity)', () => {
		const nan = bad({
			kind: 'split',
			id: 'sNaN',
			orientation: 'row',
			children: [tabs('g1', ['p1'], 'p1'), tabs('g2', ['p2'], 'p2')],
			sizes: [1, 1],
			constraints: [{ fixedPx: NaN }, null],
		})
		expect(validateTree(nan, new Set(['p1', 'p2'])).join('\n')).toContain('constraint')
		expectRejects(() => parseLayout(JSON.stringify(nan)))

		const inf = bad({
			kind: 'split',
			id: 'sInf',
			orientation: 'row',
			children: [tabs('g1', ['p1'], 'p1'), tabs('g2', ['p2'], 'p2')],
			sizes: [1, 1],
			constraints: [null, { fixedPx: Infinity }],
		})
		expect(validateTree(inf, new Set(['p1', 'p2'])).join('\n')).toContain('constraint')
		expectRejects(() => parseLayout(JSON.stringify(inf)))
	})

	it('PROBLEM: a constraint missing fixedPx / fixedPx is not a number', () => {
		const missing = bad({
			kind: 'split',
			id: 'sMiss',
			orientation: 'row',
			children: [tabs('g1', ['p1'], 'p1'), tabs('g2', ['p2'], 'p2')],
			sizes: [1, 1],
			constraints: [{}, null], // fixedPx missing entirely
		})
		expect(validateTree(missing, new Set(['p1', 'p2'])).join('\n')).toContain('constraint')
		expectRejects(() => parseLayout(JSON.stringify(missing)))

		const nonNumber = bad({
			kind: 'split',
			id: 'sStr',
			orientation: 'row',
			children: [tabs('g1', ['p1'], 'p1'), tabs('g2', ['p2'], 'p2')],
			sizes: [1, 1],
			constraints: [{ fixedPx: '240' }, null], // string, not a number
		})
		expect(validateTree(nonNumber, new Set(['p1', 'p2'])).join('\n')).toContain('constraint')
		expectRejects(() => parseLayout(JSON.stringify(nonNumber)))
	})

	// FIX B (strict-key): a constraint object carrying EXTRA keys beyond `fixedPx`
	// must be rejected so junk can't survive round-trip.
	it('PROBLEM: a constraint object with an extra key (besides fixedPx)', () => {
		const t = bad({
			kind: 'split',
			id: 'sExtra',
			orientation: 'row',
			children: [tabs('g1', ['p1'], 'p1'), tabs('g2', ['p2'], 'p2')],
			sizes: [1, 1],
			constraints: [{ fixedPx: 200, mode: 'x' }, null], // extra `mode` key
		})
		const problems = validateTree(t, new Set(['p1', 'p2']))
		expect(problems.length).toBeGreaterThan(0)
		const joined = problems.join('\n')
		expect(joined).toContain('sExtra')
		expect(joined).toContain('constraint')
		expectRejects(() => parseLayout(JSON.stringify(t)))
	})

	// FIX C: an intrinsically-malformed constraints array must be reported even
	// when `children` is ALSO malformed (the constraint format check must not be
	// gated behind children validity).
	it('PROBLEM: malformed children AND a malformed constraint both reported', () => {
		const t = bad({
			kind: 'split',
			id: 'sBoth',
			orientation: 'row',
			children: 'not-an-array', // malformed children
			sizes: [1, 1],
			constraints: [{ fixedPx: -5 }, null], // malformed constraint (fixedPx <= 0)
		})
		const problems = validateTree(t, new Set(['p1', 'p2']))
		const joined = problems.join('\n')
		// children problem is present...
		expect(joined).toContain('children')
		// ...AND the constraint problem is present (the point of FIX C).
		expect(joined).toContain('constraint')
		expect(joined).toContain('sBoth')
	})

	// FIX D: an all-fixed-px split (every constraint non-null) has no flexible
	// child to absorb leftover space — rrp v4.10 requires >= 1 weight-sized.
	it('PROBLEM: a split where EVERY child carries a fixedPx constraint', () => {
		const t = bad({
			kind: 'split',
			id: 'sAllFixed',
			orientation: 'row',
			children: [tabs('g1', ['p1'], 'p1'), tabs('g2', ['p2'], 'p2')],
			sizes: [1, 1],
			constraints: [{ fixedPx: 100 }, { fixedPx: 200 }], // no flexible child
		})
		const problems = validateTree(t, new Set(['p1', 'p2']))
		const joined = problems.join('\n')
		expect(joined).toContain('sAllFixed')
		expect(joined).toContain('constraint')
		expectRejects(() => parseLayout(JSON.stringify(t)))
	})

	it('OK: a split with at least one null (flexible) constraint is accepted', () => {
		const t = tree({
			kind: 'split',
			id: 's0',
			orientation: 'row',
			children: [tabs('g1', ['p1'], 'p1'), tabs('g2', ['p2'], 'p2')],
			sizes: [1, 1],
			constraints: [{ fixedPx: 100 }, null], // one flexible child present
		})
		expect(validateTree(t, knownOf(t))).toEqual([])
	})
})

// ───────────────────────── 4. setConstraint mutation ─────────────────────────

describe('T1 constraints — setConstraint mutation', () => {
	it('lazily creates an all-null constraints array, then sets the named child', () => {
		const t = legacyTree() // s0 has no constraints field
		const before = frozenCopy(t)
		const out = setConstraint(t, 's0', 0, { fixedPx: 320 })
		// pure
		expect(out).not.toBe(t)
		expect(t).toEqual(before)
		const s = out.root as SplitNode
		expect(s.constraints).toEqual([{ fixedPx: 320 }, null])
		// length invariant
		expect(s.constraints!.length).toBe(s.children.length)
		// still a structurally-sound, valid tree
		expect(structuralProblems(out)).toEqual([])
		expect(validateTree(out, knownOf(out))).toEqual([])
	})

	it('clears a child constraint back to null', () => {
		const t = tree(constrainedSplit()) // constraints [{240}, null]
		const out = setConstraint(t, 's0', 0, null)
		const s = out.root as SplitNode
		// ALL-NULL CHOICE: array is KEPT (not dropped), filled with null.
		expect(s.constraints).toEqual([null, null])
		expect(s.constraints!.length).toBe(s.children.length)
		expect(validateTree(out, knownOf(out))).toEqual([])
	})

	it('updates an existing child constraint without disturbing siblings', () => {
		const t = tree({
			kind: 'split',
			id: 's0',
			orientation: 'row',
			children: [tabs('g1', ['p1'], 'p1'), tabs('g2', ['p2'], 'p2'), tabs('g3', ['p3'], 'p3')],
			sizes: [1, 1, 1],
			constraints: [{ fixedPx: 100 }, null, { fixedPx: 300 }],
		})
		const out = setConstraint(t, 's0', 1, { fixedPx: 200 })
		const s = out.root as SplitNode
		expect(s.constraints).toEqual([{ fixedPx: 100 }, { fixedPx: 200 }, { fixedPx: 300 }])
	})

	it('throws when the split id is not found', () => {
		expectDomainRejects(() => setConstraint(legacyTree(), 'nope', 0, { fixedPx: 100 }))
	})

	it('throws when childIndex is out of range (negative or >= children.length)', () => {
		expectDomainRejects(() => setConstraint(legacyTree(), 's0', 2, { fixedPx: 100 }))
		expectDomainRejects(() => setConstraint(legacyTree(), 's0', -1, { fixedPx: 100 }))
	})

	// FIX A: a non-integer / NaN childIndex must be rejected BEFORE the range
	// check; otherwise 0.5 / NaN pass `<0 || >=length` and write a non-index
	// property, returning a structurally-corrupt array.
	it('throws when childIndex is a non-integer (0.5) or NaN', () => {
		expectDomainRejects(() => setConstraint(legacyTree(), 's0', 0.5, { fixedPx: 100 }))
		expectDomainRejects(() => setConstraint(legacyTree(), 's0', Number.NaN, { fixedPx: 100 }))
		// the corrupt-write footgun: a fractional index must not silently mint a
		// bogus property on the constraints array.
		expect(() => setConstraint(legacyTree(), 's0', 0.5, { fixedPx: 100 })).toThrow(/integer/)
	})
})

// ───────────── 5. existing mutations stay correct with constraints present ─────────────

describe('T1 constraints — existing mutations preserve constraints', () => {
	it('setSizes does not touch constraints', () => {
		const t = tree(constrainedSplit()) // sizes [1,1], constraints [{240}, null]
		const out = setSizes(t, 's0', [3, 7])
		const s = out.root as SplitNode
		expect(s.sizes).toEqual([3, 7])
		// constraints unchanged and still aligned
		expect(s.constraints).toEqual([{ fixedPx: 240 }, null])
		expect(s.constraints!.length).toBe(s.children.length)
	})

	it('closing a DIFFERENT child keeps the surviving fixedPx child aligned with its constraint', () => {
		// 3-child split; the MIDDLE child (index 1) is fixed at 240px.
		// Each child is a single-panel tabgroup so closing its panel drops that child.
		const t = tree({
			kind: 'split',
			id: 's0',
			orientation: 'row',
			children: [
				tabs('g0', ['p0'], 'p0'),
				tabs('g1', ['p1'], 'p1'), // the fixed one
				tabs('g2', ['p2'], 'p2'),
			],
			sizes: [1, 1, 1],
			constraints: [null, { fixedPx: 240 }, null],
		})

		// Close p0 (a DIFFERENT child). That empties g0 -> child 0 dropped.
		// Surviving children: [g1(fixed), g2]. The fixed constraint must follow g1.
		const out = closePanel(t, 'p0')
		const s = out.root as SplitNode
		expect(s.kind).toBe('split')
		expect(s.children.map(c => c.id)).toEqual(['g1', 'g2'])
		expect(s.constraints).toBeDefined()
		expect(s.constraints!.length).toBe(s.children.length)
		// g1 is now at index 0 and must still carry its fixedPx constraint.
		expect(s.constraints![0]).toEqual({ fixedPx: 240 })
		expect(s.constraints![1]).toBeNull()
		// sizes alignment also preserved (sanity, mirrors the constraint slot rule).
		expect(s.sizes.length).toBe(s.children.length)
		expect(structuralProblems(out)).toEqual([])
		expect(validateTree(out, knownOf(out))).toEqual([])
	})
})
