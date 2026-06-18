/**
 * FAILING TDD spec — robustness contracts for `<DockView>` (src/dock-view.tsx).
 *
 * Two contracts, both currently UNIMPLEMENTED:
 *
 *  Contract 1 (Bug #2 — white-screen crash guard): when a layout transition
 *  changes a split's child COUNT while its id stays the same (`'root'` stays
 *  `'root'`, the rrp `<Group>` instance is REUSED), rrp re-lays-out against a map
 *  whose length no longer matches the new panel count and throws
 *  `Invalid N panel layout`. Today that exception escapes the model→view sync and
 *  unmounts the whole React tree (white screen). EMPIRICALLY (see the probe in the
 *  reviewer note): a 3-child→2-child root transition throws `Invalid 3 panel
 *  layout: 50%, 50%` and tears the tree down. The fix must keep the component
 *  MOUNTED across the 3→2 transition (swallow the transient cardinality throw +
 *  re-sync) instead of letting it crash.
 *
 *  Contract 2 (Bug #1 A+B — flexible weight floor): a flexible (`constraint:null`)
 *  child dragged to ~0 width must NOT have a ~0 weight persisted back to the model.
 *  The `__deckApplyLayout` write-back seam must CLAMP each flexible child's weight
 *  to a small positive floor (never 0, never below the floor) so a panel can never
 *  be persisted at 0 width. A NORMAL ratio must pass through unclamped.
 *
 * These tests target the existing seams (`__deckApplyLayout`, `createLayoutModel`,
 * `setSizes`, `closePanel`, `splitPanel`) — see dock-view.test.tsx for the seam
 * contract. They MUST fail against the current impl, not from infra issues.
 *
 * ── jsdom limitation note (Contract 1) ──────────────────────────────────────
 * The intended deepest assertion ("`runSync` wraps the rrp `setLayout` call in a
 * try/catch + a BOUNDED rAF retry") is NOT directly observable in jsdom: rrp
 * never populates its imperative `groupRef.current` handle there (its
 * ResizeObserver-driven measurement never fires), so `runSync` returns early at
 * `if (!api) return false` and never reaches `setLayout` — verified by a probe
 * showing `getLayout`/`setLayout` are not called on an external `setSizes`. The
 * cardinality-change path, however, IS reachable: rrp's OWN internal re-layout on
 * a child-count change throws, and that throw escapes today. So Contract 1 is
 * tested through the reachable, behavioral repro (3→2 root transition) rather than
 * the unreachable rAF-retry internals; the retry/bounded-spin facets are recorded
 * as `it.todo` because they live behind the unreachable `runSync` seam.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import {
	createLayoutModel,
	createPanelRegistry,
	closePanel,
	setSizes,
	type LayoutTree,
	type LayoutModel,
	type PanelRegistry,
} from '../layout/index.js'
import { DockView } from './index.js'

// ───────────────────────── fixtures ─────────────────────────

/** root split[row] of THREE single-panel groups, all flexible. id stays 'root'
 *  across mutations so the rrp Group instance is reused (Bug #2 precondition). */
function makeThreeColTree(): LayoutTree {
	return {
		version: 1,
		root: {
			kind: 'split',
			id: 'root',
			orientation: 'row',
			sizes: [1, 1, 1],
			children: [
				{ kind: 'tabs', id: 'g0', panels: ['p0'], active: 'p0' },
				{ kind: 'tabs', id: 'g1', panels: ['p1'], active: 'p1' },
				{ kind: 'tabs', id: 'g2', panels: ['p2'], active: 'p2' },
			],
		},
	}
}

/** root split[row] of TWO single-panel groups, BOTH flexible. weights [50, 50]. */
function makeTwoFlexTree(): LayoutTree {
	return {
		version: 1,
		root: {
			kind: 'split',
			id: 'root',
			orientation: 'row',
			sizes: [50, 50],
			children: [
				{ kind: 'tabs', id: 'g0', panels: ['p0'], active: 'p0' },
				{ kind: 'tabs', id: 'g1', panels: ['p1'], active: 'p1' },
			],
		},
	}
}

/** root split[row]: child0 fixed at 240px, children 1 & 2 flexible. Proves the
 *  floor applies ONLY to flexible children — a fixed child keeps node.sizes[i]. */
