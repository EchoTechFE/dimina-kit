/**
 * Characterization tests for the wx.*Storage* simulator API stubs.
 *
 * Pins the current public contract ahead of an internal refactor that must
 * not change behavior: key prefixing per appId, JSON round-trip semantics,
 * async success/fail/complete ordering, and errMsg formatting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MiniAppContext } from './types'
import {
	clearStorage,
	clearStorageSync,
	getStorage,
	getStorageInfo,
	getStorageInfoSync,
	getStorageSync,
	removeStorage,
	removeStorageSync,
	setStorage,
	setStorageSync,
} from './simulator-api-storage'

function makeContext(appId: string): MiniAppContext {
	return {
		appId,
		createCallbackFunction: vi.fn((fn: unknown) => (typeof fn === 'function' ? fn : undefined)),
	} as unknown as MiniAppContext
}

beforeEach(() => {
	localStorage.clear()
})

afterEach(() => {
	localStorage.clear()
	vi.restoreAllMocks()
})

describe('setStorageSync / getStorageSync', () => {
	it('round-trips an object through JSON so structure survives, not just a string', () => {
		const ctx = makeContext('app-a')
		setStorageSync.call(ctx, { key: 'user', data: { name: 'Ann', age: 3 } })

		const result = getStorageSync.call(ctx, { key: 'user' })
		expect(result).toEqual({ data: { name: 'Ann', age: 3 } })
	})

	it('stores a non-object value with String() rather than JSON.stringify', () => {
		const ctx = makeContext('app-a')
		// String(42) === '42', which also happens to be valid JSON. A
		// JSON.stringify-based implementation would produce the same bytes here,
		// so this alone doesn't distinguish the two paths — the raw-string test
		// below does.
		setStorageSync.call(ctx, { key: 'count', data: 42 })
		expect(localStorage.getItem('app-a_count')).toBe('42')
	})

	it('returns the raw string unparsed when the stored value is not valid JSON', () => {
		const ctx = makeContext('app-a')
		setStorageSync.call(ctx, { key: 'note', data: 'not json at all' })

		const result = getStorageSync.call(ctx, { key: 'note' })
		expect(result).toEqual({ data: 'not json at all' })
	})

	it('returns {data: ""} for a key that was never set, not undefined or throwing', () => {
		const ctx = makeContext('app-a')
		expect(getStorageSync.call(ctx, { key: 'missing' })).toEqual({ data: '' })
	})

	it('prefixes the localStorage key with appId so two apps do not see each other\'s writes', () => {
		const a = makeContext('app-a')
		const b = makeContext('app-b')
		setStorageSync.call(a, { key: 'token', data: 'a-secret' })

		expect(getStorageSync.call(b, { key: 'token' })).toEqual({ data: '' })
		expect(getStorageSync.call(a, { key: 'token' })).toEqual({ data: 'a-secret' })
	})
})

describe('removeStorageSync / clearStorageSync', () => {
	it('removeStorageSync makes a subsequent getStorageSync report the key as absent', () => {
		const ctx = makeContext('app-a')
		setStorageSync.call(ctx, { key: 'k', data: 'v' })
		removeStorageSync.call(ctx, { key: 'k' })

		expect(getStorageSync.call(ctx, { key: 'k' })).toEqual({ data: '' })
	})

	it('clearStorageSync wipes only keys under the calling appId, leaving other apps intact', () => {
		const a = makeContext('app-a')
		const b = makeContext('app-b')
		setStorageSync.call(a, { key: 'k1', data: 'v1' })
		setStorageSync.call(a, { key: 'k2', data: 'v2' })
		setStorageSync.call(b, { key: 'k1', data: 'b-v1' })

		clearStorageSync.call(a)

		expect(getStorageSync.call(a, { key: 'k1' })).toEqual({ data: '' })
		expect(getStorageSync.call(a, { key: 'k2' })).toEqual({ data: '' })
		expect(getStorageSync.call(b, { key: 'k1' })).toEqual({ data: 'b-v1' })
	})
})

describe('getStorageInfoSync', () => {
	it('reports de-prefixed keys, char-count*2 currentSize, and the fixed 10MB limit', () => {
		const ctx = makeContext('app-a')
		setStorageSync.call(ctx, { key: 'a', data: 'xy' }) // stored as 'xy' -> 2 chars
		setStorageSync.call(ctx, { key: 'b', data: 'z' }) // stored as 'z' -> 1 char

		const info = getStorageInfoSync.call(ctx)
		expect(info.keys.sort()).toEqual(['a', 'b'])
		// Keys must come back WITHOUT the appId prefix.
		expect(info.keys).not.toContain('app-a_a')
		expect(info.currentSize).toBe((2 + 1) * 2)
		expect(info.limitSize).toBe(10 * 1024 * 1024)
	})

	it('only counts keys belonging to the calling appId', () => {
		const a = makeContext('app-a')
		const b = makeContext('app-b')
		setStorageSync.call(a, { key: 'k', data: 'aaaa' })
		setStorageSync.call(b, { key: 'k', data: 'bbbbbbbb' })

		const info = getStorageInfoSync.call(a)
		expect(info.keys).toEqual(['k'])
		expect(info.currentSize).toBe(4 * 2)
	})
})

describe('setStorage / getStorage (async)', () => {
	it('setStorage succeeds with errMsg "setStorage:ok" and the value is readable via getStorage', async () => {
		const ctx = makeContext('app-a')
		const success = vi.fn()
		const complete = vi.fn()
		setStorage.call(ctx, { key: 'k', data: { x: 1 }, success, complete })

		expect(success).toHaveBeenCalledWith({ errMsg: 'setStorage:ok' })
		expect(complete).toHaveBeenCalled()

		const readSuccess = vi.fn()
		getStorage.call(ctx, { key: 'k', success: readSuccess })
		expect(readSuccess).toHaveBeenCalledWith({ data: { x: 1 }, errMsg: 'getStorage:ok' })
	})

	it('getStorage on a missing key calls fail (not success) with "getStorage:fail data not found"', () => {
		const ctx = makeContext('app-a')
		const success = vi.fn()
		const fail = vi.fn()
		const complete = vi.fn()
		getStorage.call(ctx, { key: 'nope', success, fail, complete })

		expect(fail).toHaveBeenCalledWith({ errMsg: 'getStorage:fail data not found' })
		expect(success).not.toHaveBeenCalled()
		expect(complete).toHaveBeenCalled()
	})

	it('sync writes are visible to the async reader — the two APIs share one store', () => {
		const ctx = makeContext('app-a')
		setStorageSync.call(ctx, { key: 'shared', data: 'from-sync' })

		const success = vi.fn()
		getStorage.call(ctx, { key: 'shared', success })
		expect(success).toHaveBeenCalledWith({ data: 'from-sync', errMsg: 'getStorage:ok' })
	})

	it('async writes are visible to the sync reader', () => {
		const ctx = makeContext('app-a')
		setStorage.call(ctx, { key: 'shared', data: 'from-async', success: vi.fn() })

		expect(getStorageSync.call(ctx, { key: 'shared' })).toEqual({ data: 'from-async' })
	})

	it('complete always runs after success, never before, on the happy path', () => {
		const ctx = makeContext('app-a')
		const order: string[] = []
		setStorage.call(ctx, {
			key: 'k',
			data: 'v',
			success: () => order.push('success'),
			complete: () => order.push('complete'),
		})
		expect(order).toEqual(['success', 'complete'])
	})

	it('complete always runs after fail, never before, and success is skipped entirely', () => {
		const ctx = makeContext('app-a')
		const order: string[] = []
		getStorage.call(ctx, {
			key: 'missing',
			success: () => order.push('success'),
			fail: () => order.push('fail'),
			complete: () => order.push('complete'),
		})
		expect(order).toEqual(['fail', 'complete'])
	})

	it('setStorage reports fail (not success) with a "setStorage:fail <reason>" errMsg when the write throws', () => {
		const ctx = makeContext('app-a')
		vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new Error('quota exceeded')
		})
		const success = vi.fn()
		const fail = vi.fn()
		const complete = vi.fn()
		setStorage.call(ctx, { key: 'k', data: 'v', success, fail, complete })

		expect(success).not.toHaveBeenCalled()
		expect(fail).toHaveBeenCalledWith({ errMsg: 'setStorage:fail quota exceeded' })
		expect(complete).toHaveBeenCalled()
	})
})

describe('removeStorage (async)', () => {
	it('removes the key and reports success with errMsg "removeStorage:ok"', () => {
		const ctx = makeContext('app-a')
		setStorageSync.call(ctx, { key: 'k', data: 'v' })

		const success = vi.fn()
		const complete = vi.fn()
		removeStorage.call(ctx, { key: 'k', success, complete })

		expect(success).toHaveBeenCalledWith({ errMsg: 'removeStorage:ok' })
		expect(complete).toHaveBeenCalled()
		expect(getStorageSync.call(ctx, { key: 'k' })).toEqual({ data: '' })
	})
})

describe('clearStorage (async)', () => {
	it('clears only the calling appId\'s keys and reports success with "clearStorage:ok"', () => {
		const a = makeContext('app-a')
		const b = makeContext('app-b')
		setStorageSync.call(a, { key: 'k1', data: 'v1' })
		setStorageSync.call(b, { key: 'k1', data: 'b-v1' })

		const success = vi.fn()
		const complete = vi.fn()
		clearStorage.call(a, { success, complete })

		expect(success).toHaveBeenCalledWith({ errMsg: 'clearStorage:ok' })
		expect(complete).toHaveBeenCalled()
		expect(getStorageSync.call(a, { key: 'k1' })).toEqual({ data: '' })
		expect(getStorageSync.call(b, { key: 'k1' })).toEqual({ data: 'b-v1' })
	})

	it('works with no options at all (success/complete are optional)', () => {
		const ctx = makeContext('app-a')
		setStorageSync.call(ctx, { key: 'k', data: 'v' })
		expect(() => clearStorage.call(ctx)).not.toThrow()
		expect(getStorageSync.call(ctx, { key: 'k' })).toEqual({ data: '' })
	})
})

describe('getStorageInfo (async)', () => {
	it('reports success with keys/currentSize/limitSize/errMsg mirroring the sync variant', () => {
		const ctx = makeContext('app-a')
		setStorageSync.call(ctx, { key: 'a', data: 'xy' })

		const success = vi.fn()
		const complete = vi.fn()
		getStorageInfo.call(ctx, { success, complete })

		expect(success).toHaveBeenCalledWith({
			keys: ['a'],
			currentSize: 4,
			limitSize: 10 * 1024 * 1024,
			errMsg: 'getStorageInfo:ok',
		})
		expect(complete).toHaveBeenCalled()
	})
})
