import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as devkit from './index.js'

/**
 * Contract: `openProject` gains an `onWatcherError?: (err: unknown) => void`
 * option. A watcher 'error' BEFORE the initial scan completes must keep
 * rejecting `openProject` exactly as today (see open-project-cleanup.test.ts)
 * — `onWatcherError` must NOT be called for that pre-ready path, so callers
 * don't get a double signal for the same failure.
 *
 * A watcher 'error' AFTER 'ready' (EMFILE, permission loss mid-session, …) is
 * TODAY silently dropped: `createProjectWatcher`'s `watcher.on('error', ...)`
 * only rejects the (long-since-settled) `ready` promise, a no-op once ready
 * has already resolved. The project keeps "running" with a dead watcher and
 * nothing downstream ever finds out — a save after that point compiles
 * nothing, forever, with no diagnostic. The fix: `openProject` must forward a
 * post-ready watcher 'error' to `onWatcherError` so a caller (devtools'
 * workspace-service) can surface "auto-rebuild stopped working" instead of
 * silently going stale.
 *
 * Harness: verbatim copy of open-project-cleanup.test.ts's fake-fork +
 * fake-watcher setup (fork/fe/chokidar all mocked so the failure point is
 * injectable), plus a FakeWatcher that can fire 'error' AFTER 'ready'.
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
vi.mock('../fe/index.js', () => ({ start: mocks.feStart }))
vi.mock('chokidar', () => ({
	default: { watch: mocks.watch },
	watch: mocks.watch,
}))

class FakeChild extends EventEmitter {
	stdout = new PassThrough()
	stderr = new PassThrough()
	connected = true
	pid = 4343

	send = vi.fn((msg: unknown): boolean => {
		const m = msg as Record<string, unknown>
		if (m && m.cmd === 'build') {
			queueMicrotask(() => {
				if (!this.connected) return
				this.emit('message', {
					type: 'result',
					appInfo: { appId: 'watcher_err_app_001', name: 'watcher-err-app', path: String(m.projectPath ?? '') },
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
})

afterEach(() => {
	for (const root of cleanupRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true })
	}
})

function makeFixture(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-watcher-err-'))
	cleanupRoots.push(root)
	fs.writeFileSync(
		path.join(root, 'project.config.json'),
		JSON.stringify({ appid: 'watcher_err_app_001', projectname: 'watcher-err-app' }),
	)
	return root
}

function sleep(ms: number): Promise<void> {
	return new Promise<void>(resolve => setTimeout(resolve, ms))
}

describe('openProject onWatcherError — post-ready watcher errors are surfaced, pre-ready path is unchanged', () => {
	it('does NOT call onWatcherError for a watcher error BEFORE ready (openProject still rejects, same as today)', async () => {
		const root = makeFixture()
		mocks.watch.mockImplementation(() => {
			const watcher = new FakeWatcher()
			watchers.push(watcher)
			setTimeout(() => {
				try {
					watcher.emit('error', new Error('EMFILE: too many open files, watch'))
				}
				catch {
					// no 'error' listener path — matches open-project-cleanup.test.ts
				}
			}, 10)
			return watcher
		})

		const onWatcherError = vi.fn()
		await expect(
			devkit.openProject({
				projectPath: root,
				watch: true,
				outputDir: path.join(root, '.out'),
				onWatcherError,
			}),
		).rejects.toThrow()

		expect(
			onWatcherError,
			'a pre-ready watcher error must keep rejecting openProject WITHOUT also invoking onWatcherError — '
			+ 'the caller already gets the failure via the rejected promise',
		).not.toHaveBeenCalled()
	}, 15_000)

	it('calls onWatcherError with the error when the watcher fails AFTER ready — openProject has already resolved by then', async () => {
		const root = makeFixture()
		let capturedWatcher: FakeWatcher | null = null
		mocks.watch.mockImplementation(() => {
			const watcher = new FakeWatcher()
			watchers.push(watcher)
			capturedWatcher = watcher
			queueMicrotask(() => watcher.emit('ready'))
			return watcher
		})

		const onWatcherError = vi.fn()
		const session = await devkit.openProject({
			projectPath: root,
			watch: true,
			outputDir: path.join(root, '.out'),
			onWatcherError,
		})

		const postReadyError = new Error('EMFILE: too many open files, watch (post-ready)')
		capturedWatcher!.emit('error', postReadyError)
		await sleep(20)

		expect(
			onWatcherError,
			'today nothing listens for a post-ready watcher error beyond the already-settled ready promise — '
			+ 'the project silently stops auto-rebuilding forever with no signal',
		).toHaveBeenCalledWith(postReadyError)

		await session.close()
	}, 15_000)

	it('a post-ready watcher error does not crash the process (no unhandled "error" event) even without onWatcherError supplied', async () => {
		const root = makeFixture()
		let capturedWatcher: FakeWatcher | null = null
		mocks.watch.mockImplementation(() => {
			const watcher = new FakeWatcher()
			watchers.push(watcher)
			capturedWatcher = watcher
			queueMicrotask(() => watcher.emit('ready'))
			return watcher
		})

		const session = await devkit.openProject({
			projectPath: root,
			watch: true,
			outputDir: path.join(root, '.out'),
		})

		expect(() => {
			capturedWatcher!.emit('error', new Error('EMFILE (no onWatcherError supplied)'))
		}).not.toThrow()

		await session.close()
	}, 15_000)
})
