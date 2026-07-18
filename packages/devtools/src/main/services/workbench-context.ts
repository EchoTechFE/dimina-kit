import type { BrowserWindow } from 'electron'
import type { CompilationAdapter, CustomFileTypes, WorkbenchConfig } from '../../shared/types.js'
import type { BridgeRouterHandle } from '../ipc/bridge-router.js'
import type { ConsoleForwarder } from './console-forward/index.js'
import type { DiagnosticsBus } from './diagnostics/index.js'
import type { NetworkForwarder } from './network-forward/index.js'
import { createCdpSessionBroker, type CdpSessionBroker } from './cdp-session/index.js'
import type { AppDataTap } from './simulator-appdata/index.js'
import type { StorageApi } from './simulator-storage/index.js'
import type { SyncStorageChange } from '../../shared/ipc-channels.js'
import {
  createConnectionRegistry,
  DisposableRegistry,
  type ConnectionRegistry,
} from '@dimina-kit/electron-deck/main'
import type { SenderPolicy } from '../utils/ipc-registry.js'
import { createWorkbenchSenderPolicy } from '../utils/sender-policy.js'
import { defaultAdapter } from './default-adapter.js'
import {
  createRendererNotifier,
  type RendererNotifier,
} from './notifications/renderer-notifier.js'
import { createViewManager, type ViewManager } from './views/view-manager.js'
import { createWindowService, type WindowService } from './window-service.js'
import { openSettingsWindow } from '../windows/settings-window/index.js'
import {
  createWorkspaceService,
  type WorkspaceService,
} from './workspace/workspace-service.js'
import { createLocalProjectsProvider } from './projects/local-provider.js'
import {
  createSimulatorApiRegistry,
  type SimulatorApiRegistry,
} from './simulator/custom-apis.js'
import { resolveTemplates, sanitizeTemplates } from './projects/templates.js'
import { BUILTIN_TEMPLATES } from './projects/builtin-templates.js'
import type {
  ProjectsProvider,
  ProjectTemplate,
} from './projects/types.js'
import type { CustomCreateProjectDialogResult } from '../../shared/types.js'

/**
 * Shared mutable state for the workbench application.
 * Passed to each IPC module so they can read/write shared state without closures.
 */
export interface WorkbenchContext {
  adapter: CompilationAdapter
  /** Absolute path to the preload script loaded into the simulator webview */
  preloadPath: string
  /** Absolute path to the renderer dist directory */
  rendererDir: string

  /** Custom API namespace names (e.g. ['qd']) passed to the simulator */
  apiNamespaces: string[]

  /** Custom file types (e.g. .qdml/.qdss/.qds) forwarded to compilation and served to the editor via the COI `/__filetypes` endpoint. */
  fileTypes: CustomFileTypes

  /** Branding name shown in title bar and getBranding IPC */
  appName: string

  /** Host-injected provider for branding info (overrides default appName) */
  brandingProvider?: () => Promise<{ appName: string }> | { appName: string }

  /** Unified lifecycle manager for all overlay WebContentsViews */
  views: ViewManager

  /** Owns BrowserWindow instances (main + settings) and their sender-id checks. */
  windows: WindowService

  /** Unified main → renderer event dispatcher */
  notify: RendererNotifier

  /**
   * Open (or re-focus) the standalone workbench-settings window. First-class
   * member so contract holders (`MiniappRuntime` / `MenuContext`) can open
   * settings without reaching into `windows`/`notify` plumbing. Wired by
   * `createWorkbenchContext` to the real `openSettingsWindow` path.
   */
  openSettings: () => Promise<void>

  /** Single source of truth for project + session + per-project settings */
  workspace: WorkspaceService

  /**
   * Pluggable backend for the project list. Defaults to a LocalProjectsProvider
   * that persists to `<userData>/dimina-projects.json`. Hosts can inject a
   * custom implementation (e.g. read from a remote workspace).
   */
  projectsProvider: ProjectsProvider

  /**
   * Merged template catalog used by the create-project flow. Combines the
   * built-in templates with `WorkbenchAppConfig.projectTemplates` according
   * to `WorkbenchAppConfig.builtinTemplates`. Keeps any `generate`
   * functions intact — for IPC delivery, `sanitizeTemplates` is applied at
   * the IPC boundary.
   */
  projectTemplates: ProjectTemplate[]

  /**
   * Optional host hook for the "新建项目" dialog. When present, the
   * `projects:openCreateDialog` IPC returns whatever this hook resolves to;
   * when absent, the IPC returns null and the renderer shows the built-in
   * dialog.
   */
  customCreateProjectDialog?: (ctx: {
    parentWindow: BrowserWindow
    templates: ProjectTemplate[]
  }) => Promise<CustomCreateProjectDialogResult>

  /**
   * Host permission gate consulted by `workspace.openProject` BEFORE any side
   * effect. Throwing vetoes the open (see `WorkbenchAppConfig.onBeforeOpenProject`).
   * Wired from the config by `createDevtoolsRuntime`; undefined for the
   * single-tenant default.
   */
  onBeforeOpenProject?: (projectPath: string) => void | Promise<void>

