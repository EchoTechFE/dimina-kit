/**
 * Main-process `simulator:fs:*` IPC channel handlers.
 *
 * Spec: `packages/devtools/docs/file-system.md` §4.4, §6 P1-7.
 *
 * Each handler is the pure function that backs one IPC channel:
 *
 *   simulator:fs:read    → handleFsRead
 *   simulator:fs:write   → handleFsWrite
 *   simulator:fs:stat    → handleFsStat
 *   simulator:fs:readdir → handleFsReaddir
 *   simulator:fs:unlink  → handleFsUnlink
 *   simulator:fs:mkdir   → handleFsMkdir
 *
 * Every handler MUST defensively re-assert that `realPath` lies inside the
 * USER_DATA_PATH sandbox base (`DIMINA_HOME`-aware). The IPC boundary cannot
 * trust the caller — a hostile preload or fuzzed payload could send a path
 * that points outside the base. The renderer-side `resolveVPath` is one
 * layer; this is the second.
 *
 * MIME / ETag / Range semantics mirror `disk.ts`; see `disk.test.ts` for
 * the full contract on those axes.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { sandboxBase } from '../../../shared/vpath.js'
import {
	readDiskDir,
	readDiskFile,
	statDiskFile,
	writeDiskFile,
	type DiskStat,
} from './disk.js'

export interface FsReadRequest {
	realPath: string
	range?: { start: number; end: number }
}

export interface FsReadResult {
	bytes: Buffer | ArrayBuffer
	mime: string
	/** Weak ETag of the form `W/"<mtime>-<size>"`. */
	etag: string
	/** Full file size in bytes, regardless of whether a Range slice was returned. */
	totalSize: number
}

export interface FsWriteRequest {
	realPath: string
	bytes: Buffer | ArrayBuffer
}

export interface FsStatRequest {
	realPath: string
}

export interface FsReaddirRequest {
	realPath: string
}

export interface FsUnlinkRequest {
	realPath: string
}

export interface FsMkdirRequest {
	realPath: string
	recursive?: boolean
}

/**
 * Defense-in-depth: a hostile preload could synthesize a `realPath` that
 * resolveVPath would never produce. Re-canonicalize and re-anchor under the
 * sandbox base every time, throwing if the result escapes.
 *
 * Two-layer check:
 *  1. Lexical: `path.normalize` then `startsWith(base + sep)`.
 *  2. Filesystem: `fs.realpath` to follow symlinks and re-assert containment.
 *
 * The symlink check is best-effort — if the path does not yet exist (e.g. a
 * write/mkdir target), `fs.realpath` throws ENOENT and we fall back to
 * checking the deepest existing ancestor instead. A symlinked ancestor that
 * points outside the sandbox still gets caught that way.
 */
async function enforceSandbox(realPath: string): Promise<string> {
	if (typeof realPath !== 'string' || realPath.length === 0) {
		throw new Error('sandbox: realPath must be a non-empty string')
	}
	const base = sandboxBase()
	const baseReal = await fs.realpath(base).catch(() => base)
	const normalized = path.normalize(realPath)
	if (normalized !== base && !normalized.startsWith(base + path.sep)) {
		throw new Error('sandbox: realPath escapes the user-data base')
	}
	// Walk up until we find an existing path, realpath it, and assert the
	// resolved ancestor stays under the sandbox base. This catches symlinks
	// anywhere along the chain — both the leaf (read/stat) and the parent
	// (write/mkdir creating a new file under a symlinked dir).
	let probe = normalized
	while (probe !== path.parse(probe).root) {
		try {
			const resolved = await fs.realpath(probe)
			if (resolved !== baseReal && !resolved.startsWith(baseReal + path.sep)) {
				throw new Error('sandbox: realPath escapes the user-data base via symlink')
			}
			break
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				probe = path.dirname(probe)
				continue
			}
			throw err
		}
	}
	return normalized
}

export async function handleFsRead(req: FsReadRequest): Promise<FsReadResult> {
	const safe = await enforceSandbox(req.realPath)
	const result = await readDiskFile(safe, req.range ? { range: req.range } : undefined)
	return {
		bytes: result.bytes,
		mime: result.mime,
		etag: result.etag,
		totalSize: result.totalSize,
	}
}

export async function handleFsWrite(req: FsWriteRequest): Promise<{ ok: true }> {
	const safe = await enforceSandbox(req.realPath)
	await writeDiskFile(safe, req.bytes)
	return { ok: true }
}

export async function handleFsStat(req: FsStatRequest): Promise<DiskStat> {
	const safe = await enforceSandbox(req.realPath)
	return statDiskFile(safe)
}

export async function handleFsReaddir(req: FsReaddirRequest): Promise<string[]> {
	const safe = await enforceSandbox(req.realPath)
	return readDiskDir(safe)
}

export async function handleFsUnlink(req: FsUnlinkRequest): Promise<{ ok: true }> {
	const safe = await enforceSandbox(req.realPath)
	await fs.unlink(safe)
	return { ok: true }
}

export async function handleFsMkdir(req: FsMkdirRequest): Promise<{ ok: true }> {
	const safe = await enforceSandbox(req.realPath)
	await fs.mkdir(safe, { recursive: !!req.recursive })
	return { ok: true }
}
