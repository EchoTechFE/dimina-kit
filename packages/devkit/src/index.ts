import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import chokidar from 'chokidar'
import { WATCH_IGNORE_DIRS } from './watch-ignore.js'
import { applyEsbuildBinaryPath } from './esbuild-binary-path.js'
import { createRebuildScheduler } from './rebuild-scheduler.js'
import { createCompileWorker } from './compile-worker.js'
import type { CompileLogEntry, CompileWorker } from './compile-worker.js'
import { composeBuildCompleted, runRebuild } from './rebuild-dispatch.js'
import { createCompileWorkerStandby } from './compile-worker-standby.js'
import type { CompileWorkerStandby, CompileWorkerStandbyOptions } from './compile-worker-standby.js'

export { WATCH_IGNORE_DIRS } from './watch-ignore.js'
export { isStyleOnlyChange, composeBuildCompleted } from './rebuild-dispatch.js'
export { createRebuildScheduler } from './rebuild-scheduler.js'
export type { RebuildScheduler } from './rebuild-scheduler.js'
export { filterDmccLogLine } from './compile-log.js'
export { createCompileWorker } from './compile-worker.js'
export type { CompileLogEntry, CompileWorker } from './compile-worker.js'
export { createCompileWorkerStandby } from './compile-worker-standby.js'
export type {
	CompileWorkerStandby,
	CompileWorkerStandbyOptions,
	StandbyEvent,
	StandbyState,
} from './compile-worker-standby.js'

// ── warm standby (opt-in) ──────────────────────────────────────────────────
//
// One module-level spare compile worker shared by every `openProject` in this
// process. While no project is open the spare sits forked + prewarmed
// (project-agnostic — it never chdirs, see compile-worker-entry); openProject
// adopts it for the first compile and each session close refills it. Purely
// additive: hosts that never call `enableCompileWorkerStandby` get exactly the
// cold-fork behavior they had before.
let standbyManager: CompileWorkerStandby | null = null

/**
 * Turn on the warm-standby accelerator and start warming the first spare
 * immediately. Idempotent while the returned manager is live — repeat calls
 * return the SAME manager (their opts are ignored). After `dispose()` (host
 * shutdown, or a test tearing down) a new call builds a fresh manager. The
 * caller owns disposal; a disposed manager makes every openProject fall back
 * to cold forks and never spawns again.
 */
export function enableCompileWorkerStandby(
	opts?: CompileWorkerStandbyOptions,
): CompileWorkerStandby {
	if (standbyManager && standbyManager.state !== 'disposed') return standbyManager
	standbyManager = createCompileWorkerStandby(opts)
	standbyManager.ensure()
	return standbyManager
}

/**
 * Refill the spare after a compile worker has been consumed and fully closed.
 * Fire-and-forget BY DESIGN: the fork happens asynchronously inside the
 * manager, so a session close never waits on (and can never be wedged by)
 * standby work — the refill-on-graceful-close deadlock class stays
 * structurally impossible. No-ops when the standby is off, already warming,
 * or disposed.
 */
function refillStandby(): void {
	standbyManager?.ensure()
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// Packaged inside app.asar, esbuild's native binary must be spawned from
// app.asar.unpacked — resolved via require.resolve so the hoisting depth
// (pnpm vs npm layouts) is never hard-coded. The per-platform binary layout
// and every failure diagnostic live in esbuild-binary-path.ts. The env var is
// set before any compile worker forks, and forks inherit it.
applyEsbuildBinaryPath({
	dirname: __dirname,
	env: process.env,
	platform: process.platform,
	arch: process.arch,
	resolve: require.resolve,
	exists: fs.existsSync,
	warn: console.warn,
})

function getRandomPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer()
		srv.listen(0, () => {
			const port = (srv.address() as import('node:net').AddressInfo).port
			srv.close(() => resolve(port))
		})
		srv.on('error', reject)
	})
}

type FeStart = (opts: {
	port?: number
	containerDir: string
	outputDir?: string
	simulatorDir?: string
	liveReload?: boolean
	sessionApps?: Array<{ appId: string; name: string; path: string }>
}) => Promise<{ server: Server; reload: () => void; reloadStyles?: () => void }>

