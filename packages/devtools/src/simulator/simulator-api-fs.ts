/**
 * DevTools API stubs for filesystem wx.xxx APIs
 * (container-side handlers for service-apis/file).
 *
 * Each exported function is bound with `this` = MiniApp instance
 * (via AppManager.registerApi → MiniApp.invokeApi).
 */

import type { MiniAppContext } from './types'

// ─── Filesystem (container-side handlers for service-apis/file) ──────────────
// service-apis/file/index.js calls invokeAPI('fsAccess', opts), etc.
// In Electron renderer, Node.js built-ins are available via require.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const _fs: typeof import('fs') = (typeof require !== 'undefined') ? require('fs') : null
// eslint-disable-next-line @typescript-eslint/no-require-imports
const _path: typeof import('path') = (typeof require !== 'undefined') ? require('path') : null
// eslint-disable-next-line @typescript-eslint/no-require-imports
const _os: typeof import('os') = (typeof require !== 'undefined') ? require('os') : null

/** Resolve a difile:// path or absolute path to a real filesystem path. */
function _fsResolvePath(p: string): string {
	if (!p) return p
	if (p.startsWith('difile://')) {
		const rel = p.slice('difile://'.length)
		const base = _os ? _path.join(_os.homedir(), '.dimina', 'files') : '/tmp/dimina/files'
		return _path.join(base, rel)
	}
	return p
}

