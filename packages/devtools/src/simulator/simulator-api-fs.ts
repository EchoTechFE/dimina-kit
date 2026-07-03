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
import { bindCallbacks, notSupportedApi } from './simulator-api-helpers'
import { resolveVPath, type ResolvedVPath } from '../shared/vpath.js'
import { resolveTempFilePath } from './temp-files'

/**
 * Dispatch helper: pull a `_tmp/*` Blob out of the renderer Map and hand back
 * its bytes. Throws an ENOENT-shaped Error if the URL is unknown, so callers
 * can surface a `fail` with a real not-found message.
 */
async function _tmpBytes(url: string): Promise<Buffer> {
	try {
		const blob = await resolveTempFilePath(url)
		const ab = await blob.arrayBuffer()
		return Buffer.from(new Uint8Array(ab))
	}
	catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		throw new Error(`ENOENT: no such file (${url}): ${msg}`, { cause: err })
	}
}

// In Electron renderer, Node.js built-ins are available via require.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const _fs: typeof import('fs') = (typeof require !== 'undefined') ? require('fs') : null as unknown as typeof import('fs')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const _path: typeof import('path') = (typeof require !== 'undefined') ? require('path') : null as unknown as typeof import('path')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const _crypto: typeof import('crypto') = (typeof require !== 'undefined') ? require('crypto') : null as unknown as typeof import('crypto')

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

/** Resolves `p` via `resolveVPath`, or reports `${apiName}:fail invalid or unsafe path` and runs `complete`. */
function resolveOrBail(p: unknown, apiName: string, cbs: FsCallbacks): ResolvedVPath | undefined {
	const v = resolveVPath(p)
	if (v) return v
	cbs.onFail?.({ errMsg: `${apiName}:fail invalid or unsafe path` })
	cbs.onComplete?.()
	return undefined
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
		writeFn(nodeComplete(apiName, cbs, () => okExtra))
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
		// Build a map of path → stat info for the directory tree
		const statsMap: Record<string, unknown> = {}
		const walkDir = (dir: string, cb: (err: Error | null) => void) => {
			_fs.readdir(dir, { withFileTypes: true }, (err, entries) => {
				if (err) { cb(err); return }
				let pending = entries.length
				if (pending === 0) { cb(null); return }
				for (const entry of entries) {
					const full = _path.join(dir, entry.name)
					_fs.stat(full, (statErr, s) => {
						if (!statErr) {
							statsMap[full] = {
								size: s.size,
								mode: s.mode,
								lastAccessedTime: s.atimeMs,
								lastModifiedTime: s.mtimeMs,
								isFile: s.isFile(),
								isDirectory: s.isDirectory(),
							}
						}
						if (entry.isDirectory()) {
							walkDir(full, () => { if (--pending === 0) cb(null) })
						} else {
							if (--pending === 0) cb(null)
						}
					})
				}
			})
		}
		walkDir(resolved, (err) => {
			if (err) {
				onFail?.({ errMsg: `fsStat:fail ${err.message}` })
			} else {
				onSuccess?.({ stats: statsMap, errMsg: 'fsStat:ok' })
			}
			onComplete?.()
		})
	} else {
		_fs.stat(resolved, nodeComplete('fsStat', cbs, (s: NodeStats) => ({
			stats: {
				size: s.size,
				mode: s.mode,
				lastAccessedTime: s.atimeMs,
				lastModifiedTime: s.mtimeMs,
				isFile: s.isFile(),
				isDirectory: s.isDirectory(),
			},
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
	// Node 14+: rm with recursive; older Node: rmdir with recursive flag
	const rmFn = (_fs as typeof _fs & { rm?: typeof _fs.rmdir }).rm ?? _fs.rmdir
	rmFn(v.realPath, { recursive } as Parameters<typeof _fs.rmdir>[1], nodeComplete('fsRmdir', cbs))
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
	if (v.kind === 'tmp') {
		_tmpBytes(filePath).then(
			(buf) => {
				const result: Record<string, unknown> = { size: buf.length, errMsg: 'fsGetFileInfo:ok' }
				if (digestAlgorithm) {
					try {
						const hash = _crypto.createHash(digestAlgorithm === 'md5' ? 'md5' : 'sha1')
						hash.update(buf)
						result.digest = hash.digest('hex')
					}
					catch {
						// crypto unavailable — fall through without digest.
					}
				}
				onSuccess?.(result)
				onComplete?.()
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
		const result: Record<string, unknown> = { size: s.size, errMsg: 'fsGetFileInfo:ok' }
		if (digestAlgorithm) {
			// Compute digest if crypto is available
			try {
				const hash = _crypto.createHash(digestAlgorithm === 'md5' ? 'md5' : 'sha1')
				const stream = _fs.createReadStream(resolved)
				stream.on('data', (chunk) => hash.update(chunk as Buffer))
				stream.on('end', () => {
					result.digest = hash.digest('hex')
					onSuccess?.(result)
					onComplete?.()
				})
				stream.on('error', (hashErr) => {
					onFail?.({ errMsg: `fsGetFileInfo:fail ${hashErr.message}` })
					onComplete?.()
				})
				return
			} catch {
				// crypto not available, skip digest
			}
		}
		onSuccess?.(result)
		onComplete?.()
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
export function fsSaveFile(
	this: MiniAppContext,
	{ tempFilePath, filePath: _filePath, success, fail, complete }: {
		tempFilePath: string
		filePath?: string
		success?: unknown
		fail?: unknown
		complete?: unknown
	},
) {
	void _filePath
	const cbs = bindCallbacks(this, { success, fail, complete })
	const { onFail, onComplete } = cbs
	if (guardFsAvailable('fsSaveFile', cbs)) return
	const src = resolveOrBail(tempFilePath, 'fsSaveFile', cbs)
	if (!src) return
	const ext = _path.extname(tempFilePath) || ''
	const id = _crypto.randomUUID() + ext
	const savedFilePath = `difile://_store/${id}`
	const destResolved = resolveVPath(savedFilePath)
	if (!destResolved || !destResolved.realPath) {
		// Defensive: a freshly minted vpath must always resolve.
		onFail?.({ errMsg: 'fsSaveFile:fail unable to allocate destination' })
		onComplete?.()
		return
	}
	const destReal = destResolved.realPath

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
	const { onSuccess, onComplete } = cbs
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
			// Directory may not exist yet — return empty list
			onSuccess?.({ fileList: [], errMsg: 'fsGetSavedFileList:ok' })
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
		for (const name of files) {
			const full = _path.join(storeDir, name)
			_fs.stat(full, (statErr, s) => {
				if (!statErr) {
					fileList.push({
						filePath: `difile://_store/${name}`,
						size: s.size,
						createTime: s.birthtimeMs,
					})
				}
				if (--pending === 0) {
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

export const fsUnzip = notSupportedApi('fsUnzip')
