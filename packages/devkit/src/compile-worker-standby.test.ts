import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
	createCompileWorkerStandby,
	type StandbyEvent,
} from './compile-worker-standby.js'

/**
 * Contract for the warm-standby MANAGER: devtools forks a project-agnostic
 * "spare" compile worker while no project is open and pre-loads its compiler
 * (see `compile-worker-entry-warmpool.test.ts` for the ping/prewarm protocol
 * the spare speaks). `createCompileWorkerStandby` owns exactly one spare at a
 * time and must be a pure accelerator: any failure of the spare degrades to
 * "no spare" — it must never make opening a project fail or hang.
 *
 * These are REAL-fork tests (no `child_process` mock): a fixture entry script
 * is forked via the `entry` test hook and its behavior (answer ping/prewarm,
 * stay silent, or crash immediately) is scripted per test. Every check on
 * "the spare died" or "the spare was killed" is a real OS PID check —
 * `process.kill(pid, 0)` — not a spy on an intent to kill.
 */

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

/** Bounded poll for an arbitrary condition — never throws/hangs past the deadline. */
async function pollUntil(fn: () => boolean, timeoutMs: number, intervalMs = 50): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	let last = fn()
	while (!last && Date.now() < deadline) {
		await sleep(intervalMs)
		last = fn()
	}
	return last
}

async function waitForState(
	standby: { state: string },
	target: string,
	timeoutMs = 5000,
): Promise<string> {
	await pollUntil(() => standby.state === target, timeoutMs)
	return standby.state
}

/**
 * Direct children of THIS test process whose command line contains `tag`
 * (the fixture's own unique tmp-dir path) — mirrors the ps-scan technique
 * `compile-worker-leak.test.ts` uses for real PID discovery, scoped by a
 * per-test unique tag instead of a shared module name.
 */
function findChildPidsByCommand(tag: string): number[] {
	const out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
	const pids: number[] = []
	for (const line of out.split('\n')) {
		const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
		if (!match) continue
		const [, pid, ppid, command] = match
		if (Number(ppid) !== process.pid) continue
		if (!command!.includes(tag)) continue
		pids.push(Number(pid))
	}
	return pids
}

// ── fixture entries: scripted IPC children, no compiler involved ───────────

/** Answers both ping and prewarm normally — the happy-path spare. */
const FIXTURE_HAPPY = `
process.on('message', (msg) => {
	if (!msg) return
	if (msg.cmd === 'ping') process.send({ type: 'pong', id: msg.id })
	else if (msg.cmd === 'prewarm') process.send({ type: 'prewarm-result', id: msg.id, ok: true })
})
`

/** Prewarms fine but never answers ping — simulates a wedged-but-alive spare. */
const FIXTURE_SILENT_PING = `
process.on('message', (msg) => {
	if (!msg) return
	if (msg.cmd === 'prewarm') process.send({ type: 'prewarm-result', id: msg.id, ok: true })
})
`

/** Dies immediately on load — drives the circuit-breaker crash-loop scenario. */
const FIXTURE_CRASH_IMMEDIATELY = `
process.exit(1)
`

/**
 * First spawn answers prewarm with ok:false (the process itself stays alive
 * and still answers ping); every later spawn prewarms normally. The spawn
 * counter lives in a file next to the fixture, so the SECOND process the
 * manager forks (the refill) sees n=2 and behaves healthy — modelling a
 * transient toolchain-load failure that a fresh process recovers from.
 */
const FIXTURE_PREWARM_FAIL_ONCE = `
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
const counter = fileURLToPath(new URL('./spawn-count.txt', import.meta.url))
let n = 0
try { n = Number(fs.readFileSync(counter, 'utf8')) || 0 } catch {}
n += 1
fs.writeFileSync(counter, String(n))
const failPrewarm = n === 1
process.on('message', (msg) => {
	if (!msg) return
	if (msg.cmd === 'ping') process.send({ type: 'pong', id: msg.id })
	else if (msg.cmd === 'prewarm') {
		if (failPrewarm) process.send({ type: 'prewarm-result', id: msg.id, ok: false, error: 'toolchain load failed (scripted)' })
		else process.send({ type: 'prewarm-result', id: msg.id, ok: true })
	}
})
`

