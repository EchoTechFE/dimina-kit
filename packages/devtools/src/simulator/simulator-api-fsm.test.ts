/**
 * Contract tests for the container-side `wx.getFileSystemManager()` async
 * surface (see `docs/file-system.md` for the vpath scheme).
 *
 * Public protocol under test (see `simulator-api.ts`'s `simulatorApis` map,
 * which is registered 1:1 as container API handlers via
 * `SimulatorMiniApp.registerApi(name, handler)` — the `name` is exactly the
 * service-thread `invokeAPI` wire name):
 *
 *   1. Every one of the 16 async `FileSystemManager.*` methods (access, stat,
 *      readFile, writeFile, appendFile, copyFile, rename, unlink, mkdir,
 *      rmdir, readdir, getFileInfo, saveFile, getSavedFileList,
 *      removeSavedFile, truncate) must be registered under the DOTTED wire
 *      name `FileSystemManager.<method>` — not a bare `fs<Method>` name that
 *      no invokeAPI call can ever address.
 *   2. Handlers use the wx short errMsg convention: `writeFile:ok`,
 *      `readFile:fail <reason>`, etc — never a `fs<Method>:` or
 *      `FileSystemManager.<method>:` prefixed variant.
 *   3. Write-class payloads accept a `{ __diminaFileDataType: 'base64',
 *      __diminaFileDataBase64: <b64> }` sentinel (the service thread's
 *      ArrayBuffer encoding) and decode it to real bytes on disk.
 *   4. `readFile` without `encoding` answers a `{ __diminaArrayBufferBase64:
 *      <b64> }` sentinel so the service thread can decode it back to an
 *      ArrayBuffer; with `encoding` it answers a plain string.
 *   5. Illegal / unresolvable paths (non-`difile://` scheme, empty string,
 *      a file that does not exist) fail instead of silently succeeding.
 *
 * Sandbox: `resolveVPath`'s `sandboxBase()` reads `process.env.DIMINA_HOME`
 * dynamically on every call (see `packages/dimina-electron-runtime/src/shared/vpath.ts`),
 * so each test gets an isolated `<tmp>/files` base without touching the
 * developer's real `~/.dimina`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as nodeFs from 'node:fs'
import * as nodePath from 'node:path'
import * as nodeOs from 'node:os'
import type { MiniAppContext } from './types'
import { simulatorApis } from './simulator-api'

/** The full documented async FSM surface (short method names, no `Sync` suffix). */
const ASYNC_FSM_METHODS = [
	'access', 'stat', 'readFile', 'writeFile', 'appendFile', 'copyFile',
	'rename', 'unlink', 'mkdir', 'rmdir', 'readdir', 'getFileInfo',
	'saveFile', 'getSavedFileList', 'removeSavedFile', 'truncate',
] as const

const ARRAY_BUFFER_BASE64_KEY = '__diminaArrayBufferBase64'
const FILE_DATA_TYPE_KEY = '__diminaFileDataType'
const FILE_DATA_BASE64_KEY = '__diminaFileDataBase64'

function wireName(method: string): string {
	return `FileSystemManager.${method}`
}

function getHandler(method: string): (this: MiniAppContext, opts: Record<string, unknown>) => void {
	const handler = (simulatorApis as Record<string, unknown>)[wireName(method)]
	if (typeof handler !== 'function') {
		throw new Error(`simulatorApis['${wireName(method)}'] is not registered as a function (got ${typeof handler})`)
	}
	return handler as (this: MiniAppContext, opts: Record<string, unknown>) => void
}

function makeContext(): MiniAppContext {
	return {
		appId: 'test-app',
		createCallbackFunction: vi.fn((fn: unknown) =>
			typeof fn === 'function' ? (fn as (...args: unknown[]) => void) : undefined,
		),
	} as unknown as MiniAppContext
}

interface InvokeResult { success?: unknown; fail?: unknown; complete: boolean }

