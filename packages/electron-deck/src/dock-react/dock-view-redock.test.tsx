/**
 * FAILING TDD spec — Layer 2 (DockView gesture binding) for the NOT-YET-WRITTEN
 * drag-to-redock feature. Runs under the jsdom `vitest.dock-react.config.ts`
 * suite (`*.test.tsx`). The pure geometry is exhaustively covered by the node
 * suite `drag-redock.test.ts`; jsdom cannot do real pointer geometry
 * (getBoundingClientRect returns 0s), so here we cover only what jsdom CAN see:
 * the draggable-tab affordance and a TESTABLE SEAM the implementer must expose.
 *
 * ─────────────────────── locked Layer-2 contract ───────────────────────
 *
 *  1. Draggable tab affordance — each tab button (`[data-deck-tab="<panelId>"]`)
 *     carries `draggable="true"` so a drag gesture can start from it. (Pick ONE
 *     marker; we lock `draggable="true"`.) The dragged panel id stays recoverable
 *     from the existing `data-deck-tab` attribute.
 *
 *  2. Drop-handling seam — each GROUP element (`[data-deck-group="<groupId>"]`)
 *     exposes an imperative hook mirroring the existing `__deckApplyLayout` seam
 *     on split elements (see dock-view.test.tsx M1):
 *
 *         __deckHandleDrop?(draggedPanelId: string, zone: DropZone): void
 *
 *     Calling it applies the CORRECT engine mutation to the model:
 *       - zone 'center' => the dragged panel JOINS this group (movePanel).
 *       - zone 'right'  => the dragged panel SPLITS this group's target panel to
 *         the right; an already-present dragged panel is extract-then-split'd so
 *         it ends up exactly once. The seam owns choosing the target panel
 *         (the group's active panel is the natural anchor).
 *
 *  3. Drop-indicator overlay — while a drag is in progress over a group, an
 *     element with `data-deck-drop-zone="<zone>"` appears on the hovered group.
 *     Real geometry-driven zone selection is a real-pointer / e2e concern (jsdom
 *     reports 0 geometry), so the two real-drag cases are `it.todo` below,
 *     mirroring the existing `it.todo` M1 separator-drag.
 *
 * The `__deckHandleDrop` seam and the `draggable` attr do NOT exist yet, so these
 * tests fail at the seam (undefined hook) / the missing attr — NOT from infra.
 * The `./drag-redock.js` re-export assertion fails at import time until the
 * module exists.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { render, act, cleanup, fireEvent } from '@testing-library/react'
import {
	closePanel,
	createLayoutModel,
	createPanelRegistry,
	type LayoutNode,
	type LayoutTree,
	type LayoutModel,
	type PanelRegistry,
	type TabGroupNode,
} from '../layout/index.js'
import { DockView } from './index.js'
// The geometry module must ALSO be re-exported from the react entry (`./index`).
// This import is the honest failure point until `./drag-redock` exists.
import { computeDropZone, dropZoneToMutation } from './index.js'

// ───────────────────────── fixtures ─────────────────────────

/** root split[row] -> [ g-left(sim) | g-right(editor, debug) ] */
function makeTree(): LayoutTree {
	return {
		version: 1,
		root: {
			kind: 'split',
			id: 'root',
			orientation: 'row',
			sizes: [1, 1],
			children: [
				{ kind: 'tabs', id: 'g-left', panels: ['sim'], active: 'sim' },
				{ kind: 'tabs', id: 'g-right', panels: ['editor', 'debug'], active: 'editor' },
			],
		},
	}
}

