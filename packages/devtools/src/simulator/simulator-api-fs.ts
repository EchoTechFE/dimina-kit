/**
 * DevTools API stubs for filesystem wx.xxx APIs
 * (container-side handlers for service-apis/file).
 *
 * Each exported function is bound with `this` = MiniApp instance
 * (via AppManager.registerApi → MiniApp.invokeApi).
 *
 * Contract (see `docs/file-system.md`):
 *   - Every entry point routes its caller-supplied path through `resolveVPath`
 *     (single resolver), which rejects non-`difile://` schemes, absolute
 *     filesystem paths, and any `..` traversal.
 *   - Write-class APIs (writeFile / appendFile / unlink / mkdir / rmdir /
 *     truncate / rename(dest) / copyFile(dest)) refuse `difile://_tmp/*` and
 *     `difile://_store/*` with `permission denied` — those namespaces are
 *     runtime-owned and read-only, matching wx 真机 semantics.
 *   - `fsSaveFile` returns a `difile://_store/{uuid}.{ext}` vpath, never a
 *     real disk path.
 */

import type { MiniAppContext } from './types'
import { bindCallbacks } from './simulator-api-helpers'
import { getNodeBindings } from '../shared/node-bindings.js'
import { resolveVPath, sandboxBase, type ResolvedVPath } from '../shared/vpath.js'
import { resolveTempFilePath } from './temp-files'

/**
 * Dispatch helper: pull a `_tmp/*` Blob out of the renderer Map and hand back
 * its bytes. Throws an ENOENT-shaped Error if the URL is unknown, so callers
 * can surface a `fail` with a real not-found message.
 */
async function _tmpBytes(url: string): Promise<Buffer> {
	try {
		const blob = await resolveTempFilePath(url)
		return await blobToBuffer(blob)
	}
	catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		throw new Error(`ENOENT: no such file (${url}): ${msg}`, { cause: err })
	}
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
	return Object.prototype.toString.call(value) === '[object ArrayBuffer]'
}

/**
 * `Buffer` for Blob materialization: the simulator document has no global
 * `Buffer` (nodeIntegration is off and the vite bundle does not polyfill
 * it), so take the constructor from the preload-published node bindings;
 * vitest/node contexts have the global.
 */
const BufferImpl: typeof Buffer | undefined =
	getNodeBindings().buffer?.Buffer ?? (typeof Buffer !== 'undefined' ? Buffer : undefined)

async function blobToBuffer(blob: Blob): Promise<Buffer> {
	if (!BufferImpl) {
		throw new Error('Buffer binding unavailable')
	}
	const readable = blob as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> }
	if (typeof readable.arrayBuffer === 'function') {
		const ab = await readable.arrayBuffer()
		return BufferImpl.from(new Uint8Array(ab))
	}

	if (typeof FileReader !== 'function') {
		throw new Error('Blob cannot be read as ArrayBuffer')
	}

	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		reader.onerror = () => reject(reader.error ?? new Error('Blob read failed'))
		reader.onload = () => {
			const result = reader.result
			if (!isArrayBuffer(result)) {
				reject(new Error('Blob read did not return an ArrayBuffer'))
				return
			}
			resolve(BufferImpl.from(new Uint8Array(result)))
		}
		reader.readAsArrayBuffer(blob)
	})
}

/**
 * Real Node built-ins: the preload-published bindings in the simulator
 * document (nodeIntegration is off there and the vite bundle stubs `node:*`
 * imports), `require` under vitest/node. Each candidate is validated by
 * probing a required member function — the vite stubs are truthy objects, so
 * truthiness alone would wave a dead module through and the guard below
 * (`guardFsAvailable`) would then let calls crash mid-handler.
 */
function resolveNodeModule<T>(fromBindings: T | undefined, name: string, probe: (mod: T) => boolean): T {
	if (fromBindings && probe(fromBindings)) return fromBindings
	if (typeof require !== 'undefined') {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const mod = require(name) as T
		if (mod && probe(mod)) return mod
	}
	return null as unknown as T
}

const _fs = resolveNodeModule(getNodeBindings().fs, 'fs', m => typeof m.readFile === 'function')
const _path = resolveNodeModule(getNodeBindings().path, 'path', m => typeof m.join === 'function')
const _crypto = resolveNodeModule(getNodeBindings().crypto, 'crypto', m => typeof m.createHash === 'function')

type FsCallbacks = ReturnType<typeof bindCallbacks>
type NodeStats = import('fs').Stats
type NodeErr = NodeJS.ErrnoException | Error | null