const cleanupDirs: string[] = []
const doomedPids: number[] = []
const openStandbys: Array<{ dispose: () => Promise<void> }> = []

function mkTmp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-standby-'))
	cleanupDirs.push(dir)
	return dir
}

function writeFixture(dir: string, body: string): string {
	const file = path.join(dir, 'entry.mjs')
	fs.writeFileSync(file, body)
	return file
}

afterEach(async () => {
	for (const standby of openStandbys.splice(0)) {
		try {
			await standby.dispose()
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
	for (const dir of cleanupDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true })
	}
})

describe('createCompileWorkerStandby — ensure() forks + prewarms exactly one spare (idempotent)', () => {
	it('ensure() transitions empty → warming → ready; spawned (with pid) fires before prewarmed; repeated ensure() forks nothing new', async () => {
		const dir = mkTmp()
		const entry = writeFixture(dir, FIXTURE_HAPPY)
		const events: StandbyEvent[] = []
		const standby = createCompileWorkerStandby({ entry, onEvent: (ev: StandbyEvent) => events.push(ev) })
		openStandbys.push(standby)

		expect(standby.state).toBe('empty')
		standby.ensure()

		const readyState = await waitForState(standby, 'ready', 8000)
		expect(readyState, `standby never reached ready (stuck at ${standby.state})`).toBe('ready')

		const spawned = events.filter(ev => ev.type === 'spawned')
		expect(spawned).toHaveLength(1)
		expect(typeof spawned[0]!.pid).toBe('number')
		doomedPids.push(spawned[0]!.pid!)

		const spawnedIdx = events.findIndex(ev => ev.type === 'spawned')
		const prewarmedIdx = events.findIndex(ev => ev.type === 'prewarmed')
		expect(prewarmedIdx, 'a prewarmed event must fire').toBeGreaterThanOrEqual(0)
		expect(spawnedIdx).toBeLessThan(prewarmedIdx)

		standby.ensure()
		standby.ensure()
		await sleep(200)

		expect(
			events.filter(ev => ev.type === 'spawned'),
			'repeated ensure() while warming/ready must be a no-op — exactly one spare, ever',
		).toHaveLength(1)
		expect(findChildPidsByCommand(dir)).toHaveLength(1)
	}, 20_000)
})

describe('createCompileWorkerStandby — adopt() hands the spare over', () => {
	it('adopt() after ready returns the live ChildProcess (matching pid, connected), fires adopted, resets to empty; a second adopt() is null; dispose() afterwards leaves the handed-over process ALIVE', async () => {
		const dir = mkTmp()
		const entry = writeFixture(dir, FIXTURE_HAPPY)
		const events: StandbyEvent[] = []
		const standby = createCompileWorkerStandby({ entry, onEvent: (ev: StandbyEvent) => events.push(ev) })
		openStandbys.push(standby)

		standby.ensure()
		await waitForState(standby, 'ready', 8000)
		const spawnedPid = events.find(ev => ev.type === 'spawned')!.pid!

		const adopted = await standby.adopt()
		expect(adopted, 'adopt() on a ready spare must hand over a ChildProcess').not.toBeNull()
		expect(adopted!.pid).toBe(spawnedPid)
		expect(adopted!.connected).toBe(true)
		expect(standby.state).toBe('empty')
		expect(events.some(ev => ev.type === 'adopted' && ev.pid === spawnedPid)).toBe(true)

		const second = await standby.adopt()
		expect(second, 'adopt() with no spare left must return null, not resurrect one').toBeNull()

		await standby.dispose()
		expect(
			pidAlive(spawnedPid),
			'dispose() must never kill a process the manager already handed off — the CALLER owns it now',
		).toBe(true)

		// test-owned cleanup of the handed-over process
		process.kill(spawnedPid, 'SIGKILL')
		await waitForPidDeath(spawnedPid)
	}, 20_000)
})