/** Call a registered FSM handler and resolve with whichever wx callback fired. */
function invoke(method: string, args: Record<string, unknown>): Promise<InvokeResult> {
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
		let handler: (this: MiniAppContext, opts: Record<string, unknown>) => void
		try {
			handler = getHandler(method)
		} catch (err) {
			resolve({ fail: { errMsg: (err as Error).message }, complete: false })
			return
		}
		const success = vi.fn((r: unknown) => { successResult = r })
		const fail = vi.fn((r: unknown) => { failResult = r })
		const complete = vi.fn(() => { didComplete = true; settle() })
		// Fail-safe: some handler bodies may never call `complete` (a bug this
		// suite exists to catch) — settle anyway so the test reports what DID
		// fire instead of hanging.
		setTimeout(settle, 500)
		handler.call(makeContext(), { ...args, success, fail, complete })
	})
}

function getErrMsg(payload: unknown): string {
	if (payload && typeof payload === 'object' && 'errMsg' in payload) {
		return String((payload as { errMsg: unknown }).errMsg)
	}
	return ''
}

function toBase64(bytes: number[]): string {
	return Buffer.from(bytes).toString('base64')
}

// ─── sandbox lifecycle ───────────────────────────────────────────────────

let sandboxHome: string

function usrDir(): string {
	return nodePath.join(sandboxHome, 'files', 'usr')
}

beforeEach(() => {
	sandboxHome = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dimina-fsm-test-'))
	process.env.DIMINA_HOME = sandboxHome
	nodeFs.mkdirSync(usrDir(), { recursive: true })
})

afterEach(() => {
	delete process.env.DIMINA_HOME
	if (sandboxHome && nodeFs.existsSync(sandboxHome)) {
		nodeFs.rmSync(sandboxHome, { recursive: true, force: true })
	}
	vi.restoreAllMocks()
})

// ─── 1. registry: every async method registered under the dotted wire name ──

describe('simulatorApis registers the FileSystemManager.* invokeAPI wire names', () => {
	it.each(ASYNC_FSM_METHODS)('registers a handler at "FileSystemManager.%s"', (method) => {
		const handler = (simulatorApis as Record<string, unknown>)[wireName(method)]
		expect(typeof handler, `simulatorApis['${wireName(method)}'] should be a function`).toBe('function')
	})
})

// ─── 2 & 5. string round trip + errMsg convention + path validation ─────────

describe('writeFile / readFile string round trip', () => {
	it('writeFile(encoding:"utf8") succeeds with errMsg "writeFile:ok" (not "fsWriteFile:ok")', async () => {
		const w = await invoke('writeFile', { filePath: 'difile://usr/fsm-str.txt', data: 'hello-fsm', encoding: 'utf8' })
		expect(w.fail, `writeFile failed: ${JSON.stringify(w.fail)}`).toBeUndefined()
		expect(w.success).toMatchObject({ errMsg: 'writeFile:ok' })
	})

	it('readFile(encoding:"utf8") reads back the exact string with errMsg "readFile:ok"', async () => {
		await invoke('writeFile', { filePath: 'difile://usr/fsm-str2.txt', data: 'round-trip-me', encoding: 'utf8' })
		const r = await invoke('readFile', { filePath: 'difile://usr/fsm-str2.txt', encoding: 'utf8' })
		expect(r.fail, `readFile failed: ${JSON.stringify(r.fail)}`).toBeUndefined()
		expect(r.success).toMatchObject({ errMsg: 'readFile:ok', data: 'round-trip-me' })
	})

	it('readFile of a nonexistent file fails with errMsg "readFile:fail ..." (never silently succeeds)', async () => {
		const r = await invoke('readFile', { filePath: 'difile://usr/does-not-exist.txt', encoding: 'utf8' })
		expect(r.success, 'readFile of a missing file must not succeed').toBeUndefined()
		expect(r.fail).toBeDefined()
		expect(getErrMsg(r.fail)).toMatch(/^readFile:fail /)
	})

	it.each([
		['a dataURL', 'data:text/plain;base64,aGVsbG8='],
		['an empty string', ''],
		['a bare http URL', 'http://example.com/x.txt'],
	])('writeFile rejects %s as filePath instead of writing it', async (_label, badPath) => {
		const w = await invoke('writeFile', { filePath: badPath, data: 'x', encoding: 'utf8' })
		expect(w.success, `writeFile should not succeed for filePath ${JSON.stringify(badPath)}`).toBeUndefined()
		expect(w.fail).toBeDefined()
		expect(getErrMsg(w.fail)).toMatch(/^writeFile:fail /)
	})
})

