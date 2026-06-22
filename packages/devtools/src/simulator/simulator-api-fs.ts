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

type Cb = ((arg: unknown) => void) | undefined

/**
 * Resolve `p` to a `ResolvedVPath` or invoke `onFail` with a
 * `${apiName}:fail invalid or unsafe path` message and return `null`. The
 * caller still owns the responsibility of calling `onComplete` after the
 * failure surfaces.
 */
function _fsResolveOrFail(
	p: unknown,
	apiName: string,
	onFail: Cb,
): ResolvedVPath | null {
	const v = resolveVPath(p)
	if (!v) {
		onFail?.({ errMsg: `${apiName}:fail invalid or unsafe path` })
		return null
	}
	return v
}

function _denyWrite(apiName: string, onFail: Cb): void {
	onFail?.({ errMsg: `${apiName}:fail permission denied` })
}

export function fsAccess(
	this: MiniAppContext,
	{ path, success, fail, complete }: { path: string; success?: unknown; fail?: unknown; complete?: unknown },
) {
	const { onSuccess, onFail, onComplete } = bindCallbacks(this, { success, fail, complete })
	if (!_fs) {
		onFail?.({ errMsg: 'fsAccess:fail not available in browser context' })
		onComplete?.()
		return
	}
	const v = _fsResolveOrFail(path, 'fsAccess', onFail)
	if (!v) { onComplete?.(); return }
	if (v.kind === 'tmp') {
		// _tmp existence check: renderer Map hit ⇒ ok; miss ⇒ ENOENT-shaped fail.
		_tmpBytes(path).then(
			() => { onSuccess?.({ errMsg: 'fsAccess:ok' }); onComplete?.() },
			(err: Error) => { onFail?.({ errMsg: `fsAccess:fail ${err.message}` }); onComplete?.() },
		)
		return
	}
	if (!v.realPath) {
		onFail?.({ errMsg: 'fsAccess:fail invalid path' })
		onComplete?.()
		return
	}
	_fs.access(v.realPath, _fs.constants.F_OK, (err) => {
		if (err) {
			onFail?.({ errMsg: `fsAccess:fail ${err.message}` })
		} else {
			onSuccess?.({ errMsg: 'fsAccess:ok' })
		}
		onComplete?.()
	})
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
	const { onSuccess, onFail, onComplete } = bindCallbacks(this, { success, fail, complete })
	if (!_fs) {
		onFail?.({ errMsg: 'fsStat:fail not available in browser context' })
		onComplete?.()
		return
	}
	const v = _fsResolveOrFail(path, 'fsStat', onFail)
	if (!v) { onComplete?.(); return }
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
			(err: Error) => { onFail?.({ errMsg: `fsStat:fail ${err.message}` }); onComplete?.() },
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
		_fs.stat(resolved, (err, s) => {
			if (err) {
				onFail?.({ errMsg: `fsStat:fail ${err.message}` })
			} else {
				onSuccess?.({
					stats: {
						size: s.size,
						mode: s.mode,
						lastAccessedTime: s.atimeMs,
						lastModifiedTime: s.mtimeMs,
						isFile: s.isFile(),
						isDirectory: s.isDirectory(),
					},
					errMsg: 'fsStat:ok',
				})
			}
			onComplete?.()
		})
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
	const { onSuccess, onFail, onComplete } = bindCallbacks(this, { success, fail, complete })
	if (!_fs) {
		onFail?.({ errMsg: 'fsReadFile:fail not available in browser context' })
		onComplete?.()
		return
	}
	const v = _fsResolveOrFail(filePath, 'fsReadFile', onFail)
	if (!v) { onComplete?.(); return }
	if (v.kind === 'tmp') {
		_tmpBytes(filePath).then(
			(buf) => {
				const data: Buffer | string = encoding ? buf.toString(encoding) : buf
				onSuccess?.({ data, errMsg: 'fsReadFile:ok' })
				onComplete?.()
			},
			(err: Error) => { onFail?.({ errMsg: `fsReadFile:fail ${err.message}` }); onComplete?.() },
		)
		return
	}
	if (!v.realPath) {
		onFail?.({ errMsg: 'fsReadFile:fail invalid path' })
		onComplete?.()
		return
	}
	_fs.readFile(v.realPath, encoding || null, (err, data) => {
		if (err) {
			onFail?.({ errMsg: `fsReadFile:fail ${err.message}` })
		} else {
			onSuccess?.({ data, errMsg: 'fsReadFile:ok' })
		}
		onComplete?.()
	})
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
	const { onSuccess, onFail, onComplete } = bindCallbacks(this, { success, fail, complete })
	if (!_fs) {
		onFail?.({ errMsg: 'fsWriteFile:fail not available in browser context' })
		onComplete?.()
		return
	}
	const v = _fsResolveOrFail(filePath, 'fsWriteFile', onFail)
	if (!v) { onComplete?.(); return }
	if (!v.writable || !v.realPath) {
		_denyWrite('fsWriteFile', onFail)
		onComplete?.()
		return
	}
	_fs.mkdir(_path.dirname(v.realPath), { recursive: true }, (mkdirErr) => {
		if (mkdirErr) {
			onFail?.({ errMsg: `fsWriteFile:fail ${mkdirErr.message}` })
			onComplete?.()
			return
		}
		_fs.writeFile(v.realPath!, data as string, { encoding }, (err) => {
			if (err) {
				onFail?.({ errMsg: `fsWriteFile:fail ${err.message}` })
			} else {
				onSuccess?.({ errMsg: 'fsWriteFile:ok' })
			}
			onComplete?.()
		})
	})
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
	const { onSuccess, onFail, onComplete } = bindCallbacks(this, { success, fail, complete })
	if (!_fs) {
		onFail?.({ errMsg: 'fsAppendFile:fail not available in browser context' })
		onComplete?.()
		return
	}
	const v = _fsResolveOrFail(filePath, 'fsAppendFile', onFail)
	if (!v) { onComplete?.(); return }
	if (!v.writable || !v.realPath) {
		_denyWrite('fsAppendFile', onFail)
		onComplete?.()
		return
	}
	_fs.appendFile(v.realPath, data as string, { encoding }, (err) => {
		if (err) {
			onFail?.({ errMsg: `fsAppendFile:fail ${err.message}` })
		} else {
			onSuccess?.({ errMsg: 'fsAppendFile:ok' })
		}
		onComplete?.()
	})
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
	const { onSuccess, onFail, onComplete } = bindCallbacks(this, { success, fail, complete })
	if (!_fs) {
		onFail?.({ errMsg: 'fsCopyFile:fail not available in browser context' })
		onComplete?.()
		return
	}
	const vSrc = _fsResolveOrFail(srcPath, 'fsCopyFile', onFail)
	if (!vSrc) { onComplete?.(); return }
	const vDest = _fsResolveOrFail(destPath, 'fsCopyFile', onFail)
	if (!vDest) { onComplete?.(); return }
	if (!vDest.writable || !vDest.realPath) {
		_denyWrite('fsCopyFile', onFail)
		onComplete?.()
		return
	}
	if (vSrc.kind === 'tmp') {
		// Materialize the renderer Blob into the user-data
		// area. The dest writable check above already rejected _tmp / _store
		// destinations — saveFile is the documented route for tmp→store.
		_tmpBytes(srcPath).then(
			(buf) => {
				_fs.mkdir(_path.dirname(vDest.realPath!), { recursive: true }, (mkdirErr) => {
					if (mkdirErr) {
						onFail?.({ errMsg: `fsCopyFile:fail ${mkdirErr.message}` })
						onComplete?.()
						return
					}
					_fs.writeFile(vDest.realPath!, buf, (err) => {
						if (err) onFail?.({ errMsg: `fsCopyFile:fail ${err.message}` })
						else onSuccess?.({ errMsg: 'fsCopyFile:ok' })
						onComplete?.()
					})
				})
			},
			(err: Error) => { onFail?.({ errMsg: `fsCopyFile:fail ${err.message}` }); onComplete?.() },
		)
		return
	}
	if (!vSrc.realPath) {
		onFail?.({ errMsg: 'fsCopyFile:fail invalid src path' })
		onComplete?.()
		return
	}
	_fs.copyFile(vSrc.realPath, vDest.realPath, (err) => {
		if (err) {
			onFail?.({ errMsg: `fsCopyFile:fail ${err.message}` })
		} else {
			onSuccess?.({ errMsg: 'fsCopyFile:ok' })
		}
		onComplete?.()
	})
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
	const { onSuccess, onFail, onComplete } = bindCallbacks(this, { success, fail, complete })
	if (!_fs) {
		onFail?.({ errMsg: 'fsRename:fail not available in browser context' })
		onComplete?.()
		return
	}
	const vOld = _fsResolveOrFail(oldPath, 'fsRename', onFail)
	if (!vOld) { onComplete?.(); return }
	const vNew = _fsResolveOrFail(newPath, 'fsRename', onFail)
	if (!vNew) { onComplete?.(); return }
	// Rename deletes the source — both sides must be writable. _tmp / _store
	// reject under either role.
	if (!vOld.writable || !vOld.realPath) {
		_denyWrite('fsRename', onFail)
		onComplete?.()
		return
	}
	if (!vNew.writable || !vNew.realPath) {
		_denyWrite('fsRename', onFail)
		onComplete?.()
		return
	}
	_fs.rename(vOld.realPath, vNew.realPath, (err) => {
		if (err) {
			onFail?.({ errMsg: `fsRename:fail ${err.message}` })
		} else {
			onSuccess?.({ errMsg: 'fsRename:ok' })
		}
		onComplete?.()
	})
}

