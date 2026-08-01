/**
 * Contract tests for `saveImageToPhotosAlbum` filePath validation.
 *
 * Real devices (Android / iOS / Harmony dimina clients) only accept a LOCAL
 * file path for `wx.saveImageToPhotosAlbum` — a dataURL or a remote http(s)
 * URL is not a file the OS photo-album API can save, and real clients report
 * a failure instead of attempting a "download".
 *
 * This file previously treated `blob:` as the simulator's own temp-file
 * scheme and accepted it as a success case. That premise is wrong: the
 * simulator's temp-file registry (`temp-files.ts`) mints `difile://_tmp/{uuid}`
 * paths (see `createTempFilePath` at temp-files.ts:38), never `blob:` — the
 * scheme was switched away from `URL.createObjectURL` specifically because
 * `blob:` URLs are local to one renderer and cannot be served back through
 * the main-process `difile://` protocol handler into the webview session
 * (see temp-files.ts's module doc for the full history). No code path in the
 * simulator ever hands mini-program code a `blob:` filePath, and real
 * clients do not recognize the scheme either — so `blob:` belongs in the
 * "rejected, non-local filePath" bucket alongside dataURL / http(s).
 *
 * Contract asserted here:
 *   - `difile://_tmp/{uuid}` minted by `createTempFilePath` (the simulator's
 *     real temp-file scheme, produced by chooseImage/chooseMedia/
 *     compressImage) -> resolves the registered Blob, triggers exactly one
 *     download action, and succeeds before `complete` fires. Resolution is
 *     async (the Blob lives in an in-memory registry keyed by the vpath, not
 *     on disk), so the assertions await settlement instead of reading
 *     synchronously.
 *   - an unregistered `difile://_tmp/...` id (one `createTempFilePath` never
 *     produced) -> fails instead of hanging or throwing.
 *   - `difile://usr/...` -> allowed; success if the underlying file exists,
 *     fail if it does not. The exact download mechanism for the success case
 *     is not pinned — only that exactly one download action fires and
 *     `success` follows.
 *   - Any other filePath (`blob:`, dataURL, http://, https://, empty string,
 *     an arbitrary string) -> `fail` with errMsg EXACTLY
 *     "saveImageToPhotosAlbum:fail invalid file path", NO download anchor
 *     click, no `success`. `complete` still fires exactly once.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as nodeFs from 'node:fs'
import * as nodePath from 'node:path'
import * as nodeOs from 'node:os'
import type { MiniAppContext } from './types'
import { saveImageToPhotosAlbum } from './simulator-api-media'
import { createTempFilePath, revokeAllTempFilePaths } from './temp-files'

function makeContext(): MiniAppContext {
	return {
		appId: 'test-app',
		createCallbackFunction: vi.fn((fn: unknown) =>
			typeof fn === 'function' ? (fn as (...args: unknown[]) => void) : undefined,
		),
	} as unknown as MiniAppContext
}

interface InvokeResult { success?: unknown; fail?: unknown; completeCalls: number }

function invoke(filePath: string): InvokeResult {
	let successResult: unknown
	let failResult: unknown
	let completeCalls = 0
	const success = vi.fn((r: unknown) => { successResult = r })
	const fail = vi.fn((r: unknown) => { failResult = r })
	const complete = vi.fn(() => { completeCalls += 1 })
	saveImageToPhotosAlbum.call(makeContext(), { filePath, success, fail, complete })
	return { success: successResult, fail: failResult, completeCalls }
}

interface AsyncInvokeResult { success?: unknown; fail?: unknown; completeCalls: number; order: string[] }

/**
 * Same as `invoke`, but settles on `complete` instead of reading the result
 * synchronously — a `difile://_tmp/*` resolution goes through the async
 * Blob registry (`resolveTempFilePath`), so the verdict may not be available
 * on the same tick. The 500ms fallback settle keeps a still-missing
 * implementation from hanging the suite; it reports whatever DID fire.
 */
function invokeAsync(filePath: string): Promise<AsyncInvokeResult> {
	return new Promise((resolve) => {
		let resolved = false
		let successResult: unknown
		let failResult: unknown
		let completeCalls = 0
		const order: string[] = []
		const settle = () => {
			if (resolved) return
			resolved = true
			resolve({ success: successResult, fail: failResult, completeCalls, order })
		}
		const success = vi.fn((r: unknown) => { successResult = r; order.push('success') })
		const fail = vi.fn((r: unknown) => { failResult = r; order.push('fail') })
		const complete = vi.fn(() => { completeCalls += 1; order.push('complete'); settle() })
		setTimeout(settle, 500)
		saveImageToPhotosAlbum.call(makeContext(), { filePath, success, fail, complete })
	})
}

