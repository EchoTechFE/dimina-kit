/**
 * Parent-side orchestration of the forked compile worker.
 *
 * One long-lived worker per `openProject` session: the first compile and
 * every watcher rebuild are `{ cmd: 'build' }` IPC messages to the SAME
 * child, so the compiler's module/worker caches stay warm. The parent never
 * calls `process.chdir` — the worker chdirs in its own process (the root
 * motive of this architecture).
 *
 * Crash handling: an unexpected worker death ('exit' or 'close') rejects the
 * in-flight build (so the rebuild scheduler settles instead of hanging) and
 * the NEXT build lazily re-forks a fresh worker. A pre-spawn 'error' also
 * counts as death because no process ever existed; an error from an already
 * spawned child does NOT, because Node also uses that event for failed IPC
 * sends and failed kill attempts while the process remains alive. The death
 * handler is idempotent and generation-guarded: a dead child's late event can
 * never settle a build that belongs to a fresh worker. `close()` kills,
 * rejects the in-flight build itself, and resolves only after confirmed death
 * — it never re-forks
 * (refill-on-graceful-close would wedge process teardown).
 */
import { fork, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Readable } from 'node:stream'
import { filterDmccLogLine } from './compile-log.js'
import type { WorkerAppInfo, WorkerBuildOptions, WorkerResultMessage } from './compile-worker-entry.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export interface CompileLogEntry {
	stream: 'stdout' | 'stderr'
	text: string
}

export interface CompileWorkerOptions {
	/** Filtered dmcc log lines (already through `filterDmccLogLine`). */
	onLog?: (entry: CompileLogEntry) => void
	/**
	 * An already-forked compile-worker-entry process to reuse for the first
	 * build (a warm-standby hand-off) instead of paying a fresh fork + compiler
	 * import. Must be an IPC fork with piped stdio — the same shape spawnWorker
	 * produces. Pure accelerator: an adoptee that is already dead (or dies
	 * before the first build) is simply skipped and the next build forks fresh.
	 * Once adopted, the process is owned by this worker exactly like a
	 * self-forked one — close() kills it, its death rejects in-flight builds.
	 */
	adopt?: ChildProcess
	/**
	 * Watchdog deadline for one build, in milliseconds (default 120 000). The
	 * death handlers below only cover a child that DIES; a child that stays
	 * alive but never replies (a wedged compiler) would otherwise hang the
	 * in-flight build — and everything awaiting it — forever. On expiry the
	 * build rejects with a timeout error and the unresponsive child is retired
	 * (SIGTERM, then SIGKILL after a grace period); only after confirmed death
	 * may the next build fork a fresh worker.
	 */
	buildTimeoutMs?: number
	/** Grace period before a retiring worker is escalated from SIGTERM to SIGKILL. */
	killGraceMs?: number
}

const DEFAULT_BUILD_TIMEOUT_MS = 120_000
const DEFAULT_KILL_GRACE_MS = 5_000

export interface BuildRequest {
	projectPath: string
	outputDir: string
	options: WorkerBuildOptions
}

export interface CompileWorker {
	/**
	 * Run one build in the worker. Serialized: a call made while another build
	 * is in flight waits for it to settle first (the rebuild scheduler already
	 * coalesces watcher events; this guard keeps the IPC protocol single-flight
	 * even under direct use).
	 */
	build: (req: BuildRequest) => Promise<WorkerAppInfo | null>
	/**
	 * Kill the worker and resolve once the child actually died — 'exit' or
	 * 'close' (or a pre-spawn 'error', when no process ever existed). An
	 * in-flight build is rejected by close() itself
	 * (not delegated to a child 'exit' that a wedged child may never emit).
	 * Idempotent; the instance is dead afterwards — no re-fork.
	 */
	close: () => Promise<void>
}

/**
 * Resolve the fork target. In the published build this is the compiled
 * `dist/compile-worker-entry.js` sibling; under vitest/dev the module runs
 * from `src/`, where only the `.ts` source exists — the entry is a
 * zero-dependency, erasable-syntax-only shell by design, so Node can run it
 * with type stripping (default since 22.18; behind `--experimental-strip-types`
 * on 22.6–22.17, which `workerExecArgv` passes for a `.ts` entry).
 *
 * Exported (with `workerExecArgv`) as the single authority on the fork shape:
 * the warm-standby manager forks the SAME entry with the SAME execArgv, so a
 * spare is indistinguishable from a worker this module forks itself.
 */
export function resolveWorkerEntry(): string {
	const js = path.join(__dirname, 'compile-worker-entry.js')
	if (fs.existsSync(js)) return js
	return path.join(__dirname, 'compile-worker-entry.ts')
}

/**
 * execArgv for the fork. A compiled `.js` entry (the published build, engines
 * `node >=20`) needs nothing. A `.ts` entry (vitest/dev only) needs Node type
 * stripping: `--experimental-strip-types` exists since 22.6 — on older Node
 * the child would die at startup with an opaque ERR_UNKNOWN_FILE_EXTENSION /
 * bad-option crash, so fail HERE with an actionable message instead. The
 * ExperimentalWarning is silenced because the child's stderr is the dmcc log
 * transport. On ≥22.18 (stripping on by default) the flag is still accepted.
 */
