import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as devkit from './index.js'
import { writeUntilPredicate, writeUntilSettled } from './watch-rebuild.testutil.js'

/**
 * FLAKE HARDENING (no assertions changed): the watcher-driven rebuild tests
 * below depend on a REAL chokidar inotify watch (fork is mocked, chokidar is
 * not). Under CI load (concurrent real dmcc compile in
 * open-project-compile-log.test.ts pegging CPU) a single fs.writeFileSync's
 * inotify event can be dropped, hanging `await rebuilt`/`vi.waitFor` forever
 * (PR #44 30s timeout at the "fork exactly once across … 2 rebuilds" test).
 * Count-agnostic / `>=` waiters are wrapped in writeUntilSettled /
 * writeUntilPredicate, which RE-WRITE the source file (micro-varied content →
 * fresh inotify event) until the rebuild lands; the rebuild scheduler
 * coalesces the extra writes into one trailing build, so the pinned outcomes
 * are unchanged. The exact-count serial-IPC test deliberately does NOT use
 * them (see its inline note).
 */

/**
 * FORK-ARCHITECTURE WAVE (dmcc 编译子进程化) — TDD contract for the PARENT
 * side: `openProject` orchestrating a long-lived forked compile worker
 * (NOT yet implemented).
 *
 * ⚠️ ARCHITECTURE-DECISION CHANGE (user-approved, 2026-06-12):
 * Compilation moves from the in-process `require('@dimina/compiler')` call
 * (src/index.ts:104-105 with its host-global `process.chdir`) into a forked
 * long-lived child process. The tee-style `withCapturedStdio` contract from
 * ROUND 2 was deleted (see compile-log.test.ts header); THIS file pins its
 * replacement. Explicit architecture correction, not goalpost-moving.
 *
 * Parent-side contract pinned here (child_process.fork is mocked; the fake
 * child is an EventEmitter with PassThrough stdout/stderr + send/kill spies):
 *  1. `openProject` forks the compile worker EXACTLY ONCE and keeps it for
 *     the whole session — first compile and every watcher rebuild are
 *     `{ cmd: 'build', projectPath, outputDir, options }` IPC messages to
 *     the SAME child. Fork options must pipe stdout/stderr.
 *  2. The parent process NEVER calls `process.chdir` — the core motive of
 *     this architecture (the worker chdirs in its own process instead).
 *  3. child stdout/stderr are split into lines (with cross-chunk half-line
 *     buffering), passed through `filterDmccLogLine`, and only surviving
 *     lines reach `opts.onLog({ stream, text })`.
 *  4. The worker's `{ type: 'result', appInfo }` reply becomes the resolved
 *     `session.appInfo` — same shape as today (downstream consumers key
 *     storage prefixes etc. off `appId`).
 *  5. `session.close()` kills the worker.
 *  6. A worker that exits unexpectedly mid-build settles the in-flight build
 *     via `opts.onBuildError(Error mentioning the worker)` instead of
 *     hanging; the NEXT rebuild re-forks a fresh worker (crash recovery).
 *  7. Serial IPC: while a build command is unanswered, watcher events never
 *     produce a concurrent build command — they coalesce into exactly one
 *     trailing build (rebuild-scheduler semantics across the IPC boundary).
 *  8. Without `onLog` the worker is STILL forked (fork is the uniform
 *     compile path, not a logging feature) and stray child output is simply
 *     not delivered anywhere.
 *
 * NOTE for the implementer: this file mocks BOTH 'node:child_process' and
 * 'child_process' — import fork from either. The fake child auto-replies to
 * build commands unless a test flips `autoRespond` off to control timing.
 */

const mocks = vi.hoisted(() => ({ fork: vi.fn() }))

vi.mock('node:child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:child_process')>()
	return { ...actual, fork: mocks.fork, default: { ...actual, fork: mocks.fork } }
})
vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:child_process')>()
	return { ...actual, fork: mocks.fork, default: { ...actual, fork: mocks.fork } }
})

type LogEntry = { stream: 'stdout' | 'stderr'; text: string }
type SentMsg = Record<string, unknown>

/** The appInfo the fake worker replies with (path is echoed per message). */
const WORKER_APP = { appId: 'worker_app_777', name: 'from-worker' }

class FakeChild extends EventEmitter {
	stdout = new PassThrough()
	stderr = new PassThrough()
	connected = true
	killed = false
	pid = 4242
	/** When true (default), every {cmd:'build'} is answered on a microtask. */
	autoRespond = true
	/**
	 * When true, kill() does NOT auto-emit 'exit' — the test simulates the
	 * child death manually (or never). Default false keeps every pre-existing
	 * test's behaviour byte-identical.
	 */
	manualExit = false
	sent: SentMsg[] = []

	send = vi.fn((msg: unknown): boolean => {
		const m = msg as SentMsg
		this.sent.push(m)
		if (this.autoRespond && m && m.cmd === 'build') {
			queueMicrotask(() => {
				if (!this.connected) return
				this.emit('message', {
					type: 'result',
					appInfo: { ...WORKER_APP, path: String(m.projectPath ?? '') },
				})
			})
		}
		return true
	})

