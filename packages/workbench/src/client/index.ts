import {
	WorkbenchClientNotReadyError,
	WorkbenchRemoteError,
} from '../errors.js'
import {
	BRIDGE_PROTOCOL_VERSION,
	DEFAULT_BRIDGE_GLOBAL,
} from '../shared/protocol.js'
import type { EventEnvelope, WorkbenchBridge } from '../shared/protocol.js'
import type { Disposable, HostEvent, JsonValue } from '../types.js'

export { WorkbenchClientNotReadyError, WorkbenchRemoteError }

export interface CreateWorkbenchClientOptions {
	/** 默认 `__workbenchBridge`；必须与 host preload 对齐 */
	readonly globalName?: string
}

export interface WorkbenchClient<
	HS extends Record<string, (...args: JsonValue[]) => unknown>,
	EV extends readonly HostEvent<JsonValue>[],
> {
	ready(): Promise<void>
	invoke<K extends keyof HS & string>(
		name: K,
		...args: Parameters<HS[K]>
	): Promise<Awaited<ReturnType<HS[K]>>>
	on<E extends EV[number]>(
		event: E,
		listener: (payload: E extends HostEvent<infer P> ? P : never) => void,
	): Disposable
}

export function createWorkbenchClient<
	HS extends Record<string, (...args: JsonValue[]) => unknown>,
	EV extends readonly HostEvent<JsonValue>[],
>(options?: CreateWorkbenchClientOptions): WorkbenchClient<HS, EV> {
	const globalName = options?.globalName ?? DEFAULT_BRIDGE_GLOBAL

	function getBridge(): WorkbenchBridge {
		const bridge = readBridgeFromGlobal(globalName)
		if (bridge === undefined) {
			throw new WorkbenchClientNotReadyError(
				`Workbench framework bridge is missing on window["${globalName}"] — did the host preload call exposeWorkbenchBridge()?`,
			)
		}
		return bridge
	}

	return {
		async ready(): Promise<void> {
			const bridge = getBridge()
			const remoteMajor = parseMajor(bridge.version)
			const localMajor = parseMajor(BRIDGE_PROTOCOL_VERSION)
			if (remoteMajor !== localMajor) {
				throw new WorkbenchClientNotReadyError(
					`Workbench bridge protocol version mismatch: bridge=${String(bridge.version)}, client expected major ${localMajor}.x.x (${BRIDGE_PROTOCOL_VERSION})`,
				)
			}
		},

		async invoke<K extends keyof HS & string>(
			name: K,
			...args: Parameters<HS[K]>
		): Promise<Awaited<ReturnType<HS[K]>>> {
			const bridge = getBridge()
			const response = await bridge.invoke({
				kind: 'host',
				name,
				args: args as readonly JsonValue[],
			})
			if (response.ok) {
				return response.result as Awaited<ReturnType<HS[K]>>
			}
			const { remoteName, message, code } = response.error
			throw new WorkbenchRemoteError(remoteName, message, code)
		},

		on<E extends EV[number]>(
			event: E,
			listener: (payload: E extends HostEvent<infer P> ? P : never) => void,
		): Disposable {
			const bridge = getBridge()
			const wrapped = (env: EventEnvelope): void => {
				if (env.name === event.name) {
					listener(env.payload as E extends HostEvent<infer P> ? P : never)
				}
			}
			const unsubscribe = bridge.onEvent(wrapped)
			let disposed = false
			return {
				dispose: () => {
					if (disposed) return
					disposed = true
					unsubscribe()
				},
			}
		},
	}
}

export function readBridgeFromGlobal(
	globalName: string = DEFAULT_BRIDGE_GLOBAL,
): WorkbenchBridge | undefined {
	const g = globalThis as unknown as Record<string, unknown>
	const bridge = g[globalName]
	if (bridge === undefined || bridge === null) return undefined
	return bridge as WorkbenchBridge
}

function parseMajor(version: unknown): number {
	if (typeof version !== 'string') return Number.NaN
	const head = version.split('.')[0] ?? ''
	const n = Number.parseInt(head, 10)
	return Number.isNaN(n) ? Number.NaN : n
}

export { BRIDGE_PROTOCOL_VERSION, DEFAULT_BRIDGE_GLOBAL }
