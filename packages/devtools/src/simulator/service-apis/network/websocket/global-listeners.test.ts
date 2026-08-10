/**
 * The `wx.onSocket*` family: one slot per event, events of the bound
 * connection only, and a payload field set of its own — the global open
 * listener sees the header without the profile.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Settler } from './__test-stubs__/harness'
import {
	DEFAULT_URL,
	connectAndOpen,
	emitNative,
	flushAsyncDispatch,
	invokeAPIMock,
	isRecord,
	loadSocketModule,
	nativeCloseEvent,
	nativeErrorEvent,
	nativeMessageEvent,
	nativeOpenEvent,
} from './__test-stubs__/harness'

vi.mock('../../../common', () => ({ invokeAPI: invokeAPIMock }))

function firstResult(listener: ReturnType<typeof vi.fn<Settler>>): Record<string, unknown> {
	const result = listener.mock.calls[0]?.[0]
	if (!isRecord(result)) {
		throw new TypeError('the listener was never called with a result object')
	}
	return result
}

describe('global socket listeners hold a single slot', () => {
	it('keeps only the last onSocketOpen listener', async () => {
		const mod = await loadSocketModule()
		const first = vi.fn<Settler>()
		const second = vi.fn<Settler>()
		mod.onSocketOpen(first)
		mod.onSocketOpen(second)

		connectAndOpen(mod)

		expect(second).toHaveBeenCalledTimes(1)
		expect(first).not.toHaveBeenCalled()
	})

	it('keeps only the last onSocketMessage listener', async () => {
		const mod = await loadSocketModule()
		const first = vi.fn<Settler>()
		const second = vi.fn<Settler>()
		mod.onSocketMessage(first)
		mod.onSocketMessage(second)
		const { socketId } = connectAndOpen(mod)

		emitNative(nativeMessageEvent(socketId, 'hello'))

		expect(second).toHaveBeenCalledTimes(1)
		expect(first).not.toHaveBeenCalled()
	})

	it('keeps only the last onSocketClose listener', async () => {
		const mod = await loadSocketModule()
		const first = vi.fn<Settler>()
		const second = vi.fn<Settler>()
		mod.onSocketClose(first)
		mod.onSocketClose(second)
		const { socketId } = connectAndOpen(mod)

		emitNative(nativeCloseEvent(socketId, 1000, 'bye'))

		expect(second).toHaveBeenCalledTimes(1)
		expect(first).not.toHaveBeenCalled()
	})

	it('keeps only the last onSocketError listener', async () => {
		const mod = await loadSocketModule()
		const first = vi.fn<Settler>()
		const second = vi.fn<Settler>()
		mod.onSocketError(first)
		mod.onSocketError(second)
		const { socketId } = connectAndOpen(mod)

		emitNative(nativeErrorEvent(socketId))
		await flushAsyncDispatch()

		expect(second).toHaveBeenCalledTimes(1)
		expect(first).not.toHaveBeenCalled()
	})
})

describe('global socket listener payloads', () => {
	it('gives onSocketOpen the header without the profile', async () => {
		const mod = await loadSocketModule()
		const listener = vi.fn<Settler>()
		mod.onSocketOpen(listener)

		connectAndOpen(mod)

		const result = firstResult(listener)
		expect(Object.keys(result)).toEqual(['header'])
		expect(result.header).toEqual({ 'x-upgrade': 'websocket' })
	})

	it('gives onSocketMessage exactly the data', async () => {
		const mod = await loadSocketModule()
		const listener = vi.fn<Settler>()
		mod.onSocketMessage(listener)
		const { socketId } = connectAndOpen(mod)

		emitNative({ ...nativeMessageEvent(socketId, 'hello'), isBuffer: false })

		const result = firstResult(listener)
		expect(Object.keys(result)).toEqual(['data'])
		expect(result.data).toBe('hello')
	})

	it('gives onSocketError exactly the errMsg', async () => {
		const mod = await loadSocketModule()
		const listener = vi.fn<Settler>()
		mod.onSocketError(listener)
		const { socketId } = connectAndOpen(mod)

		emitNative({ ...nativeErrorEvent(socketId, 'connectSocket:fail timeout'), errCode: 5 })
		await flushAsyncDispatch()

		const result = firstResult(listener)
		expect(Object.keys(result)).toEqual(['errMsg'])
		expect(result.errMsg).toBe('connectSocket:fail timeout')
	})

	it('gives onSocketClose exactly the code and the reason', async () => {
		const mod = await loadSocketModule()
		const listener = vi.fn<Settler>()
		mod.onSocketClose(listener)
		const { socketId } = connectAndOpen(mod)

		emitNative({ ...nativeCloseEvent(socketId, 1001, 'going away'), wasClean: true })

		const result = firstResult(listener)
		expect(Object.keys(result).sort()).toEqual(['code', 'reason'])
		expect(result.code).toBe(1001)
	})
})

describe('global socket listeners follow the bound connection only', () => {
	it('drops events belonging to another live connection', async () => {
		const mod = await loadSocketModule()
		const listener = vi.fn<Settler>()
		mod.onSocketMessage(listener)
		const bound = connectAndOpen(mod, { url: `${DEFAULT_URL}/a` })
		const other = connectAndOpen(mod, { url: `${DEFAULT_URL}/b` })

		emitNative(nativeMessageEvent(other.socketId, 'for-other'))
		expect(listener).not.toHaveBeenCalled()

		emitNative(nativeMessageEvent(bound.socketId, 'for-bound'))
		expect(listener).toHaveBeenCalledTimes(1)
	})

	it('drops the open event of a second connection', async () => {
		const mod = await loadSocketModule()
		const listener = vi.fn<Settler>()
		mod.onSocketOpen(listener)
		connectAndOpen(mod, { url: `${DEFAULT_URL}/a` })
		const other = connectAndOpen(mod, { url: `${DEFAULT_URL}/b` })

		emitNative(nativeOpenEvent(other.socketId))

		expect(listener).toHaveBeenCalledTimes(1)
	})
})

describe('global socket listeners reject non-function arguments', () => {
	it('does not register a missing listener and does not throw', async () => {
		const mod = await loadSocketModule()

		expect(() => mod.onSocketOpen()).not.toThrow()
		expect(() => connectAndOpen(mod)).not.toThrow()
	})

	it('leaves the previously registered listener in place', async () => {
		const mod = await loadSocketModule()
		const listener = vi.fn<Settler>()
		mod.onSocketMessage(listener)
		mod.onSocketMessage(42)
		const { socketId } = connectAndOpen(mod)

		emitNative(nativeMessageEvent(socketId, 'hello'))

		expect(listener).toHaveBeenCalledTimes(1)
	})
})

describe('global socket listener return values', () => {
	it('returns undefined from all four registrations', async () => {
		const mod = await loadSocketModule()

		expect(mod.onSocketOpen(() => {})).toBeUndefined()
		expect(mod.onSocketMessage(() => {})).toBeUndefined()
		expect(mod.onSocketError(() => {})).toBeUndefined()
		expect(mod.onSocketClose(() => {})).toBeUndefined()
	})
})
