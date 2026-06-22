/**
 * FAILING TDD spec for the NOT-YET-WRITTEN "panel close" affordance in
 * `<DockView>`. Mirrors the harness/fixtures of `dock-view.test.tsx`.
 *
 * NEW `data-*` contract this file pins down:
 *
 *   data-deck-tab-close="<panelId>"   a <button> rendered INSIDE each tab in a
 *                                     group's tab strip. Clicking it drives
 *                                     model.apply(t => closePanel(t, panelId)),
 *                                     removing the panel from the canonical tree
 *                                     (re-render drops its tab + body).
 *
 * Boundary / interaction contract (each test names the bug it guards):
 *  - LAST-PANEL: when exactly ONE panel remains in the WHOLE tree, that panel's
 *    close button is NOT rendered. With >1 panel, close buttons ARE rendered.
 *  - Clicking close on an INACTIVE tab closes it WITHOUT activating it (no
 *    setActive churn) and does not start a drag.
 *  - Closing the ACTIVE panel of a multi-panel group re-selects a surviving
 *    sibling (closePanel's deriveActive) whose body then renders.
 *  - Closing an ACTIVE NATIVE panel unmounts the slot -> bindNativeSlot(id, null)
 *    is called, the native slot leaves the DOM, and the dom sibling's body shows.
 *
 * These MUST fail now: the component renders no `data-deck-tab-close` button at
 * all. They must NOT fail from test-infra issues.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, act, cleanup } from '@testing-library/react'
import {
	createLayoutModel,
	createPanelRegistry,
	type LayoutTree,
	type LayoutModel,
	type PanelRegistry,
} from '../layout/index.js'

// Import the component-under-test (same honest failure point as dock-view.test).
import { DockView } from './index.js'

// ───────────────────────── fixtures ─────────────────────────
// (mirrors dock-view.test.tsx)

/** root split[row] -> [ tabs g-left(sim) | tabs g-right(editor, debug) ] */
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
				{
					kind: 'tabs',
					id: 'g-right',
					panels: ['editor', 'debug'],
					active: 'editor',
				},
			],
		},
	}
}

/** A group holding one native + one dom panel, native active. */
function makeNativeTree(): LayoutTree {
	return {
		version: 1,
		root: {
			kind: 'split',
			id: 'root',
			orientation: 'column',
			sizes: [1],
			children: [
				{ kind: 'tabs', id: 'g', panels: ['nativeCam', 'logs'], active: 'nativeCam' },
			],
		},
	}
}

/** A single group holding exactly ONE panel — the whole tree has one panel. */
function makeSoloTree(): LayoutTree {
	return {
		version: 1,
		root: { kind: 'tabs', id: 'only', panels: ['sim'], active: 'sim' },
	}
}

function makeRegistry(): PanelRegistry {
	const reg = createPanelRegistry()
	reg.register({ kind: 'dom', id: 'sim', title: 'Simulator' })
	reg.register({ kind: 'dom', id: 'editor', title: 'Editor' })
	reg.register({ kind: 'dom', id: 'debug', title: 'Debug' })
	reg.register({ kind: 'dom', id: 'logs', title: 'Logs' })
	reg.register({
		kind: 'native',
		id: 'nativeCam',
		title: 'Camera',
		nativeRef: { id: 'native-cam-handle' },
	})
	return reg
}

function makeRegistryWithLockedDebug(): PanelRegistry {
	const reg = makeRegistry()
	reg.register({
		kind: 'dom',
		id: 'debug',
		title: 'Debug',
		closable: false,
	})
	return reg
}

/** Default renderDomPanel: a marker node so tests can assert which body rendered. */
function domBody(panelId: string) {
	return <div data-test-dom-content={panelId}>BODY:{panelId}</div>
}

function renderDock(opts: {
	model: LayoutModel
	registry: PanelRegistry
	renderDomPanel?: (id: string) => React.ReactNode
	bindNativeSlot?: (id: string, el: HTMLElement | null) => void
}) {
	const renderDomPanel = opts.renderDomPanel ?? domBody
	const bindNativeSlot = opts.bindNativeSlot ?? (() => {})
	return render(
		<DockView
			model={opts.model}
			registry={opts.registry}
			renderDomPanel={renderDomPanel}
			bindNativeSlot={bindNativeSlot}
		/>,
	)
}

beforeEach(() => {
	cleanup()
})

// ───────────────────────── tests ─────────────────────────

