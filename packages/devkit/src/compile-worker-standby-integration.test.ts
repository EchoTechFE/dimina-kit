import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as devkit from './index.js'
import type {
	CompileWorkerStandby,
	CompileWorkerStandbyOptions,
	StandbyEvent,
} from './compile-worker-standby.js'

/**
 * Integration contract wiring the warm-standby manager into `openProject`:
 * `enableCompileWorkerStandby(opts?)` (a new devkit export) turns the spare
 * on for the whole devkit instance —
 *
 *  - enabling immediately forks + prewarms a REAL compile-worker-entry
 *    spare (no `entry` test hook here — this is the production path);
 *  - the call is idempotent while the manager lives: repeated calls return
 *    the SAME instance and never fork a second spare; after `dispose()` a
 *    new call builds a fresh manager that warms up again;
 *  - once ready, the NEXT `openProject` adopts the spare: its first compile
 *    runs in the pre-warmed process instead of a fresh fork;
 *  - after `session.close()` the manager refills a new spare on its own, so
 *    the next open is warm too;
 *  - after `dispose()` everything degrades to today's cold path: opens
 *    still work (fresh fork) and no spare ever appears again.
 *
 * Every "which process is running" claim is proven by a real OS scan
 * (`ps -axo pid=,ppid=,command=` filtered to direct children of THIS test
 * process running compile-worker-entry) — never by a spy.
 */

type EnableFn = (opts?: CompileWorkerStandbyOptions) => CompileWorkerStandby

function getEnable(): EnableFn {
	const fn = (devkit as Record<string, unknown>).enableCompileWorkerStandby
	expect(
		typeof fn,
		'devkit must export enableCompileWorkerStandby(opts?) — the one switch that turns the warm-standby accelerator on',
	).toBe('function')
	return fn as EnableFn
}

function sleep(ms: number): Promise<void> {
	return new Promise<void>(resolve => setTimeout(resolve, ms))
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

async function waitForPidDeath(pid: number, timeoutMs = 8000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (!pidAlive(pid)) return true
		await sleep(100)
	}
	return !pidAlive(pid)
}

async function pollUntil(fn: () => boolean, timeoutMs: number, intervalMs = 100): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	let last = fn()
	while (!last && Date.now() < deadline) {
		await sleep(intervalMs)
		last = fn()
	}
	return last
}

/** Direct compile-worker-entry children of THIS test process (real PID scan). */
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

const openSessions: Array<{ close: () => Promise<void> }> = []
const activeManagers: CompileWorkerStandby[] = []
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
	for (const manager of activeManagers.splice(0)) {
		try {
			await manager.dispose()
		}
		catch {
			// best-effort teardown
		}
	}
	// Hard sweep: nothing this suite forks may outlive its test.
	for (const pid of findCompileWorkerPids()) {
		try {
			process.kill(pid, 'SIGKILL')
		}
		catch {
			// already gone
		}
	}
	for (const root of cleanupRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true })
	}
})

