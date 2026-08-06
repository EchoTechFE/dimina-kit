import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as devkit from './index.js'

/**
 * Contract: `createCompileWorker` gains a `buildTimeoutMs` watchdog. A worker
 * that goes silent mid-build — the child process is alive (no 'exit',
 * 'close', or 'error') but never replies with a `{ type: 'result' }` message —
 * must not wedge the rebuild scheduler forever: the "重新编译" button and
 * every subsequent watcher save would otherwise hang indefinitely behind one
 * unanswered IPC call. The watchdog kills the wedged child and rejects the
 * in-flight build with a timeout-flavored error; the NEXT build re-forks a
 * fresh worker and can complete normally.
 *
 * Same mocked-fork harness as compile-worker.test.ts: the fake child is an
 * EventEmitter with PassThrough stdout/stderr + send/kill spies. `autoRespond`
 * defaults to false here so the test controls exactly when (or whether) the
 * worker answers.
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

class FakeChild extends EventEmitter {
	stdout = new PassThrough()
	stderr = new PassThrough()
	connected = true
	killed = false
	pid = 5151
	autoRespond = false
	ignoreSigterm = false
	killEmitsError = false
	throwOnNextSend = false
	sent: Array<Record<string, unknown>> = []

	send = vi.fn((msg: unknown): boolean => {
		if (this.throwOnNextSend) {
			this.throwOnNextSend = false
			throw new Error('IPC channel closed synchronously')
		}
		const m = msg as Record<string, unknown>
		this.sent.push(m)
		if (this.autoRespond && m && m.cmd === 'build') {
			queueMicrotask(() => {
				if (!this.connected) return
				this.emit('message', { type: 'result', appInfo: { appId: 'timeout_app', name: 'x', path: String(m.projectPath ?? '') } })
			})
		}
		return true
	})

	kill = vi.fn((signal?: NodeJS.Signals | number): boolean => {
		if (this.killEmitsError) {
			queueMicrotask(() => this.emit('error', new Error(`failed to deliver ${signal ?? 'SIGTERM'}`)))
			return false
		}
		this.killed = true
		if (this.ignoreSigterm && signal !== 'SIGKILL') return true
		this.connected = false
		// Real-world: SIGTERM eventually reaps the process. Deferred so the
		// watchdog's own rejection is what settles the build, not this exit.
		queueMicrotask(() => this.emit('exit', null, 'SIGTERM'))
		return true
	})

	respond(): void {
		this.emit('message', { type: 'result', appInfo: { appId: 'timeout_app', name: 'x', path: '/tmp/p' } })
	}
}

const children: FakeChild[] = []

beforeEach(() => {
	children.length = 0
	mocks.fork.mockReset()
	mocks.fork.mockImplementation(() => {
		const child = new FakeChild()
		children.push(child)
		return child
	})
})

afterEach(() => {
	vi.restoreAllMocks()
})

const REQUEST = { projectPath: '/tmp/p', outputDir: '/tmp/out', options: {} }

function sleep(ms: number): Promise<void> {
	return new Promise<void>(resolve => setTimeout(resolve, ms))
}

function makeWorker(buildTimeoutMs: number, killGraceMs = 5_000): ReturnType<typeof devkit.createCompileWorker> {
	return devkit.createCompileWorker({ buildTimeoutMs, killGraceMs })
}

/** Race a promise against a bounded wait so a still-hung build reports 'hung' instead of stalling the whole suite. */
function raceSettle(promise: Promise<unknown>, ms: number): Promise<'resolved' | 'rejected' | 'hung'> {
	return Promise.race([
		promise.then(() => 'resolved' as const, () => 'rejected' as const),
		sleep(ms).then(() => 'hung' as const),
	])
}

