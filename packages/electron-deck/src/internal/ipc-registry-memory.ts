import type { BrowserWindow } from 'electron'
import type {
	Disposable,
	JsonValue,
	MaybePromise,
	TypedIpcRegistry,
} from '../types.js'

type AnyHandler = (...args: JsonValue[]) => MaybePromise<JsonValue>
type AnyListener = (payload: JsonValue) => void

/**
 * In-memory `TypedIpcRegistry` impl —— Phase 2 不接真 Electron `ipcMain`，提
 * 供 main-process 同进程 `handle` / `on` / `send` / `invoke` 的 fake。
 *
 * - `handle` / `invoke` 与 `on` / `send` 是**独立 channel space**：send 只触
 *   发 on listener；invoke 只调 handle handler；同 channel 名互不影响。
 * - audience / validator option Phase 2 不强制，仅 accept；Phase 3 接 trusted
 *   sender set 时再实施。
 *
 * @internal
 */
export class InMemoryTypedIpcRegistry implements TypedIpcRegistry {
	private readonly handlers = new Map<string, AnyHandler>()
	private readonly listeners = new Map<string, Set<AnyListener>>()

	handle<A extends JsonValue[], R extends JsonValue>(
		channel: string,
		handler: (...args: A) => MaybePromise<R>,
		_options?: {
			validator?: (args: unknown[]) => A
		},
	): Disposable {
		if (this.handlers.has(channel)) {
			throw new Error(`channel already handled: "${channel}"`)
		}
		const cast = handler as unknown as AnyHandler
		this.handlers.set(channel, cast)
		return {
			dispose: () => {
				if (this.handlers.get(channel) === cast) this.handlers.delete(channel)
			},
		}
	}

	on<P extends JsonValue>(channel: string, listener: (payload: P) => void): Disposable {
		let set = this.listeners.get(channel)
		if (!set) {
			set = new Set()
			this.listeners.set(channel, set)
		}
		const cast = listener as unknown as AnyListener
		set.add(cast)
		const ref = set
		return {
			dispose: () => {
				ref.delete(cast)
			},
		}
	}

	send(
		_target: 'mainWindow' | BrowserWindow,
		channel: string,
		payload: JsonValue,
	): void {
		const set = this.listeners.get(channel)
		if (!set) return
		const snapshot = Array.from(set)
		for (const l of snapshot) {
			try {
				l(payload)
			}
			catch (e) {
				console.error(`[electron-deck] ipc on "${channel}" listener threw:`, e)
			}
		}
	}

	/** @internal main-internal helper used by Phase 2 setup tests / framework */
	async invoke<R extends JsonValue>(channel: string, ...args: JsonValue[]): Promise<R> {
		const handler = this.handlers.get(channel)
		if (!handler) throw new Error(`no handler for channel: "${channel}"`)
		const r = await handler(...args)
		return r as R
	}
}
