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

/**
 * Shared mutable state for the workbench application.
 * Passed to each IPC module so they can read/write shared state without closures.
 */
export interface WorkbenchContext {
  /** @deprecated use ctx.windows.mainWindow */
  mainWindow: BrowserWindow
  adapter: CompilationAdapter
  /** Absolute path to the preload script loaded into the simulator webview */
  preloadPath: string
  /** Absolute path to the renderer dist directory */
  rendererDir: string

  // ── View state (managed exclusively by ViewManager) ──
  /** @deprecated use ctx.windows.settingsWindow / setSettingsWindow / closeSettingsWindow */
  workbenchSettingsWindow: BrowserWindow | null

  /** Built-in panel IDs to display (default: all) */
  panels: string[]

  /** Custom API namespace names (e.g. ['qd']) passed to the simulator */
  apiNamespaces: string[]

  /** Branding name shown in title bar and getBranding IPC */
  appName: string

  /** Host-injected provider for toolbar actions (overrides default empty list) */
  toolbarActions?: () => Promise<Array<{ id: string; label: string }>> | Array<{ id: string; label: string }>

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
   * Trust predicate consulted by `IpcRegistry` for every incoming IPC.
   * Resolves the currently-trusted senders (main renderer + overlays)
   * lazily so it stays correct as windows/views come and go.
   */
  senderPolicy: SenderPolicy

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
  toolbarActions?: WorkbenchContext['toolbarActions']
  brandingProvider?: WorkbenchContext['brandingProvider']
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
    mainWindow: opts.mainWindow,
    adapter: opts.adapter ?? defaultAdapter,
    preloadPath: opts.preloadPath,
    rendererDir: opts.rendererDir,
    panels: opts.panels ?? ['wxml', 'console', 'appdata', 'storage'],
    apiNamespaces: opts.apiNamespaces ?? [],
    appName: opts.appName ?? 'Dimina DevTools',
    toolbarActions: opts.toolbarActions,
    brandingProvider: opts.brandingProvider,

    workbenchSettingsWindow: null,
  } as WorkbenchContext

  ctx.registry = new DisposableRegistry()
  ctx.windows = createWindowService(ctx.mainWindow)
  ctx.views = createViewManager(ctx)
  ctx.notify = createRendererNotifier(ctx)
  ctx.workspace = createWorkspaceService(ctx)
  ctx.senderPolicy = createWorkbenchSenderPolicy(ctx)
  return ctx
}
