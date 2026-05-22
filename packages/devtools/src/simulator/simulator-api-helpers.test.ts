/**
 * Failing (red) tests for the two helper utilities planned in P5:
 *   - bindCallbacks(ctx, opts) — wraps success/fail/complete via createCallbackFunction
 *   - notSupportedApi(apiName) — factory for "not supported in simulator" stubs
 *
 * The target file (simulator-api-helpers.ts) does not exist yet, so every
 * import resolves to nothing and all tests fail at module resolution.
 */

import { describe, expect, it, vi } from 'vitest'
import type { MiniAppContext } from './types'
import { bindCallbacks, notSupportedApi } from './simulator-api-helpers'

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a fake MiniAppContext.
 * createCallbackFunction behaves like the real one: if the argument is a
 * function, return it (so callers can assert the exact spy); otherwise return
 * undefined. This prevents tests from silently passing when the wrong field is
 * read.
 */
function makeCtx(): MiniAppContext {
	return {
		appId: 'test-app',
		createCallbackFunction: vi.fn((fn: unknown) => (typeof fn === 'function' ? (fn as (...args: unknown[]) => void) : undefined)),
	} as unknown as MiniAppContext
}

// ─── bindCallbacks ────────────────────────────────────────────────────────────

describe('bindCallbacks', () => {
	it('calls ctx.createCallbackFunction for each of success, fail, complete', () => {
		const ctx = makeCtx()
		const success = vi.fn()
		const fail = vi.fn()
		const complete = vi.fn()

		bindCallbacks(ctx, { success, fail, complete })

		expect(ctx.createCallbackFunction).toHaveBeenCalledWith(success)
		expect(ctx.createCallbackFunction).toHaveBeenCalledWith(fail)
		expect(ctx.createCallbackFunction).toHaveBeenCalledWith(complete)
		expect(ctx.createCallbackFunction).toHaveBeenCalledTimes(3)
	})

	it('returns onSuccess/onFail/onComplete as the results of createCallbackFunction', () => {
		const ctx = makeCtx()
		const success = vi.fn()
		const fail = vi.fn()
		const complete = vi.fn()

		const result = bindCallbacks(ctx, { success, fail, complete })

		// Because makeCtx returns the fn as-is, we can compare by reference.
		expect(result.onSuccess).toBe(success)
		expect(result.onFail).toBe(fail)
		expect(result.onComplete).toBe(complete)
	})

	it('when opts only contains fail and complete, onSuccess is undefined', () => {
		const ctx = makeCtx()
		const fail = vi.fn()
		const complete = vi.fn()

		const result = bindCallbacks(ctx, { fail, complete })

		// createCallbackFunction(undefined) → undefined (per makeCtx logic)
		expect(result.onSuccess).toBeUndefined()
		expect(result.onFail).toBe(fail)
		expect(result.onComplete).toBe(complete)
	})

	it('when opts is entirely empty, all three callbacks are undefined', () => {
		const ctx = makeCtx()
		const result = bindCallbacks(ctx, {})
		expect(result.onSuccess).toBeUndefined()
		expect(result.onFail).toBeUndefined()
		expect(result.onComplete).toBeUndefined()
	})
})

// ─── notSupportedApi ──────────────────────────────────────────────────────────

describe('notSupportedApi', () => {
	it('returns a function', () => {
		expect(typeof notSupportedApi('chooseContact')).toBe('function')
	})

	it('the returned function, called with fail + complete opts, invokes fail with the correct errMsg', () => {
		const ctx = makeCtx()
		const fail = vi.fn()
		const complete = vi.fn()

		const stub = notSupportedApi('chooseContact')
		stub.call(ctx, { fail, complete })

		expect(fail).toHaveBeenCalledTimes(1)
		expect(fail).toHaveBeenCalledWith({ errMsg: 'chooseContact:fail not supported in simulator' })
	})

	it('the returned function, called with fail + complete opts, invokes complete', () => {
		const ctx = makeCtx()
		const fail = vi.fn()
		const complete = vi.fn()

		const stub = notSupportedApi('chooseContact')
		stub.call(ctx, { fail, complete })

		expect(complete).toHaveBeenCalledTimes(1)
	})

	it('the errMsg uses the exact apiName passed to notSupportedApi', () => {
		const ctx = makeCtx()
		const fail = vi.fn()

		const stub = notSupportedApi('addPhoneContact')
		stub.call(ctx, { fail })

		expect(fail).toHaveBeenCalledWith({ errMsg: 'addPhoneContact:fail not supported in simulator' })
	})

	it('calling the returned function without opts does not throw', () => {
		const ctx = makeCtx()
		const stub = notSupportedApi('foo')
		expect(() => stub.call(ctx)).not.toThrow()
	})

	it('calling the returned function with an empty opts object does not throw', () => {
		const ctx = makeCtx()
		const stub = notSupportedApi('bar')
		expect(() => stub.call(ctx, {})).not.toThrow()
	})
})