function makeRegistry(): PanelRegistry {
	const reg = createPanelRegistry()
	reg.register({ kind: 'dom', id: 'sim', title: 'Simulator' })
	reg.register({ kind: 'dom', id: 'editor', title: 'Editor' })
	reg.register({ kind: 'dom', id: 'debug', title: 'Debug' })
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

/** The group element augmented with the drop-handling seam. */
type DeckGroupElement = HTMLElement & {
	__deckHandleDrop?: (draggedPanelId: string, zone: string) => void
}

function findGroupOf(root: LayoutNode, panelId: string): TabGroupNode | null {
	let found: TabGroupNode | null = null
	const walk = (n: LayoutNode): void => {
		if (found) return
		if (n.kind === 'tabs') {
			if (n.panels.includes(panelId)) found = n
		}
		else n.children.forEach(walk)
	}
	walk(root)
	return found
}

function countPanel(root: LayoutNode, panelId: string): number {
	let n = 0
	const walk = (node: LayoutNode): void => {
		if (node.kind === 'tabs') n += node.panels.filter((p) => p === panelId).length
		else node.children.forEach(walk)
	}
	walk(root)
	return n
}

beforeEach(() => {
	cleanup()
})

// ───────────────────────── tests ─────────────────────────

describe('<DockView> drag-to-redock — re-export', () => {
	// BUG: the geometry layer is added but not surfaced from the react entry, so a
	// host importing from `@dimina-kit/electron-deck/dock-react` can't reach it.
	it('re-exports computeDropZone + dropZoneToMutation from the react entry', () => {
		expect(typeof computeDropZone).toBe('function')
		expect(typeof dropZoneToMutation).toBe('function')
	})
})

describe('<DockView> drag-to-redock — draggable tab affordance', () => {
	// BUG: tabs aren't marked draggable, so a drag gesture can't start from them
	// and the whole redock UX is dead on arrival.
	it('marks every tab button draggable="true"', () => {
		const { container } = renderDock(createLayoutModel(makeTree()), makeRegistry())
		const editorTab = container.querySelector('[data-deck-tab="editor"]')!
		const debugTab = container.querySelector('[data-deck-tab="debug"]')!
		const simTab = container.querySelector('[data-deck-tab="sim"]')!
		expect(editorTab.getAttribute('draggable')).toBe('true')
		expect(debugTab.getAttribute('draggable')).toBe('true')
		expect(simTab.getAttribute('draggable')).toBe('true')
	})

	// BUG: the dragged panel id is no longer recoverable from the DOM, so the drop
	// handler can't know WHAT is being dragged.
	it('keeps the dragged panel id recoverable via data-deck-tab', () => {
		const { container } = renderDock(createLayoutModel(makeTree()), makeRegistry())
		const tab = container.querySelector('[data-deck-tab="debug"]')!
		expect(tab.getAttribute('data-deck-tab')).toBe('debug')
	})
})

describe('<DockView> drag-to-redock — __deckHandleDrop seam', () => {
	// BUG: the group exposes no drop seam at all, so the gesture has nowhere to
	// commit the re-dock. Mirrors the __deckApplyLayout seam discipline.
	it('exposes __deckHandleDrop on every group element', () => {
		const { container } = renderDock(createLayoutModel(makeTree()), makeRegistry())
		const left = container.querySelector('[data-deck-group="g-left"]') as DeckGroupElement
		const right = container.querySelector('[data-deck-group="g-right"]') as DeckGroupElement
		expect(typeof left.__deckHandleDrop).toBe('function')
		expect(typeof right.__deckHandleDrop).toBe('function')
	})

	// BUG: a center drop fails to JOIN the target group through the model, so the
	// dragged tab never moves (or moves via local state, lost on next snapshot).
	it('__deckHandleDrop(dragged, "center") moves the dragged panel into that group', () => {
		const model = createLayoutModel(makeTree())
		const { container } = renderDock(model, makeRegistry())

		// 'sim' lives in g-left; drop it onto g-right's center => it joins g-right.
		const right = container.querySelector('[data-deck-group="g-right"]') as DeckGroupElement
		expect(typeof right.__deckHandleDrop).toBe('function')
		act(() => {
			right.__deckHandleDrop!('sim', 'center')
		})

		const root = model.get().root
		const home = findGroupOf(root, 'sim')!
		expect(home.id).toBe('g-right')
		expect(home.panels).toContain('sim')
		expect(countPanel(root, 'sim')).toBe(1)
	})

	// BUG: a right drop fails to split (or splits the wrong way / duplicates the
	// dragged panel because it didn't extract-then-split). Prove 'sim' lands to the
	// RIGHT of g-right's target, exactly once.
	it('__deckHandleDrop(dragged, "right") splits the group, placing the panel to the right exactly once', () => {
		const model = createLayoutModel(makeTree())
		const { container } = renderDock(model, makeRegistry())

		const right = container.querySelector('[data-deck-group="g-right"]') as DeckGroupElement
		expect(typeof right.__deckHandleDrop).toBe('function')
		act(() => {
			right.__deckHandleDrop!('sim', 'right')
		})

		const root = model.get().root
		// dragged panel present exactly once (extract-then-split, not duplicated).
		expect(countPanel(root, 'sim')).toBe(1)
		// a row split now exists with 'sim' present somewhere to the right of editor.
		const simGroup = findGroupOf(root, 'sim')!
		const editorGroup = findGroupOf(root, 'editor')!
		// 'sim' is no longer co-located with the original g-left only — it split out.
		expect(simGroup.id).not.toBe('g-left')
		expect(editorGroup.panels).toContain('editor')
	})

	// BUG: dropping a panel onto its OWN group center (no-op) still churns the
	// model (bumps revision / re-derives active), causing needless re-renders.
	it('__deckHandleDrop(ownPanel, "center") onto its own group is a no-op (no model churn)', () => {
		const model = createLayoutModel(makeTree())
		const { container } = renderDock(model, makeRegistry())

		let revisions = 0
		model.subscribe(() => { revisions += 1 })

		const right = container.querySelector('[data-deck-group="g-right"]') as DeckGroupElement
		// 'editor' is the active panel of g-right — dropping it onto its own center.
		act(() => {
			right.__deckHandleDrop!('editor', 'center')
		})

		// no model.apply happened => no subscriber notification.
		expect(revisions).toBe(0)
		// tree structurally unchanged: editor still the sole-active member of g-right.
		const grp = findGroupOf(model.get().root, 'editor')!
		expect(grp.id).toBe('g-right')
		expect(countPanel(model.get().root, 'editor')).toBe(1)
	})
})

describe('<DockView> drag-to-redock — registered-but-absent payload (M2)', () => {
  // BUG (M2): handleDrop accepts the drop when `registry.get(dragged) !==
  // undefined` — REGISTRY membership — but never checks the panel is actually in
  // the CURRENT layout tree. A `text/plain` (or x-deck-panel) drop whose id is a
  // REGISTERED-but-CLOSED panel (registered, but removed from the tree) passes the
  // guard and drives `onRedock` → `movePanel`/`extractPanel` on a panel absent
  // from the tree, which THROWS out of the React drop event handler (uncaught).
  //
  // jsdom getBoundingClientRect returns 0×0, so computeDropZone yields 'center'
  // (the degenerate guard), which routes to `movePanel(t, ghost, …)` →
  // `movePanel: panel not found` on HEAD. The contract: a drop carrying a
  // registered id NOT present in the tree is a NO-OP (no mutation, no throw).
  //
  // Registry has 'sim'/'editor'/'debug' (makeRegistry); the tree (makeTree) holds
  // exactly those three. We additionally register a 'ghost' panel that is NOT in
  // the tree, then drop it onto a group.

  /** A registry like makeRegistry() PLUS a registered-but-not-in-tree 'ghost'. */
  function makeRegistryWithGhost(): PanelRegistry {
    const reg = makeRegistry()
    reg.register({ kind: 'dom', id: 'ghost', title: 'Ghost' })
    return reg
  }

  /** A minimal DataTransfer stub whose getData returns `id` for both the custom
   * MIME and text/plain — exactly what a real drag payload would carry. */
  function dragPayload(id: string) {
    return {
      getData: (type: string) =>
        type === 'application/x-deck-panel' || type === 'text/plain' ? id : '',
    }
  }

  // React (dev) does not let a listener throw synchronously OUT of
  // `fireEvent.drop`; it re-raises the error through the DOM as a global `error`
  // event (jsdom dispatches it on `window`). So an `expect().not.toThrow()`
  // around `fireEvent.drop` would NOT see the mutation throw. Capture global
  // errors instead and assert none was raised — deterministic on HEAD (the
  // mutation throws `panel not found`) and after the fix (no-op, no error).
  function withCapturedGlobalErrors(run: () => void): Error[] {
    const captured: Error[] = []
    const onError = (e: ErrorEvent): void => {
      captured.push((e.error as Error) ?? new Error(e.message))
      e.preventDefault()
    }
    window.addEventListener('error', onError)
    try {
      run()
    }
    catch (e) {
      // Belt-and-braces: if a future React surfaces it synchronously, record it
      // here too (don't let it crash the runner).
      captured.push(e as Error)
    }
    finally {
      window.removeEventListener('error', onError)
    }
    return captured
  }

  it('a drop carrying a registered id that is NOT in the tree is a no-op (no error, no mutation)', () => {
    const model = createLayoutModel(makeTree())
    const { container } = renderDock(model, makeRegistryWithGhost())

    let revisions = 0
    model.subscribe(() => { revisions += 1 })
    const before = JSON.stringify(model.get())

    const right = container.querySelector('[data-deck-group="g-right"]') as DeckGroupElement

    // Firing the real DOM drop drives handleDrop → onRedock. On HEAD this raises
    // `movePanel: panel not found` (the drop zone is 'center' since jsdom
    // geometry is 0×0). The contract: it must be a NO-OP.
    const errors = withCapturedGlobalErrors(() => {
      fireEvent.drop(right, { dataTransfer: dragPayload('ghost') })
    })

    expect(errors.map((e) => e.message)).toEqual([])
    // No mutation: the tree is byte-for-byte unchanged and no subscriber fired.
    expect(JSON.stringify(model.get())).toBe(before)
    expect(revisions).toBe(0)
    // 'ghost' was never inserted into the tree.
    expect(countPanel(model.get().root, 'ghost')).toBe(0)
  })

  it('a drop carrying a registered id CLOSED out of the tree is a no-op (registry membership != tree membership)', () => {
    // Start with 'debug' in g-right, then close it from the tree (it stays
    // REGISTERED). A drop of 'debug' must NOT resurrect it / error.
    const model = createLayoutModel(makeTree())
    const { container } = renderDock(model, makeRegistry())

    // Close 'debug' out of the tree (still registered in the registry).
    act(() => {
      model.apply((t) => closePanel(t, 'debug'))
    })
    expect(countPanel(model.get().root, 'debug')).toBe(0)

    let revisions = 0
    model.subscribe(() => { revisions += 1 })
    const before = JSON.stringify(model.get())

    const left = container.querySelector('[data-deck-group="g-left"]') as DeckGroupElement
    const errors = withCapturedGlobalErrors(() => {
      fireEvent.drop(left, { dataTransfer: dragPayload('debug') })
    })

    expect(errors.map((e) => e.message)).toEqual([])
    expect(JSON.stringify(model.get())).toBe(before)
    expect(revisions).toBe(0)
    expect(countPanel(model.get().root, 'debug')).toBe(0)
  })
})

// ───────────────────── PanelCapabilities: draggable + dropPolicy ─────────────────────
//
// FAILING TDD spec for the NOT-YET-WIRED capability gates. The registry can now
// carry `draggable:false` and `dropPolicy:'reorder-only'` (PanelCapabilities);
// the DockView must HONOR them:
//
//   GOAL A (draggable:false):
//     - source: a tab for a `draggable:false` panel renders WITHOUT a truthy
//       `draggable` attribute (a default panel still renders draggable="true").
//     - target: a group whose ACTIVE panel is `draggable:false` rejects EVERY
//       drop zone (it is a no-op — no revision bump, byte-identical tree).
//
//   GOAL B (dropPolicy:'reorder-only'):
//     - a reorder-only panel may NEVER leave its group: a center drop into ANOTHER
//       group is a no-op, and ANY edge zone (own group or another) is a no-op.
//     - a reorder-only panel dropped center into its OWN group REORDERS within
//       that group (it does NOT stay a no-op — the current `isNoopRedock` would
//       wrongly swallow this; this test pins that the reorder DOES happen).
//
// Fixtures are SEPARATE from makeTree/makeRegistry so the existing free-panel
// cases above keep passing unchanged.
describe('<DockView> drag-to-redock — PanelCapabilities gates (draggable / dropPolicy)', () => {
	// root split[row] -> [ g-cap(pinned, sib) active=sib | g-free(free) active=free ]
	//   - 'pinned' : dropPolicy 'reorder-only'  (may reorder, never leave g-cap)
	//   - 'locked' : we substitute it as g-cap's ACTIVE panel in the draggable:false
	//     target test (see capsTreeLockedActive)
	function capsTree(): LayoutTree {
		return {
			version: 1,
			root: {
				kind: 'split',
				id: 'root',
				orientation: 'row',
				sizes: [1, 1],
				children: [
					// active = 'sib' (NOT 'pinned'), so a center drop of 'pinned' into its
					// own group anchors on a DIFFERENT sibling => a real reorder, not the
					// M1 self-no-op.
					{ kind: 'tabs', id: 'g-cap', panels: ['sib', 'pinned'], active: 'sib' },
					{ kind: 'tabs', id: 'g-free', panels: ['free'], active: 'free' },
				],
			},
		}
	}

	// A tree whose g-cap ACTIVE panel is a `draggable:false` panel — the GOAL-A
	// target case (the group must reject every drop onto its locked active panel).
	function capsTreeLockedActive(): LayoutTree {
		return {
			version: 1,
			root: {
				kind: 'split',
				id: 'root',
				orientation: 'row',
				sizes: [1, 1],
				children: [
					{ kind: 'tabs', id: 'g-lock', panels: ['locked'], active: 'locked' },
					{ kind: 'tabs', id: 'g-free', panels: ['free', 'free2'], active: 'free' },
				],
			},
		}
	}

	// Registry whose descriptors carry the new capability fields.
	// 'locked'  => draggable:false
	// 'pinned'  => dropPolicy:'reorder-only'
	// 'sib'/'free'/'free2' => default (permissive).
	function capsRegistry(): PanelRegistry {
		const reg = createPanelRegistry()
		// `draggable` / `dropPolicy` are PanelCapabilities fields the descriptors
		// will carry once the type extends PanelCapabilities. They are excess props
		// on the current descriptor type (the honest type failure the impl closes).
		reg.register({ kind: 'dom', id: 'locked', title: 'Locked', draggable: false })
		reg.register({ kind: 'dom', id: 'pinned', title: 'Pinned', dropPolicy: 'reorder-only' })
		reg.register({ kind: 'dom', id: 'sib', title: 'Sibling' })
		reg.register({ kind: 'dom', id: 'free', title: 'Free' })
		reg.register({ kind: 'dom', id: 'free2', title: 'Free 2' })
		return reg
	}

	const ALL_ZONES = ['center', 'left', 'right', 'top', 'bottom'] as const
	const EDGE_ZONES = ['left', 'right', 'top', 'bottom'] as const

	// ── GOAL A (source): the draggable affordance reflects the capability ──
	// BUG: the tab affordance ignores `draggable:false`, so a locked panel can
	// still be torn out by a drag gesture.
	it('GOAL A source: a draggable:false panel renders WITHOUT a truthy draggable attribute', () => {
		const model = createLayoutModel(capsTreeLockedActive())
		const { container } = renderDock(model, capsRegistry())
		const lockedTab = container.querySelector('[data-deck-tab="locked"]')!
		const freeTab = container.querySelector('[data-deck-tab="free"]')!
		// default panel stays draggable
		expect(freeTab.getAttribute('draggable')).toBe('true')
		// locked panel's draggable marker is absent / not "true"
		expect(lockedTab.getAttribute('draggable')).not.toBe('true')
	})

	// ── GOAL A (target): a group whose ACTIVE panel is draggable:false rejects ──
	//    EVERY drop zone (no-op, no churn). 'draggable:false' locks the panel as a
	//    drop ANCHOR too — nothing may dock onto it.
	// BUG: handleRedock anchors on the group's active panel without checking its
	// capabilities, so a free panel can be docked onto a locked anchor.
	for (const zone of ALL_ZONES) {
		it(`GOAL A target: dropping a free panel onto a group with a draggable:false ACTIVE panel is a no-op (zone="${zone}")`, () => {
			const model = createLayoutModel(capsTreeLockedActive())
			const { container } = renderDock(model, capsRegistry())

			let revisions = 0
			model.subscribe(() => { revisions += 1 })
			const before = JSON.stringify(model.get())

			const gLock = container.querySelector('[data-deck-group="g-lock"]') as DeckGroupElement
			expect(typeof gLock.__deckHandleDrop).toBe('function')
			act(() => {
				gLock.__deckHandleDrop!('free', zone)
			})

			expect(revisions).toBe(0)
			expect(JSON.stringify(model.get())).toBe(before)
		})
	}

	// ── GOAL B (leave-group blocked): center into ANOTHER group is a no-op ──
	// BUG: a reorder-only panel can be torn into a different group by a center
	// drop, violating its "may only reorder within its own group" policy.
	it('GOAL B: dropping a reorder-only panel into a DIFFERENT group center is a no-op', () => {
		const model = createLayoutModel(capsTree())
		const { container } = renderDock(model, capsRegistry())

		let revisions = 0
		model.subscribe(() => { revisions += 1 })
		const before = JSON.stringify(model.get())

		const gFree = container.querySelector('[data-deck-group="g-free"]') as DeckGroupElement
		act(() => {
			gFree.__deckHandleDrop!('pinned', 'center')
		})

		expect(revisions).toBe(0)
		expect(JSON.stringify(model.get())).toBe(before)
		// 'pinned' never left g-cap.
		expect(findGroupOf(model.get().root, 'pinned')!.id).toBe('g-cap')
		expect(countPanel(model.get().root, 'pinned')).toBe(1)
	})

	// ── GOAL B (leave-group blocked): ANY edge zone is a no-op — own group OR ──
	//    another group. A reorder-only panel must never SPLIT out of its group.
	for (const zone of EDGE_ZONES) {
		it(`GOAL B: edge-dropping a reorder-only panel into ANOTHER group is a no-op (zone="${zone}")`, () => {
			const model = createLayoutModel(capsTree())
			const { container } = renderDock(model, capsRegistry())

			let revisions = 0
			model.subscribe(() => { revisions += 1 })
			const before = JSON.stringify(model.get())

			const gFree = container.querySelector('[data-deck-group="g-free"]') as DeckGroupElement
			act(() => {
				gFree.__deckHandleDrop!('pinned', zone)
			})

			expect(revisions).toBe(0)
			expect(JSON.stringify(model.get())).toBe(before)
			expect(findGroupOf(model.get().root, 'pinned')!.id).toBe('g-cap')
		})

		it(`GOAL B: edge-dropping a reorder-only panel into its OWN group is a no-op (zone="${zone}")`, () => {
			const model = createLayoutModel(capsTree())
			const { container } = renderDock(model, capsRegistry())

			let revisions = 0
			model.subscribe(() => { revisions += 1 })
			const before = JSON.stringify(model.get())

			const gCap = container.querySelector('[data-deck-group="g-cap"]') as DeckGroupElement
			act(() => {
				gCap.__deckHandleDrop!('pinned', zone)
			})

			// An edge zone within its own group would SPLIT it out — forbidden, so
			// no-op: 'pinned' stays a member of g-cap and the tree is unchanged.
			expect(revisions).toBe(0)
			expect(JSON.stringify(model.get())).toBe(before)
			expect(findGroupOf(model.get().root, 'pinned')!.id).toBe('g-cap')
			expect(countPanel(model.get().root, 'pinned')).toBe(1)
		})
	}

	// ── GOAL B (reorder allowed): center into its OWN group REORDERS ──
	// BUG: the current `isNoopRedock` swallows a center drop back into the dragged
	// panel's own group (M2), so a reorder-only panel can NEVER reorder — the one
	// thing its policy is supposed to permit. The reorder-only policy must OVERRIDE
	// that no-op and reorder the panel within its group.
	//
	// g-cap = [sib, pinned] active=sib. Dropping 'pinned' center anchors on the
	// active sibling 'sib' => 'pinned' reorders relative to 'sib'. The panel set is
	// unchanged, 'pinned' stays in g-cap, and the `panels` ORDER changes.
	it('GOAL B: dropping a reorder-only panel center into its OWN group REORDERS it (not a no-op)', () => {
		const model = createLayoutModel(capsTree())
		const { container } = renderDock(model, capsRegistry())

		const beforeGroup = findGroupOf(model.get().root, 'pinned')!
		expect(beforeGroup.id).toBe('g-cap')
		expect([...beforeGroup.panels]).toEqual(['sib', 'pinned'])

		let revisions = 0
		model.subscribe(() => { revisions += 1 })

		const gCap = container.querySelector('[data-deck-group="g-cap"]') as DeckGroupElement
		act(() => {
			gCap.__deckHandleDrop!('pinned', 'center')
		})

		const afterGroup = findGroupOf(model.get().root, 'pinned')!
		// It REORDERED: a mutation happened (revision bumped) and the order changed.
		expect(revisions).toBeGreaterThan(0)
		// Panel set unchanged, still exactly once, still in g-cap.
		expect(afterGroup.id).toBe('g-cap')
		expect(countPanel(model.get().root, 'pinned')).toBe(1)
		expect([...afterGroup.panels].sort()).toEqual(['pinned', 'sib'])
		// The ORDER moved relative to the sibling: 'pinned' is no longer in its
		// original [sib, pinned] slot — it was re-inserted relative to the active
		// anchor 'sib', so the order is now ['pinned', 'sib'].
		expect([...afterGroup.panels]).not.toEqual(['sib', 'pinned'])
	})
})

describe('<DockView> drag-to-redock — real-pointer cases (e2e only)', () => {
	// jsdom returns 0 from getBoundingClientRect/offsetWidth, so a real
	// drag-hover cannot select a geometry-driven zone or render the
	// `data-deck-drop-zone` overlay deterministically. The geometry truth is
	// pinned in the node suite (drag-redock.test.ts); these two require a real
	// browser / pointer driver.
	// COVERED by the real-pointer e2e: packages/devtools/e2e/dock-real-drag.spec.ts
	// ("POINT 1+2 LEFT band" / "POINT 1+2 CENTER"). That spec drives a real HTML5
	// DnD event sequence in a live Electron renderer with real geometry, asserting
	// both the `data-deck-drop-zone` indicator zone AND the resulting tree mutation.
	// Kept as `todo` here because jsdom (getBoundingClientRect is 0) cannot.
	it.todo('dragging a tab over the LEFT band of a group shows data-deck-drop-zone="left" and drops to split-left — covered by e2e dock-real-drag.spec.ts (jsdom getBoundingClientRect is 0)')
	it.todo('dragging a tab into the CENTER of a group shows data-deck-drop-zone="center" and drops to join — covered by e2e dock-real-drag.spec.ts (jsdom getBoundingClientRect is 0)')
})