	kill = vi.fn((..._args: unknown[]): boolean => {
		this.killed = true
		this.connected = false
		if (!this.manualExit) queueMicrotask(() => this.emit('exit', null, 'SIGTERM'))
		return true
	})

	buildSends(): SentMsg[] {
		return this.sent.filter(m => m && m.cmd === 'build')
	}

	/** Manually answer the in-flight build (for autoRespond=false tests). */
	respondToBuild(projectPath: string): void {
		this.emit('message', {
			type: 'result',
			appInfo: { ...WORKER_APP, path: projectPath },
		})
	}

	/** Simulate an unexpected worker death. */
	crash(code = 1): void {
		this.connected = false
		this.emit('exit', code, null)
	}
}

const children: FakeChild[] = []
const openSessions: Array<{ close: () => Promise<void> }> = []
const cleanupRoots: string[] = []

beforeEach(() => {
	children.length = 0
	mocks.fork.mockReset()
	mocks.fork.mockImplementation(() => {
		const child = new FakeChild()
		children.push(child)
		return child
	})
})

afterEach(async () => {
	for (const session of openSessions.splice(0)) {
		try {
			await session.close()
		}
		catch {
			// best-effort teardown
		}
	}
	for (const root of cleanupRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true })
	}
})

function makeFixture(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-compile-worker-'))
	cleanupRoots.push(root)
	const write = (rel: string, content: string): void => {
		const target = path.join(root, rel)
		fs.mkdirSync(path.dirname(target), { recursive: true })
		fs.writeFileSync(target, content)
	}
	write('project.config.json', JSON.stringify({ appid: 'fixture_app_001', projectname: 'fixture-app' }))
	write('app.json', JSON.stringify({ pages: ['pages/index/index'] }))
	write('app.js', 'App({})\n')
	write('app.wxss', 'page { font-size: 14px; }\n')
	write('pages/index/index.json', '{}\n')
	write('pages/index/index.js', 'Page({ data: { msg: "hi" } })\n')
	write('pages/index/index.wxml', '<view>{{msg}}</view>\n')
	write('pages/index/index.wxss', '.x { color: red; }\n')
	return root
}

function theChild(): FakeChild {
	const child = children.at(-1)
	expect(
		child,
		'openProject must fork the compile worker — child_process.fork was never called',
	).toBeDefined()
	return child as FakeChild
}