export interface AppInfo {
	appId: string
	name: string
	path: string
}

export interface ProjectSession {
	appInfo: AppInfo
	port: number
	close: () => Promise<void>
}

export interface OpenProjectOptions {
	projectPath: string
	port?: number
	sourcemap?: boolean
	/**
	 * Custom file types appended on top of the built-in `wx*`/`dd*` families,
	 * forwarded to `@dimina/compiler`'s `build()` so `.qdml`/`.qdss`/`.qds` etc.
	 * compile like their `.wxml`/`.wxss`/`.wxs` equivalents.
	 */
	fileTypes?: { template?: string[]; style?: string[]; viewScript?: string[] }
	simulatorDir?: string
	containerDir?: string
	outputDir?: string
	/** When false, skip the chokidar file-watcher / auto-rebuild loop. Default true. */
	watch?: boolean
	/**
	 * When false, a completed watcher rebuild does NOT touch the preview at all;
	 * `onRebuild` still fires so the host learns the build finished, but the page
	 * stack / form state survives. When true (default), the preview reacts to the
	 * rebuild: a rebuild touching ONLY stylesheets hot-swaps each `<link>` in
	 * place (SSE `reload-style` — page stack / form state survive), while any
	 * other change does a full page reload (SSE `reload` → container
	 * `window.location.reload()`). Independent of `watch`.
	 */
	autoReload?: boolean
	/**
	 * Fired after each successful watcher rebuild. `info.changedPaths` are the
	 * files that triggered it; `info.styleOnly` is true when every one is a
	 * stylesheet (see {@link isStyleOnlyChange}) — the host can then hot-swap
	 * styles in place instead of a full reload. Both are absent (undefined) for
	 * the SSE-driven web-preview path; native hosts read them to pick a fast path.
	 */
	onRebuild?: (info?: { changedPaths: string[]; styleOnly: boolean }) => void
	onBuildError?: (err: unknown) => void
	/**
	 * Per-line dmcc compile log, already filtered through `filterDmccLogLine`
	 * (noise stripped, signal kept). Lines come from the forked compile
	 * worker's piped stdout/stderr, tagged with their source stream.
	 */
	onLog?: (entry: CompileLogEntry) => void
	/**
	 * Fired when the file watcher emits `'error'` (EMFILE, permission loss, …)
	 * AFTER its initial scan already resolved `ready` — i.e. the session is
	 * live and auto-rebuild-on-save has silently stopped working. A pre-ready
	 * error instead rejects `openProject` itself (see `createProjectWatcher`),
	 * so this only ever fires once per session, at most.
	 */
	onWatcherError?: (err: unknown) => void
}

/**
 * Best-effort fallback when the compiler returns no AppInfo (e.g. a build
 * racing against a just-closed project in the same Electron process): reads
 * the canonical appid from project.config.json so storage prefixing (which
 * keys off appInfo.appId) still lines up with the runtime instead of
 * silently falling to 'unknown'.
 */
function resolveAppInfoFallback(projectPath: string): AppInfo | null {
	try {
		const configRaw = fs.readFileSync(path.join(projectPath, 'project.config.json'), 'utf8')
		const config = JSON.parse(configRaw) as { appid?: string; projectname?: string }
		if (!config.appid || typeof config.appid !== 'string' || config.appid.length === 0) return null
		return {
			appId: config.appid,
			name: config.projectname ?? path.basename(projectPath),
			path: projectPath,
		}
	}
	catch {
		// best-effort — fall through to the 'unknown' fallback in the caller
		return null
	}
}

/**
 * Tear down whatever partially started before `openProject` failed: the
 * watcher, the forked compile worker, and the dev server if it was already
 * listening. Every step is best-effort so a secondary failure here never
 * masks the primary error the caller is about to rethrow.
 */
