/**
 * GAP #2 — observable model: single-writer, synchronous, call-ordered.
 *
 * Pinned conventions (implementer MUST match):
 *  - revision starts at 0 for the INITIAL tree.
 *  - subscribe() does NOT immediately replay the current snapshot. The first
 *    emission a subscriber receives is on the first successful apply, carrying
 *    revision 1. (Chosen per the design recommendation.)
 *  - revision increments by exactly +1 on each SUCCESSFUL apply.
 *  - if a mutation throws, revision does NOT advance and NO subscriber is
 *    notified; get() still returns the pre-apply tree.
 *  - applies are synchronous and run in call order (single writer).
 */
import { describe, expect, it, vi } from 'vitest'
import type { LayoutSnapshot, LayoutTree } from './types.js'
import { createLayoutModel } from './index.js'
import { split, tabs, tree } from './_fixtures.js'

function initial(): LayoutTree {
	return tree(
		split('s0', 'row', [
			tabs('g1', ['p1'], 'p1'),
			tabs('g2', ['p2'], 'p2'),
		]),
	)
}

// A trivial pure mutation: swap the root split's orientation.
function flip(t: LayoutTree): LayoutTree {
	const root = t.root
	if (root.kind !== 'split') return t
	return {
		version: 1,
		root: { ...root, orientation: root.orientation === 'row' ? 'column' : 'row' },
	}
}

describe('createLayoutModel — basics', () => {
	it('get() returns the initial tree', () => {
		const m = createLayoutModel(initial())
		expect(m.get()).toEqual(initial())
	})

	it('apply replaces the tree with the mutation result', () => {
		const m = createLayoutModel(initial())
		m.apply(flip)
		expect((m.get().root as { orientation: string }).orientation).toBe('column')
	})
})

describe('createLayoutModel — revision convention', () => {
	it('subscribe does NOT immediately emit; first emission is revision 1 on first apply', () => {
		const m = createLayoutModel(initial())
		const seen: number[] = []
		m.subscribe(s => seen.push(s.revision))
		expect(seen).toEqual([]) // no replay on subscribe
		m.apply(flip)
		expect(seen).toEqual([1]) // first apply -> revision 1
	})

	it('revision increments by exactly +1 per successful apply (strictly monotonic, no gaps)', () => {
		const m = createLayoutModel(initial())
		const seen: number[] = []
		m.subscribe(s => seen.push(s.revision))
		m.apply(flip)
		m.apply(flip)
		m.apply(flip)
		expect(seen).toEqual([1, 2, 3])
	})

	it('snapshot carries the current tree alongside the revision', () => {
		const m = createLayoutModel(initial())
		const snaps: LayoutSnapshot[] = []
		m.subscribe(s => snaps.push(s))
		m.apply(flip)
		expect(snaps).toHaveLength(1)
		expect(snaps[0]!.revision).toBe(1)
		expect(snaps[0]!.tree).toEqual(m.get())
	})
})

describe('GAP #2 — single-writer, synchronous, call order', () => {
	it('applies run synchronously in call order; get() reflects A then B', () => {
		const m = createLayoutModel(initial())
		const order: string[] = []
		m.apply((t) => { order.push('A'); return flip(t) })
		m.apply((t) => { order.push('B'); return flip(t) })
		expect(order).toEqual(['A', 'B'])
		// two flips -> back to original orientation 'row'
		expect((m.get().root as { orientation: string }).orientation).toBe('row')
	})

	it('subscribers see revisions in strictly increasing order with no reorder', () => {
		const m = createLayoutModel(initial())
		const seen: number[] = []
		m.subscribe(s => seen.push(s.revision))
		for (let i = 0; i < 5; i++) m.apply(flip)
		expect(seen).toEqual([1, 2, 3, 4, 5])
		// strictly increasing
		for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBe(seen[i - 1]! + 1)
	})

	it('a throwing mutation does NOT advance revision and does NOT notify subscribers', () => {
		const m = createLayoutModel(initial())
		const seen: number[] = []
		m.subscribe(s => seen.push(s.revision))
		m.apply(flip) // revision 1
		expect(seen).toEqual([1])
		const treeBefore = m.get()
		expect(() => m.apply(() => { throw new Error('boom') })).toThrow('boom')
		// no notification, tree unchanged
		expect(seen).toEqual([1])
		expect(m.get()).toEqual(treeBefore)
		// next successful apply continues at revision 2 (no gap, no skip)
		m.apply(flip)
		expect(seen).toEqual([1, 2])
	})
})

