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

export interface CompileWorkerHandlerDeps {
	/**
	 * Lazy compiler load — deferred to the first build. May be sync (a plain
	 * `require`) or async (a dynamic `import()` of the ESM `@dimina-kit/compiler`
	 * pool); the handler awaits it either way. Loaded ONCE and cached.
	 */
	loadCompiler: () => WorkerBuildFn | Promise<WorkerBuildFn>
	/** `process.chdir` — mutates the CHILD process cwd only. */
	chdir: (dir: string) => void
	/** `process.send` — replies to the parent. */
	send: (msg: WorkerResultMessage) => void
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

/**
 * Build the fork-side IPC message handler. Non-build messages are ignored
 * (no compiler load, no reply). A build command chdirs into the project,
 * runs the compiler exactly as the old in-process call sites did, and ALWAYS
 * replies — `@dimina/compiler` swallows compile errors internally (resolves
 * undefined), which is normalized to `appInfo: null`; a genuine throw still
 * replies with `error.message` so the parent never hangs on a lost build.
 */
export function createCompileWorkerHandler(
	deps: CompileWorkerHandlerDeps,
): (msg: unknown) => Promise<void> {
	let cachedBuild: WorkerBuildFn | null = null

	return async (msg: unknown): Promise<void> => {
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
