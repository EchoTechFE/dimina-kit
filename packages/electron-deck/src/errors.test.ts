import { describe, expect, it } from 'vitest'
import {
	EventNotBoundError,
	UndeclaredHostEventError,
	DeckClientNotReadyError,
	DeckRemoteError,
} from './errors.js'

/**
 * Pure shape tests for the error classes. These pin the public contract that
 * consumers (devtools / qdmp / webview client) rely on for `instanceof` /
 * `err.name === '...'` / structured field access. No framework, no IPC.
 */

describe('UndeclaredHostEventError', () => {
	it('is an Error subclass', () => {
		const err = new UndeclaredHostEventError('foo')
		expect(err).toBeInstanceOf(Error)
		expect(err).toBeInstanceOf(UndeclaredHostEventError)
	})

	it('has name === "UndeclaredHostEventError"', () => {
		const err = new UndeclaredHostEventError('foo')
		expect(err.name).toBe('UndeclaredHostEventError')
	})

	it('exposes the offending eventName field', () => {
		const err = new UndeclaredHostEventError('my-event')
		expect(err.eventName).toBe('my-event')
	})

	it('message mentions the event name so it is debuggable from logs', () => {
		const err = new UndeclaredHostEventError('foo')
		expect(err.message).toContain('foo')
	})
})

describe('EventNotBoundError', () => {
	it('is an Error subclass', () => {
		const err = new EventNotBoundError('foo')
		expect(err).toBeInstanceOf(Error)
		expect(err).toBeInstanceOf(EventNotBoundError)
	})

	it('has name === "EventNotBoundError"', () => {
		const err = new EventNotBoundError('foo')
		expect(err.name).toBe('EventNotBoundError')
	})

	it('exposes the offending eventName field', () => {
		const err = new EventNotBoundError('my-event')
		expect(err.eventName).toBe('my-event')
	})
})

describe('DeckClientNotReadyError', () => {
	it('is an Error subclass', () => {
		const err = new DeckClientNotReadyError()
		expect(err).toBeInstanceOf(Error)
		expect(err).toBeInstanceOf(DeckClientNotReadyError)
	})

	it('has name === "DeckClientNotReadyError"', () => {
		const err = new DeckClientNotReadyError()
		expect(err.name).toBe('DeckClientNotReadyError')
	})

	it('has a non-empty default message', () => {
		const err = new DeckClientNotReadyError()
		expect(typeof err.message).toBe('string')
		expect(err.message.length).toBeGreaterThan(0)
	})

	it('accepts a custom message', () => {
		const err = new DeckClientNotReadyError('custom diagnostic')
		expect(err.message).toBe('custom diagnostic')
	})
})

describe('DeckRemoteError', () => {
	it('is an Error subclass', () => {
		const err = new DeckRemoteError('svc', 'boom')
		expect(err).toBeInstanceOf(Error)
		expect(err).toBeInstanceOf(DeckRemoteError)
	})

	it('has name === "DeckRemoteError"', () => {
		const err = new DeckRemoteError('svc', 'boom')
		expect(err.name).toBe('DeckRemoteError')
	})

	it('preserves the original remote message', () => {
		const err = new DeckRemoteError('svc', 'underlying failure')
		expect(err.message).toBe('underlying failure')
	})

	it('exposes the remoteName field', () => {
		const err = new DeckRemoteError('host.foo', 'boom')
		expect(err.remoteName).toBe('host.foo')
	})

	it('exposes an optional code field when provided', () => {
		const err = new DeckRemoteError('host.foo', 'boom', 'E_TIMEOUT')
		expect(err.code).toBe('E_TIMEOUT')
	})

	it('leaves code undefined when not provided', () => {
		const err = new DeckRemoteError('host.foo', 'boom')
		expect(err.code).toBeUndefined()
	})
})
