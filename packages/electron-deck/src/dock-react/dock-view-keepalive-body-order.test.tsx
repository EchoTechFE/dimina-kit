/**
 * Contract spec — kept-alive DOM body ordering is decoupled from tab order.
 *
 * `data-deck-panel-body` elements are mounted under stable keys so a tab activation
 * never remounts a body. Their DOM SIBLING ORDER must likewise be independent of the
 * `panels` (tab) order: reordering the tabs must not move a body's DOM node. A web
 * host renders panel bodies as iframes; moving an iframe DOM node reloads it, so a
 * pure tab reorder must leave every body node in place (same instance, same order).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import {
	createLayoutModel,
	createPanelRegistry,
	movePanel,
	type LayoutModel,
	type LayoutTree,
	type PanelRegistry,
} from '../layout/index.js'
import { DockView } from './index.js'

function makeTree(): LayoutTree {
	return {
		version: 1,
		root: { kind: 'tabs', id: 'g', panels: ['A', 'B'], active: 'A' },
	}
}

function makeRegistry(): PanelRegistry {
	const reg = createPanelRegistry()
	reg.register({ kind: 'dom', id: 'A', title: 'A' })
	reg.register({ kind: 'dom', id: 'B', title: 'B' })
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

function bodyOrder(container: HTMLElement): string[] {
	return Array.from(container.querySelectorAll('[data-deck-panel-body]'))
		.map((el) => el.getAttribute('data-deck-panel-body')!)
}

function tabOrder(container: HTMLElement): string[] {
	return Array.from(container.querySelectorAll('[data-deck-tab]'))
		.map((el) => el.getAttribute('data-deck-tab')!)
}

beforeEach(() => {
	cleanup()
})

describe('<DockView> keepalive — body DOM order survives a tab reorder', () => {
	it('reordering tabs [A,B] -> [B,A] moves the tabs but not the body DOM nodes', () => {
		const model = createLayoutModel(makeTree())
		const { container } = renderDock(model, makeRegistry())

		const bodyOrderBefore = bodyOrder(container)
		const bodyA = container.querySelector('[data-deck-panel-body="A"]')
		const bodyB = container.querySelector('[data-deck-panel-body="B"]')
		expect(tabOrder(container)).toEqual(['A', 'B'])

		// Reorder the tab strip so tab order becomes [B, A].
		act(() => {
			model.apply((t) => movePanel(t, 'B', { groupId: 'g', index: 0 }))
		})

		// The tabs reordered...
		expect(tabOrder(container)).toEqual(['B', 'A'])
		// ...but each body is the SAME DOM node (not remounted)...
		expect(container.querySelector('[data-deck-panel-body="A"]')).toBe(bodyA)
		expect(container.querySelector('[data-deck-panel-body="B"]')).toBe(bodyB)
		// ...and their DOM sibling order is unchanged (no node was moved).
		expect(bodyOrder(container)).toEqual(bodyOrderBefore)
	})
})
