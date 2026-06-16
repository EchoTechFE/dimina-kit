/**
 * FAILING TDD spec (red phase) for FINDING M1 — "model→view resize sync".
 *
 * THE DEFECT (dock-view.tsx `renderSplit`): flexible children render as
 * `<Panel defaultSize={pct}>`. react-resizable-panels (rrp v4.10) consumes
 * `defaultSize` ONLY at mount. So after a `<DockView>` is mounted, applying a
 * programmatic `model.apply(setSizes(splitId, newWeights))`:
 *   - updates the model (✓) and the `data-deck-sizes` mirror attribute (✓),
 *   - but does NOT move the VISIBLE split — the live rrp panel ratios stay at
 *     their mounted values. The layout MODEL is supposed to be the source of
 *     truth for the visible split post-mount; today it is not.
 *
 * ── jsdom feasibility (verified empirically with a throwaway probe) ──────────
 * rrp computes ALL geometry from real layout (offsetWidth / getBoundingClientRect),
 * which is 0 in jsdom. Concretely, under THIS harness (the `_test-setup.ts`
 * ResizeObserver stub):
 *   - the Group's imperative `getLayout()` returns `{}` (EMPTY) — no measured
 *     percentages at all;
 *   - every `<Panel>` renders `flex-grow: 50` REGARDLESS of its `defaultSize`
 *     (a 20/80 seed still renders 50/50);
 *   - the imperative `setLayout({a:70,b:30})` is a COMPLETE no-op (getLayout
 *     still `{}`, flex-grow still 50/50).
 * Therefore the M1 CORE assertion — "the VISIBLE split ratio follows
 * setSizes" — CANNOT be observed in jsdom: any such assertion would either pass
 * vacuously or fail for the wrong reason (getLayout is always `{}`). The live
 * proof lives in the real-Electron e2e
 * `packages/devtools/e2e/dock-resize-sync.spec.ts`.
 *
 * What jsdom CAN observe — and what this file pins — are the surrounding
 * invariants the M1 fix must satisfy WITHOUT a real layout engine:
 *   (A) the seam through which a model→view sync would be wired exists and is
 *       reachable on a MOUNTED DockView (the rrp Group ref);          [M1-seam]
 *   (B) view→model drag write-back still works (regression);          [M1-regress-writeback]
 *   (C) a single programmatic setSizes (or write-back) does not cause an
 *       unbounded cascade of model emissions / re-renders;            [M1-no-loop]
 *   (D) a fixed-px constrained child keeps its exact px / stored weight when a
 *       programmatic setSizes touches the FLEXIBLE siblings;          [M1-fixed-px]
 *   (E) an idempotent (equivalent-weights) setSizes does not churn;   [M1-idempotent]
 *   (F) a programmatic setSizes on an INNER split moves only that split's model
 *       node, not its sibling.                                        [M1-nested]
 *
 * NOTE ON RED/GREEN: most guards here encode invariants that already hold on
 * HEAD (B/C/D/E/F) — they are REGRESSION guards that must stay green after the
 * fix (the fix must not break write-back, must not loop, must not corrupt
 * fixed-px). The one test that is RED on HEAD by construction is [M1-seam-live]
 * (A): it asserts the rrp Group ref is exposed for a model→view sync, which the
 * current impl does NOT wire (no `groupRef`, no imperative `setLayout` on a
 * model change). That assertion is the jsdom-observable proxy for "the fix added
 * the imperative sync seam"; the TRUE visible-pixels proof is the e2e.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import {
	createLayoutModel,
	setSizes,
	type LayoutModel,
	type LayoutTree,
	type PanelRegistry,
	createPanelRegistry,
} from '../layout/index.js'
import { DockView, layoutsEquivalent } from './index.js'

// ───────────────────────── fixtures ─────────────────────────

/** root split[row] of two single-panel flexible groups, seeded [1,1]. */
function makeFlexTree(): LayoutTree {
	return {
		version: 1,
		root: {
			kind: 'split',
			id: 'root',
			orientation: 'row',
			sizes: [1, 1],
			children: [
				{ kind: 'tabs', id: 'g-a', panels: ['a'], active: 'a' },
				{ kind: 'tabs', id: 'g-b', panels: ['b'], active: 'b' },
			],
		},
	}
}

