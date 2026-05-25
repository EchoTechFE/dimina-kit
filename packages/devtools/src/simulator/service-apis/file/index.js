/**
 * https://developers.weixin.qq.com/miniprogram/dev/api/file/wx.getFileSystemManager.html
 *
 * Parity with the dimina runtime: every `FileSystemManager` method short-
 * circuits to `fail` / `throw` because no dimina client (iOS / Android /
 * Harmony) has wired the FSM backends yet. The simulator deliberately mirrors
 * that gap so a mini-program that "works in devtools" does not break on a
 * real device.
 *
 * The lower-level `difile://` plumbing — vpath resolver, _tmp Blob store, main
 * protocol handler, disk reader, fs-channels IPC — still exists in the
 * codebase. Re-enabling FSM is a single edit: switch each method below back
 * to the previous `invokeAPI('fs<Api>', opts)` form. Until the upstream
 * runtime catches up we keep the surface inert.
 *
 * `USER_DATA_PATH` is exported unchanged because `wx.env.USER_DATA_PATH` is
 * an env value, not an FSM API; concatenating it to build a path is fine
 * even when the actual reads/writes would fail.
 */

const USER_DATA_PATH = 'difile://'
const UNSUPPORTED_ERRMSG = 'not supported by the dimina runtime'

class Stats {
	constructor(info) {
		this.size = info.size || 0
		this.mode = info.mode || 0o666
		this.lastAccessedTime = info.lastAccessedTime || 0
		this.lastModifiedTime = info.lastModifiedTime || 0
		this._isFile = info.isFile !== undefined ? info.isFile : true
		this._isDirectory = info.isDirectory !== undefined ? info.isDirectory : false
	}

	isFile() {
		return this._isFile
	}

	isDirectory() {
		return this._isDirectory
	}
}

function throwUnsupported(apiName) {
	throw new Error(`FileSystemManager.${apiName} ${UNSUPPORTED_ERRMSG}`)
}

function failUnsupported(apiName, opts = {}) {
	const { fail, complete } = opts
	fail?.({ errMsg: `${apiName}:fail ${UNSUPPORTED_ERRMSG}` })
	complete?.()
}

class FileSystemManager {
	access(opts) { failUnsupported('access', opts) }
	accessSync() { throwUnsupported('accessSync') }

	stat(opts) { failUnsupported('stat', opts) }
	statSync() { throwUnsupported('statSync') }

	readFile(opts) { failUnsupported('readFile', opts) }
	readFileSync() { throwUnsupported('readFileSync') }

	writeFile(opts) { failUnsupported('writeFile', opts) }
	writeFileSync() { throwUnsupported('writeFileSync') }

	appendFile(opts) { failUnsupported('appendFile', opts) }
	appendFileSync() { throwUnsupported('appendFileSync') }

	copyFile(opts) { failUnsupported('copyFile', opts) }
	copyFileSync() { throwUnsupported('copyFileSync') }

	rename(opts) { failUnsupported('rename', opts) }
	renameSync() { throwUnsupported('renameSync') }

	unlink(opts) { failUnsupported('unlink', opts) }
	unlinkSync() { throwUnsupported('unlinkSync') }

	mkdir(opts) { failUnsupported('mkdir', opts) }
	mkdirSync() { throwUnsupported('mkdirSync') }

	rmdir(opts) { failUnsupported('rmdir', opts) }
	rmdirSync() { throwUnsupported('rmdirSync') }

	readdir(opts) { failUnsupported('readdir', opts) }
	readdirSync() { throwUnsupported('readdirSync') }

	getFileInfo(opts) { failUnsupported('getFileInfo', opts) }

	saveFile(opts) { failUnsupported('saveFile', opts) }
	saveFileSync() { throwUnsupported('saveFileSync') }

	getSavedFileList(opts) { failUnsupported('getSavedFileList', opts) }
	removeSavedFile(opts) { failUnsupported('removeSavedFile', opts) }

	truncate(opts) { failUnsupported('truncate', opts) }
	truncateSync() { throwUnsupported('truncateSync') }

	unzip(opts) { failUnsupported('unzip', opts) }

	// File descriptor operations.
	open(opts) { failUnsupported('open', opts) }
	openSync() { throwUnsupported('openSync') }
	close(opts) { failUnsupported('close', opts) }
	closeSync() { throwUnsupported('closeSync') }
	read(opts) { failUnsupported('read', opts) }
	readSync() { throwUnsupported('readSync') }
	write(opts) { failUnsupported('write', opts) }
	writeSync() { throwUnsupported('writeSync') }
	fstat(opts) { failUnsupported('fstat', opts) }
	fstatSync() { throwUnsupported('fstatSync') }
	ftruncate(opts) { failUnsupported('ftruncate', opts) }
	ftruncateSync() { throwUnsupported('ftruncateSync') }

	// Compression.
	readCompressedFile(opts) { failUnsupported('readCompressedFile', opts) }
	readCompressedFileSync() { throwUnsupported('readCompressedFileSync') }
	readZipEntry(opts) { failUnsupported('readZipEntry', opts) }
}

// Stats is kept exported via this module's structuredClone-shaped output so
// consumers that detect `instanceof Stats` (e.g. the previous wrapStats path)
// still see a class identity; left in the module purely as a forward-compat
// affordance.
void Stats

let instance

export function getFileSystemManager() {
	if (!instance) {
		instance = new FileSystemManager()
	}
	return instance
}

export { USER_DATA_PATH }
