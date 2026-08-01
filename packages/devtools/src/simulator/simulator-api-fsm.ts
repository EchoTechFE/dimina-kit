/**
 * Container-side handlers for the `FileSystemManager.*` invokeAPI wire names.
 *
 * The service thread's FileSystemManager (upstream
 * `service/src/api/core/file/index.js`, overlaid by the devtools
 * `service-apis/file/index.js` shim at container build time) invokes the
 * container with dotted wire names — `FileSystemManager.writeFile`, … — and
 * speaks the upstream transport protocol:
 *
 *   - write-class `data` arrives either as a plain string or as a
 *     `{ __diminaFileDataType: 'base64', __diminaFileDataBase64 }` sentinel
 *     (the service side's postMessage-safe ArrayBuffer encoding);
 *   - binary `readFile` results travel back as `{ __diminaArrayBufferBase64 }`
 *     for the service side to decode into an ArrayBuffer;
 *   - errMsg uses the wx short name (`writeFile:ok`), matching what real
 *     dimina clients (Android / iOS / Harmony FileSystemManager backends)
 *     report to mini-program code.
 *
 * Each handler adapts that wire shape onto the `fs*` implementations in
 * `simulator-api-fs.ts`, which own path resolution (single vpath resolver)
 * and the actual Node fs work.
 */

import type { MiniAppContext } from './types'
import { getNodeBindings } from '../shared/node-bindings.js'
import { bindCallbacks } from './simulator-api-helpers'
import {
	fsAccess,
	fsStat,
	fsReadFile,
	fsWriteFile,
	fsAppendFile,
	fsCopyFile,
	fsRename,
	fsUnlink,
	fsMkdir,
	fsRmdir,
	fsReaddir,
	fsGetFileInfo,
	fsSaveFile,
	fsGetSavedFileList,
	fsRemoveSavedFile,
	fsTruncate,
} from './simulator-api-fs'

/** Sentinel keys of the service-side transport protocol (see upstream `service/src/api/core/file/index.js`). */
const ARRAY_BUFFER_BASE64_KEY = '__diminaArrayBufferBase64'
const FILE_DATA_TYPE_KEY = '__diminaFileDataType'
const FILE_DATA_BASE64_KEY = '__diminaFileDataBase64'

type WireParams = Record<string, unknown>

/**
 * An `fs*` impl as seen from the untyped wire boundary. Each impl validates
 * its own fields (path resolution, data types), so the adapter hands the
 * whole params object through unchecked.
 */
type FsHandler = (this: MiniAppContext, opts: WireParams) => void

interface FsmAdapterSpec {
	/** wx short method name — also the errMsg prefix the service side expects. */
	short: string
	impl: FsHandler
	/** Decode a base64 write-payload sentinel in `data` before the impl runs. */
	decodeWriteData?: boolean
	/** Encode a binary success `data` into the ArrayBuffer base64 sentinel. */
	encodeReadResult?: boolean
}

const FSM_ADAPTERS: FsmAdapterSpec[] = [
	{ short: 'access', impl: fsAccess as FsHandler },
	{ short: 'stat', impl: fsStat as FsHandler },
	{ short: 'readFile', impl: fsReadFile as FsHandler, encodeReadResult: true },
	{ short: 'writeFile', impl: fsWriteFile as FsHandler, decodeWriteData: true },
	{ short: 'appendFile', impl: fsAppendFile as FsHandler, decodeWriteData: true },
	{ short: 'copyFile', impl: fsCopyFile as FsHandler },
	{ short: 'rename', impl: fsRename as FsHandler },
	{ short: 'unlink', impl: fsUnlink as FsHandler },
	{ short: 'mkdir', impl: fsMkdir as FsHandler },
	{ short: 'rmdir', impl: fsRmdir as FsHandler },
	{ short: 'readdir', impl: fsReaddir as FsHandler },
	{ short: 'getFileInfo', impl: fsGetFileInfo as FsHandler },
	{ short: 'saveFile', impl: fsSaveFile as FsHandler },
	{ short: 'getSavedFileList', impl: fsGetSavedFileList as FsHandler },
	{ short: 'removeSavedFile', impl: fsRemoveSavedFile as FsHandler },
	{ short: 'truncate', impl: fsTruncate as FsHandler },
]

/** The `fs*` impls report `fsWriteFile:ok` — the legacy internal prefix for a given wx short name. */
function legacyPrefix(short: string): string {
	return `fs${short[0]!.toUpperCase()}${short.slice(1)}`
}

/** Rewrites a payload's `errMsg` from the internal `fs*` prefix to the wx short name. */
function renameErrMsg(payload: unknown, legacy: string, short: string): unknown {
	if (!payload || typeof payload !== 'object') return payload
	const rec = payload as WireParams
	if (typeof rec.errMsg === 'string' && rec.errMsg.startsWith(`${legacy}:`)) {
		return { ...rec, errMsg: `${short}:${rec.errMsg.slice(legacy.length + 1)}` }
	}
	return payload
}