// ─── 3 & 4. binary payload: base64 sentinel encode/decode both directions ───

describe('writeFile / readFile binary (ArrayBuffer <-> base64 sentinel) round trip', () => {
	it('writeFile decodes a __diminaFileDataBase64 sentinel to the exact bytes on disk', async () => {
		const bytes = [1, 2, 3, 250]
		const w = await invoke('writeFile', {
			filePath: 'difile://usr/fsm-bin.bin',
			data: { [FILE_DATA_TYPE_KEY]: 'base64', [FILE_DATA_BASE64_KEY]: toBase64(bytes) },
		})
		expect(w.fail, `writeFile failed: ${JSON.stringify(w.fail)}`).toBeUndefined()
		expect(w.success).toMatchObject({ errMsg: 'writeFile:ok' })

		const onDisk = nodeFs.readFileSync(nodePath.join(usrDir(), 'fsm-bin.bin'))
		expect(Array.from(onDisk)).toEqual(bytes)
	})

	it('readFile without encoding answers a __diminaArrayBufferBase64 sentinel, not a raw Buffer/string', async () => {
		const bytes = [9, 8, 7, 6]
		nodeFs.writeFileSync(nodePath.join(usrDir(), 'fsm-bin2.bin'), Buffer.from(bytes))

		const r = await invoke('readFile', { filePath: 'difile://usr/fsm-bin2.bin' })
		expect(r.fail, `readFile failed: ${JSON.stringify(r.fail)}`).toBeUndefined()
		const data = (r.success as { data?: unknown } | undefined)?.data
		expect(data, 'readFile without encoding must not answer a raw string/Buffer').toMatchObject({
			[ARRAY_BUFFER_BASE64_KEY]: toBase64(bytes),
		})
	})

	it('a byte round trip through writeFile(sentinel) -> readFile(no encoding) preserves every byte', async () => {
		const bytes = [0, 1, 2, 253, 254, 255]
		await invoke('writeFile', {
			filePath: 'difile://usr/fsm-bin3.bin',
			data: { [FILE_DATA_TYPE_KEY]: 'base64', [FILE_DATA_BASE64_KEY]: toBase64(bytes) },
		})
		const r = await invoke('readFile', { filePath: 'difile://usr/fsm-bin3.bin' })
		const data = (r.success as { data?: { [ARRAY_BUFFER_BASE64_KEY]: string } } | undefined)?.data
		expect(data?.[ARRAY_BUFFER_BASE64_KEY]).toBe(toBase64(bytes))
	})
})

// ─── 6. a synchronous throw inside a handler must surface as fail(), never leak ──

describe('a handler that throws synchronously reports fail with the wx short errMsg, not an uncaught exception', () => {
	it('appendFile given a non-string/Buffer `data` (Node throws ERR_INVALID_ARG_TYPE synchronously) reports fail "appendFile:fail ..." and completes exactly once', async () => {
		// appendFile calls the corresponding Node fs function directly in the
		// same synchronous tick as the handler invocation (unlike writeFile,
		// which defers its `_fs.writeFile` call into an async `fs.mkdir`
		// completion callback — a throw there becomes an unhandled process
		// exception outside any promise this test could observe). Both share
		// the same missing try/catch; appendFile exercises the identical
		// defect deterministically. Today `invoke(...)` itself rejects (the
		// throw escapes the handler and is caught by the Promise executor,
		// not by any `fail()` callback), so this `await` is expected to throw.
		const r = await invoke('appendFile', { filePath: 'difile://usr/fsm-throw.txt', data: 123 })
		expect(r.success, 'must not succeed when the underlying fs call throws').toBeUndefined()
		expect(r.fail, 'a synchronous throw inside the handler must surface as fail(), not an uncaught exception').toBeDefined()
		expect(getErrMsg(r.fail)).toMatch(/^appendFile:fail /)
		expect(getErrMsg(r.fail)).not.toMatch(/^FileSystemManager\.appendFile:/)
		expect(getErrMsg(r.fail)).not.toMatch(/^fsAppendFile:/)
		expect(r.complete, 'complete must still fire exactly once').toBe(true)
	})
})

