import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as devkit from './index.js'

/**
 * Contract: the `ProjectSession` returned by `openProject` gains an optional
 * `rebuild(): Promise<void>` — a real recompile, not the popover's current
 * "重新编译" behavior (re-attach to the last compiled output, no compiler
 * call at all). It must reuse the SAME merged scheduler the file watcher's
 * auto-rebuild uses (`createRebuildScheduler`), so a `rebuild()` call and a
 * watcher-triggered save never run two compiler builds concurrently — the
 * compile worker `chdir()`s into the project, so overlapping builds would
 * corrupt its cwd.
 *
 *  - `rebuild()` resolves only once a build that reflects the disk state AT
 *    THE TIME OF THE CALL has completed. If a build was already running when
 *    `rebuild()` was invoked, that in-flight build cannot have seen this
 *    call's state — resolution must wait for the TRAILING build instead.
 *  - A failing build rejects `rebuild()`'s promise.
 *  - `rebuild()` works identically with `watch: false` (no file watcher at
 *    all) — the popover's recompile must work regardless of the autoBuild
 *    setting.
 *
 * Harness: the fake-fork + fake-fe + fake-chokidar setup shared by
 * open-project-cleanup.test.ts / open-project-watcher-error-callback.test.ts,
 * extended with a `holdNext` gate so individual compiler replies can be held
 * open and released on demand (needed to observe in-flight vs. trailing
 * resolution ordering, which a queueMicrotask auto-responder can't expose).
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

type BuildReply = { appInfo: { appId: string, name: string, path: string } } | { error: string }

/**
 * Fake compile-worker child. Builds reply automatically (next microtask,
 * synthetic success) UNLESS `holdNext` is armed, in which case the build is
 * parked in `pendingManual` for the test to resolve/reject explicitly —
 * needed to pin down in-flight-vs-trailing resolution ordering.
 */
class FakeChild extends EventEmitter {
	stdout = new PassThrough()
	stderr = new PassThrough()
	connected = true
	pid = 6161
	holdNext = 0
	pendingManual: Array<{ projectPath: string, respond: (reply: BuildReply) => void }> = []