export function fsAccess(
	this: MiniAppContext,
	{ path, success, fail, complete }: { path: string; success?: unknown; fail?: unknown; complete?: unknown },
) {
	const onSuccess = this.createCallbackFunction(success)
	const onFail = this.createCallbackFunction(fail)
	const onComplete = this.createCallbackFunction(complete)
	if (!_fs) {
		onFail?.({ errMsg: 'fsAccess:fail not available in browser context' })
		onComplete?.()
		return
	}
	_fs.access(_fsResolvePath(path), _fs.constants.F_OK, (err) => {
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
	const onSuccess = this.createCallbackFunction(success)
	const onFail = this.createCallbackFunction(fail)
	const onComplete = this.createCallbackFunction(complete)
	if (!_fs) {
		onFail?.({ errMsg: 'fsStat:fail not available in browser context' })
		onComplete?.()
		return
	}
	const resolved = _fsResolvePath(path)
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
	const onSuccess = this.createCallbackFunction(success)
	const onFail = this.createCallbackFunction(fail)
	const onComplete = this.createCallbackFunction(complete)
	if (!_fs) {
		onFail?.({ errMsg: 'fsReadFile:fail not available in browser context' })
		onComplete?.()
		return
	}
	_fs.readFile(_fsResolvePath(filePath), encoding || null, (err, data) => {
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
	const onSuccess = this.createCallbackFunction(success)
	const onFail = this.createCallbackFunction(fail)
	const onComplete = this.createCallbackFunction(complete)
	if (!_fs) {
		onFail?.({ errMsg: 'fsWriteFile:fail not available in browser context' })
		onComplete?.()
		return
	}
	const resolved = _fsResolvePath(filePath)
	_fs.mkdir(_path.dirname(resolved), { recursive: true }, (mkdirErr) => {
		if (mkdirErr) {
			onFail?.({ errMsg: `fsWriteFile:fail ${mkdirErr.message}` })
			onComplete?.()
			return
		}
		_fs.writeFile(resolved, data as string, { encoding }, (err) => {
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
	const onSuccess = this.createCallbackFunction(success)
	const onFail = this.createCallbackFunction(fail)
	const onComplete = this.createCallbackFunction(complete)
	if (!_fs) {
		onFail?.({ errMsg: 'fsAppendFile:fail not available in browser context' })
		onComplete?.()
		return
	}
	_fs.appendFile(_fsResolvePath(filePath), data as string, { encoding }, (err) => {
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
	const onSuccess = this.createCallbackFunction(success)
	const onFail = this.createCallbackFunction(fail)
	const onComplete = this.createCallbackFunction(complete)
	if (!_fs) {
		onFail?.({ errMsg: 'fsCopyFile:fail not available in browser context' })
		onComplete?.()
		return
	}
	_fs.copyFile(_fsResolvePath(srcPath), _fsResolvePath(destPath), (err) => {
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
	const onSuccess = this.createCallbackFunction(success)
	const onFail = this.createCallbackFunction(fail)
	const onComplete = this.createCallbackFunction(complete)
	if (!_fs) {
		onFail?.({ errMsg: 'fsRename:fail not available in browser context' })
		onComplete?.()
		return
	}
	_fs.rename(_fsResolvePath(oldPath), _fsResolvePath(newPath), (err) => {
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
	const onSuccess = this.createCallbackFunction(success)
	const onFail = this.createCallbackFunction(fail)
	const onComplete = this.createCallbackFunction(complete)
	if (!_fs) {
		onFail?.({ errMsg: 'fsUnlink:fail not available in browser context' })
		onComplete?.()
		return
	}
	_fs.unlink(_fsResolvePath(filePath), (err) => {
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
	const onSuccess = this.createCallbackFunction(success)
	const onFail = this.createCallbackFunction(fail)
	const onComplete = this.createCallbackFunction(complete)
	if (!_fs) {
		onFail?.({ errMsg: 'fsMkdir:fail not available in browser context' })
		onComplete?.()
		return
	}
	_fs.mkdir(_fsResolvePath(dirPath), { recursive }, (err) => {
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
	const onSuccess = this.createCallbackFunction(success)
	const onFail = this.createCallbackFunction(fail)
	const onComplete = this.createCallbackFunction(complete)
	if (!_fs) {
		onFail?.({ errMsg: 'fsRmdir:fail not available in browser context' })
		onComplete?.()
		return
	}
	// Node 14+: rm with recursive; older Node: rmdir with recursive flag
	const rmFn = (_fs as typeof _fs & { rm?: typeof _fs.rmdir }).rm ?? _fs.rmdir
	rmFn(_fsResolvePath(dirPath), { recursive } as Parameters<typeof _fs.rmdir>[1], (err: NodeJS.ErrnoException | null) => {
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
	const onSuccess = this.createCallbackFunction(success)
	const onFail = this.createCallbackFunction(fail)
	const onComplete = this.createCallbackFunction(complete)
	if (!_fs) {
		onFail?.({ errMsg: 'fsReaddir:fail not available in browser context' })
		onComplete?.()
		return
	}
	_fs.readdir(_fsResolvePath(dirPath), (err, files) => {
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
	const onSuccess = this.createCallbackFunction(success)
	const onFail = this.createCallbackFunction(fail)
	const onComplete = this.createCallbackFunction(complete)
	if (!_fs) {
		onFail?.({ errMsg: 'fsGetFileInfo:fail not available in browser context' })
		onComplete?.()
		return
	}
	_fs.stat(_fsResolvePath(filePath), (err, s) => {
		if (err) {
			onFail?.({ errMsg: `fsGetFileInfo:fail ${err.message}` })
			onComplete?.()
			return
		}
		const result: Record<string, unknown> = { size: s.size, errMsg: 'fsGetFileInfo:ok' }
		if (digestAlgorithm) {
			// Compute digest if crypto is available
			try {
				// eslint-disable-next-line @typescript-eslint/no-require-imports
				const crypto: typeof import('crypto') = require('crypto')
				const hash = crypto.createHash(digestAlgorithm === 'md5' ? 'md5' : 'sha1')
				const stream = _fs.createReadStream(_fsResolvePath(filePath))
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
	const onSuccess = this.createCallbackFunction(success)
	const onFail = this.createCallbackFunction(fail)
	const onComplete = this.createCallbackFunction(complete)
	if (!_fs) {
		onFail?.({ errMsg: 'fsSaveFile:fail not available in browser context' })
		onComplete?.()
		return
	}
	const savedPath = filePath || _path.join(
		_os ? _os.homedir() : '/tmp',
		'.dimina',
		'saved',
		_path.basename(tempFilePath),
	)
	const resolvedSaved = _fsResolvePath(savedPath)
	_fs.mkdir(_path.dirname(resolvedSaved), { recursive: true }, (mkdirErr) => {
		if (mkdirErr) {
			onFail?.({ errMsg: `fsSaveFile:fail ${mkdirErr.message}` })
			onComplete?.()
			return
		}
		_fs.copyFile(_fsResolvePath(tempFilePath), resolvedSaved, (err) => {
			if (err) {
				onFail?.({ errMsg: `fsSaveFile:fail ${err.message}` })
			} else {
				onSuccess?.({ savedFilePath: resolvedSaved, errMsg: 'fsSaveFile:ok' })
			}
			onComplete?.()
		})
	})
}

export function fsGetSavedFileList(
	this: MiniAppContext,
	{ success, fail, complete }: { success?: unknown; fail?: unknown; complete?: unknown } = {},
) {
	const onSuccess = this.createCallbackFunction(success)
	const onFail = this.createCallbackFunction(fail)
	const onComplete = this.createCallbackFunction(complete)
	if (!_fs) {
		onFail?.({ errMsg: 'fsGetSavedFileList:fail not available in browser context' })
		onComplete?.()
		return
	}
	const savedDir = _path.join(_os ? _os.homedir() : '/tmp', '.dimina', 'saved')
	_fs.readdir(savedDir, (err, files) => {
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
			const full = _path.join(savedDir, name)
			_fs.stat(full, (statErr, s) => {
				if (!statErr) {
					fileList.push({ filePath: full, size: s.size, createTime: s.birthtimeMs })
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
	const onSuccess = this.createCallbackFunction(success)
	const onFail = this.createCallbackFunction(fail)
	const onComplete = this.createCallbackFunction(complete)
	if (!_fs) {
		onFail?.({ errMsg: 'fsRemoveSavedFile:fail not available in browser context' })
		onComplete?.()
		return
	}
	_fs.unlink(_fsResolvePath(filePath), (err) => {
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
	const onSuccess = this.createCallbackFunction(success)
	const onFail = this.createCallbackFunction(fail)
	const onComplete = this.createCallbackFunction(complete)
	if (!_fs) {
		onFail?.({ errMsg: 'fsTruncate:fail not available in browser context' })
		onComplete?.()
		return
	}
	_fs.truncate(_fsResolvePath(filePath), length, (err) => {
		if (err) {
			onFail?.({ errMsg: `fsTruncate:fail ${err.message}` })
		} else {
			onSuccess?.({ errMsg: 'fsTruncate:ok' })
		}
		onComplete?.()
	})
}

export function fsUnzip(
	this: MiniAppContext,
	{ zipFilePath: _zipFilePath, targetPath: _targetPath, success: _success, fail, complete }: {
		zipFilePath: string
		targetPath: string
		success?: unknown
		fail?: unknown
		complete?: unknown
	},
) {
	const onFail = this.createCallbackFunction(fail)
	const onComplete = this.createCallbackFunction(complete)
	// Unzip requires a native module; stub with a clear error in simulator.
	onFail?.({ errMsg: 'fsUnzip:fail not supported in simulator' })
	onComplete?.()
}
