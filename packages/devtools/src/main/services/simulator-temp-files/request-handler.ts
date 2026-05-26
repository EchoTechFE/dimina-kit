/**
 * Pure dispatcher for `difile://` URL requests.
 *
 * Spec: `packages/devtools/docs/file-system.md` §4.3.
 *
 * The shipping implementation in `index.ts` registers a thin
 * `simSession.protocol.handle('difile')` wrapper that delegates here; the race
 * waiter on `_tmp/*` lives in `index.ts` because it owns the IPC lifecycle.
 * For unit tests we assume the bytes are already in the store.
 *
 * Response shape:
 *   - 200: full body, with Content-Type, Cache-Control (immutable), ETag
 *   - 206: range slice, plus Content-Range
 *   - 304: empty body when `If-None-Match` matches the on-disk ETag. Per RFC
 *     9110 §13.1.2 If-None-Match wins over Range.
 *   - 404: anything `resolveVPath` rejects, plus disk-side ENOENT and any
 *     other I/O error. The protocol handler in `index.ts` translates this
 *     into the renderer's network failure surface; we deliberately do not
 *     leak errno strings.
 */

import { resolveVPath } from '../../../shared/vpath.js'
import { readDiskFile } from './disk.js'
import type { TempFileStore } from './resolver.js'

export interface HandleDifileContext {
	tempStore: TempFileStore
}

export interface HandleDifileRequest {
	url: string
	headers?: Record<string, string>
}

const CACHE_CONTROL = 'public, max-age=31536000, immutable'

function getHeader(headers: Record<string, string> | undefined, name: string): string | undefined {
	if (!headers) return undefined
	const lc = name.toLowerCase()
	for (const k of Object.keys(headers)) {
		if (k.toLowerCase() === lc) return headers[k]
	}
	return undefined
}

/**
 * Weak ETag comparison per RFC 9110 §8.8.3.2: strip the optional `W/` prefix
 * from each side before comparing. Both our generated ETags and conditional
 * headers may or may not include the weak prefix; the comparison must accept
 * `W/"abc"` and `"abc"` as equivalent.
 */
function etagsMatch(a: string | undefined, b: string): boolean {
	if (!a) return false
	const stripped = (s: string) => (s.startsWith('W/') ? s.slice(2) : s)
	return stripped(a.trim()) === stripped(b)
}

/**
 * Parse a `Range: bytes=<start>-<end>` header into an inclusive `{start,end}`.
 * Returns `null` if absent or malformed (callers should treat that as "no
 * range" — a full 200 response, not a 416). `totalSize` clamps the end.
 */
function parseRange(
	header: string | undefined,
	totalSize: number,
): { start: number; end: number } | null {
	if (!header) return null
	const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
	if (!m) return null
	const startStr = m[1]
	const endStr = m[2]
	if (startStr === '' && endStr === '') return null
	if (startStr === '') {
		// Suffix range: last N bytes.
		const n = Number(endStr)
		if (!Number.isFinite(n) || n <= 0) return null
		const start = Math.max(0, totalSize - n)
		return { start, end: totalSize - 1 }
	}
	const start = Number(startStr)
	if (!Number.isFinite(start) || start < 0) return null
	const end = endStr === '' ? totalSize - 1 : Number(endStr)
	if (!Number.isFinite(end)) return null
	return { start, end }
}

function notFound(): Response {
	return new Response(null, { status: 404 })
}

function notModified(etag: string): Response {
	return new Response(null, {
		status: 304,
		headers: {
			ETag: etag,
			'Cache-Control': CACHE_CONTROL,
			'Access-Control-Allow-Origin': '*',
		},
	})
}

function bufferToBody(bytes: Buffer): ArrayBuffer {
	// Copy into a fresh ArrayBuffer so the result is definitely typed as
	// `ArrayBuffer` (not `ArrayBufferLike` / `SharedArrayBuffer`) and is
	// safe to hand to Response without aliasing the Node Buffer pool.
	const out = new ArrayBuffer(bytes.byteLength)
	new Uint8Array(out).set(bytes)
	return out
}

function tempBody(
	bytes: Buffer,
	mime: string,
): Response {
	return new Response(bufferToBody(bytes), {
		status: 200,
		headers: {
			'Content-Type': mime,
			'Cache-Control': CACHE_CONTROL,
			'Access-Control-Allow-Origin': '*',
		},
	})
}

export async function handleDifileRequest(
	ctx: HandleDifileContext,
	req: HandleDifileRequest,
): Promise<Response> {
	const v = resolveVPath(req.url)
	if (!v) return notFound()

	if (v.kind === 'tmp') {
		const record = ctx.tempStore.get(req.url)
		if (!record) return notFound()
		return tempBody(record.bytes, record.mime || 'application/octet-stream')
	}

	if (!v.realPath) return notFound()

	// Disk-backed: _store or usr.
	try {
		// Probe first to learn the ETag/size so If-None-Match can short-circuit
		// without reading the body. The probe also doubles as our existence /
		// permission check, so anything that throws here (ENOENT, EACCES, ...)
		// surfaces as a 404.
		const probe = await readDiskFile(v.realPath)
		const etag = probe.etag
		const totalSize = probe.totalSize
		const mime = probe.mime

		const ifNoneMatch = getHeader(req.headers, 'If-None-Match')
		if (etagsMatch(ifNoneMatch, etag)) {
			return notModified(etag)
		}

		const rangeHeader = getHeader(req.headers, 'Range')
		const range = parseRange(rangeHeader, totalSize)

		if (range) {
			// Range out of bounds → 416 (Range Not Satisfiable) per RFC 9110 §15.4.
			// Distinct from 404 so callers can tell "wrong file" from "wrong slice".
			if (range.start < 0 || range.start >= totalSize || range.end < range.start) {
				return new Response(null, {
					status: 416,
					headers: {
						'Content-Range': `bytes */${totalSize}`,
						'Access-Control-Allow-Origin': '*',
					},
				})
			}
			const clampedEnd = Math.min(range.end, totalSize - 1)
			const sliced = await readDiskFile(v.realPath, { range: { start: range.start, end: clampedEnd } })
			const { bytes } = sliced
			const lastByte = range.start + bytes.length - 1
			return new Response(bufferToBody(bytes), {
				status: 206,
				headers: {
					'Content-Type': mime,
					'Content-Length': String(bytes.length),
					'Content-Range': `bytes ${range.start}-${lastByte}/${totalSize}`,
					'Cache-Control': CACHE_CONTROL,
					ETag: etag,
					'Access-Control-Allow-Origin': '*',
				},
			})
		}

		return new Response(bufferToBody(probe.bytes), {
			status: 200,
			headers: {
				'Content-Type': mime,
				'Cache-Control': CACHE_CONTROL,
				ETag: etag,
				'Access-Control-Allow-Origin': '*',
			},
		})
	}
	catch {
		return notFound()
	}
}
