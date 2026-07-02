/**
 * Contract spec — pure index换算 from a tab strip's visible-tab drop index to a
 * `movePanel` insertion index.
 *
 * `computeReorderIndex` reports the count of VISIBLE-tab midpoints the pointer
 * has passed (0..visibleTabs.length), counting the dragged tab's OWN midpoint and
 * measured over a rect array that omits `hideTab` panels. `movePanel`'s same-group
 * reorder inserts into `panels.filter(p => p !== dragged)` — a DIFFERENT coordinate
 * space. Feeding the strip index straight to `movePanel` overshoots to the right by
 * one and mis-maps when the group has hidden tabs.
 *
 * `resolveReorderInsertIndex` is the single translation between the two spaces:
 * given the full `panels` order, the `visibleTabIds` (tab order minus hidden), the
 * dragged panel id, and the raw strip index, it returns the insertion index into
 * `panels.filter(p => p !== dragged)`.
 *
 * Kept in its OWN file: `resolveReorderInsertIndex` does not yet exist, so this
 * import fails at load — an honest red that must not connect to the other bug
 * groups' files.
 */
import { describe, it, expect } from 'vitest'
// The translation is expected to live beside the other pure drag geometry and be
// re-exported from the react entry; import it from the geometry module directly.
import { resolveReorderInsertIndex } from './drag-redock.js'
import { movePanel } from '../layout/index.js'
import { tabs, tree } from '../layout/_fixtures.js'
import type { LayoutTree, TabGroupNode } from '../layout/index.js'

/** A single-group tree carrying `panels` (active = first). */
function group(panels: string[]): LayoutTree {
	return tree(tabs('g', panels, panels[0]!))
}

/** The `panels` order of group `g` after a reorder move. */
function orderAfterMove(panels: string[], dragged: string, index: number): string[] {
	const next = movePanel(group(panels), dragged, { groupId: 'g', index })
	const g = next.root as TabGroupNode
	return [...g.panels]
}

describe('resolveReorderInsertIndex — visible-strip index maps to the filtered insert index', () => {
	it('drag A past A+B midpoints (strip 2) inserts A between B and C', () => {
		const idx = resolveReorderInsertIndex(['A', 'B', 'C'], ['A', 'B', 'C'], 'A', 2)
		expect(idx).toBe(1)
		expect(orderAfterMove(['A', 'B', 'C'], 'A', idx)).toEqual(['B', 'A', 'C'])
	})

	it('drag A past all midpoints (strip 3) appends A to the end', () => {
		const idx = resolveReorderInsertIndex(['A', 'B', 'C'], ['A', 'B', 'C'], 'A', 3)
		expect(idx).toBe(2)
		expect(orderAfterMove(['A', 'B', 'C'], 'A', idx)).toEqual(['B', 'C', 'A'])
	})

	it('drag C leftward past A midpoint (strip 1) inserts C between A and B', () => {
		const idx = resolveReorderInsertIndex(['A', 'B', 'C'], ['A', 'B', 'C'], 'C', 1)
		expect(idx).toBe(1)
		expect(orderAfterMove(['A', 'B', 'C'], 'C', idx)).toEqual(['A', 'C', 'B'])
	})

	it('drag B settling either half-gap around its own slot (strip 1) leaves order unchanged', () => {
		const idx = resolveReorderInsertIndex(['A', 'B', 'C'], ['A', 'B', 'C'], 'B', 1)
		expect(orderAfterMove(['A', 'B', 'C'], 'B', idx)).toEqual(['A', 'B', 'C'])
	})

	it('drag B settling either half-gap around its own slot (strip 2) leaves order unchanged', () => {
		const idx = resolveReorderInsertIndex(['A', 'B', 'C'], ['A', 'B', 'C'], 'B', 2)
		expect(orderAfterMove(['A', 'B', 'C'], 'B', idx)).toEqual(['A', 'B', 'C'])
	})

	it('accounts for a hidden tab between the coordinate spaces (drag B before A)', () => {
		// panels carry a hidden tab H between A and B; the strip only measured A and B.
		const idx = resolveReorderInsertIndex(['A', 'H', 'B'], ['A', 'B'], 'B', 0)
		expect(idx).toBe(0)
		expect(orderAfterMove(['A', 'H', 'B'], 'B', idx)).toEqual(['B', 'A', 'H'])
	})
})
