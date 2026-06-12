export interface RebuildScheduler {
	/** Request a rebuild. Coalesces with any in-flight or already-pending run. */
	schedule: () => void
}

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
 *  - A rejecting run neither wedges the scheduler nor drops a pending dirty
 *    flag — `run` is expected to do its own error reporting (`onBuildError`).
 */
export function createRebuildScheduler(run: () => Promise<void>): RebuildScheduler {
	let running = false
	let dirty = false

	function start(): void {
		running = true
		// `run` stays synchronously invoked (idle schedule() starts the build
		// in the same tick), but a SYNCHRONOUS throw must funnel into the same
		// swallow-and-continue path as a rejection — a bare `run()` call would
		// let the throw escape before `.catch` attaches, leaving `running`
		// stuck at true and wedging every future schedule().
		let settled: Promise<void>
		try {
			settled = run()
		} catch {
			settled = Promise.reject()
		}
		settled
			.catch(() => {
				// Failures are `run`'s responsibility to report; the scheduler
				// only guarantees liveness (no wedge, no lost dirty flag).
			})
			.then(() => {
				running = false
				if (dirty) {
					dirty = false
					start()
				}
			})
	}

	return {
		schedule(): void {
			if (running) {
				dirty = true
				return
			}
			start()
		},
	}
}
