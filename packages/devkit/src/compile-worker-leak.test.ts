import { execFileSync, fork, spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import * as devkit from './index.js'
import { writeUntilPredicate } from './watch-rebuild.testutil.js'

/*
 * FLAKE HARDENING (no assertions changed): the "close during in-flight
 * rebuild" test below relies on a REAL chokidar inotify watch to start a
 * rebuild. Under CI load a single fs.writeFileSync's event can be dropped,
 * so the `sawRebuildOutput` precondition (count-agnostic: logEntries.length
 * > 0) re-writes the source file until the rebuild's first log line appears.
 */

/**
 * LEAK-PROOFING WAVE (项目关闭时保证编译子进程同步关闭) — REAL-PROCESS
 * integration contract. Nothing in this file mocks `child_process`: every
 * test forks the actual `compile-worker-entry` (and, for the `openProject`
 * tests, runs the actual `@dimina/compiler`) and asserts on REAL process
 * death via `process.kill(pid, 0)` (ESRCH ⇒ the PID is gone).
 *
 * Why these tests exist on top of the existing mocked-fork suite
 * (`compile-worker.test.ts` pins `child.kill` was CALLED): a kill() spy
 * proves intent, not death. The two leak classes this file closes:
 *
 *  ① ORPHAN SAFETY NET — the worker must kill ITSELF when the fork IPC
 *    channel goes away. This is the only mechanism that covers every parent
 *    death that never reaches `session.close()`: host crash, SIGKILL,
 *    `process.exit` in a teardown race. Pinned two ways:
 *      - parent-side `child.disconnect()` (the channel-closed signal in
 *        isolation) → the entry must exit(0) on its own;
 *      - a REAL orphaning: an intermediate parent forks the entry and then
 *        SIGKILLs itself — the orphan must still die unaided.
 *
 *  ② TRUE DEATH ON close() — `session.close()` must leave the worker PID
 *    actually dead (not merely "kill was invoked"), including when a build
 *    is in flight at close time.
 *
 * PID discovery (decision recorded for the implementer): NO new public API
 * is pinned for exposing the worker PID. The worker is discovered externally
 * via a `ps -axo pid=,ppid=,command=` scan for children of THIS test process
 * whose command line contains `compile-worker-entry`. That keeps the
 * contract purely behavioral — if the implementation later wants to expose
 * `worker.pid`, nothing here constrains it either way.
 *
 * CI stability: all death checks are bounded polls (8s deadline, 100ms
 * interval), and every discovered/forked PID is SIGKILLed in cleanup so a
 * genuinely failing implementation cannot leak processes out of the suite.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Fork target — same resolution rule as compile-worker.ts (src ⇒ .ts entry). */
function workerEntryPath(): string {
	const js = path.join(__dirname, 'compile-worker-entry.js')
	if (fs.existsSync(js)) return js
	return path.join(__dirname, 'compile-worker-entry.ts')
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	}
	catch {
		return false
	}
}

/** Bounded poll for real process death. Resolves true iff the PID vanished. */
async function waitForPidDeath(pid: number, timeoutMs = 8000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (!pidAlive(pid)) return true
		await sleep(100)
	}
	return !pidAlive(pid)
}

function sleep(ms: number): Promise<void> {
	return new Promise<void>(resolve => setTimeout(resolve, ms))
}

/**
 * Find compile-worker PIDs that are DIRECT children of this test process.
 * esbuild service processes are children of the worker (grandchildren of the
 * test), and vitest's own pool children belong to a different parent — the
 * ppid filter excludes both.
 */
function findCompileWorkerPids(): number[] {
	const out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
	const pids: number[] = []
	for (const line of out.split('\n')) {
		const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
		if (!match) continue
		const [, pid, ppid, command] = match
		if (Number(ppid) !== process.pid) continue
		if (!command!.includes('compile-worker-entry')) continue
		pids.push(Number(pid))
	}
	return pids
}

// ── cleanup ledger: nothing this suite spawns may outlive it ───────────────
const doomedPids: number[] = []
const openSessions: Array<{ close: () => Promise<void> }> = []
const cleanupRoots: string[] = []