function getErrMsg(payload: unknown): string {
	if (payload && typeof payload === 'object' && 'errMsg' in payload) {
		return String((payload as { errMsg: unknown }).errMsg)
	}
	return ''
}

let clickSpy: ReturnType<typeof vi.spyOn>
let sandboxHome: string

beforeEach(() => {
	clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
	// Isolated `DIMINA_HOME` for the `difile://` existence-aware cases —
	// resolveVPath (the single vpath resolver used by the FSM handlers) reads
	// `process.env.DIMINA_HOME` dynamically, so saveImageToPhotosAlbum's
	// difile:// support is expected to share that same resolver rather than
	// invent a second path scheme.
	sandboxHome = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dimina-saveimg-test-'))
	process.env.DIMINA_HOME = sandboxHome
	nodeFs.mkdirSync(nodePath.join(sandboxHome, 'files', 'usr'), { recursive: true })
})

afterEach(() => {
	clickSpy.mockRestore()
	delete process.env.DIMINA_HOME
	if (sandboxHome && nodeFs.existsSync(sandboxHome)) {
		nodeFs.rmSync(sandboxHome, { recursive: true, force: true })
	}
	revokeAllTempFilePaths()
	vi.restoreAllMocks()
})

describe('saveImageToPhotosAlbum accepts difile://_tmp/ paths minted by createTempFilePath', () => {
	it('a Blob registered via createTempFilePath resolves, downloads exactly once, and succeeds before completing', async () => {
		const tempPath = createTempFilePath(new Blob([new Uint8Array([137, 80, 78, 71])]))
		expect(tempPath).toMatch(/^difile:\/\/_tmp\//)

		const result = await invokeAsync(tempPath)
		expect(result.fail, `should not fail: ${JSON.stringify(result.fail)}`).toBeUndefined()
		expect(result.success).toMatchObject({ errMsg: 'saveImageToPhotosAlbum:ok' })
		expect(clickSpy).toHaveBeenCalledTimes(1)
		expect(result.completeCalls).toBe(1)
		expect(
			result.order.indexOf('success'),
			`success must precede complete, got order ${JSON.stringify(result.order)}`,
		).toBeLessThan(result.order.indexOf('complete'))
	})

	it('an unregistered difile://_tmp/ id (never produced by createTempFilePath) fails instead of hanging or throwing', async () => {
		const result = await invokeAsync('difile://_tmp/00000000-0000-0000-0000-000000000000')
		expect(result.success, 'should not succeed for an unknown temp id').toBeUndefined()
		expect(result.fail).toBeDefined()
		expect(clickSpy, 'no download anchor should be clicked for an unresolvable temp id').not.toHaveBeenCalled()
		expect(result.completeCalls).toBe(1)
	})
})

describe('saveImageToPhotosAlbum accepts difile://usr (existence-checked)', () => {
	it('an existing difile:// file succeeds with exactly one download action', () => {
		nodeFs.writeFileSync(nodePath.join(sandboxHome, 'files', 'usr', 'photo.png'), Buffer.from([137, 80, 78, 71]))
		const result = invoke('difile://usr/photo.png')
		expect(result.fail, `should not fail: ${JSON.stringify(result.fail)}`).toBeUndefined()
		expect(result.success).toMatchObject({ errMsg: 'saveImageToPhotosAlbum:ok' })
		expect(clickSpy).toHaveBeenCalledTimes(1)
	})

	it('a nonexistent difile:// file fails instead of "succeeding" on nothing', () => {
		const result = invoke('difile://usr/does-not-exist.png')
		expect(result.success, 'should not report success for a file that does not exist').toBeUndefined()
		expect(result.fail).toBeDefined()
		expect(result.completeCalls).toBe(1)
	})
})

describe('saveImageToPhotosAlbum rejects non-local filePaths (real-device parity)', () => {
	it.each([
		['a blob: URL (the simulator never produces one; real clients do not recognize the scheme)', 'blob:http://localhost/00000000-0000-0000-0000-000000000000'],
		['a dataURL', 'data:image/png;base64,iVBORw0KGgo='],
		['an http URL', 'http://example.com/x.png'],
		['an https URL', 'https://example.com/x.png'],
		['an empty string', ''],
		['an arbitrary non-path string', 'not-a-real-path'],
	])('%s is rejected without downloading', (_label, badPath) => {
		const result = invoke(badPath)
		expect(result.success, `should not succeed for filePath ${JSON.stringify(badPath)}`).toBeUndefined()
		expect(result.fail).toBeDefined()
		expect(getErrMsg(result.fail)).toBe('saveImageToPhotosAlbum:fail invalid file path')
		expect(clickSpy, 'no download anchor should ever be clicked for a rejected filePath').not.toHaveBeenCalled()
		expect(result.completeCalls, 'complete must still fire exactly once on the fail path').toBe(1)
	})
})
