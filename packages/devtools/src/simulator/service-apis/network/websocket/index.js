/**
 * Service-realm SocketTask facade.
 *
 * The service host owns the JavaScript object, the parameter contract and the
 * listener semantics; the actual WebSocket is constructed and driven by the
 * developer tool's simulator/container Native API layer.
 *
 * Every named export here is collected onto `wx`, so the export set is itself
 * the API surface: `wx` has a socket entry point exactly when this module
 * exports it.
 */

import { invokeAPI } from '../../../common'

const CONNECTING = 0
const OPEN = 1
const CLOSING = 2
const CLOSED = 3

const MAX_WEBSOCKET_CONNECT = 5
const NATIVE_EVENT_ID = 'websocket_native_events'
const WEBSOCKET_URL = /^(ws|wss):\/\/.*/i
/** Connection options forwarded only when the caller actually supplied them. */
const PASS_THROUGH_OPTIONS = ['protocols', 'tcpNoDelay', 'perMessageDeflate', 'forceCellularNetwork']
const SETTLER_KEYS = ['success', 'fail', 'complete']

let nextSocketId = 1
let boundTask = null
let openConnectionCount = 0
let nativeBridgeInstalled = false

/**
 * Connections the container has been asked to dial that have not reached a
 * terminal event yet, keyed by the bridge id. Iteration order is creation
 * order, which is the order `wx.closeSocket` sweeps them in.
 */
const startedTasks = new Map()

/**
 * Per-connection bookkeeping, kept off the instance: a SocketTask exposes only
 * its six methods, `readyState` and the four state constants.
 */
const taskInternals = new WeakMap()

/** `wx.onSocket*` hold one slot per event. */
const globalListeners = { open: null, message: null, error: null, close: null }

function isFunction(value) {
	return typeof value === 'function'
}

function objectTag(value) {
	return Object.prototype.toString.apply(value)
}

function typeName(value) {
	return objectTag(value).slice(8, -1)
}

function optionsOf(opts) {
	return opts && typeof opts === 'object' ? opts : {}
}

function invokeCallback(fn, result) {
	if (!isFunction(fn)) return
	try {
		fn(result)
	}
	catch (error) {
		queueMicrotask(() => { throw error })
	}
}

function settle(opts, kind, result) {
	const options = optionsOf(opts)
	invokeCallback(kind === 'success' ? options.success : options.fail, result)
	invokeCallback(options.complete, result)
}

function pickSettlers(opts) {
	const settlers = {}
	for (const key of SETTLER_KEYS) {
		if (isFunction(opts[key])) settlers[key] = opts[key]
	}
	return settlers
}

/**
 * `wx.sendSocketMessage` / `wx.closeSocket` return a Promise only when the
 * caller passed none of the success/fail/complete keys. The presence of the
 * key decides, not whether the value under it is callable.
 */
function withSettlers(opts, run) {
	const options = optionsOf(opts)
	if (SETTLER_KEYS.some(key => Object.prototype.hasOwnProperty.call(options, key))) {
		run(options)
		return undefined
	}
	return new Promise((resolve, reject) => {
		run({ ...options, success: resolve, fail: reject })
	})
}

/**
 * Header values reach the container as strings: strings stay, numbers become
 * their decimal text, everything else becomes its object tag. Names are not
 * folded, so entries differing only in case stay separate.
 */
function normalizeHeaderValues(header) {
	return Object.keys(header).reduce((result, name) => {
		const value = header[name]
		if (typeof value === 'string') result[name] = value
		else if (typeof value === 'number') result[name] = `${value}`
		else result[name] = objectTag(value)
		return result
	}, {})
}

/**
 * The script layer never invents a value the caller left out — an option the
 * caller omitted must stay distinguishable from one they set to a default.
 * `timeout` is the exception the base library makes: a non-finite value
 * becomes 0 and is always forwarded, leaving the fallback to the container.
 */
function connectParams(opts) {
	const params = { url: opts.url }
	if (typeof opts.header === 'object') {
		params.header = opts.header ? normalizeHeaderValues(opts.header) : {}
	}
	for (const key of PASS_THROUGH_OPTIONS) {
		if (opts[key] !== undefined) params[key] = opts[key]
	}
	params.timeout = typeof opts.timeout === 'number' && Number.isFinite(opts.timeout) ? opts.timeout : 0
	return params
}

