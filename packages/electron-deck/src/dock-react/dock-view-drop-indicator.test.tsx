/**
 * Contract spec for the drop-zone indicator's awareness of dragged panel policy.
 *
 * The indicator is geometry-only BY DEFAULT: even while a `reorder-only` panel is
 * dragged over a foreign group body it still paints (the capability gate rejects
 * the drop at drop time, not hover time — devtools relies on this). A host can
 * OPT IN via `suppressReorderOnlyDropIndicator` to hide the misleading highlight
 * for a reorder-only source; the web client opts in.
 *
 * DataTransfer.getData() is empty during `dragover` (W3C spec restricts value
 * access to dragstart/drop only), so the implementation records the in-flight
 * panel id at dragstart time and consults it during dragover. Tests drive
 * dragstart first to establish that context, then dragover on the target group.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import {
	createLayoutModel,
	createPanelRegistry,
	type LayoutModel,
	type PanelRegistry,
	type LayoutTree,
} from '../layout/index.js'
import { DockView } from './index.js'

// ───────────────────────── helpers ─────────────────────────

/**
 * Minimal DataTransfer stub for `fireEvent.dragStart`. jsdom's DataTransfer
 * is null on synthetically constructed DragEvents; the React `onDragStart`
 * handler calls `setData` and assigns `effectAllowed`, so both must exist and
 * not throw. `getData` is unused at dragstart time but included for symmetry.
 */
function dragStartTransfer() {
	return {
		dataTransfer: {
			setData(_type: string, _value: string): void {},
			getData(_type: string): string { return '' },
			effectAllowed: 'none' as string,
			types: [] as string[],
		},
	}
}

// ───────────────────────── fixtures ─────────────────────────

/**
 * root split[row] -> [ g-cap(sib, pinned) active=sib | g-free(free) active=free ]
 *   - 'pinned' : dropPolicy 'reorder-only'  (may only reorder within g-cap)
 *   - 'sib'    : default (permissive), companion in g-cap
 *   - 'free'   : default (permissive), sole panel in g-free
 */
function makeTree(): LayoutTree {
	return {
		version: 1,
		root: {
			kind: 'split',
			id: 'root',
			orientation: 'row',
			sizes: [1, 1],
			children: [
				{ kind: 'tabs', id: 'g-cap', panels: ['sib', 'pinned'], active: 'sib' },
				{ kind: 'tabs', id: 'g-free', panels: ['free'], active: 'free' },
			],
		},
	}
}

function makeRegistry(): PanelRegistry {
	const reg = createPanelRegistry()
	reg.register({ kind: 'dom', id: 'pinned', title: 'Pinned', dropPolicy: 'reorder-only' })
	reg.register({ kind: 'dom', id: 'sib', title: 'Sibling' })
	reg.register({ kind: 'dom', id: 'free', title: 'Free' })
	return reg
}

function domBody(panelId: string) {
	return <div data-test-dom-content={panelId}>BODY:{panelId}</div>
}

function renderDock(model: LayoutModel, registry: PanelRegistry, suppress = false) {
	return render(
		<DockView
			model={model}
			registry={registry}
			renderDomPanel={domBody}
			bindNativeSlot={() => {}}
			suppressReorderOnlyDropIndicator={suppress}
		/>,
	)
}

beforeEach(() => {
	cleanup()
})

// ───────────────────────── tests ─────────────────────────

describe('<DockView> drop indicator — reorder-only source policy', () => {
	/**
	 * Opted in (`suppressReorderOnlyDropIndicator`), no drop-zone indicator must
	 * appear on any group body other than the source group while a reorder-only
	 * panel is the drag source. The indicator's presence implies the group accepts
	 * the drop; a foreign group never does for a reorder-only panel.
	 *
	 * The implementation tracks the in-flight panel id via a module-level variable
	 * set at dragstart (DataTransfer values are unreadable during dragover). This
	 * test drives dragstart first to establish that context, then dragover on the
	 * foreign group, and asserts the indicator element is absent.
	 */
	it('suppresses the drop indicator while a reorder-only panel is dragged over a foreign group (opted in)', () => {
		const model = createLayoutModel(makeTree())
		const { container } = renderDock(model, makeRegistry(), true)

		const pinnedTab = container.querySelector('[data-deck-tab="pinned"]')!
		const gFree = container.querySelector('[data-deck-group="g-free"]')!

		// Establish the in-flight drag context from the reorder-only tab.
		// A working dataTransfer stub is required: jsdom's synthetic DragEvent has a
		// null dataTransfer, which would throw at `setData` in the onDragStart handler
		// before `activeDragPanelId` is set — the same reason M2 drop tests supply a
		// stub. Only `setData` and `effectAllowed` need to exist; values are not read.
		fireEvent.dragStart(pinnedTab, dragStartTransfer())

		// Dragover on the foreign group: the indicator must stay absent.
		fireEvent.dragOver(gFree)

		expect(gFree.querySelector('[data-deck-drop-zone]')).toBeNull()
	})

	/**
	 * Default (NOT opted in): the indicator is geometry-only and STILL paints over
	 * a foreign group even for a reorder-only source — the capability gate rejects
	 * the drop at drop time, not at hover time. This is the contract devtools'
	 * `dock-real-drag` e2e relies on; suppressing by default would break it.
	 */
	it('still shows the drop indicator for a reorder-only panel by default (not opted in)', () => {
		const model = createLayoutModel(makeTree())
		const { container } = renderDock(model, makeRegistry())

		const pinnedTab = container.querySelector('[data-deck-tab="pinned"]')!
		const gFree = container.querySelector('[data-deck-group="g-free"]')!

		fireEvent.dragStart(pinnedTab, dragStartTransfer())
		fireEvent.dragOver(gFree)

		expect(gFree.querySelector('[data-deck-drop-zone]')).not.toBeNull()
	})

	/**
	 * A free (default-policy) panel under the same scenario must still produce the
	 * drop indicator on dragover — the suppression is policy-specific, not a blanket
	 * regression on the indicator feature.
	 */
	it('still shows the drop indicator when a free panel is dragged over a foreign group', () => {
		const model = createLayoutModel(makeTree())
		const { container } = renderDock(model, makeRegistry())

		const freeTab = container.querySelector('[data-deck-tab="free"]')!
		const gCap = container.querySelector('[data-deck-group="g-cap"]')!

		// Establish the in-flight drag context from the free panel's tab.
		fireEvent.dragStart(freeTab, dragStartTransfer())

		// Dragover on the other group: the indicator must appear.
		fireEvent.dragOver(gCap)

		expect(gCap.querySelector('[data-deck-drop-zone]')).not.toBeNull()
	})
})