/** root split[row]: child0 fixed at 240px, children1&2 flexible [_,1,3]. */
function makeFixedTree(): LayoutTree {
	return {
		version: 1,
		root: {
			kind: 'split',
			id: 'root',
			orientation: 'row',
			sizes: [5, 1, 3],
			constraints: [{ fixedPx: 240 }, null, null],
			children: [
				{ kind: 'tabs', id: 'g0', panels: ['p0'], active: 'p0' },
				{ kind: 'tabs', id: 'g1', panels: ['p1'], active: 'p1' },
				{ kind: 'tabs', id: 'g2', panels: ['p2'], active: 'p2' },
			],
		},
	}
}

/** outer split[row] of [ leaf | inner split[column] of two leaves ]. */
function makeNestedTree(): LayoutTree {
	return {
		version: 1,
		root: {
			kind: 'split',
			id: 'outer',
			orientation: 'row',
			sizes: [1, 1],
			children: [
				{ kind: 'tabs', id: 'g-x', panels: ['x'], active: 'x' },
				{
					kind: 'split',
					id: 'inner',
					orientation: 'column',
					sizes: [1, 1],
					children: [
						{ kind: 'tabs', id: 'g-y', panels: ['y'], active: 'y' },
						{ kind: 'tabs', id: 'g-z', panels: ['z'], active: 'z' },
					],
				},
			],
		},
	}
}

function makeRegistry(ids: string[]): PanelRegistry {
	const reg = createPanelRegistry()
	for (const id of ids) reg.register({ kind: 'dom', id, title: id.toUpperCase() })
	return reg
}

function renderDock(model: LayoutModel, registry: PanelRegistry) {
	return render(
		<DockView
			model={model}
			registry={registry}
			renderDomPanel={(id) => <div data-test-body={id}>BODY:{id}</div>}
			bindNativeSlot={() => {}}
		/>,
	)
}

/** Read the live rrp panel flex-grow for each `[data-panel]` under a split, in
 * document order. In jsdom these are all "50" regardless of model sizes (see the
 * header) — kept so the e2e mirror reads identically and so a future jsdom that
 * gains layout would light this up. */
function panelFlexGrows(container: HTMLElement, splitId: string): string[] {
	const split = container.querySelector(`[data-deck-split="${splitId}"]`)!
	return Array.from(split.querySelectorAll('[data-panel]')).map(
		(p) => (p as HTMLElement).style.flexGrow,
	)
}

beforeEach(() => {
	cleanup()
})

// ─────────────── [M1-seam-live] RED on HEAD: model→view sync seam ───────────────

describe('M1 model→view sync — the live split must follow a programmatic setSizes', () => {
	// CORE M1 (RED on HEAD). The fix promotes the split to a component that holds
	// the rrp Group's imperative ref and, on an external `node.sizes` change, calls
	// its `setLayout(map)` to MOVE the live splitter. jsdom can't observe the moved
	// PIXELS (getLayout()==={}), but it CAN observe whether the sync seam — the rrp
	// Group imperative handle — is wired at all. The current impl renders the Group
	// WITHOUT a `groupRef`/imperative handle and re-applies nothing on an external
	// setSizes, so there is no handle to drive: this exposes the missing seam.
	//
	// We surface the handle the same fix-agnostic way the split exposes
	// `__deckApplyLayout`: the fix must hang the rrp Group's imperative API on the
	// split element as `__deckGroupApi` (or equivalent) so the model→view sync — and
	// this test — has something to read. Absent today → undefined → RED.
	it('[M1-seam-live] exposes the rrp Group imperative handle for model→view sync (RED on HEAD)', () => {
		const model = createLayoutModel(makeFlexTree())
		const { container } = renderDock(model, makeRegistry(['a', 'b']))

		const split = container.querySelector('[data-deck-split="root"]') as
			| (HTMLElement & { __deckGroupApi?: { getLayout: () => Record<string, number>; setLayout: (m: Record<string, number>) => unknown } })
			| null
		expect(split).not.toBeNull()

		// The fix must wire the rrp Group's imperative handle so a model.sizes change
		// can drive setLayout. The current impl exposes no such handle.
		expect(
			typeof split!.__deckGroupApi,
			'M1 fix must expose the rrp Group imperative handle so model→view sync can drive setLayout',
		).toBe('object')
		expect(typeof split!.__deckGroupApi!.setLayout).toBe('function')
		expect(typeof split!.__deckGroupApi!.getLayout).toBe('function')

		// And after a programmatic setSizes on a MOUNTED DockView, the fix must have
		// pushed the new ratio into the live Group. We assert the model→view sync was
		// invoked by checking the live layout reflects the new weights' RATIO. (In
		// jsdom getLayout() is {} — see header — so this concrete pixel assertion is
		// the e2e's job; here we only require the handle + a setLayout call path.)
		act(() => {
			model.apply((t) => setSizes(t, 'root', [3, 1]))
		})
		// data-deck-sizes mirrors the model (this part already works on HEAD)…
		expect(container.querySelector('[data-deck-split="root"]')!.getAttribute('data-deck-sizes')).toBe('3,1')
		// …but the LIVE proof (the seam was driven) is that the imperative handle
		// reports the new ratio. jsdom can't measure it, so this is asserted in e2e;
		// the handle's PRESENCE (above) is the jsdom-checkable half of the fix.
	})
})

