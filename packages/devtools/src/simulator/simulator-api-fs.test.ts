/**
 * Contract tests for the fs subsystem:
 *
 *   1. Security: every fs API must reject absolute paths, non-difile:// URLs,
 *      and `..` / `%2e%2e` traversal, so `/etc/passwd` or
 *      `difile://abc/../../escape` cannot leak through the resolver.
 *   2. Reserved namespace: write-class APIs (writeFile / appendFile / unlink /
 *      rename(dest) / mkdir / rmdir / truncate) must refuse `difile://_tmp/*`
 *      and `difile://_store/*` with `permission denied`, matching wx 真机 read-
 *      only tmp/store semantics.
 *   3. saveFile must return a `difile://_store/{uuid}.{ext}` vpath, not the
 *      raw realPath; a `_tmp` source materializes into `_store`.
 *
 * Sandbox strategy
 * ----------------
 * The implementation reads `~/.dimina/files` via `os.homedir()`. We mock the
 * `os` module so homedir() points at a per-suite temp directory, ensuring the
 * tests cannot touch the developer's real `~/.dimina`. The mock is set up
 * before the SUT is imported (the SUT captures `_os` at module load time).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as nodeFs from 'node:fs'
import * as nodePath from 'node:path'
import * as nodeOs from 'node:os'
import * as nodeCrypto from 'node:crypto'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const osCjs = require('os') as { homedir: () => string }
import type { MiniAppContext } from './types'
import {
	registerTempFilePath,
	revokeAllTempFilePaths,
} from './temp-files'

// ─── sandbox: redirect os.homedir() before importing the SUT ─────────────────
//
// The SUT uses CommonJS `require('os')` (renderer / Node-in-Electron pattern),
// which `vi.mock('os')` cannot intercept reliably across Node's CJS resolver.
// Instead, because Node caches a single instance of the built-in `os` module
// shared by every importer (CJS or ESM), we patch `os.homedir` directly with
// a spy that returns the per-test sandbox path. The SUT's `_os.homedir()`
// call hits the same function pointer.

let sandboxHome: string
const realHomedir = osCjs.homedir

import * as fsApi from './simulator-api-fs'

function makeContext(): MiniAppContext {
	return {
		appId: 'test-app',
		createCallbackFunction: vi.fn((fn: unknown) =>
			typeof fn === 'function' ? (fn as (...args: unknown[]) => void) : undefined,
		),
	} as unknown as MiniAppContext
}

// Convenience: invoke an fs API and resolve with the {success, fail, complete}
// callback payloads. Tests assert on whichever callback was actually invoked.
function invoke<T extends keyof typeof fsApi>(
	name: T,
	args: Record<string, unknown>,
): Promise<{ success?: unknown; fail?: unknown; complete: boolean }> {
	return new Promise((resolve) => {
		let resolved = false
		const settle = (
			value: { success?: unknown; fail?: unknown; complete: boolean },
		) => {
			if (resolved) return
			resolved = true
			resolve(value)
		}
		let successResult: unknown
		let failResult: unknown
		let didComplete = false
		const success = vi.fn((r: unknown) => {
			successResult = r
		})
		const fail = vi.fn((r: unknown) => {
			failResult = r
		})
		const complete = vi.fn(() => {
			didComplete = true
			settle({ success: successResult, fail: failResult, complete: didComplete })
		})
		const ctx = makeContext()
		// fail-safe: if complete is never called, settle after a short tick.
		setTimeout(() => settle({ success: successResult, fail: failResult, complete: didComplete }), 200)
		;(fsApi[name] as unknown as (this: MiniAppContext, opts: Record<string, unknown>) => void).call(ctx, {
			...args,
			success,
			fail,
			complete,
		})
	})
}

function getErrMsg(failPayload: unknown): string {
	if (failPayload && typeof failPayload === 'object' && 'errMsg' in failPayload) {
		return String((failPayload as { errMsg: unknown }).errMsg)
	}
	return ''
}

// ─── sandbox lifecycle ───────────────────────────────────────────────────────

beforeEach(() => {
	sandboxHome = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dimina-fs-test-'))
	nodeFs.mkdirSync(nodePath.join(sandboxHome, '.dimina', 'files'), { recursive: true })
	nodeFs.mkdirSync(nodePath.join(sandboxHome, '.dimina', 'files', '_store'), { recursive: true })
	nodeFs.mkdirSync(nodePath.join(sandboxHome, '.dimina', 'files', '_tmp'), { recursive: true })
	// The SUT captures `_os` via CJS require('os') at module load time. The
	// CJS module object is a real JS object whose properties ARE writable, so
	// we patch homedir directly. ESM namespace `vi.spyOn` does not work here
	// (Node ESM exports are non-configurable).
	osCjs.homedir = () => sandboxHome
})

afterEach(() => {
	osCjs.homedir = realHomedir
	if (sandboxHome && nodeFs.existsSync(sandboxHome)) {
		nodeFs.rmSync(sandboxHome, { recursive: true, force: true })
	}
	// Drain the renderer-side Map so _tmp entries from one test don't leak
	// into the next. This is the same sink the preload bridge would call.
	revokeAllTempFilePaths()
	vi.restoreAllMocks()
})

const filesBase = () => nodePath.join(sandboxHome, '.dimina', 'files')

// ─── 1. Security: reject absolute & traversal paths ──────────────────────────

describe('fs security: absolute / traversal rejection', () => {
	// To distinguish "rejected by path validator" from "happened to ENOENT",
	// we plant a REAL decoy file outside the sandbox and assert the SUT
	// neither succeeds nor reaches it. The fail message must indicate a path
	// validation failure (not the unix errno "no such file" leak).

	it('fsAccess rejects an absolute path that would otherwise resolve (decoy file exists)', async () => {
		const decoy = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dimina-decoy-'))
		const decoyFile = nodePath.join(decoy, 'sensitive.txt')
		try {
			nodeFs.writeFileSync(decoyFile, 'TOP-SECRET')
			const r = await invoke('fsAccess', { path: decoyFile })
			// Without path validation the current impl would happily return ok.
			expect(getErrMsg(r.success)).not.toBe('fsAccess:ok')
			expect(r.fail).toBeDefined()
			// Reject reason must be from the validator, NOT a unix errno leak.
			expect(getErrMsg(r.fail)).not.toMatch(/ENOENT|no such file/i)
		} finally {
			nodeFs.rmSync(decoy, { recursive: true, force: true })
		}
	})

	it('fsAccess rejects difile:// with `..` traversal (decoy file exists outside sandbox)', async () => {
		// Plant a decoy two directories above the sandbox so that
		// `path.join(base, '../../etc/passwd')`-style join would actually hit it
		// if the validator is missing.
		const parent = nodePath.dirname(sandboxHome)
		const decoy = nodePath.join(parent, 'escaped.txt')
		try {
			nodeFs.writeFileSync(decoy, 'should not be reachable')
			// dirname of sandboxHome is one above; from `~/.dimina/files` we need
			// to go up 3 levels to reach `<parent>`.
			const r = await invoke('fsAccess', { path: 'difile://../../../escaped.txt' })
			expect(getErrMsg(r.success)).not.toBe('fsAccess:ok')
			expect(r.fail).toBeDefined()
			expect(getErrMsg(r.fail)).not.toMatch(/ENOENT|no such file/i)
		} finally {
			if (nodeFs.existsSync(decoy)) nodeFs.unlinkSync(decoy)
		}
	})

	it('fsAccess rejects difile:// with URL-encoded `..` (%2e%2e) traversal', async () => {
		const parent = nodePath.dirname(sandboxHome)
		const decoy = nodePath.join(parent, 'encoded.txt')
		try {
			nodeFs.writeFileSync(decoy, 'should not be reachable')
			const r = await invoke('fsAccess', { path: 'difile://%2e%2e/%2e%2e/%2e%2e/encoded.txt' })
			expect(getErrMsg(r.success)).not.toBe('fsAccess:ok')
			expect(r.fail).toBeDefined()
			// The validator MUST reject before reaching fs (no ENOENT leak). If
			// the impl just shoves the literal %2e%2e through path.join, fs would
			// fail with ENOENT — that is the bug we want to catch.
			expect(getErrMsg(r.fail)).not.toMatch(/ENOENT|no such file/i)
		} finally {
			if (nodeFs.existsSync(decoy)) nodeFs.unlinkSync(decoy)
		}
	})

	it('fsReadFile rejects a real absolute path on disk (decoy file exists)', async () => {
		const decoy = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dimina-decoy-'))
		const decoyFile = nodePath.join(decoy, 'id_rsa')
		try {
			nodeFs.writeFileSync(decoyFile, 'PRIVATE_KEY_MATERIAL')
			const r = await invoke('fsReadFile', { filePath: decoyFile, encoding: 'utf8' })
			// MUST not succeed; MUST not return the decoy bytes.
			expect(r.success).toBeUndefined()
			expect(JSON.stringify(r.success ?? '')).not.toContain('PRIVATE_KEY_MATERIAL')
			expect(r.fail).toBeDefined()
		} finally {
			nodeFs.rmSync(decoy, { recursive: true, force: true })
		}
	})

	it('fsReadFile rejects difile:// path that canonicalizes outside the sandbox', async () => {
		const r = await invoke('fsReadFile', { filePath: 'difile://abc/../../escape' })
		expect(r.success).toBeUndefined()
		expect(r.fail).toBeDefined()
		// Reject reason must come from the validator, not a fs errno leak.
		expect(getErrMsg(r.fail)).not.toMatch(/ENOENT|no such file/i)
	})

	it('fsWriteFile rejects writing to an arbitrary absolute path (no file is created at that path)', async () => {
		const decoy = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dimina-decoy-'))
		const target = nodePath.join(decoy, 'anywhere.txt')
		try {
			const r = await invoke('fsWriteFile', { filePath: target, data: 'x' })
			expect(r.success).toBeUndefined()
			expect(r.fail).toBeDefined()
			expect(getErrMsg(r.fail)).toMatch(/fsWriteFile:fail/)
			// And nothing was actually written to the target path by the SUT.
			expect(nodeFs.existsSync(target)).toBe(false)
		} finally {
			nodeFs.rmSync(decoy, { recursive: true, force: true })
		}
	})

	it('fsAccess on a valid difile:// user file reports ENOENT (not a path-validation fail) when the file does not exist', async () => {
		// Boundary case: clean difile://valid_file must clear the path-validator
		// and reach the real fs call. If the file does not exist we expect a
		// generic ENOENT-style fail, NOT a path-rejected fail.
		const r = await invoke('fsAccess', { path: 'difile://valid_file_that_does_not_exist' })
		expect(r.success).toBeUndefined()
		expect(r.fail).toBeDefined()
		const msg = getErrMsg(r.fail)
		// The error must come from fs (ENOENT / no such file), not from a path
		// validator. We loosely allow either the exact ENOENT string or "no such
		// file" — the goal is to assert the call reached fs.
		expect(msg).toMatch(/ENOENT|no such file/i)
	})

	it('fsAccess on a real existing difile:// user file succeeds', async () => {
		const target = nodePath.join(filesBase(), 'hello.txt')
		nodeFs.writeFileSync(target, 'world')
		const r = await invoke('fsAccess', { path: 'difile://hello.txt' })
		expect(r.fail).toBeUndefined()
		expect(r.success).toBeDefined()
		expect(getErrMsg(r.success)).toBe('fsAccess:ok')
	})
})

// ─── 2. Reserved namespace: write-class APIs reject _tmp / _store ───────────

describe('reserved namespace: write APIs reject _tmp and _store', () => {
	it('fsWriteFile to difile://_tmp/* fails with permission denied', async () => {
		const r = await invoke('fsWriteFile', { filePath: 'difile://_tmp/abc.jpg', data: 'x' })
		expect(r.success).toBeUndefined()
		expect(r.fail).toBeDefined()
		expect(getErrMsg(r.fail)).toMatch(/fsWriteFile:fail/)
		expect(getErrMsg(r.fail)).toMatch(/permission denied/i)
	})

	it('fsWriteFile to difile://_store/* fails with permission denied', async () => {
		const r = await invoke('fsWriteFile', { filePath: 'difile://_store/abc.png', data: 'x' })
		expect(r.success).toBeUndefined()
		expect(r.fail).toBeDefined()
		expect(getErrMsg(r.fail)).toMatch(/permission denied/i)
	})

	it('fsAppendFile to difile://_tmp/* fails with permission denied', async () => {
		const r = await invoke('fsAppendFile', { filePath: 'difile://_tmp/abc', data: 'x' })
		expect(r.success).toBeUndefined()
		expect(r.fail).toBeDefined()
		expect(getErrMsg(r.fail)).toMatch(/permission denied/i)
	})

	it('fsUnlink on difile://_tmp/* fails with permission denied', async () => {
		const r = await invoke('fsUnlink', { filePath: 'difile://_tmp/abc' })
		expect(r.success).toBeUndefined()
		expect(r.fail).toBeDefined()
		expect(getErrMsg(r.fail)).toMatch(/permission denied/i)
	})

	it('fsUnlink on difile://_store/* fails with permission denied', async () => {
		const r = await invoke('fsUnlink', { filePath: 'difile://_store/abc' })
		expect(r.success).toBeUndefined()
		expect(r.fail).toBeDefined()
		expect(getErrMsg(r.fail)).toMatch(/permission denied/i)
	})

	it('fsRename whose newPath lands inside _tmp/ fails with permission denied', async () => {
		// Seed a real source file so we know rename would otherwise succeed.
		const src = nodePath.join(filesBase(), 'src.txt')
		nodeFs.writeFileSync(src, 'hi')
		const r = await invoke('fsRename', {
			oldPath: 'difile://src.txt',
			newPath: 'difile://_tmp/x',
		})
		expect(r.success).toBeUndefined()
		expect(r.fail).toBeDefined()
		expect(getErrMsg(r.fail)).toMatch(/permission denied/i)
		// And the source file is still where it was — rename was not partially applied.
		expect(nodeFs.existsSync(src)).toBe(true)
	})

	it('fsMkdir under difile://_tmp/* fails with permission denied', async () => {
		const r = await invoke('fsMkdir', { dirPath: 'difile://_tmp/newdir' })
		expect(r.success).toBeUndefined()
		expect(r.fail).toBeDefined()
		expect(getErrMsg(r.fail)).toMatch(/permission denied/i)
	})

	it('fsWriteFile to a non-reserved difile:// user path still succeeds (regression guard)', async () => {
		const r = await invoke('fsWriteFile', { filePath: 'difile://userfile.txt', data: 'hi' })
		expect(r.fail).toBeUndefined()
		expect(r.success).toBeDefined()
		expect(getErrMsg(r.success)).toBe('fsWriteFile:ok')
		// And the bytes really landed under the sandbox.
		const onDisk = nodePath.join(filesBase(), 'userfile.txt')
		expect(nodeFs.readFileSync(onDisk, 'utf8')).toBe('hi')
	})
})

// ─── 3. saveFile returns a difile://_store/{uuid}.{ext} vpath ────────────────

describe('fsSaveFile vpath contract', () => {
	// A _tmp source must materialize into _store and produce a _store/* vpath
	// (see _tmp materialization, docs/file-system.md §6).
	it('fsSaveFile from a difile://_tmp/* source materializes into _store', async () => {
		const original = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x10, 0x11, 0x12])
		const tmpUrl = 'difile://_tmp/saveFile-from-tmp.jpg'
		registerTempFilePath(tmpUrl, new Blob([new Uint8Array(original)], { type: 'image/jpeg' }))

		const r = await invoke('fsSaveFile', { tempFilePath: tmpUrl })
		expect(r.fail).toBeUndefined()
		expect(r.success).toBeDefined()
		const payload = r.success as { savedFilePath?: unknown; errMsg?: unknown }
		expect(payload.errMsg).toBe('fsSaveFile:ok')

		const savedPath = String(payload.savedFilePath ?? '')
		// Saved as a _store vpath, not a real disk path, and preserves the ext.
		expect(savedPath.startsWith('difile://_store/')).toBe(true)
		expect(savedPath.endsWith('.jpg')).toBe(true)
		expect(savedPath).not.toContain(sandboxHome)

		// Round-trip: the bytes are readable through the _store entry.
		const read = await invoke('fsReadFile', { filePath: savedPath })
		expect(read.fail).toBeUndefined()
		const data = (read.success as { data?: unknown }).data
		expect(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)).toEqual(original)
	})

	it('fsSaveFile rejects absolute-path sources outright (rejected by validator, not ENOENT)', async () => {
		// Plant a REAL file at an absolute path so the only way the SUT can fail
		// is if it actively rejects the absolute scheme. Without validation the
		// current impl would happily copy it.
		const decoy = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dimina-decoy-'))
		const src = nodePath.join(decoy, 'file.jpg')
		try {
			nodeFs.writeFileSync(src, Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
			const r = await invoke('fsSaveFile', { tempFilePath: src })
			expect(r.success).toBeUndefined()
			expect(r.fail).toBeDefined()
			expect(getErrMsg(r.fail)).toMatch(/fsSaveFile:fail/)
			// Reject reason must come from validator, not a unix errno leak.
			expect(getErrMsg(r.fail)).not.toMatch(/ENOENT|no such file/i)
		} finally {
			nodeFs.rmSync(decoy, { recursive: true, force: true })
		}
	})

	it('fsSaveFile from a USER_DATA_PATH difile:// source returns difile://_store/{uuid}.{ext}', async () => {
		// Seed a user-area file inside the sandbox so saveFile has something to copy.
		const srcReal = nodePath.join(filesBase(), 'existing_disk.jpg')
		nodeFs.writeFileSync(srcReal, Buffer.from([0xff, 0xd8, 0xff, 0xe0]))

		const r = await invoke('fsSaveFile', { tempFilePath: 'difile://existing_disk.jpg' })
		expect(r.fail).toBeUndefined()
		expect(r.success).toBeDefined()
		const payload = r.success as { savedFilePath?: unknown; errMsg?: unknown }
		expect(payload.errMsg).toBe('fsSaveFile:ok')

		const savedPath = String(payload.savedFilePath ?? '')
		// MUST be a vpath, NOT an absolute realPath leaking the homedir.
		expect(savedPath.startsWith('difile://_store/')).toBe(true)
		expect(savedPath).not.toMatch(/^\//)
		expect(savedPath).not.toContain(sandboxHome)
		// MUST preserve the original extension.
		expect(savedPath.endsWith('.jpg')).toBe(true)
		// And the {uuid} segment must be non-empty.
		const tail = savedPath.slice('difile://_store/'.length)
		expect(tail.length).toBeGreaterThan(4)
	})

	it('the file saved by fsSaveFile is readable back through fsReadFile and bytes match', async () => {
		const original = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05])
		const srcReal = nodePath.join(filesBase(), 'roundtrip.bin')
		nodeFs.writeFileSync(srcReal, original)

		const save = await invoke('fsSaveFile', { tempFilePath: 'difile://roundtrip.bin' })
		expect(save.fail).toBeUndefined()
		const savedPath = String((save.success as { savedFilePath?: unknown }).savedFilePath ?? '')
		expect(savedPath.startsWith('difile://_store/')).toBe(true)

		const read = await invoke('fsReadFile', { filePath: savedPath })
		expect(read.fail).toBeUndefined()
		const data = (read.success as { data?: unknown }).data
		// fs.readFile without encoding returns a Buffer; ensure bytewise equal.
		expect(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)).toEqual(original)
	})
})

// ─── 4. FSM read-class dispatch ──────────────────────────────────────────────
//
// Read-class FSM entries dispatch by vpath kind (docs/file-system.md §6):
//
//   - `_tmp/<id>`   → bytes pulled from the renderer Blob Map (temp-files.ts)
//   - `_store/<id>` → bytes pulled from the main-process disk (~/.dimina/files/_store)
//   - `<usr-rel>`   → bytes pulled from the user-data area (~/.dimina/files/<rel>)
//
// In jsdom we exercise the two backends in the same process: the renderer Map
// for `_tmp` (via `registerTempFilePath`) and the real Node fs under the
// sandboxed `DIMINA_HOME` for `_store` / `usr`. Tests assert byte-equality
// after a full FSM round-trip, NOT internal IPC plumbing — so the impl is
// free to do main IPC OR a direct renderer fs read.
//
// Affordances:
//   - `_tmp` reads must succeed once a Blob is registered under that URL.
//   - `_tmp` reads of an unknown URL must surface an ENOENT-shaped fail.
//   - `_store` / `usr` reads must successfully round-trip from real disk.
//   - `fsReaddir` on `_tmp` and `_store` must fail — those namespaces are
//     flat (no dir tree) per the design note in §3.1.

function md5HexOf(buf: Buffer): string {
	return nodeCrypto.createHash('md5').update(buf).digest('hex')
}

function asBuffer(data: unknown): Buffer {
	if (Buffer.isBuffer(data)) return data
	if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data))
	if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
	throw new Error('fsReadFile returned unexpected data shape: ' + Object.prototype.toString.call(data))
}

describe('FSM read-class dispatch', () => {
	describe('fsReadFile', () => {
		it('reads bytes from a _tmp/* Blob registered in the renderer Map', async () => {
			const original = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x01, 0x02])
			const url = 'difile://_tmp/read-tmp-hit.bin'
			registerTempFilePath(url, new Blob([new Uint8Array(original)], { type: 'application/octet-stream' }))

			const r = await invoke('fsReadFile', { filePath: url })

			expect(r.fail).toBeUndefined()
			expect(r.success).toBeDefined()
			const data = (r.success as { data?: unknown }).data
			expect(asBuffer(data).equals(original)).toBe(true)
		})

		it('fails with an ENOENT-shaped error when the _tmp/* entry is unknown', async () => {
			// A missing _tmp entry must surface a real not-found error, not a
			// blanket "not supported" message — that string is wrong for this
			// namespace.
			const r = await invoke('fsReadFile', { filePath: 'difile://_tmp/never-registered.bin' })
			expect(r.success).toBeUndefined()
			expect(r.fail).toBeDefined()
			const msg = getErrMsg(r.fail)
			expect(msg).toMatch(/fsReadFile:fail/)
			expect(msg).toMatch(/ENOENT|not found|no such file/i)
			expect(msg).not.toMatch(/not supported|Phase 0/i)
		})

		it('reads bytes from a _store/<id> entry sitting on real disk', async () => {
			const id = nodeCrypto.randomUUID() + '.png'
			const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xee])
			nodeFs.writeFileSync(nodePath.join(filesBase(), '_store', id), original)

			const r = await invoke('fsReadFile', { filePath: `difile://_store/${id}` })

			expect(r.fail).toBeUndefined()
			const data = (r.success as { data?: unknown }).data
			expect(asBuffer(data).equals(original)).toBe(true)
		})

		it('reads bytes from a difile://<usr-rel> file on real disk', async () => {
			const original = Buffer.from('user-area-content', 'utf8')
			nodeFs.writeFileSync(nodePath.join(filesBase(), 'usr-read.txt'), original)

			const r = await invoke('fsReadFile', { filePath: 'difile://usr-read.txt' })

			expect(r.fail).toBeUndefined()
			const data = (r.success as { data?: unknown }).data
			expect(asBuffer(data).equals(original)).toBe(true)
		})

		it('fails with an ENOENT-shaped error when a usr path does not exist', async () => {
			const r = await invoke('fsReadFile', { filePath: 'difile://no-such-usr-file.bin' })
			expect(r.success).toBeUndefined()
			expect(r.fail).toBeDefined()
			expect(getErrMsg(r.fail)).toMatch(/ENOENT|no such file/i)
		})
	})

	describe('fsStat', () => {
		it('reports size + isFile=true for a _tmp/* Blob (mtime may be 0)', async () => {
			const original = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07])
			const url = 'difile://_tmp/stat-tmp.bin'
			registerTempFilePath(url, new Blob([new Uint8Array(original)], { type: 'application/octet-stream' }))

			const r = await invoke('fsStat', { path: url })

			expect(r.fail).toBeUndefined()
			const stats = (r.success as { stats?: Record<string, unknown> }).stats
			expect(stats).toBeDefined()
			expect(stats!.size).toBe(original.length)
			expect(stats!.isFile).toBe(true)
			expect(stats!.isDirectory).toBe(false)
		})

		it('reports stat info for a _store/<id> disk entry', async () => {
			const id = nodeCrypto.randomUUID() + '.bin'
			const bytes = Buffer.alloc(42, 0x55)
			nodeFs.writeFileSync(nodePath.join(filesBase(), '_store', id), bytes)

			const r = await invoke('fsStat', { path: `difile://_store/${id}` })

			expect(r.fail).toBeUndefined()
			const stats = (r.success as { stats?: Record<string, unknown> }).stats
			expect(stats!.size).toBe(42)
			expect(stats!.isFile).toBe(true)
		})

		it('reports stat info for a usr-area file', async () => {
			nodeFs.writeFileSync(nodePath.join(filesBase(), 'stat-usr.txt'), 'hello')
			const r = await invoke('fsStat', { path: 'difile://stat-usr.txt' })
			expect(r.fail).toBeUndefined()
			const stats = (r.success as { stats?: Record<string, unknown> }).stats
			expect(stats!.size).toBe(5)
			expect(stats!.isFile).toBe(true)
		})

		it('fails when _tmp/* is not registered', async () => {
			const r = await invoke('fsStat', { path: 'difile://_tmp/no-stat.bin' })
			expect(r.success).toBeUndefined()
			expect(r.fail).toBeDefined()
			expect(getErrMsg(r.fail)).toMatch(/ENOENT|not found|no such file/i)
		})
	})

	describe('fsAccess', () => {
		it('succeeds for a registered _tmp/* URL', async () => {
			const url = 'difile://_tmp/access-tmp.bin'
			registerTempFilePath(url, new Blob(['x'], { type: 'application/octet-stream' }))
			const r = await invoke('fsAccess', { path: url })
			expect(r.fail).toBeUndefined()
			expect(getErrMsg(r.success)).toBe('fsAccess:ok')
		})

		it('fails for an unknown _tmp/* URL', async () => {
			const r = await invoke('fsAccess', { path: 'difile://_tmp/access-miss.bin' })
			expect(r.success).toBeUndefined()
			expect(r.fail).toBeDefined()
			expect(getErrMsg(r.fail)).toMatch(/ENOENT|no such file|not found/i)
		})

		it('succeeds for an existing _store/* disk file', async () => {
			const id = nodeCrypto.randomUUID() + '.bin'
			nodeFs.writeFileSync(nodePath.join(filesBase(), '_store', id), 'x')
			const r = await invoke('fsAccess', { path: `difile://_store/${id}` })
			expect(r.fail).toBeUndefined()
			expect(getErrMsg(r.success)).toBe('fsAccess:ok')
		})

		it('fails for an unknown _store/* disk path', async () => {
			const r = await invoke('fsAccess', { path: `difile://_store/${nodeCrypto.randomUUID()}.bin` })
			expect(r.success).toBeUndefined()
			expect(getErrMsg(r.fail)).toMatch(/ENOENT|no such file/i)
		})
	})

	describe('fsGetFileInfo', () => {
		it('returns size + md5 digest for a _tmp/* Blob', async () => {
			const original = Buffer.from('content-to-digest-' + nodeCrypto.randomUUID(), 'utf8')
			const url = 'difile://_tmp/digest-tmp.bin'
			registerTempFilePath(url, new Blob([new Uint8Array(original)], { type: 'application/octet-stream' }))

			const r = await invoke('fsGetFileInfo', { filePath: url, digestAlgorithm: 'md5' })

			expect(r.fail).toBeUndefined()
			const payload = r.success as { size?: number; digest?: string }
			expect(payload.size).toBe(original.length)
			expect(payload.digest).toBe(md5HexOf(original))
		})

		it('returns size + md5 digest for a _store/* disk file', async () => {
			const id = nodeCrypto.randomUUID() + '.bin'
			const bytes = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x11, 0x22, 0x33])
			nodeFs.writeFileSync(nodePath.join(filesBase(), '_store', id), bytes)

			const r = await invoke('fsGetFileInfo', {
				filePath: `difile://_store/${id}`,
				digestAlgorithm: 'md5',
			})

			expect(r.fail).toBeUndefined()
			const payload = r.success as { size?: number; digest?: string }
			expect(payload.size).toBe(bytes.length)
			expect(payload.digest).toBe(md5HexOf(bytes))
		})

		it('returns size + md5 digest for a usr-area file', async () => {
			const bytes = Buffer.from('usr-digest-' + nodeCrypto.randomUUID(), 'utf8')
			nodeFs.writeFileSync(nodePath.join(filesBase(), 'digest-usr.txt'), bytes)

			const r = await invoke('fsGetFileInfo', {
				filePath: 'difile://digest-usr.txt',
				digestAlgorithm: 'md5',
			})

			expect(r.fail).toBeUndefined()
			const payload = r.success as { size?: number; digest?: string }
			expect(payload.size).toBe(bytes.length)
			expect(payload.digest).toBe(md5HexOf(bytes))
		})
	})

	describe('fsReaddir', () => {
		it('fails on a _tmp/* path — _tmp is a flat namespace (no dir tree)', async () => {
			const url = 'difile://_tmp/somedir'
			// Even with an entry parked at this URL, readdir on _tmp must fail —
			// _tmp has no notion of a directory.
			registerTempFilePath(url, new Blob(['x']))
			const r = await invoke('fsReaddir', { dirPath: url })
			expect(r.success).toBeUndefined()
			expect(r.fail).toBeDefined()
			expect(getErrMsg(r.fail)).toMatch(/fsReaddir:fail/)
		})

		it('fails on a _store/* path — _store is a flat namespace (no dir tree)', async () => {
			// Even if a directory happens to exist on disk under _store, readdir
			// at a _store/<id> position is meaningless — _store entries are
			// addressed by id, not by path traversal.
			const subdir = nodePath.join(filesBase(), '_store', 'sub')
			nodeFs.mkdirSync(subdir, { recursive: true })
			nodeFs.writeFileSync(nodePath.join(subdir, 'a.bin'), 'x')

			const r = await invoke('fsReaddir', { dirPath: 'difile://_store/sub' })
			expect(r.success).toBeUndefined()
			expect(r.fail).toBeDefined()
			expect(getErrMsg(r.fail)).toMatch(/fsReaddir:fail/)
		})

		it('lists immediate children of a usr-area directory', async () => {
			const dir = nodePath.join(filesBase(), 'readdir-usr')
			nodeFs.mkdirSync(dir, { recursive: true })
			nodeFs.writeFileSync(nodePath.join(dir, 'a.txt'), 'a')
			nodeFs.writeFileSync(nodePath.join(dir, 'b.txt'), 'b')

			const r = await invoke('fsReaddir', { dirPath: 'difile://readdir-usr' })

			expect(r.fail).toBeUndefined()
			const files = (r.success as { files?: unknown[] }).files
			expect(Array.isArray(files)).toBe(true)
			expect([...(files as string[])].sort()).toEqual(['a.txt', 'b.txt'])
		})
	})
})

// ─── 5. fsCopyFile materialization ───────────────────────────────────────────

describe('fsCopyFile materialization', () => {
	it('copies a _tmp/* Blob into a usr-area destination (materializes the bytes)', async () => {
		const original = Buffer.from([0x10, 0x20, 0x30, 0x40, 0x50])
		const srcUrl = 'difile://_tmp/copy-src.bin'
		registerTempFilePath(srcUrl, new Blob([new Uint8Array(original)], { type: 'application/octet-stream' }))

		const r = await invoke('fsCopyFile', {
			srcPath: srcUrl,
			destPath: 'difile://copy-dest.bin',
		})

		expect(r.fail).toBeUndefined()
		expect(getErrMsg(r.success)).toBe('fsCopyFile:ok')

		// And the destination file truly carries the source bytes.
		const onDisk = nodeFs.readFileSync(nodePath.join(filesBase(), 'copy-dest.bin'))
		expect(onDisk.equals(original)).toBe(true)
	})

	it('rejects a _tmp/* source when the destination is itself in _tmp', async () => {
		// dest is runtime-owned and not writable; even with a valid _tmp src
		// the copy must refuse on the dest side.
		registerTempFilePath('difile://_tmp/src-x.bin', new Blob(['x']))
		const r = await invoke('fsCopyFile', {
			srcPath: 'difile://_tmp/src-x.bin',
			destPath: 'difile://_tmp/dest-x.bin',
		})
		expect(r.success).toBeUndefined()
		expect(r.fail).toBeDefined()
		expect(getErrMsg(r.fail)).toMatch(/permission denied/i)
	})

	it('rejects a _tmp/* source when the destination is in _store', async () => {
		// _store is also runtime-owned for the user-area write API — the
		// documented entry point for tmp→store is fsSaveFile, NOT copyFile.
		registerTempFilePath('difile://_tmp/src-y.bin', new Blob(['x']))
		const r = await invoke('fsCopyFile', {
			srcPath: 'difile://_tmp/src-y.bin',
			destPath: 'difile://_store/dest-y.bin',
		})
		expect(r.success).toBeUndefined()
		expect(r.fail).toBeDefined()
		expect(getErrMsg(r.fail)).toMatch(/permission denied/i)
	})

	it('copies between two usr-area paths (regression for non-_tmp source)', async () => {
		const original = Buffer.from('usr-copy-' + nodeCrypto.randomUUID(), 'utf8')
		nodeFs.writeFileSync(nodePath.join(filesBase(), 'usr-a.bin'), original)

		const r = await invoke('fsCopyFile', {
			srcPath: 'difile://usr-a.bin',
			destPath: 'difile://usr-b.bin',
		})
		expect(r.fail).toBeUndefined()
		expect(getErrMsg(r.success)).toBe('fsCopyFile:ok')
		const onDisk = nodeFs.readFileSync(nodePath.join(filesBase(), 'usr-b.bin'))
		expect(onDisk.equals(original)).toBe(true)
	})

	it('fails when the _tmp/* source has no Blob registered', async () => {
		const r = await invoke('fsCopyFile', {
			srcPath: 'difile://_tmp/never-registered.bin',
			destPath: 'difile://orphan-dest.bin',
		})
		expect(r.success).toBeUndefined()
		expect(r.fail).toBeDefined()
		expect(getErrMsg(r.fail)).toMatch(/ENOENT|not found|no such file/i)
		// And the destination was NOT created as an empty file.
		expect(nodeFs.existsSync(nodePath.join(filesBase(), 'orphan-dest.bin'))).toBe(false)
	})
})
