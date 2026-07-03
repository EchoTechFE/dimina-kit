/**
 * Deck framework wire protocol —— main ↔ webview 之间的 channel 名 + 帧
 * 形态。SoT 在此，preload / client / main runtime 都从这里 import。
 *
 * 设计：把 declared `hostServices` / `simulatorApis` / `events` 三类全部走
 * **两个** 统一 channel，避免 channel name 爆炸 / 难以加 senderPolicy 白名单。
 * - `__electron-deck:invoke`  — webview → main RPC (ipcRenderer.invoke)
 * - `__electron-deck:event`   — main → webview event push (webContents.send)
 * - `__electron-deck:probe`   — webview → main 探活，bridge ready 检查
 *
 * 帧用 JSON 对象一层 envelope，便于扩展 + 校验。
 *
 * @internal
 */

import type { JsonValue } from '../types.js'

/** Bridge global 默认挂的全局名（contextBridge.exposeInMainWorld） */
export const DEFAULT_BRIDGE_GLOBAL = '__electronDeckBridge'

/**
 * Slot-token LAYOUT bridge 默认挂的全局名。`exposeDeckLayoutBridge()` 默认暴露到
 * 此名，renderer 的 `createDeckLayoutClient({ bridge: window.__electronDeckLayoutBridge })`
 * 读取同名。单一来源避免 preload helper 与 client 之间字符串漂移。
 */
export const DEFAULT_LAYOUT_BRIDGE_GLOBAL = '__electronDeckLayoutBridge'

/** Bridge protocol semver；client 在 ready() 时校验 major 一致 */
export const BRIDGE_PROTOCOL_VERSION = '1.0.0'

export const DeckChannel = {
	Invoke: '__electron-deck:invoke',
	Event: '__electron-deck:event',
	Probe: '__electron-deck:probe',
	Snapshot: '__electron-deck:snapshot',
	SlotGrant: '__electron-deck:slot-grant',
	LayoutSubscribe: '__electron-deck:layout-subscribe',
} as const

export type InvokeKind = 'host' | 'simulator'

export interface InvokeRequest {
	readonly kind: InvokeKind
	readonly name: string
	readonly args: readonly JsonValue[]
}

export interface InvokeSuccess<R extends JsonValue = JsonValue> {
	readonly ok: true
	readonly result: R
}

export interface InvokeFailure {
	readonly ok: false
	readonly error: {
		readonly remoteName: string
		readonly message: string
		readonly code?: string
	}
}

export type InvokeResponse<R extends JsonValue = JsonValue> =
	| InvokeSuccess<R>
	| InvokeFailure

export interface EventEnvelope<P extends JsonValue = JsonValue> {
	readonly name: string
	readonly payload: P
}

export interface ProbeResponse {
	readonly ready: true
	readonly version: typeof BRIDGE_PROTOCOL_VERSION
}

/**
 * Bridge global 暴露到 webview window 的 shape。preload 把它通过
 * `contextBridge.exposeInMainWorld(globalName, bridge)` 注入；webview-side
 * `createDeckClient()` 通过 `globalThis[globalName]` 读取。
 *
 * 注意所有方法必须是 contextBridge-friendly（plain values + serializable
 * arguments），不要把 Map / Set / Date / Promise.race 等 leak 进 bridge 接口。
 */
export interface DeckBridge {
	readonly version: typeof BRIDGE_PROTOCOL_VERSION
	probe(): Promise<ProbeResponse>
	invoke(req: InvokeRequest): Promise<InvokeResponse>
	/** 订阅 event channel；返回 unsubscribe 函数（不是 Disposable，因为要跨 contextBridge） */
	onEvent(listener: (env: EventEnvelope) => void): () => void
}
