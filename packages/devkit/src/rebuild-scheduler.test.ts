import { afterEach, describe, expect, it, vi } from 'vitest'
import * as devkit from './index.js'

/**
 * Contract for the rebuild scheduler — closes the "save silently dropped
 * while a build is in flight" hole in `openProject`'s rebuild loop, where a
 * naive `if (isBuilding) return` would discard any watcher event that lands
 * while `build()` is running (a save made during the ~1-2s compile window
 * never produces a rebuild — the simulator stays stale until the user saves
 * again).
 *
 * Required contract:
 *  - devkit exports `createRebuildScheduler(run: () => Promise<void>)`
 *    returning `{ schedule(): void }`, and `openProject` routes its watcher
 *    `rebuild` calls through it.
 *  - `schedule()` while idle starts `run` immediately.
 *  - `schedule()` while `run` is in flight never starts a concurrent run;
 *    it marks the state dirty instead.
 *  - When the in-flight run finishes and the state is dirty, EXACTLY ONE
 *    trailing run starts (N saves during one build coalesce into 1 rerun).
 *  - The trailing run is itself schedulable-against (saves during the
 *    trailing run coalesce into the next trailing run, and so on).
 *  - A rejecting run must neither wedge the scheduler nor drop a pending
 *    dirty flag (a save during a failing build still gets its rebuild).
 *
 * They use a manually-resolved deferred `run` so the in-flight window is fully
 * controlled — no timing flakiness.
 */

type Scheduler = { schedule: () => void }
type CreateRebuildScheduler = (run: () => Promise<void>) => Scheduler

function getCreateRebuildScheduler(): CreateRebuildScheduler {
	const factory = (devkit as Record<string, unknown>).createRebuildScheduler
	expect(
		typeof factory,
		'devkit must export createRebuildScheduler(run) — the dirty-flag + trailing-rerun replacement for the "if (isBuilding) return" drop in openProject\'s rebuild()',
	).toBe('function')
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
		/** Settle the i-th started run (0-based). */
		finish: (i: number) => pending[i]!.resolve(),
		fail: (i: number, err: unknown) => pending[i]!.reject(err),
	}
}

/** Let queued microtasks/then-chains drain. */
async function settle(ms = 25): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, ms))
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe('createRebuildScheduler — saves during an in-flight build must not be dropped', () => {
	it('runs the build immediately when idle', async () => {
		const createRebuildScheduler = getCreateRebuildScheduler()
		const { run } = makeDeferredRun()
		const scheduler = createRebuildScheduler(run)

		scheduler.schedule()

		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
	})

	it('never starts a concurrent build while one is in flight', async () => {
		const createRebuildScheduler = getCreateRebuildScheduler()
		const { run } = makeDeferredRun()
		const scheduler = createRebuildScheduler(run)

		scheduler.schedule()
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

		// Saves landing mid-build must not spawn parallel compiler runs
		// (build() chdir()s into the project — concurrency would corrupt cwd).
		scheduler.schedule()
		scheduler.schedule()
		await settle()

		expect(run).toHaveBeenCalledTimes(1)
	})

	it('coalesces N saves during one build into EXACTLY ONE trailing rebuild', async () => {
		const createRebuildScheduler = getCreateRebuildScheduler()
		const { run, finish } = makeDeferredRun()
		const scheduler = createRebuildScheduler(run)

		scheduler.schedule()
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

		// Three rapid saves while build #0 is still compiling.
		scheduler.schedule()
		scheduler.schedule()
		scheduler.schedule()
		await settle()
		expect(run, 'no concurrent run may start').toHaveBeenCalledTimes(1)

		// Build #0 finishes → the dirty flag triggers ONE trailing rerun.
		finish(0)
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))

		// The trailing run finishes with nothing else dirty → quiescent.
		finish(1)
		await settle()
		expect(run, '3 saves during one build = 1 trailing rebuild, not 3').toHaveBeenCalledTimes(2)
	})

	it('does NOT rerun when nothing was scheduled during the build', async () => {
		const createRebuildScheduler = getCreateRebuildScheduler()
		const { run, finish } = makeDeferredRun()
		const scheduler = createRebuildScheduler(run)

		scheduler.schedule()
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

		finish(0)
		await settle()

		expect(run, 'a clean build with no mid-flight saves must not loop').toHaveBeenCalledTimes(1)
	})

	it('saves during the trailing run coalesce again (chained trailing runs)', async () => {
		const createRebuildScheduler = getCreateRebuildScheduler()
		const { run, finish } = makeDeferredRun()
		const scheduler = createRebuildScheduler(run)

		scheduler.schedule()
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

		scheduler.schedule() // dirty during run #0
		finish(0)
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))

		scheduler.schedule() // dirty during trailing run #1
		scheduler.schedule()
		finish(1)
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3))

		finish(2)
		await settle()
		expect(run).toHaveBeenCalledTimes(3)
	})

	it('stays usable after the build rejects', async () => {
		const createRebuildScheduler = getCreateRebuildScheduler()
		const { run, fail } = makeDeferredRun()
		const scheduler = createRebuildScheduler(run)

		scheduler.schedule()
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

		fail(0, new Error('compile exploded'))
		await settle()

		// A later save must still trigger a build — the scheduler must not wedge.
		scheduler.schedule()
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
	})

	it('a save during a FAILING build still gets its trailing rebuild', async () => {
		const createRebuildScheduler = getCreateRebuildScheduler()
		const { run, finish, fail } = makeDeferredRun()
		const scheduler = createRebuildScheduler(run)

		scheduler.schedule()
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

		scheduler.schedule() // the save that fixes the broken code
		fail(0, new Error('syntax error mid-edit'))

		// The dirty flag set during the failing build must survive the failure.
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))

		finish(1)
		await settle()
		expect(run).toHaveBeenCalledTimes(2)
	})
})

