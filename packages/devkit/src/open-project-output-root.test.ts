import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as devkit from './index.js'

/**
 * Contract: `openProject()` gains an optional `outputRoot`.
 *
 *  - When `outputRoot` is passed (and `outputDir` is not), the artifact
 *    directory is `path.join(outputRoot, sha1(path.resolve(projectPath)).slice(0, 12))`
 *    — keyed by the RESOLVED project path, so two different project paths
 *    never collide under the same root even when their `project.config.json`
 *    reports the same appid.
 *  - Passing `outputDir` still selects the final directory verbatim — that
 *    existing contract is unchanged by the new option.
 *  - Passing both `outputDir` AND `outputRoot` together is ambiguous and must
 *    reject, with both option names named in the error.
 *
 * Harness copied from open-project-rebuild.test.ts: fake fork + fake fe +
 * fake chokidar, `watch: false` throughout so no watcher mock is exercised.
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
	pid = 7171
	send = vi.fn((msg: unknown): boolean => {
		const m = msg as Record<string, unknown>
		if (m && m.cmd === 'build') {
			const outputDir = String(m.outputDir ?? '')
			queueMicrotask(() => this.emit('message', {
				type: 'result',
				appInfo: { appId: 'outputroot_app', name: 'outputroot-app', path: outputDir },
			}))
		}
		return true
	})

	kill = vi.fn((): boolean => {
		this.connected = false
		queueMicrotask(() => this.emit('exit', null, 'SIGTERM'))
		return true
	})
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
const feInstances: FakeFe[] = []
const cleanupRoots: string[] = []

beforeEach(() => {
	children.length = 0
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

function makeFixture(appid = 'outputroot_app'): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-outputroot-'))
	cleanupRoots.push(root)
	fs.writeFileSync(
		path.join(root, 'project.config.json'),
		JSON.stringify({ appid, projectname: 'outputroot-app' }),
	)
	return root
}

function lastBuildOutputDir(child: FakeChild): string {
	const buildCalls = child.send.mock.calls.filter((c) => {
		const m = c[0] as Record<string, unknown>
		return m?.cmd === 'build'
	})
	const msg = buildCalls[buildCalls.length - 1]?.[0] as Record<string, unknown> | undefined
	return String(msg?.outputDir ?? '')
}

function expectedSubdir(projectPath: string): string {
	return createHash('sha1').update(path.resolve(projectPath)).digest('hex').slice(0, 12)
}

describe('openProject({ outputRoot }): artifact directory derived from outputRoot + hashed project path', () => {
	it('places artifacts under outputRoot/sha1(resolvedProjectPath).slice(0, 12)', async () => {
		const root = makeFixture()
		const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-outputroot-target-'))
		cleanupRoots.push(outputRoot)

		const session = await devkit.openProject({
			projectPath: root,
			watch: false,
			outputRoot,
		} as devkit.OpenProjectOptions & { outputRoot: string })

		const expected = path.join(outputRoot, expectedSubdir(root))
		expect(
			lastBuildOutputDir(children[0]!),
			'outputRoot must be honored the same way the tmpdir default is today (index.ts:258) instead of being silently ignored',
		).toBe(expected)

		await session.close()
	}, 15_000)

	it('two different project paths sharing the same appid land in different subdirectories under outputRoot', async () => {
		const rootA = makeFixture('same_appid')
		const rootB = makeFixture('same_appid')
		const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-outputroot-collide-'))
		cleanupRoots.push(outputRoot)

		const sessionA = await devkit.openProject({
			projectPath: rootA,
			watch: false,
			outputRoot,
		} as devkit.OpenProjectOptions & { outputRoot: string })
		const dirA = lastBuildOutputDir(children[0]!)

		const sessionB = await devkit.openProject({
			projectPath: rootB,
			watch: false,
			outputRoot,
		} as devkit.OpenProjectOptions & { outputRoot: string })
		const dirB = lastBuildOutputDir(children[1]!)

		expect(dirA.startsWith(outputRoot), 'project A must build under the requested outputRoot').toBe(true)
		expect(dirB.startsWith(outputRoot), 'project B must build under the requested outputRoot').toBe(true)
		expect(
			dirA,
			'same appid, different project paths — the two builds must not be keyed onto the same output directory',
		).not.toBe(dirB)

		await sessionA.close()
		await sessionB.close()
	}, 15_000)

	it('rejects when both outputDir and outputRoot are passed, naming both options in the error', async () => {
		const root = makeFixture()
		const outputDir = path.join(root, '.out')
		const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-outputroot-conflict-'))
		cleanupRoots.push(outputRoot)

		await expect(
			devkit.openProject({
				projectPath: root,
				watch: false,
				outputDir,
				outputRoot,
			} as devkit.OpenProjectOptions & { outputRoot: string }),
			'passing both options is ambiguous about which one wins and must fail loudly instead of silently picking outputDir',
		).rejects.toThrow(/outputDir/i)

		await expect(
			devkit.openProject({
				projectPath: root,
				watch: false,
				outputDir,
				outputRoot,
			} as devkit.OpenProjectOptions & { outputRoot: string }),
		).rejects.toThrow(/outputRoot/i)
	}, 15_000)
})