describe('createLayoutModel — re-entrancy + isolation + ownership', () => {
	it('re-entrant apply preserves monotonic revision order [1, 2]', () => {
		const m = createLayoutModel(initial())
		const bSeen: number[] = []
		let aReapplied = false
		// A re-applies once, on its FIRST notification only.
		m.subscribe(() => {
			if (!aReapplied) {
				aReapplied = true
				m.apply(flip)
			}
		})
		m.subscribe(s => bSeen.push(s.revision))
		m.apply(flip)
		// B must observe revisions in committed order, never reversed.
		expect(bSeen).toEqual([1, 2])
	})

	it('a throwing re-entrant (queued) apply is skipped without disrupting the rest of the drain queue', () => {
		// BUG-1 regression: during the drain pass, a queued mutation that throws must
		// be treated as an independent fire-and-forget transaction — skipped (no
		// revision bump, no notify), with the throw neither bubbling out of the
		// already-committed outer apply() nor aborting the remaining FIFO queue.
		const m = createLayoutModel(initial())
		const seen: number[] = []
		let enqueued = false
		// On the FIRST notification, enqueue TWO re-entrant applies: the first throws,
		// the second is a valid flip. Both are deferred (drained after this pass).
		m.subscribe(() => {
			if (!enqueued) {
				enqueued = true
				m.apply(() => { throw new Error('queued boom') })
				m.apply(flip)
			}
		})
		m.subscribe(s => seen.push(s.revision))
		// (a) the outer/original apply() must NOT throw despite a queued mut throwing.
		expect(() => m.apply(flip)).not.toThrow()
		// (b) the second (valid) re-entrant flip still ran: outer flip -> 'column',
		// throwing item skipped, second flip -> back to 'row'.
		expect((m.get().root as { orientation: string }).orientation).toBe('row')
		// (c) revisions are contiguous/monotonic with NO gap for the skipped throw:
		// outer apply -> rev 1, throwing queued item consumes no revision, valid
		// queued flip -> rev 2.
		expect(seen).toEqual([1, 2])
	})

	it('model owns the initial tree — external mutation of the source does not leak in', () => {
		const source = initial()
		const m = createLayoutModel(source)
		const before = m.get()
		const snapshot = JSON.parse(JSON.stringify(before)) as LayoutTree
		// Mutate the original object in place AFTER construction.
		;(source.root as { orientation: string }).orientation = 'column'
		;((source.root as unknown as { children: { panels: string[] }[] }).children[0]!.panels).push('leaked')
		// The model's tree must be unaffected.
		expect(m.get()).toEqual(snapshot)
	})

	it('isolates subscriber errors: a throwing subscriber neither blocks others nor escapes apply()', () => {
		const m = createLayoutModel(initial())
		const bSeen: number[] = []
		m.subscribe(() => { throw new Error('A boom') })
		m.subscribe(s => bSeen.push(s.revision))
		// A throws, but apply() must not propagate it and B must still be notified.
		expect(() => m.apply(flip)).not.toThrow()
		expect(bSeen).toEqual([1])
		// committed state stands
		expect((m.get().root as { orientation: string }).orientation).toBe('column')
		// a subsequent apply still works and B sees revision 2
		expect(() => m.apply(flip)).not.toThrow()
		expect(bSeen).toEqual([1, 2])
	})
})

describe('createLayoutModel — multiple subscribers + unsubscribe', () => {
	it('all subscribers receive the same snapshot and revision', () => {
		const m = createLayoutModel(initial())
		const a = vi.fn()
		const b = vi.fn()
		m.subscribe(a)
		m.subscribe(b)
		m.apply(flip)
		expect(a).toHaveBeenCalledTimes(1)
		expect(b).toHaveBeenCalledTimes(1)
		const snapA = a.mock.calls[0]![0] as LayoutSnapshot
		const snapB = b.mock.calls[0]![0] as LayoutSnapshot
		expect(snapA.revision).toBe(1)
		expect(snapB.revision).toBe(1)
		expect(snapA.tree).toEqual(snapB.tree)
	})

	it('unsubscribe() stops delivery to that subscriber only', () => {
		const m = createLayoutModel(initial())
		const a = vi.fn()
		const b = vi.fn()
		const offA = m.subscribe(a)
		m.subscribe(b)
		m.apply(flip) // both get rev 1
		offA()
		m.apply(flip) // only b gets rev 2
		expect(a).toHaveBeenCalledTimes(1)
		expect(b).toHaveBeenCalledTimes(2)
		const lastB = b.mock.calls[1]![0] as LayoutSnapshot
		expect(lastB.revision).toBe(2)
	})
})
