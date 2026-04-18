import { invokeAPI } from '@/api/common'

/**
 * https://developers.weixin.qq.com/miniprogram/dev/api/file/wx.getFileSystemManager.html
 */

const USER_DATA_PATH = 'difile://'
const UNSUPPORTED_ERRMSG = 'not supported in simulator'

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

function wrapStats(info) {
	return info ? new Stats(info) : info
}

function wrapRecursiveStats(statsMap) {
	if (!statsMap || typeof statsMap !== 'object') return statsMap
	const wrapped = {}
	for (const [key, value] of Object.entries(statsMap)) {
		wrapped[key] = new Stats(value)
	}
	return wrapped
}

class FileSystemManager {
	// ─── access ──────────────────────────────────────────────────────────

	access(opts) {
		invokeAPI('fsAccess', opts)
	}

	accessSync() {
		throwUnsupported('accessSync')
	}

	// ─── stat ────────────────────────────────────────────────────────────

	stat(opts = {}) {
		const { success, recursive, ...rest } = opts
		invokeAPI('fsStat', {
			...rest,
			recursive,
			success: (result) => {
				if (!success) return
				const stats = recursive
					? wrapRecursiveStats(result?.stats)
					: wrapStats(result?.stats)
				success({
					...result,
					stats,
				})
			},
		})
	}

	statSync() {
		throwUnsupported('statSync')
	}

	// ─── readFile ────────────────────────────────────────────────────────

	readFile(opts) {
		invokeAPI('fsReadFile', opts)
	}

	readFileSync() {
		throwUnsupported('readFileSync')
	}

	// ─── writeFile ───────────────────────────────────────────────────────

	writeFile(opts) {
		invokeAPI('fsWriteFile', opts)
	}

	writeFileSync() {
		throwUnsupported('writeFileSync')
	}

	// ─── appendFile ──────────────────────────────────────────────────────

	appendFile(opts) {
		invokeAPI('fsAppendFile', opts)
	}

	appendFileSync() {
		throwUnsupported('appendFileSync')
	}

	// ─── copyFile ────────────────────────────────────────────────────────

	copyFile(opts) {
		invokeAPI('fsCopyFile', opts)
	}

	copyFileSync() {
		throwUnsupported('copyFileSync')
	}

	// ─── rename ──────────────────────────────────────────────────────────

	rename(opts) {
		invokeAPI('fsRename', opts)
	}

	renameSync() {
		throwUnsupported('renameSync')
	}

	// ─── unlink ──────────────────────────────────────────────────────────

	unlink(opts) {
		invokeAPI('fsUnlink', opts)
	}

	unlinkSync() {
		throwUnsupported('unlinkSync')
	}

	// ─── mkdir ───────────────────────────────────────────────────────────

	mkdir(opts) {
		invokeAPI('fsMkdir', opts)
	}

	mkdirSync() {
		throwUnsupported('mkdirSync')
	}

	// ─── rmdir ───────────────────────────────────────────────────────────

	rmdir(opts) {
		invokeAPI('fsRmdir', opts)
	}

	rmdirSync() {
		throwUnsupported('rmdirSync')
	}

	// ─── readdir ─────────────────────────────────────────────────────────

	readdir(opts) {
		invokeAPI('fsReaddir', opts)
	}

	readdirSync() {
		throwUnsupported('readdirSync')
	}

	// ─── getFileInfo ─────────────────────────────────────────────────────

	getFileInfo(opts) {
		invokeAPI('fsGetFileInfo', opts)
	}

	// ─── saveFile / getSavedFileList / removeSavedFile ───────────────────

	saveFile(opts) {
		invokeAPI('fsSaveFile', opts)
	}

	saveFileSync() {
		throwUnsupported('saveFileSync')
	}

	getSavedFileList(opts) {
		invokeAPI('fsGetSavedFileList', opts)
	}

	removeSavedFile(opts) {
		invokeAPI('fsRemoveSavedFile', opts)
	}

	// ─── truncate ────────────────────────────────────────────────────────

	truncate(opts) {
		invokeAPI('fsTruncate', opts)
	}

	truncateSync() {
		throwUnsupported('truncateSync')
	}

	// ─── unzip ───────────────────────────────────────────────────────────

	unzip(opts) {
		invokeAPI('fsUnzip', opts)
	}

	// ─── File descriptor operations ──────────────────────────────────────

	open(opts) {
		failUnsupported('open', opts)
	}

	openSync() {
		throwUnsupported('openSync')
	}

	close(opts) {
		failUnsupported('close', opts)
	}

	closeSync() {
		throwUnsupported('closeSync')
	}

	read(opts) {
		failUnsupported('read', opts)
	}

	readSync() {
		throwUnsupported('readSync')
	}

	write(opts) {
		failUnsupported('write', opts)
	}

	writeSync() {
		throwUnsupported('writeSync')
	}

	fstat(opts) {
		failUnsupported('fstat', opts)
	}

	fstatSync() {
		throwUnsupported('fstatSync')
	}

	ftruncate(opts) {
		failUnsupported('ftruncate', opts)
	}

	ftruncateSync() {
		throwUnsupported('ftruncateSync')
	}

	// ─── Compression ─────────────────────────────────────────────────────

	readCompressedFile(opts) {
		failUnsupported('readCompressedFile', opts)
	}

	readCompressedFileSync() {
		throwUnsupported('readCompressedFileSync')
	}

	readZipEntry(opts) {
		failUnsupported('readZipEntry', opts)
	}
}

let instance

export function getFileSystemManager() {
	if (!instance) {
		instance = new FileSystemManager()
	}
	return instance
}

export { USER_DATA_PATH }