function rebuildWaiter(): { onRebuild: () => void; next: () => Promise<void> } {
	const waiters: Array<() => void> = []
	return {
		onRebuild: () => {
			for (const wake of waiters.splice(0)) wake()
		},
		next: () => new Promise<void>(resolve => waiters.push(resolve)),
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise<void>(resolve => setTimeout(resolve, ms))
}

describe('openProject — fork-based compile worker orchestration', () => {
	it('forks the compile worker exactly once, targeting the compile-worker-entry module with piped stdio', async () => {
		const root = makeFixture()
		const session = await devkit.openProject({
			projectPath: root,
			watch: false,
			outputDir: path.join(root, '.out'),
		})
		openSessions.push(session)

		expect(
			mocks.fork,
			'openProject must fork the long-lived compile worker via child_process.fork — compilation no longer runs in the host process',
		).toHaveBeenCalledTimes(1)

		const call = mocks.fork.mock.calls[0] as unknown[]
		expect(
			String(call[0]),
			'the fork target must be the compile-worker-entry module',
		).toContain('compile-worker-entry')

		// Without piped stdio the parent can never read dmcc output: either
		// silent:true or an explicit stdio array containing 'pipe' is required.
		const optionsArg = call.find(
			arg => typeof arg === 'object' && arg !== null && !Array.isArray(arg),
		) as { silent?: boolean; stdio?: unknown } | undefined
		let piped = false
		if (optionsArg) {
			piped = optionsArg.silent === true
				|| (Array.isArray(optionsArg.stdio) && optionsArg.stdio.includes('pipe'))
		}
		expect(
			piped,
			'fork options must pipe the child stdout/stderr (silent:true or a stdio array containing "pipe") — otherwise onLog can never see dmcc output',
		).toBe(true)
	}, 45_000)

	it('first build flows over IPC and openProject resolves with the worker-returned AppInfo (downstream shape preserved)', async () => {
		const root = makeFixture()
		const outputDir = path.join(root, '.out')
		const session = await devkit.openProject({
			projectPath: root,
			watch: false,
			outputDir,
			sourcemap: true,
		})
		openSessions.push(session)

		const child = theChild()
		const builds = child.buildSends()
		expect(
			builds.length,
			'the first compile must be a {cmd:"build"} IPC message to the worker',
		).toBe(1)
		expect(builds[0]).toEqual(expect.objectContaining({
			cmd: 'build',
			projectPath: root,
			outputDir,
			options: expect.objectContaining({ sourcemap: true }),
		}))

		// The fake worker replied {type:'result', appInfo} — openProject must
		// resolve with exactly that appInfo. Consumers key storage prefixes
		// etc. off appId; the shape must survive the IPC hop unchanged.
		expect(session.appInfo).toEqual({ ...WORKER_APP, path: root })
		expect(typeof session.port).toBe('number')
		expect(typeof session.close).toBe('function')
	}, 45_000)

	it('the parent process NEVER calls process.chdir — first build and rebuild alike', async () => {
		const chdirSpy = vi.spyOn(process, 'chdir').mockImplementation(() => {})
		try {
			const root = makeFixture()
			const waiter = rebuildWaiter()
			const session = await devkit.openProject({
				projectPath: root,
				watch: true,
				outputDir: path.join(root, '.out'),
				onRebuild: waiter.onRebuild,
				// Either way the rebuild attempt finished — the pin below is
				// chdir-zero, not the rebuild outcome.
				onBuildError: waiter.onRebuild,
			})
			openSessions.push(session)

			const rebuilt = waiter.next()
			// Count-agnostic (chdir-zero): re-write until the rebuild actually lands.
			await writeUntilSettled(
				rebuilt,
				path.join(root, 'pages', 'index', 'index.js'),
				attempt => `Page({ data: { msg: "updated-${attempt}" } })\n`,
			)

			expect(
				chdirSpy,
				'process.chdir in the host (Electron main) process is the root cause this architecture kills — the parent must never chdir; the worker chdirs in its OWN process',
			).not.toHaveBeenCalled()
		}
		finally {
			chdirSpy.mockRestore()
		}
	}, 45_000)

	it('rebuilds reuse the same long-lived worker: fork exactly once across first build + 2 rebuilds', async () => {
		const root = makeFixture()
		const waiter = rebuildWaiter()
		const session = await devkit.openProject({
			projectPath: root,
			watch: true,
			outputDir: path.join(root, '.out'),
			onRebuild: waiter.onRebuild,
		})
		openSessions.push(session)
		const child = theChild()

		for (const round of [1, 2]) {
			const rebuilt = waiter.next()
			// Count-agnostic (fork-once / buildSends >= 3): re-write until each
			// rebuild lands. Extra coalesced rebuilds cannot break a `>=` or a
			// single-fork pin — fork is mocked and stays one child.
			await writeUntilSettled(
				rebuilt,
				path.join(root, 'pages', 'index', 'index.js'),
				attempt => `Page({ data: { msg: "round-${round}-${attempt}" } })\n`,
			)
		}

		expect(
			mocks.fork,
			'the worker is LONG-LIVED: re-forking per build is the old CLI-subprocess model this contract rejects (compiler/module caches would be cold every time)',
		).toHaveBeenCalledTimes(1)
		expect(
			child.buildSends().length,
			'first compile + 2 rebuilds must all be build commands on the SAME child',
		).toBeGreaterThanOrEqual(3)
		expect(children).toHaveLength(1)
	}, 45_000)

	it('child stdout/stderr lines are filtered through filterDmccLogLine and delivered to onLog with stream tags', async () => {
		const root = makeFixture()
		const entries: LogEntry[] = []
		const logOpts = { onLog: (entry: LogEntry) => entries.push(entry) }
		const session = await devkit.openProject({
			projectPath: root,
			watch: false,
			outputDir: path.join(root, '.out'),
			...logOpts,
		})
		openSessions.push(session)
		const child = theChild()
		entries.length = 0

		// keep / drop / drop on stdout; keep on stderr — verbatim spike lines.
		child.stdout.write('✔ 收集配置信息\n❯ 编译页面逻辑\n› [████░░░░░░░░░░░░░░░░░░░░░░░░░░] 12.50%\n')
		child.stderr.write('[compat] Unsupported wx API: wx.createInnerAudioContext (/pages/audio-test/audio-test.js:33)\n')

		await vi.waitFor(() => {
			expect(entries.length).toBeGreaterThanOrEqual(2)
		}, { timeout: 5000 })
		await sleep(50) // noise lines must not straggle in late

		expect(entries).toHaveLength(2)
		expect(entries).toEqual(expect.arrayContaining([
			{ stream: 'stdout', text: '✔ 收集配置信息' },
			{ stream: 'stderr', text: '[compat] Unsupported wx API: wx.createInnerAudioContext (/pages/audio-test/audio-test.js:33)' },
		]))
	}, 45_000)

	it('half lines split across chunks are buffered until the newline arrives (no partial-line delivery)', async () => {
		const root = makeFixture()
		const entries: LogEntry[] = []
		const logOpts = { onLog: (entry: LogEntry) => entries.push(entry) }
		const session = await devkit.openProject({
			projectPath: root,
			watch: false,
			outputDir: path.join(root, '.out'),
			...logOpts,
		})
		openSessions.push(session)
		const child = theChild()
		entries.length = 0

		child.stdout.write('✔ 收集')
		await sleep(30)
		child.stdout.write('配置信息\n')
		child.stderr.write('[logic] esbuild 转换失败 /p/x.js: Transform fail')
		await sleep(30)
		child.stderr.write('ed with 1 error:\n')

		await vi.waitFor(() => {
			expect(entries.length).toBeGreaterThanOrEqual(2)
		}, { timeout: 5000 })
		await sleep(50)

		expect(
			entries.some(entry => entry.text === '✔ 收集'),
			'a half line must never be delivered — buffer it until its newline arrives',
		).toBe(false)
		expect(entries).toHaveLength(2)
		expect(entries).toEqual(expect.arrayContaining([
			{ stream: 'stdout', text: '✔ 收集配置信息' },
			{ stream: 'stderr', text: '[logic] esbuild 转换失败 /p/x.js: Transform failed with 1 error:' },
		]))
	}, 45_000)

	it('without onLog the worker is STILL forked (uniform architecture) and stray output is simply not delivered', async () => {
		const root = makeFixture()
		const session = await devkit.openProject({
			projectPath: root,
			watch: false,
			outputDir: path.join(root, '.out'),
		})
		openSessions.push(session)
		const child = theChild()

		expect(
			mocks.fork,
			'forking is the uniform compile path — it must not be conditional on the onLog option',
		).toHaveBeenCalledTimes(1)

		// Child output with no onLog consumer must be inert (no crash, no
		// unhandled error) — zero-callback contract.
		child.stdout.write('✔ 收集配置信息\n')
		child.stderr.write('✖ 编译页面逻辑 [FAILED: x]\n')
		await sleep(80)

		expect(session.appInfo.appId).toBe(WORKER_APP.appId)
	}, 45_000)

	it('session.close() kills the long-lived worker', async () => {
		const root = makeFixture()
		const session = await devkit.openProject({
			projectPath: root,
			watch: false,
			outputDir: path.join(root, '.out'),
		})
		openSessions.push(session)
		const child = theChild()

		await session.close()

		expect(
			child.kill,
			'close() must kill the compile worker — a leaked child per closed project is the new architecture\'s one new failure mode',
		).toHaveBeenCalled()
	}, 45_000)

	it('a worker crash mid-build settles the in-flight rebuild via onBuildError, and the next rebuild re-forks (crash recovery)', async () => {
		const root = makeFixture()
		const waiter = rebuildWaiter()
		const buildErrors: unknown[] = []
		const session = await devkit.openProject({
			projectPath: root,
			watch: true,
			outputDir: path.join(root, '.out'),
			onRebuild: waiter.onRebuild,
			onBuildError: (err: unknown) => buildErrors.push(err),
		})
		openSessions.push(session)
		const first = theChild()
		first.autoRespond = false

		// Trigger a rebuild whose build command will never be answered…
		// buildSends===2 is a STABLE equality here: the child never auto-responds,
		// so the first build stays in flight and every extra (re-written) watcher
		// event coalesces to dirty — buildSends cannot exceed 2. Re-write until
		// the (single) in-flight build command is observed.
		await writeUntilPredicate(
			() => first.buildSends().length === 2,
			path.join(root, 'pages', 'index', 'index.js'),
			attempt => `Page({ data: { msg: "doomed-${attempt}" } })\n`,
		)
		expect(first.buildSends().length).toBe(2)

		// …then kill the worker out from under it.
		first.crash(1)

		await vi.waitFor(() => {
			expect(
				buildErrors.length,
				'an in-flight build whose worker died must settle through onBuildError — NOT hang the rebuild scheduler forever',
			).toBeGreaterThanOrEqual(1)
		}, { timeout: 5000 })
		const err = buildErrors[0]
		expect(err).toBeInstanceOf(Error)
		expect(
			String((err as Error).message),
			'the error must identify the compile worker death (so devtools can render it, not a generic failure)',
		).toMatch(/worker/i)

		// Recovery: the NEXT rebuild re-forks a fresh worker and succeeds.
		// Count-agnostic (fork-times-2 after a crash): the first worker is dead, so
		// re-writing only schedules trailing rebuilds on the single fresh worker.
		const rebuilt = waiter.next()
		await writeUntilSettled(
			rebuilt,
			path.join(root, 'pages', 'index', 'index.js'),
			attempt => `Page({ data: { msg: "recovered-${attempt}" } })\n`,
		)
		await vi.waitFor(() => {
			expect(
				children.length,
				'after a crash the next rebuild must fork a FRESH worker',
			).toBe(2)
		}, { timeout: 5000 })

		expect(mocks.fork).toHaveBeenCalledTimes(2)
		const second = children.at(-1) as FakeChild
		expect(second.buildSends().length).toBeGreaterThanOrEqual(1)
	}, 45_000)

	it('a worker crash while IDLE is recovered too: the next rebuild forks a fresh worker and succeeds', async () => {
		const root = makeFixture()
		const waiter = rebuildWaiter()
		const session = await devkit.openProject({
			projectPath: root,
			watch: true,
			outputDir: path.join(root, '.out'),
			onRebuild: waiter.onRebuild,
		})
		openSessions.push(session)
		const first = theChild()

		first.crash(1)

		// Count-agnostic (fork-times-2): the crashed worker is gone, so re-writes
		// only schedule trailing rebuilds on the one fresh worker — no extra fork.
		const rebuilt = waiter.next()
		await writeUntilSettled(
			rebuilt,
			path.join(root, 'pages', 'index', 'index.js'),
			attempt => `Page({ data: { msg: "after-idle-crash-${attempt}" } })\n`,
		)

		expect(
			mocks.fork,
			'an idle crash must not wedge the session — the next rebuild re-forks exactly one fresh worker',
		).toHaveBeenCalledTimes(2)
		const second = children.at(-1) as FakeChild
		expect(second).not.toBe(first)
		expect(second.buildSends().length).toBeGreaterThanOrEqual(1)
	}, 45_000)

	it('serial IPC: a save during an in-flight build never sends a concurrent build command — it coalesces into one trailing build', async () => {
		const root = makeFixture()
		const waiter = rebuildWaiter()
		const session = await devkit.openProject({
			projectPath: root,
			watch: true,
			outputDir: path.join(root, '.out'),
			onRebuild: waiter.onRebuild,
		})
		openSessions.push(session)
		const child = theChild()
		child.autoRespond = false
		const pageFile = path.join(root, 'pages', 'index', 'index.js')

		// EXACT-COUNT test — the writeUntilSettled re-write helper is NOT applied
		// to the coalescing assertions (===2 in-flight, ===3 after the response).
		// The first waiter is a STABLE EQUALITY (===2): while no build is answered
		// every extra watcher event coalesces to dirty, so re-writing to defeat a
		// dropped inotify event cannot push the count past 2.
		await writeUntilPredicate(
			() => child.buildSends().length === 2,
			pageFile,
			attempt => `Page({ data: { msg: "a-${attempt}" } })\n`,
		)
		expect(child.buildSends().length).toBe(2)

		// A second save lands while the first rebuild's IPC is unanswered. Pump it
		// across the in-flight window: EVERY save while a build is unanswered folds
		// into ONE dirty flag (rebuild-scheduler coalescing), so the count provably
		// stays 2 — no concurrent build — no matter how many we issue. Re-issuing
		// thus CANNOT over-count past the single trailing build; it only defeats a
		// dropped inotify event under CI CPU contention (a single mid-build write
		// whose event is lost would otherwise leave dirty unset → no trailing build
		// → the ===3 assertion below hangs to timeout). The ===2 invariant is the
		// real serialization proof and is asserted on every pump.
		for (let attempt = 0; attempt < 6; attempt++) {
			fs.writeFileSync(pageFile, `Page({ data: { msg: "b-${attempt}" } })\n`)
			await sleep(250)
			expect(
				child.buildSends().length,
				'NO concurrent build command while one is in flight — rebuild-scheduler serialization must hold across the IPC boundary',
			).toBe(2)
		}

		// Answer the in-flight build: the coalesced dirty flag (set by the pumped
		// saves above, all while the build was unanswered) yields exactly ONE
		// trailing build.
		child.respondToBuild(root)
		await vi.waitFor(() => {
			expect(
				child.buildSends().length,
				'the save that landed mid-build must coalesce into exactly one trailing build once the in-flight one settles',
			).toBe(3)
		}, { timeout: 5000 })

		// Settle everything for teardown.
		child.autoRespond = true
		child.respondToBuild(root)
		await sleep(50)

		expect(mocks.fork).toHaveBeenCalledTimes(1)
	}, 45_000)
})

/**
 * LEAK-PROOFING WAVE (项目关闭时保证编译子进程同步关闭) — close-time guards on
 * the exported `createCompileWorker` directly (same mocked fork as above).
 * Real process death is pinned by `compile-worker-leak.test.ts`; these pin
 * the parent-side STATE MACHINE around close:
 *   - close with a build in flight kills immediately and SETTLES the pending
 *     promise (a hung promise wedges the rebuild scheduler — and a scheduler
 *     wedged at close time is itself a teardown leak),
 *   - a closed worker can never be resurrected (build-after-close must not
 *     re-fork — a zombie re-fork after project close IS the leak).
 */
describe('createCompileWorker — close-time leak guards (direct use)', () => {
	it('close() with a build in flight kills the worker immediately and the pending build settles (no hang)', async () => {
		// Children for this test never auto-respond: the build stays in flight.
		mocks.fork.mockImplementation(() => {
			const child = new FakeChild()
			child.autoRespond = false
			children.push(child)
			return child
		})

		const worker = devkit.createCompileWorker({})
		const pending = worker.build({
			projectPath: '/tmp/p',
			outputDir: '/tmp/out',
			options: {},
		})
		// Pre-arm the rejection expectation so the settle is observed even if
		// it happens while we are still asserting on the kill spy.
		const settled = expect(
			pending,
			'a build in flight at close() must SETTLE (reject) — a forever-pending build wedges the rebuild scheduler',
		).rejects.toThrow(/worker|closed/i)

		await vi.waitFor(() => {
			expect(children.length).toBe(1)
		}, { timeout: 5000 })
		const child = children[0] as FakeChild

		worker.close()

		expect(
			child.kill,
			'close() must kill the worker even while a build is in flight — waiting for the build to finish first '
			+ 'leaves a busy compiler running after the project closed',
		).toHaveBeenCalled()
		await settled
	}, 45_000)

	it('build() after close() rejects and NEVER re-forks — a closed session must not resurrect a worker process', async () => {
		const worker = devkit.createCompileWorker({})
		const request = {
			projectPath: '/tmp/p',
			outputDir: '/tmp/out',
			options: {},
		}

		// One normal build so the worker exists, then close it.
		await worker.build(request)
		expect(mocks.fork).toHaveBeenCalledTimes(1)
		worker.close()
		const child = children[0] as FakeChild
		expect(child.kill).toHaveBeenCalled()

		await expect(
			worker.build(request),
			'build on a closed worker must reject loudly — silently re-forking would leak a process the session '
			+ 'owner already believes is gone',
		).rejects.toThrow(/clos/i)

		expect(
			mocks.fork,
			'NO re-fork after close(): close is terminal for the instance (refill-on-close is the documented '
			+ 'teardown-wedge anti-pattern, and a post-close fork is an untracked orphan)',
		).toHaveBeenCalledTimes(1)
		expect(children).toHaveLength(1)
	}, 45_000)

	it('close() is idempotent — the second close neither throws nor double-kills', async () => {
		const worker = devkit.createCompileWorker({})
		await worker.build({
			projectPath: '/tmp/p',
			outputDir: '/tmp/out',
			options: {},
		})
		const child = children[0] as FakeChild

		worker.close()
		expect(() => worker.close()).not.toThrow()

		expect(
			child.kill,
			'double-close must not double-kill: the second kill could land on a recycled OS PID',
		).toHaveBeenCalledTimes(1)
	}, 45_000)
})

/**
 * CODEX-REVIEW REGRESSION WAVE (fix/editor-hot-reload-and-simulator-leftovers)
 * — failing regression tests for review findings M1 / M2 / M3 / m7. Same
 * mocked-fork harness as above; each test names the finding it pins.
 *
 *  M1  a `{ type:'result', error }` reply is currently resolved as a SUCCESS
 *      with appInfo:null — it must reject the in-flight build (message passed
 *      through) and surface via onBuildError on the rebuild path.
 *  M2  a child 'error' event (spawn/IPC failure) is swallowed; Node does NOT
 *      guarantee an accompanying 'exit', so the in-flight build hangs forever
 *      and the dead child is never replaced.
 *  M3  close() kills and returns immediately — it must return a promise that
 *      resolves only after the child actually exited, and must settle the
 *      in-flight build itself (not rely on the child cooperating with exit).
 *  m7  a final line without a trailing newline is buffered forever — it must
 *      be flushed to onLog exactly once when the stream ends.
 */
describe('codex review regressions — worker error replies, fork errors, close semantics, trailing line (M1/M2/M3/m7)', () => {
	const REQUEST = {
		projectPath: '/tmp/p',
		outputDir: '/tmp/out',
		options: {},
	}

	function raceSettle(promise: Promise<unknown>, ms: number): Promise<'resolved' | 'rejected' | 'hung'> {
		return Promise.race([
			promise.then(() => 'resolved' as const, () => 'rejected' as const),
			sleep(ms).then(() => 'hung' as const),
		])
	}

	/** Children that never auto-respond — the build stays in flight. */
	function useSilentChildren(): void {
		mocks.fork.mockImplementation(() => {
			const child = new FakeChild()
			child.autoRespond = false
			children.push(child)
			return child
		})
	}

	it('M1: build() rejects (error message passed through) when the worker reply carries an error — not a silent appInfo:null success', async () => {
		useSilentChildren()
		const worker = devkit.createCompileWorker({})
		const pending = worker.build(REQUEST)
		const settled = expect(
			pending,
			'a worker reply carrying { error } must REJECT the in-flight build with the worker-reported message — '
			+ 'resolving it as appInfo:null reports a failed compile as a success',
		).rejects.toThrow(/compiler init failed/)

		await vi.waitFor(() => {
			expect(children.length).toBe(1)
		}, { timeout: 5000 })
		const child = children[0] as FakeChild

		child.emit('message', {
			type: 'result',
			appInfo: null,
			error: { message: 'boom — compiler init failed' },
		})

		await settled
	}, 45_000)

	it('M1: a rebuild whose worker reply carries an error settles through onBuildError — NOT through onRebuild as a fake hot-reload success', async () => {
		const root = makeFixture()
		const buildErrors: unknown[] = []
		const rebuilds: unknown[] = []
		const session = await devkit.openProject({
			projectPath: root,
			watch: true,
			outputDir: path.join(root, '.out'),
			onRebuild: () => rebuilds.push(true),
			onBuildError: (err: unknown) => buildErrors.push(err),
		})
		openSessions.push(session)
		const child = theChild()
		child.autoRespond = false

		// buildSends===2 is a stable equality (child never auto-responds, so the
		// first build stays in flight and re-written watcher events coalesce to
		// dirty). Re-write until the single in-flight build command is observed.
		await writeUntilPredicate(
			() => child.buildSends().length === 2,
			path.join(root, 'pages', 'index', 'index.js'),
			attempt => `Page({ data: { msg: "will fail-${attempt}" } })\n`,
		)
		expect(child.buildSends().length).toBe(2)

		child.emit('message', {
			type: 'result',
			appInfo: null,
			error: { message: 'boom — esbuild exploded' },
		})

		await vi.waitFor(() => {
			expect(
				buildErrors.length,
				'an error reply must surface through onBuildError — treating it as appInfo:null makes the rebuild path '
				+ 'report 编译完成/hot-reload SUCCESS for a build the worker itself flagged as failed',
			).toBeGreaterThanOrEqual(1)
		}, { timeout: 5000 })
		expect(buildErrors[0]).toBeInstanceOf(Error)
		expect(
			String((buildErrors[0] as Error).message),
			'the worker-reported error message must pass through to onBuildError (the devtools panel renders it)',
		).toMatch(/esbuild exploded/)
		expect(
			rebuilds,
			'the failed rebuild must NOT fire onRebuild — onRebuild triggers the hot-reload toast',
		).toHaveLength(0)
	}, 45_000)

	it("M2: a fork 'error' event with NO accompanying 'exit' settles the in-flight build (bounded) and the next build re-forks a fresh worker", async () => {
		useSilentChildren()
		const worker = devkit.createCompileWorker({})
		const pending = worker.build(REQUEST)
		await vi.waitFor(() => {
			expect(children.length).toBe(1)
		}, { timeout: 5000 })
		const first = children[0] as FakeChild

		// Node does NOT guarantee 'exit' after 'error' (spawn/IPC failures can
		// surface as a lone 'error' event). Swallowing it leaves the in-flight
		// build pending forever.
		first.emit('error', new Error('spawn EAGAIN'))

		expect(
			await raceSettle(pending, 2000),
			"a child 'error' event without 'exit' must settle (reject) the in-flight build — today it hangs the rebuild scheduler forever",
		).toBe('rejected')

		// The errored child must be discarded so the NEXT build re-forks.
		const second = worker.build(REQUEST)
		await vi.waitFor(() => {
			expect(
				children.length,
				"after a fork 'error' the child must be cleared — the next build must fork a FRESH worker, not reuse the broken one",
			).toBe(2)
		}, { timeout: 5000 })
		const fresh = children[1] as FakeChild
		await vi.waitFor(() => {
			expect(fresh.buildSends().length).toBe(1)
		}, { timeout: 5000 })
		fresh.respondToBuild('/tmp/p')
		await expect(second).resolves.toEqual(expect.objectContaining({ appId: WORKER_APP.appId }))
	}, 45_000)

	it("M2: 'error' followed by a LATE 'exit' is idempotent — the stale exit must not settle the NEXT build on the fresh worker", async () => {
		useSilentChildren()
		const worker = devkit.createCompileWorker({})
		const pending = worker.build(REQUEST)
		await vi.waitFor(() => {
			expect(children.length).toBe(1)
		}, { timeout: 5000 })
		const first = children[0] as FakeChild

		first.emit('error', new Error('spawn failure'))
		expect(
			await raceSettle(pending, 2000),
			"the 'error' event alone must settle the in-flight build (see the companion M2 test)",
		).toBe('rejected')

		// Start the recovery build, THEN let the dead child's 'exit' fire late
		// (the real-world double-fire). The stale exit must not reject the new
		// in-flight build that belongs to the fresh worker.
		const second = worker.build(REQUEST)
		await vi.waitFor(() => {
			expect(children.length).toBe(2)
		}, { timeout: 5000 })
		first.crash(1)
		await sleep(20)

		const fresh = children[1] as FakeChild
		await vi.waitFor(() => {
			expect(fresh.buildSends().length).toBe(1)
		}, { timeout: 5000 })
		fresh.respondToBuild('/tmp/p')
		await expect(
			second,
			"the dead child's late 'exit' must be a no-op for the new generation — error+exit double-fire settles ONE build, once",
		).resolves.toEqual(expect.objectContaining({ appId: WORKER_APP.appId }))
	}, 45_000)

	it("M3: close() returns a promise that resolves only AFTER the child actually exited — kill-and-return is not a close", async () => {
		const worker = devkit.createCompileWorker({})
		await worker.build(REQUEST)
		const child = children[0] as FakeChild
		// From here the child only dies when the test says so.
		child.manualExit = true

		const closeResult: unknown = worker.close()
		expect(
			closeResult,
			'close() must return a promise tied to the child exit — a void kill-and-return lets callers proceed while the compiler is still dying',
		).toBeInstanceOf(Promise)

		let settledEarly = false
		void (closeResult as Promise<void>).then(
			() => {
				settledEarly = true
			},
			() => {
				settledEarly = true
			},
		)
		await sleep(50)
		expect(
			settledEarly,
			"close()'s promise must NOT settle before the child emitted 'exit' — resolving early defeats the whole guarantee",
		).toBe(false)

		child.emit('exit', null, 'SIGTERM')
		await (closeResult as Promise<void>)
	}, 45_000)

	it('M3: close() itself rejects the in-flight build — even when the child never emits exit', async () => {
		useSilentChildren()
		const worker = devkit.createCompileWorker({})
		const pending = worker.build(REQUEST)
		await vi.waitFor(() => {
			expect(children.length).toBe(1)
		}, { timeout: 5000 })
		const child = children[0] as FakeChild
		// A wedged child that ignores SIGTERM: kill() never produces 'exit'.
		child.manualExit = true

		worker.close()

		expect(
			await raceSettle(pending, 1500),
			'close() must settle the in-flight build ITSELF — delegating the rejection to a child exit that may never '
			+ 'come leaves the rebuild scheduler hanging at teardown',
		).toBe('rejected')
	}, 45_000)

	/**
	 * CODEX RE-REVIEW — M3 NOT-RESOLVED follow-up. `settleDeath`'s
	 * `removeAllListeners()` also strips the `once('exit', resolve)` that
	 * close() registered on the SAME child: when a child dies through the
	 * 'error' path while a close() is in flight (kill sent, exit not yet
	 * emitted), the closePromise loses its only resolver and hangs forever.
	 * Contract: a child 'error' during an in-flight close is a death signal
	 * (Node does NOT guarantee an 'exit' after 'error' — see M2) — the close
	 * promise must still resolve, whether a late 'exit' follows or never comes.
	 * The normal-exit-resolves case is already pinned above ("M3: close()
	 * returns a promise that resolves only AFTER the child actually exited").
	 */
	it("M3 follow-up: a child 'error' during an in-flight close() must not strip the close resolver — closePromise resolves even though only a LATE 'exit' follows", async () => {
		const worker = devkit.createCompileWorker({})
		await worker.build(REQUEST)
		const child = children[0] as FakeChild
		// kill() no longer auto-exits: close() stays in flight until the test
		// drives the death events by hand.
		child.manualExit = true

		const closeResult = worker.close()
		expect(child.kill).toHaveBeenCalled()

		// The child dies via 'error' first (settleDeath runs and — today —
		// removeAllListeners() takes close()'s once('exit') resolver with it)…
		child.emit('error', new Error('EPIPE'))
		// …then the real-world late 'exit' fires. With the resolver stripped,
		// nobody is listening and closePromise hangs forever.
		child.emit('exit', null, 'SIGTERM')

		expect(
			await raceSettle(closeResult, 1500),
			"settleDeath's removeAllListeners must not strip close()'s exit resolver — a child that dies via "
			+ "'error' mid-close leaves closePromise hanging forever, wedging every awaiter of session.close()",
		).toBe('resolved')
	}, 45_000)

	it("M3 follow-up: a child 'error' during an in-flight close() with NO 'exit' ever resolves the close too — 'error' is a death signal, not a wait-longer signal", async () => {
		const worker = devkit.createCompileWorker({})
		await worker.build(REQUEST)
		const child = children[0] as FakeChild
		child.manualExit = true

		const closeResult = worker.close()
		expect(child.kill).toHaveBeenCalled()

		// Node does NOT guarantee an 'exit' after 'error' (the exact premise M2
		// pinned for builds): the lone 'error' must settle the close as well.
		child.emit('error', new Error('spawn EAGAIN'))

		expect(
			await raceSettle(closeResult, 1500),
			"a lone child 'error' during close() must resolve the close promise — settleDeath already treats "
			+ "'error' as death everywhere else (clears the child, rejects builds); close() waiting for an 'exit' "
			+ 'that Node never guarantees hangs teardown forever',
		).toBe('resolved')
	}, 45_000)

	it('m7: a final line WITHOUT a trailing newline is flushed to onLog exactly once when the stream ends', async () => {
		const root = makeFixture()
		const entries: LogEntry[] = []
		const logOpts = { onLog: (entry: LogEntry) => entries.push(entry) }
		const session = await devkit.openProject({
			projectPath: root,
			watch: false,
			outputDir: path.join(root, '.out'),
			...logOpts,
		})
		openSessions.push(session)
		const child = theChild()
		entries.length = 0

		// dmcc's last line (often the error summary) can end without a '\n'
		// when the process dies — the buffered remainder must still surface.
		child.stderr.write('pages/index/index.js 编译出错: Transform failed')
		child.stderr.end()

		await vi.waitFor(() => {
			expect(
				entries.filter(entry => entry.text.includes('编译出错')).length,
				'the un-terminated final line must be flushed to onLog when the stream ends — today it is buffered forever and silently dropped',
			).toBe(1)
		}, { timeout: 3000 })
		await sleep(50)

		// PassThrough emits BOTH 'end' and 'close' — the flush must not double-fire.
		expect(entries).toHaveLength(1)
		expect(entries[0]).toEqual({
			stream: 'stderr',
			text: 'pages/index/index.js 编译出错: Transform failed',
		})
	}, 45_000)
})
