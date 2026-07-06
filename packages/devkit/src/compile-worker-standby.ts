/**
 * Warm-standby manager for the forked compile worker.
 *
 * A host (devtools) keeps ONE project-agnostic spare compile worker forked and
 * prewarmed while no project is open; `openProject` adopts it so the first
 * compile skips fork + compiler import + toolchain load. The spare never
 * chdirs and never builds (see compile-worker-entry's prewarm contract), so it
 * can be handed to ANY next-opened project.
 *
 * The manager is a PURE ACCELERATOR — every failure mode degrades to "no
 * spare" and the caller's normal cold-fork path:
 *  - adopt() health-checks the spare (ping/pong with a timeout) and kills a
 *    wedged one rather than handing it over.
 *  - an unexpected spare death auto-refills, but through a circuit breaker:
 *    `breakerMaxDeaths` deaths inside `breakerWindowMs` trip the manager into
 *    'degraded' — permanently cold, no fork storm on a broken install.
 *  - dispose() (host quit) kills the spare and is terminal; ensure()/adopt()
 *    afterwards are no-ops, so a teardown racing a refill cannot leak a fork.
 *
 * State machine: empty → (ensure) warming → ready → (adopt) empty; an
 * unexpected death keeps the refill obligation ('warming' with the respawn
 * scheduled after a short delay); 'degraded' and 'disposed' are terminal.
 */
import { fork, type ChildProcess } from 'node:child_process'
import { resolveWorkerEntry, workerExecArgv } from './compile-worker.js'

export type StandbyState = 'empty' | 'warming' | 'ready' | 'degraded' | 'disposed'

export interface StandbyEvent {
	type: 'spawned' | 'prewarmed' | 'adopted' | 'health-check-failed' | 'died' | 'degraded'
	pid?: number
	reason?: string
}

export interface CompileWorkerStandby {
	/** Fork + prewarm a spare if none exists. No-op while warming/ready/degraded/disposed. */
	ensure: () => void
	/**
	 * Health-check the spare and hand it over (the caller owns it afterwards;
	 * pass it to `createCompileWorker({ adopt })`). Returns null — never
	 * throws, never hangs — when there is no healthy spare to give.
	 */
	adopt: () => Promise<ChildProcess | null>
	/** Kill the spare (waiting for real death) and shut the manager down for good. */
	dispose: () => Promise<void>
	readonly state: StandbyState
}

export interface CompileWorkerStandbyOptions {
	/** Lifecycle telemetry (diagnostics bus, logs). Errors thrown here are swallowed. */
	onEvent?: (ev: StandbyEvent) => void
	/** Sliding window for the crash-loop circuit breaker. Default 30000. */
	breakerWindowMs?: number
	/** Spare deaths within the window that trip 'degraded'. Default 3. */
	breakerMaxDeaths?: number
	/** ping→pong deadline for adopt()'s health check. Default 1000. */
	healthCheckTimeoutMs?: number
	/** Fork target override (tests script the spare's behavior). Default: the real compile-worker-entry. */
	entry?: string
}

// Delay between an unexpected spare death and the refill fork. Long enough
// that an adopt() racing the death observes "obligation but no spare" (and
// reports a failed hand-off) instead of adopting a just-born replacement the
// caller never warmed; short enough that the refill is imperceptible.
const REFILL_DELAY_MS = 500

