import type { OpenProjectOptions } from '@dimina-kit/devkit'
import type { SimulatorApiHandler } from '../main/services/simulator/custom-apis.js'
import type { MiniappSessionAppInfo } from '../main/runtime/miniapp-runtime.js'

/**
 * The HAND-WRITTEN narrow contract handed to a host `menuBuilder` — the
 * audited menu consumption surface only, same posture as `MiniappRuntime`.
 * NOT an `Omit<WorkbenchContext, …>` projection: a projection drags every
 * nested internal service type (adapter, windows → BrowserWindow, bridge,
 * connections, …) onto the host-facing menu surface, making internal
 * refactors unreviewed breaking changes for host menu builders.
 *
 * A full `WorkbenchContext` stays structurally assignable to this type, so
 * hosts (and the default-menu path) that pass the whole ctx through keep
 * compiling. Widening this surface is a deliberate semver decision.
 */
export interface MenuContext {
  /** Branding name shown in title bar / menu labels. */
  appName: string
  /** Narrow workspace set a menu legitimately drives. */
  workspace: {
    hasActiveSession: () => boolean
    getProjectPath: () => string
    openProject: (projectPath: string) => Promise<{ success: boolean; error?: string }>
    closeProject: () => Promise<void>
    getSession: () => { appInfo: MiniappSessionAppInfo } | null
  }
  /** Open (or re-focus) the standalone workbench-settings window. */
  openSettings: () => Promise<void>
  notify: {
    /** Broadcast compile-status transitions to the main renderer. */
    projectStatus: (payload: { status: string; message: string; hotReload?: boolean }) => void
    /** Ask the main renderer to navigate back to its landing screen (打开项目). */
    windowNavigateBack: () => void
  }
}

/**
 * Structured `session.appInfo` DTO — the producer contract a
 * `CompilationAdapter` must satisfy. Single definition: alias of the
 * host-facing {@link MiniappSessionAppInfo} (`appId` required; the rest
 * optional). `openProject` validates this shape at the adapter boundary and
 * rejects sessions without a string `appId`.
 */
export type AppInfo = MiniappSessionAppInfo

export interface ProjectSession {
  close: () => Promise<void>
  port: number
  appInfo: AppInfo
}

export interface CompilationAdapter {
  openProject(opts: Omit<OpenProjectOptions, 'containerDir' | 'outputDir'>): Promise<ProjectSession>
}

export type BuiltinPanelId = 'wxml' | 'console' | 'appdata' | 'storage'
export type BuiltinModuleId = 'projects' | 'session' | 'simulator' | 'popover' | 'settings'

/**
 * Custom mini-program file types. Same shape as the dmcc compiler's
 * `build()` `options.fileTypes`: brand extensions appended on top of the
 * built-in `wx*`/`dd*` families. In devtools this drives both the editor's
 * extension → Monaco-language mapping (template→wxml, style→css,
 * viewScript→javascript) and compilation — it is forwarded to the dmcc
 * compiler via `openProject({ fileTypes })`.
 */
export interface CustomFileTypes {
  template?: string[]
  style?: string[]
  viewScript?: string[]
}

export interface WorkbenchConfig {
  /** Window title, default 'Dimina DevTools' */
  appName?: string
  /** Custom file types (e.g. `.qdml`/`.qdss`/`.qds`) recognized by the editor. */
  fileTypes?: CustomFileTypes
  /** Compilation adapter */
  adapter?: CompilationAdapter
  /**
   * @deprecated Ignored at runtime. The config never filters the built-in
   * panels and never lands on the context; which panels are on screen is
   * governed solely by the persisted dock tree. A persisted tree missing part
   * of the built-in debug strip is healed back to the full set on restore
   * (`healMissingDebugPanels` in dock-layout.ts); the strip only disappears as
   * a whole via the toolbar region toggle. Kept only so existing hosts passing
   * it keep compiling.
   */
  panels?: BuiltinPanelId[]
  /** Absolute path to a custom preload script (overrides built-in simulator.js) */
  preloadPath?: string
  /** Custom API namespace names (e.g. ['qd']) passed to the simulator */
  apiNamespaces?: string[]
  /** Provider for branding info (overrides default appName) */
  brandingProvider?: () => Promise<{ appName: string }> | { appName: string }
  /**
   * @deprecated Ignored. The devtools toolbar header is fixed at 40px
   * (`HEADER_H` in `shared/constants`). Hosts that need their own toolbar
   * should use the host toolbar WCV instead. Kept only so existing hosts
   * passing it keep compiling; it has no runtime effect.
   */
  headerHeight?: number
}

