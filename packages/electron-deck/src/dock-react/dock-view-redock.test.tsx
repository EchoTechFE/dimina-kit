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
import { render, act, cleanup } from '@testing-library/react'
import {
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

describe('<DockView> drag-to-redock — real-pointer cases (e2e only)', () => {
	// jsdom returns 0 from getBoundingClientRect/offsetWidth, so a real
	// drag-hover cannot select a geometry-driven zone or render the
	// `data-deck-drop-zone` overlay deterministically. The geometry truth is
	// pinned in the node suite (drag-redock.test.ts); these two require a real
	// browser / pointer driver.
	it.todo('dragging a tab over the LEFT band of a group shows data-deck-drop-zone="left" and drops to split-left — needs e2e/real-pointer (jsdom getBoundingClientRect is 0)')
	it.todo('dragging a tab into the CENTER of a group shows data-deck-drop-zone="center" and drops to join — needs e2e/real-pointer (jsdom getBoundingClientRect is 0)')
})