class SocketTask {
	constructor() {
		this.CONNECTING = CONNECTING
		this.OPEN = OPEN
		this.CLOSING = CLOSING
		this.CLOSED = CLOSED
		let readyState = CONNECTING
		// readyState is a writable accessor: the base library assigns it, and so
		// may mini-app code.
		Object.defineProperty(this, 'readyState', {
			get: () => readyState,
			set: (value) => { readyState = value },
			enumerable: true,
			configurable: true,
		})
	}

	send(opts) {
		sendOnTask(this, opts)
	}

	close(opts) {
		closeOnTask(this, opts)
	}

	onOpen(listener) {
		addTaskListener(this, 'open', listener)
	}

	onMessage(listener) {
		addTaskListener(this, 'message', listener)
	}

	onError(listener) {
		addTaskListener(this, 'error', listener)
	}

	onClose(listener) {
		addTaskListener(this, 'close', listener)
	}
}

function addTaskListener(task, type, listener) {
	if (!isFunction(listener)) return
	const state = taskInternals.get(task)
	// A Set keeps several distinct listeners per event and collapses a repeated
	// registration of the same function into one.
	if (state) state.listeners[type].add(listener)
}

function dispatchTaskEvent(task, type, taskResult, globalResult) {
	const state = taskInternals.get(task)
	if (!state) return
	for (const listener of [...state.listeners[type]]) invokeCallback(listener, taskResult)
	// Global listeners only observe the bound connection; events of any other
	// live connection are dropped.
	if (task === boundTask) {
		invokeCallback(globalListeners[type], globalResult === undefined ? taskResult : globalResult)
	}
}

/** A connection occupies one of the five slots only while it is open. */
function releaseSlot(state) {
	if (!state.counted) return
	state.counted = false
	openConnectionCount -= 1
}

function terminateTask(task, state) {
	state.terminal = true
	startedTasks.delete(state.socketId)
}

function handleOpenEvent(task, state, event) {
	state.opened = true
	if (!state.counted) {
		state.counted = true
		openConnectionCount += 1
	}
	task.readyState = OPEN
	dispatchTaskEvent(task, 'open', { header: event.header, profile: event.profile }, { header: event.header })
}

function handleErrorEvent(task, state, event) {
	releaseSlot(state)
	task.readyState = CLOSED
	const result = { errMsg: event.errMsg }
	// Errors are delivered asynchronously so that listeners registered right
	// after connectSocket returned still see them.
	setTimeout(() => { dispatchTaskEvent(task, 'error', result) }, 0)
	// A connection that opened still gets its close event; one that never
	// opened has nothing further to deliver.
	if (!state.opened) terminateTask(task, state)
}

function handleCloseEvent(task, state, event) {
	releaseSlot(state)
	terminateTask(task, state)
	task.readyState = CLOSED
	dispatchTaskEvent(task, 'close', { code: event.code, reason: event.reason })
}

function handleNativeEvent(event) {
	if (!event || typeof event !== 'object') return
	const task = startedTasks.get(event.socketId)
	if (!task) return
	const state = taskInternals.get(task)
	if (!state || state.terminal) return
	if (event.event === 'open') handleOpenEvent(task, state, event)
	else if (event.event === 'message') dispatchTaskEvent(task, 'message', { data: event.data })
	else if (event.event === 'error') handleErrorEvent(task, state, event)
	else if (event.event === 'close') handleCloseEvent(task, state, event)
}

function ensureNativeBridge() {
	if (nativeBridgeInstalled) return
	invokeAPI('socketListen', { evtId: NATIVE_EVENT_ID, keep: true, success: handleNativeEvent })
	nativeBridgeInstalled = true
}

function sendOnTask(task, opts) {
	const options = optionsOf(opts)
	// Being OPEN is the only precondition; the payload itself is the
	// container's to accept or reject.
	if (task.readyState !== OPEN) {
		settle(options, 'fail', { errMsg: 'SocketTask.send:fail SocketTask.readyState is not OPEN' })
		return
	}
	const state = taskInternals.get(task)
	invokeAPI('sendSocketMessage', {
		...pickSettlers(options),
		socketId: state.socketId,
		data: options.data,
	})
}

function closeOnTask(task, opts) {
	const options = optionsOf(opts)
	const state = taskInternals.get(task)
	const params = {
		...pickSettlers(options),
		socketId: state.socketId,
		code: typeof options.code === 'number' && Number.isFinite(options.code) ? options.code : 1000,
	}
	// `reason` is passed through exactly as given: no default, no length rule,
	// no coercion.
	if (options.reason !== undefined) params.reason = options.reason
	invokeAPI('closeSocket', params)
}

