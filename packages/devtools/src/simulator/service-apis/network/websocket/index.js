/**
 * Service-realm SocketTask facade.
 *
 * The service host owns the JavaScript object and callback/listener semantics;
 * the actual WebSocket is constructed and driven by the developer tool's
 * simulator/container Native API layer.
 */

import { invokeAPI } from '../../../common'

const CONNECTING = 0
const OPEN = 1
const CLOSING = 2
const CLOSED = 3

let nextSocketId = 1
let latestSocketTask = null
let nativeListenerInstalled = false
const tasks = new Map()

function isFunction(value) {
	return typeof value === 'function'
}

function invokeCallback(fn, payload) {
	if (!isFunction(fn)) return
	try {
		fn(payload)
	} catch (error) {
		queueMicrotask(() => { throw error })
	}
}

function callbackResult(opts, kind, payload) {
	invokeCallback(kind === 'success' ? opts.success : opts.fail, payload)
	invokeCallback(opts.complete, payload)
}

function createListenerStore() {
	let listeners = []
	return {
		add(listener) {
			if (!isFunction(listener) || listeners.includes(listener)) return
			listeners.push(listener)
		},
		remove(listener) {
			listeners = isFunction(listener)
				? listeners.filter(item => item !== listener)
				: []
		},
		dispatch(payload) {
			for (const listener of listeners.slice()) invokeCallback(listener, payload)
		},
	}
}

const globalListeners = {
	open: createListenerStore(),
	message: createListenerStore(),
	error: createListenerStore(),
	close: createListenerStore(),
}

function nativeEvent(payload) {
	if (!payload || typeof payload !== 'object') return
	const task = tasks.get(payload.socketId)
	if (!task) return
	task._dispatchNative(payload)
}

function ensureNativeListener() {
	if (nativeListenerInstalled) return
	nativeListenerInstalled = true
	invokeAPI('socketListen', {
		evtId: 'websocket_native_events',
		keep: true,
		success: nativeEvent,
	})
}

class SocketTask {
	constructor(socketId, opts) {
		this.socketId = socketId
		this.socketTaskId = socketId
		this.CONNECTING = CONNECTING
		this.OPEN = OPEN
		this.CLOSING = CLOSING
		this.CLOSED = CLOSED
		this._readyState = CONNECTING
		this._opts = opts
		this._connectSettled = false
		this._terminal = false
		this._listeners = {
			open: createListenerStore(),
			message: createListenerStore(),
			error: createListenerStore(),
			close: createListenerStore(),
		}
	}

	get readyState() {
		return this._readyState
	}

	_dispatch(type, payload) {
		this._listeners[type].dispatch(payload)
		globalListeners[type].dispatch(payload)
	}

	_settleConnect(kind, payload) {
		if (this._connectSettled) return
		this._connectSettled = true
		callbackResult(this._opts, kind, payload)
	}

	_cleanup() {
		tasks.delete(this.socketId)
		if (latestSocketTask === this) {
			latestSocketTask = Array.from(tasks.values()).at(-1) || null
		}
	}

	_failConnect(payload) {
		if (this._terminal) return
		this._terminal = true
		this._readyState = CLOSED
		this._settleConnect('fail', payload)
		this._dispatch('error', payload)
		this._cleanup()
	}

	_start() {
		try {
			ensureNativeListener()
			invokeAPI('connectSocket', {
				...this._opts,
				socketId: this.socketId,
				success: result => this._settleConnect('success', result),
				fail: result => this._failConnect(result),
				complete: undefined,
			})
		} catch (error) {
			this._failConnect({
				errMsg: `connectSocket:fail ${error && error.message ? error.message : error}`,
			})
		}
	}

	_dispatchNative(payload) {
		const { event } = payload
		if (event === 'open') {
			if (this._terminal) return
			this._readyState = OPEN
			this._dispatch('open', {
				header: payload.header || {},
				profile: payload.profile,
			})
			return
		}
		if (event === 'message') {
			if (this._terminal) return
			this._dispatch('message', { data: payload.data })
			return
		}
		if (event === 'error') {
			this._readyState = CLOSED
			this._dispatch('error', {
				errMsg: payload.errMsg || 'connectSocket:fail WebSocket connection failed',
			})
			return
		}
		if (event === 'close') {
			if (this._terminal) return
			this._terminal = true
			this._readyState = CLOSED
			this._dispatch('close', {
				code: Number(payload.code) || 0,
				reason: payload.reason || '',
			})
			this._cleanup()
		}
	}