describe('createCompileWorkerStandby — adopt() health check', () => {
	it('a spare externally SIGKILLed before adopt() fails the health check: adopt() → null, health-check-failed fires', async () => {
		const dir = mkTmp()
		const entry = writeFixture(dir, FIXTURE_HAPPY)
		const events: StandbyEvent[] = []
		const standby = createCompileWorkerStandby({ entry, onEvent: (ev: StandbyEvent) => events.push(ev) })
		openStandbys.push(standby)

		standby.ensure()
		await waitForState(standby, 'ready', 8000)
		const pid = events.find(ev => ev.type === 'spawned')!.pid!
		process.kill(pid, 'SIGKILL')
		await waitForPidDeath(pid)

		const adopted = await standby.adopt()
		expect(adopted).toBeNull()
		expect(events.some(ev => ev.type === 'health-check-failed')).toBe(true)
	}, 20_000)

	it('a spare that never answers ping times out the health check: adopt() → null, health-check-failed fires, and the wedged spare is ACTUALLY killed', async () => {
		const dir = mkTmp()
		const entry = writeFixture(dir, FIXTURE_SILENT_PING)
		const events: StandbyEvent[] = []
		const standby = createCompileWorkerStandby({
			entry,
			onEvent: (ev: StandbyEvent) => events.push(ev),
			healthCheckTimeoutMs: 300,
		})
		openStandbys.push(standby)

		standby.ensure()
		await waitForState(standby, 'ready', 8000)
		const pid = events.find(ev => ev.type === 'spawned')!.pid!
		expect(pidAlive(pid)).toBe(true)
		doomedPids.push(pid)

		const adopted = await standby.adopt()
		expect(adopted).toBeNull()
		expect(events.some(ev => ev.type === 'health-check-failed')).toBe(true)
		expect(
			await waitForPidDeath(pid, 5000),
			'a spare that fails its own health check must be killed, not left running unmonitored',
		).toBe(true)
	}, 20_000)
})

describe('createCompileWorkerStandby — unexpected death auto-refills', () => {
	it('an unexpected death of the READY spare fires died and auto-refills a NEW spare (different pid), returning to ready', async () => {
		const dir = mkTmp()
		const entry = writeFixture(dir, FIXTURE_HAPPY)
		const events: StandbyEvent[] = []
		const standby = createCompileWorkerStandby({ entry, onEvent: (ev: StandbyEvent) => events.push(ev) })
		openStandbys.push(standby)

		standby.ensure()
		await waitForState(standby, 'ready', 8000)
		const firstPid = events.find(ev => ev.type === 'spawned')!.pid!

		process.kill(firstPid, 'SIGKILL')

		const diedFired = await pollUntil(() => events.some(ev => ev.type === 'died'), 5000)
		expect(diedFired, 'an unexpected spare death must fire a died event').toBe(true)

		const readyAgain = await waitForState(standby, 'ready', 8000)
		expect(readyAgain, 'the manager must auto-refill after an unexpected death').toBe('ready')

		const spawnedPids = events.filter(ev => ev.type === 'spawned').map(ev => ev.pid)
		expect(spawnedPids).toHaveLength(2)
		expect(spawnedPids[1]).not.toBe(firstPid)
		doomedPids.push(spawnedPids[1]!)
	}, 20_000)
})

describe('createCompileWorkerStandby — a spare whose prewarm FAILED is unusable', () => {
	it('a prewarm-result ok:false spare is never handed out as ready: the manager kills it (real PID death), fires died with its pid, and refills to ready on a fresh pid', async () => {
		const dir = mkTmp()
		const entry = writeFixture(dir, FIXTURE_PREWARM_FAIL_ONCE)
		const events: StandbyEvent[] = []
		const standby = createCompileWorkerStandby({ entry, onEvent: (ev: StandbyEvent) => events.push(ev) })
		openStandbys.push(standby)

		standby.ensure()

		// The first spawn's prewarm fails; the manager must recover through the
		// normal died→refill path and end ready on the SECOND (healthy) spawn.
		const readyState = await waitForState(standby, 'ready', 10_000)
		expect(
			readyState,
			`the manager must reach ready via a refill after the failed prewarm (stuck at ${standby.state})`,
		).toBe('ready')

		const spawnedPids = events.filter(ev => ev.type === 'spawned').map(ev => ev.pid!)
		expect(
			spawnedPids.length,
			'a failed prewarm must trigger a SECOND spawn — the broken spare is not retried in place',
		).toBeGreaterThanOrEqual(2)
		const firstPid = spawnedPids[0]!
		const currentPid = spawnedPids.at(-1)!
		expect(currentPid).not.toBe(firstPid)
		doomedPids.push(...spawnedPids)

		// The un-prewarmed process was alive and answering ping — only the
		// manager itself can have killed it. It must be REALLY dead, not idling
		// unowned next to the refill.
		expect(
			await waitForPidDeath(firstPid, 5000),
			'the spare whose prewarm failed must be killed by the manager — a live-but-cold process handed out later would silently lose the whole warm-up',
		).toBe(true)
		expect(
			events.some(ev => ev.type === 'died' && ev.pid === firstPid),
			'the failed-prewarm teardown must surface as a died event carrying the broken spare\'s pid',
		).toBe(true)

		// No prewarmed event may reference the broken first pid: ready was
		// reached by the refill, never by the ok:false spare.
		expect(
			events.some(ev => ev.type === 'prewarmed' && ev.pid === firstPid),
			'a spare that answered prewarm-result ok:false must never be reported prewarmed',
		).toBe(false)
		expect(pidAlive(currentPid)).toBe(true)
	}, 30_000)
})

