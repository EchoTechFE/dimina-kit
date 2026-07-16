import path from 'node:path'
import type { AppInfo } from './index.js'
import type { BuildRequest, CompileWorker } from './compile-worker.js'

/** Insert or replace `rebuilt` in the session's app list, keyed by appId. */
export function upsertSessionApp(sessionApps: AppInfo[], rebuilt: AppInfo): void {
	const idx = sessionApps.findIndex(a => a.appId === rebuilt.appId)
	if (idx === -1) sessionApps.push(rebuilt)
	else sessionApps[idx] = rebuilt
}

/**
 * Stylesheet extensions whose recompile can hot-swap in place (no full reload):
 * the built-in `wx*`/`dd*` style dialects plus the CSS pre-processors dimina
 * feeds through. A rebuild touching ONLY these can swap each `<link>` instead of
 * reloading the page, because the compiled CSS scope id is a deterministic
 * `hash(path)` — the recompiled `.css` keeps the same `[data-v-<id>]` selectors,
 * so they still match the already-mounted DOM. Custom dialects (`.qdss`) are
 * added per-project via `fileTypes.style`.
 */
const DEFAULT_STYLE_EXTS = ['.wxss', '.ddss', '.css', '.less', '.scss', '.sass']

/**
 * True iff `changedPaths` is non-empty AND every path is a stylesheet — the
 * precondition for a style-only hot swap. Empty is false: "no known paths"
 * (e.g. a coalesced rebuild that lost its change list) must fall back to a full
 * reload rather than silently assume styles-only. `extraStyleExts` (from
 * `fileTypes.style`) is merged in; a leading dot is optional and matching is
 * case-insensitive.
 */
export function isStyleOnlyChange(changedPaths: string[], extraStyleExts: string[] = []): boolean {
	if (changedPaths.length === 0) return false
	const exts = new Set(
		[...DEFAULT_STYLE_EXTS, ...extraStyleExts.map(e => (e.startsWith('.') ? e : `.${e}`))]
			.map(e => e.toLowerCase()),
	)
	return changedPaths.every(p => exts.has(path.extname(p).toLowerCase()))
}

/**
 * Compose the "build completed" subscriber — the single place deciding which of
 * two INDEPENDENT reactions run: reflecting the rebuild in the preview, and the
 * caller's `onRebuild`. When `autoReload` is on and the rebuild touched ONLY
 * stylesheets (`isStyleOnlyChange`), it hot-swaps the stylesheets in place
 * (`getReloadStyles`) so the page stack / form state survives; otherwise it does
 * a full `getReload()` page reload. With `autoReload` off, neither is called
 * (auto-compile stays on, preview frozen). Both `getReload`/`getReloadStyles`
 * are read at call time because the dev server assigns them after this
 * subscriber is wired; `getReloadStyles` may be absent (older fe server) — then
 * even a style-only change falls back to a full reload.
 */
export function composeBuildCompleted(opts: {
	autoReload: boolean
	getReload: () => (() => void) | undefined
	getReloadStyles?: () => (() => void) | undefined
	styleExts?: string[]
	onRebuild?: (info?: { changedPaths: string[]; styleOnly: boolean }) => void
}): (changedPaths?: string[]) => void {
	return (changedPaths = []) => {
		const styleOnly = isStyleOnlyChange(changedPaths, opts.styleExts)
		if (opts.autoReload) {
			const reloadStyles = opts.getReloadStyles?.()
			if (reloadStyles && styleOnly) {
				reloadStyles()
			}
			else {
				opts.getReload()?.()
			}
		}
		// Hand the host the same style-only verdict the SSE dispatch used, so a
		// native host (devtools simulator — no SSE client) can pick its OWN fast
		// path (in-place stylesheet swap) instead of a full simulator respawn.
		opts.onRebuild?.({ changedPaths, styleOnly })
	}
}

/** Run one watcher-triggered rebuild, then fan out to the build-completed
 * subscriber (style hot-swap or full reload + onRebuild); a build failure routes
 * to onBuildFailed. `changedPaths` are the files that triggered THIS rebuild —
 * threaded so the subscriber can pick a style-only hot swap over a full reload. */
export async function runRebuild(
	compileWorker: CompileWorker,
	buildRequest: BuildRequest,
	sessionApps: AppInfo[],
	onBuildCompleted: (changedPaths: string[]) => void,
	onBuildFailed: (err: unknown) => void,
	changedPaths: string[] = [],
): Promise<void> {
	try {
		const rebuilt = (await compileWorker.build(buildRequest)) as AppInfo | null
		if (rebuilt) upsertSessionApp(sessionApps, rebuilt)
		onBuildCompleted(changedPaths)
	}
	catch (e) {
		onBuildFailed(e)
	}
}