	send(opts = {}) {
		const payload = opts && typeof opts === 'object' ? opts : {}
		if (this._readyState !== OPEN) {
			callbackResult(payload, 'fail', {
				errMsg: 'sendSocketMessage:fail WebSocket is not connected',
			})
			return
		}
		const data = payload.data
		if (
			typeof data !== 'string'
			&& !(data instanceof ArrayBuffer)
			&& !ArrayBuffer.isView(data)
		) {
			callbackResult(payload, 'fail', {
				errMsg: 'sendSocketMessage:fail data must be string or ArrayBuffer',
			})
			return
		}
		invokeAPI('sendSocketMessage', { ...payload, socketId: this.socketId })
	}

	close(opts = {}) {
		const payload = opts && typeof opts === 'object' ? opts : {}
		if (this._readyState === CLOSED) {
			callbackResult(payload, 'fail', {
				errMsg: 'closeSocket:fail WebSocket is not connected',
			})
			return
		}
		if (
			payload.reason !== undefined
			&& (
				typeof payload.reason !== 'string'
				|| new TextEncoder().encode(payload.reason).byteLength > 123
			)
		) {
			callbackResult(payload, 'fail', {
				errMsg: 'closeSocket:fail reason must not exceed 123 UTF-8 bytes',
			})
			return
		}
		const previousReadyState = this._readyState
		this._readyState = CLOSING
		invokeAPI('closeSocket', {
			...payload,
			socketId: this.socketId,
			fail: result => {
				if (!this._terminal) this._readyState = previousReadyState
				invokeCallback(payload.fail, result)
			},
		})
	}

	onOpen(listener) { this._listeners.open.add(listener) }
	offOpen(listener) { this._listeners.open.remove(listener) }
	onMessage(listener) { this._listeners.message.add(listener) }
	offMessage(listener) { this._listeners.message.remove(listener) }
	onError(listener) { this._listeners.error.add(listener) }
	offError(listener) { this._listeners.error.remove(listener) }
	onClose(listener) { this._listeners.close.add(listener) }
	offClose(listener) { this._listeners.close.remove(listener) }
}

SocketTask.CONNECTING = CONNECTING
SocketTask.OPEN = OPEN
SocketTask.CLOSING = CLOSING
SocketTask.CLOSED = CLOSED

export function connectSocket(opts = {}) {
	const socketId = `socket_${Date.now()}_${nextSocketId++}`
	const task = new SocketTask(socketId, opts && typeof opts === 'object' ? opts : {})
	tasks.set(socketId, task)
	latestSocketTask = task
	queueMicrotask(() => task._start())
	return task
}

export function sendSocketMessage(opts = {}) {
	if (!latestSocketTask) {
		callbackResult(opts, 'fail', {
			errMsg: 'sendSocketMessage:fail WebSocket is not connected',
		})
		return
	}
	return latestSocketTask.send(opts)
}

export function closeSocket(opts = {}) {
	if (!latestSocketTask) {
		callbackResult(opts, 'fail', {
			errMsg: 'closeSocket:fail WebSocket is not connected',
		})
		return
	}
	return latestSocketTask.close(opts)
}

export function onSocketOpen(listener) { globalListeners.open.add(listener) }
export function offSocketOpen(listener) { globalListeners.open.remove(listener) }
export function onSocketMessage(listener) { globalListeners.message.add(listener) }
export function offSocketMessage(listener) { globalListeners.message.remove(listener) }
export function onSocketError(listener) { globalListeners.error.add(listener) }
export function offSocketError(listener) { globalListeners.error.remove(listener) }
export function onSocketClose(listener) { globalListeners.close.add(listener) }
export function offSocketClose(listener) { globalListeners.close.remove(listener) }