async function cleanupFailedOpen(
	watcher: { close: () => Promise<void>; ready: Promise<void> } | null,
	compileWorker: CompileWorker,
	server: Server | null,
): Promise<void> {
	try {
		await watcher?.close()
	}
	catch {
		// best-effort — the open is already failing with the primary error
	}
	try {
		await compileWorker.close()
	}
	catch {
		// best-effort — never mask the primary error
	}
	if (server) {
		;(server as Server & { closeAllConnections?: () => void }).closeAllConnections?.()
		const listening = server
		await new Promise<void>(resolve => listening.close(() => resolve()))
	}
}

export async function openProject(opts: OpenProjectOptions): Promise<ProjectSession> {
	const {
		projectPath: rawProjectPath,
		port = 0,
		sourcemap = false,
		fileTypes,
		simulatorDir,
		containerDir: overrideContainerDir,
		outputDir,
		watch = true,
		autoReload = true,
		onRebuild,
		onBuildError,
		onLog,
		onWatcherError,
	} = opts
	const projectPath = path.resolve(rawProjectPath)
	const buildOptions = { sourcemap, fileTypes }

	const resolvedPort = port === 0 ? await getRandomPort() : port

	const containerDir = overrideContainerDir ?? path.join(__dirname, '..', 'fe', 'dimina-fe-container')
	const resolvedOutputDir = outputDir
		?? path.join(os.tmpdir(), 'dimina-kit', createHash('sha1').update(projectPath).digest('hex').slice(0, 12))
	fs.mkdirSync(resolvedOutputDir, { recursive: true })

	// Compilation runs in a long-lived forked worker — the worker chdirs in
	// its OWN process, so this (host) process never mutates its cwd, and dmcc
	// terminal output arrives on the worker's piped streams (delivered to
	// `onLog` line-by-line after `filterDmccLogLine`). When the warm standby is
	// enabled and holds a healthy spare, adopt it: the first compile then runs
	// on an already-forked, toolchain-warm process. adopt() degrades to null on
	// every failure path, which lands in the normal cold-fork behavior.
	const adopted = standbyManager ? await standbyManager.adopt() : null
	const compileWorker = createCompileWorker({ onLog, ...(adopted ? { adopt: adopted } : {}) })
	const buildRequest = {
		projectPath,
		outputDir: resolvedOutputDir,
		options: buildOptions,
	}

	let initialAppInfo: AppInfo | null
	try {
		initialAppInfo = (await compileWorker.build(buildRequest)) as AppInfo | null
	}
	catch (err) {
		// The first compile failing IS the open failing: a compile error rejects
		// out of the worker (the pool relays it as a real rejection), and a
		// session started anyway could only serve 404s (no artifacts in
		// outputDir) while the real cause stays invisible. Tear down and rethrow
		// so the host sees the compile error as openProject's failure.
		await compileWorker.close()
		// A failed open consumed the spare too — refill (fire-and-forget) so the
		// NEXT open attempt still starts warm.
		refillStandby()
		throw err
	}
	// A compile FAILURE rejects above — a resolved null never means "compile
	// failed". It means the compiler had no app info to report: e.g. racing a
	// project that was just closed elsewhere in the same Electron process,
	// where the manifest on disk is perfectly readable. The fallback to
	// `{ appId: 'unknown' }` is load-bearing for
	// any consumer that calls `wx.setStorageSync` — the dimina runtime
	// stores values under `${appId}_${key}` and the devtools storage panel
	// also derives its IPC prefix from `appInfo.appId`. A stale `unknown`
	// appId makes the panel and the runtime disagree (panel writes
	// `unknown_foo`, runtime reads `${realAppId}_foo`), so this falls back
	// to the canonical id from `project.config.json` instead. The literal
	// `'unknown'` is only used as a last resort when the manifest itself
	// is missing/unreadable, preserving the original error path.
	if (!initialAppInfo) {
		initialAppInfo = resolveAppInfoFallback(projectPath)
	}
	if (!initialAppInfo) {
		// Both the compile (null AppInfo) and the project.config.json fallback
		// failed to yield an appId. The session is still constructed below with
		// `appId: 'unknown'` so storage prefixing stays consistent, but with that
		// id the runtime later fetches `<base>unknown/<root>/logic.js`, which 404s
		// → no modules register → the cryptic `module app not found`. Surface the
		// real cause here, at the point the invalid id is produced, instead of
		// letting it fail opaquely at injection time.
		const reason = `[devkit] could not resolve an appId for ${projectPath}: the compiler produced no app info and project.config.json has no "appid". `
			+ 'Falling back to "unknown" — the mini-program is likely missing its manifest.'
		console.warn(reason)
		onBuildError?.(new Error(reason))
	}
	const sessionApps: AppInfo[] = initialAppInfo ? [initialAppInfo] : []

	// Everything after the worker exists is failure-cleaned: if the dev server
	// or the watcher fails to come up, the already-forked compile worker (and a
	// server that already started listening) must be torn down before the error
	// propagates — otherwise every failed open leaks a whole compiler process.
	let server: Server | null = null
	let reload: (() => void) | undefined
	let reloadStyles: (() => void) | undefined
	let watcher: { close: () => Promise<void>; ready: Promise<void> } | null = null

	try {
		process.env.DIMINA_NO_OPEN_BROWSER = '1'
		const fe = await import('../fe/index.js' as string)
		const start = fe.start as FeStart
		const started = await start({
			port: resolvedPort,
			containerDir,
			outputDir: resolvedOutputDir,
			simulatorDir,
			liveReload: true,
			sessionApps,
		})
		server = started.server
		reload = started.reload
		reloadStyles = started.reloadStyles

		// Watcher events are routed through the scheduler so a save landing while
		// a build is in flight is never dropped: it coalesces into exactly one
		// trailing rebuild once the current run settles.
		const onBuildCompleted = composeBuildCompleted({
			autoReload,
			getReload: () => reload,
			getReloadStyles: () => reloadStyles,
			styleExts: fileTypes?.style,
			onRebuild,
		})
		// The scheduler coalesces N saves into one trailing rebuild, so the changed
		// paths accumulate here and are drained (not lost) at the moment that run
		// actually starts. Draining at run-start — before the build's await — lets
		// saves landing DURING the build accumulate cleanly for the next trailing
		// run. An empty set means "changes unknown" → composeBuildCompleted falls
		// back to a full reload rather than a style-only swap.
		const pendingChanges = new Set<string>()
		const rebuildScheduler = createRebuildScheduler(() => {
			const changed = [...pendingChanges]
			pendingChanges.clear()
			return runRebuild(compileWorker, buildRequest, sessionApps, onBuildCompleted, err => onBuildError?.(err), changed)
		})
		watcher = watch
			? createProjectWatcher(projectPath, (changedPath) => {
				if (changedPath) pendingChanges.add(changedPath)
				rebuildScheduler.schedule()
			}, onWatcherError)
			: null
		// Don't resolve until the watcher's initial scan is done: a save landing
		// in the gap between `openProject` resolving and chokidar going live
		// (fsevents stream not yet active on macOS) would otherwise be silently
		// missed — no rebuild for the very first post-open edit. The promise
		// also REJECTS on a pre-ready watcher 'error' (EMFILE, permission loss)
		// so a broken watcher fails the open instead of hanging it forever.
		await watcher?.ready
	}
	catch (err) {
		await cleanupFailedOpen(watcher, compileWorker, server)
		refillStandby()
		throw err
	}

	// `server` is always assigned when the try block completes without throwing
	// — this guard exists only to narrow the type for the close closure.
	if (!server) throw new Error('openProject: dev server missing after successful start')
	const liveServer = server
	return {
		appInfo: initialAppInfo ?? { appId: 'unknown', name: path.basename(projectPath), path: projectPath },
		port: resolvedPort,
		close: async () => {
			await watcher?.close()
			// Kill the long-lived compile worker and WAIT for the child to be
			// actually dead — THIS worker is never re-forked on a graceful close
			// (an awaited refill here would wedge process teardown).
			await compileWorker.close()
			// The standby refill is different: fire-and-forget into the manager
			// (nothing here waits on it), sequenced after the old worker's death
			// so spare + dying worker never hold memory simultaneously.
			refillStandby()
			;(liveServer as Server & { closeAllConnections?: () => void }).closeAllConnections?.()
			await new Promise<void>(resolve => liveServer.close(() => resolve()))
		},
	}
}

