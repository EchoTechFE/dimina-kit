import { describe, expect, it, vi } from 'vitest'
import * as devkit from './index.js'

/**
 * Contract for the scheduler's `notify()` entry point and the `explicit` tag
 * `run` receives on every invocation.
 *
 * The popover "重新编译" button (a user-initiated request) and the file
 * watcher's auto-rebuild (a background convenience) must be distinguishable
 * downstream — the renderer must never treat a watcher-triggered rebuild as
 * if the user had explicitly asked for it (that would let a background save
 * force-close an open popover or steal the user's attention).
 *
 * `notify()` is the watcher's fire-and-forget entry point: unlike
 * `schedule()`, it returns nothing and never surfaces a rejection to the
 * caller. `run` now receives `{ explicit: boolean }`: a run is explicit when
 * it covers at least one `schedule()` call among the requests it coalesces;
 * a run started or re-triggered purely by `notify()` calls is not.
 */

interface RunInfo { explicit: boolean }
type Scheduler = {
	schedule: () => Promise<void>
	notify: () => void
}
type CreateRebuildScheduler = (run: (info: RunInfo) => Promise<void>) => Scheduler

function getCreateRebuildScheduler(): CreateRebuildScheduler {
	const factory = (devkit as Record<string, unknown>).createRebuildScheduler
	expect(typeof factory, 'devkit must export createRebuildScheduler(run)').toBe('function')
	return factory as CreateRebuildScheduler
}

/** A `run` whose completion the test controls call-by-call, recording the explicit flag it was invoked with. */
function makeDeferredRun() {
	const pending: Array<{ resolve: () => void; reject: (e: unknown) => void }> = []
	const explicitFlags: boolean[] = []
	const runInfos: RunInfo[] = []
	const run = vi.fn(
		(info: RunInfo) =>
			new Promise<void>((resolve, reject) => {
				runInfos.push(info)
				explicitFlags.push(info.explicit)
				pending.push({ resolve, reject })
			}),
	)
	return {
		run,
		explicitFlags,
		runInfos,
		finish: (i: number) => pending[i]!.resolve(),
	}
}

async function settle(ms = 25): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, ms))
}

describe('createRebuildScheduler: notify() is a fire-and-forget request distinct from schedule()', () => {
	it('exposes a notify() method alongside schedule()', () => {
		const createRebuildScheduler = getCreateRebuildScheduler()
		const { run } = makeDeferredRun()
		const scheduler = createRebuildScheduler(run)

		expect(
			typeof scheduler.notify,
			'the watcher needs a fire-and-forget entry point distinct from the awaitable schedule() the popover uses',
		).toBe('function')
	})

	it('notify() while idle starts run immediately and returns undefined (no promise to await)', () => {
		const createRebuildScheduler = getCreateRebuildScheduler()
		const { run } = makeDeferredRun()
		const scheduler = createRebuildScheduler(run)

		const result = scheduler.notify()

		expect(run).toHaveBeenCalledTimes(1)
		expect(
			result,
			'notify() is fire-and-forget — a returned promise would invite an awaiting caller who then never resolves',
		).toBeUndefined()
	})
})

describe('createRebuildScheduler: explicit tag on run — watcher saves must never masquerade as a user-requested rebuild', () => {
	it('a run started by notify() while idle is NOT explicit', async () => {
		const createRebuildScheduler = getCreateRebuildScheduler()
		const { run, explicitFlags } = makeDeferredRun()
		const scheduler = createRebuildScheduler(run)

		scheduler.notify()

		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
		expect(explicitFlags[0], 'a background watcher save must not be tagged explicit').toBe(false)
	})

	it('a run started by schedule() while idle IS explicit', async () => {
		const createRebuildScheduler = getCreateRebuildScheduler()
		const { run, explicitFlags } = makeDeferredRun()
		const scheduler = createRebuildScheduler(run)

		void scheduler.schedule()

		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
		expect(explicitFlags[0], 'a user-requested rebuild must be tagged explicit').toBe(true)
	})

	it('a schedule() landing during an in-flight notify()-started run makes the TRAILING run explicit', async () => {
		const createRebuildScheduler = getCreateRebuildScheduler()
		const { run, explicitFlags, runInfos, finish } = makeDeferredRun()
		const scheduler = createRebuildScheduler(run)

		scheduler.notify() // run #0 — not explicit
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

		void scheduler.schedule() // lands mid-flight — the user asked for a rebuild
		expect(
			runInfos[0]!.explicit,
			'the in-flight watcher run must suppress its soft reflection once an explicit transaction is queued',
		).toBe(true)
		finish(0)

		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
		expect(
			explicitFlags[1],
			'the trailing run covers the schedule() call — it must be reported as explicit, or the popover can never tell its request actually ran',
		).toBe(true)
	})

	it('a notify() landing during an explicit run keeps the trailing run in the explicit transaction', async () => {
		const createRebuildScheduler = getCreateRebuildScheduler()
		const { run, explicitFlags, finish } = makeDeferredRun()
		const scheduler = createRebuildScheduler(run)

		void scheduler.schedule() // run #0 — explicit
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

		scheduler.notify() // only a background save lands mid-flight — no schedule() this time
		finish(0)

		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
		expect(
			explicitFlags[1],
			'the explicit caller must remain authoritative until its coalesced watcher tail is quiescent',
		).toBe(true)
	})

	it('mixing multiple notify() and schedule() calls during one in-flight run coalesces into ONE explicit trailing run', async () => {
		const createRebuildScheduler = getCreateRebuildScheduler()
		const { run, explicitFlags, finish } = makeDeferredRun()
		const scheduler = createRebuildScheduler(run)

		scheduler.notify() // run #0 — not explicit
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

		scheduler.notify()
		void scheduler.schedule()
		scheduler.notify()
		void scheduler.schedule()
		await settle()
		expect(run, 'no concurrent run may start for the coalesced mid-flight requests').toHaveBeenCalledTimes(1)

		finish(0)
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
		expect(
			explicitFlags[1],
			'at least one schedule() among the coalesced mid-flight requests must make the single trailing run explicit',
		).toBe(true)

		finish(1)
		await settle()
		expect(run, '4 coalesced mid-flight requests = 1 trailing run, not 4').toHaveBeenCalledTimes(2)
	})

	it('notify() coalesces with an in-flight notify()-started run just like schedule() does — no concurrent run', async () => {
		const createRebuildScheduler = getCreateRebuildScheduler()
		const { run, finish } = makeDeferredRun()
		const scheduler = createRebuildScheduler(run)

		scheduler.notify()
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

		scheduler.notify()
		scheduler.notify()
		await settle()
		expect(run, 'notify() must merge into the same dirty-flag scheduler, not spawn a parallel run').toHaveBeenCalledTimes(1)

		finish(0)
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
		finish(1)
		await settle()
		expect(run, 'the coalesced notify() calls produce exactly one trailing run').toHaveBeenCalledTimes(2)
	})
})
