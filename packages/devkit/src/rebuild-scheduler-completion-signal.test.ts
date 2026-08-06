import { describe, expect, it, vi } from 'vitest'
import * as devkit from './index.js'

/**
 * Contract for `createRebuildScheduler`'s completion signal — the piece the
 * "重新编译" button needs to know a compile it asked for has actually
 * finished, instead of firing-and-forgetting into the same coalescing
 * scheduler the file watcher already uses.
 *
 * `schedule()` returns `Promise<void>`, and settles according to which run
 * covers the caller's disk state at the moment it was called:
 *  - Called while idle: the promise tracks the run started for THIS call.
 *  - Called while a run is already in flight: the caller's request could not
 *    be reflected by that in-flight run (it started before this call), so the
 *    promise tracks the NEXT (trailing) run instead — it must not resolve
 *    off a run that never saw this call's state.
 *  - N calls landing during the same in-flight run all coalesce into ONE
 *    trailing run (unchanged merge semantics from rebuild-scheduler.test.ts)
 *    and all their promises settle together with that one trailing run.
 *  - A run's rejection rejects every promise tied to that run with the same
 *    error; a synchronous throw from `run` must reject the promise rather
 *    than escape `schedule()` as a synchronous exception.
 */

type Scheduler = { schedule: () => Promise<void> }
type CreateRebuildScheduler = (run: () => Promise<void>) => Scheduler

function getCreateRebuildScheduler(): CreateRebuildScheduler {
	const factory = (devkit as Record<string, unknown>).createRebuildScheduler
	expect(typeof factory, 'devkit must export createRebuildScheduler(run)').toBe('function')
	return factory as CreateRebuildScheduler
}

/** A `run` whose completion the test controls call-by-call. */
function makeDeferredRun() {
	const pending: Array<{ resolve: () => void; reject: (e: unknown) => void }> = []
	const run = vi.fn(
		() =>
			new Promise<void>((resolve, reject) => {
				pending.push({ resolve, reject })
			}),
	)
	return {
		run,
		finish: (i: number) => pending[i]!.resolve(),
		fail: (i: number, err: unknown) => pending[i]!.reject(err),
	}
}

/** Let queued microtasks/then-chains drain without settling anything new. */
async function settle(ms = 25): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, ms))
}

/** Track whether a promise has settled, without consuming its rejection. */
function watchSettled(p: Promise<unknown>): { get resolved(): boolean, get rejected(): boolean } {
	const state = { resolved: false, rejected: false }
	p.then(
		() => { state.resolved = true },
		() => { state.rejected = true },
	)
	return state
}