// ─── shared fs-API scaffolding ────────────────────────────────────────────
//
// Every handler below shares the same skeleton: bail if Node `fs` isn't
// available, resolve the caller path through the single vpath resolver
// (bailing on invalid/unsafe paths), optionally reject read-only
// namespaces for write-class APIs, then run a Node fs call and translate its
// `(err, ...)` callback into the wx success/fail/complete triad. The helpers
// below are the single authority for each of those steps so per-API bodies
// only contain what differs between APIs (the real fs call and any extra
// success payload fields).

/** Bails with `${apiName}:fail not available in browser context` when the Node `fs` binding is absent (e.g. a browser-only build). */
function guardFsAvailable(apiName: string, cbs: FsCallbacks): boolean {
	if (_fs) return false
	cbs.onFail?.({ errMsg: `${apiName}:fail not available in browser context` })
	cbs.onComplete?.()
	return true
}

/**
 * True when any path component from the sandbox base down to `realPath` is a
 * symlink. `resolveVPath` validates the requested STRING (no `..`, stays
 * under the base after normalize) but never inspects the disk — a symlink
 * planted inside `usr/` would otherwise let Node's default follow-symlinks
 * behavior read or write through to a target outside the sandbox. `lstat`
 * (not `stat`/`exists`) sees the link itself, so dangling links — which
 * `fs.writeFile` would still follow to CREATE the outside target — are
 * caught too. The base itself may legitimately be a symlink (macOS tmpdir);
 * only components below it are checked.
 */
function containsSymlink(realPath: string): boolean {
	const rel = _path.relative(sandboxBase(), realPath)
	if (!rel || rel.startsWith('..')) return false
	let cur = sandboxBase()
	for (const seg of rel.split(_path.sep)) {
		cur = _path.join(cur, seg)
		let entry: import('fs').Stats
		try {
			entry = _fs.lstatSync(cur)
		} catch {
			// Nothing on disk from here down — nothing left to follow.
			return false
		}
		if (entry.isSymbolicLink()) return true
	}
	return false
}

/**
 * Resolves `p` via `resolveVPath` and asserts the resolved disk path does not
 * pass through a sandbox-internal symlink, or reports `${apiName}:fail
 * invalid or unsafe path` and runs `complete`.
 */
function resolveOrBail(p: unknown, apiName: string, cbs: FsCallbacks): ResolvedVPath | undefined {
	const v = resolveVPath(p)
	if (v && (!v.realPath || !_fs || !containsSymlink(v.realPath))) return v
	cbs.onFail?.({ errMsg: `${apiName}:fail invalid or unsafe path` })
	cbs.onComplete?.()
	return undefined
}

/**
 * wx `Stats` payload: numeric mode bits, byte size, SECOND-unit epoch
 * timestamps — wx and the dimina native clients all report seconds, while
 * Node's `atimeMs`/`mtimeMs` are milliseconds.
 */
function toWxStats(s: NodeStats): Record<string, unknown> {
	return {
		size: s.size,
		mode: s.mode,
		lastAccessedTime: Math.floor(s.atimeMs / 1000),
		lastModifiedTime: Math.floor(s.mtimeMs / 1000),
		isFile: s.isFile(),
		isDirectory: s.isDirectory(),
	}
}

/**
 * Type-guards `v` as writable (narrows `realPath` to `string`), or reports
 * `${apiName}:fail permission denied` and runs `complete`. `_tmp` / `_store`
 * are runtime-owned and read-only, matching wx 真机 semantics.
 */
function ensureWritable(v: ResolvedVPath, apiName: string, cbs: FsCallbacks): v is ResolvedVPath & { realPath: string } {
	if (v.writable && v.realPath) return true
	cbs.onFail?.({ errMsg: `${apiName}:fail permission denied` })
	cbs.onComplete?.()
	return false
}

/** Fail handler for a `_tmpBytes(...).then(success, ...)` chain: reports `${apiName}:fail <message>` and runs `complete`. */
function tmpFailHandler(apiName: string, cbs: FsCallbacks) {
	return (err: Error) => {
		cbs.onFail?.({ errMsg: `${apiName}:fail ${err.message}` })
		cbs.onComplete?.()
	}
}

/**
 * Builds a Node-style `(err, ...args)` callback that translates into the wx
 * success/fail/complete triad: `err` truthy → fail with `${apiName}:fail
 * <message>`; otherwise success with `${apiName}:ok` plus whatever
 * `buildOk(...args)` contributes.
 */
