/**
 * `SocketTask.send` and `SocketTask.close`: the only precondition for sending
 * is that the connection is OPEN, payloads travel untouched, the close code
 * falls back to 1000 whenever it is not a finite number, and the reason is
 * passed through exactly as given.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Settler } from './__test-stubs__/harness'
import {
	OPEN,
	answerBridge,
	bridgeCalls,
	connect,
	connectAndOpen,
	emitNative,
	invokeAPIMock,
	lastBridgeCall,
	loadSocketModule,
	nativeCloseEvent,
} from './__test-stubs__/harness'

vi.mock('../../../common', () => ({ invokeAPI: invokeAPIMock }))

const NOT_OPEN_ERRMSG = 'SocketTask.send:fail SocketTask.readyState is not OPEN'

describe('SocketTask.send preconditions', () => {
	it('refuses to send while the connection is still connecting', async () => {
		const mod = await loadSocketModule()
		const { task } = connect(mod)
		const fail = vi.fn<Settler>()

		task.send({ data: 'hello', fail })

		expect(fail).toHaveBeenCalledWith({ errMsg: NOT_OPEN_ERRMSG })
		expect(bridgeCalls('sendSocketMessage')).toHaveLength(0)
	})

	it('refuses to send once the connection has closed', async () => {
		const mod = await loadSocketModule()
		const { task, socketId } = connectAndOpen(mod)
		emitNative(nativeCloseEvent(socketId, 1000, 'bye'))
		const fail = vi.fn<Settler>()

		task.send({ data: 'hello', fail })

		expect(fail).toHaveBeenCalledWith({ errMsg: NOT_OPEN_ERRMSG })
		expect(bridgeCalls('sendSocketMessage')).toHaveLength(0)
	})
})

describe('SocketTask.send payloads', () => {
	it('forwards the payload to the container under the connection id', async () => {
		const mod = await loadSocketModule()
		const { task, socketId } = connectAndOpen(mod)

		task.send({ data: 'hello' })

		const params = lastBridgeCall('sendSocketMessage')
		expect(params.socketId).toBe(socketId)
		expect(params.data).toBe('hello')
	})

	it('leaves a typed array as it was instead of converting it to an ArrayBuffer', async () => {
		const mod = await loadSocketModule()
		const { task } = connectAndOpen(mod)
		const payload = new Uint8Array([1, 2, 3])

		task.send({ data: payload })

		expect(lastBridgeCall('sendSocketMessage').data).toBe(payload)
	})

	it('leaves a payload the contract does not cover untouched for the container to reject', async () => {
		const mod = await loadSocketModule()
		const { task } = connectAndOpen(mod)

		task.send({ data: 42 })

		expect(lastBridgeCall('sendSocketMessage').data).toBe(42)
	})

	it('accepts a call with no options at all', async () => {
		const mod = await loadSocketModule()
		const { task } = connectAndOpen(mod)

		expect(() => task.send()).not.toThrow()
	})
})

describe('SocketTask.close code', () => {
	it('forwards a finite numeric code unchanged', async () => {
		const mod = await loadSocketModule()
		const { task } = connectAndOpen(mod)

		task.close({ code: 3001 })

		expect(lastBridgeCall('closeSocket').code).toBe(3001)
	})

	it('applies no range rule of its own to the code', async () => {
		const mod = await loadSocketModule()
		const { task } = connectAndOpen(mod)

		task.close({ code: 12 })

		expect(lastBridgeCall('closeSocket').code).toBe(12)
	})

	it('falls back to 1000 for a numeric string', async () => {
		const mod = await loadSocketModule()
		const { task } = connectAndOpen(mod)

		task.close({ code: '1000' })

		expect(lastBridgeCall('closeSocket').code).toBe(1000)
	})

	it('falls back to 1000 for null', async () => {
		const mod = await loadSocketModule()
		const { task } = connectAndOpen(mod)

		task.close({ code: null })

		expect(lastBridgeCall('closeSocket').code).toBe(1000)
	})

	it('falls back to 1000 for NaN so both sides of the bridge agree', async () => {
		const mod = await loadSocketModule()
		const { task } = connectAndOpen(mod)

		task.close({ code: Number.NaN })

		expect(lastBridgeCall('closeSocket').code).toBe(1000)
	})

	it('falls back to 1000 for Infinity', async () => {
		const mod = await loadSocketModule()
		const { task } = connectAndOpen(mod)

		task.close({ code: Number.POSITIVE_INFINITY })

		expect(lastBridgeCall('closeSocket').code).toBe(1000)
	})

	it('uses 1000 when the caller supplies no code', async () => {
		const mod = await loadSocketModule()
		const { task } = connectAndOpen(mod)

		task.close({ reason: 'bye' })

		expect(lastBridgeCall('closeSocket').code).toBe(1000)
	})
})

describe('SocketTask.close reason', () => {
	it('forwards the reason exactly, including one longer than 123 bytes', async () => {
		const mod = await loadSocketModule()
		const { task } = connectAndOpen(mod)
		const reason = 'r'.repeat(200)

		task.close({ code: 1000, reason })

		expect(lastBridgeCall('closeSocket').reason).toBe(reason)
	})

	it('sends no reason at all when the caller supplies none', async () => {
		const mod = await loadSocketModule()
		const { task } = connectAndOpen(mod)

		task.close({ code: 1000 })

		expect('reason' in lastBridgeCall('closeSocket')).toBe(false)
	})

	it('accepts a call with no options at all', async () => {
		const mod = await loadSocketModule()
		const { task } = connectAndOpen(mod)

		expect(() => task.close()).not.toThrow()
		expect(lastBridgeCall('closeSocket').code).toBe(1000)
	})
})

describe('SocketTask.close when the container refuses', () => {
	it('puts readyState back where it was so the live connection stays reachable', async () => {
		const mod = await loadSocketModule()
		const { task } = connectAndOpen(mod)
		answerBridge('closeSocket', 'fail', { errMsg: 'closeSocket:fail invalid code' })

		task.close({ code: 12, fail: () => {} })

		expect(task.readyState).toBe(OPEN)
	})
})

describe('SocketTask method return values', () => {
	it('returns undefined from every method', async () => {
		const mod = await loadSocketModule()
		const { task } = connectAndOpen(mod)

		expect(task.send({ data: 'hello' })).toBeUndefined()
		expect(task.onOpen(() => {})).toBeUndefined()
		expect(task.onMessage(() => {})).toBeUndefined()
		expect(task.onError(() => {})).toBeUndefined()
		expect(task.onClose(() => {})).toBeUndefined()
		expect(task.close({ code: 1000 })).toBeUndefined()
	})
})
