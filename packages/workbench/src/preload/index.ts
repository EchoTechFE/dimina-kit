import { contextBridge, ipcRenderer } from 'electron'
import {
	BRIDGE_PROTOCOL_VERSION,
	DEFAULT_BRIDGE_GLOBAL,
	WorkbenchChannel,
} from '../shared/protocol.js'
import type {
	EventEnvelope,
	InvokeRequest,
	InvokeResponse,
	ProbeResponse,
	WorkbenchBridge,
} from '../shared/protocol.js'

export interface ExposeBridgeOptions {
	/** 暴露到 window 的全局名，默认 `__workbenchBridge` */
	readonly globalName?: string
}

/**
 * 在 host preload 内调用，把 framework typed RPC + event push bridge 暴露到
 * webview window：
 *
 * ```ts
 * import { contextBridge, ipcRenderer } from 'electron'
 * import { exposeWorkbenchBridge } from '@dimina-kit/workbench/preload'
 * exposeWorkbenchBridge()
 * ```
 *
 * 见 `WorkbenchBridge` 接口（`shared/protocol.ts`）。
 */
export function exposeWorkbenchBridge(options?: ExposeBridgeOptions): void {
	if (typeof contextBridge?.exposeInMainWorld !== 'function' || typeof ipcRenderer?.invoke !== 'function') {
		throw new Error('exposeWorkbenchBridge: must be called from a preload script (electron contextBridge / ipcRenderer unavailable)')
	}

	const globalName = options?.globalName ?? DEFAULT_BRIDGE_GLOBAL
	// 自检 globalThis —— contextBridge 内部也维护去重，但我们抢先抛更明确的诊断
	const g = globalThis as unknown as Record<string, unknown>
	if (g[globalName] !== undefined) {
		throw new Error(`Workbench bridge already exposed at "${globalName}"`)
	}

	const bridge: WorkbenchBridge = {
		version: BRIDGE_PROTOCOL_VERSION,
		probe(): Promise<ProbeResponse> {
			return ipcRenderer.invoke(WorkbenchChannel.Probe) as Promise<ProbeResponse>
		},
		invoke(req: InvokeRequest): Promise<InvokeResponse> {
			return ipcRenderer.invoke(WorkbenchChannel.Invoke, req) as Promise<InvokeResponse>
		},
		onEvent(listener: (env: EventEnvelope) => void): () => void {
			const wrapped = (_event: unknown, env: EventEnvelope): void => {
				listener(env)
			}
			ipcRenderer.on(WorkbenchChannel.Event, wrapped)
			return () => {
				ipcRenderer.removeListener(WorkbenchChannel.Event, wrapped)
			}
		},
	}

	contextBridge.exposeInMainWorld(globalName, bridge)
}

export type {
	EventEnvelope,
	InvokeRequest,
	InvokeResponse,
	ProbeResponse,
	WorkbenchBridge,
}
export { BRIDGE_PROTOCOL_VERSION, DEFAULT_BRIDGE_GLOBAL, WorkbenchChannel }
