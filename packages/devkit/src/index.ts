import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import chokidar from 'chokidar'
import { createRebuildScheduler } from './rebuild-scheduler.js'
import { createCompileWorker } from './compile-worker.js'
import type { CompileLogEntry } from './compile-worker.js'

export { createRebuildScheduler } from './rebuild-scheduler.js'
export type { RebuildScheduler } from './rebuild-scheduler.js'
export { filterDmccLogLine } from './compile-log.js'
export { createCompileWorker } from './compile-worker.js'
export type { CompileLogEntry, CompileWorker } from './compile-worker.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// esbuild's native binary is shipped inside node_modules, but when packaged
// via electron-builder it lives in app.asar. asarUnpack puts the real binary
// in app.asar.unpacked — but esbuild computes its binary path from __dirname,
// which still points inside app.asar. Redirect it explicitly via require.resolve
// so we don't hard-code the hoisting depth (pnpm vs npm layouts differ).
if (!process.env.ESBUILD_BINARY_PATH && __dirname.includes('app.asar')) {
	const platform = `${process.platform}-${process.arch}`
	try {
		const resolved = require.resolve(`@esbuild/${platform}/bin/esbuild`)
		process.env.ESBUILD_BINARY_PATH = resolved.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
	}
	catch {
		// fall through — esbuild will surface a clearer error if the binary is truly missing
	}
}

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
}) => Promise<{ server: Server; reload: () => void }>

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
	onRebuild?: () => void
	onBuildError?: (err: unknown) => void
	/**
	 * Per-line dmcc compile log, already filtered through `filterDmccLogLine`
	 * (noise stripped, signal kept). Lines come from the forked compile
	 * worker's piped stdout/stderr, tagged with their source stream.
	 */
	onLog?: (entry: CompileLogEntry) => void
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
		onRebuild,
		onBuildError,
		onLog,
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
	// `onLog` line-by-line after `filterDmccLogLine`).
	const compileWorker = createCompileWorker({ onLog })
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
		await compileWorker.close()
		throw err
	}
	// When the compiler is racing (e.g. opening a project that was just
	// closed elsewhere in the same Electron process) `build()` can return
	// null even though the manifest on disk is perfectly readable. The
	// fallback to `{ appId: 'unknown' }` is load-bearing for
	// any consumer that calls `wx.setStorageSync` — the dimina runtime
	// stores values under `${appId}_${key}` and the devtools storage panel
	// also derives its IPC prefix from `appInfo.appId`. A stale `unknown`
	// appId makes the panel and the runtime disagree (panel writes
	// `unknown_foo`, runtime reads `${realAppId}_foo`), so this falls back
	// to the canonical id from `project.config.json` instead. The literal
	// `'unknown'` is only used as a last resort when the manifest itself
	// is missing/unreadable, preserving the original error path.
	if (!initialAppInfo) {
		try {
			const configRaw = fs.readFileSync(path.join(projectPath, 'project.config.json'), 'utf8')
			const config = JSON.parse(configRaw) as { appid?: string; projectname?: string }
			if (config.appid && typeof config.appid === 'string' && config.appid.length > 0) {
				initialAppInfo = {
					appId: config.appid,
					name: config.projectname ?? path.basename(projectPath),
					path: projectPath,
				}
			}
		}
		catch {
			// best-effort — fall through to the 'unknown' fallback below
		}
	}
	const sessionApps: AppInfo[] = initialAppInfo ? [initialAppInfo] : []

	// Everything after the worker exists is failure-cleaned: if the dev server
	// or the watcher fails to come up, the already-forked compile worker (and a
	// server that already started listening) must be torn down before the error
	// propagates — otherwise every failed open leaks a whole compiler process.
	let server: Server | null = null
	let reload: (() => void) | undefined
	let watcher: { close: () => Promise<void>; ready: Promise<void> } | null = null

	async function rebuild(): Promise<void> {
		try {
			const rebuilt = (await compileWorker.build(buildRequest)) as AppInfo | null
			if (rebuilt) {
				const idx = sessionApps.findIndex(a => a.appId === rebuilt.appId)
				if (idx === -1) sessionApps.push(rebuilt)
				else sessionApps[idx] = rebuilt
			}
			reload?.()
			onRebuild?.()
		}
		catch (e) {
			onBuildError?.(e)
		}
	}

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

		// Watcher events are routed through the scheduler so a save landing while
		// a build is in flight is never dropped: it coalesces into exactly one
		// trailing rebuild once the current run settles.
		const rebuildScheduler = createRebuildScheduler(rebuild)
		watcher = watch ? createProjectWatcher(projectPath, () => rebuildScheduler.schedule()) : null
		// Don't resolve until the watcher's initial scan is done: a save landing
		// in the gap between `openProject` resolving and chokidar going live
		// (fsevents stream not yet active on macOS) would otherwise be silently
		// missed — no rebuild for the very first post-open edit. The promise
		// also REJECTS on a pre-ready watcher 'error' (EMFILE, permission loss)
		// so a broken watcher fails the open instead of hanging it forever.
		await watcher?.ready
	}
	catch (err) {
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
			// actually dead — only kill, never re-fork on a graceful close (a
			// refill here would wedge process teardown).
			await compileWorker.close()
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
	onChange: () => void | Promise<void>,
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
			return rel.split('/').some(seg => seg.startsWith('.'))
		},
		persistent: true,
		ignoreInitial: true,
	})
	// Listen to add + change + unlink so creating, editing, and deleting a
	// source file all surface as onChange. Listening only to 'change' silently
	// dropped the "developer added a new page" case (a chokidar 'add' event)
	// and made auto-compile feel broken on a common save pattern.
	watcher.on('add', () => { void onChange() })
	watcher.on('change', () => { void onChange() })
	watcher.on('unlink', () => { void onChange() })
	// A watcher 'error' before the initial scan completes (EMFILE, permission
	// loss, …) must REJECT `ready`: resolving only on 'ready' would leave
	// `await watcher.ready` — and the whole openProject — hung forever. The
	// listener also doubles as the EventEmitter unhandled-'error' guard. A
	// post-ready 'error' makes the reject a settled-promise no-op.
	const ready = new Promise<void>((resolve, reject) => {
		watcher.once('ready', () => resolve())
		watcher.on('error', (err: unknown) => {
			reject(err instanceof Error ? err : new Error(String(err)))
		})
	})
	return {
		close: () => watcher.close(),
		ready,
	}
}
