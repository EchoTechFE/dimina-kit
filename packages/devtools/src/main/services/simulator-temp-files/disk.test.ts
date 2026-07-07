/**
 * Contract tests for the main-process disk helpers in `disk.ts`.
 *
 * Spec: `packages/devtools/docs/file-system.md`.
 *
 *   readDiskFile(realPath, opts?) → { bytes, mime, etag, totalSize }
 *   writeDiskFile(realPath, bytes)
 *   readDiskDir(realPath) → string[]
 *   statDiskFile(realPath) → { size, mtime, mode, isFile, isDirectory }
 *
 * These tests treat `realPath` as already-canonicalized; vpath canonicalize
 * is covered by `src/shared/vpath.test.ts`. To stay hermetic each test
 * spins up an isolated sandbox under `os.tmpdir()` and points
 * `DIMINA_HOME` at it — the same hook `resolveVPath` honours — so callers
 * who DO go through `resolveVPath` would land at the same `realPath` we
 * write to here.
 *
 * MIME contract: magic-byte sniffing (first ~12 bytes) wins, extension is
 * the fallback, `application/octet-stream` is the last resort.
 *
 * ETag shape: `W/"<mtime-ms>-<size>"` — weak validator folding both axes.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	readDiskDir,
	readDiskFile,
	statDiskFile,
	writeDiskFile,
} from './disk'

// -- fixtures ---------------------------------------------------------------

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])
// MP4 ftyp box: any 4 bytes box size, then 'ftyp', then a brand.
const MP4_MAGIC = Buffer.from([
	0x00, 0x00, 0x00, 0x20,
	0x66, 0x74, 0x79, 0x70, // 'ftyp'
	0x69, 0x73, 0x6f, 0x6d, // 'isom'
])

const ETAG_RE = /^W\/"\d+-\d+"$/

// -- sandbox helpers --------------------------------------------------------

let sandboxRoot: string
let sandboxBase: string
let savedHome: string | undefined

function rid(): string {
	// Avoid Web Crypto / uuid deps — plain hex is enough for a fixture name.
	return Math.random().toString(16).slice(2) + Date.now().toString(16)
}

async function mkTempSandbox(): Promise<{ root: string; base: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dimina-disk-test-'))
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
})

afterEach(async () => {
	if (savedHome === undefined) delete process.env.DIMINA_HOME
	else process.env.DIMINA_HOME = savedHome
	if (sandboxRoot) await rmrf(sandboxRoot)
})

function realOf(...segs: string[]): string {
	return path.join(sandboxBase, ...segs)
}

async function writeRaw(rel: string, bytes: Buffer): Promise<string> {
	const full = realOf(rel)
	await fs.mkdir(path.dirname(full), { recursive: true })
	await fs.writeFile(full, bytes)
	return full
}

// -- readDiskFile -----------------------------------------------------------

describe('readDiskFile — basic reads', () => {
	it('reads a user-data file and returns identical bytes', async () => {
		const bytes = Buffer.from('hello user data ' + rid(), 'utf8')
		const real = await writeRaw('notes.txt', bytes)

		const result = await readDiskFile(real)

		expect(Buffer.isBuffer(result.bytes)).toBe(true)
		expect(result.bytes.equals(bytes)).toBe(true)
		expect(result.totalSize).toBe(bytes.length)
		expect(result.mime).toBe('text/plain')
	})

	it('reads a _store/* file and returns identical bytes', async () => {
		const bytes = Buffer.concat([PNG_MAGIC, Buffer.alloc(64, 0x42)])
		const real = await writeRaw(path.join('_store', `${rid()}.png`), bytes)

		const result = await readDiskFile(real)

		expect(result.bytes.equals(bytes)).toBe(true)
		expect(result.totalSize).toBe(bytes.length)
		expect(result.mime).toBe('image/png')
	})

	it('throws when the file does not exist (ENOENT-like)', async () => {
		const missing = realOf('does-not-exist', `${rid()}.bin`)
		await expect(readDiskFile(missing)).rejects.toThrow()
	})

	it('reports totalSize equal to bytes.length for a full read', async () => {
		const bytes = Buffer.alloc(1234, 0x37)
		const real = await writeRaw('full.bin', bytes)

		const result = await readDiskFile(real)

		expect(result.bytes.length).toBe(1234)
		expect(result.totalSize).toBe(1234)
	})
})

describe('readDiskFile — Range slicing', () => {
	it('returns the inclusive slice for { start, end }', async () => {
		const bytes = Buffer.from('abcdefghij', 'utf8') // length 10
		const real = await writeRaw('slice.txt', bytes)

		const result = await readDiskFile(real, { range: { start: 2, end: 5 } })

		expect(result.bytes.toString('utf8')).toBe('cdef')
		expect(result.bytes.length).toBe(4)
	})

	it('keeps totalSize as the FULL size even when a range is requested', async () => {
		const bytes = Buffer.alloc(1000, 0x21)
		const real = await writeRaw('total.bin', bytes)

		const result = await readDiskFile(real, { range: { start: 100, end: 199 } })

		expect(result.bytes.length).toBe(100)
		expect(result.totalSize).toBe(1000)
	})

	it('throws when start is beyond totalSize', async () => {
		const bytes = Buffer.from('short', 'utf8')
		const real = await writeRaw('short.txt', bytes)

		await expect(
			readDiskFile(real, { range: { start: 999, end: 1000 } }),
		).rejects.toThrow()
	})

	it('throws when start is negative', async () => {
		const bytes = Buffer.alloc(32)
		const real = await writeRaw('neg.bin', bytes)

		await expect(
			readDiskFile(real, { range: { start: -1, end: 5 } }),
		).rejects.toThrow()
	})

	it('throws when start > end', async () => {
		const bytes = Buffer.alloc(32)
		const real = await writeRaw('reverse.bin', bytes)

		await expect(
			readDiskFile(real, { range: { start: 20, end: 5 } }),
		).rejects.toThrow()
	})
})

// -- MIME -------------------------------------------------------------------

describe('readDiskFile — MIME detection', () => {
	it('returns image/jpeg for a .jpg extension', async () => {
		const real = await writeRaw('photo.jpg', JPEG_MAGIC)
		const result = await readDiskFile(real)
		expect(result.mime).toBe('image/jpeg')
	})

	it('returns image/png for a .png extension', async () => {
		const real = await writeRaw('shot.png', PNG_MAGIC)
		const result = await readDiskFile(real)
		expect(result.mime).toBe('image/png')
	})

	it('returns text/plain for a .txt extension', async () => {
		const real = await writeRaw('readme.txt', Buffer.from('plain text', 'utf8'))
		const result = await readDiskFile(real)
		expect(result.mime).toBe('text/plain')
	})

	it('returns video/mp4 for a .mp4 extension', async () => {
		const real = await writeRaw('clip.mp4', MP4_MAGIC)
		const result = await readDiskFile(real)
		expect(result.mime).toBe('video/mp4')
	})

	it('returns image/png for a file with no extension but PNG magic bytes', async () => {
		// Stress the magic-byte sniffer: no extension to lean on, so the
		// implementation must inspect the leading bytes.
		const real = await writeRaw('mystery-' + rid(), Buffer.concat([PNG_MAGIC, Buffer.alloc(16)]))
		const result = await readDiskFile(real)
		expect(result.mime).toBe('image/png')
	})

	it('returns application/octet-stream for unknown extension AND unknown magic', async () => {
		const real = await writeRaw(
			'unknown-' + rid(),
			Buffer.from([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]),
		)
		const result = await readDiskFile(real)
		expect(result.mime).toBe('application/octet-stream')
	})

	it('prefers magic-byte sniffing over a lying extension (txt with JPEG magic → image/jpeg)', async () => {
		// Contract: magic wins. A `.txt` that is actually JPEG should report
		// image/jpeg so downstream consumers (Content-Type, <img> render)
		// don't trip over a misleading extension.
		const real = await writeRaw('lying.txt', JPEG_MAGIC)
		const result = await readDiskFile(real)
		expect(result.mime).toBe('image/jpeg')
	})
})

// -- ETag -------------------------------------------------------------------

describe('readDiskFile — ETag', () => {
	it('matches the W/"<mtime>-<size>" shape', async () => {
		const real = await writeRaw('etag-shape.bin', Buffer.alloc(7))
		const result = await readDiskFile(real)
		expect(result.etag).toMatch(ETAG_RE)
	})

	it('is stable across successive reads of an unchanged file', async () => {
		const real = await writeRaw('stable.bin', Buffer.alloc(42, 0x55))
		const a = await readDiskFile(real)
		const b = await readDiskFile(real)
		expect(a.etag).toBe(b.etag)
	})

	it('changes when the file mtime changes (same size, touched)', async () => {
		const real = await writeRaw('mtime.bin', Buffer.alloc(8, 0x01))
		const before = (await readDiskFile(real)).etag
		// Forge a future mtime so the second read can't accidentally share it
		// even on coarse-grained filesystems (e.g. HFS+ has 1s resolution).
		const future = new Date(Date.now() + 5000)
		await fs.utimes(real, future, future)
		const after = (await readDiskFile(real)).etag
		expect(after).not.toBe(before)
	})

	it('changes when the file size changes', async () => {
		const real = await writeRaw('size.bin', Buffer.alloc(10))
		const before = (await readDiskFile(real)).etag
		await fs.writeFile(real, Buffer.alloc(20))
		const after = (await readDiskFile(real)).etag
		expect(after).not.toBe(before)
	})
})

// -- writeDiskFile ----------------------------------------------------------

describe('writeDiskFile', () => {
	it('writes a Buffer to the sandbox and round-trips identical bytes', async () => {
		const bytes = Buffer.from('round-trip ' + rid(), 'utf8')
		const real = realOf('out.txt')

		await writeDiskFile(real, bytes)
		const onDisk = await fs.readFile(real)

		expect(onDisk.equals(bytes)).toBe(true)
	})

	it('creates missing parent directories recursively', async () => {
		const bytes = Buffer.from('nested', 'utf8')
		const real = realOf('a', 'b', 'c', 'leaf.txt')

		// Parent chain a/b/c must NOT exist beforehand.
		await expect(fs.stat(path.dirname(real))).rejects.toThrow()

		await writeDiskFile(real, bytes)

		const onDisk = await fs.readFile(real)
		expect(onDisk.equals(bytes)).toBe(true)
	})

	it('accepts ArrayBuffer input and stores the equivalent bytes', async () => {
		const u8 = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
		const real = realOf('ab.bin')

		await writeDiskFile(real, u8.buffer)

		const onDisk = await fs.readFile(real)
		expect(onDisk.equals(Buffer.from([0xde, 0xad, 0xbe, 0xef]))).toBe(true)
	})
})

// -- readDiskDir ------------------------------------------------------------

describe('readDiskDir', () => {
	it('returns [] for an empty directory', async () => {
		const dir = realOf('empty-dir')
		await fs.mkdir(dir, { recursive: true })

		const entries = await readDiskDir(dir)

		expect(entries).toEqual([])
	})

	it('returns three entries for a directory with two files and one subdir; no . or ..', async () => {
		const dir = realOf('mixed-dir')
		await fs.mkdir(dir, { recursive: true })
		await fs.writeFile(path.join(dir, 'a.txt'), 'a')
		await fs.writeFile(path.join(dir, 'b.txt'), 'b')
		await fs.mkdir(path.join(dir, 'sub'))

		const entries = await readDiskDir(dir)

		expect(entries.length).toBe(3)
		expect([...entries].sort()).toEqual(['a.txt', 'b.txt', 'sub'])
		expect(entries).not.toContain('.')
		expect(entries).not.toContain('..')
	})
})

// -- statDiskFile -----------------------------------------------------------

describe('statDiskFile', () => {
	it('reports isFile=true / isDirectory=false / correct size and a positive mtime for a regular file', async () => {
		const bytes = Buffer.alloc(123, 0x09)
		const real = await writeRaw('stat-file.bin', bytes)

		const st = await statDiskFile(real)

		expect(st.isFile).toBe(true)
		expect(st.isDirectory).toBe(false)
		expect(st.size).toBe(123)
		expect(typeof st.mtime).toBe('number')
		expect(st.mtime).toBeGreaterThan(0)
		expect(typeof st.mode).toBe('number')
	})

	it('reports isFile=false / isDirectory=true for a directory', async () => {
		const dir = realOf('stat-dir')
		await fs.mkdir(dir, { recursive: true })

		const st = await statDiskFile(dir)

		expect(st.isFile).toBe(false)
		expect(st.isDirectory).toBe(true)
	})
})
