/**
 * Main-process disk reader/writer backing `difile://_store/*` and
 * `difile://<usr-rel>` URLs.
 *
 * Spec: `packages/devtools/docs/file-system.md`.
 *
 *   - `readDiskFile(realPath, opts?)`: read a (possibly ranged) slice of a
 *     file inside the USER_DATA_PATH sandbox. Returns `bytes` plus the
 *     content metadata callers need to assemble an HTTP response without a
 *     second `fs.stat` round-trip (`mime`, `etag`, `totalSize`).
 *   - `writeDiskFile(realPath, bytes)`: write bytes into the sandbox,
 *     creating parent directories on demand. Accepts both `Buffer` and
 *     `ArrayBuffer`.
 *   - `readDiskDir(realPath)`: list immediate children, no '.' / '..'.
 *   - `statDiskFile(realPath)`: minimal stat surface (size/mtime/mode/flags).
 *
 * The caller is responsible for canonicalizing `realPath` through
 * `resolveVPath` *before* invoking these helpers — disk.ts assumes the
 * argument is already known to be inside the sandbox base.
 *
 * MIME resolution prefers magic-byte sniffing (first ~12 bytes) over file
 * extension, falling back to `application/octet-stream` for both unknown
 * extensions and unknown magic.
 *
 * ETag shape is `W/"<mtime-ms>-<size>"` — weak validator, both axes folded
 * into one token so byte-equal rewrites at the same timestamp still match.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

export interface DiskReadResult {
	bytes: Buffer
	mime: string
	/** Weak ETag of the form `W/"<mtime>-<size>"`. */
	etag: string
	/** Full file size in bytes, regardless of whether a Range slice was returned. */
	totalSize: number
}

export interface DiskReadOptions {
	/** Inclusive byte range `[start, end]`. Omit to read the whole file. */
	range?: { start: number; end: number }
}

export interface DiskStat {
	size: number
	/** Unix milliseconds. */
	mtime: number
	mode: number
	isFile: boolean
	isDirectory: boolean
}

// -- MIME detection ---------------------------------------------------------

/**
 * Extension-based MIME fallback. Kept deliberately small — anything more
 * exotic should land in the magic-byte sniffer above. Lowercase keys only.
 */
const EXT_MIME: Record<string, string> = {
	'.txt': 'text/plain',
	'.log': 'text/plain',
	'.md': 'text/markdown',
	'.html': 'text/html',
	'.htm': 'text/html',
	'.css': 'text/css',
	'.csv': 'text/csv',
	'.json': 'application/json',
	'.xml': 'application/xml',
	'.js': 'application/javascript',
	'.mjs': 'application/javascript',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.bmp': 'image/bmp',
	'.ico': 'image/x-icon',
	'.mp4': 'video/mp4',
	'.m4v': 'video/mp4',
	'.webm': 'video/webm',
	'.mov': 'video/quicktime',
	'.mp3': 'audio/mpeg',
	'.wav': 'audio/wav',
	'.ogg': 'audio/ogg',
	'.pdf': 'application/pdf',
	'.zip': 'application/zip',
}

function isPng(head: Buffer): boolean {
	return head.length >= 8
		&& head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
		&& head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a
}

function isJpeg(head: Buffer): boolean {
	return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
}

function isGif(head: Buffer): boolean {
	return head.length >= 6
		&& head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46
		&& head[3] === 0x38 && (head[4] === 0x37 || head[4] === 0x39) && head[5] === 0x61
}

function isWebp(head: Buffer): boolean {
	return head.length >= 12
		&& head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46
		&& head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50
}

/** MP4 ftyp box: brand bytes vary, treat all as video/mp4 for now. */
function isMp4(head: Buffer): boolean {
	return head.length >= 12
		&& head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70
}

function isPdf(head: Buffer): boolean {
	return head.length >= 4
		&& head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46
}

function isBmp(head: Buffer): boolean {
	return head.length >= 2 && head[0] === 0x42 && head[1] === 0x4d
}

function isZip(head: Buffer): boolean {
	return head.length >= 4
		&& head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04
}

/** ID3-tagged MP3. */
function isId3Mp3(head: Buffer): boolean {
	return head.length >= 3 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33
}

function isOgg(head: Buffer): boolean {
	return head.length >= 4 && head[0] === 0x4f && head[1] === 0x67 && head[2] === 0x67 && head[3] === 0x53
}

/** Magic-byte sniffers in priority order — first match wins. */
const MAGIC_SNIFFERS: ReadonlyArray<{ mime: string, match: (head: Buffer) => boolean }> = [
	{ mime: 'image/png', match: isPng },
	{ mime: 'image/jpeg', match: isJpeg },
	{ mime: 'image/gif', match: isGif },
	{ mime: 'image/webp', match: isWebp },
	{ mime: 'video/mp4', match: isMp4 },
	{ mime: 'application/pdf', match: isPdf },
	{ mime: 'image/bmp', match: isBmp },
	{ mime: 'application/zip', match: isZip },
	{ mime: 'audio/mpeg', match: isId3Mp3 },
	{ mime: 'audio/ogg', match: isOgg },
]