export interface CompileConfig {
  startPage: string
  scene: number
  queryParams: { key: string; value: string }[]
}

/**
 * Named launch configuration — a saved compile config with an identity.
 * Users create these from the compile-mode popover to persist frequently
 * used start-page / scene / query-param combinations and switch between
 * them without recompilation.
 */
export interface LaunchConfig extends CompileConfig {
  id: string
  name: string
}

export interface IpcResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

export interface WorkbenchWindowConfig {
  width?: number
  height?: number
  minWidth?: number
  minHeight?: number
  /**
   * Auto-show the main window on `ready-to-show`. Defaults to `true`. Set
   * `false` when the host gates the window behind its own startup flow (e.g. a
   * login screen) and wants to reveal it itself once ready — avoids an
   * un-authed window flashing on screen.
   *
   * Visibility is governed by this flag in BOTH the test and non-test
   * environments; the environment only chooses HOW to show (non-test →
   * `show()`, test → `showInactive()` so e2e windows don't steal focus). When
   * `false`, the framework calls neither in either env — the host owns reveal,
   * test included.
   */
  autoShow?: boolean
}

// ── Update Checker ──────────────────────────────────────────────────────

export interface UpdateInfo {
  /** New version string (e.g. '1.2.0') */
  version: string
  /** URL to download the update package */
  downloadUrl: string
  /** Optional release notes / changelog */
  releaseNotes?: string
  /** If true, the user cannot dismiss the update prompt */
  mandatory?: boolean
}

export interface UpdateChecker {
  /** Check whether a newer version is available. Return null if up-to-date. */
  checkForUpdates(currentVersion: string): Promise<UpdateInfo | null>
  /** Download the update and return the local file path of the downloaded package. */
  downloadUpdate(info: UpdateInfo, onProgress?: (percent: number) => void): Promise<string>
}

/**
 * The instance passed to host hooks (menuBuilder, onSetup, onBeforeClose).
 * `context` is a WorkbenchContext — import it from '@dimina-kit/devtools/context' for full typing.
 */
export interface WorkbenchHostInstance {
  mainWindow: import('electron').BrowserWindow
  // eslint-disable-next-line no-restricted-syntax -- grandfathered(workbench-context): shrink-only
  context: import('../main/services/workbench-context.js').WorkbenchContext

  /**
   * Gated custom-IPC registration surface. Channels registered through this
   * `IpcRegistry` are bound to `context.senderPolicy` and torn down with the
   * context. This is the only supported path for host custom IPC.
   */
  readonly ipc: import('../main/utils/ipc-registry.js').IpcRegistry

  /**
   * Adds a host-owned BrowserWindow's renderer to the trusted-sender set so
   * its `instance.ipc` calls pass the gateway. The window is auto-evicted
   * when it closes; the returned Disposable evicts it explicitly and is also
   * registered into `context.registry` for context-scoped cleanup.
   */
  registerTrustedWindow(
    win: import('electron').BrowserWindow,
  ): import('@dimina-kit/electron-deck/main').Disposable

  /**
   * Registers a simulator custom API into THIS context's registry, callable
   * from mini-program code as `wx.<name>(params)`. The registration joins
   * `context.registry`, so it is released when the context is disposed.
   * The returned Disposable removes only the registration it created.
   */
  registerSimulatorApi(
    name: string,
    handler: SimulatorApiHandler,
  ): import('@dimina-kit/electron-deck/main').Disposable

  /**
   * Read all saved launch configs for the active project.
   * Returns an empty array when no project is open or no configs exist.
   */
  getLaunchConfigs(): Promise<LaunchConfig[]>