function nodeComplete<TArgs extends unknown[] = []>(
	apiName: string,
	cbs: FsCallbacks,
	buildOk?: (...args: TArgs) => Record<string, unknown> | undefined,
) {
	return (err: NodeErr, ...args: TArgs) => {
		if (err) {
			cbs.onFail?.({ errMsg: `${apiName}:fail ${err.message}` })
		} else {
			cbs.onSuccess?.({ ...(buildOk ? buildOk(...args) : undefined), errMsg: `${apiName}:ok` })
		}
		cbs.onComplete?.()
	}
}

/**
 * `mkdir -p` the parent of `destReal`, then run `writeFn` (a `writeFile` /
 * `copyFile` call) through `nodeComplete`. Shared by every API that
 * materializes bytes onto disk under a possibly-not-yet-existing directory
 * (fsWriteFile, fsCopyFile's `_tmp` branch, fsSaveFile).
 */
function mkdirpThenWrite(
	destReal: string,
	apiName: string,
	cbs: FsCallbacks,
	writeFn: (done: (err: NodeErr) => void) => void,
	okExtra?: Record<string, unknown>,
): void {
	_fs.mkdir(_path.dirname(destReal), { recursive: true }, (mkdirErr) => {
		if (mkdirErr) {
			cbs.onFail?.({ errMsg: `${apiName}:fail ${mkdirErr.message}` })
			cbs.onComplete?.()
			return
		}
		// fs.writeFile/copyFile validate their arguments synchronously (a
		// numeric `data`, an unknown `encoding`); this callback runs after the
		// wire handler's own try/catch has already returned, so an unguarded
		// throw here would leave the call with no verdict at all.
		try {
			writeFn(nodeComplete(apiName, cbs, () => okExtra))
		} catch (err) {
			cbs.onFail?.({ errMsg: `${apiName}:fail ${err instanceof Error ? err.message : String(err)}` })
			cbs.onComplete?.()
		}
	})
}

export function fsAccess(
	this: MiniAppContext,
	{ path, success, fail, complete }: { path: string; success?: unknown; fail?: unknown; complete?: unknown },
) {
	const cbs = bindCallbacks(this, { success, fail, complete })
	const { onSuccess, onFail, onComplete } = cbs
	if (guardFsAvailable('fsAccess', cbs)) return
	const v = resolveOrBail(path, 'fsAccess', cbs)
	if (!v) return
	if (v.kind === 'tmp') {
		// _tmp existence check: renderer Map hit ⇒ ok; miss ⇒ ENOENT-shaped fail.
		_tmpBytes(path).then(
			() => { onSuccess?.({ errMsg: 'fsAccess:ok' }); onComplete?.() },
			tmpFailHandler('fsAccess', cbs),
		)
		return
	}
	if (!v.realPath) {
		onFail?.({ errMsg: 'fsAccess:fail invalid path' })
		onComplete?.()
		return
	}
	_fs.access(v.realPath, _fs.constants.F_OK, nodeComplete('fsAccess', cbs))
}

