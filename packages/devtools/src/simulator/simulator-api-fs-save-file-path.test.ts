/**
 * Contract: `fsSaveFile`'s optional `filePath` (upstream / wx
 * `saveFile({ tempFilePath, filePath })`) must be honored as the
 * caller-chosen destination. Today `filePath` is destructured and discarded
 * (`fsSaveFile`'s `{ tempFilePath, filePath: _filePath, ... }` binds it to
 * `_filePath` and immediately `void`s it — see `simulator-api-fs.ts`), so
 * every save lands under the auto-minted `difile://_store/{uuid}.{ext}`
 * vpath even when the caller asked for a specific user-data location.
 *
 * Real wx / dimina native clients: an explicit `filePath` becomes the
 * `savedFilePath` verbatim, missing parent directories are created (matching
 * every other write-class FSM API's `mkdirpThenWrite` behavior), and the
 * runtime-owned read-only namespaces (`_tmp/`, `_store/`) remain off-limits
 * as a save DESTINATION — the same `permission denied` rule every other
 * write-class API already enforces for those namespaces.
 *
 * `filePath` omitted (the auto-minted `difile://_store/{uuid}.{ext}` path)
 * is existing, already-covered behavior (`simulator-api-fs.test.ts`'s
 * "fsSaveFile from ... source materializes into _store" suite) and is not
 * duplicated here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as nodeFs from 'node:fs'
import * as nodePath from 'node:path'
import * as nodeOs from 'node:os'
import type { MiniAppContext } from './types'
import { fsSaveFile, fsReadFile, fsWriteFile } from './simulator-api-fs'

function makeContext(): MiniAppContext {
	return {
		appId: 'test-app',
		createCallbackFunction: vi.fn((fn: unknown) =>
			typeof fn === 'function' ? (fn as (...args: unknown[]) => void) : undefined,
		),
	} as unknown as MiniAppContext
}

interface InvokeResult { success?: unknown; fail?: unknown; complete: boolean }

function invoke(handler: unknown, args: Record<string, unknown>): Promise<InvokeResult> {
	return new Promise((resolve) => {
		let resolved = false
		let successResult: unknown
		let failResult: unknown
		let didComplete = false
		const settle = () => {
			if (resolved) return
			resolved = true
			resolve({ success: successResult, fail: failResult, complete: didComplete })
		}
		const success = vi.fn((r: unknown) => { successResult = r })
		const fail = vi.fn((r: unknown) => { failResult = r })
		const complete = vi.fn(() => { didComplete = true; settle() })
		setTimeout(settle, 500)
		;(handler as (this: MiniAppContext, opts: Record<string, unknown>) => void)
			.call(makeContext(), { ...args, success, fail, complete })
	})
}

function getErrMsg(payload: unknown): string {
	if (payload && typeof payload === 'object' && 'errMsg' in payload) {
		return String((payload as { errMsg: unknown }).errMsg)
	}
	return ''
}

let sandboxHome: string

beforeEach(() => {
	sandboxHome = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dimina-savefile-path-test-'))
	process.env.DIMINA_HOME = sandboxHome
	nodeFs.mkdirSync(nodePath.join(sandboxHome, 'files', 'usr'), { recursive: true })
})

afterEach(() => {
	delete process.env.DIMINA_HOME
	if (sandboxHome && nodeFs.existsSync(sandboxHome)) {
		nodeFs.rmSync(sandboxHome, { recursive: true, force: true })
	}
	vi.restoreAllMocks()
})

describe('fsSaveFile honors a caller-supplied filePath destination', () => {
	it('saveFile({tempFilePath, filePath}) saves under EXACTLY the caller filePath, creating missing parent dirs, and the bytes read back match', async () => {
		const w = await invoke(fsWriteFile, { filePath: 'difile://usr/src.txt', data: 'save-me-here', encoding: 'utf8' })
		expect(w.fail, `seed write failed: ${JSON.stringify(w.fail)}`).toBeUndefined()

		// 'saved/' does not exist yet under usr/ — the destination directory
		// must be created, mirroring fsWriteFile's mkdirpThenWrite behavior.
		const s = await invoke(fsSaveFile, {
			tempFilePath: 'difile://usr/src.txt',
			filePath: 'difile://usr/saved/dest.bin',
		})
		expect(s.fail, `fsSaveFile failed: ${JSON.stringify(s.fail)}`).toBeUndefined()
		const savedFilePath = (s.success as { savedFilePath?: unknown } | undefined)?.savedFilePath
		expect(
			savedFilePath,
			'fsSaveFile must report the CALLER-supplied filePath as savedFilePath, not an auto-minted _store/ vpath',
		).toBe('difile://usr/saved/dest.bin')

		const r = await invoke(fsReadFile, { filePath: 'difile://usr/saved/dest.bin', encoding: 'utf8' })
		expect(r.fail, `readFile of the caller-chosen destination failed: ${JSON.stringify(r.fail)}`).toBeUndefined()
		expect(r.success).toMatchObject({ data: 'save-me-here' })
	})

	it.each([
		['difile://_tmp/x', '_tmp is runtime-owned and read-only as a save destination'],
		['difile://_store/x', '_store is runtime-owned and read-only as a save destination'],
	])('rejects filePath: %s (%s)', async (badFilePath) => {
		const w = await invoke(fsWriteFile, { filePath: 'difile://usr/src2.txt', data: 'x', encoding: 'utf8' })
		expect(w.fail).toBeUndefined()

		const s = await invoke(fsSaveFile, { tempFilePath: 'difile://usr/src2.txt', filePath: badFilePath })
		expect(
			s.success,
			`fsSaveFile must not succeed writing into a runtime-owned namespace (filePath: ${badFilePath})`,
		).toBeUndefined()
		expect(s.fail).toBeDefined()
		expect(getErrMsg(s.fail)).toMatch(/^fsSaveFile:fail /)
		expect(getErrMsg(s.fail)).toMatch(/permission denied/)
	})
})

// ─── saveFile where tempFilePath and filePath resolve to the SAME realPath ──
//
// Guards the defined contract for a "re-save in place" call: when the
// caller's `filePath` normalizes to the same realPath as `tempFilePath`,
// saveFile succeeds as an explicit no-op (echoing the caller's path, bytes
// unchanged) — a stable simulator contract rather than whatever the host
// Node's same-file `fs.copyFile` happens to do.

describe('fsSaveFile where filePath resolves to the SAME realPath as tempFilePath', () => {
	it('saveFile(tempFilePath === filePath, identical spelling) succeeds, echoes filePath, and leaves the content unchanged', async () => {
		const w = await invoke(fsWriteFile, { filePath: 'difile://usr/same.txt', data: 'same-path-content', encoding: 'utf8' })
		expect(w.fail, `seed write failed: ${JSON.stringify(w.fail)}`).toBeUndefined()

		const s = await invoke(fsSaveFile, { tempFilePath: 'difile://usr/same.txt', filePath: 'difile://usr/same.txt' })
		expect(s.fail, `fsSaveFile failed for an identical tempFilePath/filePath: ${JSON.stringify(s.fail)}`).toBeUndefined()
		expect((s.success as { savedFilePath?: unknown } | undefined)?.savedFilePath).toBe('difile://usr/same.txt')

		const r = await invoke(fsReadFile, { filePath: 'difile://usr/same.txt', encoding: 'utf8' })
		expect(r.fail).toBeUndefined()
		expect(r.success).toMatchObject({ data: 'same-path-content' })
	})

	it('saveFile(tempFilePath, filePath) that NORMALIZE to the same realPath (extra leading slashes) also succeeds and leaves content unchanged', async () => {
		const w = await invoke(fsWriteFile, { filePath: 'difile://usr/same2.txt', data: 'normalized-same-content', encoding: 'utf8' })
		expect(w.fail, `seed write failed: ${JSON.stringify(w.fail)}`).toBeUndefined()

		// `resolveVPath` strips leading slashes after the scheme, so
		// 'difile:///usr/same2.txt' resolves to the exact same realPath as
		// 'difile://usr/same2.txt' despite the differing spelling.
		const s = await invoke(fsSaveFile, { tempFilePath: 'difile://usr/same2.txt', filePath: 'difile:///usr/same2.txt' })
		expect(s.fail, `fsSaveFile failed for a normalized-identical filePath: ${JSON.stringify(s.fail)}`).toBeUndefined()
		expect((s.success as { savedFilePath?: unknown } | undefined)?.savedFilePath).toBe('difile:///usr/same2.txt')

		const r = await invoke(fsReadFile, { filePath: 'difile://usr/same2.txt', encoding: 'utf8' })
		expect(r.fail).toBeUndefined()
		expect(r.success).toMatchObject({ data: 'normalized-same-content' })
	})
})

// ─── same-path save still requires the source to exist on disk ─────────────
//
// `resolveOrBail` validates the path STRING (scheme, no `..`, symlink
// segments) but never stats what's on disk, so the same-realPath no-op
// branch must verify the source itself before echoing success.

describe('fsSaveFile same-path no-op still requires an existing source file', () => {
	it('saveFile(tempFilePath === filePath) with a MISSING source fails instead of fabricating ok', async () => {
		const s = await invoke(fsSaveFile, { tempFilePath: 'difile://usr/ghost.txt', filePath: 'difile://usr/ghost.txt' })
		expect(s.success, `a missing source must not save: ${JSON.stringify(s.success)}`).toBeUndefined()
		expect(getErrMsg(s.fail)).toMatch(/^fsSaveFile:fail /)
	})

	it('saveFile(tempFilePath === filePath) pointing at a DIRECTORY fails instead of echoing ok', async () => {
		nodeFs.mkdirSync(nodePath.join(sandboxHome, 'files', 'usr', 'a-dir'))
		const s = await invoke(fsSaveFile, { tempFilePath: 'difile://usr/a-dir', filePath: 'difile://usr/a-dir' })
		expect(s.success, `a directory source must not save: ${JSON.stringify(s.success)}`).toBeUndefined()
		expect(getErrMsg(s.fail)).toMatch(/^fsSaveFile:fail /)
	})
})