describe('createRebuildScheduler: schedule() resolves/rejects with the run that covers its call', () => {
	it('an idle call resolves only once ITS OWN run settles, not before', async () => {
		const createRebuildScheduler = getCreateRebuildScheduler()
		const { run, finish } = makeDeferredRun()
		const scheduler = createRebuildScheduler(run)

		const p = scheduler.schedule()
		const watch = watchSettled(p)
		await settle()
		expect(watch.resolved, 'the run is still in flight — schedule() must not resolve early').toBe(false)

		finish(0)
		await p
		expect(watch.resolved).toBe(true)
	})

	it('an idle call rejects with the run\'s error', async () => {
		const createRebuildScheduler = getCreateRebuildScheduler()
		const { run, fail } = makeDeferredRun()
		const scheduler = createRebuildScheduler(run)

		const p = scheduler.schedule()
		fail(0, new Error('compile exploded'))

		await expect(p).rejects.toThrow('compile exploded')
	})

	it('a call made while a run is in flight resolves with the TRAILING run, never the one already running', async () => {
		const createRebuildScheduler = getCreateRebuildScheduler()
		const { run, finish } = makeDeferredRun()
		const scheduler = createRebuildScheduler(run)

		void scheduler.schedule() // run #0
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

		const p1 = scheduler.schedule() // lands mid-flight — must wait for run #1
		const watch1 = watchSettled(p1)

		finish(0) // run #0 settles — p1 must NOT resolve off this
		await settle()
		expect(
			watch1.resolved,
			'run #0 started before p1\'s call — resolving p1 here would hand the caller a build that never saw its disk state',
		).toBe(false)

		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
		finish(1)
		await p1
		expect(watch1.resolved).toBe(true)
	})

	it('N calls during one in-flight run share the SAME trailing run and settle together (merge semantics preserved)', async () => {
		const createRebuildScheduler = getCreateRebuildScheduler()
		const { run, finish } = makeDeferredRun()
		const scheduler = createRebuildScheduler(run)

		void scheduler.schedule() // run #0
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

		const pA = scheduler.schedule()
		const pB = scheduler.schedule()
		const pC = scheduler.schedule()
		for (const p of [pA, pB, pC]) {
			expect(typeof (p as unknown as { then?: unknown })?.then, 'schedule() must return a promise, not void').toBe('function')
		}
		await settle()
		expect(run, 'no concurrent run may start for the coalesced calls').toHaveBeenCalledTimes(1)

		finish(0)
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
		expect(run, '3 coalesced calls = exactly 1 trailing run, not 3').toHaveBeenCalledTimes(2)

		finish(1)
		await Promise.all([pA, pB, pC])
		expect(run).toHaveBeenCalledTimes(2)
	})

	it('a rejecting trailing run rejects every promise coalesced into it, with the same error', async () => {
		const createRebuildScheduler = getCreateRebuildScheduler()
		const { run, finish, fail } = makeDeferredRun()
		const scheduler = createRebuildScheduler(run)

		void scheduler.schedule() // run #0
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

		const p1 = scheduler.schedule() // coalesces into the trailing run
		finish(0)
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))

		fail(1, new Error('trailing build failed'))
		await expect(p1).rejects.toThrow('trailing build failed')
	})

		it('an explicit transaction stays pending through recursively coalesced trailing runs', async () => {
		const createRebuildScheduler = getCreateRebuildScheduler()
		const { run, finish } = makeDeferredRun()
		const scheduler = createRebuildScheduler(run)

		void scheduler.schedule() // run #0
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

		const pTrailing1 = scheduler.schedule() // → trailing run #1
		finish(0)
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))

		const pTrailing2 = scheduler.schedule() // lands during run #1 → trailing run #2
		const watchTrailing1 = watchSettled(pTrailing1)
			finish(1)
			await settle()
			expect(
				watchTrailing1.resolved,
				'a hard reflection after run #1 could race the already-queued run #2 watcher reflection',
			).toBe(false)

		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3))
		finish(2)
			await Promise.all([pTrailing1, pTrailing2])
		expect(run).toHaveBeenCalledTimes(3)
	})

	it('a run that throws synchronously rejects the returned promise instead of escaping schedule() as a throw', async () => {
		const createRebuildScheduler = getCreateRebuildScheduler()
		const run = vi.fn((): Promise<void> => {
			throw new Error('sync failure before any promise exists')
		})
		const scheduler = createRebuildScheduler(run)

		let p: Promise<void> | undefined
		let threw = false
		try {
			p = scheduler.schedule()
		} catch {
			threw = true
		}
		expect(
			threw,
			'schedule() now returns a promise — a synchronous run() throw must be funneled into a rejection, not escape as a raw throw',
		).toBe(false)
		await expect(p).rejects.toThrow('sync failure before any promise exists')
	})

	it('the scheduler stays usable for a later call after a run rejects', async () => {
		const createRebuildScheduler = getCreateRebuildScheduler()
		const { run, fail, finish } = makeDeferredRun()
		const scheduler = createRebuildScheduler(run)

		const p0 = scheduler.schedule()
		fail(0, new Error('first attempt failed'))
		await expect(p0).rejects.toThrow('first attempt failed')

		const p1 = scheduler.schedule()
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
		finish(1)
		await expect(p1).resolves.toBeUndefined()
	})
})
