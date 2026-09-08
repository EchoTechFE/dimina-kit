/**
 * Devtools overlay of the upstream service-layer FileSystemManager module
 * (https://developers.weixin.qq.com/miniprogram/dev/api/file/wx.getFileSystemManager.html).
 *
 * At container build time (`build-container.js`) this file replaces
 * `service/src/api/core/file/index.js`, and the upstream original is
 * preserved next to it as `./upstream-impl.js`. The async surface below
 * delegates to that original, so upstream's invokeFileAPI protocol
 * (`FileSystemManager.*` wire names + base64 ArrayBuffer sentinels) stays
 * the single source of truth for how the service thread talks to the
 * container; the container-side backends live in
 * `simulator/simulator-api-fsm.ts`.
 *
 * What this overlay changes, and why:
 *
 *   - Synchronous methods (`*Sync`) throw. The devtools service thread runs
 *     in a Web Worker whose container bridge is an asynchronous postMessage
 *     (`service/src/core/message.js`) — a synchronous return value is
 *     structurally impossible there, and the unmodified upstream methods
 *     would silently answer `undefined`, corrupting caller state.
 *   - Async methods with no container backend in the simulator (unzip, the
 *     fd ops open/close/read/write/fstat/ftruncate, readCompressedFile,
 *     readZipEntry) fail loudly through their `fail` callback.
 *   - `fileSystemManagerAPINames` — which upstream `base/index.js` maps into
 *     `wx.canIUse('FileSystemManager.*')` — lists ONLY the methods that
 *     actually work, so canIUse answers match reality.
 *
 * Maintenance note: keep `fileSystemManagerAPINames` written out as quoted
 * string literals — the vitest contract suite reads this file both by import
 * (against the sibling test stand-in for `./upstream-impl.js`) and, as a
 * fallback, by scanning the source text for that literal list.
 */

import { getFileSystemManager as getUpstreamFileSystemManager, VIRTUAL_FILE_PREFIX } from './upstream-impl.js'

// Mirrors the value `wx.env.USER_DATA_PATH` answers (upstream
// `core/base/index.js` owns that env object; this overlay never touches it).
// `VIRTUAL_FILE_PREFIX` is re-exported below because `core/base/index.js`
// imports it directly from this module's path, and is derived from rather than
// duplicated here so the two stay in step if the scheme ever changes.
const USER_DATA_PATH = `${VIRTUAL_FILE_PREFIX}usr`

/** Async methods with a working container backend in the devtools simulator. */
export const fileSystemManagerAPINames = [
	'access',
	'stat',
	'readFile',
	'writeFile',
	'appendFile',
	'copyFile',
	'rename',
	'unlink',
	'mkdir',
	'rmdir',
	'readdir',
	'getFileInfo',
	'saveFile',
	'getSavedFileList',
	'removeSavedFile',
	'truncate',
]

const SYNC_UNSUPPORTED_REASON
	= 'is not supported by the devtools simulator: the service thread talks to the container over an asynchronous postMessage bridge, so a synchronous return value is impossible — use the async variant'
const ASYNC_UNSUPPORTED_REASON = 'not supported by the devtools simulator (no container backend)'

function makeSyncThrow(name) {
	return function () {
		throw new Error(`FileSystemManager.${name} ${SYNC_UNSUPPORTED_REASON}`)
	}
}

function makeAsyncFail(name) {
	return function (opts = {}) {
		opts.fail?.({ errMsg: `${name}:fail ${ASYNC_UNSUPPORTED_REASON}` })
		opts.complete?.()
	}
}

// Upstream's `getFileSystemManager()` copies every prototype method onto the
// instance as a bound own property (so `Object.keys(fsm)` enumerates the API
// surface for compatibility layers). Own properties shadow the prototype, so a
// replacement written to the prototype would never run. Collect the surface
// from both, and always install the replacement as an own property on the
// singleton — that wins whichever way upstream exposes a method, and leaves the
// shared prototype untouched.
function withUnsupportedSurfaceReplaced(fsm) {
	const proto = Object.getPrototypeOf(fsm)
	const supported = new Set(fileSystemManagerAPINames)
	const names = new Set([...Object.getOwnPropertyNames(proto), ...Object.getOwnPropertyNames(fsm)])
	for (const name of names) {
		if (name === 'constructor' || supported.has(name)) continue
		// Read through descriptors rather than `fsm[name]` so an accessor on
		// either object is classified without being invoked.
		const descriptor = Object.getOwnPropertyDescriptor(fsm, name) ?? Object.getOwnPropertyDescriptor(proto, name)
		if (typeof descriptor?.value !== 'function') continue
		fsm[name] = name.endsWith('Sync') ? makeSyncThrow(name) : makeAsyncFail(name)
	}
	return fsm
}

let instance

export function getFileSystemManager() {
	if (!instance) {
		instance = withUnsupportedSurfaceReplaced(getUpstreamFileSystemManager())
	}
	return instance
}

export { USER_DATA_PATH, VIRTUAL_FILE_PREFIX }