/**
 * Watch a project directory and invoke `onChange` whenever a source file is
 * created, modified, or deleted. Returns a handle whose `close()` stops the
 * watcher and whose `ready` resolves once the initial scan is complete (only
 * changes made after that point are guaranteed to surface).
 */
export function createProjectWatcher(
	projectPath: string,
	onChange: (changedPath?: string) => void | Promise<void>,
	onWatcherError?: (err: unknown) => void,
): { close: () => Promise<void>; ready: Promise<void> } {
	// Ignore dotfiles/dot-directories that live *inside* the project (.git,
	// .DS_Store, editor scratch, etc.) without nuking the whole watch when the
	// project itself sits under a dotted ancestor path. A regex like
	// /(^|[/\\])\../ runs against the full absolute path, so a project under
	// e.g. /…/.claude/worktrees/app would match on the ancestor ".claude" and
	// chokidar would silently ignore everything — editing source files never
	// triggers a rebuild. The function form scopes the dot check to the path
	// segments *below* projectPath. chokidar v5 passes posix-normalized
	// (forward-slash) absolute paths to the matcher, so we normalize both sides
	// before computing the relative path.
	const toPosix = (p: string) => p.replace(/\\/g, '/')
	const projectPathPosix = toPosix(path.resolve(projectPath))
	const watcher = chokidar.watch(projectPath, {
		ignored: (candidate: string) => {
			const rel = path.posix.relative(projectPathPosix, toPosix(candidate))
			// The root itself (rel === '') or anything outside the project
			// (rel starts with '..') must never be ignored.
			if (!rel || rel.startsWith('..'))
				return false
			// Ignore all dotfiles/dot-dirs plus the shared never-source core
			// (`WATCH_IGNORE_DIRS`: node_modules + VCS), kept in one place so the
			// devtools editor mirror can't drift from this on the load-bearing
			// `node_modules` omission. NOT build-output dirs like `dist`/`build`
			// (app.json may put pages there — the compiler must see those edits).
			// Watching `node_modules` makes chokidar hold thousands of
			// per-directory handles — a multi-second `watcher.close()`, a slow
			// initial scan, and spurious rebuilds on dependency churn; the
			// compiler's real npm input is the built `miniprogram_npm/`, which
			// stays watched.
			return rel.split('/').some(seg => seg.startsWith('.') || WATCH_IGNORE_DIRS.has(seg))
		},
		persistent: true,
		ignoreInitial: true,
	})
	// Listen to add + change + unlink so creating, editing, and deleting a
	// source file all surface as onChange. Listening only to 'change' silently
	// dropped the "developer added a new page" case (a chokidar 'add' event)
	// and made auto-compile feel broken on a common save pattern.
	watcher.on('add', (p: string) => { void onChange(p) })
	watcher.on('change', (p: string) => { void onChange(p) })
	watcher.on('unlink', (p: string) => { void onChange(p) })
	// A watcher 'error' before the initial scan completes (EMFILE, permission
	// loss, …) must REJECT `ready`: resolving only on 'ready' would leave
	// `await watcher.ready` — and the whole openProject — hung forever. The
	// listener also doubles as the EventEmitter unhandled-'error' guard. Once
	// `ready` has settled, the reject above is a no-op — that's the live-session
	// case (watcher died mid-session, not at open time) and is instead surfaced
	// through `onWatcherError`, the only remaining signal that auto-rebuild has
	// silently stopped.
	let readySettled = false
	const ready = new Promise<void>((resolve, reject) => {
		watcher.once('ready', () => {
			readySettled = true
			resolve()
		})
		watcher.on('error', (err: unknown) => {
			if (!readySettled) {
				readySettled = true
				reject(err instanceof Error ? err : new Error(String(err)))
				return
			}
			onWatcherError?.(err)
		})
	})
	return {
		close: () => watcher.close(),
		ready,
	}
}