// ─── `run` throwing SYNCHRONOUSLY (not rejecting) ──────────────────
//
// Regression tests for a wedge: `start()` sets `running = true` and then calls
// `run()` bare. If `run` throws synchronously
// (e.g. a config/IO error raised before the build's first await — no promise
// ever exists), the `.catch().then()` settle chain is never attached, so:
//   - the exception escapes through `schedule()` to the watcher callsite,
//   - `running` stays true FOREVER,
//   - every later `schedule()` only sets `dirty` and is silently swallowed —
//     the project never rebuilds again until the process restarts.
//
// The documented contract ("a failing run neither wedges the scheduler nor
// drops a pending dirty flag", with failures being `run`'s responsibility to
// report) must hold regardless of HOW the run fails: rejection and synchronous
// throw are the same event to the scheduler.
describe('createRebuildScheduler: run() throwing synchronously must not wedge the scheduler', () => {
	/** A `run` that throws synchronously on the i-th call(s), resolves otherwise. */
	function makeSyncThrowingRun(throwOnCalls: number[]) {
		const run = vi.fn((): Promise<void> => {
			if (throwOnCalls.includes(run.mock.calls.length)) {
				throw new Error('sync failure before any promise exists')
			}
			return Promise.resolve()
		})
		return run
	}

	it('schedule() does not propagate a synchronous throw from run (same swallow semantics as a rejection)', () => {
		const createRebuildScheduler = getCreateRebuildScheduler()
		const run = makeSyncThrowingRun([1])
		const scheduler = createRebuildScheduler(run)

		// BUG CAUGHT: today the throw escapes start() → schedule() → the watcher
		// callsite, which never expected schedule() to throw.
		expect(() => scheduler.schedule()).not.toThrow()
		expect(run).toHaveBeenCalledTimes(1)
	})

	it('a later save still triggers a build after run threw synchronously (no permanent running=true wedge)', async () => {
		const createRebuildScheduler = getCreateRebuildScheduler()
		const run = makeSyncThrowingRun([1])
		const scheduler = createRebuildScheduler(run)

		// Tolerate the current buggy escape so this test isolates the WEDGE, not
		// the throw itself (the throw is pinned by the test above).
		try {
			scheduler.schedule()
		} catch {
			// current buggy behavior — swallowed so we can probe liveness
		}
		expect(run).toHaveBeenCalledTimes(1)
		await settle()

		// BUG CAUGHT: `running` was never reset, so this schedule() only sets
		// `dirty` and the rebuild is silently dropped forever.
		scheduler.schedule()
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
	})

	it('a dirty flag set during a synchronously-throwing run still gets its trailing rebuild', async () => {
		const createRebuildScheduler = getCreateRebuildScheduler()
		// Run #1: a watcher event lands re-entrantly while the build is starting
		// (running=true → marks dirty), THEN the build throws synchronously.
		const run = vi.fn((): Promise<void> => {
			if (run.mock.calls.length === 1) {
				scheduler.schedule() // the save that fixes the broken state
				throw new Error('sync failure before any promise exists')
			}
			return Promise.resolve()
		})
		const scheduler: Scheduler = createRebuildScheduler(run)

		try {
			scheduler.schedule()
		} catch {
			// current buggy behavior — swallowed so we can probe the dirty flag
		}

		// BUG CAUGHT: the dirty flag set during run #1 is never consumed because
		// the settle chain (which performs the trailing rerun) was never attached.
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))

		await settle()
		expect(run, 'exactly one trailing rebuild — no loop').toHaveBeenCalledTimes(2)
	})
})
