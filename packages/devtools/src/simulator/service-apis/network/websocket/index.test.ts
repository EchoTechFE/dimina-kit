import { describe, expect, it, vi } from 'vitest'

const invokeAPIMock = vi.hoisted(() => vi.fn())

vi.mock('../../../common', () => ({
	invokeAPI: invokeAPIMock,
}))

type NativeEvent = Record<string, unknown>

interface SocketTaskHandle {
	socketId: string
	readyState: number
	CONNECTING: number
	OPEN: number
	CLOSING: number
	CLOSED: number
	send(opts?: Record<string, unknown>): void
	close(opts?: Record<string, unknown>): void
	onOpen(listener: (payload: unknown) => void): void
	onMessage(listener: (payload: unknown) => void): void
	onError(listener: (payload: unknown) => void): void
	onClose(listener: (payload: unknown) => void): void
}

interface SocketApiModule {
	connectSocket(opts?: Record<string, unknown>): SocketTaskHandle
	sendSocketMessage(opts?: Record<string, unknown>): void
	closeSocket(opts?: Record<string, unknown>): void
	onSocketOpen(listener: (payload: unknown) => void): void
	onSocketMessage(listener: (payload: unknown) => void): void
	offSocketMessage(listener?: (payload: unknown) => void): void
}

function flushMicrotask(): Promise<void> {
	return new Promise(resolve => queueMicrotask(resolve))
}

async function loadSocketApi(options: { connectFail?: boolean } = {}) {
	vi.resetModules()
	let emitNative: (payload: NativeEvent) => void = () => {}
	invokeAPIMock.mockReset()
	invokeAPIMock.mockImplementation((name: string, params: Record<string, unknown>) => {
		if (name === 'socketListen') {
			emitNative = params.success as (payload: NativeEvent) => void
		} else if (name === 'connectSocket') {
			if (options.connectFail) {
				;(params.fail as (payload: unknown) => void)?.({ errMsg: 'connectSocket:fail test' })
			} else {
				;(params.success as (payload: unknown) => void)?.({ errMsg: 'connectSocket:ok' })
			}
		} else if (name === 'sendSocketMessage') {
			;(params.success as (payload: unknown) => void)?.({ errMsg: 'sendSocketMessage:ok' })
		} else if (name === 'closeSocket') {
			;(params.success as (payload: unknown) => void)?.({ errMsg: 'closeSocket:ok' })
		}
	})
	const api: SocketApiModule = await import('./index')
	return {
		api,
		emit(payload: NativeEvent) {
			emitNative(payload)
		},
	}
}