  /**
   * Trust predicate consulted by `IpcRegistry` for every incoming IPC.
   * Resolves the currently-trusted senders (main renderer + overlays)
   * lazily so it stays correct as windows/views come and go.
   */
  senderPolicy: SenderPolicy

  /**
   * Reference-counted map of `webContents.id` → live registration count for
   * host-owned BrowserWindows registered as trusted senders via
   * `instance.registerTrustedWindow`. A window stays trusted while its count
   * is > 0; registering the same window N times requires N disposals (or a
   * single `closed` event, which zeroes the count outright) to un-trust it.
   * Consulted by `createWorkbenchSenderPolicy` in addition to the static
   * main-window / overlay checks.
   */
  trustedWindowSenderIds: Map<number, number>

  /**
   * Per-context registry of host-registered simulator custom APIs. Populated
   * via `instance.registerSimulatorApi`; read by the simulator IPC handlers.
   * One registry per context — no process-global crosstalk.
   */
  simulatorApis: SimulatorApiRegistry

  /** Aggregates dispose handlers for every IPC handler, listener, watcher, and CDP session registered by the workbench. */
  registry: DisposableRegistry

  /**
   * Per-webContents connection registry. Each trusted webContents (main window,
   * overlay views, native simulator/render guests) is one `Connection` that
   * owns the resources tied to its lifetime and tears them down deterministically
   * on `webContents.once('destroyed')` (hard) or `reset(id)` (soft pool reuse).
   * The substrate for connection-scoped resource ownership — see
   * packages/electron-deck/docs/foundation.md §4. Domain services consume it by
   * `own()`-ing their per-endpoint resources and observing `reset`/`closed`.
   */
  connections: ConnectionRegistry

  /**
   * Single owner of every render-guest `wc.debugger` (CDP) session: safe-area,
   * elements-forward, render-inspect and network-forward all `acquire()` a
   * lease from this instead of each hand-rolling their own attach/reuse/detach
   * bookkeeping (see cdp-session/index.ts's design doc for why that duplication
   * was a real bug, not just repetition).
   */
  cdpSessionBroker: CdpSessionBroker

  /**
   * Accessor over the bridge-router's private state, set by `installBridgeRouter`.
   * Lets other main services (simulator-storage, automation, appdata) resolve
   * live render/service WebContents and the native-host flag without owning
   * router state. Undefined until the bridge router is installed.
   */
  bridge?: BridgeRouterHandle

  /**
   * Native-host AppData tap, set by `setupSimulatorAppData` (app.ts) when
   * native-host is on. bridge-router feeds it the service→render setData stream
   * + page evictions so the AppData panel can be sourced from main. Undefined on
   * the default dimina-fe path (which sniffs setData via a Worker hook).
   */
  appData?: AppDataTap

  /**
   * Native-host async-storage runtime hook, set by `setupSimulatorStorage` when
   * native-host is on. bridge-router routes async `wx.setStorage`/etc. here so
   * they hit the same service-host `file://` store as the sync APIs (one origin).
   * Undefined on the default dimina-fe path (storage handled in the guest).
   */
  storageApi?: StorageApi

  /**
   * Native-host SYNC-storage liveness hook, set by `setupSimulatorStorage`.
   * bridge-router calls it on each `storageChanged` container message the
   * service-host posts after a `setStorageSync`/`removeStorageSync`/
   * `clearStorageSync` (those write `localStorage` directly, bypassing main), so
   * the Storage panel updates without a manual reload. Undefined on the default
   * dimina-fe path (the CDP DOMStorage watcher covers the simulator origin there).
   */
  onServiceStorageChanged?: (appId: string, change: SyncStorageChange) => void

  /**
   * Native-host console sink. Render-layer entries arrive from
   * render-host/preload.cjs (`console.*` monkeypatch → `consoleLog` message);
   * service-layer entries arrive from CDP `Runtime.consoleAPICalled`
   * (services/service-console) so native source attribution is preserved.
   * Owned by the `ConsoleForwarder` (set in `installBridgeRouter`), whose `emit`
   * fans every entry out to subscribers (automation WS) AND mirrors render-layer
   * entries into the service host's own console for the embedded DevTools.
   */
  guestConsole?: { emit(entry: unknown): void }

  /**
   * Always-on console fan-out, set by `installBridgeRouter`. Other services
   * (automation) call `subscribe` to receive every guest console entry instead
   * of each clobbering `ctx.guestConsole`. Undefined until the bridge router is
   * installed.
   */
  consoleForwarder?: ConsoleForwarder

  /**
   * Authoritative diagnostics bus for main-synthesized developer diagnostics
   * (page-not-found, logic-bundle-unreachable, service-host-navigation-failed,
   * …), set by `installBridgeRouter`. `consoleForwarder` subscribes to it so
   * every diagnostic also surfaces in the owning session's embedded DevTools
   * Console panel, not just the main-process log. Undefined until the bridge
   * router is installed.
   */
  diagnostics?: DiagnosticsBus