describe('createCompileWorkerStandby — circuit breaker', () => {
	it('3 deaths within the window trip state=degraded, fire degraded exactly once, and permanently stop forking — ensure()/adopt() become no-ops', async () => {
		const dir = mkTmp()
		const entry = writeFixture(dir, FIXTURE_CRASH_IMMEDIATELY)
		const events: StandbyEvent[] = []
		const standby = createCompileWorkerStandby({
			entry,
			onEvent: (ev: StandbyEvent) => events.push(ev),
			breakerWindowMs: 60_000,
			breakerMaxDeaths: 3,
			healthCheckTimeoutMs: 300,
		})
		openStandbys.push(standby)

		standby.ensure()

		const degraded = await pollUntil(() => standby.state === 'degraded', 10_000)
		expect(degraded, `standby never degraded (stuck at ${standby.state})`).toBe(true)
		expect(events.filter(ev => ev.type === 'degraded')).toHaveLength(1)
		expect(events.filter(ev => ev.type === 'spawned')).toHaveLength(3)

		// quiet period: no further fork attempts once tripped
		await sleep(1000)
		expect(events.filter(ev => ev.type === 'spawned')).toHaveLength(3)
		expect(
			findChildPidsByCommand(dir).filter(pidAlive),
			'a tripped breaker must leave no live spare process behind',
		).toHaveLength(0)

		standby.ensure()
		await sleep(200)
		expect(events.filter(ev => ev.type === 'spawned'), 'ensure() while degraded is a no-op').toHaveLength(3)

		const adopted = await standby.adopt()
		expect(adopted, 'adopt() while degraded must return null, never resurrect the crash-loop').toBeNull()
	}, 30_000)
})

describe('createCompileWorkerStandby — dispose()', () => {
	it('dispose() while ready kills the spare (real PID death), moves state to disposed, and is idempotent; ensure()/adopt() afterwards are no-ops', async () => {
		const dir = mkTmp()
		const entry = writeFixture(dir, FIXTURE_HAPPY)
		const events: StandbyEvent[] = []
		const standby = createCompileWorkerStandby({ entry, onEvent: (ev: StandbyEvent) => events.push(ev) })
		openStandbys.push(standby)

		standby.ensure()
		await waitForState(standby, 'ready', 8000)
		const pid = events.find(ev => ev.type === 'spawned')!.pid!

		await standby.dispose()
		expect(standby.state).toBe('disposed')
		expect(
			await waitForPidDeath(pid, 5000),
			'dispose() must leave the spare actually dead, not merely requested to die',
		).toBe(true)

		await expect(standby.dispose()).resolves.toBeUndefined()

		standby.ensure()
		await sleep(200)
		expect(standby.state, 'a disposed standby is terminal — ensure() must not resurrect it').toBe('disposed')
		const adopted = await standby.adopt()
		expect(adopted).toBeNull()
	}, 20_000)
})

describe('createCompileWorkerStandby — empty state', () => {
	it('adopt() with no ensure() ever called returns null and forks nothing', async () => {
		const standby = createCompileWorkerStandby({})
		openStandbys.push(standby)

		expect(standby.state).toBe('empty')
		const adopted = await standby.adopt()
		expect(adopted).toBeNull()
		expect(standby.state).toBe('empty')
	})
})