describe('createCompileWorker: buildTimeoutMs watchdog on a silently-wedged worker', () => {
	it('a worker that never replies within buildTimeoutMs rejects the build with a timeout error', async () => {
		const worker = makeWorker(40)
		const pending = worker.build(REQUEST)

		expect(
			await raceSettle(pending, 500),
			'the child never replied and never died — without a watchdog the build hangs forever, wedging the rebuild scheduler',
		).toBe('rejected')
		await expect(pending).rejects.toThrow(/time(d)?[\s-]?out/i)
	})

	it('the watchdog kills the wedged child process', async () => {
		const worker = makeWorker(40)
		const pending = worker.build(REQUEST)
		pending.catch(() => {})

		await vi.waitFor(() => expect(children.length).toBe(1))
		const child = children[0] as FakeChild

		await sleep(200)

		expect(
			child.kill,
			'a build that timed out must not leave the unresponsive child process running — the next build needs a clean re-fork',
		).toHaveBeenCalled()
	})

	it('after a timeout the NEXT build re-forks a fresh worker and completes normally', async () => {
		const worker = makeWorker(40)
		const firstPending = worker.build(REQUEST)
		firstPending.catch(() => {})
		await sleep(200)

		mocks.fork.mockImplementation(() => {
			const child = new FakeChild()
			child.autoRespond = true
			children.push(child)
			return child
		})

		const second = worker.build(REQUEST)
		expect(
			await raceSettle(second, 500),
			'a timed-out build must not permanently wedge the worker\'s internal single-flight chain — the next build should complete instead of queuing forever behind the never-settled first build',
		).toBe('resolved')
		await expect(second).resolves.toEqual(expect.objectContaining({ appId: 'timeout_app' }))
		expect(children.length).toBe(2)
	}, 3_000)

	it('waits for SIGKILL-confirmed death before forking a replacement for a SIGTERM-ignoring worker', async () => {
		const worker = makeWorker(30, 80)
		mocks.fork.mockImplementationOnce(() => {
			const child = new FakeChild()
			child.ignoreSigterm = true
			children.push(child)
			return child
		})
		const first = worker.build(REQUEST)
		await expect(first).rejects.toThrow(/timed out/i)

		mocks.fork.mockImplementation(() => {
			const child = new FakeChild()
			child.autoRespond = true
			children.push(child)
			return child
		})
		const second = worker.build(REQUEST)
		await sleep(30)
		expect(children, 'a replacement must not overlap the still-alive timed-out compiler').toHaveLength(1)

		await expect(second).resolves.toEqual(expect.objectContaining({ appId: 'timeout_app' }))
		expect(children).toHaveLength(2)
		expect(children[0]!.kill).toHaveBeenCalledWith('SIGKILL')
		await worker.close()
	}, 3_000)

	it('close() waits for an already-retiring timed-out worker to be force-reaped', async () => {
		const worker = makeWorker(30, 80)
		mocks.fork.mockImplementationOnce(() => {
			const child = new FakeChild()
			child.ignoreSigterm = true
			children.push(child)
			return child
		})
		const build = worker.build(REQUEST)
		await expect(build).rejects.toThrow(/timed out/i)

		let closed = false
		const closing = worker.close().then(() => { closed = true })
		await sleep(30)
		expect(closed, 'child=null must not make close resolve while the retired process is alive').toBe(false)
		await closing
		expect(children[0]!.kill).toHaveBeenCalledWith('SIGKILL')
	})

	it('a kill error from a still-live timed-out worker cannot unblock its replacement', async () => {
		const worker = makeWorker(30, 40)
		mocks.fork.mockImplementationOnce(() => {
			const child = new FakeChild()
			child.killEmitsError = true
			children.push(child)
			return child
		})
		await expect(worker.build(REQUEST)).rejects.toThrow(/timed out/i)

		mocks.fork.mockImplementation(() => {
			const child = new FakeChild()
			child.autoRespond = true
			children.push(child)
			return child
		})
		const replacementBuild = worker.build(REQUEST)
		await sleep(100)
		expect(children, 'kill errors do not prove the old compiler exited').toHaveLength(1)
		expect(children[0]!.kill).toHaveBeenCalledWith('SIGKILL')

		children[0]!.connected = false
		children[0]!.emit('exit', null, 'SIGKILL')
		await expect(replacementBuild).resolves.toEqual(expect.objectContaining({ appId: 'timeout_app' }))
		expect(children).toHaveLength(2)
		await worker.close()
	}, 3_000)

	it('a synchronous send failure is retired cleanly and its watchdog cannot kill the next build', async () => {
		const isolated = makeWorker(80, 20)
		mocks.fork.mockImplementationOnce(() => {
			const child = new FakeChild()
			child.throwOnNextSend = true
			children.push(child)
			return child
		}).mockImplementationOnce(() => {
			const child = new FakeChild()
			child.autoRespond = true
			children.push(child)
			return child
		})
		await expect(isolated.build(REQUEST)).rejects.toThrow(/channel closed/i)
		await expect(isolated.build(REQUEST)).resolves.toEqual(expect.objectContaining({ appId: 'timeout_app' }))
		const replacement = children.at(-1)!
		await sleep(120)
		expect(replacement.kill, 'the rejected request\'s stale timer must not kill the replacement').not.toHaveBeenCalled()
		await isolated.close()
	}, 3_000)

	it('a build that replies BEFORE buildTimeoutMs elapses is unaffected — no spurious timeout rejection', async () => {
		const worker = makeWorker(200)
		const pending = worker.build(REQUEST)

		await vi.waitFor(() => expect(children.length).toBe(1))
		const child = children[0] as FakeChild
		await sleep(10)
		child.respond()

		await expect(pending).resolves.toEqual(expect.objectContaining({ appId: 'timeout_app' }))
		expect(child.kill, 'a build that answered in time must not be killed by the watchdog').not.toHaveBeenCalled()
	})
})