// ─────────────── [M1-regress-writeback] drag write-back still works ───────────────

describe('M1 regression — view→model drag write-back (must stay GREEN after the fix)', () => {
	// The fix introduces a model→view sync; it must NOT suppress a legitimate
	// user-driven resize. The `__deckApplyLayout` seam (the production drag commit
	// path) must still apply setSizes to the model. Green on HEAD; must stay green.
	it('[M1-regress-writeback] a user resize via __deckApplyLayout writes new weights to the model', () => {
		const model = createLayoutModel(makeFlexTree())
		const { container } = renderDock(model, makeRegistry(['a', 'b']))

		const split = container.querySelector('[data-deck-split="root"]') as
			HTMLElement & { __deckApplyLayout?: (w: number[]) => void }
		expect(typeof split.__deckApplyLayout).toBe('function')

		act(() => {
			split.__deckApplyLayout!([3, 1])
		})

		const root = model.get().root as any
		expect(root.sizes).toEqual([3, 1])
		// And the mirror reflects it.
		expect(container.querySelector('[data-deck-split="root"]')!.getAttribute('data-deck-sizes')).toBe('3,1')
	})
})

// ─────────────── [M1-no-loop] bounded emissions (no write-back storm) ───────────────

describe('M1 regression — no write-back loop / revision storm', () => {
	// The fix wires model→view sync; rrp's own `setLayout` re-emits
	// `onLayoutChanged` → which writes back to the model → which could re-sync →
	// which re-emits… an infinite cascade. This guard pins a BOUNDED number of
	// model emissions for a single programmatic setSizes. Green on HEAD (no sync
	// today, so exactly 1 emission); after the fix it must remain bounded (the
	// idempotent epsilon guard must break the loop — a small constant, NOT growing).
	it('[M1-no-loop] one programmatic setSizes yields a BOUNDED number of model emissions', () => {
		const model = createLayoutModel(makeFlexTree())
		let emissions = 0
		const unsub = model.subscribe(() => {
			emissions += 1
		})
		const { container } = renderDock(model, makeRegistry(['a', 'b']))

		act(() => {
			model.apply((t) => setSizes(t, 'root', [3, 1]))
		})

		unsub()
		// HEAD: exactly 1 (no model→view sync re-emits). The fix may add at most a
		// small constant (its own settle write-back), but MUST NOT loop. A generous
		// upper bound of 3 catches an unbounded storm while tolerating one settle.
		expect(emissions, `single setSizes must not storm the model (got ${emissions})`).toBeGreaterThanOrEqual(1)
		expect(emissions, `single setSizes must stay bounded — no write-back loop (got ${emissions})`).toBeLessThanOrEqual(3)
		// the model landed on the requested weights regardless.
		expect((model.get().root as any).sizes).toEqual([3, 1])
		// structure intact.
		expect(container.querySelector('[data-deck-split="root"]')).not.toBeNull()
	})

	// Same bound for a user-driven write-back: invoking __deckApplyLayout once must
	// settle in a bounded number of emissions, not cascade through the new sync.
	it('[M1-no-loop] one user write-back yields a BOUNDED number of model emissions', () => {
		const model = createLayoutModel(makeFlexTree())
		let emissions = 0
		const unsub = model.subscribe(() => {
			emissions += 1
		})
		const { container } = renderDock(model, makeRegistry(['a', 'b']))
		const split = container.querySelector('[data-deck-split="root"]') as
			HTMLElement & { __deckApplyLayout?: (w: number[]) => void }

		act(() => {
			split.__deckApplyLayout!([2, 1])
		})

		unsub()
		expect(emissions, `single write-back must stay bounded (got ${emissions})`).toBeGreaterThanOrEqual(1)
		expect(emissions, `single write-back must stay bounded — no loop (got ${emissions})`).toBeLessThanOrEqual(3)
		expect((model.get().root as any).sizes).toEqual([2, 1])
	})
})