// ─── 7. fsStat: timestamp units + recursive stats map shape (real-device parity) ──
//
// Contract corrected against dimina native source (Android FileApi.kt:400,
// iOS FileAPI.swift:523) and wx's documented FileSystemManager.stat: a
// recursive stat's map keys the queried directory itself as "." alongside
// its descendants (relativeTo-style relative paths), and every
// lastAccessedTime/lastModifiedTime is a SECONDS-unit epoch (both native
// backends divide by 1000 / use timeIntervalSince1970), not milliseconds.

/**
 * True when `value` looks like a Unix epoch in SECONDS, not milliseconds. A
 * millisecond value (Node's `Stats.atimeMs`/`mtimeMs`) is ~1000x this
 * magnitude and fails the 1-hour tolerance below.
 */
function isSecondsEpoch(value: unknown): boolean {
	return typeof value === 'number' && Math.abs(value - Date.now() / 1000) < 3600
}

describe('fsStat reports lastAccessedTime / lastModifiedTime in seconds, not milliseconds', () => {
	it('a single (non-recursive) stat reports second-unit timestamps', async () => {
		nodeFs.writeFileSync(nodePath.join(usrDir(), 'fsm-stat-single.txt'), 'x')
		const r = await invoke('stat', { path: 'difile://usr/fsm-stat-single.txt' })
		expect(r.fail, `stat failed: ${JSON.stringify(r.fail)}`).toBeUndefined()
		const stats = (r.success as { stats?: { lastAccessedTime?: unknown; lastModifiedTime?: unknown } } | undefined)?.stats
		expect(stats, 'stat must return a stats object').toBeDefined()
		expect(isSecondsEpoch(stats!.lastModifiedTime), `lastModifiedTime ${stats!.lastModifiedTime} is not a seconds-unit epoch`).toBe(true)
		expect(isSecondsEpoch(stats!.lastAccessedTime), `lastAccessedTime ${stats!.lastAccessedTime} is not a seconds-unit epoch`).toBe(true)
	})
})

describe('fsStat recursive: stats map keys are vpath-relative and include the root "." entry', () => {
	it('a nested directory tree produces a complete, relatively-keyed stats map with second-unit timestamps', async () => {
		nodeFs.mkdirSync(nodePath.join(usrDir(), 'a'), { recursive: true })
		nodeFs.writeFileSync(nodePath.join(usrDir(), 'a', 'b.txt'), 'x')
		nodeFs.writeFileSync(nodePath.join(usrDir(), 'c.txt'), 'y')

		const r = await invoke('stat', { path: 'difile://usr', recursive: true })
		expect(r.fail, `stat failed: ${JSON.stringify(r.fail)}`).toBeUndefined()
		const stats = (r.success as {
			stats?: Record<string, { isFile?: boolean; isDirectory?: boolean; lastModifiedTime?: unknown; lastAccessedTime?: unknown }>
		} | undefined)?.stats
		expect(stats, 'recursive stat must return a stats map').toBeDefined()
		const keys = Object.keys(stats!)

		// Root self-entry: real dimina clients key the queried directory itself
		// as "." alongside its descendants.
		expect(keys, `stats map keys: ${JSON.stringify(keys)}`).toContain('.')
		expect(stats!['.']?.isDirectory).toBe(true)

		// Completeness: every entry created above must be present under a
		// relative key. A stat() failure on one entry silently dropping it from
		// the map (rather than failing the whole call) would shrink this set.
		expect(new Set(keys)).toEqual(new Set(['.', 'a', 'a/b.txt', 'c.txt']))

		for (const [key, info] of Object.entries(stats!)) {
			expect(key.startsWith('/'), `stats map key "${key}" must be vpath-relative, not host-absolute`).toBe(false)
			expect(key.includes(sandboxHome), `stats map key "${key}" leaks the host sandbox path`).toBe(false)
			expect(isSecondsEpoch(info.lastModifiedTime), `"${key}".lastModifiedTime ${info.lastModifiedTime} is not seconds-unit`).toBe(true)
			expect(isSecondsEpoch(info.lastAccessedTime), `"${key}".lastAccessedTime ${info.lastAccessedTime} is not seconds-unit`).toBe(true)
		}
	})
})