export function workerExecArgv(entry: string): string[] {
	if (!entry.endsWith('.ts')) return []
	const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
	const hasStripTypesFlag = major > 22 || (major === 22 && minor >= 6)
	if (!hasStripTypesFlag) {
		throw new Error(
			`running the compile worker from .ts source requires Node >= 22.6 for type stripping `
			+ `(current: ${process.versions.node}); build the package and use the compiled dist entry instead`,
		)
	}
	return ['--experimental-strip-types', '--disable-warning=ExperimentalWarning']
}

export function createCompileWorker(opts: CompileWorkerOptions = {}): CompileWorker {
	let child: ChildProcess | null = null
	let closed = false
	let closePromise: Promise<void> | null = null
	const deathPromises = new WeakMap<ChildProcess, Promise<void>>()
	// At most one retired worker exists: the serialization chain waits for this
	// promise before it may fork a replacement.
	let retiring: { worker: ChildProcess; promise: Promise<void> } | null = null
	let inFlight: {
		/** Generation tag: the worker this build was sent to. A dead previous
		 * child's late death event must never settle a NEWER worker's build. */
		worker: ChildProcess
		resolve: (appInfo: WorkerAppInfo | null) => void
		reject: (err: Error) => void
	} | null = null
	// Serialization chain: at most one unanswered build command on the wire.
	let chain: Promise<unknown> = Promise.resolve()

	function attachLineReader(stream: Readable | null, tag: 'stdout' | 'stderr'): void {
		if (!stream) return
		// Cross-chunk half-line buffering: deliver only complete lines.
		let buffered = ''
		let flushed = false
		stream.setEncoding('utf8')
		const deliver = (line: string): void => {
			const kept = filterDmccLogLine(line.replace(/\r$/, ''))
			if (kept !== null) opts.onLog?.({ stream: tag, text: kept })
		}
		stream.on('data', (chunk: string) => {
			buffered += chunk
			let newlineAt = buffered.indexOf('\n')
			while (newlineAt !== -1) {
				const line = buffered.slice(0, newlineAt)
				buffered = buffered.slice(newlineAt + 1)
				deliver(line)
				newlineAt = buffered.indexOf('\n')
			}
		})
		// A dying process's last line (often the error summary) can end without
		// a trailing newline — flush the remainder when the stream finishes.
		// Streams emit BOTH 'end' and 'close'; the flag keeps the flush single
		// and clearing the buffer prevents a double delivery either way.
		const flush = (): void => {
			if (flushed) return
			flushed = true
			if (buffered.length === 0) return
			const line = buffered
			buffered = ''
			deliver(line)
		}
		stream.on('end', flush)
		stream.on('close', flush)
	}

	// Attach the log pipes, result routing and death handling to a worker
	// process — the SAME wiring whether the process was self-forked or adopted
	// from a warm standby (an inline copy for one of the two would drift).
	function wireWorker(worker: ChildProcess): ChildProcess {
		// A failed spawn can emit `error` without ever emitting `exit`. Once a
		// process has spawned, however, `error` is not a death signal: Node also
		// emits it when send()/kill() fails while the process may still be alive.
		let spawned = worker.pid !== undefined
		worker.once('spawn', () => { spawned = true })
		let resolveDeath!: () => void
		const deathPromise = new Promise<void>((resolve) => { resolveDeath = resolve })
		deathPromises.set(worker, deathPromise)
		attachLineReader(worker.stdout, 'stdout')
		attachLineReader(worker.stderr, 'stderr')
		// Shared, idempotent confirmed-death handler. exit+close can both fire;
		// only the FIRST one acts, and every mutation is guarded by worker
		// identity so a previous generation's death never touches a fresh one.
		let settled = false
		const settleDeath = (reason: string): void => {
			if (settled) return
			settled = true
			// Clear the dead child so the next build re-forks a fresh worker.
			if (child === worker) child = null
			// Settle an in-flight build instead of hanging the rebuild
			// scheduler — but only a build that was sent to THIS worker.
			if (inFlight && inFlight.worker === worker) {
				const pending = inFlight
				inFlight = null
				pending.reject(new Error(reason))
			}
			// Per-worker death completion: an old generation can never resolve a
			// close/retirement that belongs to its replacement.
			resolveDeath()
			// Drop stale listeners on the dead child; the next build re-forks.
			worker.removeAllListeners()
		}
		worker.on('message', (msg: unknown) => {
			if (child !== worker) return
			const result = msg as WorkerResultMessage
			if (!result || result.type !== 'result' || !inFlight) return
			const pending = inFlight
			inFlight = null
			if (result.error) {
				// A reply carrying an error is a FAILED build — pass the
				// worker-reported message through (devtools renders it).
				pending.reject(new Error(result.error.message))
				return
			}
			pending.resolve(result.appInfo ?? null)
		})
		worker.on('exit', () => settleDeath('compile worker exited unexpectedly mid-build'))
		worker.on('close', () => settleDeath('compile worker exited unexpectedly mid-build'))
		worker.on('error', (err: Error) => {
			const reason = `compile worker errored: ${err.message}`
			if (!spawned) {
				// No OS process exists, so Node cannot emit an exit event.
				settleDeath(reason)
				return
			}
			// For a live process the error settles only its request. Retire the
			// exact worker and wait for exit/close before allowing replacement.
			if (inFlight && inFlight.worker === worker) {
				const pending = inFlight
				inFlight = null
				pending.reject(new Error(reason))
			}
			if (child === worker) void retireWorker(worker)
		})
		return worker
	}

	function spawnWorker(): ChildProcess {
		const entry = resolveWorkerEntry()
		return wireWorker(fork(entry, [], {
			// Pipe stdout/stderr back to the parent — the dmcc log transport.
			silent: true,
			// Explicit execArgv, NOT the parent's (vitest/electron loaders would
			// leak into a plain Node child).
			execArgv: workerExecArgv(entry),
		}))
	}

	// Adopt the warm-standby hand-off, if any, at creation time — wiring
	// immediately (not at the first build) so a spare that dies in the gap is
	// handled by the normal death path (child cleared → next build re-forks)
	// instead of being discovered as a broken pipe mid-build. An adoptee that
	// is ALREADY dead is skipped outright: its death events fired before any
	// listener could attach, so wiring it would leave a permanently wedged
	// child slot.
	if (opts.adopt && opts.adopt.exitCode === null && opts.adopt.signalCode === null && opts.adopt.connected) {
		child = wireWorker(opts.adopt)
	}

	function retireWorker(worker: ChildProcess): Promise<void> {
		if (retiring?.worker === worker) return retiring.promise
		const death = deathPromises.get(worker) ?? Promise.resolve()
		if (child === worker) child = null
		const timers: { escalation?: ReturnType<typeof setTimeout> } = {}
		const promise = death.finally(() => {
			if (timers.escalation) clearTimeout(timers.escalation)
			if (retiring?.worker === worker) retiring = null
		})
		// Publish retirement BEFORE signalling: a synchronous/mock `error` event
		// from kill() must observe that this exact worker is already retiring.
		retiring = { worker, promise }
		try { worker.kill() }
		catch {
			try { worker.kill('SIGKILL') }
			catch { /* wait for a real exit/close; a kill error is not death */ }
		}
		timers.escalation = setTimeout(() => {
			if (retiring?.worker !== worker) return
			try { worker.kill('SIGKILL') }
			catch { /* wait for confirmed death */ }
		}, opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS)
		timers.escalation.unref?.()
		return promise
	}

	async function runBuild(req: BuildRequest): Promise<WorkerAppInfo | null> {
		// Never overlap a replacement with a timed-out compiler that may still be
		// writing the same output directory. SIGKILL escalation bounds this wait.
		if (retiring) await retiring.promise
		if (closed) {
			return Promise.reject(new Error('compile worker is closed'))
		}
		if (!child) child = spawnWorker()
		const worker = child
		return new Promise<WorkerAppInfo | null>((resolve, reject) => {
			// Watchdog: covers the send→settle window. Every settle path
			// (result message, death, close(), the watchdog itself) funnels
			// through the wrapped resolve/reject below, so the timer can never
			// outlive the build it guards.
			const timeoutMs = opts.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS
			const request = {
				worker,
				resolve,
				reject,
			}
			const timer = setTimeout(() => {
				if (inFlight !== request) return
				inFlight = null
				request.reject(new Error(
					`compile build timed out after ${timeoutMs}ms — the compile worker stopped responding and was killed`,
				))
				void retireWorker(worker)
			}, timeoutMs)
			timer.unref?.()
			request.resolve = (appInfo) => {
				clearTimeout(timer)
				resolve(appInfo)
			}
			request.reject = (err) => {
				clearTimeout(timer)
				reject(err)
			}
			inFlight = request
			try {
				worker.send({ cmd: 'build', ...req })
			}
			catch (err) {
				if (inFlight === request) inFlight = null
				request.reject(err instanceof Error ? err : new Error(String(err)))
				void retireWorker(worker)
			}
		})
	}

	return {
		build(req) {
			const result = chain.then(() => runBuild(req))
			chain = result.catch(() => {
				// Failures are reported to the caller via `result`; the chain only
				// guarantees single-flight ordering and must not reject.
			})
			return result
		},
		close() {
			if (closed) return closePromise ?? Promise.resolve()
			closed = true
			const worker = child
			// Reject the in-flight build HERE: a wedged child that ignores
			// SIGTERM never emits 'exit', and the rebuild scheduler must not
			// hang at teardown waiting on it.
			if (inFlight) {
				const pending = inFlight
				inFlight = null
				pending.reject(new Error('compile worker closed'))
			}
			if (!worker) {
				// A timeout may already be retiring the last child. Closing must wait
				// until that exact process is reaped, not merely observe child=null.
				closePromise = retiring?.promise ?? Promise.resolve()
				return closePromise
			}
			closePromise = retireWorker(worker)
			return closePromise
		},
	}
}
