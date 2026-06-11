import type { OpenProjectOptions } from '@dimina-kit/devkit'
import type { SimulatorApiHandler } from '../main/services/simulator/custom-apis.js'
import type { WorkbenchContext } from '../main/services/workbench-context.js'

/**
 * The narrowed view of `WorkbenchContext` handed to a host `menuBuilder`.
 * Strips the internal pipeline fields (`registry`, `senderPolicy`,
 * `trustedWindowSenderIds`, `simulatorApis`) so a menu builder can
 * read menu-relevant state (workspace, views, windows, notify, appName, …)
 * without reaching into devtools-internal plumbing.
 */
export type MenuContext = Omit<
  WorkbenchContext,
  'registry' | 'senderPolicy' | 'trustedWindowSenderIds' | 'simulatorApis'
>

export interface AppInfo {
  appName?: string
  [key: string]: unknown
}

export interface ProjectSession {
  close: () => Promise<void>
  port: number
  appInfo: AppInfo | unknown
}

export interface CompilationAdapter {
  openProject(opts: Omit<OpenProjectOptions, 'containerDir' | 'outputDir'>): Promise<ProjectSession>
}

export type BuiltinPanelId = 'wxml' | 'console' | 'appdata' | 'storage'
export type BuiltinModuleId = 'projects' | 'session' | 'simulator' | 'popover' | 'settings'

export interface WorkbenchConfig {
  /** Window title, default 'Dimina DevTools' */
  appName?: string
  /** Compilation adapter */
  adapter?: CompilationAdapter
  /**
   * @deprecated Ignored at runtime. The workbench UI always renders all four
   * built-in panels (WXML / Console / AppData / Storage); the config no longer
   * filters them and never lands on the context. Kept only so existing hosts
   * passing it keep compiling.
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
}

export interface ProjectTemplate {
  id: string
  name: string
  description?: string
  icon?: string
  source?: { type: 'directory'; path: string }
  generate?: (target: string, opts: { name: string }) => Promise<void>
}

export interface CreateProjectInput {
  name: string
  path: string
  templateId?: string
  extra?: Record<string, unknown>
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