// ─────────────── [M1-fixed-px] programmatic setSizes preserves fixed-px ───────────────

describe('M1 regression — fixed-px child preserved across a programmatic setSizes', () => {
	// A split with a fixed-px child + flexible siblings: a programmatic
	// `model.apply(setSizes(flexibleWeights))` must leave the fixed child's px
	// constraint UNTOUCHED (not absorbed into the percentage pool) and its stored
	// weight intact. The model-level setSizes already carries constraints through
	// (mutations.ts), so this is GREEN on HEAD; the M1 fix's model→view sync must
	// not change that — the fixed Panel keeps its `Npx` defaultSize/min/max.
	it('[M1-fixed-px] setSizes on flexible weights leaves the fixed child constraint + weight intact', () => {
		const model = createLayoutModel(makeFixedTree())
		const { container } = renderDock(model, makeRegistry(['p0', 'p1', 'p2']))

		// setSizes must carry the fixed child's slot through. We pass a full-length
		// weights array (length === children.length); only the flexible slots change.
		act(() => {
			model.apply((t) => setSizes(t, 'root', [5, 30, 70]))
		})

		const root = model.get().root as any
		// fixed child's constraint untouched (NOT absorbed into the % pool).
		expect(root.constraints).toEqual([{ fixedPx: 240 }, null, null])
		// flexible siblings updated; fixed slot weight unchanged (still 5).
		expect(root.sizes).toEqual([5, 30, 70])
		// the mirror reflects the same raw weights — the render is a function of
		// model.sizes including the (carried-through) fixed slot.
		expect(container.querySelector('[data-deck-split="root"]')!.getAttribute('data-deck-sizes')).toBe('5,30,70')

		// JSDOM LIMITATION: the LIVE px-lock of the fixed Panel cannot be asserted
		// here — rrp gives the min===max-px Panel a percentage `flex` (e.g.
		// `flex: 33.334 1 0px`) under jsdom because there is no measured container
		// width to convert 240px against. The fixed child still renders (structure),
		// and the % pool / weight is computed excluding it (proved separately in
		// dock-view.test.tsx `computeFlexiblePercentages`); that the fixed child stays
		// EXACTLY 240 real pixels after a programmatic setSizes is asserted in the
		// real-Electron e2e `packages/devtools/e2e/dock-resize-sync.spec.ts`.
		const split = container.querySelector('[data-deck-split="root"]')!
		expect(split.querySelectorAll('[data-panel]').length).toBe(3)
		// all three bodies mounted; the fixed panel was not dropped.
		expect(container.querySelector('[data-test-body="p0"]')).not.toBeNull()
		expect(container.querySelector('[data-test-body="p1"]')).not.toBeNull()
		expect(container.querySelector('[data-test-body="p2"]')).not.toBeNull()
	})
})

// ─────────────── [M1-idempotent] equivalent-weights setSizes does not churn ───────────────

describe('M1 — idempotent no-op setSizes does not churn', () => {
	// Applying setSizes with weights equivalent to the CURRENT model weights must
	// not cause needless emission churn. The model bumps revision on every apply
	// (even an identical one), but the DockView's model→view sync the fix adds MUST
	// be guarded by an epsilon check so it does NOT push a redundant setLayout into
	// rrp (which would itself re-emit onLayoutChanged → write-back → churn).
	//
	// jsdom-observable proxy: re-applying the SAME weights must leave the model on
	// those weights and not multiply emissions beyond the apply itself. We assert a
	// re-applied identical setSizes emits a bounded count and the data attribute is
	// unchanged.
	it('[M1-idempotent] re-applying the current weights stays bounded and unchanged', () => {
		const model = createLayoutModel(makeFlexTree())
		const { container } = renderDock(model, makeRegistry(['a', 'b']))

		// Move once to a known state.
		act(() => {
			model.apply((t) => setSizes(t, 'root', [3, 1]))
		})
		expect(container.querySelector('[data-deck-split="root"]')!.getAttribute('data-deck-sizes')).toBe('3,1')

		// Now count emissions for a NO-OP re-apply of the same weights.
		let emissions = 0
		const unsub = model.subscribe(() => {
			emissions += 1
		})
		act(() => {
			model.apply((t) => setSizes(t, 'root', [3, 1]))
		})
		unsub()

		// One model apply happened (the model itself does not dedupe), but the
		// DockView's sync must NOT amplify it into a cascade.
		expect(emissions, `idempotent re-apply must not cascade (got ${emissions})`).toBeLessThanOrEqual(3)
		// State unchanged.
		expect(container.querySelector('[data-deck-split="root"]')!.getAttribute('data-deck-sizes')).toBe('3,1')
		expect((model.get().root as any).sizes).toEqual([3, 1])
	})
})

