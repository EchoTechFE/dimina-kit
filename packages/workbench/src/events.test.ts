import { describe, expect, it } from 'vitest'
import { EventNotBoundError } from './errors.js'
import { defineEvent } from './events.js'
import type { JsonValue } from './types.js'

/**
 * Contract tests for the `defineEvent(name)` pure factory.
 *
 * Key invariants:
 * - pure factory: zero side effects on call, no module-level dedupe / registry
 * - returns a HostEvent with `name`, `publish`, `on`
 * - publishing before framework binds a transport throws EventNotBoundError
 * - listeners added via `on()` return a Disposable that, when disposed, stops
 *   delivery (only verifiable once a transport is bound — Phase 1 stub does
 *   not bind one, so dispose-while-unbound paths are covered indirectly).
 */

describe('defineEvent', () => {
	it('returns an object with name / publish / on', () => {
		const ev = defineEvent<JsonValue>('foo')
		expect(ev.name).toBe('foo')
		expect(typeof ev.publish).toBe('function')
		expect(typeof ev.on).toBe('function')
	})

	it('preserves the event name verbatim', () => {
		const ev = defineEvent<JsonValue>('namespace:my-event/v1')
		expect(ev.name).toBe('namespace:my-event/v1')
	})

	it('throws TypeError on empty string name', () => {
		expect(() => defineEvent<JsonValue>('')).toThrow(TypeError)
	})

	it('throws TypeError on non-string name', () => {
		// CONTRACT-AMBIGUOUS: doc says "非空 string，否则 throw TypeError". We
		// assert that runtime guards against non-string at the JS layer too,
		// since TS types alone cannot stop a JS caller.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect(() => defineEvent<JsonValue>(123 as any)).toThrow(TypeError)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect(() => defineEvent<JsonValue>(undefined as any)).toThrow(TypeError)
	})

	it('is a pure factory: invoking it does not throw or register globally', () => {
		// Calling defineEvent should never reach into any framework state.
		// A second call with the same name must not "see" the first one.
		expect(() => {
			defineEvent<JsonValue>('pure-check-1')
			defineEvent<JsonValue>('pure-check-1')
			defineEvent<JsonValue>('pure-check-2')
		}).not.toThrow()
	})

	it('same name twice yields two independent instances (no module-level dedupe)', () => {
		const a = defineEvent<JsonValue>('dup')
		const b = defineEvent<JsonValue>('dup')
		expect(a).not.toBe(b)
		// Both still expose the same name string of course.
		expect(a.name).toBe('dup')
		expect(b.name).toBe('dup')
	})

	it('publish() throws EventNotBoundError when framework has not bound a transport', () => {
		const ev = defineEvent<JsonValue>('unbound')
		expect(() => ev.publish('payload')).toThrow(EventNotBoundError)
	})

	it('publish() error carries the event name', () => {
		const ev = defineEvent<JsonValue>('unbound-named')
		try {
			ev.publish(null)
			throw new Error('publish() should have thrown')
		}
		catch (err) {
			expect(err).toBeInstanceOf(EventNotBoundError)
			expect((err as EventNotBoundError).eventName).toBe('unbound-named')
		}
	})

	it('on() returns a Disposable shape (object with dispose())', () => {
		const ev = defineEvent<JsonValue>('listener-shape')
		const sub = ev.on(() => {})
		expect(sub).toBeDefined()
		expect(typeof sub.dispose).toBe('function')
		// dispose itself must not throw even when the event is unbound.
		expect(() => sub.dispose()).not.toThrow()
	})

	it('on() can register multiple distinct listeners without throwing', () => {
		// CONTRACT-AMBIGUOUS: actual fan-out delivery requires a bound
		// transport, which Phase 1 does not provide. We only assert that
		// registering multiple listeners is itself a non-throwing op — the
		// delivery contract ("一旦 publisher 绑定后, 多次 on() 不同 listener 都
		// 要被通知") will be covered in Phase 2 once bind() exists.
		const ev = defineEvent<JsonValue>('multi-listener')
		expect(() => {
			ev.on(() => {})
			ev.on(() => {})
			ev.on(() => {})
		}).not.toThrow()
	})

	it('on() returns a fresh Disposable per call', () => {
		const ev = defineEvent<JsonValue>('fresh-disposable')
		const a = ev.on(() => {})
		const b = ev.on(() => {})
		expect(a).not.toBe(b)
	})
})
