import fs from 'node:fs'

/**
 * FLAKE-HARDENING HELPER (not a test file — name avoids the `*.test.ts` glob).
 *
 * Why this exists
 * ───────────────
 * The watcher-driven rebuild tests in compile-worker.test.ts /
 * open-project-compile-log.test.ts / compile-worker-leak.test.ts exercise the
 * ONE genuinely-real moving part left after fork is mocked: chokidar's inotify
 * watch. A single `fs.writeFileSync` produces a single inotify `change` event,
 * and under CI load (Linux inotify + a concurrent REAL dmcc compile in
 * open-project-compile-log.test.ts pegging the CPU) chokidar can DROP that lone
 * event — the rebuild never fires and the test waits forever until timeout.
 *
 * The fix is NOT a longer timeout (the event is lost, not slow): re-issue the
 * filesystem write — with micro-varied content so size+mtime change and a fresh
 * inotify event is guaranteed — until the rebuild we're waiting on actually
 * lands. The rebuild scheduler (rebuild-scheduler.ts) coalesces every extra
 * write into exactly ONE trailing build, so re-writing is safe for the
 * count-agnostic / `>=` assertions these helpers are applied to.
 *
 * This is flake hardening only: no assertion is touched. Only apply these
 * helpers where the assertion is count-agnostic or `>=`
 * (re-triggering an extra coalesced rebuild cannot change the outcome). Tests
 * that pin an EXACT rebuild/build-send count must not use them.
 */

const REWRITE_INTERVAL_MS = 400

/**
 * Write `file` with `contentFor(attempt)`; if `settled` (e.g. the onRebuild
 * promise) does not resolve within ~400ms, re-write with the next attempt's
 * content (guaranteed size/mtime change → fresh inotify event) and keep
 * retrying until `settled` resolves or the test's own vitest timeout fires.
 *
 * `contentFor` MUST embed `attempt` so successive writes differ in length —
 * an identical-bytes rewrite can be coalesced by the OS into no new event.
 */
export async function writeUntilSettled(
	settled: Promise<unknown>,
	file: string,
	contentFor: (attempt: number) => string,
): Promise<void> {
	let done = false
	const guard = settled.then(
		() => { done = true },
		() => { done = true },
	)

	let attempt = 0
	// First write happens immediately; subsequent re-writes only if still unsettled.
	for (;;) {
		fs.writeFileSync(file, contentFor(attempt))
		attempt += 1
		const tick = await Promise.race([
			guard.then(() => 'settled' as const),
			sleep(REWRITE_INTERVAL_MS).then(() => 'retry' as const),
		])
		if (tick === 'settled' || done) break
	}

	await settled
}

/**
 * Like `writeUntilSettled` but waits on a polled PREDICATE instead of a
 * promise — for the `vi.waitFor(buildSends === N)` / `logEntries.length > 0`
 * style waiters where the thing being awaited is observable state, not a
 * one-shot resolve. Re-writes the file every ~400ms until `predicate()` is
 * true. Same coalescing-safety contract: predicate must be count-agnostic /
 * monotone-reached (a `>=`, a "saw output", or a stable equality that extra
 * coalesced rebuilds cannot overshoot).
 */
export async function writeUntilPredicate(
	predicate: () => boolean,
	file: string,
	contentFor: (attempt: number) => string,
): Promise<void> {
	let attempt = 0
	for (;;) {
		fs.writeFileSync(file, contentFor(attempt))
		attempt += 1
		const start = Date.now()
		while (Date.now() - start < REWRITE_INTERVAL_MS) {
			if (predicate()) return
			await sleep(25)
		}
		if (predicate()) return
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise<void>(resolve => setTimeout(resolve, ms))
}
