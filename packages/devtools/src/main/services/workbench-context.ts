import type { BrowserWindow } from 'electron'
import type { CompilationAdapter } from '../../shared/types.js'
import { DisposableRegistry } from '../utils/disposable.js'
import type { SenderPolicy } from '../utils/ipc-registry.js'
import { createWorkbenchSenderPolicy } from '../utils/sender-policy.js'
import { defaultAdapter } from './default-adapter.js'
import {
  createRendererNotifier,
  type RendererNotifier,
} from './notifications/renderer-notifier.js'
import { createViewManager, type ViewManager } from './views/view-manager.js'
import { createWindowService, type WindowService } from './window-service.js'
import {
  createWorkspaceService,
  type WorkspaceService,
} from './workspace/workspace-service.js'
import { createLocalProjectsProvider } from './projects/local-provider.js'
import {
  createSimulatorApiRegistry,
  type SimulatorApiRegistry,
} from './simulator/custom-apis.js'
import { createToolbarStore, type ToolbarStore } from './toolbar/toolbar-store.js'
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

  /** Built-in panel IDs to display (default: all) */
  panels: string[]

  /** Custom API namespace names (e.g. ['qd']) passed to the simulator */
  apiNamespaces: string[]

  /** Branding name shown in title bar and getBranding IPC */
  appName: string

  /** Header bar height in px, used for view layout and exposed to the renderer */
  headerHeight: number

  /** Host-injected provider for branding info (overrides default appName) */
  brandingProvider?: () => Promise<{ appName: string }> | { appName: string }

  /** Unified lifecycle manager for all overlay WebContentsViews */
  views: ViewManager

  /** Owns BrowserWindow instances (main + settings) and their sender-id checks. */
  windows: WindowService

  /** Unified main → renderer event dispatcher */
  notify: RendererNotifier

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
   * Trust predicate consulted by `IpcRegistry` for every incoming IPC.
   * Resolves the currently-trusted senders (main renderer + overlays)
   * lazily so it stays correct as windows/views come and go.
   */
  senderPolicy: SenderPolicy

  /**
   * Mutable set of `webContents.id`s for host-owned BrowserWindows that have
   * been registered as trusted senders via `instance.registerTrustedWindow`.
   * Consulted by `createWorkbenchSenderPolicy` in addition to the static
   * main-window / overlay checks.
   */
  trustedWindowSenderIds: Set<number>

  /**
   * Per-context registry of host-registered simulator custom APIs. Populated
   * via `instance.registerSimulatorApi`; read by the simulator IPC handlers.
   * One registry per context — no process-global crosstalk.
   */
  simulatorApis: SimulatorApiRegistry

  /**
   * Per-context store of host-registered toolbar actions. Populated via
   * `instance.toolbar.set`; read by the toolbar IPC handlers. One store per
   * context — no process-global crosstalk.
   */
  toolbar: ToolbarStore

  /** Aggregates dispose handlers for every IPC handler, listener, watcher, and CDP session registered by the workbench. */
  registry: DisposableRegistry
}

export interface CreateContextOptions {
  mainWindow: BrowserWindow
  adapter?: CompilationAdapter
  preloadPath: string
  rendererDir: string
  panels?: string[]
  apiNamespaces?: string[]
  appName?: string
  /** Header bar height in px (default 40). */
  headerHeight?: number
  brandingProvider?: WorkbenchContext['brandingProvider']
  /** Host-supplied project list backend. Defaults to LocalProjectsProvider. */
  projectsProvider?: ProjectsProvider
  /** Templates injected by the host; same-id overrides a built-in. */
  projectTemplates?: ProjectTemplate[]
  /** Built-in template policy (default 'all'). */
  builtinTemplates?: 'all' | 'none' | readonly string[]
  /** Host-supplied "新建项目" dialog hook. */
  customCreateProjectDialog?: WorkbenchContext['customCreateProjectDialog']
}

export function hasBuiltinPanel(ctx: Pick<WorkbenchContext, 'panels'>, panelId: string): boolean {
  return ctx.panels.includes(panelId)
}

export function getDefaultTab(
  ctx: Pick<WorkbenchContext, 'panels'>,
): string {
  if (hasBuiltinPanel(ctx, 'console')) return 'simulator'
  if (ctx.panels.length > 0) return ctx.panels[0]!
  return 'simulator'
}

export function createWorkbenchContext(opts: CreateContextOptions): WorkbenchContext {
  const ctx = {
    adapter: opts.adapter ?? defaultAdapter,
    preloadPath: opts.preloadPath,
    rendererDir: opts.rendererDir,
    panels: opts.panels ?? ['wxml', 'console', 'appdata', 'storage'],
    apiNamespaces: opts.apiNamespaces ?? [],
    appName: opts.appName ?? 'Dimina DevTools',
    headerHeight: opts.headerHeight ?? 40,
    brandingProvider: opts.brandingProvider,
  } as WorkbenchContext

  ctx.registry = new DisposableRegistry()
  ctx.trustedWindowSenderIds = new Set<number>()
  ctx.simulatorApis = createSimulatorApiRegistry()
  ctx.toolbar = createToolbarStore()
  ctx.windows = createWindowService(opts.mainWindow)
  ctx.views = createViewManager(ctx)
  ctx.notify = createRendererNotifier(ctx)
  ctx.projectsProvider = opts.projectsProvider ?? createLocalProjectsProvider()
  ctx.projectTemplates = resolveTemplates(
    BUILTIN_TEMPLATES,
    opts.projectTemplates ?? [],
    opts.builtinTemplates ?? 'all',
  )
  ctx.customCreateProjectDialog = opts.customCreateProjectDialog
  ctx.workspace = createWorkspaceService(ctx)
  ctx.senderPolicy = createWorkbenchSenderPolicy(ctx)
  return ctx
}

// Re-export at this stable module path so callers don't have to know about
// the projects/ subtree layout.
export { sanitizeTemplates }