export function fsStat(
	this: MiniAppContext,
	{ path, recursive = false, success, fail, complete }: {
		path: string
		recursive?: boolean
		success?: unknown
		fail?: unknown
		complete?: unknown
	},
) {
	const cbs = bindCallbacks(this, { success, fail, complete })
	const { onSuccess, onFail, onComplete } = cbs
	if (guardFsAvailable('fsStat', cbs)) return
	const v = resolveOrBail(path, 'fsStat', cbs)
	if (!v) return
	if (v.kind === 'tmp') {
		// _tmp size is known from the Blob; mtime is 0 (no on-disk timestamp).
		_tmpBytes(path).then(
			(buf) => {
				onSuccess?.({
					stats: {
						size: buf.length,
						mode: 0,
						lastAccessedTime: 0,
						lastModifiedTime: 0,
						isFile: true,
						isDirectory: false,
					},
					errMsg: 'fsStat:ok',
				})
				onComplete?.()
			},
			tmpFailHandler('fsStat', cbs),
		)
		return
	}
	if (!v.realPath) {
		onFail?.({ errMsg: 'fsStat:fail invalid path' })
		onComplete?.()
		return
	}
	const resolved = v.realPath
	if (recursive) {
		// Map of RELATIVE path → stats for the tree, keyed the way wx and the
		// dimina native clients key it: the queried directory itself as "."
		// plus `relative(root, entry)`-style descendants — never a host
		// absolute path (that would leak the sandbox location to mini-program
		// code). Any readdir/stat error fails the whole call: silently
		// dropping a failed entry would present an incomplete tree as ok.
		const statsMap: Record<string, unknown> = {}
		let settled = false
		const failOnce = (err: Error) => {
			if (settled) return
			settled = true
			onFail?.({ errMsg: `fsStat:fail ${err.message}` })
			onComplete?.()
		}
		const okOnce = () => {
			if (settled) return
			settled = true
			onSuccess?.({ stats: statsMap, errMsg: 'fsStat:ok' })
			onComplete?.()
		}
		const relKey = (full: string): string => {
			const rel = _path.relative(resolved, full)
			return rel === '' ? '.' : rel.split(_path.sep).join('/')
		}
		// `lstat`, never `stat`: `resolveOrBail`'s symlink fence only inspects
		// the REQUESTED root path — a symlink discovered mid-walk would
		// otherwise be followed (leaking sandbox-external metadata into the
		// map) while its Dirent still reads as a non-directory (leaving a
		// truncated tree). A symlink anywhere in the walk fails the whole
		// call; the recursion decision uses the same lstat result.
		const statInto = (full: string, cb: (err: Error | null, isDirectory?: boolean) => void) => {
			_fs.lstat(full, (err, s) => {
				if (err) { cb(err); return }
				if (s.isSymbolicLink()) {
					cb(new Error('invalid or unsafe path'))
					return
				}
				statsMap[relKey(full)] = toWxStats(s)
				cb(null, s.isDirectory())
			})
		}
		const walkDir = (dir: string, cb: (err: Error | null) => void) => {
			_fs.readdir(dir, { withFileTypes: true }, (err, entries) => {
				if (err) { cb(err); return }
				let pending = entries.length
				if (pending === 0) { cb(null); return }
				let erred = false
				const done = (e: Error | null) => {
					if (erred) return
					if (e) { erred = true; cb(e); return }
					if (--pending === 0) cb(null)
				}
				for (const entry of entries) {
					const full = _path.join(dir, entry.name)
					statInto(full, (statErr, isDirectory) => {
						if (statErr) { done(statErr); return }
						if (isDirectory) walkDir(full, done)
						else done(null)
					})
				}
			})
		}
		statInto(resolved, (rootErr) => {
			if (rootErr) { failOnce(rootErr); return }
			walkDir(resolved, (err) => {
				if (err) failOnce(err)
				else okOnce()
			})
		})
	} else {
		_fs.stat(resolved, nodeComplete('fsStat', cbs, (s: NodeStats) => ({
			stats: toWxStats(s),
		})))
	}
}

export function fsReadFile(
	this: MiniAppContext,
	{ filePath, encoding, success, fail, complete }: {
		filePath: string
		encoding?: BufferEncoding
		success?: unknown
		fail?: unknown
		complete?: unknown
	},
) {
	const cbs = bindCallbacks(this, { success, fail, complete })
	const { onSuccess, onFail, onComplete } = cbs
	if (guardFsAvailable('fsReadFile', cbs)) return
	const v = resolveOrBail(filePath, 'fsReadFile', cbs)
	if (!v) return
	if (v.kind === 'tmp') {
		_tmpBytes(filePath).then(
			(buf) => {
				const data: Buffer | string = encoding ? buf.toString(encoding) : buf
				onSuccess?.({ data, errMsg: 'fsReadFile:ok' })
				onComplete?.()
			},
			tmpFailHandler('fsReadFile', cbs),
		)
		return
	}
	if (!v.realPath) {
		onFail?.({ errMsg: 'fsReadFile:fail invalid path' })
		onComplete?.()
		return
	}
	_fs.readFile(v.realPath, encoding || null, nodeComplete('fsReadFile', cbs, (data: Buffer | string) => ({ data })))
}

export function fsWriteFile(
	this: MiniAppContext,
	{ filePath, data, encoding = 'utf8', success, fail, complete }: {
		filePath: string
		data: string | Uint8Array
		encoding?: BufferEncoding
		success?: unknown
		fail?: unknown
		complete?: unknown
	},
) {
	const cbs = bindCallbacks(this, { success, fail, complete })
	if (guardFsAvailable('fsWriteFile', cbs)) return
	const v = resolveOrBail(filePath, 'fsWriteFile', cbs)
	if (!v) return
	if (!ensureWritable(v, 'fsWriteFile', cbs)) return
	mkdirpThenWrite(v.realPath, 'fsWriteFile', cbs, done => _fs.writeFile(v.realPath, data as string, { encoding }, done))
}