export function createCompileWorkerStandby(
	opts: CompileWorkerStandbyOptions = {},
): CompileWorkerStandby {
	const {
		onEvent,
		breakerWindowMs = 30_000,
		breakerMaxDeaths = 3,
		healthCheckTimeoutMs = 1000,
	} = opts

	let state: StandbyState = 'empty'
	let spare: ChildProcess | null = null
	// The manager's own listeners on the current spare — removed on hand-off /
	// deliberate kill so only UNEXPECTED deaths flow into the breaker.
	let detachSpareListeners: (() => void) | null = null
	let refillTimer: NodeJS.Timeout | null = null
	let deathTimestamps: number[] = []
	let msgSeq = 0

	function emit(ev: StandbyEvent): void {
		try {
			onEvent?.(ev)
		}
		catch {
			// telemetry must never break the manager
		}
	}

	function cancelRefill(): void {
		if (refillTimer) {
			clearTimeout(refillTimer)
			refillTimer = null
		}
	}

	/** Take the spare out of the manager without killing it (hand-off / deliberate kill). */
	function releaseSpare(child: ChildProcess): void {
		if (spare !== child) return
		detachSpareListeners?.()
		detachSpareListeners = null
		spare = null
	}

	/**
	 * Single death-accounting authority: emits `died`, feeds the breaker, and
	 * either trips 'degraded' or keeps the refill obligation ('warming' with the
	 * respawn scheduled after REFILL_DELAY_MS). Both an unexpected spare death
	 * and a synchronous fork failure flow through here — one breaker, one refill
	 * policy.
	 */
	function recordDeathAndScheduleRefill(pid: number | undefined, reason: string): void {
		emit({ type: 'died', pid, reason })
		const now = Date.now()
		deathTimestamps = deathTimestamps.filter(t => now - t < breakerWindowMs)
		deathTimestamps.push(now)
		if (deathTimestamps.length >= breakerMaxDeaths) {
			state = 'degraded'
			cancelRefill()
			emit({
				type: 'degraded',
				reason: `${deathTimestamps.length} spare deaths within ${breakerWindowMs}ms — standby disabled for this session`,
			})
			return
		}
		state = 'warming'
		cancelRefill()
		refillTimer = setTimeout(() => {
			refillTimer = null
			if (state !== 'warming' || spare !== null) return
			spawnSpare()
		}, REFILL_DELAY_MS)
		refillTimer.unref?.()
	}

	function onSpareDeath(child: ChildProcess, reason: string): void {
		if (spare !== child) return
		releaseSpare(child)
		if (state === 'disposed' || state === 'degraded') return
		recordDeathAndScheduleRefill(child.pid, reason)
	}

	function spawnSpare(): void {
		const entry = opts.entry ?? resolveWorkerEntry()
		let child: ChildProcess
		try {
			// Same fork shape as compile-worker's own spawnWorker — piped stdio,
			// explicit execArgv — so the adopter can't tell the difference.
			child = fork(entry, [], { silent: true, execArgv: workerExecArgv(entry) })
		}
		catch (err) {
			// A synchronous fork failure is a death for breaker purposes: a broken
			// install must trip 'degraded', not retry forever.
			recordDeathAndScheduleRefill(undefined, `spare fork failed: ${err instanceof Error ? err.message : String(err)}`)
			return
		}
		spare = child
		state = 'warming'
		emit({ type: 'spawned', pid: child.pid })

		const onExit = (): void => onSpareDeath(child, 'spare exited')
		const onError = (err: Error): void => onSpareDeath(child, `spare errored: ${err.message}`)
		const onMessage = (msg: unknown): void => {
			if (spare !== child) return
			const reply = msg as { type?: string, id?: string, ok?: boolean, error?: string }
			if (reply && reply.type === 'prewarm-result' && reply.id === prewarmId) {
				if (reply.ok) {
					if (state === 'warming') {
						state = 'ready'
						emit({ type: 'prewarmed', pid: child.pid })
					}
				}
				else {
					// A spare that cannot prewarm is useless — kill it deliberately
					// and let the death path decide between refill and breaker.
					const failed = child
					try {
						failed.kill('SIGKILL')
					}
					catch {
						// already dying
					}
				}
			}
		}
		child.on('exit', onExit)
		child.on('error', onError)
		child.on('message', onMessage)
		detachSpareListeners = () => {
			child.off('exit', onExit)
			child.off('error', onError)
			child.off('message', onMessage)
		}

		const prewarmId = `standby-prewarm-${++msgSeq}`
		try {
			child.send({ cmd: 'prewarm', id: prewarmId })
		}
		catch {
			// channel already gone — the exit listener owns this death
		}
	}

	/** ping→pong round-trip with a deadline; false on timeout, death or a closed channel. */
	function pingCheck(child: ChildProcess): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			if (child.exitCode !== null || child.signalCode !== null || !child.connected) {
				resolve(false)
				return
			}
			const id = `standby-ping-${++msgSeq}`
			const onMsg = (msg: unknown): void => {
				const reply = msg as { type?: string, id?: string }
				if (reply && reply.type === 'pong' && reply.id === id) settle(true)
			}
			const onGone = (): void => settle(false)
			const timer = setTimeout(() => settle(false), healthCheckTimeoutMs)
			timer.unref?.()
			const settle = (ok: boolean): void => {
				clearTimeout(timer)
				child.off('message', onMsg)
				child.off('exit', onGone)
				child.off('error', onGone)
				resolve(ok)
			}
			child.on('message', onMsg)
			child.on('exit', onGone)
			child.on('error', onGone)
			try {
				child.send({ cmd: 'ping', id })
			}
			catch {
				settle(false)
			}
		})
	}

	return {
		get state() {
			return state
		},

		ensure() {
			if (state !== 'empty') return
			spawnSpare()
		},

		async adopt() {
			if (state !== 'ready' && state !== 'warming') return null
			const child = spare
			if (!child) {
				// The manager owes a spare (a refill is pending after a death) but
				// has nothing healthy to hand over right now.
				emit({ type: 'health-check-failed', reason: 'spare died before adoption' })
				return null
			}
			const healthy = await pingCheck(child)
			if (spare !== child) {
				// Died during the check — the death path already took over.
				emit({ type: 'health-check-failed', pid: child.pid, reason: 'spare died during health check' })
				return null
			}
			if (!healthy) {
				emit({ type: 'health-check-failed', pid: child.pid, reason: 'no pong within the health-check window' })
				// Deliberate kill: detach FIRST so this never counts as an
				// unexpected death (no refill, no breaker hit). The caller is about
				// to cold-fork; it re-arms the standby explicitly via ensure().
				releaseSpare(child)
				state = 'empty'
				try {
					child.kill('SIGKILL')
				}
				catch {
					// already gone
				}
				return null
			}
			releaseSpare(child)
			cancelRefill()
			state = 'empty'
			emit({ type: 'adopted', pid: child.pid })
			return child
		},

		async dispose() {
			if (state === 'disposed') return
			state = 'disposed'
			cancelRefill()
			const child = spare
			if (child) releaseSpare(child)
			if (!child || child.exitCode !== null || child.signalCode !== null) return
			await new Promise<void>((resolve) => {
				const done = (): void => resolve()
				child.once('exit', done)
				child.once('error', done)
				// Bounded: a spare that somehow ignores the kill must not wedge the
				// host's quit path — the kill was issued, the wait is best-effort.
				const guard = setTimeout(done, 5000)
				guard.unref?.()
				try {
					child.kill()
				}
				catch {
					resolve()
				}
			})
		},
	}
}
