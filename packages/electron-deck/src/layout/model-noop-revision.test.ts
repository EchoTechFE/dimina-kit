/**
 * Contract spec — a no-op mutation does not bump the revision.
 *
 * `LayoutModel.apply` treats a mutation that returns the CURRENT tree by identity
 * (`next === current`) as a no-op: the revision does not advance and no subscriber
 * is notified. A mutation returning a fresh tree keeps the existing behavior
 * (revision +1, notify). This keeps a UI action that resolves to nothing (closing a
 * `closable:false` panel, closing the last remaining panel) from driving a spurious
 * re-render.
 */
import { describe, it, expect } from 'vitest'
import type { LayoutTree } from './types.js'
import { createLayoutModel } from './index.js'
import { closePanel } from './index.js'
import { split, tabs, tree } from './_fixtures.js'

function initial(): LayoutTree {
	return tree(
		split('s0', 'row', [
			tabs('g1', ['p1'], 'p1'),
			tabs('g2', ['p2'], 'p2'),
		]),
	)
}

function flip(t: LayoutTree): LayoutTree {
	const root = t.root
	if (root.kind !== 'split') return t
	return {
		version: 1,
		root: { ...root, orientation: root.orientation === 'row' ? 'column' : 'row' },
	}
}

describe('createLayoutModel — no-op mutation does not advance revision', () => {
	it('an identity mutation (returns the current tree) neither bumps revision nor notifies', () => {
		const m = createLayoutModel(initial())
		const seen: number[] = []
		m.subscribe((s) => seen.push(s.revision))

		m.apply((t) => t)

		expect(seen).toEqual([])
		// The next real mutation still starts at revision 1 (the no-op consumed none).
		m.apply(flip)
		expect(seen).toEqual([1])
	})

	it('a no-op closePanel (closing the sole panel returns the same tree) does not notify', () => {
		const single = tree(tabs('only', ['solo'], 'solo'))
		const m = createLayoutModel(single)
		const seen: number[] = []
		m.subscribe((s) => seen.push(s.revision))
		const before = m.get()

		// closePanel on the last remaining panel is a no-op: it returns the tree as-is.
		m.apply((t) => closePanel(t, 'solo'))

		expect(seen).toEqual([])
		expect(m.get()).toBe(before)
	})

	it('a mutation returning a fresh tree still bumps revision and notifies', () => {
		const m = createLayoutModel(initial())
		const seen: number[] = []
		m.subscribe((s) => seen.push(s.revision))

		m.apply(flip)

		expect(seen).toEqual([1])
	})
})