export function fsAppendFile(
	this: MiniAppContext,
	{ filePath, data, encoding = 'utf8', success, fail, complete }: {
		filePath: string
		data: string | Uint8Array
		encoding?: BufferEncoding
		success?: unknown
		fail?: unknown
		complete?: unknown
	},
) {
	const cbs = bindCallbacks(this, { success, fail, complete })
	if (guardFsAvailable('fsAppendFile', cbs)) return
	const v = resolveOrBail(filePath, 'fsAppendFile', cbs)
	if (!v) return
	if (!ensureWritable(v, 'fsAppendFile', cbs)) return
	_fs.appendFile(v.realPath, data as string, { encoding }, nodeComplete('fsAppendFile', cbs))
}

export function fsCopyFile(
	this: MiniAppContext,
	{ srcPath, destPath, success, fail, complete }: {
		srcPath: string
		destPath: string
		success?: unknown
		fail?: unknown
		complete?: unknown
	},
) {
	const cbs = bindCallbacks(this, { success, fail, complete })
	const { onFail, onComplete } = cbs
	if (guardFsAvailable('fsCopyFile', cbs)) return
	const vSrc = resolveOrBail(srcPath, 'fsCopyFile', cbs)
	if (!vSrc) return
	const vDest = resolveOrBail(destPath, 'fsCopyFile', cbs)
	if (!vDest) return
	if (!ensureWritable(vDest, 'fsCopyFile', cbs)) return
	if (vSrc.kind === 'tmp') {
		// Materialize the renderer Blob into the user-data
		// area. The dest writable check above already rejected _tmp / _store
		// destinations — saveFile is the documented route for tmp→store.
		_tmpBytes(srcPath).then(
			buf => mkdirpThenWrite(vDest.realPath, 'fsCopyFile', cbs, done => _fs.writeFile(vDest.realPath, buf, done)),
			tmpFailHandler('fsCopyFile', cbs),
		)
		return
	}
	if (!vSrc.realPath) {
		onFail?.({ errMsg: 'fsCopyFile:fail invalid src path' })
		onComplete?.()
		return
	}
	_fs.copyFile(vSrc.realPath, vDest.realPath, nodeComplete('fsCopyFile', cbs))
}

export function fsRename(
	this: MiniAppContext,
	{ oldPath, newPath, success, fail, complete }: {
		oldPath: string
		newPath: string
		success?: unknown
		fail?: unknown
		complete?: unknown
	},
) {
	const cbs = bindCallbacks(this, { success, fail, complete })
	if (guardFsAvailable('fsRename', cbs)) return
	const vOld = resolveOrBail(oldPath, 'fsRename', cbs)
	if (!vOld) return
	const vNew = resolveOrBail(newPath, 'fsRename', cbs)
	if (!vNew) return
	// Rename deletes the source — both sides must be writable. _tmp / _store
	// reject under either role.
	if (!ensureWritable(vOld, 'fsRename', cbs)) return
	if (!ensureWritable(vNew, 'fsRename', cbs)) return
	_fs.rename(vOld.realPath, vNew.realPath, nodeComplete('fsRename', cbs))
}

export function fsUnlink(
	this: MiniAppContext,
	{ filePath, success, fail, complete }: { filePath: string; success?: unknown; fail?: unknown; complete?: unknown },
) {
	const cbs = bindCallbacks(this, { success, fail, complete })
	if (guardFsAvailable('fsUnlink', cbs)) return
	const v = resolveOrBail(filePath, 'fsUnlink', cbs)
	if (!v) return
	if (!ensureWritable(v, 'fsUnlink', cbs)) return
	_fs.unlink(v.realPath, nodeComplete('fsUnlink', cbs))
}

export function fsMkdir(
	this: MiniAppContext,
	{ dirPath, recursive = false, success, fail, complete }: {
		dirPath: string
		recursive?: boolean
		success?: unknown
		fail?: unknown
		complete?: unknown
	},
) {
	const cbs = bindCallbacks(this, { success, fail, complete })
	if (guardFsAvailable('fsMkdir', cbs)) return
	const v = resolveOrBail(dirPath, 'fsMkdir', cbs)
	if (!v) return
	if (!ensureWritable(v, 'fsMkdir', cbs)) return
	_fs.mkdir(v.realPath, { recursive }, nodeComplete('fsMkdir', cbs))
}