// ─── 8. getSavedFileList must not swallow a real (non-ENOENT) readdir error ──

describe('getSavedFileList reports fail on a real readdir error, not just ENOENT', () => {
	it('difile://_store missing entirely still succeeds with an empty list (existing behavior)', async () => {
		const r = await invoke('getSavedFileList', {})
		expect(r.fail, `getSavedFileList failed: ${JSON.stringify(r.fail)}`).toBeUndefined()
		expect(r.success).toMatchObject({ errMsg: 'getSavedFileList:ok', fileList: [] })
	})

	it('difile://_store existing as a FILE (ENOTDIR on readdir) reports fail, not a silent empty success', async () => {
		// A stray file where the store directory should be is a directory-walk
		// failure that is NOT "the directory doesn't exist yet" and must not be
		// swallowed into the same "empty list" success the ENOENT case reports.
		nodeFs.writeFileSync(nodePath.join(sandboxHome, 'files', '_store'), 'not a directory')
		const r = await invoke('getSavedFileList', {})
		expect(r.success, 'a non-ENOENT readdir error must not report success').toBeUndefined()
		expect(r.fail).toBeDefined()
		expect(getErrMsg(r.fail)).toMatch(/^getSavedFileList:fail /)
	})
})

// ─── 9. getFileInfo digest defaults to md5 and supports sha1 (real-device parity) ──
//
// wx / all three dimina native backends (Android FileApi.kt:373 `optString
// ("digestAlgorithm", "md5")`, iOS FileAPI.swift:324, Harmony) default
// digestAlgorithm to 'md5' rather than omitting the digest when the caller
// doesn't pass one. "crypto unavailable -> fail" is not exercised here: it
// cannot be simulated reliably in a Node test environment where crypto is
// always available.

describe('getFileInfo digest defaults to md5 and supports sha1', () => {
	it('digestAlgorithm omitted still returns a 32-hex md5 digest', async () => {
		nodeFs.writeFileSync(nodePath.join(usrDir(), 'digest-default.bin'), Buffer.from([1, 2, 3]))
		const r = await invoke('getFileInfo', { filePath: 'difile://usr/digest-default.bin' })
		expect(r.fail, `getFileInfo failed: ${JSON.stringify(r.fail)}`).toBeUndefined()
		const digest = (r.success as { digest?: unknown } | undefined)?.digest
		expect(typeof digest, `expected a digest field, got success ${JSON.stringify(r.success)}`).toBe('string')
		expect(digest).toMatch(/^[0-9a-f]{32}$/)
	})

	it('digestAlgorithm: "sha1" returns a 40-hex sha1 digest', async () => {
		nodeFs.writeFileSync(nodePath.join(usrDir(), 'digest-sha1.bin'), Buffer.from([4, 5, 6]))
		const r = await invoke('getFileInfo', { filePath: 'difile://usr/digest-sha1.bin', digestAlgorithm: 'sha1' })
		expect(r.fail, `getFileInfo failed: ${JSON.stringify(r.fail)}`).toBeUndefined()
		const digest = (r.success as { digest?: unknown } | undefined)?.digest
		expect(typeof digest).toBe('string')
		expect(digest).toMatch(/^[0-9a-f]{40}$/)
	})

	// Guards the current, deliberate fallback: any digestAlgorithm value other
	// than the literal "sha1" (a typo, an unsupported algorithm name, etc)
	// silently produces an md5 digest instead of failing the call — matching
	// all three dimina native FileSystemManager backends (Android FileApi.kt,
	// iOS FileAPI.swift, Harmony), which likewise treat any non-"sha1" value
	// as "use md5" rather than validating the algorithm name. This test exists
	// so a future "throw/fail on unknown digestAlgorithm" change is caught as
	// a deliberate behavior change, not an accidental regression.
	it('an unrecognized digestAlgorithm falls back to md5 instead of failing', async () => {
		nodeFs.writeFileSync(nodePath.join(usrDir(), 'digest-typo.bin'), Buffer.from([7, 8, 9]))
		const r = await invoke('getFileInfo', { filePath: 'difile://usr/digest-typo.bin', digestAlgorithm: 'sha-256-typo' })
		expect(r.fail, `getFileInfo failed: ${JSON.stringify(r.fail)}`).toBeUndefined()
		const digest = (r.success as { digest?: unknown } | undefined)?.digest
		expect(typeof digest, `expected a digest field, got success ${JSON.stringify(r.success)}`).toBe('string')
		expect(digest).toMatch(/^[0-9a-f]{32}$/)
		expect(r.complete).toBe(true)
	})
})

