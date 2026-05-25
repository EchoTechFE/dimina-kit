/**
 * Phase 1 contract tests for the pure `difile://` request dispatcher.
 *
 * Spec: `packages/devtools/docs/file-system.md` §4.3, §6 P1-2 / P1-3.
 *
 * Electron's `simSession.protocol.handle` is unreachable from vitest, so
 * the implementer is asked to factor the dispatch body out into an exported
 * pure function `handleDifileRequest(ctx, req): Promise<Response>` that:
 *
 *   - reads `_tmp/*` from the shared in-memory `TempFileStore`
 *   - reads `_store/*` and `usr/<rel>` from `disk.ts`
 *   - rejects anything `resolveVPath` returns null for (→ 404)
 *   - returns 304 when `If-None-Match` matches the disk-side ETag
 *   - returns 206 + Content-Range when `Range: bytes=<start>-<end>` is set
 *   - tags 200/206 responses with Cache-Control + ETag + Content-Type
 *
 * The race-waiter on `_tmp/*` lives in `index.ts` because it owns the IPC
 * lifecycle — these unit tests assume the bytes are already in the store.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HandleDifileContext } from './request-handler'
import { handleDifileRequest } from './request-handler'
import { registerTempFile } from './store'
import type { TempFileRecord, TempFileStore } from './resolver'

// -- fixtures ---------------------------------------------------------------

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ETAG_RE = /^W\/"\d+-\d+"$/
const CACHE_CONTROL = 'public, max-age=31536000, immutable'

// -- sandbox helpers --------------------------------------------------------

let sandboxRoot: string
let sandboxBase: string
let savedHome: string | undefined
let store: TempFileStore
let ctx: HandleDifileContext

function rid(): string {
	return Math.random().toString(16).slice(2) + Date.now().toString(16)
}

async function mkTempSandbox(): Promise<{ root: string; base: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dimina-dispatch-test-'))
	const base = path.join(root, 'files')
	await fs.mkdir(base, { recursive: true })
	return { root, base }
}

async function rmrf(p: string): Promise<void> {
	await fs.rm(p, { recursive: true, force: true })
}

beforeEach(async () => {
	savedHome = process.env.DIMINA_HOME
	const sb = await mkTempSandbox()
	sandboxRoot = sb.root
	sandboxBase = sb.base
	process.env.DIMINA_HOME = sandboxRoot
	store = new Map<string, TempFileRecord>()
	ctx = { tempStore: store }
})

afterEach(async () => {
	if (savedHome === undefined) delete process.env.DIMINA_HOME
	else process.env.DIMINA_HOME = savedHome
	if (sandboxRoot) await rmrf(sandboxRoot)
})

async function writeUsr(rel: string, bytes: Buffer): Promise<string> {
	const full = path.join(sandboxBase, rel)
	await fs.mkdir(path.dirname(full), { recursive: true })
	await fs.writeFile(full, bytes)
	return full
}

async function readBody(res: Response): Promise<Buffer> {
	const ab = await res.arrayBuffer()
	return Buffer.from(ab)
}

// -- 200 / 304 / 404 --------------------------------------------------------

describe('handleDifileRequest — status routing', () => {
	it('returns 200 with the bytes for an existing difile://_tmp/<id>', async () => {
		const bytes = Buffer.from('tmp-bytes', 'utf8')
		const url = `difile://_tmp/${rid()}.txt`
		registerTempFile(store, url, 'text/plain', bytes)

		const res = await handleDifileRequest(ctx, { url })

		expect(res.status).toBe(200)
		const body = await readBody(res)
		expect(body.equals(bytes)).toBe(true)
	})

	it('returns 404 for an unknown difile://_tmp/<id>', async () => {
		const res = await handleDifileRequest(ctx, {
			url: `difile://_tmp/${rid()}.txt`,
		})
		expect(res.status).toBe(404)
	})

	it('returns 200 with disk bytes for an existing difile://_store/<id>', async () => {
		const bytes = Buffer.concat([PNG_MAGIC, Buffer.alloc(32, 0x77)])
		const id = `${rid()}.png`
		await writeUsr(path.join('_store', id), bytes)

		const res = await handleDifileRequest(ctx, {
			url: `difile://_store/${id}`,
		})

		expect(res.status).toBe(200)
		const body = await readBody(res)
		expect(body.equals(bytes)).toBe(true)
	})

	it('returns 404 for an unknown difile://_store/<id>', async () => {
		const res = await handleDifileRequest(ctx, {
			url: `difile://_store/${rid()}.png`,
		})
		expect(res.status).toBe(404)
	})

	it('returns 200 with disk bytes for an existing difile://<usr-rel>', async () => {
		const bytes = Buffer.from('usr area ' + rid(), 'utf8')
		const rel = `notes-${rid()}.txt`
		await writeUsr(rel, bytes)

		const res = await handleDifileRequest(ctx, { url: `difile://${rel}` })

		expect(res.status).toBe(200)
		const body = await readBody(res)
		expect(body.equals(bytes)).toBe(true)
	})

	it('returns 404 for a difile://../ traversal attempt (resolveVPath rejects)', async () => {
		const res = await handleDifileRequest(ctx, {
			url: 'difile://../etc/passwd',
		})
		expect(res.status).toBe(404)
	})

	it('returns 404 for a difile://%2e%2e/ URL-encoded traversal attempt', async () => {
		const res = await handleDifileRequest(ctx, {
			url: 'difile://%2e%2e/etc/passwd',
		})
		expect(res.status).toBe(404)
	})

	it('returns 404 for a non-difile scheme (file://, http://)', async () => {
		const fileRes = await handleDifileRequest(ctx, {
			url: 'file:///etc/passwd',
		})
		expect(fileRes.status).toBe(404)

		const httpRes = await handleDifileRequest(ctx, {
			url: 'http://example.com/x',
		})
		expect(httpRes.status).toBe(404)
	})

	it('returns 304 with empty body when If-None-Match matches the file ETag', async () => {
		const bytes = Buffer.from('cacheable', 'utf8')
		const rel = `cache-${rid()}.txt`
		await writeUsr(rel, bytes)

		const first = await handleDifileRequest(ctx, { url: `difile://${rel}` })
		expect(first.status).toBe(200)
		const etag = first.headers.get('ETag')
		expect(etag).toBeTruthy()

		const second = await handleDifileRequest(ctx, {
			url: `difile://${rel}`,
			headers: { 'If-None-Match': etag! },
		})

		expect(second.status).toBe(304)
		const body = await readBody(second)
		expect(body.length).toBe(0)
	})

	it('still returns 200 when If-None-Match does NOT match the file ETag', async () => {
		const bytes = Buffer.from('fresh', 'utf8')
		const rel = `fresh-${rid()}.txt`
		await writeUsr(rel, bytes)

		const res = await handleDifileRequest(ctx, {
			url: `difile://${rel}`,
			headers: { 'If-None-Match': 'W/"0-0"' },
		})

		expect(res.status).toBe(200)
		const body = await readBody(res)
		expect(body.equals(bytes)).toBe(true)
	})
})

// -- Range ------------------------------------------------------------------

describe('handleDifileRequest — Range', () => {
	it('returns 206 + Content-Range + sliced body for "bytes=0-99"', async () => {
		const bytes = Buffer.alloc(500, 0x41) // 500 × 'A'
		const rel = `range-${rid()}.bin`
		await writeUsr(rel, bytes)

		const res = await handleDifileRequest(ctx, {
			url: `difile://${rel}`,
			headers: { Range: 'bytes=0-99' },
		})

		expect(res.status).toBe(206)
		expect(res.headers.get('Content-Range')).toBe('bytes 0-99/500')
		const body = await readBody(res)
		expect(body.length).toBe(100)
		expect(body.equals(bytes.subarray(0, 100))).toBe(true)
	})

	it('returns 206 + Content-Range + tail body for "bytes=100-" (open-ended)', async () => {
		const bytes = Buffer.alloc(300)
		for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff
		const rel = `tail-${rid()}.bin`
		await writeUsr(rel, bytes)

		const res = await handleDifileRequest(ctx, {
			url: `difile://${rel}`,
			headers: { Range: 'bytes=100-' },
		})

		expect(res.status).toBe(206)
		expect(res.headers.get('Content-Range')).toBe('bytes 100-299/300')
		const body = await readBody(res)
		expect(body.length).toBe(200)
		expect(body.equals(bytes.subarray(100))).toBe(true)
	})

	it('returns 200 + full body when no Range header is supplied', async () => {
		const bytes = Buffer.alloc(64, 0x5a)
		const rel = `full-${rid()}.bin`
		await writeUsr(rel, bytes)

		const res = await handleDifileRequest(ctx, { url: `difile://${rel}` })

		expect(res.status).toBe(200)
		const body = await readBody(res)
		expect(body.equals(bytes)).toBe(true)
	})
})

// -- Headers ----------------------------------------------------------------

describe('handleDifileRequest — response headers', () => {
	it('sets Cache-Control: public, max-age=31536000, immutable on a 200 response', async () => {
		const bytes = Buffer.from('headers-1', 'utf8')
		const rel = `hdr-cc-${rid()}.txt`
		await writeUsr(rel, bytes)

		const res = await handleDifileRequest(ctx, { url: `difile://${rel}` })

		expect(res.status).toBe(200)
		expect(res.headers.get('Cache-Control')).toBe(CACHE_CONTROL)
	})

	it('sets a Content-Type that matches the magic-byte sniffed MIME', async () => {
		const bytes = Buffer.concat([PNG_MAGIC, Buffer.alloc(8, 0)])
		// Deliberately mislabel the extension to force magic-byte sniffing
		// to be the source of Content-Type.
		const rel = `lying-${rid()}.txt`
		await writeUsr(rel, bytes)

		const res = await handleDifileRequest(ctx, { url: `difile://${rel}` })

		expect(res.status).toBe(200)
		expect(res.headers.get('Content-Type')).toBe('image/png')
	})

	it('sets a weak ETag matching W/"<mtime>-<size>" on a 200 response', async () => {
		const bytes = Buffer.from('etag-shape', 'utf8')
		const rel = `hdr-etag-${rid()}.txt`
		await writeUsr(rel, bytes)

		const res = await handleDifileRequest(ctx, { url: `difile://${rel}` })

		expect(res.status).toBe(200)
		const etag = res.headers.get('ETag')
		expect(etag).toBeTruthy()
		expect(etag!).toMatch(ETAG_RE)
	})
})
