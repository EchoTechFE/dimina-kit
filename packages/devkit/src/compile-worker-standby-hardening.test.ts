import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
	createCompileWorkerStandby,
	type StandbyEvent,
} from './compile-worker-standby.js'

/**
 * Hardening contracts for the warm-standby manager (see
 * `compile-worker-standby.test.ts` for the base ensure/adopt/dispose
 * contract and the ping/prewarm protocol fixtures speak).
 *
 * Group A: adopt() must only ever hand over a spare whose prewarm has
 * actually completed — a spare still warming is not safe to use, and a
 * spare that is handed over must not be silently orphaned by whatever
 * outcome its still-in-flight prewarm eventually reports.
 *
 * Group B: dispose() must not leave a spare alive forever just because it
 * traps SIGTERM — it escalates to SIGKILL after `disposeGraceMs`.
 *
 * These are real-fork tests: fixtures are scripted child entry scripts, and
 * every "the spare died" / "the spare is still alive" check is a real OS
 * PID check (`process.kill(pid, 0)`), not a spy on intent.
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

async function pollUntil(fn: () => boolean, timeoutMs: number, intervalMs = 50): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	let last = fn()
	while (!last && Date.now() < deadline) {
		await sleep(intervalMs)
		last = fn()
	}
	return last
}

async function waitForState(standby: { state: string }, target: string, timeoutMs = 5000): Promise<string> {
	await pollUntil(() => standby.state === target, timeoutMs)
	return standby.state
}

/** Answers ping normally; prewarm succeeds only after a delay, to give tests a window while state is still 'warming'. */
const FIXTURE_DELAYED_PREWARM_OK = `
process.on('message', (msg) => {
	if (!msg) return
	if (msg.cmd === 'ping') process.send({ type: 'pong', id: msg.id })
	else if (msg.cmd === 'prewarm') {
		setTimeout(() => process.send({ type: 'prewarm-result', id: msg.id, ok: true }), 1000)
	}
})
`

/** Answers ping normally; prewarm reports failure only after a delay, to exercise the death path once already adopt()-attempted while warming. */
const FIXTURE_DELAYED_PREWARM_FAIL = `
process.on('message', (msg) => {
	if (!msg) return
	if (msg.cmd === 'ping') process.send({ type: 'pong', id: msg.id })
	else if (msg.cmd === 'prewarm') {
		setTimeout(() => process.send({ type: 'prewarm-result', id: msg.id, ok: false, error: 'delayed toolchain failure (scripted)' }), 800)
	}
})
`

/** Answers both ping and prewarm immediately — the happy-path spare. */
const FIXTURE_HAPPY = `
process.on('message', (msg) => {
	if (!msg) return
	if (msg.cmd === 'ping') process.send({ type: 'pong', id: msg.id })
	else if (msg.cmd === 'prewarm') process.send({ type: 'prewarm-result', id: msg.id, ok: true })
})
`

/** Traps SIGTERM and swallows it forever while still answering ping/prewarm normally — a spare that will not exit gracefully. */
const FIXTURE_TRAP_SIGTERM = `
process.on('SIGTERM', () => {})
process.on('message', (msg) => {
	if (!msg) return
	if (msg.cmd === 'ping') process.send({ type: 'pong', id: msg.id })
	else if (msg.cmd === 'prewarm') process.send({ type: 'prewarm-result', id: msg.id, ok: true })
})
`

const cleanupDirs: string[] = []
const doomedPids: number[] = []
const openStandbys: Array<{ dispose: () => Promise<void> }> = []

function mkTmp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-standby-hardening-'))
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