	send = vi.fn((msg: unknown): boolean => {
		const m = msg as Record<string, unknown>
		if (m && m.cmd === 'build') {
			const projectPath = String(m.projectPath ?? '')
			const respond = (reply: BuildReply): void => {
				if (!this.connected) return
				if ('error' in reply) this.emit('message', { type: 'result', error: { message: reply.error } })
				else this.emit('message', { type: 'result', appInfo: reply.appInfo })
			}
			if (this.holdNext > 0) {
				this.holdNext--
				this.pendingManual.push({ projectPath, respond })
			}
			else {
				queueMicrotask(() => respond({ appInfo: { appId: 'rebuild_app_001', name: 'rebuild-app', path: projectPath } }))
			}
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
	server: { close: ReturnType<typeof vi.fn>, closeAllConnections: ReturnType<typeof vi.fn> }
	reload: ReturnType<typeof vi.fn>
}

function makeFakeFe(): FakeFe {
	const server = {
		close: vi.fn((cb?: () => void) => { cb?.(); return server }),
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
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-rebuild-'))
	cleanupRoots.push(root)
	fs.writeFileSync(
		path.join(root, 'project.config.json'),
		JSON.stringify({ appid: 'rebuild_app_001', projectname: 'rebuild-app' }),
	)
	return root
}

function buildSendCount(child: FakeChild): number {
	return child.send.mock.calls.filter((c) => {
		const m = c[0] as Record<string, unknown>
		return m?.cmd === 'build'
	}).length
}

/** Track resolve/reject WITHOUT consuming the rejection (avoids unhandled-rejection noise). */
function watchSettled(p: Promise<unknown>): { get resolved(): boolean, get rejected(): boolean } {
	const state = { resolved: false, rejected: false }
	p.then(() => { state.resolved = true }, () => { state.rejected = true })
	return state
}

async function settle(ms = 25): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, ms))
}

describe('openProject session.rebuild(): a real recompile through the shared merged scheduler', () => {
	it('exposes rebuild as a callable function on the returned session', async () => {
		const root = makeFixture()
		const session = await devkit.openProject({ projectPath: root, watch: true, outputDir: path.join(root, '.out') })

		expect(
			typeof (session as unknown as { rebuild?: unknown }).rebuild,
			'ProjectSession must expose rebuild() — the popover "重新编译" button needs a real compiler call, not just a reattach',
		).toBe('function')

		await session.close()
	}, 15_000)

	it('rebuild() drives one additional real compile beyond the opening build (watch: true)', async () => {
		const root = makeFixture()
		const session = await devkit.openProject({ projectPath: root, watch: true, outputDir: path.join(root, '.out') })
		const child = children[0]!
		expect(buildSendCount(child)).toBe(1)

		const rebuild = (session as unknown as { rebuild: () => Promise<void> }).rebuild
		await rebuild()

		expect(
			buildSendCount(child),
			'clicking 重新编译 must invoke the compiler again, not merely reattach to the last build',
		).toBe(2)

		await session.close()
	}, 15_000)

	it('rebuild() works with watch: false — the popover recompile must not depend on autoBuild being on', async () => {
		const root = makeFixture()
		const session = await devkit.openProject({ projectPath: root, watch: false, outputDir: path.join(root, '.out') })
		expect(watchers.length, 'watch:false must never start a chokidar watcher').toBe(0)
		const child = children[0]!
		expect(buildSendCount(child)).toBe(1)

		const rebuild = (session as unknown as { rebuild: () => Promise<void> }).rebuild
		await rebuild()

		expect(buildSendCount(child)).toBe(2)

		await session.close()
	}, 15_000)

	it('rebuild() rejects when the compiler reports a build error', async () => {
		const root = makeFixture()
		const session = await devkit.openProject({ projectPath: root, watch: false, outputDir: path.join(root, '.out') })
		const child = children[0]!
		child.holdNext = 1

		const rebuild = (session as unknown as { rebuild: () => Promise<void> }).rebuild
		const p = rebuild()
		await vi.waitFor(() => expect(child.pendingManual.length).toBe(1))
		child.pendingManual[0]!.respond({ error: 'unexpected token at line 4' })

		await expect(p).rejects.toThrow(/unexpected token/)

		await session.close()
	}, 15_000)

	it('a rebuild() called while an earlier rebuild() is in flight resolves with the TRAILING build, not the running one', async () => {
		const root = makeFixture()
		const session = await devkit.openProject({ projectPath: root, watch: false, outputDir: path.join(root, '.out') })
		const child = children[0]!
		const rebuild = (session as unknown as { rebuild: () => Promise<void> }).rebuild

		child.holdNext = 2
		const p0 = rebuild()
		const watch0 = watchSettled(p0)
		await vi.waitFor(() => expect(child.pendingManual.length).toBe(1))

		const p1 = rebuild() // lands while p0's build is in flight
		const watch1 = watchSettled(p1)
		await settle()
		expect(
			child.pendingManual.length,
			'the compile worker chdir()s into the project — two concurrent builds would corrupt its cwd',
		).toBe(1)

		child.pendingManual[0]!.respond({ appInfo: { appId: 'rebuild_app_001', name: 'x', path: root } })
		await vi.waitFor(() => expect(child.pendingManual.length).toBe(2))
		expect(
			watch1.resolved,
			'p1 was requested after p0\'s build already started — it must not resolve off a build that predates its own call',
		).toBe(false)
		expect(watch0.resolved, 'p0 stays pending so its hard reflection cannot race the queued p1 run').toBe(false)

		child.pendingManual[1]!.respond({ appInfo: { appId: 'rebuild_app_001', name: 'x', path: root } })
		await Promise.all([p0, p1])
		expect(watch1.resolved).toBe(true)
		expect(buildSendCount(child)).toBe(3) // initial open + p0's build + the trailing build p1 waited for

		await session.close()
	}, 15_000)

	it('rebuild() and a watcher-triggered save merge through the same scheduler — never a concurrent compiler build', async () => {
		const root = makeFixture()
		const session = await devkit.openProject({ projectPath: root, watch: true, outputDir: path.join(root, '.out') })
		const child = children[0]!
		const watcher = watchers[0]!
		const rebuild = (session as unknown as { rebuild: () => Promise<void> }).rebuild

		child.holdNext = 2
		const p0 = rebuild()
		await vi.waitFor(() => expect(child.pendingManual.length).toBe(1))

		// A save lands while the explicit rebuild() is compiling.
		watcher.emit('change', path.join(root, 'app.js'))
		await settle()
		expect(
			child.pendingManual.length,
			'a watcher save mid-rebuild must coalesce into the trailing run, not start a second concurrent build',
		).toBe(1)

		child.pendingManual[0]!.respond({ appInfo: { appId: 'rebuild_app_001', name: 'x', path: root } })
		await vi.waitFor(() => expect(child.pendingManual.length).toBe(2))
		child.pendingManual[1]!.respond({ appInfo: { appId: 'rebuild_app_001', name: 'x', path: root } })
		await p0
		expect(buildSendCount(child)).toBe(3)

		await session.close()
	}, 15_000)
})
