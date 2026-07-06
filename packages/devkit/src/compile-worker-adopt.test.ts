import { execFileSync, fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createCompileWorker, type CompileWorkerOptions } from './compile-worker.js'

/**
 * Contract for warm-standby ADOPTION on the `createCompileWorker` side:
 * `opts.adopt?: ChildProcess` lets a caller (devtools' warm-standby manager)
 * hand over an already-forked, already-toolchain-warmed compile worker so
 * the FIRST build of a newly opened project reuses it instead of paying a
 * fresh fork + `@dimina-kit/compiler` import.
 *
 * REAL-fork, real-compile integration tests (same style as
 * `compile-worker-leak.test.ts`): the adopted process is a genuine fork of
 * `compile-worker-entry`, and "reused, not re-forked" is proven by a real OS
 * PID scan — `ps -axo pid=,ppid=,command=` for direct children of THIS test
 * process whose command line names the entry module — not by a spy.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function workerEntryPath(): string {
	const js = path.join(__dirname, 'compile-worker-entry.js')
	if (fs.existsSync(js)) return js
	return path.join(__dirname, 'compile-worker-entry.ts')
}

function workerExecArgv(entry: string): string[] {
	return entry.endsWith('.ts')
		? ['--experimental-strip-types', '--disable-warning=ExperimentalWarning']
		: []
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

async function waitForPidAlive(pid: number, timeoutMs = 8000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (pidAlive(pid)) return true
		await sleep(100)
	}
	return pidAlive(pid)
}

/** Direct children of THIS test process that are compile-worker-entry forks. */
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

function forkAdoptCandidate(): ChildProcess {
	const entry = workerEntryPath()
	// Same fork shape createCompileWorker's own spawnWorker uses: piped stdio +
	// an explicit execArgv (never the parent's loaders) so the adopted process
	// is indistinguishable from one createCompileWorker would have forked itself.
	return fork(entry, [], { execArgv: workerExecArgv(entry), silent: true })
}

const doomedPids: number[] = []
const cleanupRoots: string[] = []
const activeWorkers: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
	for (const worker of activeWorkers.splice(0)) {
		try {
			await worker.close()
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
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-adopt-'))
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

describe('createCompileWorker — opts.adopt (warm-standby hand-off)', () => {
	it('the FIRST build reuses the adopted process (same PID, no extra fork), pipes its stdout to onLog, and close() kills that same PID', async () => {
		const adoptee = forkAdoptCandidate()
		await once(adoptee, 'spawn')
		doomedPids.push(adoptee.pid!)
		expect(pidAlive(adoptee.pid!)).toBe(true)

		const logEntries: Array<{ stream: string, text: string }> = []
		const worker = createCompileWorker({
			onLog: entry => logEntries.push(entry),
			adopt: adoptee,
		} as CompileWorkerOptions & { adopt: ChildProcess })
		activeWorkers.push(worker)

		const root = makeFixture()
		const appInfo = await worker.build({
			projectPath: root,
			outputDir: path.join(root, '.out'),
			options: {},
		})
		expect(appInfo?.appId).toBe('fixture_app_001')

		const liveWorkerPids = findCompileWorkerPids()
		expect(
			liveWorkerPids,
			'the first build must reuse the ADOPTED process, not fork a fresh one — exactly one compile-worker-entry child must exist, and it must be the adoptee',
		).toEqual([adoptee.pid])

		expect(
			logEntries.length,
			'the adopted process\'s stdout/stderr must flow to onLog just like a self-forked worker\'s',
		).toBeGreaterThan(0)

		await worker.close()
		expect(
			await waitForPidDeath(adoptee.pid!, 8000),
			'close() on a worker using an adopted process must leave that PID actually dead — same guarantee as a self-forked worker',
		).toBe(true)
	}, 90_000)

	it('an adopted process that dies BEFORE the first build falls back to a fresh fork, and the build still succeeds', async () => {
		const adoptee = forkAdoptCandidate()
		await once(adoptee, 'spawn')
		const deadPid = adoptee.pid!
		adoptee.kill('SIGKILL')
		expect(await waitForPidDeath(deadPid, 8000)).toBe(true)

		const worker = createCompileWorker({
			adopt: adoptee,
		} as CompileWorkerOptions & { adopt: ChildProcess })
		activeWorkers.push(worker)

		const root = makeFixture()
		const appInfo = await worker.build({
			projectPath: root,
			outputDir: path.join(root, '.out'),
			options: {},
		})
		expect(
			appInfo?.appId,
			'a dead adoptee must not fail the build — createCompileWorker must transparently fork a FRESH worker instead',
		).toBe('fixture_app_001')

		const liveWorkerPids = findCompileWorkerPids()
		expect(liveWorkerPids).toHaveLength(1)
		expect(
			liveWorkerPids[0],
			'the fallback fork must be a genuinely NEW process, not the dead adoptee',
		).not.toBe(deadPid)
		doomedPids.push(liveWorkerPids[0]!)

		await worker.close()
	}, 90_000)

	it('a fresh (never-crashed) adopted process is genuinely alive at hand-off time — precondition sanity check', async () => {
		const adoptee = forkAdoptCandidate()
		await once(adoptee, 'spawn')
		doomedPids.push(adoptee.pid!)
		expect(await waitForPidAlive(adoptee.pid!, 3000)).toBe(true)
		adoptee.kill('SIGKILL')
	})
})
