/**
 * Contract tests for the main-process resolver that backs `difile://_tmp/*`
 * URLs. The resolver looks up bytes/mime in a shared `TempFileStore` (a Map)
 * and returns a `{ status: 200, bytes, mime }` or `{ status: 404 }` shape.
 *
 * No protocol.handle integration is tested here — just the pure function.
 */

import { describe, expect, it } from 'vitest'
import { resolveTempFile, type TempFileRecord, type TempFileStore } from './resolver'

function makeStore(entries: Array<[string, TempFileRecord]> = []): TempFileStore {
	return new Map(entries)
}

describe('resolveTempFile', () => {
	it('returns status 200 with bytes and mime for a registered url', () => {
		const bytes = Buffer.from('hello-bytes')
		const store = makeStore([
			['difile://_tmp/abc', { bytes, mime: 'text/plain' }],
		])

		const result = resolveTempFile(store, 'difile://_tmp/abc')

		expect(result.status).toBe(200)
		if (result.status === 200) {
			expect(result.bytes).toBe(bytes)
			expect(result.mime).toBe('text/plain')
		}
	})

	it('falls back to application/octet-stream when mime is empty string', () => {
		const bytes = Buffer.from([0x01, 0x02])
		const store = makeStore([
			['difile://_tmp/no-mime', { bytes, mime: '' }],
		])

		const result = resolveTempFile(store, 'difile://_tmp/no-mime')

		expect(result.status).toBe(200)
		if (result.status === 200) {
			expect(result.mime).toBe('application/octet-stream')
			expect(result.bytes).toBe(bytes)
		}
	})

	it('falls back to application/octet-stream when mime is undefined', () => {
		const bytes = Buffer.from([0x03])
		const store = makeStore([
			[
				'difile://_tmp/undef-mime',
				{ bytes, mime: undefined as unknown as string },
			],
		])

		const result = resolveTempFile(store, 'difile://_tmp/undef-mime')

		expect(result.status).toBe(200)
		if (result.status === 200) {
			expect(result.mime).toBe('application/octet-stream')
		}
	})

	it('returns 404 when the url is not present in the store', () => {
		const store = makeStore()

		const result = resolveTempFile(store, 'difile://_tmp/missing')

		expect(result).toEqual({ status: 404 })
	})

	it('returns 404 for a non-difile scheme (e.g. https)', () => {
		const store = makeStore([
			['https://example.com/asset.png', { bytes: Buffer.from('x'), mime: 'image/png' }],
		])

		const result = resolveTempFile(store, 'https://example.com/asset.png')

		expect(result).toEqual({ status: 404 })
	})

	it('returns 404 for a non-difile scheme (e.g. blob:)', () => {
		const store = makeStore([
			['blob:legacy-1', { bytes: Buffer.from('x'), mime: 'text/plain' }],
		])

		const result = resolveTempFile(store, 'blob:legacy-1')

		expect(result).toEqual({ status: 404 })
	})

	it('returns 404 for a difile url with the wrong host', () => {
		// Store an entry under the same `id` part but a different host. The
		// resolver must NOT match across hosts even if the key shape is similar.
		const store = makeStore([
			['difile://_tmp/abc', { bytes: Buffer.from('right'), mime: 'text/plain' }],
		])

		const result = resolveTempFile(store, 'difile://other-host/abc')

		expect(result).toEqual({ status: 404 })
	})

	it('uses the full url (including scheme) as the Map key — partial keys do not match', () => {
		const bytes = Buffer.from('full-key-only')
		const store = makeStore([
			['difile://_tmp/full-key', { bytes, mime: 'text/plain' }],
		])

		// The bare path "/full-key" or "_tmp/full-key" must NOT resolve.
		expect(resolveTempFile(store, '/full-key')).toEqual({ status: 404 })
		expect(resolveTempFile(store, '_tmp/full-key')).toEqual({ status: 404 })
		expect(resolveTempFile(store, 'difile://_tmp/full-key').status).toBe(200)
	})
})

/**
 * The main-process resolver only owns the `_tmp/` namespace. `_store/` and plain
 * user-data paths (`difile://<rel>`) are handed off to the on-disk reader
 * (`disk.ts`). The resolver returns 404 for those URLs even if a record happens
 * to exist in the Map under that key (the Map should never be populated for
 * non-tmp URLs, but we assert the safe-by-default behaviour anyway).
 */
describe('resolveTempFile — namespace ownership', () => {
	it('returns 404 for difile://_store/* even when a record exists at that key', () => {
		const store = makeStore([
			['difile://_store/xyz', { bytes: Buffer.from('stored'), mime: 'image/png' }],
		])

		expect(resolveTempFile(store, 'difile://_store/xyz')).toEqual({ status: 404 })
	})

	it('returns 404 for a plain user-data path difile://<rel> even when a record exists', () => {
		const store = makeStore([
			['difile://abc.txt', { bytes: Buffer.from('user'), mime: 'text/plain' }],
		])

		expect(resolveTempFile(store, 'difile://abc.txt')).toEqual({ status: 404 })
	})

	it('returns 404 for a nested user-data path', () => {
		const store = makeStore()
		expect(resolveTempFile(store, 'difile://docs/notes/a.md')).toEqual({ status: 404 })
	})

	it('still returns 200 for a legitimate difile://_tmp/* entry', () => {
		const store = makeStore([
			['difile://_tmp/legit', { bytes: Buffer.from('ok'), mime: 'text/plain' }],
		])

		expect(resolveTempFile(store, 'difile://_tmp/legit').status).toBe(200)
	})
})
