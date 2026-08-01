/**
 * Contract: `FileSystemManager.*` handlers must not follow a symlink placed
 * inside the sandbox (`difile://usr/*`) out to a target outside it.
 *
 * `resolveVPath` (`../shared/vpath.js`) validates the REQUESTED path string
 * (no `..`, stays under the sandbox base after `path.normalize`) but never
 * inspects what's actually on disk at that path — it has no way to know a
 * `usr/`-relative entry is a symlink whose target escapes the sandbox. Node's
 * `fs.readFile` / `fs.writeFile` follow symlinks by default (verified
 * directly against Node: reading a sandboxed symlink returns the target
 * file's real bytes, and writing through it overwrites the target in place),
 * so a symlink planted inside `usr/` — e.g. by a malicious mini-program
 * write, or a pre-seeded project — defeats the sandbox for both read and
 * write without resolveVPath ever seeing it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as nodeFs from 'node:fs'
import * as nodePath from 'node:path'
import * as nodeOs from 'node:os'
import type { MiniAppContext } from './types'
import { simulatorApis } from './simulator-api'

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
		setTimeout(settle, 500)
		handler.call(makeContext(), { ...args, success, fail, complete })
	})
}

let sandboxHome: string
let outsideDir: string
let secretPath: string

function usrDir(): string {
	return nodePath.join(sandboxHome, 'files', 'usr')
}

beforeEach(() => {
	sandboxHome = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dimina-fsm-symlink-test-'))
	process.env.DIMINA_HOME = sandboxHome
	nodeFs.mkdirSync(usrDir(), { recursive: true })

	outsideDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dimina-fsm-symlink-outside-'))
	secretPath = nodePath.join(outsideDir, 'secret.txt')
	nodeFs.writeFileSync(secretPath, 'TOP-SECRET-OUTSIDE-SANDBOX')
})

afterEach(() => {
	delete process.env.DIMINA_HOME
	if (sandboxHome && nodeFs.existsSync(sandboxHome)) {
		nodeFs.rmSync(sandboxHome, { recursive: true, force: true })
	}
	if (outsideDir && nodeFs.existsSync(outsideDir)) {
		nodeFs.rmSync(outsideDir, { recursive: true, force: true })
	}
	vi.restoreAllMocks()
})

describe('readFile refuses to follow a sandboxed symlink out to the host filesystem', () => {
	it('a difile://usr/<link> symlinked to an outside file fails instead of leaking its bytes', async () => {
		nodeFs.symlinkSync(secretPath, nodePath.join(usrDir(), 'escape-link.txt'))

		const r = await invoke('readFile', { filePath: 'difile://usr/escape-link.txt', encoding: 'utf8' })
		expect(
			r.success,
			`readFile through a sandbox-escaping symlink must not succeed, got: ${JSON.stringify(r.success)}`,
		).toBeUndefined()
		expect(r.fail).toBeDefined()
		expect(r.complete).toBe(true)
	})
})

describe('writeFile refuses to follow a sandboxed symlink out to the host filesystem', () => {
	it('a difile://usr/<link> symlinked to an outside file fails, and the outside file is left untouched', async () => {
		nodeFs.symlinkSync(secretPath, nodePath.join(usrDir(), 'escape-link-write.txt'))

		const r = await invoke('writeFile', {
			filePath: 'difile://usr/escape-link-write.txt',
			data: 'CLOBBERED-VIA-SYMLINK',
			encoding: 'utf8',
		})
		expect(
			r.success,
			`writeFile through a sandbox-escaping symlink must not succeed, got: ${JSON.stringify(r.success)}`,
		).toBeUndefined()
		expect(r.fail).toBeDefined()

		expect(
			nodeFs.readFileSync(secretPath, 'utf8'),
			'the file outside the sandbox must be unchanged',
		).toBe('TOP-SECRET-OUTSIDE-SANDBOX')
	})
})

// ─── recursive stat must not follow a symlink found DURING the walk ────────
//
// `resolveOrBail` (simulator-api-fs.ts's `containsSymlink`) only inspects the
// single REQUESTED path (e.g. `difile://usr`) — it has no visibility into
// entries a recursive walk discovers below that root. Guards that the walk
// itself refuses symlinks: a link planted anywhere inside the tree — not
// just at the queried root — must fail the whole call instead of leaking
// the link target's metadata into the stats map (following it would defeat
// the sandbox exactly like the single-file read/write cases above).

function getErrMsg(payload: unknown): string {
	if (payload && typeof payload === 'object' && 'errMsg' in payload) {
		return String((payload as { errMsg: unknown }).errMsg)
	}
	return ''
}

describe('stat(recursive) refuses to follow a symlink found while walking the tree', () => {
	it('a directory symlink nested inside the queried tree fails the whole call and completes exactly once, leaking no stats', async () => {
		nodeFs.mkdirSync(nodePath.join(usrDir(), 'normal'), { recursive: true })
		nodeFs.writeFileSync(nodePath.join(usrDir(), 'normal', 'ok.txt'), 'fine')

		const escapedDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dimina-fsm-symlink-recursive-'))
		nodeFs.writeFileSync(nodePath.join(escapedDir, 'leak.txt'), 'LEAKED-OUTSIDE-SANDBOX')

		try {
			nodeFs.symlinkSync(escapedDir, nodePath.join(usrDir(), 'escape-link-dir'))

			const handler = getHandler('stat')
			const success = vi.fn()
			const fail = vi.fn()
			const complete = vi.fn()
			await new Promise<void>((resolve) => {
				complete.mockImplementation(() => resolve())
				handler.call(makeContext(), { path: 'difile://usr', recursive: true, success, fail, complete })
				setTimeout(resolve, 1000)
			})

			expect(success, 'recursive stat through a tree-internal symlink must not succeed').not.toHaveBeenCalled()
			expect(fail, 'a symlink found during the recursive walk must fail the whole call').toHaveBeenCalledTimes(1)
			expect(getErrMsg(fail.mock.calls[0]![0])).toMatch(/^stat:fail /)
			expect(complete, 'complete must fire exactly once').toHaveBeenCalledTimes(1)

			if (success.mock.calls.length > 0) {
				const stats = (success.mock.calls[0]![0] as { stats?: Record<string, unknown> } | undefined)?.stats
				expect(
					stats && 'escape-link-dir' in stats,
					'a success payload (bug) must not carry the symlinked descendant\'s leaked stats',
				).toBe(false)
			}
		} finally {
			nodeFs.rmSync(escapedDir, { recursive: true, force: true })
		}
	})
})
