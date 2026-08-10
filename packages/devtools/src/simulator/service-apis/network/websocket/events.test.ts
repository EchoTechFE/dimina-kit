/**
 * The native event bridge and the task-level listeners it feeds: one
 * persistent subscription for the whole module, a fixed field set per event,
 * per-connection routing, and asynchronous error delivery.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Settler } from './__test-stubs__/harness'
import {
	CLOSED,
	DEFAULT_URL,
	NATIVE_EVENT_ID,
	PROFILE_FIELDS,
	bridgeCalls,
	connect,
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

describe('native event subscription', () => {
	it('installs exactly one persistent subscription no matter how many connections are made', async () => {
		const mod = await loadSocketModule()

		connect(mod, { url: `${DEFAULT_URL}/a` })
		connect(mod, { url: `${DEFAULT_URL}/b` })
		connect(mod, { url: `${DEFAULT_URL}/c` })

		const listens = bridgeCalls('socketListen')
		expect(listens).toHaveLength(1)
		expect(listens[0].evtId).toBe(NATIVE_EVENT_ID)
		expect(listens[0].keep).toBe(true)
		expect(typeof listens[0].success).toBe('function')
	})

	it('installs the subscription before the first connection is dialled', async () => {
		const mod = await loadSocketModule()

		connect(mod)

		const names = invokeAPIMock.mock.calls.map((call) => call[0])
		expect(names.indexOf('socketListen')).toBeGreaterThanOrEqual(0)
		expect(names.indexOf('socketListen')).toBeLessThan(names.indexOf('connectSocket'))
	})

	it('subscribes even when the caller registers no listener at all', async () => {
		const mod = await loadSocketModule()
		const { task, socketId } = connect(mod)

		emitNative(nativeOpenEvent(socketId))

		expect(task.readyState).toBe(1)
	})
})

describe('SocketTask event payloads', () => {
	it('gives onOpen exactly the header and the profile', async () => {
		const mod = await loadSocketModule()
		const { task, socketId } = connect(mod)
		const listener = vi.fn<Settler>()
		task.onOpen(listener)

		emitNative({ ...nativeOpenEvent(socketId, { 'x-upgrade': 'websocket' }), state: 'open' })

		const result = firstResult(listener)
		expect(Object.keys(result).sort()).toEqual(['header', 'profile'])
		expect(result.header).toEqual({ 'x-upgrade': 'websocket' })
	})

	it('gives onOpen a profile carrying all eight timing fields as numbers', async () => {
		const mod = await loadSocketModule()
		const { task, socketId } = connect(mod)
		const listener = vi.fn<Settler>()
		task.onOpen(listener)

		emitNative(nativeOpenEvent(socketId))

		const profile = firstResult(listener).profile
		expect(isRecord(profile)).toBe(true)
		if (!isRecord(profile)) return
		expect(Object.keys(profile).sort()).toEqual([...PROFILE_FIELDS].sort())
		for (const field of PROFILE_FIELDS) {
			expect(typeof profile[field]).toBe('number')
		}
	})

	it('gives onMessage exactly the data', async () => {
		const mod = await loadSocketModule()
		const { task, socketId } = connectAndOpen(mod)
		const listener = vi.fn<Settler>()
		task.onMessage(listener)

		emitNative({ ...nativeMessageEvent(socketId, 'hello'), isBuffer: false })

		const result = firstResult(listener)
		expect(Object.keys(result)).toEqual(['data'])
		expect(result.data).toBe('hello')
	})

	it('gives onError exactly the errMsg', async () => {
		const mod = await loadSocketModule()
		const { task, socketId } = connectAndOpen(mod)
		const listener = vi.fn<Settler>()
		task.onError(listener)

		emitNative({ ...nativeErrorEvent(socketId, 'connectSocket:fail timeout'), errCode: 5 })
		await flushAsyncDispatch()

		const result = firstResult(listener)
		expect(Object.keys(result)).toEqual(['errMsg'])
		expect(result.errMsg).toBe('connectSocket:fail timeout')
	})

	it('gives onClose exactly the code and the reason', async () => {
		const mod = await loadSocketModule()
		const { task, socketId } = connectAndOpen(mod)
		const listener = vi.fn<Settler>()
		task.onClose(listener)

		emitNative({ ...nativeCloseEvent(socketId, 1001, 'going away'), wasClean: true })

		const result = firstResult(listener)
		expect(Object.keys(result).sort()).toEqual(['code', 'reason'])
		expect(result.code).toBe(1001)
		expect(result.reason).toBe('going away')
	})
})

describe('SocketTask event routing', () => {
	it('notifies only the connection the event belongs to', async () => {
		const mod = await loadSocketModule()
		const first = connectAndOpen(mod, { url: `${DEFAULT_URL}/a` })
		const second = connectAndOpen(mod, { url: `${DEFAULT_URL}/b` })
		const firstListener = vi.fn<Settler>()
		const secondListener = vi.fn<Settler>()
		first.task.onMessage(firstListener)
		second.task.onMessage(secondListener)

		emitNative(nativeMessageEvent(second.socketId, 'for-second'))

		expect(secondListener).toHaveBeenCalledTimes(1)
		expect(firstListener).not.toHaveBeenCalled()
	})
})

describe('SocketTask listener registration', () => {
	it('invokes every distinct listener registered for the same event', async () => {
		const mod = await loadSocketModule()
		const { task, socketId } = connectAndOpen(mod)
		const first = vi.fn<Settler>()
		const second = vi.fn<Settler>()
		task.onMessage(first)
		task.onMessage(second)

		emitNative(nativeMessageEvent(socketId, 'hello'))

		expect(first).toHaveBeenCalledTimes(1)
		expect(second).toHaveBeenCalledTimes(1)
	})

	it('invokes the same function once even when it is registered twice', async () => {
		const mod = await loadSocketModule()
		const { task, socketId } = connectAndOpen(mod)
		const listener = vi.fn<Settler>()
		task.onMessage(listener)
		task.onMessage(listener)

		emitNative(nativeMessageEvent(socketId, 'hello'))

		expect(listener).toHaveBeenCalledTimes(1)
	})
})

describe('error dispatch timing', () => {
	it('does not deliver an error to its listeners within the emitting call', async () => {
		const mod = await loadSocketModule()
		const { task, socketId } = connectAndOpen(mod)
		const listener = vi.fn<Settler>()
		task.onError(listener)

		emitNative(nativeErrorEvent(socketId))
		expect(listener).not.toHaveBeenCalled()

		await flushAsyncDispatch()
		expect(listener).toHaveBeenCalledTimes(1)
	})

	it('still reaches a listener registered right after the error arrived', async () => {
		const mod = await loadSocketModule()
		const { task, socketId } = connect(mod)
		const listener = vi.fn<Settler>()

		emitNative(nativeErrorEvent(socketId, 'connectSocket:fail timeout'))
		task.onError(listener)
		await flushAsyncDispatch()

		expect(listener).toHaveBeenCalledWith({ errMsg: 'connectSocket:fail timeout' })
	})
})

describe('error followed by close', () => {
	it('keeps delivering close on a connection that had already opened', async () => {
		const mod = await loadSocketModule()
		const { task, socketId } = connectAndOpen(mod)
		const onClose = vi.fn<Settler>()
		task.onClose(onClose)

		emitNative(nativeErrorEvent(socketId))
		await flushAsyncDispatch()
		emitNative(nativeCloseEvent(socketId, 1006, ''))

		expect(onClose).toHaveBeenCalledWith({ code: 1006, reason: '' })
		expect(task.readyState).toBe(CLOSED)
	})

	it('stops delivering events once a connection that never opened errors out', async () => {
		const mod = await loadSocketModule()
		const { task, socketId } = connect(mod)
		const onClose = vi.fn<Settler>()
		task.onClose(onClose)

		emitNative(nativeErrorEvent(socketId))
		await flushAsyncDispatch()
		emitNative(nativeCloseEvent(socketId, 1006, ''))

		expect(onClose).not.toHaveBeenCalled()
		expect(task.readyState).toBe(CLOSED)
	})
})