function makeMixedTree(): LayoutTree {
	return {
		version: 1,
		root: {
			kind: 'split',
			id: 'root',
			orientation: 'row',
			sizes: [5, 50, 50],
			children: [
				{ kind: 'tabs', id: 'g0', panels: ['p0'], active: 'p0' },
				{ kind: 'tabs', id: 'g1', panels: ['p1'], active: 'p1' },
				{ kind: 'tabs', id: 'g2', panels: ['p2'], active: 'p2' },
			],
			constraints: [{ fixedPx: 240 }, null, null],
		},
	}
}

function makeRegistry(): PanelRegistry {
	const reg = createPanelRegistry()
	;['p0', 'p1', 'p2'].forEach((id) => reg.register({ kind: 'dom', id, title: id }))
	return reg
}

function domBody(panelId: string) {
	return <div data-test-dom-content={panelId}>BODY:{panelId}</div>
}

function renderDock(model: LayoutModel, registry: PanelRegistry) {
	return render(
		<DockView
			model={model}
			registry={registry}
			renderDomPanel={domBody}
			bindNativeSlot={() => {}}
		/>,
	)
}

type SplitEl = HTMLElement & { __deckApplyLayout?: (weights: number[]) => void }

beforeEach(() => {
	cleanup()
})

// ─────────────────── Contract 1: cardinality-change crash guard (Bug #2) ───────────────────

describe('<DockView> survives a root child-count change (Bug #2 white-screen guard)', () => {
	// CORE CONTRACT (fails-now): collapsing the root from 3 children to 2 (the
	// split id stays 'root', so the rrp Group is reused) must NOT throw and must
	// keep the component mounted. The current impl lets rrp's transient
	// `Invalid 3 panel layout` escape the sync → React tears down the tree →
	// `[data-deck-split="root"]` vanishes and the apply RETHROWS into the test.
	it('does not throw or unmount when the root collapses 3 children → 2', () => {
		const model = createLayoutModel(makeThreeColTree())
		const { container } = renderDock(model, makeRegistry())
		expect(container.querySelector('[data-deck-split="root"]')).not.toBeNull()

		// Close one of three single-panel groups → root drops to 2 children, same id.
		expect(() => {
			act(() => {
				model.apply((t) => closePanel(t, 'p2'))
			})
		}).not.toThrow()

		// White-screen guard: the split (and thus the whole tree) is still mounted.
		expect(container.querySelector('[data-deck-split="root"]')).not.toBeNull()
		// The two surviving groups are still rendered.
		expect(container.querySelector('[data-deck-group="g0"]')).not.toBeNull()
		expect(container.querySelector('[data-deck-group="g1"]')).not.toBeNull()
		// The model itself collapsed correctly (sanity).
		const root = model.get().root as any
		expect(root.kind).toBe('split')
		expect(root.children.length).toBe(2)
	})

	// REGRESSION: a same-cardinality external setSizes must NOT throw and must keep
	// the tree mounted — the guard must not disturb the (already-working) equal-count
	// resize path. (Empirically this already holds; pinned so a future guard does not
	// regress it.)
	it('a same-cardinality external setSizes does not throw or unmount', () => {
		const model = createLayoutModel(makeTwoFlexTree())
		const { container } = renderDock(model, makeRegistry())

		expect(() => {
			act(() => {
				model.apply((t) => setSizes(t, 'root', [80, 20]))
			})
		}).not.toThrow()

		expect(container.querySelector('[data-deck-split="root"]')).not.toBeNull()
		expect(container.querySelector('[data-deck-sizes="80,20"]')).not.toBeNull()
	})

	// The deepest facet of the guard — `runSync` must wrap the rrp `setLayout` call
	// in a try/catch and schedule a BOUNDED rAF retry on a throw — is not directly
	// observable in jsdom: rrp never populates its imperative `groupRef.current`
	// handle there (no ResizeObserver callback), so `runSync` returns early at
	// `if (!api) return false` and never reaches `setLayout` (verified by probe:
	// getLayout/setLayout are never called on an external setSizes). The reachable
	// behavioral contract (no crash on the 3→2 transition) is covered above; the
	// try/catch + bounded-rAF-retry internals are a real-renderer / e2e concern.
	it.todo('runSync swallows a throwing setLayout + bounded rAF retry — runSync is unreachable in jsdom (rrp groupRef.current is null: no ResizeObserver measurement), so setLayout is never reached; covered by the 3→2 no-crash behavior + e2e')
})

