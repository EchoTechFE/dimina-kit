/**
 * Contract tests for the main-process `simulator:fs:*` IPC channel handlers.
 *
 * Spec: `packages/devtools/docs/file-system.md` §4.4, §6 P1-7.
 *
 *   simulator:fs:read    payload { realPath, range? }
 *                        → { bytes: ArrayBuffer | Buffer, mime, etag, totalSize }
 *   simulator:fs:write   payload { realPath, bytes: ArrayBuffer | Buffer }
 *                        → { ok: true }
 *   simulator:fs:stat    payload { realPath }
 *                        → DiskStat
 *   simulator:fs:readdir payload { realPath }
 *                        → string[]
 *   simulator:fs:unlink  payload { realPath }
 *                        → { ok: true }
 *   simulator:fs:mkdir   payload { realPath, recursive? }
 *                        → { ok: true }
 *
 * Electron's `ipcMain` is unreachable from vitest, so we test the *pure
 * handlers* exposed from `./fs-channels`:
 *
 *   handleFsRead(req): Promise<{ bytes, mime, etag, totalSize }>
 *   handleFsWrite(req): Promise<{ ok: true }>
 *   handleFsStat(req): Promise<DiskStat>
 *   handleFsReaddir(req): Promise<string[]>
 *   handleFsUnlink(req): Promise<{ ok: true }>
 *   handleFsMkdir(req): Promise<{ ok: true }>
 *
 * The Electron-side wiring (`registerFsChannels(simSession): Disposable`) is
 * deliberately NOT exercised here — that surface mirrors the existing
 * `setupSimulatorTempFiles` shape, including the simulator-session-only
 * `SenderPolicy`. The same policy plumbing is covered by
 * `update-manager-sender-policy.test.ts`.
 *
 * The handlers below must enforce the sandbox base themselves (path must lie
 * inside `~/.dimina/files/`, honouring `DIMINA_HOME`). This is defense in
 * depth: the renderer-side `resolveVPath` already canonicalises, but the IPC
 * boundary must not trust its caller — a hostile preload script could send
 * a `realPath` that points outside the base.
 *
 * Failures (ENOENT, sandbox escape, etc.) surface as rejected promises so
 * Electron's `ipcMain.handle` contract delivers them to the renderer as a
 * rejected `ipcRenderer.invoke`.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	handleFsMkdir,
	handleFsRead,
	handleFsReaddir,
	handleFsStat,
	handleFsUnlink,
	handleFsWrite,
} from './fs-channels'

// -- fixtures ---------------------------------------------------------------

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ETAG_RE = /^W\/"\d+-\d+"$/

let sandboxRoot: string
let sandboxBase: string
let savedHome: string | undefined

function rid(): string {
	return Math.random().toString(16).slice(2) + Date.now().toString(16)
}

async function mkTempSandbox(): Promise<{ root: string; base: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dimina-fs-chan-test-'))
	const base = path.join(root, 'files')
	await fs.mkdir(base, { recursive: true })
	return { root, base }
}

async function rmrf(p: string): Promise<void> {
	await fs.rm(p, { recursive: true, force: true })
}

beforeEach(async () => {
	savedHome = process.env.DIMINA_HOME
	const sb = await mkTempSandbox()
	sandboxRoot = sb.root
	sandboxBase = sb.base
	process.env.DIMINA_HOME = sandboxRoot
})

afterEach(async () => {
	if (savedHome === undefined) delete process.env.DIMINA_HOME
	else process.env.DIMINA_HOME = savedHome
	if (sandboxRoot) await rmrf(sandboxRoot)
})

function realOf(...segs: string[]): string {
	return path.join(sandboxBase, ...segs)
}

async function writeRaw(rel: string, bytes: Buffer): Promise<string> {
	const full = realOf(rel)
	await fs.mkdir(path.dirname(full), { recursive: true })
	await fs.writeFile(full, bytes)
	return full
}

// `Buffer` is also an `ArrayBufferView`; the contract allows either as the
// over-the-wire shape (Electron serialises both losslessly). We normalise to
// Buffer for byte-equality assertions.
function asBuffer(value: unknown): Buffer {
	if (Buffer.isBuffer(value)) return value
	if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value))
	if (ArrayBuffer.isView(value)) {
		const v = value as ArrayBufferView
		return Buffer.from(v.buffer, v.byteOffset, v.byteLength)
	}
	throw new Error('expected bytes-like, got ' + Object.prototype.toString.call(value))
}

// -- simulator:fs:read ------------------------------------------------------

describe('handleFsRead', () => {
	it('returns the full bytes + mime + etag + totalSize for an existing file', async () => {
		const bytes = Buffer.concat([PNG_MAGIC, Buffer.alloc(64, 0x42)])
		const real = await writeRaw(`hit-${rid()}.png`, bytes)

		const result = await handleFsRead({ realPath: real })

		expect(asBuffer(result.bytes).equals(bytes)).toBe(true)
		expect(result.mime).toBe('image/png')
		expect(result.totalSize).toBe(bytes.length)
		expect(result.etag).toMatch(ETAG_RE)
	})

	it('rejects (throws) when the file does not exist', async () => {
		await expect(
			handleFsRead({ realPath: realOf('missing', `${rid()}.bin`) }),
		).rejects.toThrow()
	})

	it('rejects when realPath lies OUTSIDE the sandbox base (defense in depth)', async () => {
		// Plant a real file outside the sandbox so the only way the handler
		// can fail is if it actively rejects the path. Without sandbox
		// enforcement at the IPC boundary, this would happily read TOP-SECRET.
		const escape = await fs.mkdtemp(path.join(os.tmpdir(), 'dimina-escape-'))
		const decoy = path.join(escape, 'secret.txt')
		try {
			await fs.writeFile(decoy, 'TOP-SECRET-PAYLOAD')

			await expect(handleFsRead({ realPath: decoy })).rejects.toThrow()
		} finally {
			await rmrf(escape)
		}
	})

	it('returns the requested inclusive range slice with totalSize=full size', async () => {
		const bytes = Buffer.from('abcdefghij', 'utf8') // length 10
		const real = await writeRaw(`range-${rid()}.txt`, bytes)

		const result = await handleFsRead({ realPath: real, range: { start: 2, end: 5 } })

		expect(asBuffer(result.bytes).toString('utf8')).toBe('cdef')
		expect(asBuffer(result.bytes).length).toBe(4)
		expect(result.totalSize).toBe(10)
	})

	it('rejects ranges that fall outside the file (start beyond totalSize)', async () => {
		const real = await writeRaw(`short-${rid()}.bin`, Buffer.from('short', 'utf8'))
		await expect(
			handleFsRead({ realPath: real, range: { start: 999, end: 1000 } }),
		).rejects.toThrow()
	})
})

// -- simulator:fs:write -----------------------------------------------------

describe('handleFsWrite', () => {
	it('writes bytes to disk and returns { ok: true }', async () => {
		const bytes = Buffer.from('round-trip ' + rid(), 'utf8')
		const real = realOf(`write-${rid()}.txt`)

		const result = await handleFsWrite({ realPath: real, bytes })

		expect(result).toEqual({ ok: true })
		// And a subsequent read sees the same bytes.
		const back = await handleFsRead({ realPath: real })
		expect(asBuffer(back.bytes).equals(bytes)).toBe(true)
	})

	it('accepts ArrayBuffer input and stores the equivalent bytes', async () => {
		const u8 = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
		const real = realOf(`write-ab-${rid()}.bin`)

		await handleFsWrite({ realPath: real, bytes: u8.buffer })

		const back = await handleFsRead({ realPath: real })
		expect(asBuffer(back.bytes).equals(Buffer.from([0xde, 0xad, 0xbe, 0xef]))).toBe(true)
	})

	it('creates missing parent directories so the renderer does not need a separate mkdir', async () => {
		const real = realOf('write-nested', 'a', 'b', `${rid()}.bin`)
		await expect(fs.stat(path.dirname(real))).rejects.toThrow()

		await handleFsWrite({ realPath: real, bytes: Buffer.from('nested', 'utf8') })

		const back = await handleFsRead({ realPath: real })
		expect(asBuffer(back.bytes).toString('utf8')).toBe('nested')
	})

	it('rejects when realPath lies OUTSIDE the sandbox base (no file is created at that path)', async () => {
		const escape = await fs.mkdtemp(path.join(os.tmpdir(), 'dimina-escape-'))
		const target = path.join(escape, 'planted.txt')
		try {
			await expect(
				handleFsWrite({ realPath: target, bytes: Buffer.from('x') }),
			).rejects.toThrow()
			// Nothing was created at the escape path by the handler.
			await expect(fs.stat(target)).rejects.toThrow()
		} finally {
			await rmrf(escape)
		}
	})
})

// -- simulator:fs:stat ------------------------------------------------------

describe('handleFsStat', () => {
	it('returns size/mtime/mode/isFile for a regular file', async () => {
		const real = await writeRaw(`stat-${rid()}.bin`, Buffer.alloc(123, 0x07))

		const st = await handleFsStat({ realPath: real })

		expect(st.size).toBe(123)
		expect(st.isFile).toBe(true)
		expect(st.isDirectory).toBe(false)
		expect(typeof st.mtime).toBe('number')
		expect(st.mtime).toBeGreaterThan(0)
		expect(typeof st.mode).toBe('number')
	})

	it('returns isDirectory=true for a directory', async () => {
		const dir = realOf('stat-dir')
		await fs.mkdir(dir, { recursive: true })

		const st = await handleFsStat({ realPath: dir })

		expect(st.isDirectory).toBe(true)
		expect(st.isFile).toBe(false)
	})

	it('rejects when the path does not exist', async () => {
		await expect(
			handleFsStat({ realPath: realOf(`no-stat-${rid()}.bin`) }),
		).rejects.toThrow()
	})

	it('rejects when realPath lies OUTSIDE the sandbox base', async () => {
		const escape = await fs.mkdtemp(path.join(os.tmpdir(), 'dimina-escape-'))
		const decoy = path.join(escape, 'stat-leak.txt')
		try {
			await fs.writeFile(decoy, 'leak')
			await expect(handleFsStat({ realPath: decoy })).rejects.toThrow()
		} finally {
			await rmrf(escape)
		}
	})
})

// -- simulator:fs:readdir ---------------------------------------------------

describe('handleFsReaddir', () => {
	it('returns the immediate children (no . or ..)', async () => {
		const dir = realOf(`readdir-${rid()}`)
		await fs.mkdir(dir, { recursive: true })
		await fs.writeFile(path.join(dir, 'a.txt'), 'a')
		await fs.writeFile(path.join(dir, 'b.txt'), 'b')
		await fs.mkdir(path.join(dir, 'sub'))

		const entries = await handleFsReaddir({ realPath: dir })

		expect([...entries].sort()).toEqual(['a.txt', 'b.txt', 'sub'])
		expect(entries).not.toContain('.')
		expect(entries).not.toContain('..')
	})

	it('returns [] for an empty directory', async () => {
		const dir = realOf(`empty-${rid()}`)
		await fs.mkdir(dir, { recursive: true })

		const entries = await handleFsReaddir({ realPath: dir })

		expect(entries).toEqual([])
	})

	it('rejects when the directory does not exist', async () => {
		await expect(
			handleFsReaddir({ realPath: realOf(`no-dir-${rid()}`) }),
		).rejects.toThrow()
	})

	it('rejects when realPath lies OUTSIDE the sandbox base', async () => {
		const escape = await fs.mkdtemp(path.join(os.tmpdir(), 'dimina-escape-'))
		try {
			await expect(handleFsReaddir({ realPath: escape })).rejects.toThrow()
		} finally {
			await rmrf(escape)
		}
	})
})

// -- simulator:fs:unlink ----------------------------------------------------

describe('handleFsUnlink', () => {
	it('deletes the file and returns { ok: true }; a subsequent read raises ENOENT', async () => {
		const real = await writeRaw(`unlink-${rid()}.bin`, Buffer.from('bye', 'utf8'))
		await fs.stat(real)

		const result = await handleFsUnlink({ realPath: real })
		expect(result).toEqual({ ok: true })

		// The file is really gone.
		await expect(fs.stat(real)).rejects.toThrow()
		// And reading through the channel surfaces a fresh failure.
		await expect(handleFsRead({ realPath: real })).rejects.toThrow()
	})

	it('rejects when the file does not exist', async () => {
		await expect(
			handleFsUnlink({ realPath: realOf(`unlink-miss-${rid()}.bin`) }),
		).rejects.toThrow()
	})

	it('rejects when realPath lies OUTSIDE the sandbox base (no escape-side deletion)', async () => {
		const escape = await fs.mkdtemp(path.join(os.tmpdir(), 'dimina-escape-'))
		const decoy = path.join(escape, 'do-not-delete.txt')
		try {
			await fs.writeFile(decoy, 'keep')
			await expect(handleFsUnlink({ realPath: decoy })).rejects.toThrow()
			// And the file outside the sandbox is intact.
			const back = await fs.readFile(decoy, 'utf8')
			expect(back).toBe('keep')
		} finally {
			await rmrf(escape)
		}
	})
})

// -- simulator:fs:mkdir -----------------------------------------------------

describe('handleFsMkdir', () => {
	it('creates a single directory and returns { ok: true }', async () => {
		const dir = realOf(`mkdir-flat-${rid()}`)
		await expect(fs.stat(dir)).rejects.toThrow()

		const result = await handleFsMkdir({ realPath: dir })
		expect(result).toEqual({ ok: true })

		const st = await fs.stat(dir)
		expect(st.isDirectory()).toBe(true)
	})

	it('creates the entire parent chain when recursive=true', async () => {
		const dir = realOf(`mkdir-deep-${rid()}`, 'a', 'b', 'c')
		await expect(fs.stat(path.dirname(dir))).rejects.toThrow()

		await handleFsMkdir({ realPath: dir, recursive: true })

		const st = await fs.stat(dir)
		expect(st.isDirectory()).toBe(true)
	})

	it('rejects when the parent does not exist and recursive is not set', async () => {
		const dir = realOf(`mkdir-no-parent-${rid()}`, 'leaf')
		await expect(
			handleFsMkdir({ realPath: dir }),
		).rejects.toThrow()
	})

	it('rejects when realPath lies OUTSIDE the sandbox base', async () => {
		const escape = await fs.mkdtemp(path.join(os.tmpdir(), 'dimina-escape-'))
		try {
			const target = path.join(escape, 'planted-dir')
			await expect(handleFsMkdir({ realPath: target })).rejects.toThrow()
			// And nothing was created at the escape path.
			await expect(fs.stat(target)).rejects.toThrow()
		} finally {
			await rmrf(escape)
		}
	})
})