/**
 * `wx.closeSocket` marks a connection closed the moment it asks the container
 * to close it. If the container refuses and no terminal event has arrived, the
 * connection is still live, so the optimistic state is put back.
 */
function closeFromGlobal(task, options) {
	const previousReadyState = task.readyState
	task.readyState = CLOSED
	closeOnTask(task, {
		...options,
		fail: (result) => {
			const state = taskInternals.get(task)
			if (state && !state.terminal) task.readyState = previousReadyState
			invokeCallback(options.fail, result)
		},
	})
}

function createTask() {
	const task = new SocketTask()
	taskInternals.set(task, {
		socketId: `socket_${Date.now()}_${nextSocketId++}`,
		opened: false,
		counted: false,
		terminal: false,
		listeners: { open: new Set(), message: new Set(), error: new Set(), close: new Set() },
	})
	return task
}

function rejectConnect(opts) {
	if (typeof opts.url !== 'string') {
		settle(opts, 'fail', {
			errMsg: `connectSocket:fail parameter error: parameter.url should be String instead of ${typeName(opts.url)};`,
			errno: 1001,
		})
		return true
	}
	if (!WEBSOCKET_URL.test(opts.url)) {
		// Protocol is the only url rule the script layer applies; everything
		// else about the address is the container's judgement.
		settle(opts, 'fail', { errMsg: `connectSocket:fail invalid url "${opts.url}"` })
		return true
	}
	return false
}

export function connectSocket(opts) {
	// Without an options object there is no fail channel to report through.
	if (!opts || typeof opts !== 'object') return undefined
	if (rejectConnect(opts)) return undefined

	const task = createTask()
	const state = taskInternals.get(task)
	// The global APIs stay on the earliest connection that had not closed by
	// the time this call ran; a connection closing later never moves them.
	const previousBound = boundTask
	if (!previousBound || previousBound.readyState === CLOSED) boundTask = task

	if (openConnectionCount >= MAX_WEBSOCKET_CONNECT) {
		// The ceiling is reached after the task exists, so the caller still
		// receives one — already closed, and never dialled.
		state.terminal = true
		task.readyState = CLOSED
		settle(opts, 'fail', {
			errMsg: `connectSocket:fail fail reach max websocket connect count ${MAX_WEBSOCKET_CONNECT}`,
		})
		return task
	}

	startedTasks.set(state.socketId, task)
	try {
		ensureNativeBridge()
		invokeAPI('connectSocket', {
			...connectParams(opts),
			socketId: state.socketId,
			success: result => invokeCallback(opts.success, result),
			fail: (result) => {
				releaseSlot(state)
				terminateTask(task, state)
				task.readyState = CLOSED
				invokeCallback(opts.fail, result)
			},
			complete: result => invokeCallback(opts.complete, result),
		})
	}
	catch (error) {
		startedTasks.delete(state.socketId)
		if (boundTask === task) boundTask = previousBound
		state.terminal = true
		task.readyState = CLOSED
		settle(opts, 'fail', {
			errMsg: `connectSocket:fail ${error && error.message ? error.message : error}`,
		})
		return undefined
	}
	return task
}

export function sendSocketMessage(opts) {
	return withSettlers(opts, (options) => {
		if (!boundTask || boundTask.readyState !== OPEN) {
			settle(options, 'fail', { errMsg: 'sendSocketMessage:fail WebSocket is not connected' })
			return
		}
		sendOnTask(boundTask, options)
	})
}

export function closeSocket(opts) {
	return withSettlers(opts, (options) => {
		const current = boundTask
		if (current && current.readyState !== CLOSED) {
			closeFromGlobal(current, options)
		}
		else {
			settle(options, 'fail', { errMsg: 'closeSocket:fail WebSocket is not connected' })
		}
		// Whichever branch ran, every other connection this app started and
		// that has not reached a terminal event is closed too, bare.
		for (const task of [...startedTasks.values()]) {
			if (task === current) continue
			closeFromGlobal(task, {})
		}
	})
}

function setGlobalListener(type, listener) {
	// One slot per event: a later registration replaces the earlier one, and a
	// non-function argument registers nothing and leaves the slot alone.
	if (isFunction(listener)) globalListeners[type] = listener
}

export function onSocketOpen(listener) {
	setGlobalListener('open', listener)
}

export function onSocketMessage(listener) {
	setGlobalListener('message', listener)
}

export function onSocketError(listener) {
	setGlobalListener('error', listener)
}

export function onSocketClose(listener) {
	setGlobalListener('close', listener)
}
