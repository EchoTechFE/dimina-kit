import type { Disposable, MaybePromise, ResourceRegistry } from '../types.js'

/**
 * I3: LIFO disposable registry。
 *
 * 合同：
 * - `add(d)` 接受 `Disposable` 或 nullary cleanup function；返回 wrapper
 *   `Disposable`，dispose 自身会 (a) 调用 underlying dispose, (b) 从 registry
 *   除名，避免 disposeAll 再次调。
 * - `disposeAll()` 按**注册逆序**调 dispose（LIFO）；任一 dispose 抛错都不阻断
 *   后续，全部跑完再 throw `AggregateError`（仅当至少一个失败时）；调过一次后
 *   再次调是 no-op resolve。
 * - 在 disposeAll 已跑后，`add()` 仍然要立即 dispose 新资源（不泄漏）。
 *
 * @deprecated 地基层的承重 disposable 原语已收敛到 `src/main/disposable.ts`
 *   的 `DisposableRegistry`（foundation.md §11 决策①：连接层选用 disposed-后-add-抛错
 *   语义 + reset=换实例）。本实现的 disposed-后-add-立即-dispose 语义与之互斥，
 *   仅 `workbench-app.ts` 旧路径仍在用，不再用于新代码。后续期删除。
 * @internal
 */
interface Entry {
	readonly id: number
	readonly dispose: () => MaybePromise<void>
}

export class ResourceRegistryImpl implements ResourceRegistry {
	private entries: Entry[] = []
	private nextId = 1
	private allDisposed = false

	add(d: Disposable | (() => MaybePromise<void>)): Disposable {
		const underlying: () => MaybePromise<void>
			= typeof d === 'function' ? d : () => d.dispose()

		if (this.allDisposed) {
			// add() after disposeAll() → 立即 dispose，不进 registry（防泄漏）
			void runQuietly(underlying)
			return { dispose: () => {} }
		}

		const id = this.nextId++
		const entry: Entry = { id, dispose: underlying }
		this.entries.push(entry)
		let disposedThis = false
		return {
			dispose: async () => {
				if (disposedThis) return
				disposedThis = true
				const idx = this.entries.findIndex(e => e.id === id)
				if (idx !== -1) this.entries.splice(idx, 1)
				await underlying()
			},
		}
	}

	async disposeAll(): Promise<void> {
		if (this.allDisposed) return
		this.allDisposed = true
		const toDispose = this.entries.slice().reverse()
		this.entries = []
		const errors: unknown[] = []
		for (const entry of toDispose) {
			try {
				await entry.dispose()
			}
			catch (e) {
				errors.push(e)
			}
		}
		if (errors.length > 0) {
			throw new AggregateError(
				errors,
				`ResourceRegistry.disposeAll: ${errors.length} dispose(s) failed`,
			)
		}
	}
}

function runQuietly(fn: () => MaybePromise<void>): MaybePromise<void> {
	try {
		const r = fn()
		if (r && typeof (r as Promise<void>).then === 'function') {
			return (r as Promise<void>).catch(() => {})
		}
		return undefined
	}
	catch {
		return undefined
	}
}
