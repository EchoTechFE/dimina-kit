/**
 * Contract spec — end-to-end tab reorder via the tab-strip drop path.
 *
 * A `reorder-only` tab dropped onto its own strip commits a within-group reorder
 * whose insertion index is derived from the pointer x over the visible tab rects.
 * Dragging a tab RIGHTWARD must land it exactly at the gap under the pointer, not
 * one slot further right: dropping A between B and C yields [B, A, C].
 *
 * jsdom's getBoundingClientRect is 0×0, so each tab's rect is stubbed to a real
 * horizontal layout (100px-wide tabs laid end to end) and the drop carries a
 * clientX inside the B|C gap.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { render, cleanup, fireEvent, createEvent } from '@testing-library/react'
import {
	createLayoutModel,
	createPanelRegistry,
	type LayoutModel,
	type LayoutNode,
	type LayoutTree,
	type PanelRegistry,
	type TabGroupNode,
} from '../layout/index.js'
import { DockView } from './index.js'

function makeTree(): LayoutTree {
	return {
		version: 1,
		root: { kind: 'tabs', id: 'g', panels: ['A', 'B', 'C'], active: 'A' },
	}
}

function makeRegistry(): PanelRegistry {
	const reg = createPanelRegistry()
	// reorder-only so the tab-strip drop path (pointer-derived index) is exercised.
	reg.register({ kind: 'dom', id: 'A', title: 'A', dropPolicy: 'reorder-only' })
	reg.register({ kind: 'dom', id: 'B', title: 'B', dropPolicy: 'reorder-only' })
	reg.register({ kind: 'dom', id: 'C', title: 'C', dropPolicy: 'reorder-only' })
	return reg
}

function domBody(panelId: string) {
	return <div data-test-dom-content={panelId}>BODY:{panelId}</div>
}

function renderDock(model: LayoutModel, registry: PanelRegistry) {
	return render(
		<DockView model={model} registry={registry} renderDomPanel={domBody} bindNativeSlot={() => {}} />,
	)
}

function groupOf(root: LayoutNode, id: string): TabGroupNode {
	let found: TabGroupNode | null = null
	const walk = (n: LayoutNode): void => {
		if (n.kind === 'tabs') { if (n.id === id) found = n }
		else n.children.forEach(walk)
	}
	walk(root)
	return found!
}

/** Stub each visible tab's rect: 100px wide, laid out end to end from x=0. */
function stubTabRects(container: HTMLElement): void {
	const tabsEls = Array.from(container.querySelectorAll<HTMLElement>('[data-deck-tab]'))
	tabsEls.forEach((el, i) => {
		el.getBoundingClientRect = () => ({
			left: i * 100, right: i * 100 + 100, width: 100,
			top: 0, bottom: 20, height: 20, x: i * 100, y: 0,
			toJSON() {},
		}) as DOMRect
	})
}

function dropPayload(id: string) {
	return {
		types: ['application/x-deck-panel', 'text/plain'],
		getData: (t: string) => (t === 'application/x-deck-panel' || t === 'text/plain' ? id : ''),
		setData() {},
		effectAllowed: 'move',
	}
}

beforeEach(() => {
	cleanup()
})

describe('<DockView> tab reorder — rightward drop lands under the pointer', () => {
	it('dropping A into the gap between B and C yields [B, A, C]', () => {
		const model = createLayoutModel(makeTree())
		const { container } = renderDock(model, makeRegistry())
		stubTabRects(container)

		const strip = container.querySelector('[data-deck-group="g"] [role="tablist"]') as HTMLElement
		// midpoints: A=50, B=150, C=250. clientX=210 passes A and B (strip index 2),
		// still left of C's midpoint => the B|C gap. `fireEvent.drop`'s init does not
		// carry clientX onto the native event, so build the event and pin clientX.
		const ev = createEvent.drop(strip, { dataTransfer: dropPayload('A') })
		Object.defineProperty(ev, 'clientX', { value: 210 })
		fireEvent(strip, ev)

		expect([...groupOf(model.get().root, 'g').panels]).toEqual(['B', 'A', 'C'])
	})
})
