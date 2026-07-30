import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeAPIMock = vi.hoisted(() => vi.fn())

vi.mock('../../../common', () => ({
	invokeAPI: invokeAPIMock,
}))

type NativeEvent = Record<string, unknown>

function flushMicrotask(): Promise<void> {
	return new Promise(resolve => queueMicrotask(resolve))
}

async function loadSocketApi() {
	vi.resetModules()
	let emitNative: (payload: NativeEvent) => void = () => {}
	invokeAPIMock.mockReset()
	invokeAPIMock.mockImplementation((name: string, params: Record<string, unknown>) => {
		if (name === 'socketListen') {
			emitNative = params.success as (payload: NativeEvent) => void
		} else if (name === 'connectSocket') {
			;(params.success as (payload: unknown) => void)?.({ errMsg: 'connectSocket:ok' })
		} else if (name === 'sendSocketMessage') {
			;(params.success as (payload: unknown) => void)?.({ errMsg: 'sendSocketMessage:ok' })
		} else if (name === 'closeSocket') {
			;(params.success as (payload: unknown) => void)?.({ errMsg: 'closeSocket:ok' })
		}
	})
	const api = await import('./index')
	return {
		api,
		emit(payload: NativeEvent) {
			emitNative(payload)
		},
	}
}

beforeEach(() => {
	vi.useRealTimers()
})

describe('service SocketTask facade → developer-tool Native API', () => {
	it('returns immediately, installs one persistent event bridge, and separates success from open', async () => {
		const { api, emit } = await loadSocketApi()
		const success = vi.fn()
		const complete = vi.fn()
		const onOpen = vi.fn()
		const task = api.connectSocket({
			url: 'wss://example.com/socket',
			success,
			complete,
		})
		task.onOpen(onOpen)

		expect(task.readyState).toBe(task.CONNECTING)
		await flushMicrotask()
		expect(invokeAPIMock.mock.calls.map(call => call[0])).toEqual([
			'socketListen',
			'connectSocket',
		])
		expect(success).toHaveBeenCalledWith({ errMsg: 'connectSocket:ok' })
		expect(complete).toHaveBeenCalledWith({ errMsg: 'connectSocket:ok' })
		expect(onOpen).not.toHaveBeenCalled()

		emit({
			socketId: task.socketId,
			event: 'open',
			header: { 'Sec-WebSocket-Protocol': 'chat' },
		})
		expect(task.readyState).toBe(task.OPEN)
		expect(onOpen).toHaveBeenCalledWith({
			header: { 'Sec-WebSocket-Protocol': 'chat' },
		})
	})

	it('routes task and global message listeners by native socket id', async () => {
		const { api, emit } = await loadSocketApi()
		const first = api.connectSocket({ url: 'wss://example.com/first' })
		const second = api.connectSocket({ url: 'wss://example.com/second' })
		await flushMicrotask()

		const firstMessage = vi.fn()
		const secondMessage = vi.fn()
		const globalMessage = vi.fn()
		first.onMessage(firstMessage)
		second.onMessage(secondMessage)
		api.onSocketMessage(globalMessage)
		emit({ socketId: first.socketId, event: 'message', data: 'one' })

		expect(firstMessage).toHaveBeenCalledWith({ data: 'one' })
		expect(secondMessage).not.toHaveBeenCalled()
		expect(globalMessage).toHaveBeenCalledWith({ data: 'one' })
		expect(invokeAPIMock.mock.calls.filter(call => call[0] === 'socketListen')).toHaveLength(1)
	})

	it('delegates send/close and applies local ready-state guards', async () => {
		const { api, emit } = await loadSocketApi()
		const task = api.connectSocket({ url: 'wss://example.com/socket' })
		await flushMicrotask()
		const earlyFail = vi.fn()
		task.send({ data: 'early', fail: earlyFail })
		expect(earlyFail).toHaveBeenCalledWith(expect.objectContaining({
			errMsg: expect.stringContaining('not connected'),
		}))

		emit({ socketId: task.socketId, event: 'open', header: {} })
		const sendSuccess = vi.fn()
		const closeSuccess = vi.fn()
		task.send({ data: 'hello', success: sendSuccess })
		task.close({ code: 4001, reason: 'done', success: closeSuccess })

		expect(invokeAPIMock).toHaveBeenCalledWith('sendSocketMessage', expect.objectContaining({
			socketId: task.socketId,
			data: 'hello',
		}))
		expect(invokeAPIMock).toHaveBeenCalledWith('closeSocket', expect.objectContaining({
			socketId: task.socketId,
			code: 4001,
			reason: 'done',
		}))
		expect(sendSuccess).toHaveBeenCalledWith({ errMsg: 'sendSocketMessage:ok' })
		expect(closeSuccess).toHaveBeenCalledWith({ errMsg: 'closeSocket:ok' })
		expect(task.readyState).toBe(task.CLOSING)
	})

	it('forwards native errors and terminal close metadata', async () => {
		const { api, emit } = await loadSocketApi()
		const task = api.connectSocket({ url: 'wss://example.com/socket' })
		const onError = vi.fn()
		const onClose = vi.fn()
		task.onError(onError)
		task.onClose(onClose)
		await flushMicrotask()

		emit({ socketId: task.socketId, event: 'error', errMsg: 'connectSocket:fail timeout' })
		expect(task.readyState).toBe(task.CLOSED)
		expect(onError).toHaveBeenCalledWith({ errMsg: 'connectSocket:fail timeout' })
		emit({ socketId: task.socketId, event: 'close', code: 4001, reason: 'bye' })
		expect(onClose).toHaveBeenCalledWith({ code: 4001, reason: 'bye' })
	})

	it('supports legacy global send/close against the latest task', async () => {
		const { api, emit } = await loadSocketApi()
		const task = api.connectSocket({ url: 'wss://example.com/socket' })
		await flushMicrotask()
		emit({ socketId: task.socketId, event: 'open', header: {} })

		api.sendSocketMessage({ data: 'legacy' })
		api.closeSocket({ code: 1000, reason: 'done' })

		expect(invokeAPIMock).toHaveBeenCalledWith('sendSocketMessage', expect.objectContaining({
			socketId: task.socketId,
			data: 'legacy',
		}))
		expect(invokeAPIMock).toHaveBeenCalledWith('closeSocket', expect.objectContaining({
			socketId: task.socketId,
		}))
	})
})
