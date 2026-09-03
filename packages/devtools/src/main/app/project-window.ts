import { BrowserWindow, nativeImage } from 'electron'
import path from 'path'
import type { WorkbenchAppConfig } from '../../shared/types.js'
import { defaultPreloadPath } from '../utils/paths.js'
import { createMainWindow } from '../windows/main-window/index.js'
// eslint-disable-next-line no-restricted-syntax -- grandfathered(workbench-context): shrink-only
import { createWorkbenchContext, type CreateContextOptions, type WorkbenchContext } from '../services/workbench-context.js'
import type { AppServices } from '../services/app-services.js'
import type { WindowContextRouter } from '../services/window-contexts/context-router.js'

/** The project a workbench window is opened for. */
export interface ProjectRef {
  path: string
  name?: string
}

/** A window and the context that answers IPC coming from it. */
export interface ProjectWindow {
  window: BrowserWindow
  context: WorkbenchContext
  dispose: () => Promise<void>
}

export interface CreateProjectWindowOptions {
  config: WorkbenchAppConfig
  rendererDir: string
  appServices: AppServices
  router: WindowContextRouter<WorkbenchContext>
}

function createConfiguredMainWindow(
  config: WorkbenchAppConfig,
  rendererDir: string,
  entry: string,
  title: string,
  query?: Record<string, string>,
): BrowserWindow {
  const mainWindow = createMainWindow({
    title,
    indexHtml: path.join(rendererDir, entry),
    query,
    width: config.window?.width,
    height: config.window?.height,
    minWidth: config.window?.minWidth,
    minHeight: config.window?.minHeight,
    autoShow: config.window?.autoShow,
  })

  // Set window/taskbar icon if provided (Linux/Windows; macOS uses app bundle icon)
  if (config.icon) {
    const icon = nativeImage.createFromPath(config.icon)
    if (!icon.isEmpty()) mainWindow.setIcon(icon)
  }

  return mainWindow
}

function createContext(
  config: WorkbenchAppConfig,
  mainWindow: BrowserWindow,
  rendererDir: string,
  appServices: AppServices,
): WorkbenchContext {
  return createWorkbenchContext({
    mainWindow,
    appServices,
    adapter: config.adapter,
    preloadPath: config.preloadPath ?? defaultPreloadPath,
    rendererDir,
    appName: config.appName,
    apiNamespaces: config.apiNamespaces,
    fileTypes: config.fileTypes,
    brandingProvider: config.brandingProvider,
    customCreateProjectDialog: config.customCreateProjectDialog as
      CreateContextOptions['customCreateProjectDialog'],
    // No cast needed here: the hook receives the project record, so the
    // main-process `Project` the context hands it satisfies the structural
    // `EditableProject` the config declares.
    customEditProjectDialog: config.customEditProjectDialog,
    onBeforeOpenProject: config.onBeforeOpenProject,
  })
}

export async function disposeContext(ctx: WorkbenchContext): Promise<void> {
  await ctx.workspace.closeProject()
  await ctx.registry.dispose().catch((err) => {
    console.warn('[workbench] dispose registry encountered errors:', err)
  })
}

/**
 * Build a window together with the context that owns it, and publish that
 * context to the router so IPC arriving from this window is answered by it.
 *
 * The router registration is parked on the context's own registry: a window
 * that is torn down must stop claiming senders in the same breath, or a
 * recycled `webContents.id` would resolve to a dead context.
 */
function createWindowWithContext(
  opts: CreateProjectWindowOptions,
  entry: string,
  title: string,
  query?: Record<string, string>,
): ProjectWindow {
  const { config, rendererDir, appServices, router } = opts
  const window = createConfiguredMainWindow(config, rendererDir, entry, title, query)
  const context = createContext(config, window, rendererDir, appServices)

  // Anchor the window's renderer as the first Connection. Resources scoped to
  // that webContents (acquired by later wiring) tear down with it; see
  // packages/electron-deck/docs/foundation.md (teardown paths).
  context.connections.acquire(window.webContents)
  context.registry.add(router.register(context))

  return { window, context, dispose: () => disposeContext(context) }
}

/**
 * The project-list window. It is the application's root window: the app-level
 * IPC surface is registered while it exists, and it stays open for the whole
 * session so workbench windows can come and go around it.
 */
export function createLauncherWindow(opts: CreateProjectWindowOptions): ProjectWindow {
  return createWindowWithContext(
    opts,
    'entries/main/index.html',
    opts.config.appName ?? 'Dimina DevTools',
  )
}

/**
 * A workbench window: one open mini-program project, with its own simulator,
 * panels and editor. The project identity travels in the URL query so the
 * renderer entry can mount straight into the project without asking main.
 */
export function createWorkbenchWindow(
  opts: CreateProjectWindowOptions,
  project: ProjectRef,
): ProjectWindow {
  return createWindowWithContext(
    opts,
    'entries/workbench/index.html',
    project.name || opts.config.appName || 'Dimina DevTools',
    { path: project.path, name: project.name ?? '' },
  )
}
