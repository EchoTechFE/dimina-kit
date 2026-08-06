export interface RebuildScheduler {
	/**
	 * Request a rebuild and observe its completion (the explicit
	 * `session.rebuild()` entry point). Coalesces with any in-flight or
	 * already-pending run. The returned promise settles with the run that
	 * COVERS this call's disk state. Called while a run is in flight it tracks
	 * the trailing rerun, because the current run cannot have seen the call.
	 * Once an explicit transaction starts, its waiter is carried across any
	 * coalesced successful trailing runs and resolves only when the sequence is
	 * quiescent, so its single hard reflection cannot race a watcher reflection.
	 * It rejects with the first covered run's error. A dropped promise never
	 * surfaces as an unhandled rejection.
	 */
	schedule: () => Promise<void>
	/**
	 * Fire-and-forget rebuild request (the file watcher's entry point). Same
	 * coalescing as `schedule()` but allocates NO completion promise/waiter —
	 * a watcher event storm during a wedged build must not accumulate
	 * per-event waiters that can never settle.
	 */
	notify: () => void
}

type Waiter = { resolve: () => void; reject: (err: unknown) => void }

/**
 * Serialize rebuild runs with a dirty-flag + trailing rerun, replacing the old
 * `if (isBuilding) return` early-exit in `openProject`'s rebuild loop, which
 * silently DROPPED any watcher event that landed while a build was in flight
 * (a save made during the ~1-2s compile window never produced a rebuild — the
 * simulator stayed stale until the user saved again).
 *
 * Semantics:
 *  - `schedule()` while idle starts `run` immediately.
 *  - `schedule()` while `run` is in flight never starts a concurrent run
 *    (`build()` chdir()s into the project — concurrency would corrupt cwd);
 *    it marks the state dirty instead.
 *  - When the in-flight run settles and the state is dirty, exactly one
 *    trailing run starts: N saves during one build coalesce into 1 rerun.
 *    The trailing run is itself schedulable-against, recursively.
 *  - Completion signals follow the same coalescing: waiters that landed
 *    during a run are promoted to the trailing run. Successful explicit
 *    waiters remain promoted until no dirty tail remains, keeping reflection
 *    single-owner across the transaction. A synchronous throw from `run`
 *    funnels into the same rejection path instead of escaping `schedule()`.
 *  - A rejecting run neither wedges the scheduler nor drops a pending dirty
 *    flag — `run` reports its own errors (`onBuildError`); the rejection is
 *    ALSO forwarded to that run's waiters so an explicit rebuild caller can
 *    tell success from failure.
 *  - `run` receives `{ explicit }`: true iff the run covers at least one
 *    `schedule()` call (a user-requested rebuild), false for runs driven
 *    purely by `notify()` (background watcher saves). Downstream reflection
 *    differs — an explicit rebuild is reflected by the caller's own hard
 *    re-attach, never by the watcher's hot-reload signal.
 */
export function createRebuildScheduler(run: (info: { explicit: boolean }) => Promise<void>): RebuildScheduler {
	let running = false
	let dirty = false
	/** Waiters covered by the currently-running run. */
	let currentWaiters: Waiter[] = []
	/** Waiters that landed mid-run — covered only by the trailing rerun. */
	let pendingWaiters: Waiter[] = []
	/** Mutable so a mid-run explicit request can suppress this run's watcher reflection. */
	let currentRunInfo: { explicit: boolean } | null = null

	function start(): void {
		running = true
		// `run` stays synchronously invoked (idle schedule() starts the build
		// in the same tick), but a SYNCHRONOUS throw must funnel into the same
		// swallow-and-continue path as a rejection — a bare `run()` call would
		// let the throw escape before `.catch` attaches, leaving `running`
		// stuck at true and wedging every future schedule().
		// Explicit iff a schedule() waiter is covered: notify() allocates no
		// waiter, so waiter presence IS the origin signal.
		const runInfo = { explicit: currentWaiters.length > 0 }
		currentRunInfo = runInfo
		let settled: Promise<void>
		try {
			settled = run(runInfo)
		} catch (err) {
			settled = Promise.reject(err)
		}
		settled.then(
			() => finish(null),
			(err: unknown) => finish({ err }),
		)
	}

	/**
	 * Settle the finished run's waiters, then start the trailing run if any.
	 * Successful explicit waiters are carried into a dirty tail so the caller
	 * reflects only after the coalesced transaction becomes quiescent.
	 */
	function finish(failure: { err: unknown } | null): void {
		const continueTransaction = failure === null && dirty && currentWaiters.length > 0
		if (continueTransaction) {
			// A watcher/explicit request landed during an explicit run. Keep the
			// explicit waiters attached through the trailing run so the caller's
			// single hard reflection happens only after the coalesced sequence is
			// quiescent; otherwise that trailing watcher reflection could race it.
			pendingWaiters = [...currentWaiters, ...pendingWaiters]
		}
		else {
			for (const waiter of currentWaiters) {
				if (failure) waiter.reject(failure.err)
				else waiter.resolve()
			}
		}
		currentWaiters = []
		currentRunInfo = null
		running = false
		if (dirty) {
			dirty = false
			currentWaiters = pendingWaiters
			pendingWaiters = []
			start()
		}
	}

	return {
		schedule(): Promise<void> {
			const promise = new Promise<void>((resolve, reject) => {
				const waiter: Waiter = { resolve, reject }
				if (running) {
					dirty = true
					pendingWaiters.push(waiter)
					// The current build predates this explicit request and cannot
					// settle it, but its eventual watcher reflection must be suppressed:
					// the queued explicit transaction owns reflection for the sequence.
					if (currentRunInfo) currentRunInfo.explicit = true
					return
				}
				currentWaiters.push(waiter)
				start()
			})
			// Mark the rejection as observed even if the caller drops the
			// promise; an awaiting caller still receives it normally.
			promise.catch(() => {})
			return promise
		},
		notify(): void {
			if (running) {
				dirty = true
				return
			}
			start()
		},
	}
}