  /**
   * Native-host network forwarder, set in app bootstrap. Attaches the CDP
   * debugger to the simulator WCV (where `wx.request`/`downloadFile`/`uploadFile`
   * run) and injects its raw Network.* CDP events into the DevTools FRONT-END wc
   * (`window.DevToolsAPI.dispatchMessage`) so the native Network tab renders them;
   * falls back to a `[网络]` service-host console line when the front-end is
   * unavailable. The ViewManager calls the forwarder's own `attachSimulator` +
   * `setDevtoolsHost` from `attachNativeSimulator` once the simulator WCV +
   * DevTools host exist. Undefined until bootstrap wires it.
   */
  networkForward?: NetworkForwarder
}

/**
 * Inputs for `createWorkbenchContext`. The scalar config fields it shares with
 * `WorkbenchConfig` (`adapter` / `apiNamespaces` / `appName`)
 * are derived from there via `Pick` so the two stay in lockstep — no
 * field-by-field re-declaration. The remaining fields are kept explicit
 * because their shapes intentionally differ from the config:
 *  - `preloadPath` / `rendererDir` are REQUIRED here (the caller resolves the
 *    defaults before constructing the context) but optional in the config;
 *  - `projectsProvider` / `projectTemplates` / `customCreateProjectDialog` use
 *    the main-process types, not the structural mirrors in `shared/types`.
 */
export interface CreateContextOptions
  extends Pick<WorkbenchConfig, 'adapter' | 'apiNamespaces' | 'appName' | 'fileTypes'> {
  mainWindow: BrowserWindow
  preloadPath: string
  rendererDir: string
  brandingProvider?: WorkbenchContext['brandingProvider']
  /** Host-supplied project list backend. Defaults to LocalProjectsProvider. */
  projectsProvider?: ProjectsProvider
  /** Templates injected by the host; same-id overrides a built-in. */
  projectTemplates?: ProjectTemplate[]
  /** Built-in template policy (default 'all'). */
  builtinTemplates?: 'all' | 'none' | readonly string[]
  /** Host-supplied "新建项目" dialog hook. */
  customCreateProjectDialog?: WorkbenchContext['customCreateProjectDialog']
  /** Host permission gate run before a project opens (throw to veto). */
  onBeforeOpenProject?: WorkbenchContext['onBeforeOpenProject']
}

export function createWorkbenchContext(opts: CreateContextOptions): WorkbenchContext {
  const ctx = {
    adapter: opts.adapter ?? defaultAdapter,
    preloadPath: opts.preloadPath,
    rendererDir: opts.rendererDir,
    apiNamespaces: opts.apiNamespaces ?? [],
    fileTypes: opts.fileTypes ?? {},
    appName: opts.appName ?? 'Dimina DevTools',
    brandingProvider: opts.brandingProvider,
  } as WorkbenchContext

  ctx.registry = new DisposableRegistry()
  // Empty connection registry as a first-class context field. Connections are
  // acquired by real wiring points (app bootstrap, view-manager endpoints),
  // NOT here — the constructor stays side-effect-free so focused unit tests can
  // build a context with a minimal mainWindow fake.
  ctx.connections = createConnectionRegistry()
  ctx.cdpSessionBroker = createCdpSessionBroker({ connections: ctx.connections })
  ctx.registry.add(() => ctx.cdpSessionBroker.dispose())
  ctx.trustedWindowSenderIds = new Map<number, number>()
  ctx.simulatorApis = createSimulatorApiRegistry()
  ctx.windows = createWindowService(opts.mainWindow)
  ctx.views = createViewManager(ctx)
  // Full view teardown belongs to the CONTEXT's life, not a project's:
  // closeProject only disposes project-scoped views, so this registration is
  // the one place that releases the HOST-scoped toolbar (its view and the
  // ref-counted session-runtime preload) when the app/context winds down.
  ctx.registry.add(() => ctx.views.disposeAll())
  ctx.notify = createRendererNotifier(ctx)
  // Lazy closure (not a bound snapshot): reads ctx.windows/notify/rendererDir
  // at call time through the live context, which structurally satisfies the
  // helper's narrow OpenSettingsWindowDeps.
  ctx.openSettings = () => openSettingsWindow(ctx)
  ctx.projectsProvider = opts.projectsProvider ?? createLocalProjectsProvider()
  ctx.projectTemplates = resolveTemplates(
    BUILTIN_TEMPLATES,
    opts.projectTemplates ?? [],
    opts.builtinTemplates ?? 'all',
  )
  ctx.customCreateProjectDialog = opts.customCreateProjectDialog
  ctx.onBeforeOpenProject = opts.onBeforeOpenProject
  ctx.workspace = createWorkspaceService(ctx)
  ctx.senderPolicy = createWorkbenchSenderPolicy(ctx)
  return ctx
}

// Re-export at this stable module path so callers don't have to know about
// the projects/ subtree layout.
export { sanitizeTemplates }