// ─────────────── [M1-nested] inner-split sync is independent ───────────────

describe('M1 — nested split sync is independent', () => {
	// A programmatic setSizes on an INNER split must move ONLY that split's model
	// node; the outer split (and its sibling leaf) must be untouched. This pins
	// that the fix's per-split model→view sync is keyed to the right split id and
	// does not leak across the tree.
	it('[M1-nested] setSizes on the inner split updates only the inner node', () => {
		const model = createLayoutModel(makeNestedTree())
		const { container } = renderDock(model, makeRegistry(['x', 'y', 'z']))

		expect(container.querySelector('[data-deck-split="outer"]')!.getAttribute('data-deck-sizes')).toBe('1,1')
		expect(container.querySelector('[data-deck-split="inner"]')!.getAttribute('data-deck-sizes')).toBe('1,1')

		act(() => {
			model.apply((t) => setSizes(t, 'inner', [4, 1]))
		})

		// inner moved; outer untouched.
		expect(container.querySelector('[data-deck-split="inner"]')!.getAttribute('data-deck-sizes')).toBe('4,1')
		expect(container.querySelector('[data-deck-split="outer"]')!.getAttribute('data-deck-sizes')).toBe('1,1')

		const root = model.get().root as any
		expect(root.sizes).toEqual([1, 1])
		const inner = root.children.find((c: any) => c.id === 'inner')!
		expect(inner.sizes).toEqual([4, 1])

		// flex-grow readout retained for the e2e mirror (jsdom: all "50" — see header).
		void panelFlexGrows(container, 'inner')
	})
})

// ─────────────── [N1] layoutsEquivalent hardening ───────────────

// The M1 fix EXPORTS `layoutsEquivalent` (it is pure), so the two edge cases the
// predicate must handle can now be pinned directly:
//   (a) maps with MISMATCHED key sets are non-equivalent — a missing id AND an
//       extra id (one present in a/b but absent from the compared `ids`), and
//   (b) a non-finite value (NaN/±Infinity) is treated as NON-equivalent — on the
//       pre-fix predicate `typeof NaN === 'number'` was true and
//       `Math.abs(NaN - x) > eps` is FALSE, so a NaN wrongly read as equivalent
//       and could suppress a legitimate sync/write-back.
describe('[N1] layoutsEquivalent hardening', () => {
	it('a NaN value is treated as NON-equivalent', () => {
		expect(layoutsEquivalent({ a: NaN, b: 50 }, { a: 50, b: 50 }, ['a', 'b'])).toBe(false)
		// NaN on either side, or both.
		expect(layoutsEquivalent({ a: 50, b: 50 }, { a: NaN, b: 50 }, ['a', 'b'])).toBe(false)
		expect(layoutsEquivalent({ a: NaN, b: 50 }, { a: NaN, b: 50 }, ['a', 'b'])).toBe(false)
		// ±Infinity is likewise non-finite → non-equivalent.
		expect(layoutsEquivalent({ a: Infinity, b: 50 }, { a: Infinity, b: 50 }, ['a', 'b'])).toBe(false)
		// Sanity: two finite, equal maps ARE equivalent.
		expect(layoutsEquivalent({ a: 50, b: 50 }, { a: 50, b: 50 }, ['a', 'b'])).toBe(true)
		// And within the default epsilon.
		expect(layoutsEquivalent({ a: 50, b: 50 }, { a: 50.3, b: 49.7 }, ['a', 'b'])).toBe(true)
	})

	it('maps with mismatched key sets are NON-equivalent', () => {
		// Missing id: `b` absent from the first map.
		expect(layoutsEquivalent({ a: 50 }, { a: 50, b: 50 }, ['a', 'b'])).toBe(false)
		// Extra id: `c` present in a map but NOT in the compared `ids`.
		expect(layoutsEquivalent({ a: 50, b: 25, c: 25 }, { a: 50, b: 50 }, ['a', 'b'])).toBe(false)
		expect(layoutsEquivalent({ a: 50, b: 50 }, { a: 50, b: 25, c: 25 }, ['a', 'b'])).toBe(false)
	})
})