function makeFixture(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-standby-integ-'))
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

/**
 * A projectPath that does not exist on disk: the worker-side
 * chdir(projectPath) throws ENOENT, the build settles as a failure, and
 * openProject rejects — AFTER the compile worker (the adopted spare) was
 * already consumed. A merely-miscompiling project is NOT enough here:
 * dmcc swallows compile errors (resolves undefined) and openProject's appId
 * fallback tolerates even an unparsable project.config.json, so a broken-
 * content fixture opens "successfully" in degraded form.
 */
function makeBrokenFixture(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-standby-integ-broken-'))
	fs.rmSync(root, { recursive: true, force: true })
	return root
}

function spawnedPids(events: StandbyEvent[]): number[] {
	return events.filter(ev => ev.type === 'spawned').map(ev => ev.pid!)
}

async function enableAndAwaitReady(events: StandbyEvent[]): Promise<CompileWorkerStandby> {
	const enable = getEnable()
	const manager = enable({ onEvent: (ev: StandbyEvent) => events.push(ev) })
	activeManagers.push(manager)
	const ready = await pollUntil(() => manager.state === 'ready', 30_000)
	expect(ready, `standby never reached ready (stuck at ${manager.state}) — the REAL entry must prewarm end to end`).toBe(true)
	return manager
}

describe('enableCompileWorkerStandby — enable-time warm-up and idempotence', () => {
	it('enabling immediately warms ONE real spare to ready; repeated calls return the SAME instance without a second fork; after dispose() a new enable builds a fresh manager that warms again', async () => {
		const events: StandbyEvent[] = []
		const manager = await enableAndAwaitReady(events)

		const again = getEnable()()
		expect(
			again,
			'enableCompileWorkerStandby while the manager lives must return the SAME instance — two live managers would each own a spare',
		).toBe(manager)
		await sleep(300)
		expect(spawnedPids(events), 'the repeated enable must not fork a second spare').toHaveLength(1)
		const firstPid = spawnedPids(events)[0]!
		expect(findCompileWorkerPids()).toEqual([firstPid])

		await manager.dispose()
		expect(manager.state).toBe('disposed')
		expect(await waitForPidDeath(firstPid), 'dispose() must leave the spare actually dead').toBe(true)

		const rebornEvents: StandbyEvent[] = []
		const reborn = await enableAndAwaitReady(rebornEvents)
		expect(
			reborn,
			'enable after dispose() must build a FRESH manager — the disposed one is terminal',
		).not.toBe(manager)
		const secondPid = spawnedPids(rebornEvents)[0]!
		expect(secondPid).not.toBe(firstPid)
		expect(pidAlive(secondPid)).toBe(true)
	}, 90_000)
})

describe('enableCompileWorkerStandby — openProject adopts the spare, close() refills it', () => {
	it('openProject with a ready spare reuses THAT process for its first compile (no fresh fork), and after session.close() the manager refills a new, different-pid spare back to ready', async () => {
		const events: StandbyEvent[] = []
		const manager = await enableAndAwaitReady(events)
		const standbyPid = spawnedPids(events)[0]!
		expect(findCompileWorkerPids(), 'precondition: exactly the spare is alive before open').toEqual([standbyPid])

		const root = makeFixture()
		const session = await devkit.openProject({
			projectPath: root,
			watch: false,
			outputDir: path.join(root, '.out'),
		})
		openSessions.push(session)

		expect(session.appInfo.appId, 'the adopted spare must produce a real, correct compile').toBe('fixture_app_001')
		expect(
			findCompileWorkerPids(),
			'after open, the ONLY live compile-worker-entry child must be the pre-warmed spare — adoption, not a fresh fork next to an idle spare',
		).toEqual([standbyPid])

		await session.close()

		expect(
			await waitForPidDeath(standbyPid),
			'the adopted worker must die with its session — adoption transfers ownership, not immortality',
		).toBe(true)
		const refilled = await pollUntil(() => manager.state === 'ready', 30_000)
		expect(refilled, `after close() the manager must refill a new spare on its own (stuck at ${manager.state})`).toBe(true)
		const pids = spawnedPids(events)
		expect(pids.length, 'the refill must be a NEW spawn').toBeGreaterThanOrEqual(2)
		const refillPid = pids.at(-1)!
		expect(refillPid).not.toBe(standbyPid)
		expect(pidAlive(refillPid)).toBe(true)
	}, 120_000)

	it('a FAILED openProject also consumes the spare cleanly: the adopted worker is dead afterwards and the manager refills back to ready on a new pid', async () => {
		const events: StandbyEvent[] = []
		const manager = await enableAndAwaitReady(events)
		const standbyPid = spawnedPids(events)[0]!
		expect(findCompileWorkerPids(), 'precondition: exactly the spare is alive before open').toEqual([standbyPid])

		const root = makeBrokenFixture()
		// The outputDir must live OUTSIDE the nonexistent root: openProject
		// creates the outputDir recursively, and an outputDir nested under the
		// root would re-create the root as a side effect — turning the intended
		// hard failure into a degraded-but-successful open of an empty project.
		const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-standby-integ-out-'))
		cleanupRoots.push(outputDir)
		let rejected = false
		try {
			const session = await devkit.openProject({
				projectPath: root,
				watch: false,
				outputDir,
			})
			openSessions.push(session)
		}
		catch {
			rejected = true
		}
		expect(
			rejected,
			'precondition: a nonexistent projectPath must make openProject reject (worker-side chdir ENOENT)',
		).toBe(true)

		// The failure path must not leak the consumed spare: it was adopted
		// into the failed open, and the failed open's cleanup must kill it.
		expect(
			await waitForPidDeath(standbyPid, 10_000),
			'the spare consumed by a FAILED open must be dead afterwards — failure cleanup owns the adopted worker exactly like session.close() does',
		).toBe(true)

		const refilled = await pollUntil(() => manager.state === 'ready', 30_000)
		expect(
			refilled,
			`a failed open must refill the standby just like a successful open+close does (stuck at ${manager.state})`,
		).toBe(true)
		const pids = spawnedPids(events)
		expect(pids.length).toBeGreaterThanOrEqual(2)
		const refillPid = pids.at(-1)!
		expect(refillPid).not.toBe(standbyPid)
		expect(pidAlive(refillPid)).toBe(true)
	}, 120_000)
})

describe('enableCompileWorkerStandby — dispose() restores the pure cold path', () => {
	it('after manager.dispose(), openProject still succeeds via a fresh cold fork, and after close() NO spare ever appears again (quiet window)', async () => {
		const events: StandbyEvent[] = []
		const manager = await enableAndAwaitReady(events)
		const oldStandbyPid = spawnedPids(events)[0]!

		await manager.dispose()
		expect(await waitForPidDeath(oldStandbyPid)).toBe(true)

		const root = makeFixture()
		const session = await devkit.openProject({
			projectPath: root,
			watch: false,
			outputDir: path.join(root, '.out'),
		})
		openSessions.push(session)
		expect(session.appInfo.appId, 'a disposed standby must not break opening — cold path is the structural fallback').toBe('fixture_app_001')

		const coldPids = findCompileWorkerPids()
		expect(coldPids, 'the cold path forks exactly one fresh worker').toHaveLength(1)
		expect(coldPids[0]).not.toBe(oldStandbyPid)

		await session.close()
		expect(await waitForPidDeath(coldPids[0]!)).toBe(true)

		// Quiet window: a disposed manager must never refill — no new
		// compile-worker-entry child may appear after the session closed.
		await sleep(2000)
		expect(
			findCompileWorkerPids(),
			'a disposed standby manager must NEVER fork again — a post-dispose refill is an untracked orphan factory',
		).toHaveLength(0)
	}, 120_000)
})
