import { contextBridge, ipcRenderer } from 'electron'
import {
	BRIDGE_PROTOCOL_VERSION,
	DEFAULT_BRIDGE_GLOBAL,
	DEFAULT_LAYOUT_BRIDGE_GLOBAL,
	DeckChannel,
} from '../shared/protocol.js'
import type {
	EventEnvelope,
	InvokeRequest,
	InvokeResponse,
	ProbeResponse,
	DeckBridge,
} from '../shared/protocol.js'
import type { LayoutBridge, SlotGrant } from '../client/layout-client.js'

export interface ExposeBridgeOptions {
	/** 暴露到 window 的全局名，默认 `__electronDeckBridge` */
	readonly globalName?: string
}

/**
 * 在 host preload 内调用，把 framework typed RPC + event push bridge 暴露到
 * webview window：
 *
 * ```ts
 * import { contextBridge, ipcRenderer } from 'electron'
 * import { exposeDeckBridge } from '@dimina-kit/electron-deck/preload'
 * exposeDeckBridge()
 * ```
 *
 * 见 `DeckBridge` 接口（`shared/protocol.ts`）。
 */
export function exposeDeckBridge(options?: ExposeBridgeOptions): void {
	if (typeof contextBridge?.exposeInMainWorld !== 'function' || typeof ipcRenderer?.invoke !== 'function') {
		throw new Error('exposeDeckBridge: must be called from a preload script (electron contextBridge / ipcRenderer unavailable)')
	}

	const globalName = options?.globalName ?? DEFAULT_BRIDGE_GLOBAL
	// 自检 globalThis —— contextBridge 内部也维护去重，但我们抢先抛更明确的诊断
	const g = globalThis as unknown as Record<string, unknown>
	if (g[globalName] !== undefined) {
		throw new Error(`Deck bridge already exposed at "${globalName}"`)
	}

	const bridge: DeckBridge = {
		version: BRIDGE_PROTOCOL_VERSION,
		probe(): Promise<ProbeResponse> {
			return ipcRenderer.invoke(DeckChannel.Probe) as Promise<ProbeResponse>
		},
		invoke(req: InvokeRequest): Promise<InvokeResponse> {
			return ipcRenderer.invoke(DeckChannel.Invoke, req) as Promise<InvokeResponse>
		},
		onEvent(listener: (env: EventEnvelope) => void): () => void {
			const wrapped = (_event: unknown, env: EventEnvelope): void => {
				listener(env)
			}
			ipcRenderer.on(DeckChannel.Event, wrapped)
			return () => {
				ipcRenderer.removeListener(DeckChannel.Event, wrapped)
			}
		},
	}

	contextBridge.exposeInMainWorld(globalName, bridge)
}

export interface ExposeLayoutBridgeOptions {
	/** 暴露到 window 的全局名，默认 `__electronDeckLayoutBridge` */
	readonly globalName?: string
}

/**
 * 在 host preload 内调用，把三条 slot-token LAYOUT channel（`slot-grant` PUSH /
 * `snapshot` send / `layout-subscribe` invoke）封装成一个 `LayoutBridge`-shaped
 * 对象暴露到 webview window，供 renderer：
 *
 * ```ts
 * import { exposeDeckLayoutBridge } from '@dimina-kit/electron-deck/preload'
 * exposeDeckLayoutBridge()
 * // renderer:
 * createDeckLayoutClient({ bridge: window.__electronDeckLayoutBridge })
 * ```
 *
 * channel 名一律取自框架 `DeckChannel`（不手抄字符串）。`onSlotGrant` 返回一个
 * 纯 unsubscribe 函数（可跨 contextBridge），不是 Disposable 对象。
 */
export function exposeDeckLayoutBridge(options?: ExposeLayoutBridgeOptions): void {
	if (typeof contextBridge?.exposeInMainWorld !== 'function' || typeof ipcRenderer?.on !== 'function') {
		throw new Error('exposeDeckLayoutBridge: must be called from a preload script (electron contextBridge / ipcRenderer unavailable)')
	}

	const globalName = options?.globalName ?? DEFAULT_LAYOUT_BRIDGE_GLOBAL
	const g = globalThis as unknown as Record<string, unknown>
	if (g[globalName] !== undefined) {
		throw new Error(`Deck layout bridge already exposed at "${globalName}"`)
	}

	const bridge: LayoutBridge = {
		onSlotGrant(cb: (grant: SlotGrant) => void): () => void {
			const listener = (_event: unknown, grant: SlotGrant): void => {
				cb(grant)
			}
			ipcRenderer.on(DeckChannel.SlotGrant, listener)
			return () => {
				ipcRenderer.removeListener(DeckChannel.SlotGrant, listener)
			}
		},
		sendSnapshot(snapshot): void {
			void ipcRenderer.invoke(DeckChannel.Snapshot, snapshot).catch(() => {})
		},
		subscribe(): void {
			void ipcRenderer.invoke(DeckChannel.LayoutSubscribe).catch(() => {})
		},
	}

	contextBridge.exposeInMainWorld(globalName, bridge)
}

export type {
	EventEnvelope,
	InvokeRequest,
	InvokeResponse,
	ProbeResponse,
	DeckBridge,
	LayoutBridge,
	SlotGrant,
}
export { BRIDGE_PROTOCOL_VERSION, DEFAULT_BRIDGE_GLOBAL, DEFAULT_LAYOUT_BRIDGE_GLOBAL, DeckChannel }