export function fsRmdir(
	this: MiniAppContext,
	{ dirPath, recursive = false, success, fail, complete }: {
		dirPath: string
		recursive?: boolean
		success?: unknown
		fail?: unknown
		complete?: unknown
	},
) {
	const cbs = bindCallbacks(this, { success, fail, complete })
	if (guardFsAvailable('fsRmdir', cbs)) return
	const v = resolveOrBail(dirPath, 'fsRmdir', cbs)
	if (!v) return
	if (!ensureWritable(v, 'fsRmdir', cbs)) return
	// The two cases need different Node primitives: `fs.rm` without
	// `recursive` refuses directories outright (ERR_FS_EISDIR) even when
	// empty, while wx's non-recursive rmdir removes an empty directory and
	// fails only on a non-empty one — exactly `fs.rmdir`'s contract.
	if (recursive) {
		const rmFn = (_fs as typeof _fs & { rm?: typeof _fs.rmdir }).rm ?? _fs.rmdir
		rmFn(v.realPath, { recursive: true } as Parameters<typeof _fs.rmdir>[1], nodeComplete('fsRmdir', cbs))
	} else {
		_fs.rmdir(v.realPath, nodeComplete('fsRmdir', cbs))
	}
}

export function fsReaddir(
	this: MiniAppContext,
	{ dirPath, success, fail, complete }: { dirPath: string; success?: unknown; fail?: unknown; complete?: unknown },
) {
	const cbs = bindCallbacks(this, { success, fail, complete })
	const { onFail, onComplete } = cbs
	if (guardFsAvailable('fsReaddir', cbs)) return
	const v = resolveOrBail(dirPath, 'fsReaddir', cbs)
	if (!v) return
	// _tmp and _store are flat (id-addressed) namespaces — readdir is meaningless.
	if (v.kind === 'tmp' || v.kind === 'store') {
		onFail?.({ errMsg: `fsReaddir:fail ${v.kind} is a flat namespace (no dir tree)` })
		onComplete?.()
		return
	}
	if (!v.realPath) {
		onFail?.({ errMsg: 'fsReaddir:fail invalid path' })
		onComplete?.()
		return
	}
	_fs.readdir(v.realPath, nodeComplete('fsReaddir', cbs, (files: string[]) => ({ files })))
}

export function fsGetFileInfo(
	this: MiniAppContext,
	{ filePath, digestAlgorithm, success, fail, complete }: {
		filePath: string
		digestAlgorithm?: string
		success?: unknown
		fail?: unknown
		complete?: unknown
	},
) {
	const cbs = bindCallbacks(this, { success, fail, complete })
	const { onSuccess, onFail, onComplete } = cbs
	if (guardFsAvailable('fsGetFileInfo', cbs)) return
	const v = resolveOrBail(filePath, 'fsGetFileInfo', cbs)
	if (!v) return
	// wx and every dimina native client default digestAlgorithm to md5 and
	// always include the digest — a missing digest is a fail, not a silently
	// smaller success payload.
	const algorithm = digestAlgorithm === 'sha1' ? 'sha1' : 'md5'
	if (v.kind === 'tmp') {
		_tmpBytes(filePath).then(
			(buf) => {
				try {
					const hash = _crypto.createHash(algorithm)
					hash.update(buf)
					onSuccess?.({ size: buf.length, digest: hash.digest('hex'), errMsg: 'fsGetFileInfo:ok' })
					onComplete?.()
				} catch (hashErr) {
					onFail?.({ errMsg: `fsGetFileInfo:fail ${(hashErr as Error).message}` })
					onComplete?.()
				}
			},
			tmpFailHandler('fsGetFileInfo', cbs),
		)
		return
	}
	if (!v.realPath) {
		onFail?.({ errMsg: 'fsGetFileInfo:fail invalid path' })
		onComplete?.()
		return
	}
	const resolved = v.realPath
	_fs.stat(resolved, (err, s) => {
		if (err) {
			onFail?.({ errMsg: `fsGetFileInfo:fail ${err.message}` })
			onComplete?.()
			return
		}
		try {
			const hash = _crypto.createHash(algorithm)
			const stream = _fs.createReadStream(resolved)
			stream.on('data', (chunk) => hash.update(chunk as Buffer))
			stream.on('end', () => {
				onSuccess?.({ size: s.size, digest: hash.digest('hex'), errMsg: 'fsGetFileInfo:ok' })
				onComplete?.()
			})
			stream.on('error', (hashErr) => {
				onFail?.({ errMsg: `fsGetFileInfo:fail ${hashErr.message}` })
				onComplete?.()
			})
		} catch (hashErr) {
			onFail?.({ errMsg: `fsGetFileInfo:fail ${(hashErr as Error).message}` })
			onComplete?.()
		}
	})
}