  /**
   * Persist the full list of launch configs for the active project.
   */
  setLaunchConfigs(configs: LaunchConfig[]): Promise<void>

  /**
   * Activate a named launch config (by id) or revert to normal mode (null).
   * Persists the selection and notifies the renderer to relaunch.
   */
  setActiveLaunchConfig(id: string | null): Promise<void>
}

/**
 * Pluggable backend for the project-list panel. Hosts may supply this to
 * take over project storage from the default `<userData>/dimina-projects.json`.
 *
 * Detailed contract lives in
 * `@dimina-kit/devtools/projects-provider` (the runtime exports it).
 * Repeated here as a structural type so `WorkbenchAppConfig` can reference
 * it without a circular import from the main-process tree.
 */
export interface ProjectsProvider {
  listProjects(): unknown[] | Promise<unknown[]>
  validateProjectDir?(dirPath: string): string | null
  addProject(dirPath: string): unknown
  removeProject(dirPath: string): void | Promise<void>
  updateLastOpened?(dirPath: string): void | Promise<void>
  getCompileConfig?(dirPath: string): unknown
  saveCompileConfig?(dirPath: string, cfg: unknown): void | Promise<void>

  getLaunchConfigs?(dirPath: string): unknown[] | Promise<unknown[]>
  saveLaunchConfigs?(dirPath: string, configs: unknown[]): void | Promise<void>
  getActiveLaunchConfigId?(dirPath: string): string | null | Promise<string | null>
  saveActiveLaunchConfigId?(dirPath: string, id: string | null): void | Promise<void>
}

/**
 * A template the user can pick from in the "新建项目" dialog. Exactly one of
 * `source` or `generate` should be supplied; if both are omitted, the
 * service refuses to materialise the template.
 */
export interface ProjectTemplate {
  /** Stable identifier. Used by host whitelists and the `templateId` field of CreateProjectInput. */
  id: string
  /** Human-readable label shown in the dialog. */
  name: string
  description?: string
  icon?: string
  /** Copy-tree source. `path` must be absolute. */
  source?: { type: 'directory'; path: string }
  /** Programmatic generator. `target` is the absolute destination directory. */
  generate?: (target: string, opts: { name: string }) => Promise<void>
}

/**
 * Payload returned from the create-project dialog. The service uses this to
 * scaffold disk content and to register the project with the provider.
 */
export interface CreateProjectInput {
  name: string
  path: string
  templateId?: string
  extra?: Record<string, unknown>
}

/**
 * Configuration for the embedded VS Code workbench editor — the sole devtools
 * editor. This config only fine-tunes where the workbench bundle and downstream
 * contributed extensions are served from; the editor is always on.
 */
export interface EditorViewConfig {
  /**
   * Absolute path to the built workbench bundle dir. Defaults to the
   * devtools-bundled `dist/vscode-workbench`. Override to ship a custom workbench.
   */
  bundleDir?: string
  /**
   * Downstream editor extensibility: absolute path to a directory of VS Code
   * **web** extensions (each a folder with a `package.json` whose `browser`/
   * `main` entry runs in the worker ext-host). The framework serves them through
   * the workbench's same-origin COI server and the workbench registers each at
   * boot, so a host (or qdmp) can contribute languages, commands, and views to
   * the editor without forking the bundle. Omit for none.
   */
  extensionsDir?: string
}