/**
 * `Buffer` for the base64 codec: the simulator document has no global
 * `Buffer` (nodeIntegration is off), so take it from the preload-published
 * node bindings; vitest/node contexts have the global.
 */
const BufferImpl: typeof Buffer | undefined =
	getNodeBindings().buffer?.Buffer ?? (typeof Buffer !== 'undefined' ? Buffer : undefined)

/** Decodes the service side's base64 write-payload sentinel into bytes; passes any other value through. */
function decodeFileData(data: unknown): unknown {
	if (!BufferImpl) return data
	if (!data || typeof data !== 'object') return data
	const rec = data as WireParams
	if (rec[FILE_DATA_TYPE_KEY] !== 'base64' || typeof rec[FILE_DATA_BASE64_KEY] !== 'string') return data
	return BufferImpl.from(rec[FILE_DATA_BASE64_KEY] as string, 'base64')
}

/**
 * Wraps a binary success `data` (Buffer/typed array) in the ArrayBuffer
 * base64 sentinel; strings pass through. `ArrayBuffer.isView` is a brand
 * check that holds across realms — an `instanceof Uint8Array` test would
 * miss Node `Buffer`s when this module is evaluated under a DOM realm.
 */
function encodeReadResult(payload: unknown): unknown {
	if (!BufferImpl) return payload
	if (!payload || typeof payload !== 'object') return payload
	const rec = payload as WireParams
	const data = rec.data
	if (typeof data === 'string' || !ArrayBuffer.isView(data)) return payload
	const bytes = BufferImpl.from(data.buffer, data.byteOffset, data.byteLength)
	return { ...rec, data: { [ARRAY_BUFFER_BASE64_KEY]: bytes.toString('base64') } }
}

function makeFsmHandler(spec: FsmAdapterSpec): (this: MiniAppContext, params?: unknown) => void {
	const legacy = legacyPrefix(spec.short)
	return function (this: MiniAppContext, params?: unknown) {
		const raw: WireParams =
			params && typeof params === 'object' && !Array.isArray(params)
				? { ...(params as WireParams) }
				: {}
		const { success, fail, complete, ...rest } = raw
		// Resolve the caller's callbacks through THIS context (on the production
		// bridge they are sentinel ids only runApiAsync's patched
		// createCallbackFunction understands).
		const cbs = bindCallbacks(this, { success, fail, complete })

		const opts: WireParams = rest
		if (spec.decodeWriteData && 'data' in opts) {
			opts.data = decodeFileData(opts.data)
		}
		// Terminal guards: exactly one success/fail verdict and one complete per
		// call. A synchronous throw inside the impl (e.g. Node fs rejecting an
		// invalid `data` type) must surface as a short-name fail through the wx
		// callbacks — never propagate as an exception (the bridge would stamp it
		// with the dotted wire name) — and any late async callback the impl
		// still fires after that is dropped here.
		let verdictFired = false
		let completeFired = false
		const fireSuccess = (out: unknown) => {
			if (verdictFired) return
			verdictFired = true
			cbs.onSuccess?.(out)
		}
		const fireFail = (out: unknown) => {
			if (verdictFired) return
			verdictFired = true
			cbs.onFail?.(out)
		}
		const fireComplete = () => {
			if (completeFired) return
			completeFired = true
			cbs.onComplete?.()
		}
		opts.success = (res: unknown) => {
			let out = renameErrMsg(res, legacy, spec.short)
			if (spec.encodeReadResult) out = encodeReadResult(out)
			fireSuccess(out)
		}
		opts.fail = (res: unknown) => {
			fireFail(renameErrMsg(res, legacy, spec.short))
		}
		opts.complete = fireComplete

		// The impl re-resolves its callbacks via ctx.createCallbackFunction, and
		// the production bridge's patched createCallbackFunction only understands
		// sentinel ids — hand the impl a derived context that passes the plain
		// interceptor functions above straight through.
		const innerCtx = Object.create(this as object) as MiniAppContext
		innerCtx.createCallbackFunction = (fn: unknown) =>
			typeof fn === 'function' ? (fn as (...args: unknown[]) => void) : undefined
		try {
			spec.impl.call(innerCtx, opts)
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			fireFail({ errMsg: `${spec.short}:fail ${msg}` })
			fireComplete()
		}
	}
}

const handlers: Record<string, (this: MiniAppContext, params?: unknown) => void> = {}
for (const spec of FSM_ADAPTERS) {
	handlers[`FileSystemManager.${spec.short}`] = makeFsmHandler(spec)
}

/** Registered 1:1 into `simulatorApis` — the keys are the invokeAPI wire names. */
export const fileSystemManagerApis = handlers
