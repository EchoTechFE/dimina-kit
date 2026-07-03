import { EventNotBoundError } from './errors.js'
import type { Disposable, HostEvent, JsonValue } from './types.js'

/**
 * Module-private internals。把 publisher 和 listener 集合放在 WeakMap 而不是
 * 类实例字段上，外部即便拿到 HostEvent 也无法通过 `as any` / 原型链触达。
 *
 * Limitation：同 process 内若加载了**两份**不同 instance 的 `@dimina-kit/electron-deck`，
 * 它们的 WeakMap 互不相通——这是 packaging 问题，不是 API 设计问题。framework
 * 期待 monorepo + peer-dep 锁定单实例。
 */
interface EventInternals {
	publisher: ((payload: JsonValue) => void) | null
	listeners: Set<(payload: JsonValue) => void>
}

const internals: WeakMap<HostEvent<JsonValue>, EventInternals> = new WeakMap()

class HostEventImpl<P extends JsonValue> implements HostEvent<P> {
	readonly name: string

	constructor(name: string) {
		this.name = name
		internals.set(this as HostEvent<JsonValue>, {
			publisher: null,
			listeners: new Set(),
		})
	}

	publish(payload: P): void {
		const it = internals.get(this as HostEvent<JsonValue>)
		if (!it || it.publisher === null) throw new EventNotBoundError(this.name)
		it.publisher(payload as JsonValue)
		for (const l of it.listeners) {
			try {
				l(payload as JsonValue)
			}
			catch (e) {
				console.error(`[electron-deck] HostEvent "${this.name}" listener threw:`, e)
			}
		}
	}

	on(listener: (payload: P) => void): Disposable {
		const it = internals.get(this as HostEvent<JsonValue>)
		if (!it) {
			throw new TypeError(
				`HostEvent "${this.name}" has no internals — was it produced by defineEvent()?`,
			)
		}
		it.listeners.add(listener as (payload: JsonValue) => void)
		return {
			dispose: () => {
				it.listeners.delete(listener as (payload: JsonValue) => void)
			},
		}
	}
}

/** @experimental No production consumer yet — see the note on {@link HostEvent}. */
export function defineEvent<P extends JsonValue>(name: string): HostEvent<P> {
	if (typeof name !== 'string' || name.length === 0) {
		throw new TypeError('defineEvent(name): name must be a non-empty string')
	}
	return new HostEventImpl<P>(name)
}

/**
 * 校验 `ev` 是否真的来自 `defineEvent()`。判定方式是 WeakMap 身份，而非
 * `instanceof` —— 这样跨 vm.Context（同 module instance）也能工作。
 *
 * @internal
 */
export function isHostEvent(ev: unknown): ev is HostEvent<JsonValue> {
	if (ev === null || typeof ev !== 'object') return false
	return internals.has(ev as HostEvent<JsonValue>)
}

/** @internal framework 在 Bind 阶段调；同实例重复 bind 覆盖前任 */
export function bindHostEvent<P extends JsonValue>(
	event: HostEvent<P>,
	publisher: (payload: P) => void,
): void {
	const it = internals.get(event as HostEvent<JsonValue>)
	if (!it) {
		throw new TypeError(
			'bindHostEvent: argument is not a HostEvent produced by defineEvent()',
		)
	}
	it.publisher = publisher as (payload: JsonValue) => void
}

/** @internal framework 在 Cleanup 阶段调 */
export function unbindHostEvent<P extends JsonValue>(event: HostEvent<P>): void {
	const it = internals.get(event as HostEvent<JsonValue>)
	if (it) {
		it.publisher = null
		it.listeners.clear()
	}
}
