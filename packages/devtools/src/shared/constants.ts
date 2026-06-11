/** Shared cross-process constants for dimina-devtools. */

/** Default Chrome DevTools Protocol (CDP) remote debugging port. */
export const DEFAULT_CDP_PORT = 9222

/** Default scene value for mini-app launch. */
export const DEFAULT_SCENE = 1001

/**
 * Fixed devtools toolbar header height (px). Single source of truth shared by
 * the main process (overlay view layout) and the renderer (toolbar/popover
 * layout). Not host-configurable — the deprecated
 * `WorkbenchAppConfig.headerHeight` is ignored; hosts that need their own
 * toolbar use the host toolbar WCV instead.
 */
export const HEADER_H = 40

/**
 * Process-level argv marker injected (via `webPreferences.additionalArguments`)
 * into the host-toolbar WebContentsView. The session-registered toolbar-runtime
 * preload (`src/preload/runtime/host-toolbar-runtime.ts`) executes in EVERY
 * defaultSession renderer; its guard activates the height advertiser only when
 * `process.argv` carries this marker AND `process.isMainFrame` is true (the
 * marker is process-level, so subframes of the toolbar window see it too —
 * both guard wings are required; see .repro/wave3-spike/RESULTS.md items 3/4).
 */
export const HOST_TOOLBAR_RUNTIME_MARKER = '--dimina-host-toolbar'