afterEach(async () => {
	for (const session of openSessions.splice(0)) {
		try {
			await session.close()
		}
		catch {
			// best-effort teardown
		}
	}
	for (const pid of doomedPids.splice(0)) {
		if (pidAlive(pid)) {
			try {
				process.kill(pid, 'SIGKILL')
			}
			catch {
				// already gone
			}
		}
	}
	for (const root of cleanupRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true })
	}
})

function makeFixture(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-worker-leak-'))
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

describe('① orphan safety net — the worker kills ITSELF when the IPC channel dies', () => {
	it('a forked entry whose parent disconnects the IPC channel exits ON ITS OWN with code 0 (no kill from anyone)', async () => {
		const child = fork(workerEntryPath(), [], { execArgv: [], silent: true })
		doomedPids.push(child.pid!)
		await once(child, 'spawn')

		const exited = once(child, 'exit')
		// The channel-closed signal in isolation: the parent stays alive and
		// NEVER calls kill — the only way the child dies is its own
		// disconnect handler. This is exactly what the worker observes when
		// the host process dies without running session.close().
		child.disconnect()

		const result = await Promise.race([
			exited,
			sleep(8000).then(() => 'TIMEOUT' as const),
		])
		expect(
			result,
			'the compile worker must exit on its own when the fork IPC channel disconnects — '
			+ 'a worker that lingers after channel loss is an orphan leak on every parent death that skips close()',
		).not.toBe('TIMEOUT')

		const [code] = result as [number | null, NodeJS.Signals | null]
		expect(
			code,
			'the disconnect self-exit must be graceful (exit code 0) — a crash-style death would pollute crash telemetry/logs',
		).toBe(0)

		expect(await waitForPidDeath(child.pid!)).toBe(true)
	}, 30_000)

	it('REAL orphaning: parent process SIGKILLed (never calls close) — the orphaned worker still dies unaided', async () => {
		// Intermediate parent: forks the entry, reports the child PID on
		// stdout, then SIGKILLs ITSELF. SIGKILL is the harshest parent death —
		// no exit handlers, no kill(child), nothing but the OS closing the
		// IPC pipe. The orphan must notice and exit.
		const helperSource = `
			const { fork } = require('node:child_process')
			const fs = require('node:fs')
			const child = fork(process.argv[1], [], { execArgv: [], silent: true })
			child.on('spawn', () => {
				fs.writeSync(1, 'CHILD_PID=' + child.pid + '\\n')
				process.kill(process.pid, 'SIGKILL')
			})
		`
		const parent = spawn(process.execPath, ['-e', helperSource, workerEntryPath()], {
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		doomedPids.push(parent.pid!)

		let stdout = ''
		parent.stdout.on('data', (chunk: Buffer) => {
			stdout += chunk.toString('utf8')
		})
		const [, signal] = (await once(parent, 'exit')) as [number | null, NodeJS.Signals | null]
		expect(signal, 'precondition: the intermediate parent must die by SIGKILL').toBe('SIGKILL')

		const match = stdout.match(/CHILD_PID=(\d+)/)
		expect(match, 'precondition: the intermediate parent must report the worker PID before dying').not.toBeNull()
		const orphanPid = Number(match![1])
		doomedPids.push(orphanPid)

		expect(
			await waitForPidDeath(orphanPid),
			`orphaned compile worker (pid ${orphanPid}) must exit on its own after its parent was SIGKILLed — `
			+ 'this is the safety net for every host death that never reaches session.close()',
		).toBe(true)
	}, 30_000)
})

describe('② session.close() — the worker PID is ACTUALLY dead afterwards (real fork, real compiler)', () => {
	it('openProject forks a real worker; session.close() leaves that PID dead within the deadline', async () => {
		const root = makeFixture()
		const session = await devkit.openProject({
			projectPath: root,
			watch: false,
			outputDir: path.join(root, '.out'),
		})
		openSessions.push(session)

		const pids = findCompileWorkerPids()
		doomedPids.push(...pids)
		expect(
			pids.length,
			'precondition: after openProject resolves, exactly one live compile-worker child of this process is expected',
		).toBe(1)
		const workerPid = pids[0]!
		expect(pidAlive(workerPid)).toBe(true)

		await session.close()

		expect(
			await waitForPidDeath(workerPid),
			`session.close() must leave the compile worker (pid ${workerPid}) actually dead — `
			+ 'the existing suite only pins that kill() was INVOKED; this pins that the process is GONE',
		).toBe(true)
	}, 90_000)

	it('close() during an in-flight rebuild still leaves the worker PID dead within the deadline (no mid-build survivor)', async () => {
		const root = makeFixture()
		const logEntries: Array<{ stream: string, text: string }> = []
		const session = await devkit.openProject({
			projectPath: root,
			watch: true,
			outputDir: path.join(root, '.out'),
			// The in-flight build's death-by-close settles through the error
			// path — it must be swallowed here, not crash the suite.
			onBuildError: () => {},
			onLog: entry => logEntries.push(entry),
		})
		openSessions.push(session)

		const pids = findCompileWorkerPids()
		doomedPids.push(...pids)
		expect(pids.length, 'precondition: one live compile worker after open').toBe(1)
		const workerPid = pids[0]!

		// Trigger a watcher rebuild and close as soon as the worker shows
		// life (first rebuild log line ⇒ the build is running RIGHT NOW).
		// Best-effort in-flight timing: even if the rebuild squeaks through
		// before close lands, the pinned outcome (PID dead) must still hold.
		logEntries.length = 0
		// Count-agnostic precondition (logEntries.length > 0): re-write the
		// source until the rebuild's first log line appears, so a dropped
		// inotify event under CI load can't fail the precondition. The rebuild
		// scheduler coalesces the extra writes into one trailing build.
		let sawRebuildOutput = false
		await Promise.race([
			writeUntilPredicate(
				() => logEntries.length > 0,
				path.join(root, 'pages', 'index', 'index.js'),
				attempt => `Page({ data: { msg: "mid-build close-${attempt}" } })\n`,
			).then(() => { sawRebuildOutput = true }),
			sleep(20_000),
		])
		if (logEntries.length > 0) sawRebuildOutput = true
		expect(sawRebuildOutput, 'precondition: the watcher rebuild must have started (worker emitted output)').toBe(true)

		await session.close()

		expect(
			await waitForPidDeath(workerPid),
			`close() issued while a build was in flight must still leave the worker (pid ${workerPid}) dead — `
			+ 'a busy worker that survives close is the classic "compile still running after project closed" leak',
		).toBe(true)
	}, 90_000)

	/**
	 * CODEX-REVIEW REGRESSION (M3): the tests above tolerate an 8s post-close
	 * death poll. The actual contract is stronger — `await session.close()`
	 * must RETURN only after the worker already exited (close() awaits the
	 * child 'exit'), so the await itself is the death guarantee and no caller
	 * ever needs a grace poll.
	 */
	it("M3: await session.close() returns only AFTER the worker PID is already dead — the await IS the guarantee, no grace poll", async () => {
		const root = makeFixture()
		const session = await devkit.openProject({
			projectPath: root,
			watch: false,
			outputDir: path.join(root, '.out'),
		})
		openSessions.push(session)

		const pids = findCompileWorkerPids()
		doomedPids.push(...pids)
		expect(pids.length, 'precondition: one live compile worker after open').toBe(1)
		const workerPid = pids[0]!
		expect(pidAlive(workerPid)).toBe(true)

		await session.close()

		// Checked synchronously right after the await — NO waitForPidDeath poll.
		expect(
			pidAlive(workerPid),
			`session.close() resolved while the compile worker (pid ${workerPid}) was still alive — `
			+ "close() must await the child 'exit' before resolving; kill-and-return makes every caller race a dying "
			+ 'compiler for ports, output files and cwd',
		).toBe(false)
	}, 90_000)
})