async function connectOpenedTasks(
	api: SocketApiModule,
	emit: (payload: NativeEvent) => void,
	count: number,
): Promise<SocketTaskHandle[]> {
	const handles = Array.from({ length: count }, (_, index) => api.connectSocket({
		url: `wss://example.com/task-${index}`,
	}))
	await flushMicrotask()
	for (const handle of handles) {
		emit({ socketId: handle.socketId, event: 'open', header: {} })
	}
	return handles
}

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
		expect(earlyFail).toHaveBeenCalledWith({
			errMsg: 'SocketTask.send:fail SocketTask.readyState is not OPEN',
		})

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

		emit({ socketId: task.socketId, event: 'open', header: {} })
		emit({ socketId: task.socketId, event: 'error', errMsg: 'connectSocket:fail timeout' })
		expect(task.readyState).toBe(task.CLOSED)
		expect(onError).toHaveBeenCalledWith({ errMsg: 'connectSocket:fail timeout' })
		emit({ socketId: task.socketId, event: 'close', code: 4001, reason: 'bye' })
		expect(onClose).toHaveBeenCalledWith({ code: 4001, reason: 'bye' })
	})

	it('supports legacy global send/close against the bound task', async () => {
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

describe('SocketTask close before the connection opens', () => {
	it('closing in the same tick as connectSocket stays local and dispatches close', async () => {
		const { api } = await loadSocketApi()
		const [connectSuccess, closeSuccess] = [vi.fn(), vi.fn()]
		const [onClose, silent] = [vi.fn(), vi.fn()]
		const task = api.connectSocket({ url: 'wss://example.com/socket', success: connectSuccess })
		task.onOpen(silent)
		task.onError(silent)
		task.onClose(onClose)
		task.close({ code: 4001, reason: 'bye', success: closeSuccess })
		expect(task.readyState).toBe(task.CLOSED)
		expect(closeSuccess).toHaveBeenCalledWith({ errMsg: 'closeSocket:ok' })

		await flushMicrotask()

		expect(connectSuccess).toHaveBeenCalledWith({ errMsg: 'connectSocket:ok' })
		expect(invokeAPIMock).not.toHaveBeenCalledWith('connectSocket', expect.anything())
		expect(invokeAPIMock).not.toHaveBeenCalledWith('closeSocket', expect.anything())
		expect(silent).not.toHaveBeenCalled()
		expect(onClose).toHaveBeenCalledTimes(1)
		expect(onClose).toHaveBeenCalledWith({ code: 4001, reason: 'bye' })
	})

	it('closing while connecting delegates to native and settles on native close', async () => {
		const { api, emit } = await loadSocketApi()
		const [onError, onClose] = [vi.fn(), vi.fn()]
		const task = api.connectSocket({ url: 'wss://example.com/socket' })
		task.onError(onError)
		task.onClose(onClose)
		await flushMicrotask()
		task.close()
		expect(invokeAPIMock).toHaveBeenCalledWith('closeSocket', expect.objectContaining({
			socketId: task.socketId,
		}))

		emit({ socketId: task.socketId, event: 'close', code: 1000, reason: '' })
		expect(onClose).toHaveBeenCalledWith({ code: 1000, reason: '' })
		expect(task.readyState).toBe(task.CLOSED)
		expect(onError).not.toHaveBeenCalled()

		const sendFail = vi.fn()
		api.sendSocketMessage({ data: 'late', fail: sendFail })
		expect(sendFail).toHaveBeenCalledWith({
			errMsg: 'sendSocketMessage:fail WebSocket is not connected',
		})
	})
})

describe('legacy global send/close keeps a single bound task', () => {
	it('targets the first created task while all connections survive', async () => {
		const { api, emit } = await loadSocketApi()
		const [first] = await connectOpenedTasks(api, emit, 2)

		api.sendSocketMessage({ data: 'legacy' })
		api.closeSocket({ code: 1000, reason: 'done' })

		expect(invokeAPIMock).toHaveBeenCalledWith('sendSocketMessage', expect.objectContaining({
			socketId: first.socketId,
			data: 'legacy',
		}))
		expect(invokeAPIMock).toHaveBeenCalledWith('closeSocket', expect.objectContaining({
			socketId: first.socketId,
		}))
	})

	it('fails global send after the bound connection closes until a reconnect rebinds', async () => {
		const { api, emit } = await loadSocketApi()
		const [first] = await connectOpenedTasks(api, emit, 3)
		emit({ socketId: first.socketId, event: 'close', code: 1000, reason: '' })

		const sendFail = vi.fn()
		api.sendSocketMessage({ data: 'after-close', fail: sendFail })

		expect(sendFail).toHaveBeenCalledWith({
			errMsg: 'sendSocketMessage:fail WebSocket is not connected',
		})
		expect(invokeAPIMock).not.toHaveBeenCalledWith('sendSocketMessage', expect.anything())

		const reopened = api.connectSocket({ url: 'wss://example.com/reopened' })
		await flushMicrotask()
		emit({ socketId: reopened.socketId, event: 'open', header: {} })
		api.sendSocketMessage({ data: 'rebound' })

		expect(invokeAPIMock).toHaveBeenCalledWith('sendSocketMessage', expect.objectContaining({
			socketId: reopened.socketId,
			data: 'rebound',
		}))
	})
})

describe('legacy global closeSocket closes every live connection', () => {
	it('passes the caller opts only to the bound task and closes the rest bare', async () => {
		const { api, emit } = await loadSocketApi()
		const [first, second] = await connectOpenedTasks(api, emit, 2)

		api.closeSocket({ code: 1000, reason: 'all' })

		const closeParams = invokeAPIMock.mock.calls
			.filter(call => call[0] === 'closeSocket')
			.map(call => call[1] as Record<string, unknown>)
		expect(closeParams).toHaveLength(2)
		expect(closeParams.find(params => params.socketId === first.socketId))
			.toMatchObject({ code: 1000, reason: 'all' })
		const otherClose = closeParams.find(params => params.socketId === second.socketId)
		expect(otherClose).toBeDefined()
		expect(otherClose).not.toHaveProperty('code')
		expect(otherClose).not.toHaveProperty('reason')
	})

	it('fails when there is no bound task or the bound task is closed', async () => {
		const { api, emit } = await loadSocketApi()
		const notConnected = { errMsg: 'closeSocket:fail WebSocket is not connected' }
		const earlyFail = vi.fn()
		api.closeSocket({ fail: earlyFail })
		expect(earlyFail).toHaveBeenCalledWith(notConnected)

		const [task] = await connectOpenedTasks(api, emit, 1)
		emit({ socketId: task.socketId, event: 'close', code: 1000, reason: '' })
		const lateFail = vi.fn()
		api.closeSocket({ fail: lateFail })
		expect(lateFail).toHaveBeenCalledWith(notConnected)
		expect(invokeAPIMock).not.toHaveBeenCalledWith('closeSocket', expect.anything())
	})

	it('still sweeps other live connections when the bound task is already closed', async () => {
		const { api, emit } = await loadSocketApi()
		const [first, second] = await connectOpenedTasks(api, emit, 2)
		emit({ socketId: first.socketId, event: 'close', code: 1000, reason: '' })
		const [success, fail] = [vi.fn(), vi.fn()]
		api.closeSocket({ success, fail })
		expect(fail).toHaveBeenCalledWith({ errMsg: 'closeSocket:fail WebSocket is not connected' })

		const closeParams = invokeAPIMock.mock.calls
			.filter(call => call[0] === 'closeSocket')
			.map(call => call[1] as Record<string, unknown>)
		expect(closeParams.find(params => params.socketId === first.socketId)).toBeUndefined()
		const swept = closeParams.find(params => params.socketId === second.socketId)
		expect(swept).toBeDefined()
		expect(swept).not.toHaveProperty('code')
		expect(swept).not.toHaveProperty('reason')
	})
})

describe('global listeners only observe the bound connection', () => {
	it('delivers messages globally only from the bound connection', async () => {
		const { api, emit } = await loadSocketApi()
		const [first, second] = await connectOpenedTasks(api, emit, 2)
		const [secondMessage, globalMessage] = [vi.fn(), vi.fn()]
		second.onMessage(secondMessage)
		api.onSocketMessage(globalMessage)

		emit({ socketId: second.socketId, event: 'message', data: 'two' })
		expect(secondMessage).toHaveBeenCalledWith({ data: 'two' })
		expect(globalMessage).not.toHaveBeenCalled()

		emit({ socketId: first.socketId, event: 'message', data: 'one' })
		expect(globalMessage).toHaveBeenCalledTimes(1)

		emit({ socketId: first.socketId, event: 'close', code: 1000, reason: '' })
		emit({ socketId: second.socketId, event: 'message', data: 'two-again' })
		expect(globalMessage).toHaveBeenCalledTimes(1)

		const third = api.connectSocket({ url: 'wss://example.com/third' })
		await flushMicrotask()
		emit({ socketId: third.socketId, event: 'open', header: {} })
		emit({ socketId: third.socketId, event: 'message', data: 'three' })
		expect(globalMessage).toHaveBeenCalledWith({ data: 'three' })
		expect(globalMessage).toHaveBeenCalledTimes(2)
	})

	it('delivers open globally only from the bound connection', async () => {
		const { api, emit } = await loadSocketApi()
		const first = api.connectSocket({ url: 'wss://example.com/first' })
		const second = api.connectSocket({ url: 'wss://example.com/second' })
		await flushMicrotask()
		const globalOpen = vi.fn()
		api.onSocketOpen(globalOpen)

		emit({ socketId: first.socketId, event: 'open', header: {} })
		expect(globalOpen).toHaveBeenCalledTimes(1)
		emit({ socketId: second.socketId, event: 'open', header: {} })
		expect(globalOpen).toHaveBeenCalledTimes(1)

		emit({ socketId: first.socketId, event: 'close', code: 1000, reason: '' })
		emit({ socketId: second.socketId, event: 'open', header: {} })
		expect(globalOpen).toHaveBeenCalledTimes(1)

		const third = api.connectSocket({ url: 'wss://example.com/third' })
		await flushMicrotask()
		emit({ socketId: third.socketId, event: 'open', header: {} })
		expect(globalOpen).toHaveBeenCalledTimes(2)
	})
})

describe('global onSocket* registration keeps only the last listener', () => {
	it('replaces a previously registered global message listener', async () => {
		const { api, emit } = await loadSocketApi()
		const [task] = await connectOpenedTasks(api, emit, 1)
		const [staleListener, activeListener] = [vi.fn(), vi.fn()]
		api.onSocketMessage(staleListener)
		api.onSocketMessage(activeListener)

		emit({ socketId: task.socketId, event: 'message', data: 'hi' })

		expect(staleListener).not.toHaveBeenCalled()
		expect(activeListener).toHaveBeenCalledWith({ data: 'hi' })
	})

	it('clears the slot when offSocketMessage removes the active listener', async () => {
		const { api, emit } = await loadSocketApi()
		const [task] = await connectOpenedTasks(api, emit, 1)
		const [staleListener, activeListener] = [vi.fn(), vi.fn()]
		api.onSocketMessage(staleListener)
		api.onSocketMessage(activeListener)
		api.offSocketMessage(activeListener)

		emit({ socketId: task.socketId, event: 'message', data: 'hi' })

		expect(staleListener).not.toHaveBeenCalled()
		expect(activeListener).not.toHaveBeenCalled()
	})

	it('keeps the active listener when offSocketMessage removes a different function', async () => {
		const { api, emit } = await loadSocketApi()
		const [task] = await connectOpenedTasks(api, emit, 1)
		const [staleListener, activeListener] = [vi.fn(), vi.fn()]
		api.onSocketMessage(staleListener)
		api.onSocketMessage(activeListener)
		api.offSocketMessage(vi.fn())

		emit({ socketId: task.socketId, event: 'message', data: 'hi' })

		expect(staleListener).not.toHaveBeenCalled()
		expect(activeListener).toHaveBeenCalledWith({ data: 'hi' })
	})

	it('clears the slot when offSocketMessage is called without a listener', async () => {
		const { api, emit } = await loadSocketApi()
		const [task] = await connectOpenedTasks(api, emit, 1)
		const listener = vi.fn()
		api.onSocketMessage(listener)
		api.offSocketMessage()

		emit({ socketId: task.socketId, event: 'message', data: 'hi' })

		expect(listener).not.toHaveBeenCalled()
	})

	it('keeps SocketTask instance listeners multicast', async () => {
		const { api, emit } = await loadSocketApi()
		const [task] = await connectOpenedTasks(api, emit, 1)
		const [firstListener, secondListener] = [vi.fn(), vi.fn()]
		task.onMessage(firstListener)
		task.onMessage(secondListener)

		emit({ socketId: task.socketId, event: 'message', data: 'hi' })

		expect(firstListener).toHaveBeenCalledWith({ data: 'hi' })
		expect(secondListener).toHaveBeenCalledWith({ data: 'hi' })
	})
})

describe('connections that fail before open do not produce close', () => {
	it('settles fail and error without a later close event', async () => {
		const { api, emit } = await loadSocketApi({ connectFail: true })
		const [fail, onError, onClose] = [vi.fn(), vi.fn(), vi.fn()]
		const task = api.connectSocket({ url: 'wss://example.com/refused', fail })
		task.onError(onError)
		task.onClose(onClose)
		await flushMicrotask()

		expect(fail).toHaveBeenCalledWith({ errMsg: 'connectSocket:fail test' })
		expect(onError).toHaveBeenCalledWith({ errMsg: 'connectSocket:fail test' })

		emit({ socketId: task.socketId, event: 'close', code: 1000, reason: '' })
		expect(onClose).not.toHaveBeenCalled()
	})

	it('keeps the error then close sequence for connections lost after open', async () => {
		const { api, emit } = await loadSocketApi()
		const [task] = await connectOpenedTasks(api, emit, 1)
		const [onError, onClose] = [vi.fn(), vi.fn()]
		task.onError(onError)
		task.onClose(onClose)

		emit({ socketId: task.socketId, event: 'error', errMsg: 'connectSocket:fail broken pipe' })
		expect(onError).toHaveBeenCalledWith({ errMsg: 'connectSocket:fail broken pipe' })

		emit({ socketId: task.socketId, event: 'close', code: 1006, reason: 'abnormal' })
		expect(onClose).toHaveBeenCalledWith({ code: 1006, reason: 'abnormal' })
	})
})
