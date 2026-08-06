import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as devkit from './index.js'

/**
 * Contract: `OpenProjectOptions.onRebuild`'s info gains `explicit: boolean` —
 * the piece the devtools renderer needs to tell a user-requested "重新编译"
 * apart from a background watcher save, so an explicit rebuild can force a
 * hard re-attach instead of the soft hot-reload path (see
 * rebuild-status.ts / use-simulator.ts on the devtools side).
 *
 *  - A rebuild driven purely by the file watcher reports `explicit: false`.
 *  - A rebuild driven by `session.rebuild()` reports `explicit: true`.
 *  - When a watcher save and a `session.rebuild()` call land on the SAME
 *    trailing run (rebuild-scheduler coalescing), that run reports
 *    `explicit: true` — the user's request must never be silently
 *    downgraded because a background save happened to land in the same
 *    window.
 *
 * Harness lifted from open-project-rebuild.test.ts: fake fork + fake fe +
 * fake chokidar, with a `holdNext` gate on the fake compile worker so
 * in-flight-vs-trailing ordering can be observed deterministically.
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

class FakeChild extends EventEmitter {
	stdout = new PassThrough()
	stderr = new PassThrough()
	connected = true
	pid = 7171
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
				queueMicrotask(() => respond({ appInfo: { appId: 'explicit_app_001', name: 'explicit-app', path: projectPath } }))
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
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-rebuild-explicit-'))
	cleanupRoots.push(root)
	fs.writeFileSync(
		path.join(root, 'project.config.json'),
		JSON.stringify({ appid: 'explicit_app_001', projectname: 'explicit-app' }),
	)
	return root
}

async function settle(ms = 25): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, ms))
}

function watchSettled(promise: Promise<unknown>): { get resolved(): boolean } {
	const state = { resolved: false }
	promise.then(() => { state.resolved = true }, () => {})
	return state
}

interface RebuildInfo { changedPaths: string[], styleOnly: boolean, explicit: boolean }

describe('openProject: onRebuild info.explicit distinguishes watcher saves from user-requested rebuilds', () => {
	it('a rebuild driven purely by the file watcher reports explicit: false', async () => {
		const root = makeFixture()
		const rebuilds: RebuildInfo[] = []
		const session = await devkit.openProject({
			projectPath: root,
			watch: true,
			outputDir: path.join(root, '.out'),
			onRebuild: (info) => rebuilds.push(info as RebuildInfo),
		})
		const watcher = watchers[0]!

		watcher.emit('change', path.join(root, 'app.js'))
		await vi.waitFor(() => expect(rebuilds.length).toBe(1))

		expect(
			rebuilds[0]!.explicit,
			'a background watcher save must never be reported as an explicit (user-requested) rebuild',
		).toBe(false)

		await session.close()
	}, 15_000)

	it('a rebuild driven by session.rebuild() reports explicit: true', async () => {
		const root = makeFixture()
		const rebuilds: RebuildInfo[] = []
		const session = await devkit.openProject({
			projectPath: root,
			watch: false,
			outputDir: path.join(root, '.out'),
			onRebuild: (info) => rebuilds.push(info as RebuildInfo),
		})

		await session.rebuild()
		await vi.waitFor(() => expect(rebuilds.length).toBe(1))

		expect(
			rebuilds[0]!.explicit,
			'the popover 重新编译 button calls session.rebuild() — its completed run must be reported as explicit',
		).toBe(true)

		await session.close()
	}, 15_000)

	it('a watcher save that lands DURING an explicit rebuild is absorbed by the SAME explicit trailing run', async () => {
		const root = makeFixture()
		const rebuilds: RebuildInfo[] = []
		const session = await devkit.openProject({
			projectPath: root,
			watch: true,
			outputDir: path.join(root, '.out'),
			onRebuild: (info) => rebuilds.push(info as RebuildInfo),
		})
		const child = children[0]!
		const watcher = watchers[0]!
		child.holdNext = 2

		const rebuildCall = session.rebuild() // explicit request — build #1, held open
		await vi.waitFor(() => expect(child.pendingManual.length).toBe(1))

		// A background save lands while the explicit build is still in flight —
		// it must coalesce into the SAME trailing run session.rebuild() is
		// waiting on, not spawn a separate non-explicit run.
		watcher.emit('change', path.join(root, 'app.js'))
		await settle()
		expect(child.pendingManual.length, 'no concurrent build — the watcher save must coalesce').toBe(1)

		const settled = watchSettled(rebuildCall)
		child.pendingManual[0]!.respond({ appInfo: { appId: 'explicit_app_001', name: 'x', path: root } })
		await vi.waitFor(() => expect(child.pendingManual.length).toBe(2))
		expect(settled.resolved, 'hard re-attach must wait for the coalesced watcher tail').toBe(false)
		await vi.waitFor(() => expect(rebuilds.length).toBe(1))

		expect(
			rebuilds[0]!.explicit,
			'the completed run covers the explicit session.rebuild() call — it must be reported explicit even though a watcher save also landed in the same window',
		).toBe(true)
		child.pendingManual[1]!.respond({ appInfo: { appId: 'explicit_app_001', name: 'x', path: root } })
		await rebuildCall
		await vi.waitFor(() => expect(rebuilds.length).toBe(2))
		expect(rebuilds[1]!.explicit, 'the trailing watcher run remains owned by the explicit transaction').toBe(true)

		await session.close()
	}, 15_000)

	it('an explicit session.rebuild() that lands DURING a watcher-triggered rebuild makes the trailing run explicit too', async () => {
		const root = makeFixture()
		const rebuilds: RebuildInfo[] = []
		const session = await devkit.openProject({
			projectPath: root,
			watch: true,
			outputDir: path.join(root, '.out'),
			onRebuild: (info) => rebuilds.push(info as RebuildInfo),
		})
		const child = children[0]!
		const watcher = watchers[0]!
		child.holdNext = 2

		watcher.emit('change', path.join(root, 'app.js')) // background save — build #1, held open
		await vi.waitFor(() => expect(child.pendingManual.length).toBe(1))

		const rebuildCall = session.rebuild() // the user clicks 重新编译 mid-build
		await settle()
		expect(child.pendingManual.length, 'no concurrent build — the explicit request must coalesce').toBe(1)

		child.pendingManual[0]!.respond({ appInfo: { appId: 'explicit_app_001', name: 'x', path: root } })
		await vi.waitFor(() => expect(child.pendingManual.length).toBe(2))

		// Once the explicit request lands, even the already-running watcher build
		// suppresses soft reflection; the explicit transaction reflects once after
		// its trailing build completes.
		await vi.waitFor(() => expect(rebuilds.length).toBeGreaterThanOrEqual(1))
		expect(rebuilds[0]!.explicit, 'the in-flight watcher reflection must be suppressed').toBe(true)

		child.pendingManual[1]!.respond({ appInfo: { appId: 'explicit_app_001', name: 'x', path: root } })
		await rebuildCall
		await vi.waitFor(() => expect(rebuilds.length).toBe(2))

		expect(
			rebuilds[1]!.explicit,
			'the trailing run covers the explicit session.rebuild() call — it must be reported explicit',
		).toBe(true)

		await session.close()
	}, 15_000)
})
