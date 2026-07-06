/**
 * `child_process.fork()` target for the long-lived compile worker.
 *
 * Compilation runs OUT of the host (Electron main) process so that:
 *  - `process.chdir(projectPath)` mutates the WORKER's cwd, never the host's,
 *  - dmcc/listr2 output lands on the worker's piped stdout/stderr (read
 *    line-by-line by the parent — no global write-hooks, no isTTY hacks),
 *  - a compiler crash kills the worker, not the host.
 *
 * Zero-dependency thin shell: the compiler is required lazily on the first
 * build command and cached for the worker's lifetime. The IPC handling lives
 * in `createCompileWorkerHandler` (dependency-injected) so it is unit-testable
 * without forking.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface WorkerAppInfo {
	appId: string
	name: string
	path: string
}

export interface WorkerBuildOptions {
	sourcemap?: boolean
	/** Forwarded verbatim to `@dimina/compiler`'s `build()` `options.fileTypes`. */
	fileTypes?: { template?: string[]; style?: string[]; viewScript?: string[] }
}

export type WorkerBuildFn = (
	outputDir: string,
	projectPath: string,
	useAppIdDir: boolean,
	options: WorkerBuildOptions,
) => Promise<WorkerAppInfo | null | undefined>

export interface WorkerResultMessage {
	type: 'result'
	appInfo: WorkerAppInfo | null
	error?: { message: string }
}

/** Reply to `{ cmd: 'ping' }` — the warm-standby manager's health probe. */
export interface WorkerPongMessage {
	type: 'pong'
	id: string
}

/** Reply to `{ cmd: 'prewarm' }` — ok:false carries the load/warm failure. */
export interface WorkerPrewarmResultMessage {
	type: 'prewarm-result'
	id: string
	ok: boolean
	error?: string
}

export type WorkerOutboundMessage
	= WorkerResultMessage | WorkerPongMessage | WorkerPrewarmResultMessage

export interface CompileWorkerHandlerDeps {
	/**
	 * Lazy compiler load — deferred to the first build (or an explicit prewarm).
	 * May be sync (a plain `require`) or async (a dynamic `import()` of the ESM
	 * `@dimina-kit/compiler` pool); the handler awaits it either way. Loaded
	 * ONCE and cached — a build after a prewarm reuses the prewarmed load.
	 */
	loadCompiler: () => WorkerBuildFn | Promise<WorkerBuildFn>
	/** `process.chdir` — mutates the CHILD process cwd only. */
	chdir: (dir: string) => void
	/** `process.send` — replies to the parent. */
	send: (msg: WorkerOutboundMessage) => void
	/**
	 * Optional deep warm-up run by `{ cmd: 'prewarm' }` after the compiler
	 * loads (e.g. spinning up the resident pool's stage workers so the first
	 * real build starts on warm threads). Project-agnostic by contract.
	 */
	warmPool?: () => Promise<void>
}

interface BuildMessage {
	cmd: 'build'
	projectPath: string
	outputDir: string
	options: WorkerBuildOptions
}

function isBuildMessage(msg: unknown): msg is BuildMessage {
	return (
		typeof msg === 'object'
		&& msg !== null
		&& (msg as { cmd?: unknown }).cmd === 'build'
	)
}

function isCommandWithId(msg: unknown, cmd: string): msg is { cmd: string, id: string } {
	return (
		typeof msg === 'object'
		&& msg !== null
		&& (msg as { cmd?: unknown }).cmd === cmd
		&& typeof (msg as { id?: unknown }).id === 'string'
	)
}

/**
 * Build the fork-side IPC message handler. Unknown messages are ignored
 * (no compiler load, no reply). A build command chdirs into the project,
 * runs the compiler exactly as the old in-process call sites did, and ALWAYS
 * replies — a compile failure rejects out of the pool's build() and is
 * relayed as `error.message` (the parent rejects its in-flight build on it),
 * so the parent never hangs on a lost build and never mistakes a failed
 * compile for success. A resolved null/undefined appInfo carries no error:
 * it means "no app info to report" and is normalized to `appInfo: null`.
 *
 * Two warm-standby commands ride the same channel:
 *  - `{ cmd: 'ping', id }` → `{ type: 'pong', id }`. Pure liveness; never
 *    loads the compiler (a health check on a cold-idle spare must stay cheap).
 *  - `{ cmd: 'prewarm', id }` → loads the compiler into the SAME cache the
 *    build path uses, then awaits `deps.warmPool?.()`, and always replies
 *    `{ type: 'prewarm-result', id, ok, error? }` (a failed prewarm reports —
 *    it never throws out of the handler). Deliberately NO chdir: a prewarmed
 *    spare stays project-agnostic, which is what makes adopting it into ANY
 *    next-opened project safe.
 */
