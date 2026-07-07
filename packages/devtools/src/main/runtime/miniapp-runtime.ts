/**
 * MiniappRuntime — the stable, host-facing contract surface documented in
 * host-migration.md's public-contract section.
 *
 * HAND-WRITTEN, not derived from `WorkbenchContext`. A `Pick`-style projection
 * would drag every nested internal service type (ViewManager,
 * BridgeRouterHandle, SimulatorApiRegistry, Electron WebContents…) onto the
 * public semver face, so any internal refactor of those services becomes an
 * unreviewed breaking change for downstream hosts. Instead this module
 * names ONLY the audited downstream consumption surface, with structural DTOs
 * and zero Electron types — non-Electron consumers can compile against it.
 *
 * Contract rules:
 *  - Members are FUNCTION-VALUED PROPERTIES (`m: (x) => r`), never method
 *    syntax: under strictFunctionTypes method signatures compare bivariantly,
 *    which would let a wrongly-narrowed implementation or host override slip
 *    past the drift sentinel.
 *  - `workspace.openProject` stays writable (no `readonly`) for backward
 *    compat: hosts MAY still gate permissions by reassigning it. The preferred
 *    path is now the declarative `WorkbenchAppConfig.onBeforeOpenProject` hook
 *    (runs before any side effect, throw to veto) — see host-migration.md's
 *    `onBeforeOpenProject` hook section.
 *
 * `asMiniappRuntime(ctx)` is an identity return — the contract is a typed
 * VIEW onto the live context, not a snapshot/projection. That is what makes
 * the monkey-patch contract work (a copied projection would receive the patch
 * on a dead object), and its `return ctx` doubles as the assignment-compat
 * sentinel: if an internal service drifts away from the contract, compilation
 * breaks HERE, in this package's CI — not in a downstream host's upgrade.
 */
// eslint-disable-next-line no-restricted-syntax -- grandfathered(workbench-context): shrink-only
import type { WorkbenchContext } from '../services/workbench-context.js'

/** Compile-status payload broadcast to hosts via `notify.projectStatus`. */
export interface MiniappProjectStatusPayload {
  status: string
  message: string
  /** True when the status update is emitted by the file-watcher rebuild loop. */
  hotReload?: boolean
}

/**
 * Structured shape of `getSession().appInfo` — the doc-promised
 * (`host-migration.md` "appInfo 已结构化") DTO, named so hosts can type what
 * they receive without deep imports or casts.
 *
 * `appId` is REQUIRED: the renderer derives its IPC scoping from it and the
 * default devkit adapter always supplies one (fallback included). A custom
 * adapter that returns a session without a string `appId` is rejected at the
 * `openProject` boundary (see workspace-service.ts) — it never becomes the
 * active session. The decorative rest stays optional: `name`/`path` come from
 * the devkit adapter, `appName` from the devtools-side mirror; minimal custom
 * adapters may omit all three.
 */
export interface MiniappSessionAppInfo {
  appId: string
  name?: string
  path?: string
  appName?: string
}

/**
 * The page-side bridge the framework injects into the host-toolbar WCV as
 * `window.diminaHostToolbar` (see src/preload/runtime/host-toolbar-port.ts).
 * Declared here (the electron-free contract module) so TypeScript toolbar
 * pages can type the bridge without hand-rolling — and without importing
 * anything Electron-flavored.
 *
 * Shape mirrors the injected bridge EXACTLY:
 *  - `send` returns void (pre-handshake sends are queued, bounded at 128);
 *  - `onMessage` returns a BARE un-subscribe function — unlike the main-side
 *    control's `{ dispose }` — because that is what the preload exposes.
 * Both throw a `TypeError` synchronously when `channel` is not a non-empty
 * string (parity with the main side's `onMessage` guard).
 */
export interface DiminaHostToolbarPageBridge {
  send: (channel: string, payload: unknown) => void
  onMessage: (channel: string, handler: (payload: unknown) => void) => () => void
}

declare global {
  interface Window {
    /**
     * Present ONLY inside the host-toolbar WebContentsView's main frame
     * (guarded injection — see host-toolbar-runtime.ts); optional everywhere
     * else, so page code must runtime-guard before use.
     */
    diminaHostToolbar?: DiminaHostToolbarPageBridge
  }
}

/**
 * Host-facing control surface for the toolbar WebContentsView — a
 * message-channel surface (`send`/`onMessage`), with no `webContents` escape
 * hatch (that would put Electron types on the contract).
 */