/**
 * Save a temp file into the read-only `_store/` namespace. Returns a vpath
 * (`difile://_store/{uuid}.{ext}`) rather than a real disk path so callers
 * cannot leak the host filesystem layout.
 *
 * Scope:
 *   - source must be a `difile://`-anchored vpath (validator rejects abs paths);
 *   - source from `_tmp/` materializes the renderer Blob into `_store/` via the
 *     renderer-Blob → main-fs copy bridge;
 *   - source from `_store/` or the user-data area is copied byte-for-byte to a
 *     freshly minted `_store/{uuid}.{ext}` entry under the sandbox base.
 */
/**
 * Resolves the saveFile destination. wx contract: an explicit `filePath`
 * names the exact destination and is echoed back as `savedFilePath` — it
 * goes through the same validator + writable gate as every other
 * write-class destination, so runtime-owned `_tmp/` / `_store/` targets
 * fail with permission denied. Only when `filePath` is omitted is a fresh
 * `_store/{uuid}` vpath minted. Reports fail + complete and returns
 * undefined when the destination is invalid.
 */
function resolveSaveFileDestination(
	tempFilePath: string,
	filePath: string | undefined,
	cbs: FsCallbacks,
): { savedFilePath: string; destReal: string } | undefined {
	if (typeof filePath === 'string' && filePath) {
		const dest = resolveOrBail(filePath, 'fsSaveFile', cbs)
		if (!dest) return undefined
		if (!ensureWritable(dest, 'fsSaveFile', cbs)) return undefined
		return { savedFilePath: filePath, destReal: dest.realPath }
	}
	const ext = _path.extname(tempFilePath) || ''
	const id = _crypto.randomUUID() + ext
	const savedFilePath = `difile://_store/${id}`
	const destResolved = resolveVPath(savedFilePath)
	if (!destResolved || !destResolved.realPath) {
		// Defensive: a freshly minted vpath must always resolve.
		cbs.onFail?.({ errMsg: 'fsSaveFile:fail unable to allocate destination' })
		cbs.onComplete?.()
		return undefined
	}
	if (containsSymlink(destResolved.realPath)) {
		cbs.onFail?.({ errMsg: 'fsSaveFile:fail invalid or unsafe path' })
		cbs.onComplete?.()
		return undefined
	}
	return { savedFilePath, destReal: destResolved.realPath }
}

export function fsSaveFile(
	this: MiniAppContext,
	{ tempFilePath, filePath, success, fail, complete }: {
		tempFilePath: string
		filePath?: string
		success?: unknown
		fail?: unknown
		complete?: unknown
	},
) {
	const cbs = bindCallbacks(this, { success, fail, complete })
	const { onFail, onComplete } = cbs
	if (guardFsAvailable('fsSaveFile', cbs)) return
	const src = resolveOrBail(tempFilePath, 'fsSaveFile', cbs)
	if (!src) return

	const destination = resolveSaveFileDestination(tempFilePath, filePath, cbs)
	if (!destination) return
	const { savedFilePath, destReal } = destination

	if (src.kind === 'tmp') {
		// Materialize the renderer Blob into _store on disk.
		_tmpBytes(tempFilePath).then(
			bytes => mkdirpThenWrite(destReal, 'fsSaveFile', cbs, done => _fs.writeFile(destReal, bytes, done), { savedFilePath }),
			tmpFailHandler('fsSaveFile', cbs),
		)
		return
	}
	if (!src.realPath) {
		onFail?.({ errMsg: 'fsSaveFile:fail invalid src path' })
		onComplete?.()
		return
	}
	if (src.realPath === destReal) {
		// Source and destination normalize to the same file: saving a file
		// onto itself is a defined no-op success, not whatever the host
		// Node's same-file copyFile happens to do. Still a no-op only for a
		// real file — resolveOrBail validates the path string, not the disk,
		// so a missing or directory source must fail here like any other save.
		_fs.stat(src.realPath, (statErr, st) => {
			if (statErr) {
				onFail?.({ errMsg: `fsSaveFile:fail ${statErr.message}` })
				onComplete?.()
				return
			}
			if (!st.isFile()) {
				onFail?.({ errMsg: `fsSaveFile:fail illegal operation on a directory, copyfile '${tempFilePath}'` })
				onComplete?.()
				return
			}
			cbs.onSuccess?.({ savedFilePath, errMsg: 'fsSaveFile:ok' })
			onComplete?.()
		})
		return
	}
	mkdirpThenWrite(destReal, 'fsSaveFile', cbs, done => _fs.copyFile(src.realPath!, destReal, done), { savedFilePath })
}

/**
 * List files previously persisted by `fsSaveFile` — i.e. anything under the
 * `_store/` namespace. Returned `filePath` entries are vpaths so callers can
 * round-trip through `fsReadFile` / `fsRemoveSavedFile` without ever seeing
 * the host filesystem.
 */
