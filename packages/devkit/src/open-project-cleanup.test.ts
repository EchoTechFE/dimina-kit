import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as devkit from './index.js'

/**
 * Resource cleanup when `openProject` fails AFTER the compile worker was
 * already forked.
 *
 *  - the worker is created before the dev server starts; a server-start
 *    failure that propagates out of openProject must still kill the worker
 *    (otherwise a leaked compiler process per failed open).
 *  - `createProjectWatcher().ready` only resolves on chokidar's 'ready'; a
 *    watcher 'error' (EMFILE, permission loss, …) before ready must REJECT
 *    `ready` — otherwise `await watcher?.ready` (and openProject) hangs
 *    forever, leaking the worker AND the already-listening dev server.
 *
 * Harness: same fake-fork pattern as compile-worker.test.ts, plus this file
 * mocks the fe dev-server module and chokidar so the failure point of each
 * test is injectable. All mocks are per-file (vi.mock is hoisted), so these
 * tests live in their own file instead of the main orchestration suite.
 */

const mocks = vi.hoisted(() => ({
	fork: vi.fn(),
	feStart: vi.fn(),
	watch: vi.fn(),
}))

vi.mock('node:child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:child_process')>()
	return { ...actual, fork: mocks.fork, default: { ...actual, fork: mocks.fork } }
})
vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:child_process')>()
	return { ...actual, fork: mocks.fork, default: { ...actual, fork: mocks.fork } }
})
// src/index.ts dynamically imports '../fe/index.js' and calls its `start`.
vi.mock('../fe/index.js', () => ({ start: mocks.feStart }))
vi.mock('chokidar', () => ({
	default: { watch: mocks.watch },
	watch: mocks.watch,
}))

/** Minimal auto-responding fake compile worker (kill spy is the assertion). */
class FakeChild extends EventEmitter {
	stdout = new PassThrough()
	stderr = new PassThrough()
	connected = true
	pid = 4242

	send = vi.fn((msg: unknown): boolean => {
		const m = msg as Record<string, unknown>
		if (m && m.cmd === 'build') {
			queueMicrotask(() => {
				if (!this.connected) return
				this.emit('message', {
					type: 'result',
					appInfo: { appId: 'cleanup_app_001', name: 'cleanup-app', path: String(m.projectPath ?? '') },
				})
			})
		}
		return true
	})

	kill = vi.fn((): boolean => {
		this.connected = false
		queueMicrotask(() => this.emit('exit', null, 'SIGTERM'))
		return true
	})
}

/** chokidar stand-in: an EventEmitter with the watcher surface index.ts uses. */
class FakeWatcher extends EventEmitter {
	close = vi.fn(async (): Promise<void> => {})
}

interface FakeFe {
	server: {
		close: ReturnType<typeof vi.fn>
		closeAllConnections: ReturnType<typeof vi.fn>
	}
	reload: ReturnType<typeof vi.fn>
}

function makeFakeFe(): FakeFe {
	const server = {
		close: vi.fn((cb?: () => void) => {
			cb?.()
			return server
		}),
		closeAllConnections: vi.fn(),
	}
	return { server, reload: vi.fn() }
}

const children: FakeChild[] = []
const watchers: FakeWatcher[] = []
const feInstances: FakeFe[] = []
const cleanupRoots: string[] = []

beforeEach(() => {
	children.length = 0
	watchers.length = 0
	feInstances.length = 0
	mocks.fork.mockReset()
	mocks.fork.mockImplementation(() => {
		const child = new FakeChild()
		children.push(child)
		return child
	})
	mocks.feStart.mockReset()
	mocks.feStart.mockImplementation(async () => {
		const fe = makeFakeFe()
		feInstances.push(fe)
		return fe
	})
	mocks.watch.mockReset()
	mocks.watch.mockImplementation(() => {
		const watcher = new FakeWatcher()
		watchers.push(watcher)
		// Well-behaved default: initial scan completes promptly.
		queueMicrotask(() => watcher.emit('ready'))
		return watcher
	})
})

afterEach(() => {
	for (const root of cleanupRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true })
	}
})

function makeFixture(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-open-cleanup-'))
	cleanupRoots.push(root)
	fs.writeFileSync(
		path.join(root, 'project.config.json'),
		JSON.stringify({ appid: 'cleanup_app_001', projectname: 'cleanup-app' }),
	)
	return root
}

function sleep(ms: number): Promise<void> {
	return new Promise<void>(resolve => setTimeout(resolve, ms))
}

describe('openProject failure cleanup — no leaked compile worker', () => {
	it('a dev-server start failure AFTER the worker was forked rejects openProject AND kills the worker', async () => {
		const root = makeFixture()
		mocks.feStart.mockReset()
		mocks.feStart.mockRejectedValue(new Error('listen EADDRINUSE: address already in use'))

		await expect(
			devkit.openProject({
				projectPath: root,
				watch: false,
				outputDir: path.join(root, '.out'),
			}),
		).rejects.toThrow(/EADDRINUSE/)

		expect(
			children.length,
			'precondition: the compile worker is forked BEFORE the dev server starts',
		).toBe(1)
		expect(
			children[0]!.kill,
			'a server-start failure must kill the already-forked compile worker — today the error propagates but the '
			+ 'worker (a whole compiler process) is leaked on every failed open',
		).toHaveBeenCalled()
	}, 15_000)

	it("a watcher 'error' before 'ready' rejects openProject within a bounded time and kills the worker (no eternal hang)", async () => {
		const root = makeFixture()
		mocks.watch.mockReset()
		mocks.watch.mockImplementation(() => {
			const watcher = new FakeWatcher()
			watchers.push(watcher)
			setTimeout(() => {
				// Today nothing listens for 'error' (EventEmitter would throw on
				// an unhandled 'error' event) — the swallow keeps THIS test
				// deterministic; the bug is that openProject then hangs forever.
				try {
					watcher.emit('error', new Error('EMFILE: too many open files, watch'))
				}
				catch {
					// no 'error' listener registered — the exact gap under test
				}
			}, 10)
			return watcher
		})

		const openPromise = devkit.openProject({
			projectPath: root,
			watch: true,
			outputDir: path.join(root, '.out'),
		})

		const outcome = await Promise.race([
			openPromise.then(() => 'resolved' as const, () => 'rejected' as const),
			sleep(3000).then(() => 'hung' as const),
		])
		expect(
			outcome,
			"a watcher 'error' before the initial scan completes must REJECT openProject — `await watcher.ready` only "
			+ "listens for 'ready', so today the open hangs forever",
		).toBe('rejected')

		expect(
			children.length,
			'precondition: the compile worker was forked before the watcher failed',
		).toBe(1)
		expect(
			children[0]!.kill,
			'the watcher-error rejection must clean up the already-created resources: the compile worker must be killed',
		).toHaveBeenCalled()
		expect(
			feInstances[0]?.server.close,
			'…and the already-listening dev server must be closed too',
		).toHaveBeenCalled()
	}, 15_000)
})
