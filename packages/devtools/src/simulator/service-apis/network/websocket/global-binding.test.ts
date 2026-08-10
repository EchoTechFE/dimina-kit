/**
 * Which connection the `wx.sendSocketMessage` / `wx.closeSocket` / `wx.onSocket*`
 * family acts on: the earliest connection that was not already closed when the
 * next `connectSocket` ran, and `closeSocket` sweeping up every other one.
 */
import { describe, expect, it, vi } from 'vitest'
import type { BridgeParams, Settler } from './__test-stubs__/harness'
import {
	DEFAULT_URL,
	bridgeCalls,
	connect,
	connectAndOpen,
	emitNative,
	invokeAPIMock,
	lastBridgeCall,
	loadSocketModule,
	nativeCloseEvent,
	nativeMessageEvent,
} from './__test-stubs__/harness'

vi.mock('../../../common', () => ({ invokeAPI: invokeAPIMock }))

const NOT_CONNECTED_SEND = 'sendSocketMessage:fail WebSocket is not connected'
const NOT_CONNECTED_CLOSE = 'closeSocket:fail WebSocket is not connected'

function closeCallFor(socketId: string): BridgeParams {
	const call = bridgeCalls('closeSocket').find((params) => params.socketId === socketId)
	if (!call) {
		throw new Error(`the container was never asked to close ${socketId}`)
	}
	return call
}

describe('global API binding', () => {
	it('binds to the connection that was created first', async () => {
		const mod = await loadSocketModule()
		const first = connectAndOpen(mod, { url: `${DEFAULT_URL}/a` })
		connectAndOpen(mod, { url: `${DEFAULT_URL}/b` })

		mod.sendSocketMessage({ data: 'ping', success: () => {} })

		expect(lastBridgeCall('sendSocketMessage').socketId).toBe(first.socketId)
	})

	it('keeps the binding on an earlier connection that is still connecting', async () => {
		const mod = await loadSocketModule()
		const listener = vi.fn<Settler>()
		mod.onSocketMessage(listener)
		connect(mod, { url: `${DEFAULT_URL}/a` })
		const second = connectAndOpen(mod, { url: `${DEFAULT_URL}/b` })

		emitNative(nativeMessageEvent(second.socketId, 'for-second'))

		expect(listener).not.toHaveBeenCalled()
	})

	it('rebinds to a new connection when the earlier one had already closed', async () => {
		const mod = await loadSocketModule()
		const first = connectAndOpen(mod, { url: `${DEFAULT_URL}/a` })
		emitNative(nativeCloseEvent(first.socketId, 1000, 'bye'))
		const second = connectAndOpen(mod, { url: `${DEFAULT_URL}/b` })

		mod.sendSocketMessage({ data: 'ping', success: () => {} })

		expect(lastBridgeCall('sendSocketMessage').socketId).toBe(second.socketId)
	})

	it('does not drift to a newer connection when the bound one closes later', async () => {
		const mod = await loadSocketModule()
		const first = connectAndOpen(mod, { url: `${DEFAULT_URL}/a` })
		connectAndOpen(mod, { url: `${DEFAULT_URL}/b` })
		emitNative(nativeCloseEvent(first.socketId, 1000, 'bye'))
		const fail = vi.fn<Settler>()

		mod.sendSocketMessage({ data: 'ping', fail })

		expect(fail).toHaveBeenCalledWith({ errMsg: NOT_CONNECTED_SEND })
		expect(bridgeCalls('sendSocketMessage')).toHaveLength(0)
	})
})

describe('wx.sendSocketMessage', () => {
	it('fails when no connection was ever created', async () => {
		const mod = await loadSocketModule()
		const fail = vi.fn<Settler>()

		mod.sendSocketMessage({ data: 'ping', fail })

		expect(fail).toHaveBeenCalledWith({ errMsg: NOT_CONNECTED_SEND })
		expect(bridgeCalls('sendSocketMessage')).toHaveLength(0)
	})

	it('fails while the bound connection has not opened yet', async () => {
		const mod = await loadSocketModule()
		connect(mod)
		const fail = vi.fn<Settler>()

		mod.sendSocketMessage({ data: 'ping', fail })

		expect(fail).toHaveBeenCalledWith({ errMsg: NOT_CONNECTED_SEND })
		expect(bridgeCalls('sendSocketMessage')).toHaveLength(0)
	})

	it('forwards the payload untouched once the bound connection is OPEN', async () => {
		const mod = await loadSocketModule()
		const { socketId } = connectAndOpen(mod)
		const payload = { any: 'shape' }

		mod.sendSocketMessage({ data: payload, success: () => {} })

		const params = lastBridgeCall('sendSocketMessage')
		expect(params.socketId).toBe(socketId)
		expect(params.data).toBe(payload)
	})
})

describe('wx.closeSocket', () => {
	it('closes the bound connection with the code and reason the caller gave', async () => {
		const mod = await loadSocketModule()
		const bound = connectAndOpen(mod)

		mod.closeSocket({ code: 3001, reason: 'bye', success: () => {} })

		const params = closeCallFor(bound.socketId)
		expect(params.code).toBe(3001)
		expect(params.reason).toBe('bye')
	})

	it('closes every other connection with the default code and no reason', async () => {
		const mod = await loadSocketModule()
		const bound = connectAndOpen(mod, { url: `${DEFAULT_URL}/a` })
		const second = connectAndOpen(mod, { url: `${DEFAULT_URL}/b` })
		const connecting = connect(mod, { url: `${DEFAULT_URL}/c` })

		mod.closeSocket({ code: 3001, reason: 'bye', success: () => {} })

		expect(bridgeCalls('closeSocket')).toHaveLength(3)
		expect(closeCallFor(bound.socketId).code).toBe(3001)
		for (const socketId of [second.socketId, connecting.socketId]) {
			const params = closeCallFor(socketId)
			expect(params.code).toBe(1000)
			expect('reason' in params).toBe(false)
		}
	})

	it('reports a failure when the bound connection has already closed, and still sweeps the rest', async () => {
		const mod = await loadSocketModule()
		const bound = connectAndOpen(mod, { url: `${DEFAULT_URL}/a` })
		const second = connectAndOpen(mod, { url: `${DEFAULT_URL}/b` })
		emitNative(nativeCloseEvent(bound.socketId, 1000, 'bye'))
		const fail = vi.fn<Settler>()

		mod.closeSocket({ code: 3001, fail })

		expect(fail).toHaveBeenCalledWith({ errMsg: NOT_CONNECTED_CLOSE })
		expect(closeCallFor(second.socketId).code).toBe(1000)
	})

	it('fails without touching the container when no connection was ever created', async () => {
		const mod = await loadSocketModule()
		const fail = vi.fn<Settler>()

		mod.closeSocket({ fail })

		expect(fail).toHaveBeenCalledWith({ errMsg: NOT_CONNECTED_CLOSE })
		expect(bridgeCalls('closeSocket')).toHaveLength(0)
	})
})