export function fsUnlink(
	this: MiniAppContext,
	{ filePath, success, fail, complete }: { filePath: string; success?: unknown; fail?: unknown; complete?: unknown },
) {
	const { onSuccess, onFail, onComplete } = bindCallbacks(this, { success, fail, complete })
	if (!_fs) {
		onFail?.({ errMsg: 'fsUnlink:fail not available in browser context' })
		onComplete?.()
		return
	}
	const v = _fsResolveOrFail(filePath, 'fsUnlink', onFail)
	if (!v) { onComplete?.(); return }
	if (!v.writable || !v.realPath) {
		_denyWrite('fsUnlink', onFail)
		onComplete?.()
		return
	}
	_fs.unlink(v.realPath, (err) => {
		if (err) {
			onFail?.({ errMsg: `fsUnlink:fail ${err.message}` })
		} else {
			onSuccess?.({ errMsg: 'fsUnlink:ok' })
		}
		onComplete?.()
	})
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
	const { onSuccess, onFail, onComplete } = bindCallbacks(this, { success, fail, complete })
	if (!_fs) {
		onFail?.({ errMsg: 'fsMkdir:fail not available in browser context' })
		onComplete?.()
		return
	}
	const v = _fsResolveOrFail(dirPath, 'fsMkdir', onFail)
	if (!v) { onComplete?.(); return }
	if (!v.writable || !v.realPath) {
		_denyWrite('fsMkdir', onFail)
		onComplete?.()
		return
	}
	_fs.mkdir(v.realPath, { recursive }, (err) => {
		if (err) {
			onFail?.({ errMsg: `fsMkdir:fail ${err.message}` })
		} else {
			onSuccess?.({ errMsg: 'fsMkdir:ok' })
		}
		onComplete?.()
	})
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
	const { onSuccess, onFail, onComplete } = bindCallbacks(this, { success, fail, complete })
	if (!_fs) {
		onFail?.({ errMsg: 'fsRmdir:fail not available in browser context' })
		onComplete?.()
		return
	}
	const v = _fsResolveOrFail(dirPath, 'fsRmdir', onFail)
	if (!v) { onComplete?.(); return }
	if (!v.writable || !v.realPath) {
		_denyWrite('fsRmdir', onFail)
		onComplete?.()
		return
	}
	// Node 14+: rm with recursive; older Node: rmdir with recursive flag
	const rmFn = (_fs as typeof _fs & { rm?: typeof _fs.rmdir }).rm ?? _fs.rmdir
	rmFn(v.realPath, { recursive } as Parameters<typeof _fs.rmdir>[1], (err: NodeJS.ErrnoException | null) => {
		if (err) {
			onFail?.({ errMsg: `fsRmdir:fail ${err.message}` })
		} else {
			onSuccess?.({ errMsg: 'fsRmdir:ok' })
		}
		onComplete?.()
	})
}

