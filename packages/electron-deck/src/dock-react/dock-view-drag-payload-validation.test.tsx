/**
 * Contract spec — drag payloads are validated against the deck's own MIME.
 *
 * The group body must only react to a drag that carries the deck panel MIME
 * (`application/x-deck-panel`). An OS drag (files, external text) exposes other
 * types and a `text/plain` value that may COINCIDE with a registered panel id;
 * neither may drive a layout change nor paint a drop indicator. A genuine deck
 * drag (custom MIME present) still works.
 *
 * The tab STRIP dragover already gates on `dataTransfer.types` — the group body is
 * held to the same contract here.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
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

const DECK_MIME = 'application/x-deck-panel'

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
		<DockView model={model} registry={registry} renderDomPanel={domBody} bindNativeSlot={() => {}} />,
	)
}

function groupOf(root: LayoutNode, panelId: string): TabGroupNode {
	let found: TabGroupNode | null = null
	const walk = (n: LayoutNode): void => {
		if (n.kind === 'tabs') { if (n.panels.includes(panelId)) found = n }
		else n.children.forEach(walk)
	}
	walk(root)
	return found!
}

/** A DataTransfer stub carrying `types` and `text/plain`, but NO deck MIME. */
function foreignPayload(types: string[], text: string) {
	return {
		types,
		getData: (t: string) => (t === 'text/plain' ? text : ''),
		setData() {},
		effectAllowed: 'copy',
	}
}

/** A DataTransfer stub carrying the deck MIME (a genuine deck drag). */
function deckPayload(id: string) {
	return {
		types: [DECK_MIME, 'text/plain'],
		getData: (t: string) => (t === DECK_MIME || t === 'text/plain' ? id : ''),
		setData() {},
		effectAllowed: 'move',
	}
}

beforeEach(() => {
	cleanup()
})

describe('<DockView> drag payload validation — non-deck MIME is inert', () => {
	it('dragover carrying only foreign types (no deck MIME) shows no drop indicator', () => {
		const { container } = renderDock(createLayoutModel(makeTree()), makeRegistry())
		const gLeft = container.querySelector('[data-deck-group="g-left"]') as HTMLElement

		fireEvent.dragOver(gLeft, { dataTransfer: foreignPayload(['Files'], '') })

		expect(container.querySelector('[data-deck-drop-zone]')).toBeNull()
	})

	it('a drop carrying only text/plain (even a registered panel id) does not mutate the layout', () => {
		const model = createLayoutModel(makeTree())
		const { container } = renderDock(model, makeRegistry())

		let revisions = 0
		model.subscribe(() => { revisions += 1 })
		const before = JSON.stringify(model.get())

		const gLeft = container.querySelector('[data-deck-group="g-left"]') as HTMLElement
		// text/plain value is exactly 'editor', a registered panel present in the tree.
		fireEvent.drop(gLeft, { clientX: 0, dataTransfer: foreignPayload(['text/plain'], 'editor') })

		expect(revisions).toBe(0)
		expect(JSON.stringify(model.get())).toBe(before)
		// 'editor' never left g-right.
		expect(groupOf(model.get().root, 'editor').id).toBe('g-right')
	})

	it('a genuine deck drag (custom MIME present) still commits the re-dock', () => {
		const model = createLayoutModel(makeTree())
		const { container } = renderDock(model, makeRegistry())

		let revisions = 0
		model.subscribe(() => { revisions += 1 })

		const gRight = container.querySelector('[data-deck-group="g-right"]') as HTMLElement
		// jsdom geometry is 0×0 => 'center' zone => 'sim' joins g-right.
		fireEvent.drop(gRight, { clientX: 0, dataTransfer: deckPayload('sim') })

		expect(revisions).toBeGreaterThan(0)
		expect(groupOf(model.get().root, 'sim').id).toBe('g-right')
	})
})