export interface WorkbenchAppConfig extends WorkbenchConfig {
  /** Absolute path to the renderer dist directory. Defaults to dimina-devtools' built-in renderer. */
  rendererDir?: string
  /** Enable or disable built-in IPC module groups. Defaults to all enabled. */
  modules?: Partial<Record<BuiltinModuleId, boolean>>
  /** Window sizing overrides for the main devtools window. */
  window?: WorkbenchWindowConfig
  /** Absolute path to a window/taskbar icon (png or ico). macOS uses the app bundle icon. */
  icon?: string
  /** Custom menu builder. Should call Menu.setApplicationMenu(). If omitted, the default dimina-devtools menu is installed. */
  menuBuilder?: (mainWindow: import('electron').BrowserWindow, menuContext: MenuContext) => void
  /** Called after window and context are created but before start() resolves. Use to register custom IPC handlers. */
  onSetup?: (instance: WorkbenchHostInstance) => void | Promise<void>
  /** Called before window close when a session is active. Session disposal happens automatically after this hook. */
  onBeforeClose?: (instance: WorkbenchHostInstance) => void | Promise<void>
  /**
   * Called before a project is opened, BEFORE any side effect (session
   * teardown, compile, dev-server). Use to gate the open on login/permission
   * state. THROW to veto: `openProject` then resolves `{ success: false,
   * error }`, leaves any currently-active session untouched, and never spins
   * up the adapter. Resolve normally (or omit) to allow the open. The
   * declarative alternative to monkey-patching `workspace.openProject`.
   *
   * On veto the framework surfaces the thrown error to the status bar
   * (`notify.projectStatus({ status: 'error', message })`), symmetric with its
   * own validateProjectDir rejection — the host need not reach for `notify`
   * just to report the denial; it may layer richer UX (e.g. a dialog) on top.
   */
  onBeforeOpenProject?: (projectPath: string) => void | Promise<void>
  /**
   * Fine-tune the embedded VS Code workbench editor (the sole devtools
   * editor). The 'editor' dock slot is always a main-process WebContentsView
   * hosting the workbench (full project-wide IntelliSense, wxml LSP, dd/wx
   * types); the framework starts the COI http server and bakes the
   * SharedArrayBuffer switch unconditionally. Provide this only to override the
   * bundle dir or contribute downstream extensions; omit for the defaults.
   */
  editorViewConfig?: EditorViewConfig
  /** Custom update checker. If provided, enables the check-for-updates feature. */
  updateChecker?: UpdateChecker
  /** Extra options applied when an updateChecker is provided. */
  updateOptions?: {
    /** Check interval in milliseconds. Default: 1 hour */
    checkInterval?: number
    /** Delay before the first check after startup in ms. Default: 5000 */
    initialDelay?: number
    /** Override the version string passed to the checker. Default: app.getVersion() */
    getCurrentVersion?: () => string
  }

  // ── Projects panel extension surface ──────────────────────────────────
  //
  // Three orthogonal extension points consumed by the create-project flow.
  // All three can be omitted for the single-tenant default behavior.

  /** Override the default `<userData>/dimina-projects.json` backend. */
  projectsProvider?: ProjectsProvider
  /** Templates injected at the head of the list; same-id overrides a built-in. */
  projectTemplates?: ProjectTemplate[]
  /** Built-in policy: 'all' (default), 'none', or an allowlist of ids. */
  builtinTemplates?: 'all' | 'none' | string[]
  /**
   * Host-supplied "新建项目" dialog. When provided, the renderer routes the
   * "+" card click through IPC into this main-process hook instead of
   * showing the built-in dialog. Receives the parent window for native
   * dialog parenting and the merged + sanitized template list (no
   * `generate` functions cross the IPC boundary).
   *
   * Return either:
   *  - `null` — user cancelled.
   *  - a `CreateProjectInput` — devtools runs its built-in scaffold
   *    (copy template → write project.config.json → provider.addProject)
   *    on the host's behalf.
   *  - `{ ready: Project }` — the host has ALREADY created the project
   *    (typically via its own backend). devtools skips the scaffold and
   *    just refreshes the list. Use this when materialization is remote
   *    or already done.
   */
  customCreateProjectDialog?: (ctx: {
    parentWindow: import('electron').BrowserWindow
    templates: ProjectTemplate[]
  }) => Promise<CustomCreateProjectDialogResult>
}

/**
 * Discriminated return of `customCreateProjectDialog`. `null` = cancelled.
 * `{ ready }` = host created the project itself; devtools just refreshes.
 * Otherwise treated as `CreateProjectInput` and devtools materializes the
 * template locally.
 *
 * The `ready.Project` shape is the structural minimum devtools needs to
 * render the card (mirrors `Project` in `./projects-provider`).
 */
export type CustomCreateProjectDialogResult =
  | null
  | {
      ready: {
        name: string
        path: string
        lastOpened?: string | null
      }
    }
  | CreateProjectInput