export function fsReaddir(
	this: MiniAppContext,
	{ dirPath, success, fail, complete }: { dirPath: string; success?: unknown; fail?: unknown; complete?: unknown },
) {
	const { onSuccess, onFail, onComplete } = bindCallbacks(this, { success, fail, complete })
	if (!_fs) {
		onFail?.({ errMsg: 'fsReaddir:fail not available in browser context' })
		onComplete?.()
		return
	}
	const v = _fsResolveOrFail(dirPath, 'fsReaddir', onFail)
	if (!v) { onComplete?.(); return }
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
	_fs.readdir(v.realPath, (err, files) => {
		if (err) {
			onFail?.({ errMsg: `fsReaddir:fail ${err.message}` })
		} else {
			onSuccess?.({ files, errMsg: 'fsReaddir:ok' })
		}
		onComplete?.()
	})
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
	const { onSuccess, onFail, onComplete } = bindCallbacks(this, { success, fail, complete })
	if (!_fs) {
		onFail?.({ errMsg: 'fsGetFileInfo:fail not available in browser context' })
		onComplete?.()
		return
	}
	const v = _fsResolveOrFail(filePath, 'fsGetFileInfo', onFail)
	if (!v) { onComplete?.(); return }
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
			(err: Error) => { onFail?.({ errMsg: `fsGetFileInfo:fail ${err.message}` }); onComplete?.() },
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
	const { onSuccess, onFail, onComplete } = bindCallbacks(this, { success, fail, complete })
	if (!_fs) {
		onFail?.({ errMsg: 'fsSaveFile:fail not available in browser context' })
		onComplete?.()
		return
	}
	const src = _fsResolveOrFail(tempFilePath, 'fsSaveFile', onFail)
	if (!src) { onComplete?.(); return }
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

	function writeBytesToStore(bytes: Buffer): void {
		_fs.mkdir(_path.dirname(destReal), { recursive: true }, (mkdirErr) => {
			if (mkdirErr) {
				onFail?.({ errMsg: `fsSaveFile:fail ${mkdirErr.message}` })
				onComplete?.()
				return
			}
			_fs.writeFile(destReal, bytes, (err) => {
				if (err) onFail?.({ errMsg: `fsSaveFile:fail ${err.message}` })
				else onSuccess?.({ savedFilePath, errMsg: 'fsSaveFile:ok' })
				onComplete?.()
			})
		})
	}

	if (src.kind === 'tmp') {
		// Materialize the renderer Blob into _store on disk.
		_tmpBytes(tempFilePath).then(
			writeBytesToStore,
			(err: Error) => { onFail?.({ errMsg: `fsSaveFile:fail ${err.message}` }); onComplete?.() },
		)
		return
	}
	if (!src.realPath) {
		onFail?.({ errMsg: 'fsSaveFile:fail invalid src path' })
		onComplete?.()
		return
	}
	_fs.mkdir(_path.dirname(destReal), { recursive: true }, (mkdirErr) => {
		if (mkdirErr) {
			onFail?.({ errMsg: `fsSaveFile:fail ${mkdirErr.message}` })
			onComplete?.()
			return
		}
		_fs.copyFile(src.realPath!, destReal, (err) => {
			if (err) {
				onFail?.({ errMsg: `fsSaveFile:fail ${err.message}` })
			} else {
				onSuccess?.({ savedFilePath, errMsg: 'fsSaveFile:ok' })
			}
			onComplete?.()
		})
	})
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
	const { onSuccess, onFail, onComplete } = bindCallbacks(this, { success, fail, complete })
	if (!_fs) {
		onFail?.({ errMsg: 'fsGetSavedFileList:fail not available in browser context' })
		onComplete?.()
		return
	}
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
	const { onSuccess, onFail, onComplete } = bindCallbacks(this, { success, fail, complete })
	if (!_fs) {
		onFail?.({ errMsg: 'fsRemoveSavedFile:fail not available in browser context' })
		onComplete?.()
		return
	}
	const v = _fsResolveOrFail(filePath, 'fsRemoveSavedFile', onFail)
	if (!v) { onComplete?.(); return }
	// removeSavedFile is the documented exception to the `_store/` read-only
	// rule. Only `_store/*` entries may be removed through this API.
	if (v.kind !== 'store' || !v.realPath) {
		onFail?.({ errMsg: 'fsRemoveSavedFile:fail only _store/ entries may be removed' })
		onComplete?.()
		return
	}
	_fs.unlink(v.realPath, (err) => {
		if (err) {
			onFail?.({ errMsg: `fsRemoveSavedFile:fail ${err.message}` })
		} else {
			onSuccess?.({ errMsg: 'fsRemoveSavedFile:ok' })
		}
		onComplete?.()
	})
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
	const { onSuccess, onFail, onComplete } = bindCallbacks(this, { success, fail, complete })
	if (!_fs) {
		onFail?.({ errMsg: 'fsTruncate:fail not available in browser context' })
		onComplete?.()
		return
	}
	const v = _fsResolveOrFail(filePath, 'fsTruncate', onFail)
	if (!v) { onComplete?.(); return }
	if (!v.writable || !v.realPath) {
		_denyWrite('fsTruncate', onFail)
		onComplete?.()
		return
	}
	_fs.truncate(v.realPath, length, (err) => {
		if (err) {
			onFail?.({ errMsg: `fsTruncate:fail ${err.message}` })
		} else {
			onSuccess?.({ errMsg: 'fsTruncate:ok' })
		}
		onComplete?.()
	})
}

export const fsUnzip = notSupportedApi('fsUnzip')