describe('<DockView> close affordance — rendering', () => {
	// BUG: impl renders no close button on tabs, so there is no way to close a
	// panel from the UI at all.
	it('renders a close affordance with data-deck-tab-close per tab when >1 panel exists', () => {
		const { container } = renderDock({ model: createLayoutModel(makeTree()), registry: makeRegistry() })
		const editorClose = container.querySelector('[data-deck-tab-close="editor"]')
		const debugClose = container.querySelector('[data-deck-tab-close="debug"]')
		const simClose = container.querySelector('[data-deck-tab-close="sim"]')
		expect(editorClose).not.toBeNull()
		expect(debugClose).not.toBeNull()
		expect(simClose).not.toBeNull()
		// It is a `role="button"` affordance — keyboard/AT operable — but NOT a real
		// <button> element: an interactive <button> may not be a descendant of the
		// tab <button> (invalid HTML + illegal a11y nesting), so it is a focusable
		// role-button span instead.
		expect(editorClose!.getAttribute('role')).toBe('button')
		expect(editorClose!.tagName).not.toBe('BUTTON')
		expect(editorClose!.getAttribute('tabindex')).toBe('0')
	})

	// BUG: the close button is nested INSIDE the tab so the host can scope it to
	// the tab; a close button orphaned from its tab would target the wrong panel.
	it('nests each close button inside its own tab button', () => {
		const { container } = renderDock({ model: createLayoutModel(makeTree()), registry: makeRegistry() })
		const editorTab = container.querySelector('[data-deck-tab="editor"]')!
		expect(editorTab.querySelector('[data-deck-tab-close="editor"]')).not.toBeNull()
	})

	it('does not render a close affordance when the descriptor sets closable:false', () => {
		const { container } = renderDock({
			model: createLayoutModel(makeTree()),
			registry: makeRegistryWithLockedDebug(),
		})

		expect(container.querySelector('[data-deck-tab="debug"]')).not.toBeNull()
		expect(container.querySelector('[data-deck-tab-close="debug"]')).toBeNull()
		expect(container.querySelector('[data-deck-tab-close="editor"]')).not.toBeNull()
	})
})

describe('<DockView> close affordance — last-panel boundary', () => {
	// BUG: rendering a close button on the only remaining panel lets the user
	// close the whole layout into nothing; the last panel must NOT show close.
	it('does NOT render a close button for the only panel in the whole tree', () => {
		const { container } = renderDock({ model: createLayoutModel(makeSoloTree()), registry: makeRegistry() })
		// the tab itself still renders…
		expect(container.querySelector('[data-deck-tab="sim"]')).not.toBeNull()
		// …but its close affordance is suppressed.
		expect(container.querySelector('[data-deck-tab-close="sim"]')).toBeNull()
	})

	// BUG: a too-aggressive last-panel suppression hides close on EVERY panel of
	// a single multi-panel group; with >1 panel total, closes must still appear.
	it('renders close buttons when more than one panel exists', () => {
		const { container } = renderDock({ model: createLayoutModel(makeTree()), registry: makeRegistry() })
		expect(container.querySelectorAll('[data-deck-tab-close]').length).toBeGreaterThan(1)
	})
})