export function createCompileWorkerHandler(
	deps: CompileWorkerHandlerDeps,
): (msg: unknown) => Promise<void> {
	let cachedBuild: WorkerBuildFn | null = null

	return async (msg: unknown): Promise<void> => {
		if (isCommandWithId(msg, 'ping')) {
			deps.send({ type: 'pong', id: msg.id })
			return
		}
		if (isCommandWithId(msg, 'prewarm')) {
			try {
				if (!cachedBuild) cachedBuild = await deps.loadCompiler()
				await deps.warmPool?.()
				deps.send({ type: 'prewarm-result', id: msg.id, ok: true })
			}
			catch (err) {
				deps.send({
					type: 'prewarm-result',
					id: msg.id,
					ok: false,
					error: err instanceof Error ? err.message : String(err),
				})
			}
			return
		}
		if (!isBuildMessage(msg)) return
		try {
			if (!cachedBuild) cachedBuild = await deps.loadCompiler()
			deps.chdir(msg.projectPath)
			const appInfo = await cachedBuild(
				msg.outputDir,
				msg.projectPath,
				true,
				msg.options,
			)
			deps.send({ type: 'result', appInfo: appInfo ?? null })
		}
		catch (err) {
			deps.send({
				type: 'result',
				appInfo: null,
				error: { message: err instanceof Error ? err.message : String(err) },
			})
		}
	}
}

/**
 * Wire a worker process to its message handler. Extracted so the fork-mode
 * self-wiring below and unit tests exercise the SAME wiring code (an inline
 * copy next to an exported one would drift apart silently).
 *
 * Both subscriptions are registered synchronously at call time — an async gap
 * between fork and the 'disconnect' subscription is a window where a dying
 * parent leaks the child as an orphan.
 */
export function wireCompileWorkerProcess(
	proc: {
		on: (event: 'message' | 'disconnect', listener: (...args: unknown[]) => void) => unknown
		exit: (code?: number) => void
	},
	handler: (msg: unknown) => Promise<void>,
): void {
	proc.on('message', (msg: unknown) => {
		void handler(msg)
	})
	// The parent kills the worker on session close; if the parent dies first
	// (IPC channel gone), exit instead of lingering as an orphan.
	proc.on('disconnect', () => {
		proc.exit(0)
	})
}

// ── Fork-mode self-wiring ───────────────────────────────────────────────────
//
// Only engage when this module IS the forked entry: argv[1] must be EXACTLY
// this module's own file (normalized-path comparison against import.meta.url),
// not merely a path containing the substring 'compile-worker-entry' — a
// substring gate would let any unrelated IPC-child script whose path happens
// to contain that fragment import this module and get its process hijacked
// (a disconnect→exit(0) handler + a message handler stealing IPC traffic).
// A plain `process.send` check is not enough either: vitest's default "forks"
// pool also runs test workers as IPC children, and importing this module from
// a unit test must stay side-effect free there.
//
// `stripModuleQuery` drops a `?query` / `#hash` suffix before comparing —
// dev-time loaders (vite-node/vitest) append cache-busting queries like
// `?v=…` to module URLs, which fileURLToPath would choke on and which never
// appear in the real argv[1].
function stripModuleQuery(spec: string): string {
	return spec.replace(/[?#].*$/, '')
}

const selfModulePath = (() => {
	try {
		return path.resolve(fileURLToPath(stripModuleQuery(import.meta.url)))
	}
	catch {
		// Non-file module URL (bundler virtual module etc.) — never the fork
		// target, so the gate simply stays disengaged.
		return null
	}
})()

const isForkedWorkerEntry
	= typeof process.argv[1] === 'string'
		&& selfModulePath !== null
		&& path.resolve(stripModuleQuery(process.argv[1])) === selfModulePath
		&& typeof process.send === 'function'

if (isForkedWorkerEntry) {
	const handler = createCompileWorkerHandler({
		// Load @dimina-kit/compiler's resident Node worker_threads pool (drop-in for
		// dmcc's build(): same signature, same log/error surface, but keeps its 3 stage
		// workers WARM across rebuilds). ESM package → dynamic import (works on Node 20+);
		// its default export is the pooled build fn.
		loadCompiler: async () =>
			(await import('@dimina-kit/compiler/pool-node')).default as unknown as WorkerBuildFn,
		// Deep prewarm for the warm-standby spare: spin up the resident pool's stage
		// workers ahead of the first build. Optional-chained so an older compiler
		// package without the export degrades to load-only prewarm.
		warmPool: async () => {
			const pool = await import('@dimina-kit/compiler/pool-node') as { warmDefaultPool?: () => Promise<void> }
			await pool.warmDefaultPool?.()
		},
		chdir: dir => process.chdir(dir),
		send: (msg) => {
			process.send?.(msg)
		},
	})
	wireCompileWorkerProcess(
		{
			on: (event, listener) => process.on(event, listener),
			exit: code => process.exit(code),
		},
		handler,
	)
}