// ─── rmdir: the recursive flag selects the correct Node primitive ──────────
//
// `fs.rm(dir, { recursive: false })` refuses directories outright
// (ERR_FS_EISDIR) — even empty ones — while wx's non-recursive
// `FileSystemManager.rmdir` removes an empty directory and fails only on a
// non-empty one. The two cases need different primitives: `fs.rmdir` for
// non-recursive, `fs.rm(recursive: true)` for recursive.

describe('rmdir honors the recursive flag', () => {
	it('rmdir without recursive removes an EMPTY directory', async () => {
		nodeFs.mkdirSync(nodePath.join(usrDir(), 'empty-dir'))
		const r = await invoke('rmdir', { dirPath: 'difile://usr/empty-dir' })
		expect(r.fail, `rmdir of an empty dir failed: ${JSON.stringify(r.fail)}`).toBeUndefined()
		expect(r.success).toMatchObject({ errMsg: 'rmdir:ok' })
		expect(nodeFs.existsSync(nodePath.join(usrDir(), 'empty-dir'))).toBe(false)
	})

	it('rmdir without recursive fails on a NON-empty directory (only recursive removes contents)', async () => {
		nodeFs.mkdirSync(nodePath.join(usrDir(), 'full-dir'))
		nodeFs.writeFileSync(nodePath.join(usrDir(), 'full-dir', 'f.txt'), 'x')
		const r = await invoke('rmdir', { dirPath: 'difile://usr/full-dir' })
		expect(r.success, 'non-recursive rmdir of a non-empty dir must not succeed').toBeUndefined()
		expect(getErrMsg(r.fail)).toMatch(/^rmdir:fail /)
		expect(nodeFs.existsSync(nodePath.join(usrDir(), 'full-dir', 'f.txt'))).toBe(true)
	})

	it('rmdir with recursive:true removes a non-empty directory tree', async () => {
		nodeFs.mkdirSync(nodePath.join(usrDir(), 'tree', 'sub'), { recursive: true })
		nodeFs.writeFileSync(nodePath.join(usrDir(), 'tree', 'sub', 'f.txt'), 'x')
		const r = await invoke('rmdir', { dirPath: 'difile://usr/tree', recursive: true })
		expect(r.fail, `recursive rmdir failed: ${JSON.stringify(r.fail)}`).toBeUndefined()
		expect(nodeFs.existsSync(nodePath.join(usrDir(), 'tree'))).toBe(false)
	})
})

// ─── writeFile: malformed arguments settle as fail/complete, never an
// uncaught throw ───────────────────────────────────────────────────────────
//
// `fs.writeFile` validates its arguments synchronously — but the write is
// scheduled from inside the deferred `mkdir -p` callback, after the wire
// handler's own try/catch has already returned. Without a catch at the
// deferred call site, malformed `data`/`encoding` becomes an uncaught
// renderer exception and the mini-program call hangs with no verdict (the
// handler ACK has already disarmed the main-process watchdog by then).

describe('writeFile with malformed arguments settles instead of throwing uncaught', () => {
	it('writeFile(data: number) fails with "writeFile:fail ..." and completes', async () => {
		const r = await invoke('writeFile', { filePath: 'difile://usr/bad-data.txt', data: 12345 })
		expect(r.success, 'malformed data must not succeed').toBeUndefined()
		expect(getErrMsg(r.fail)).toMatch(/^writeFile:fail /)
		expect(r.complete).toBe(true)
	})

	it('writeFile with an unknown encoding fails with "writeFile:fail ..." and completes', async () => {
		const r = await invoke('writeFile', { filePath: 'difile://usr/bad-enc.txt', data: 'x', encoding: 'not-an-encoding' })
		expect(r.success, 'an unknown encoding must not succeed').toBeUndefined()
		expect(getErrMsg(r.fail)).toMatch(/^writeFile:fail /)
		expect(r.complete).toBe(true)
	})
})
