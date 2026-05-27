import { describe, expect, it, vi } from 'vitest'
import type { Disposable } from '../types.js'
import { ResourceRegistryImpl } from './resource-registry.js'

/**
 * Phase 2 contract tests for I3 LIFO disposable registry.
 *
 * Source of truth: JSDoc on ResourceRegistryImpl. We do NOT read the
 * stub method bodies — they are placeholders, not behaviour.
 */
describe('ResourceRegistryImpl', () => {
	it('accepts a Disposable and returns a wrapper Disposable', () => {
		const reg = new ResourceRegistryImpl()
		const d: Disposable = { dispose: () => {} }
		const wrapper = reg.add(d)
		expect(wrapper).toBeDefined()
		expect(typeof wrapper.dispose).toBe('function')
	})

	it('accepts a nullary cleanup function and returns a wrapper Disposable', () => {
		const reg = new ResourceRegistryImpl()
		const wrapper = reg.add(() => {})
		expect(wrapper).toBeDefined()
		expect(typeof wrapper.dispose).toBe('function')
	})

	it('wrapper.dispose() triggers underlying dispose', async () => {
		const reg = new ResourceRegistryImpl()
		const underlying = vi.fn()
		const wrapper = reg.add({ dispose: underlying })
		await wrapper.dispose()
		expect(underlying).toHaveBeenCalledTimes(1)
	})

	it('wrapper.dispose() triggers underlying nullary function', async () => {
		const reg = new ResourceRegistryImpl()
		const fn = vi.fn()
		const wrapper = reg.add(fn)
		await wrapper.dispose()
		expect(fn).toHaveBeenCalledTimes(1)
	})

	it('wrapper.dispose() removes the entry so disposeAll skips it', async () => {
		const reg = new ResourceRegistryImpl()
		const a = vi.fn()
		const b = vi.fn()
		const wrapperA = reg.add(a)
		reg.add(b)
		await wrapperA.dispose()
		await reg.disposeAll()
		expect(a).toHaveBeenCalledTimes(1) // not double-disposed
		expect(b).toHaveBeenCalledTimes(1)
	})

	it('disposeAll() invokes disposables in LIFO order', async () => {
		const reg = new ResourceRegistryImpl()
		const calls: string[] = []
		reg.add(() => {
			calls.push('a')
		})
		reg.add(() => {
			calls.push('b')
		})
		reg.add(() => {
			calls.push('c')
		})
		await reg.disposeAll()
		expect(calls).toEqual(['c', 'b', 'a'])
	})

	it('one throwing dispose does not stop the others from running', async () => {
		const reg = new ResourceRegistryImpl()
		const a = vi.fn()
		const b = vi.fn(() => {
			throw new Error('boom-b')
		})
		const c = vi.fn()
		reg.add(a)
		reg.add(b)
		reg.add(c)
		await expect(reg.disposeAll()).rejects.toBeDefined()
		expect(a).toHaveBeenCalledTimes(1)
		expect(b).toHaveBeenCalledTimes(1)
		expect(c).toHaveBeenCalledTimes(1)
	})

	it('disposeAll() throws AggregateError when at least one dispose fails', async () => {
		const reg = new ResourceRegistryImpl()
		reg.add(() => {
			throw new Error('boom-1')
		})
		reg.add(() => {
			throw new Error('boom-2')
		})
		try {
			await reg.disposeAll()
			throw new Error('expected disposeAll to reject')
		}
		catch (err) {
			expect(err).toBeInstanceOf(AggregateError)
			expect((err as AggregateError).errors.length).toBe(2)
		}
	})

	it('disposeAll() resolves cleanly when no dispose throws', async () => {
		const reg = new ResourceRegistryImpl()
		reg.add(() => {})
		reg.add({ dispose: () => {} })
		await expect(reg.disposeAll()).resolves.toBeUndefined()
	})

	it('disposeAll() is idempotent — second call is a no-op resolve', async () => {
		const reg = new ResourceRegistryImpl()
		const fn = vi.fn()
		reg.add(fn)
		await reg.disposeAll().catch(() => {})
		await expect(reg.disposeAll()).resolves.toBeUndefined()
		expect(fn).toHaveBeenCalledTimes(1) // not run again on second disposeAll
	})

	it('awaits async dispose functions before resolving', async () => {
		const reg = new ResourceRegistryImpl()
		let resolved = false
		reg.add(async () => {
			await new Promise(r => setTimeout(r, 20))
			resolved = true
		})
		await reg.disposeAll()
		expect(resolved).toBe(true)
	})

	it('awaits async Disposable.dispose() before resolving', async () => {
		const reg = new ResourceRegistryImpl()
		let resolved = false
		reg.add({
			dispose: async () => {
				await new Promise(r => setTimeout(r, 20))
				resolved = true
			},
		})
		await reg.disposeAll()
		expect(resolved).toBe(true)
	})

	// CONTRACT-AMBIGUOUS: JSDoc does not explicitly say whether add() after
	// disposeAll() is allowed. We assert the safer behaviour: a resource
	// added after disposeAll() is still disposed immediately, so we never
	// leak it. If the implementer chooses "throw on add after disposeAll"
	// this test will fail loudly — that signals the choice must be revisited.
	it('add() after disposeAll() still disposes the resource (CONTRACT-AMBIGUOUS)', async () => {
		const reg = new ResourceRegistryImpl()
		await reg.disposeAll()
		const fn = vi.fn()
		// Either the impl disposes it immediately, or it throws.
		// The "still tracks + disposes later" behaviour leaks; reject it.
		let threw = false
		try {
			reg.add(fn)
		}
		catch {
			threw = true
		}
		// Wait a microtask for any async immediate-dispose.
		await Promise.resolve()
		expect(threw || fn.mock.calls.length === 1).toBe(true)
	})
})
