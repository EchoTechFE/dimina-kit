/**
 * Shared scaffolding for the simulator socket facade tests.
 *
 * The facade reaches the container through a single `invokeAPI(name, params)`
 * bridge and receives every native socket event through one persistent
 * `socketListen` subscription. Every helper here is expressed in terms of that
 * bridge alone, so the specs assert observable contract behaviour instead of
 * internal structure.
 *
 * The module keeps module-level state (bound connection, live-connection
 * count, single-slot global listeners, whether the event bridge is installed),
 * so each spec must obtain a fresh instance through `loadSocketModule()`.
 */
import { vi } from 'vitest'

export type BridgeParams = Record<string, unknown>
export type Settler = (result: BridgeParams) => void
export type NativeEvent = Record<string, unknown>
export type NativeEventHandler = (event: NativeEvent) => void
export type SocketEventListener = (result: BridgeParams) => void

/** Event id the persistent native subscription is registered under. */
export const NATIVE_EVENT_ID = 'websocket_native_events'

/** Every profile field `SocketTask.onOpen` must carry. */
export const PROFILE_FIELDS = [
	'fetchStart',
	'domainLookUpStart',
	'domainLookUpEnd',
	'connectStart',
	'connectEnd',
	'rtt',
	'handshakeCost',
	'cost',
]

export const DEFAULT_URL = 'ws://localhost:8080/socket'

/** readyState values the facade exposes on every SocketTask instance. */
export const CONNECTING = 0
export const OPEN = 1
export const CLOSING = 2
export const CLOSED = 3

export interface SocketTaskLike {
	readyState: number
	CONNECTING: number
	OPEN: number
	CLOSING: number
	CLOSED: number
	send(options?: BridgeParams): unknown
	close(options?: BridgeParams): unknown
	onOpen(listener: SocketEventListener): unknown
	onMessage(listener: SocketEventListener): unknown
	onError(listener: SocketEventListener): unknown
	onClose(listener: SocketEventListener): unknown
}

export interface SocketModule {
	connectSocket(options?: unknown): SocketTaskLike | undefined
	sendSocketMessage(options?: unknown): unknown
	closeSocket(options?: unknown): unknown
	onSocketOpen(listener?: unknown): unknown
	onSocketMessage(listener?: unknown): unknown
	onSocketError(listener?: unknown): unknown
	onSocketClose(listener?: unknown): unknown
}

export interface ConnectedSocket {
	task: SocketTaskLike
	socketId: string
}

export const invokeAPIMock = vi.fn<(name: string, params?: BridgeParams) => unknown>()

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

/**
 * Load a pristine copy of the facade. Resets the module registry so no
 * module-level state leaks between specs, and clears the bridge mock.
 */
export async function loadSocketNamespace(): Promise<Record<string, unknown>> {
	vi.resetModules()
	invokeAPIMock.mockReset()
	const loaded: unknown = await import('../index')
	if (!isRecord(loaded)) {
		throw new TypeError('the socket module namespace is not an object')
	}
	return loaded
}

export async function loadSocketModule(): Promise<SocketModule> {
	const namespace = await loadSocketNamespace()
	return namespace as unknown as SocketModule
}

export function bridgeCalls(name: string): BridgeParams[] {
	const calls: BridgeParams[] = []
	for (const call of invokeAPIMock.mock.calls) {
		if (call[0] !== name) continue
		calls.push(isRecord(call[1]) ? call[1] : {})
	}
	return calls
}

export function lastBridgeCall(name: string): BridgeParams {
	const calls = bridgeCalls(name)
	if (calls.length === 0) {
		throw new Error(`the bridge never received an invokeAPI("${name}") call`)
	}
	return calls[calls.length - 1]
}

export function readString(params: BridgeParams, key: string): string {
	const value = params[key]
	if (typeof value !== 'string') {
		throw new TypeError(`bridge param "${key}" is not a string`)
	}
	return value
}

/** The dispatcher the container invokes for every native socket event. */
export function nativeEventHandler(): NativeEventHandler {
	for (const params of bridgeCalls('socketListen')) {
		const handler = params.success
		if (typeof handler === 'function') {
			return handler as NativeEventHandler
		}
	}
	throw new Error('the persistent socketListen subscription was never installed')
}

export function emitNative(event: NativeEvent): void {
	nativeEventHandler()(event)
}

export function nativeProfile(): BridgeParams {
	const profile: BridgeParams = {}
	PROFILE_FIELDS.forEach((field, index) => {
		profile[field] = index + 1
	})
	return profile
}

export function nativeOpenEvent(
	socketId: string,
	header: Record<string, string> = { 'x-upgrade': 'websocket' },
): NativeEvent {
	return { socketId, event: 'open', header, profile: nativeProfile() }
}

export function nativeMessageEvent(socketId: string, data: unknown): NativeEvent {
	return { socketId, event: 'message', data }
}

export function nativeErrorEvent(socketId: string, errMsg = 'connectSocket:fail timeout'): NativeEvent {
	return { socketId, event: 'error', errMsg }
}

export function nativeCloseEvent(socketId: string, code = 1000, reason = 'bye'): NativeEvent {
	return { socketId, event: 'close', code, reason }
}

export function connect(mod: SocketModule, options: BridgeParams = { url: DEFAULT_URL }): ConnectedSocket {
	const task = mod.connectSocket(options)
	if (!task) {
		throw new Error('connectSocket did not return a SocketTask')
	}
	return { task, socketId: readString(lastBridgeCall('connectSocket'), 'socketId') }
}

export function connectAndOpen(mod: SocketModule, options?: BridgeParams): ConnectedSocket {
	const connected = connect(mod, options)
	emitNative(nativeOpenEvent(connected.socketId))
	return connected
}

export function openSockets(mod: SocketModule, count: number): ConnectedSocket[] {
	const sockets: ConnectedSocket[] = []
	for (let index = 0; index < count; index += 1) {
		sockets.push(connectAndOpen(mod, { url: `${DEFAULT_URL}/${index}` }))
	}
	return sockets
}

/** Resolves after the macrotask queue has run, so async error dispatch lands. */
export function flushAsyncDispatch(): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, 0)
	})
}

/**
 * Make the bridge settle calls to `name` through the caller's `outcome`
 * callback, followed by `complete`, the way the container does.
 */
export function answerBridge(name: string, outcome: 'success' | 'fail', result: BridgeParams = {}): void {
	invokeAPIMock.mockImplementation((called: string, params?: BridgeParams) => {
		if (called !== name || !params) return undefined
		const settle = params[outcome]
		if (typeof settle === 'function') (settle as Settler)(result)
		const complete = params.complete
		if (typeof complete === 'function') (complete as Settler)(result)
		return undefined
	})
}
