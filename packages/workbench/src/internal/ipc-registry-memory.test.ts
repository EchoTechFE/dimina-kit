import { describe, expect, it, vi } from 'vitest'
import type { JsonValue } from '../types.js'
import { InMemoryTypedIpcRegistry } from './ipc-registry-memory.js'

/**
 * Phase 2 contract tests for the in-memory TypedIpcRegistry fake.
 *
 * Source of truth: JSDoc on InMemoryTypedIpcRegistry. invoke() is the
 * @internal main-internal helper used by Phase 2 setup tests.
 */
describe('InMemoryTypedIpcRegistry — handle / invoke', () => {
	it('handle() registers a channel and invoke() returns the handler result (sync)', async () => {
		const reg = new InMemoryTypedIpcRegistry()
		reg.handle('add', (a: JsonValue, b: JsonValue) => (a as number) + (b as number))
		await expect(reg.invoke('add', 2, 3)).resolves.toBe(5)
	})

	it('invoke() awaits async handlers and resolves to their value', async () => {
		const reg = new InMemoryTypedIpcRegistry()
		reg.handle('slow', async (x: JsonValue) => {
			await new Promise(r => setTimeout(r, 10))
			return (x as number) * 2
		})
		await expect(reg.invoke('slow', 21)).resolves.toBe(42)
	})

	it('invoke() rejects with the same error a throwing handler throws', async () => {
		const reg = new InMemoryTypedIpcRegistry()
		const err = new Error('handler-boom')
		reg.handle('boom', () => {
			throw err
		})
		await expect(reg.invoke('boom')).rejects.toBe(err)
	})

	it('invoke() rejects with the same error an async handler rejects with', async () => {
		const reg = new InMemoryTypedIpcRegistry()
		const err = new Error('async-boom')
		reg.handle('async-boom', async () => {
			throw err
		})
		await expect(reg.invoke('async-boom')).rejects.toBe(err)
	})

	it('handle() on an already-registered channel throws "channel already handled"', () => {
		const reg = new InMemoryTypedIpcRegistry()
		reg.handle('dup', () => null)
		expect(() => reg.handle('dup', () => null)).toThrow(/channel already handled/i)
	})

	it('the Disposable returned by handle() frees the channel for re-registration', () => {
		const reg = new InMemoryTypedIpcRegistry()
		const d = reg.handle('chan', () => null)
		d.dispose()
		expect(() => reg.handle('chan', () => null)).not.toThrow()
	})

	it('disposing handle() makes invoke() reject "no handler"', async () => {
		const reg = new InMemoryTypedIpcRegistry()
		const d = reg.handle('chan', () => 'ok' as JsonValue)
		d.dispose()
		await expect(reg.invoke('chan')).rejects.toThrow(/no handler/i)
	})

	it('invoke() on an unregistered channel rejects with an Error mentioning the channel name', async () => {
		const reg = new InMemoryTypedIpcRegistry()
		await expect(reg.invoke('ghost-channel')).rejects.toThrow(/ghost-channel/)
		await expect(reg.invoke('ghost-channel')).rejects.toThrow(/no handler/i)
	})

	// CONTRACT-AMBIGUOUS: JSDoc requires accepting `options` (audience /
	// validator) but does not say what they do in Phase 2. We only assert
	// the option object does not block registration.
	it('handle() accepts audience/validator options without blocking registration (CONTRACT-AMBIGUOUS)', () => {
		const reg = new InMemoryTypedIpcRegistry()
		expect(() =>
			reg.handle<JsonValue[], JsonValue>('with-opts', () => null, {
				audience: ['toolbar'],
				validator: args => args as JsonValue[],
			}),
		).not.toThrow()
		expect(() =>
			reg.handle('with-opts-all', () => null, { audience: 'allTrusted' }),
		).not.toThrow()
	})
})

describe('InMemoryTypedIpcRegistry — on / send', () => {
	it('send() triggers all on() listeners for that channel', () => {
		const reg = new InMemoryTypedIpcRegistry()
		const a = vi.fn()
		const b = vi.fn()
		reg.on('chan', a)
		reg.on('chan', b)
		reg.send('mainWindow', 'chan', { x: 1 })
		expect(a).toHaveBeenCalledWith({ x: 1 })
		expect(b).toHaveBeenCalledWith({ x: 1 })
	})

	it('send() to a channel with no listeners is a no-op (fire-and-forget)', () => {
		const reg = new InMemoryTypedIpcRegistry()
		expect(() => reg.send('mainWindow', 'silent', { x: 1 })).not.toThrow()
	})

	it('on() returns a Disposable; dispose stops that listener from receiving', () => {
		const reg = new InMemoryTypedIpcRegistry()
		const listener = vi.fn()
		const d = reg.on('chan', listener)
		reg.send('mainWindow', 'chan', { x: 1 })
		expect(listener).toHaveBeenCalledTimes(1)
		d.dispose()
		reg.send('mainWindow', 'chan', { x: 2 })
		expect(listener).toHaveBeenCalledTimes(1)
	})

	it('one listener disposed does not affect the others', () => {
		const reg = new InMemoryTypedIpcRegistry()
		const a = vi.fn()
		const b = vi.fn()
		const dA = reg.on('chan', a)
		reg.on('chan', b)
		dA.dispose()
		reg.send('mainWindow', 'chan', { x: 1 })
		expect(a).not.toHaveBeenCalled()
		expect(b).toHaveBeenCalledTimes(1)
	})
})

describe('InMemoryTypedIpcRegistry — on/handle channel-space isolation', () => {
	// CONTRACT-AMBIGUOUS: JSDoc treats handle() (request/reply) and on()
	// (event fan-out) as separate concepts but doesn't explicitly say their
	// channel namespaces are disjoint. We assert isolation here because the
	// alternative — a `send()` calling into the `handle()` handler with no
	// reply path — has no sensible runtime semantics. Implementer can keep
	// them disjoint or flag this test as needing revision.
	it('handle() and on() use independent channel spaces (CONTRACT-AMBIGUOUS)', async () => {
		const reg = new InMemoryTypedIpcRegistry()
		const handler = vi.fn(() => 'handled' as JsonValue)
		const listener = vi.fn()
		reg.handle('shared', handler)
		reg.on('shared', listener)
		// send only fan-outs to on() listeners, not to handle() handlers
		reg.send('mainWindow', 'shared', { x: 1 })
		expect(listener).toHaveBeenCalledWith({ x: 1 })
		expect(handler).not.toHaveBeenCalled()
		// invoke only calls the handle() handler, not the on() listeners
		await reg.invoke('shared', 1)
		expect(handler).toHaveBeenCalledTimes(1)
		expect(listener).toHaveBeenCalledTimes(1) // unchanged
	})
})