describe('<DockView> close affordance — interaction', () => {
	// BUG: clicking close does nothing (or mutates local state), so the canonical
	// tree never loses the panel and the close is purely cosmetic.
	it('clicking close drives model.apply(closePanel) and removes the tab + body', () => {
		const model = createLayoutModel(makeTree())
		const { container } = renderDock({ model, registry: makeRegistry() })

		// before: debug is a tab in g-right (inactive, body not rendered).
		expect(container.querySelector('[data-deck-tab="debug"]')).not.toBeNull()

		const debugClose = container.querySelector('[data-deck-tab-close="debug"]')!
		act(() => {
			fireEvent.click(debugClose)
		})

		// canonical tree no longer holds debug in g-right.
		const grp = (model.get().root as any).children.find((c: any) => c.id === 'g-right')
		expect(grp.panels).toEqual(['editor'])
		// DOM dropped the debug tab + its close button.
		expect(container.querySelector('[data-deck-tab="debug"]')).toBeNull()
		expect(container.querySelector('[data-deck-tab-close="debug"]')).toBeNull()
		// editor still present and active.
		expect(container.querySelector('[data-deck-panel-body="editor"]')).not.toBeNull()
	})

	// BUG: the close button's click bubbles to the tab's activate handler, so
	// clicking close on an INACTIVE tab first activates it (visible flicker /
	// wrong active) instead of just closing it.
	it('clicking close on an INACTIVE tab closes it WITHOUT activating it', () => {
		const model = createLayoutModel(makeTree())
		const { container } = renderDock({ model, registry: makeRegistry() })

		// g-right active=editor; debug is inactive.
		expect((model.get().root as any).children.find((c: any) => c.id === 'g-right').active).toBe('editor')

		const debugClose = container.querySelector('[data-deck-tab-close="debug"]')!
		act(() => {
			fireEvent.click(debugClose)
		})

		// debug removed; active stayed editor (close never routed through setActive).
		const grp = (model.get().root as any).children.find((c: any) => c.id === 'g-right')
		expect(grp.panels).toEqual(['editor'])
		expect(grp.active).toBe('editor')
		expect(container.querySelector('[data-deck-panel-body="editor"]')).not.toBeNull()
		expect(container.querySelector('[data-deck-panel-body="debug"]')).toBeNull()
	})

	// BUG: closing the ACTIVE panel leaves the group with no valid active (or
	// renders the closed panel's stale body); deriveActive must pick a sibling
	// whose body then renders.
	it('closing the ACTIVE panel re-selects a surviving sibling and renders its body', () => {
		const model = createLayoutModel(makeTree())
		const { container } = renderDock({ model, registry: makeRegistry() })

		// g-right active=editor; editor body is the one rendered.
		expect(container.querySelector('[data-deck-panel-body="editor"]')).not.toBeNull()

		const editorClose = container.querySelector('[data-deck-tab-close="editor"]')!
		act(() => {
			fireEvent.click(editorClose)
		})

		const grp = (model.get().root as any).children.find((c: any) => c.id === 'g-right')
		expect(grp.panels).toEqual(['debug'])
		expect(grp.active).toBe('debug')
		// closed panel's body gone, surviving sibling's body present.
		expect(container.querySelector('[data-deck-panel-body="editor"]')).toBeNull()
		expect(container.querySelector('[data-deck-panel-body="debug"]')).not.toBeNull()
	})

	// BUG: the HTML5 drag source is the draggable ANCESTOR (the tab), so a press
	// that BEGINS on the close × fires the tab's onDragStart with e.target === ×.
	// A descendant stopPropagation cannot cancel an ancestor's drag — the tab's
	// handler must detect the close-affordance origin and preventDefault WITHOUT
	// writing the drag payload, else a fat-finger drag-off-close yanks the tab.
	it('a drag that BEGINS on the close affordance does not start a tab drag', () => {
		const model = createLayoutModel(makeTree())
		const { container } = renderDock({ model, registry: makeRegistry() })

		const debugClose = container.querySelector('[data-deck-tab-close="debug"]')! as HTMLElement
		const debugTab = container.querySelector('[data-deck-tab="debug"]')! as HTMLElement

		// Drag BEGINS on the close span: bubbles to the tab's onDragStart with
		// e.target === closeSpan. Guard must preventDefault + skip setData.
		const closeSetData = vi.fn()
		const closeDt = { setData: closeSetData, effectAllowed: '' }
		const notPrevented = fireEvent.dragStart(debugClose, { dataTransfer: closeDt })

		// fireEvent returns false when default was prevented → drag aborted.
		expect(notPrevented).toBe(false)
		// No drag payload was written for the panel (no MIME, no fallback).
		expect(closeSetData).not.toHaveBeenCalled()

		// CONTROL: a drag on the TAB ITSELF (target = tab, not ×) is a real tab
		// drag — proves the guard is scoped to close-origin, not killing all drags.
		const tabSetData = vi.fn()
		const tabDt = { setData: tabSetData, effectAllowed: '' }
		fireEvent.dragStart(debugTab, { dataTransfer: tabDt })

		expect(tabSetData).toHaveBeenCalledWith('application/x-deck-panel', 'debug')
		expect(tabSetData).toHaveBeenCalledWith('text/plain', 'debug')
	})
})

describe('<DockView> close affordance — native lifecycle', () => {
	// BUG: closing an active native panel leaves the host's native view anchored
	// to a slot that's been removed; the close must unbind via
	// bindNativeSlot(id, null) AND remove the slot, surfacing the dom sibling.
	it('closing an active NATIVE panel unbinds the slot and renders the dom sibling', () => {
		const bind = vi.fn()
		const model = createLayoutModel(makeNativeTree())
		const { container } = renderDock({ model, registry: makeRegistry(), bindNativeSlot: bind })

		// nativeCam active -> its slot is bound + present; logs body not yet shown.
		expect(container.querySelector('[data-deck-native-slot="nativeCam"]')).not.toBeNull()
		bind.mockClear()

		const nativeClose = container.querySelector('[data-deck-tab-close="nativeCam"]')!
		act(() => {
			fireEvent.click(nativeClose)
		})

		// the native slot is unbound on unmount.
		const nullCall = bind.mock.calls.find((c) => c[0] === 'nativeCam' && c[1] === null)
		expect(nullCall).toBeTruthy()
		// the slot left the DOM.
		expect(container.querySelector('[data-deck-native-slot="nativeCam"]')).toBeNull()
		// nativeCam gone from the canonical group; logs is the survivor + active.
		// makeNativeTree's root is a SINGLE-child split, so removing nativeCam
		// collapses that split to the bare tabgroup `g` — root may now BE the
		// tabgroup rather than a split with `.children`. Resolve `g` either way.
		const root = model.get().root as any
		const grp = root.id === 'g' ? root : root.children.find((c: any) => c.id === 'g')
		expect(grp.panels).toEqual(['logs'])
		expect(grp.active).toBe('logs')
		// the dom sibling's body now renders.
		expect(container.querySelector('[data-deck-panel-body="logs"]')).not.toBeNull()
	})
})