// ─────────────────── Contract 2: flexible weight floor on write-back (Bug #1) ───────────────────

describe('<DockView> __deckApplyLayout floors flexible weights (Bug #1 0-width guard)', () => {
	// CORE CONTRACT (fails-now): a near-0 flexible weight reported by an rrp commit
	// must be CLAMPED to a small positive floor before it is persisted — never 0,
	// never below the floor. The current `__deckApplyLayout` writes the supplied
	// value straight through for flexible children (no clamp), so persisting
	// [0.0001, ...] stores 0.0001 → this FAILS now.
	it('clamps a near-0 flexible weight to a positive floor (never 0)', () => {
		const model = createLayoutModel(makeTwoFlexTree())
		const { container } = renderDock(model, makeRegistry())

		const split = container.querySelector('[data-deck-split="root"]') as SplitEl
		expect(typeof split.__deckApplyLayout).toBe('function')

		// User dragged child 0 to ~0 width; rrp reports a near-0 ratio for it.
		act(() => {
			split.__deckApplyLayout!([0.0001, 99.9999])
		})

		const root = model.get().root as any
		// CORE: the near-0 child is NEVER persisted at 0.
		expect(root.sizes[0]).toBeGreaterThan(0)
		// FLOOR: it sits at or above the impl's positive floor (~1 for 2 flex children;
		// the contract is "a positive floor", expressed conservatively as ≥0.5).
		expect(root.sizes[0]).toBeGreaterThanOrEqual(0.5)
	})

	// Same with an exact-0 weight: must still floor, never store 0.
	it('clamps an exact-0 flexible weight to the positive floor', () => {
		const model = createLayoutModel(makeTwoFlexTree())
		const { container } = renderDock(model, makeRegistry())
		const split = container.querySelector('[data-deck-split="root"]') as SplitEl

		act(() => {
			split.__deckApplyLayout!([0, 100])
		})

		const root = model.get().root as any
		expect(root.sizes[0]).toBeGreaterThan(0)
		expect(root.sizes[0]).toBeGreaterThanOrEqual(0.5)
	})

	// REGRESSION: a NORMAL flexible ratio passes through unclamped — the 60/40 split
	// is reflected faithfully (the floor only rescues near-0 values, it never
	// disturbs a healthy ratio).
	it('passes a normal flexible ratio through unchanged (60/40 stays 60/40)', () => {
		const model = createLayoutModel(makeTwoFlexTree())
		const { container } = renderDock(model, makeRegistry())
		const split = container.querySelector('[data-deck-split="root"]') as SplitEl

		act(() => {
			split.__deckApplyLayout!([60, 40])
		})

		const root = model.get().root as any
		expect(root.sizes[0]).toBeCloseTo(60, 6)
		expect(root.sizes[1]).toBeCloseTo(40, 6)
	})

	// SCOPE: the floor is FLEXIBLE-ONLY. With a fixed-px child mixed in, the fixed
	// child keeps its stored weight (node.sizes[i], preserved by the existing write-
	// back), while a near-0 flexible sibling is floored. This guards the fix from
	// accidentally touching the px-pinned branch.
	it('floors only flexible children; a fixed-px child keeps its stored weight', () => {
		const model = createLayoutModel(makeMixedTree())
		const { container } = renderDock(model, makeRegistry())
		const split = container.querySelector('[data-deck-split="root"]') as SplitEl

		// rrp reports a percentage for every child incl. the pinned one; flexible
		// child 1 is dragged to ~0.
		act(() => {
			split.__deckApplyLayout!([12, 0.0001, 99.9999])
		})

		const root = model.get().root as any
		// Fixed child 0 keeps its model weight (5), NOT the reported 12.
		expect(root.sizes[0]).toBe(5)
		// Flexible child 1's near-0 is floored to a positive value.
		expect(root.sizes[1]).toBeGreaterThan(0)
		expect(root.sizes[1]).toBeGreaterThanOrEqual(0.5)
		// The healthy flexible sibling is unaffected.
		expect(root.sizes[2]).toBeGreaterThan(1)
		// Constraint untouched.
		expect(root.constraints).toEqual([{ fixedPx: 240 }, null, null])
	})
})
