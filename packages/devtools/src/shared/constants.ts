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
 * both guard wings are required).
 */
export const HOST_TOOLBAR_RUNTIME_MARKER = '--dimina-host-toolbar'

/**
 * Same guard-marker contract as {@link HOST_TOOLBAR_RUNTIME_MARKER}, for the
 * host-sidebar WebContentsView (`src/preload/runtime/host-sidebar-runtime.ts`).
 */
export const HOST_SIDEBAR_RUNTIME_MARKER = '--dimina-host-sidebar'

/**
 * Same guard-marker contract as {@link HOST_TOOLBAR_RUNTIME_MARKER}, for the
 * host-dialog WebContentsView (`src/preload/runtime/host-dialog-runtime.ts`).
 */
export const HOST_DIALOG_RUNTIME_MARKER = '--dimina-host-dialog'

/**
 * Intrinsic width (px) of devtools' own default host-sidebar content (the
 * project-category icon rail). Single source of truth shared by the renderer
 * (`host-sidebar-default.tsx`, which gives its `[data-host-sidebar-root]` this
 * exact width so the width advertiser reports it) and anything in main that
 * needs to reason about the default rail's size. The slot is NOT left pinned
 * at this width: main pushes it once as a seed and immediately returns the
 * slot to 'auto' (see `createDevtoolsRuntime`), so the rail — and any
 * downstream `loadURL`/`loadFile` content that replaces it — advertises its
 * own width from then on, exactly like any other host-sidebar content.
 */
export const HOST_SIDEBAR_DEFAULT_WIDTH = 56
