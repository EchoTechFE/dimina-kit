import {
	DeckClientNotReadyError,
	DeckRemoteError,
} from '../errors.js'
import {
	BRIDGE_PROTOCOL_VERSION,
	DEFAULT_BRIDGE_GLOBAL,
} from '../shared/protocol.js'
import type { EventEnvelope, DeckBridge } from '../shared/protocol.js'
import type { Disposable, HostEvent, JsonValue } from '../types.js'

export { DeckClientNotReadyError, DeckRemoteError }

export { createDeckLayoutClient } from './layout-client.js'
export type {
	SlotGrant,
	LayoutBridge,
	LayoutClientDeps,
} from './layout-client.js'

export interface CreateDeckClientOptions {
	/** 默认 `__electronDeckBridge`；必须与 host preload 对齐 */
	readonly globalName?: string
}

// HS / EV 使用 `any` 而非 `JsonValue[]` 约束：
// (1) host 侧 HostServiceHandler 同样是 `(...args: any[]) => unknown`，两侧对称；
// (2) JsonValue 索引签名挡掉常见 host 写法（`(p: { code: string }) => ...`），
//     强迫 rest-only 签名时 `Parameters<HS[K]>` 推不出真实参数类型；
// (3) Electron IPC 实际走 structured clone（非 JSON），原约束的"前提"本就错；
// (4) 真要 runtime 校验，在 transport 边界用 `runtime.ipc.handle({ validator })`
//     与 protocol envelope（`InvokeRequest.args: readonly JsonValue[]`）已经够。
export interface DeckClient<
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	HS extends Record<keyof HS, (...args: any[]) => unknown>,
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

export function createDeckClient<
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	HS extends Record<keyof HS, (...args: any[]) => unknown>,
	EV extends readonly HostEvent<JsonValue>[],
>(options?: CreateDeckClientOptions): DeckClient<HS, EV> {
	const globalName = options?.globalName ?? DEFAULT_BRIDGE_GLOBAL

	function getBridge(): DeckBridge {
		const bridge = readBridgeFromGlobal(globalName)
		if (bridge === undefined) {
			throw new DeckClientNotReadyError(
				`Deck framework bridge is missing on window["${globalName}"] — did the host preload call exposeDeckBridge()?`,
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
				throw new DeckClientNotReadyError(
					`Deck bridge protocol version mismatch: bridge=${String(bridge.version)}, client expected major ${localMajor}.x.x (${BRIDGE_PROTOCOL_VERSION})`,
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
			throw new DeckRemoteError(remoteName, message, code)
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
): DeckBridge | undefined {
	const g = globalThis as unknown as Record<string, unknown>
	const bridge = g[globalName]
	if (bridge === undefined || bridge === null) return undefined
	return bridge as DeckBridge
}

function parseMajor(version: unknown): number {
	if (typeof version !== 'string') return Number.NaN
	const head = version.split('.')[0] ?? ''
	const n = Number.parseInt(head, 10)
	return Number.isNaN(n) ? Number.NaN : n
}

export { BRIDGE_PROTOCOL_VERSION, DEFAULT_BRIDGE_GLOBAL }
