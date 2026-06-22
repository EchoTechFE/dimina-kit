import { describe, expect, it } from 'vitest'
import { closePanel, closePanelForUser, createPanelRegistry } from './index.js'
import type { LayoutTree } from './index.js'

function tree(): LayoutTree {
	return {
		version: 1,
		root: {
			kind: 'tabs',
			id: 'group',
			panels: ['fixed', 'regular'],
			active: 'fixed',
		},
	}
}

describe('closePanelForUser', () => {
	it('blocks user closure when the registry sets closable:false', () => {
		const registry = createPanelRegistry()
		registry.register({ kind: 'dom', id: 'fixed', title: 'Fixed', closable: false })
		registry.register({ kind: 'dom', id: 'regular', title: 'Regular' })
		const before = tree()

		expect(closePanelForUser(before, 'fixed', registry)).toBe(before)
	})

	it('preserves the default user-close behavior when closable is omitted', () => {
		const registry = createPanelRegistry()
		registry.register({ kind: 'dom', id: 'fixed', title: 'Fixed', closable: false })
		registry.register({ kind: 'dom', id: 'regular', title: 'Regular' })

		expect(closePanelForUser(tree(), 'regular', registry).root).toMatchObject({
			kind: 'tabs',
			panels: ['fixed'],
		})
	})

	it('does not restrict the generic closePanel mutation', () => {
		expect(closePanel(tree(), 'fixed').root).toMatchObject({
			kind: 'tabs',
			panels: ['regular'],
		})
	})
})