export interface MiniappHostToolbar {
  /**
   * The host's own `webPreferences.preload` for the toolbar view (purely
   * additive — never replaces the framework's session-resident height
   * advertiser). Must be set before the view is (re)created; `null` (default)
   * means "no host preload".
   */
  setPreloadPath: (path: string | null) => void
  /** Load a local file into the toolbar view (lazy-creates the view). */
  loadFile: (path: string) => Promise<void>
  /** Load a URL into the toolbar view (lazy-creates the view). */
  loadURL: (url: string) => Promise<void>
  /**
   * Post `{ channel, payload }` to the toolbar page. Gated and non-queueing:
   * returns false (delivering nothing, creating no view) while there is no
   * live toolbar webContents or the current load's MessagePort handshake
   * hasn't completed; true once the envelope went out.
   */
  send: (channel: string, payload: unknown) => boolean
  /**
   * Register a host-side handler for messages the toolbar page sends via
   * `window.diminaHostToolbar.send(channel, payload)`. May be called before
   * the view exists; survives page reloads. `dispose()` detaches (idempotent).
   */
  onMessage: (
    channel: string,
    handler: (payload: unknown) => void,
  ) => { dispose: () => void }
  /**
   * Observe handshake readiness. Fires the handler once per load generation,
   * exactly when the toolbar page's MessagePort handshake completes (i.e.
   * when `send` flips to true). Registering while the channel is already
   * ready fires once asynchronously on a microtask (missed-signal guard);
   * a reload / re-handshake fires registered handlers again. `dispose()`
   * detaches (idempotent).
   */
  onReady: (handler: () => void) => { dispose: () => void }
  /**
   * Pin (`{ fixed }`) or unpin (`'auto'`) the toolbar strip height. `'auto'`
   * (default) lets the in-page height advertiser drive the placeholder.
   * `{ fixed }` values must be finite and non-negative — anything else throws
   * a `TypeError` synchronously and leaves the standing mode untouched.
   */
  setHeightMode: (mode: 'auto' | { fixed: number }) => void
}

/**
 * The audited workspace surface: project list membership, session lifecycle,
 * and minimal session state. Thumbnails / per-project settings / providers
 * stay internal.
 */
export interface MiniappWorkspace {
  /** True while a project session is open. */
  hasActiveSession: () => boolean
  /** Absolute path of the open project, or '' when none. */
  getProjectPath: () => string
  /**
   * Open (compile + start) a project session. WRITABLE BY CONTRACT: hosts may
   * reassign this member to wrap it (e.g. a permission gate) — every internal
   * caller routes through the live property, so the wrapper always intercepts.
   */
  openProject: (projectPath: string) => Promise<{ success: boolean; error?: string }>
  /** Tear down the active session (no-op when none). */
  closeProject: () => Promise<void>
  /** True when the directory is already in the project list. */
  hasProject: (dirPath: string) => Promise<boolean>
  /** Add a directory to the project list. */
  addProject: (dirPath: string) => Promise<unknown>
  /**
   * Minimal live-session DTO, or null when no session. Deliberately excludes
   * the session's own `close` — hosts end sessions via `closeProject`, never
   * behind the workspace's back. `appInfo` is structured (see
   * {@link MiniappSessionAppInfo}) — no casting required.
   */
  getSession: () => { appInfo: MiniappSessionAppInfo } | null
}

/**
 * The stable miniapp-kernel surface a downstream host consumes.
 * Compiler-enforced and versionable: widening it back toward internal
 * plumbing is a deliberate semver decision, not an accident of projection.
 */
export interface MiniappRuntime {
  /** View layer — only the host-owned toolbar control is public. */
  views: { readonly hostToolbar: MiniappHostToolbar }
  /** Project + session workspace (see {@link MiniappWorkspace}). */
  workspace: MiniappWorkspace
  /** Main → renderer notifier — only the compile-status broadcast is public. */
  notify: { projectStatus: (payload: MiniappProjectStatusPayload) => void }
  /**
   * Lifecycle sink: hosts register their own teardown via `registry.add`.
   * Accepts BOTH disposal idioms — a `{ dispose }` object (what
   * `hostToolbar.onMessage`/`onReady` return) or a bare `() => void` —
   * matching the live registry, so `registry.add(sub)` works without the
   * `registry.add(() => sub.dispose())` wrapper.
   */
  registry: { add: (d: { dispose: () => void } | (() => void)) => void }
  /**
   * Open (or re-focus) the standalone workbench-settings window. Replaces the
   * retired `windows` opaque pass-through (whose only documented purpose —
   * `openSettingsWindow(ctx)` — could never typecheck from the contract) and
   * the `rendererDir` member that existed solely to feed it; hosts needing
   * the renderer dist path use the `/paths` export instead.
   */
  openSettings: () => Promise<void>
}

/**
 * View a full `WorkbenchContext` as its `MiniappRuntime` contract. Identity
 * return: the result IS the live context, typed down to the contract, so host
 * monkey-patches (e.g. `runtime.workspace.openProject = gated`) land on the
 * real object. The `return ctx` is also the compile-time drift sentinel — if
 * `WorkbenchContext` ever stops structurally satisfying the contract, THIS
 * stops compiling.
 */
export function asMiniappRuntime(ctx: WorkbenchContext): MiniappRuntime {
  return ctx
}
