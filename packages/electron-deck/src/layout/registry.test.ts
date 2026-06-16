import { describe, expect, it } from 'vitest'
import type { DomPanelDescriptor, NativePanelDescriptor } from './types.js'
import { createPanelRegistry } from './index.js'

const dom = (id: string, title?: string): DomPanelDescriptor => ({ kind: 'dom', id, title })
const native = (id: string, refId: string): NativePanelDescriptor => ({
	kind: 'native',
	id,
	nativeRef: { id: refId },
})

describe('createPanelRegistry', () => {
	it('register then get returns the same descriptor', () => {
		const r = createPanelRegistry()
		const d = dom('a', 'Panel A')
		r.register(d)
		expect(r.get('a')).toEqual(d)
	})

	it('get returns undefined for unknown id', () => {
		const r = createPanelRegistry()
		expect(r.get('nope')).toBeUndefined()
	})

	it('list returns all registered descriptors', () => {
		const r = createPanelRegistry()
		r.register(dom('a'))
		r.register(native('b', 'ref-b'))
		const ids = r.list().map(p => p.id).sort()
		expect(ids).toEqual(['a', 'b'])
	})

	it('dispose() removes the descriptor (get -> undefined, drops from list)', () => {
		const r = createPanelRegistry()
		const handle = r.register(dom('a'))
		expect(r.get('a')).toBeDefined()
		handle.dispose()
		expect(r.get('a')).toBeUndefined()
		expect(r.list().map(p => p.id)).not.toContain('a')
	})

	it('preserves native opaque handle ref through register/get', () => {
		const r = createPanelRegistry()
		r.register(native('n', 'handle-123'))
		const got = r.get('n')
		expect(got?.kind).toBe('native')
		expect((got as NativePanelDescriptor).nativeRef).toEqual({ id: 'handle-123' })
	})
})