function sniffMime(head: Buffer): string | null {
	const hit = MAGIC_SNIFFERS.find((sniffer) => sniffer.match(head))
	return hit ? hit.mime : null
}

function extMime(realPath: string): string | null {
	const ext = path.extname(realPath).toLowerCase()
	if (!ext) return null
	return EXT_MIME[ext] ?? null
}

function detectMime(realPath: string, head: Buffer): string {
	const sniffed = sniffMime(head)
	if (sniffed) return sniffed
	const byExt = extMime(realPath)
	if (byExt) return byExt
	return 'application/octet-stream'
}

// -- ETag -------------------------------------------------------------------

function etagOf(mtimeMs: number, size: number): string {
	return `W/"${Math.floor(mtimeMs)}-${size}"`
}

// -- read -------------------------------------------------------------------

/** Validate `range` against `totalSize` and resolve it to a byte slice, or throws. */
function resolveRange(range: { start: number, end: number }, totalSize: number): { sliceStart: number, sliceLen: number } {
	const { start, end } = range
	if (!Number.isFinite(start) || !Number.isFinite(end)) {
		throw new RangeError(`invalid range: ${start}-${end}`)
	}
	if (start < 0) throw new RangeError(`range start out of bounds: ${start}`)
	if (start > end) throw new RangeError(`range start > end: ${start} > ${end}`)
	if (start >= totalSize) {
		throw new RangeError(`range start beyond file size: ${start} >= ${totalSize}`)
	}
	const clampedEnd = Math.min(end, totalSize - 1)
	return { sliceStart: start, sliceLen: clampedEnd - start + 1 }
}

/**
 * Read at most the first 12 bytes for magic sniffing, regardless of whether
 * the caller asked for a range. The head bytes from position 0 are needed to
 * label Content-Type correctly even on a tail Range request.
 */
async function readHeadBytes(handle: fs.FileHandle, totalSize: number): Promise<Buffer> {
	const head = Buffer.alloc(Math.min(12, totalSize))
	if (head.length > 0) {
		await handle.read(head, 0, head.length, 0)
	}
	return head
}

/** Full-file body, re-using `head` (already read) instead of a second read for the leading bytes. */
async function readFullBody(handle: fs.FileHandle, head: Buffer, totalSize: number): Promise<Buffer> {
	const bytes = Buffer.alloc(totalSize)
	if (totalSize === 0) return bytes
	if (totalSize <= head.length) {
		head.copy(bytes, 0, 0, totalSize)
		return bytes
	}
	head.copy(bytes, 0, 0, head.length)
	await handle.read(bytes, head.length, totalSize - head.length, head.length)
	return bytes
}

async function readRangeBody(handle: fs.FileHandle, sliceStart: number, sliceLen: number): Promise<Buffer> {
	const bytes = Buffer.alloc(sliceLen)
	if (sliceLen > 0) {
		await handle.read(bytes, 0, sliceLen, sliceStart)
	}
	return bytes
}

export async function readDiskFile(
	realPath: string,
	opts?: DiskReadOptions,
): Promise<DiskReadResult> {
	const handle = await fs.open(realPath, 'r')
	try {
		const st = await handle.stat()
		const totalSize = st.size
		const mtimeMs = st.mtimeMs

		const range = opts?.range
		const { sliceStart, sliceLen } = range
			? resolveRange(range, totalSize)
			: { sliceStart: 0, sliceLen: totalSize }

		const head = await readHeadBytes(handle, totalSize)
		const bytes = range
			? await readRangeBody(handle, sliceStart, sliceLen)
			: await readFullBody(handle, head, totalSize)

		return {
			bytes,
			mime: detectMime(realPath, head),
			etag: etagOf(mtimeMs, totalSize),
			totalSize,
		}
	}
	finally {
		await handle.close()
	}
}

// -- write ------------------------------------------------------------------

export async function writeDiskFile(
	realPath: string,
	bytes: Buffer | ArrayBuffer,
): Promise<void> {
	const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(new Uint8Array(bytes))
	await fs.mkdir(path.dirname(realPath), { recursive: true })
	await fs.writeFile(realPath, buf)
}

// -- dir --------------------------------------------------------------------

export async function readDiskDir(realPath: string): Promise<string[]> {
	const entries = await fs.readdir(realPath)
	return entries
}

// -- stat -------------------------------------------------------------------

export async function statDiskFile(realPath: string): Promise<DiskStat> {
	const st = await fs.stat(realPath)
	return {
		size: st.size,
		mtime: Math.floor(st.mtimeMs),
		mode: st.mode,
		isFile: st.isFile(),
		isDirectory: st.isDirectory(),
	}
}
