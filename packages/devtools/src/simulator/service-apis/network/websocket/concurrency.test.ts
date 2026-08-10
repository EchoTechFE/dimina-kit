/**
 * The five-connection ceiling: which connections count against it, when a slot
 * is handed back, and what a caller gets when the ceiling is reached.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Settler } from './__test-stubs__/harness'
import {
	CLOSED,
	DEFAULT_URL,
	bridgeCalls,
	connect,
	emitNative,
	flushAsyncDispatch,
	invokeAPIMock,
	loadSocketModule,
	nativeCloseEvent,
	nativeErrorEvent,
	openSockets,
} from './__test-stubs__/harness'

vi.mock('../../../common', () => ({ invokeAPI: invokeAPIMock }))

const OVER_LIMIT_ERRMSG = 'connectSocket:fail fail reach max websocket connect count 5'

describe('connectSocket concurrency ceiling', () => {
	it('reports the sixth open connection with the documented text', async () => {
		const mod = await loadSocketModule()
		openSockets(mod, 5)
		const fail = vi.fn<Settler>()

		mod.connectSocket({ url: DEFAULT_URL, fail })

		expect(fail).toHaveBeenCalledWith({ errMsg: OVER_LIMIT_ERRMSG })
	})

	it('hands back a CLOSED task and never dials the container when over the ceiling', async () => {
		const mod = await loadSocketModule()
		openSockets(mod, 5)

		const task = mod.connectSocket({ url: DEFAULT_URL, fail: () => {} })

		expect(task).toBeDefined()
		expect(task?.readyState).toBe(CLOSED)
		expect(bridgeCalls('connectSocket')).toHaveLength(5)
	})

	it('leaves the over-limit task terminal, so sending on it fails', async () => {
		const mod = await loadSocketModule()
		openSockets(mod, 5)
		const task = mod.connectSocket({ url: DEFAULT_URL, fail: () => {} })
		const sendFail = vi.fn<Settler>()

		task?.send({ data: 'ping', fail: sendFail })

		expect(sendFail).toHaveBeenCalledWith({
			errMsg: 'SocketTask.send:fail SocketTask.readyState is not OPEN',
		})
		expect(bridgeCalls('sendSocketMessage')).toHaveLength(0)
	})

	it('counts only connections that reached OPEN, not ones still connecting', async () => {
		const mod = await loadSocketModule()
		for (let index = 0; index < 5; index += 1) {
			connect(mod, { url: `${DEFAULT_URL}/${index}` })
		}
		const fail = vi.fn<Settler>()

		mod.connectSocket({ url: DEFAULT_URL, fail })

		expect(fail).not.toHaveBeenCalled()
		expect(bridgeCalls('connectSocket')).toHaveLength(6)
	})

	it('hands the slot back when a close event arrives', async () => {
		const mod = await loadSocketModule()
		const sockets = openSockets(mod, 5)
		emitNative(nativeCloseEvent(sockets[0].socketId, 1000, 'bye'))
		const fail = vi.fn<Settler>()

		mod.connectSocket({ url: DEFAULT_URL, fail })

		expect(fail).not.toHaveBeenCalled()
		expect(bridgeCalls('connectSocket')).toHaveLength(6)
	})

	it('hands the slot back when an error event arrives', async () => {
		const mod = await loadSocketModule()
		const sockets = openSockets(mod, 5)
		emitNative(nativeErrorEvent(sockets[0].socketId))
		await flushAsyncDispatch()
		const fail = vi.fn<Settler>()

		mod.connectSocket({ url: DEFAULT_URL, fail })

		expect(fail).not.toHaveBeenCalled()
		expect(bridgeCalls('connectSocket')).toHaveLength(6)
	})

	it('keeps the slot until the close event arrives, not when close is merely requested', async () => {
		const mod = await loadSocketModule()
		const sockets = openSockets(mod, 5)
		sockets[0].task.close({ code: 1000 })
		const fail = vi.fn<Settler>()

		mod.connectSocket({ url: DEFAULT_URL, fail })

		expect(fail).toHaveBeenCalledWith({ errMsg: OVER_LIMIT_ERRMSG })
		expect(bridgeCalls('connectSocket')).toHaveLength(5)
	})
})