export function fsGetSavedFileList(
	this: MiniAppContext,
	{ success, fail, complete }: { success?: unknown; fail?: unknown; complete?: unknown } = {},
) {
	const cbs = bindCallbacks(this, { success, fail, complete })
	const { onSuccess, onFail, onComplete } = cbs
	if (guardFsAvailable('fsGetSavedFileList', cbs)) return
	const storeVpath = resolveVPath('difile://_store/')
	const storeDir = storeVpath?.realPath
	if (!storeDir) {
		onSuccess?.({ fileList: [], errMsg: 'fsGetSavedFileList:ok' })
		onComplete?.()
		return
	}
	_fs.readdir(storeDir, (err, files) => {
		if (err) {
			// Only "the store directory does not exist yet" is a legitimate
			// empty list; any other readdir error (ENOTDIR, EACCES, EIO)
			// masked as an empty success would hide real breakage.
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				onSuccess?.({ fileList: [], errMsg: 'fsGetSavedFileList:ok' })
			} else {
				onFail?.({ errMsg: `fsGetSavedFileList:fail ${err.message}` })
			}
			onComplete?.()
			return
		}
		let pending = files.length
		if (pending === 0) {
			onSuccess?.({ fileList: [], errMsg: 'fsGetSavedFileList:ok' })
			onComplete?.()
			return
		}
		const fileList: Array<{ filePath: string; size: number; createTime: number }> = []
		let settled = false
		for (const name of files) {
			const full = _path.join(storeDir, name)
			_fs.stat(full, (statErr, s) => {
				if (settled) return
				if (statErr) {
					// A partial list would misrepresent the store's contents.
					settled = true
					onFail?.({ errMsg: `fsGetSavedFileList:fail ${statErr.message}` })
					onComplete?.()
					return
				}
				fileList.push({
					filePath: `difile://_store/${name}`,
					size: s.size,
					// wx createTime is a seconds-unit epoch.
					createTime: Math.floor(s.birthtimeMs / 1000),
				})
				if (--pending === 0) {
					settled = true
					onSuccess?.({ fileList, errMsg: 'fsGetSavedFileList:ok' })
					onComplete?.()
				}
			})
		}
	})
}

export function fsRemoveSavedFile(
	this: MiniAppContext,
	{ filePath, success, fail, complete }: { filePath: string; success?: unknown; fail?: unknown; complete?: unknown },
) {
	const cbs = bindCallbacks(this, { success, fail, complete })
	const { onFail, onComplete } = cbs
	if (guardFsAvailable('fsRemoveSavedFile', cbs)) return
	const v = resolveOrBail(filePath, 'fsRemoveSavedFile', cbs)
	if (!v) return
	// removeSavedFile is the documented exception to the `_store/` read-only
	// rule. Only `_store/*` entries may be removed through this API.
	if (v.kind !== 'store' || !v.realPath) {
		onFail?.({ errMsg: 'fsRemoveSavedFile:fail only _store/ entries may be removed' })
		onComplete?.()
		return
	}
	_fs.unlink(v.realPath, nodeComplete('fsRemoveSavedFile', cbs))
}

export function fsTruncate(
	this: MiniAppContext,
	{ filePath, length = 0, success, fail, complete }: {
		filePath: string
		length?: number
		success?: unknown
		fail?: unknown
		complete?: unknown
	},
) {
	const cbs = bindCallbacks(this, { success, fail, complete })
	if (guardFsAvailable('fsTruncate', cbs)) return
	const v = resolveOrBail(filePath, 'fsTruncate', cbs)
	if (!v) return
	if (!ensureWritable(v, 'fsTruncate', cbs)) return
	_fs.truncate(v.realPath, length, nodeComplete('fsTruncate', cbs))
}

/**
 * Synchronous "vpath → bytes" read for consumers that must resolve within one
 * task (saveImageToPhotosAlbum builds its download anchor synchronously so
 * its success/fail verdict precedes `complete`). Returns null when Node fs is
 * unavailable, the vpath does not resolve to a disk-backed file (`_tmp/*`
 * bytes live in the renderer Blob registry — resolve those through
 * `resolveTempFilePath` instead), the resolved path passes through a
 * sandbox-internal symlink, or the read itself fails.
 */
export function readVPathBytesSync(p: unknown): Buffer | null {
	if (!_fs) return null
	const v = resolveVPath(p)
	if (!v?.realPath) return null
	if (containsSymlink(v.realPath)) return null
	try {
		return _fs.readFileSync(v.realPath)
	} catch {
		return null
	}
}
