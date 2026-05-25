/**
 * Contract tests for the main-process temp-file store helpers.
 *
 *   registerTempFile(store, path, mime, bytes: ArrayBuffer | Buffer): void
 *   revokeTempFile(store, path): void
 *   revokeAllTempFiles(store): void
 *
 * The store is a `Map<string, { bytes: Buffer; mime: string }>`. ArrayBuffer
 * inputs must be normalised to Buffer before insertion. revoke/revokeAll are
 * silent — no throw on missing keys.
 */

import { describe, expect, it } from 'vitest'
import { registerTempFile, revokeTempFile, revokeAllTempFiles } from './store'
import type { TempFileRecord, TempFileStore } from './resolver'

function makeStore(): TempFileStore {
	return new Map<string, TempFileRecord>()
}

describe('registerTempFile', () => {
	it('accepts an ArrayBuffer and stores it as a Buffer', () => {
		const store = makeStore()
		const ab = new Uint8Array([1, 2, 3, 4]).buffer

		registerTempFile(store, 'difile://_tmp/ab', 'application/octet-stream', ab)

		const entry = store.get('difile://_tmp/ab')
		expect(entry).toBeDefined()
		expect(Buffer.isBuffer(entry!.bytes)).toBe(true)
		expect(entry!.bytes.equals(Buffer.from([1, 2, 3, 4]))).toBe(true)
		expect(entry!.mime).toBe('application/octet-stream')
	})

	it('accepts a Buffer and stores it (Buffer.isBuffer remains true)', () => {
		const store = makeStore()
		const buf = Buffer.from('hello')

		registerTempFile(store, 'difile://_tmp/buf', 'text/plain', buf)

		const entry = store.get('difile://_tmp/buf')
		expect(entry).toBeDefined()
		expect(Buffer.isBuffer(entry!.bytes)).toBe(true)
		expect(entry!.bytes.toString('utf8')).toBe('hello')
		expect(entry!.mime).toBe('text/plain')
	})

	it('overwrites an existing entry under the same path', () => {
		const store = makeStore()
		registerTempFile(store, 'difile://_tmp/x', 'text/plain', Buffer.from('first'))
		registerTempFile(store, 'difile://_tmp/x', 'image/png', Buffer.from([0xff, 0xd8]))

		const entry = store.get('difile://_tmp/x')
		expect(entry).toBeDefined()
		expect(entry!.mime).toBe('image/png')
		expect(entry!.bytes.equals(Buffer.from([0xff, 0xd8]))).toBe(true)
		expect(store.size).toBe(1)
	})

	it('uses the full path (including scheme) as the Map key', () => {
		const store = makeStore()
		registerTempFile(store, 'difile://_tmp/full-key', 'text/plain', Buffer.from('a'))

		expect(store.has('difile://_tmp/full-key')).toBe(true)
		expect(store.has('/full-key')).toBe(false)
		expect(store.has('devtools/full-key')).toBe(false)
	})
})

describe('revokeTempFile', () => {
	it('removes the entry from the store', () => {
		const store = makeStore()
		registerTempFile(store, 'difile://_tmp/a', 'text/plain', Buffer.from('a'))
		registerTempFile(store, 'difile://_tmp/b', 'text/plain', Buffer.from('b'))

		revokeTempFile(store, 'difile://_tmp/a')

		expect(store.has('difile://_tmp/a')).toBe(false)
		expect(store.has('difile://_tmp/b')).toBe(true)
		expect(store.size).toBe(1)
	})

	it('is silent (does not throw) when the path is not in the store', () => {
		const store = makeStore()

		expect(() => revokeTempFile(store, 'difile://_tmp/never-registered')).not.toThrow()
		expect(store.size).toBe(0)
	})

	it('is silent when called on an empty store', () => {
		const store = makeStore()
		expect(() => revokeTempFile(store, 'difile://_tmp/anything')).not.toThrow()
	})
})

describe('revokeAllTempFiles', () => {
	it('clears every entry from the store', () => {
		const store = makeStore()
		registerTempFile(store, 'difile://_tmp/a', 'text/plain', Buffer.from('a'))
		registerTempFile(store, 'difile://_tmp/b', 'text/plain', Buffer.from('b'))
		registerTempFile(store, 'difile://_tmp/c', 'text/plain', Buffer.from('c'))

		revokeAllTempFiles(store)

		expect(store.size).toBe(0)
	})

	it('is a no-op (and does not throw) on an empty store', () => {
		const store = makeStore()

		expect(() => revokeAllTempFiles(store)).not.toThrow()
		expect(store.size).toBe(0)
	})
})
