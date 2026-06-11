/**
 * MiniappRuntime — the stable, host-facing contract surface (foundation.md §3
 * "MiniappRuntime 契约" layer).
 *
 * HAND-WRITTEN, not derived from `WorkbenchContext`. A `Pick`-style projection
 * would drag every nested internal service type (ViewManager,
 * BridgeRouterHandle, SimulatorApiRegistry, Electron WebContents…) onto the
 * public semver face, so any internal refactor of those services becomes an
 * unreviewed breaking change for downstream hosts (qdmp). Instead this module
 * names ONLY the audited downstream consumption surface, with structural DTOs
 * and zero Electron types — non-Electron consumers can compile against it.
 *
 * Contract rules:
 *  - Members are FUNCTION-VALUED PROPERTIES (`m: (x) => r`), never method
 *    syntax: under strictFunctionTypes method signatures compare bivariantly,
 *    which would let a wrongly-narrowed implementation or host override slip
 *    past the drift sentinel.
 *  - `workspace.openProject` stays writable (no `readonly`): qdmp gates
 *    project permissions by reassigning it (documented monkey-patch contract).
 *  - `windows` is an OPAQUE handle (`object`): hosts pass it through to
 *    framework helpers but never reach into it (no BrowserWindow leak).
 *
 * `asMiniappRuntime(ctx)` is an identity return — the contract is a typed
 * VIEW onto the live context, not a snapshot/projection. That is what makes
 * the monkey-patch contract work (a copied projection would receive the patch
 * on a dead object), and its `return ctx` doubles as the assignment-compat
 * sentinel: if an internal service drifts away from the contract, compilation
 * breaks HERE, in this package's CI — not in a downstream host's upgrade.
 */
import type { WorkbenchContext } from '../services/workbench-context.js'

/** Compile-status payload broadcast to hosts via `notify.projectStatus`. */
export interface MiniappProjectStatusPayload {
  status: string
  message: string
  /** True when the status update is emitted by the file-watcher rebuild loop. */
  hotReload?: boolean
}

/**
 * Host-facing control surface for the toolbar WebContentsView — the exact
 * post-R2 message-channel surface (`send`/`onMessage`), with no `webContents`
 * escape hatch (that would put Electron types on the contract).
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
   * Pin (`{ fixed }`) or unpin (`'auto'`) the toolbar strip height. `'auto'`
   * (default) lets the in-page height advertiser drive the placeholder.
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
   * behind the workspace's back.
   */
  getSession: () => { appInfo: unknown } | null
}

/**
 * The stable miniapp-kernel surface a downstream host (qdmp) consumes.
 * Compiler-enforced and versionable: widening it back toward internal
 * plumbing is a deliberate semver decision, not an accident of projection.
 */
export interface MiniappRuntime {
  /** Absolute path to the devtools renderer dist directory. */
  rendererDir: string
  /** View layer — only the host-owned toolbar control is public. */
  views: { readonly hostToolbar: MiniappHostToolbar }
  /** Project + session workspace (see {@link MiniappWorkspace}). */
  workspace: MiniappWorkspace
  /** Main → renderer notifier — only the compile-status broadcast is public. */
  notify: { projectStatus: (payload: MiniappProjectStatusPayload) => void }
  /** Lifecycle sink: hosts register their own teardown via `registry.add`. */
  registry: { add: (dispose: () => void) => unknown }
  /**
   * Opaque window-service handle. Pass it through to framework helpers
   * (e.g. `openSettingsWindow`); it exposes nothing to reach into.
   */
  windows: object
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