describe('createCompileWorkerStandby — adopt() only hands over a spare whose prewarm has completed', () => {
	it('adopt() during warming returns null and leaves the spare running untouched; the same spare is handed over once ready', async () => {
		const dir = mkTmp()
		const entry = writeFixture(dir, FIXTURE_DELAYED_PREWARM_OK)
		const events: StandbyEvent[] = []
		const standby = createCompileWorkerStandby({ entry, onEvent: (ev: StandbyEvent) => events.push(ev) })
		openStandbys.push(standby)

		standby.ensure()
		await sleep(200)
		expect(standby.state, 'prewarm is scripted to take ~1s, so it must still be in flight').toBe('warming')

		const duringWarming = await standby.adopt()
		expect(duringWarming, 'adopt() must not hand over a spare whose prewarm has not completed').toBeNull()

		const pid = events.find(ev => ev.type === 'spawned')!.pid!
		expect(pidAlive(pid), 'the spare must keep running untouched while adopt() defers to a null result').toBe(true)
		expect(events.some(ev => ev.type === 'adopted')).toBe(false)
		expect(events.some(ev => ev.type === 'health-check-failed')).toBe(false)
		expect(standby.state).toBe('warming')

		const readyState = await waitForState(standby, 'ready', 3000)
		expect(readyState).toBe('ready')

		const adopted = await standby.adopt()
		expect(adopted, 'once ready, the same spare must be handed over').not.toBeNull()
		expect(adopted!.pid).toBe(pid)

		process.kill(pid, 'SIGKILL')
		await waitForPidDeath(pid)
	}, 10_000)

	it('a null adopt() during warming does not orphan the spare — a later prewarm failure still kills it via the died path', async () => {
		const dir = mkTmp()
		const entry = writeFixture(dir, FIXTURE_DELAYED_PREWARM_FAIL)
		const events: StandbyEvent[] = []
		const standby = createCompileWorkerStandby({ entry, onEvent: (ev: StandbyEvent) => events.push(ev) })
		openStandbys.push(standby)

		standby.ensure()
		await sleep(200)
		const duringWarming = await standby.adopt()
		expect(duringWarming).toBeNull()

		const pid = events.find(ev => ev.type === 'spawned')!.pid!
		doomedPids.push(pid)

		const diedFired = await pollUntil(() => events.some(ev => ev.type === 'died'), 3000)
		expect(
			diedFired,
			'a spare whose prewarm later fails must still be torn down by the manager, not left unmonitored by the earlier null adopt()',
		).toBe(true)
		expect(
			await waitForPidDeath(pid, 3000),
			'a spare orphaned by an earlier null adopt() and a failed prewarm must actually die, not leak as a live process',
		).toBe(true)
	}, 10_000)

	it('adopt() called right after an unexpected death, before the refill fork completes, still fails its health check', async () => {
		const dir = mkTmp()
		const entry = writeFixture(dir, FIXTURE_HAPPY)
		const events: StandbyEvent[] = []
		const standby = createCompileWorkerStandby({ entry, onEvent: (ev: StandbyEvent) => events.push(ev) })
		openStandbys.push(standby)

		standby.ensure()
		await waitForState(standby, 'ready', 8000)
		const pid = events.find(ev => ev.type === 'spawned')!.pid!
		process.kill(pid, 'SIGKILL')

		const diedFired = await pollUntil(() => events.some(ev => ev.type === 'died'), 5000)
		expect(diedFired).toBe(true)

		const adopted = await standby.adopt()
		expect(adopted).toBeNull()
		const failure = events.find(ev => ev.type === 'health-check-failed')
		expect(failure, 'adopt() in the dead-but-not-yet-refilled window must fail its health check').toBeTruthy()
		expect(String(failure?.reason)).toContain('died before adoption')
	}, 10_000)
})

describe('createCompileWorkerStandby — dispose() escalates past a spare that ignores SIGTERM', () => {
	it('a spare trapping SIGTERM is still killed within disposeGraceMs, and dispose() resolves promptly rather than hanging', async () => {
		const dir = mkTmp()
		const entry = writeFixture(dir, FIXTURE_TRAP_SIGTERM)
		const events: StandbyEvent[] = []
		// `disposeGraceMs` is passed through a variable (not an inline object
		// literal) so this test compiles against today's narrower option type
		// while still exercising the new option once implemented.
		const opts = { entry, onEvent: (ev: StandbyEvent) => events.push(ev), disposeGraceMs: 300 }
		const standby = createCompileWorkerStandby(opts)
		openStandbys.push(standby)

		standby.ensure()
		await waitForState(standby, 'ready', 8000)
		const pid = events.find(ev => ev.type === 'spawned')!.pid!
		doomedPids.push(pid)

		const disposeOutcome = await Promise.race([
			standby.dispose().then(() => 'resolved' as const),
			sleep(3000).then(() => 'timed-out' as const),
		])
		expect(
			disposeOutcome,
			'dispose() must resolve within a bounded time even when the spare ignores SIGTERM, not hang forever waiting for a graceful exit',
		).toBe('resolved')
		expect(
			await waitForPidDeath(pid, 2000),
			'a spare that traps SIGTERM must still end up dead — dispose() must escalate to SIGKILL after disposeGraceMs',
		).toBe(true)
	}, 10_000)
})
