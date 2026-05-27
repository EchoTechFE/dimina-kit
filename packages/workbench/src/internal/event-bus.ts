import { bindHostEvent, unbindHostEvent } from '../events.js'
import type { Disposable, HostEvent, JsonValue } from '../types.js'

/**
 * Framework-internal event bus。
 *
 * 责任：
 * - `bindDeclaredEvents(events)`：在 Bind 阶段调；对每个声明的 HostEvent，调用
 *   framework binder，让该 event 的 `publish()` 走 bus。
 * - `publish(name, payload)`：通知 `subscribe(name, ...)` 注册的所有 listener。
 * - `subscribe(name, listener)`：返回 `Disposable`，dispose 后停止通知。
 * - `unbindAll()`：解绑所有 declared event publisher + 清空 subscribers。
 *
 * @internal
 */
export class EventBus {
	private readonly subscribers = new Map<string, Set<(payload: JsonValue) => void>>()
	private readonly allSubscribers = new Set<(name: string, payload: JsonValue) => void>()
	private readonly inFlight = new Set<string>()
	private boundEvents: HostEvent<JsonValue>[] = []

	bindDeclaredEvents(events: readonly HostEvent<JsonValue>[]): void {
		for (const ev of events) {
			bindHostEvent(ev, (payload: JsonValue) => this.publish(ev.name, payload))
			this.boundEvents.push(ev)
		}
	}

	publish(name: string, payload: JsonValue): void {
		// 重入守护：listener 内同步再 publish 同一 event 会无限递归。检测到后
		// log + drop，不抛错（避免破坏 fire-and-forget 语义中已经在跑的
		// listener 链）。
		if (this.inFlight.has(name)) {
			console.error(`[workbench] reentrant publish on "${name}" dropped (listener republished the same event synchronously)`)
			return
		}
		this.inFlight.add(name)
		try {
			const subs = this.subscribers.get(name)
			if (subs && subs.size > 0) {
				// snapshot 防止 listener 中 dispose 影响迭代
				const snapshot = Array.from(subs)
				for (const l of snapshot) {
					try {
						l(payload)
					}
					catch (e) {
						console.error(`[workbench] subscriber for "${name}" threw:`, e)
					}
				}
			}
			if (this.allSubscribers.size > 0) {
				const snapshot = Array.from(this.allSubscribers)
				for (const l of snapshot) {
					try {
						l(name, payload)
					}
					catch (e) {
						console.error(`[workbench] catch-all subscriber threw on "${name}":`, e)
					}
				}
			}
		}
		finally {
			this.inFlight.delete(name)
		}
	}

	subscribe(name: string, listener: (payload: JsonValue) => void): Disposable {
		let subs = this.subscribers.get(name)
		if (!subs) {
			subs = new Set()
			this.subscribers.set(name, subs)
		}
		subs.add(listener)
		const set = subs
		return {
			dispose: () => {
				set.delete(listener)
			},
		}
	}

	/**
	 * 订阅所有 channel 的 publish —— framework wire-transport 把 declared
	 * HostEvent.publish() 桥到 webContents.send 时用。
	 */
	subscribeAll(listener: (name: string, payload: JsonValue) => void): Disposable {
		this.allSubscribers.add(listener)
		return {
			dispose: () => {
				this.allSubscribers.delete(listener)
			},
		}
	}

	unbindAll(): void {
		for (const ev of this.boundEvents) unbindHostEvent(ev)
		this.boundEvents = []
		this.subscribers.clear()
		this.allSubscribers.clear()
	}
}
