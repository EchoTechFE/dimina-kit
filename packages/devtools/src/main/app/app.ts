import { setupCdpPort, registerDifileScheme, suppressInsecureCspWarnings } from './bootstrap.js'
import { registerProjectFsIpc } from '../ipc/project-fs.js'

import { app, BrowserWindow, nativeImage, session } from 'electron'
import fs from 'fs'
import path from 'path'
import type { BuiltinModuleId, MenuContext, WorkbenchAppConfig } from '../../shared/types.js'
import type { SimulatorApiHandler } from '../services/simulator/custom-apis.js'
import { rendererDir as defaultRendererDir, defaultPreloadPath } from '../utils/paths.js'
import { installThemeBackgroundSync } from '../utils/theme.js'
import { createMainWindow, wireMainWindowEvents } from '../windows/main-window/index.js'
import { isAppQuitting } from './lifecycle.js'
// eslint-disable-next-line no-restricted-syntax -- grandfathered(workbench-context): shrink-only
import { createWorkbenchContext, type WorkbenchContext } from '../services/workbench-context.js'
import { loadWorkbenchSettings, applyTheme } from '../services/settings/index.js'
import { installAppMenu } from '../menu/index.js'
import {
  registerAppIpc,
  popoverModule,
  projectsModule,
  sessionModule,
  settingsModule,
  simulatorModule,
} from '../ipc/index.js'
import type { WorkbenchModule } from '../services/module.js'
import { startAutomationServer, type AutomationServer } from '../services/automation/index.js'
import {
  startMcpServer,
  setNativeHost,
  setActiveBridgeId,
  setNativeOverviewProvider,
} from '../services/mcp/index.js'
import { setupSimulatorStorage } from '../services/simulator-storage/index.js'
import { createNetworkForwarder } from '../services/network-forward/index.js'
import { setupSimulatorWxml } from '../services/simulator-wxml/index.js'
import { setupSimulatorAppData } from '../services/simulator-appdata/index.js'
import { setupSimulatorCurrentPage } from '../services/simulator-current-page/index.js'
import { createRenderInspector } from '../services/render-inspect/index.js'
import { setupSimulatorTempFiles } from '../services/simulator-temp-files/index.js'
import { SHARED_MINIAPP_PARTITION } from '../services/views/miniapp-partition.js'
import { setupSimulatorSessionPolicy } from '../services/views/simulator-session-policy.js'
import { startWorkbenchCoiServer } from '../services/workbench-coi-server.js'
import { UpdateManager } from '../services/update/index.js'
import { toDisposable, type Disposable } from '@dimina-kit/electron-deck/main'
import { IpcRegistry } from '../utils/ipc-registry.js'

const DEFAULT_MODULES: Record<BuiltinModuleId, boolean> = {
  projects: true,
  session: true,
  simulator: true,
  popover: true,
  settings: true,
}

const BUILTIN_MODULES: Record<BuiltinModuleId, WorkbenchModule> = {
  projects: projectsModule,
  session: sessionModule,
  simulator: simulatorModule,
  popover: popoverModule,
  settings: settingsModule,
}

export interface WorkbenchAppInstance {
  mainWindow: BrowserWindow
  context: WorkbenchContext
  /** Gated custom-IPC registration surface bound to `context.senderPolicy`. */
  readonly ipc: IpcRegistry
  /** Adds a host-owned BrowserWindow to the trusted-sender set. */
  registerTrustedWindow: (win: BrowserWindow) => Disposable
  /** Registers a simulator custom API into this context's registry. */
  registerSimulatorApi: (name: string, handler: SimulatorApiHandler) => Disposable
  automationServer?: AutomationServer
  updateManager?: UpdateManager
  dispose: () => Promise<void>
}

/**
 * Adds `win.webContents` to the context's trusted-sender set and returns a
 * Disposable that removes it again.
 *
 * Trust is reference-counted: registering the SAME window N times keeps it
 * trusted until every one of the N returned Disposables has been disposed.
 * `trustedWindowSenderIds` is a `Map<webContents.id, refCount>`; each register
 * bumps the count, each dispose decrements it, and the window is un-trusted
 * only when the count reaches zero.
 *
 * The window's `closed` event short-circuits the ref-count: it deletes the
 * map entry outright (the window is dead, so it must be un-trusted
 * immediately regardless of how many Disposables are still outstanding).
 * After `closed`, disposing any leftover Disposable is a safe no-op — the
 * map entry is already gone, so the decrement finds `undefined` and bails
 * without driving the count negative or resurrecting trust.
 *
 * Each returned Disposable is itself idempotent (`removed` flag), and its
 * `closed` listener removes itself once fired so a long-lived context
 * doesn't accumulate dead listeners on closed windows.
 */
function registerTrustedWindow(context: WorkbenchContext, win: BrowserWindow): Disposable {
  const senderId = win.webContents.id
  const counts = context.trustedWindowSenderIds
  counts.set(senderId, (counts.get(senderId) ?? 0) + 1)

  let removed = false
  const onClosed = () => {
    // The window is gone: zero the ref-count for this sender id outright,
    // regardless of any other outstanding registrations for the same window.
    counts.delete(senderId)
    win.removeListener('closed', onClosed)
  }

  function remove() {
    if (removed) return
    removed = true
    win.removeListener('closed', onClosed)
    const count = counts.get(senderId)
    // `undefined` → the entry was already cleared (e.g. by `closed` or by a
    // prior sibling's decrement that hit zero). Nothing to do — never go
    // negative, never resurrect trust.
    if (count === undefined) return
    if (count <= 1) counts.delete(senderId)
    else counts.set(senderId, count - 1)
  }

  win.once('closed', onClosed)
  return toDisposable(remove)
}

/** Parse --auto, --auto-port, --project from process.argv. */
function parseAutoArgs(): { auto: boolean; autoPort: number; projectPath: string } {
  const argv = process.argv
  let auto = false
  let autoPort = 9420
  let projectPath = ''

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === 'auto' || argv[i] === '--auto') auto = true
    if ((argv[i] === '--auto-port' || argv[i] === '--auto_port') && argv[i + 1]) {
      const parsed = parseInt(argv[i + 1]!, 10)
      // 0 → OS-assigned free port (used by parallel e2e workers)
      if (Number.isFinite(parsed) && parsed >= 0) autoPort = parsed
    }
    if (argv[i] === '--project' && argv[i + 1]) {
      projectPath = argv[i + 1]!
    }
  }

  return { auto, autoPort, projectPath }
}

function resolveModules(config: WorkbenchAppConfig): Record<BuiltinModuleId, boolean> {
  return {
    ...DEFAULT_MODULES,
    ...config.modules,
  }
}

async function disposeContext(ctx: WorkbenchContext): Promise<void> {
  await ctx.workspace.closeProject()
  await ctx.registry.dispose().catch((err) => {
    console.warn('[workbench] dispose registry encountered errors:', err)
  })
}

function createConfiguredMainWindow(config: WorkbenchAppConfig, rendererDir: string): BrowserWindow {
  const mainWindow = createMainWindow({
    title: config.appName ?? 'Dimina DevTools',
    indexHtml: path.join(rendererDir, 'entries/main/index.html'),
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

function createContext(config: WorkbenchAppConfig, mainWindow: BrowserWindow, rendererDir: string): WorkbenchContext {
  return createWorkbenchContext({
    mainWindow,
    adapter: config.adapter,
    preloadPath: config.preloadPath ?? defaultPreloadPath,
    rendererDir,
    appName: config.appName,
    apiNamespaces: config.apiNamespaces,
    brandingProvider: config.brandingProvider,
    // The host-supplied ProjectsProvider / template types in `shared/types`
    // are structurally compatible with the main-process equivalents —
    // these casts are safe; we re-narrow at the workspace-service /
    // create-project-service boundary.
    projectsProvider: config.projectsProvider as
      | import('../services/projects/types.js').ProjectsProvider
      | undefined,
    projectTemplates: config.projectTemplates as
      | import('../services/projects/types.js').ProjectTemplate[]
      | undefined,
    builtinTemplates: config.builtinTemplates,
    customCreateProjectDialog: config.customCreateProjectDialog as
      // eslint-disable-next-line no-restricted-syntax -- grandfathered(workbench-context): shrink-only
      | import('../services/workbench-context.js').WorkbenchContext['customCreateProjectDialog']
      | undefined,
    onBeforeOpenProject: config.onBeforeOpenProject,
  })
}

function registerBuiltinModules(config: WorkbenchAppConfig, context: WorkbenchContext): void {
  const modules = resolveModules(config)
  ;(Object.keys(modules) as BuiltinModuleId[]).forEach((moduleId) => {
    if (modules[moduleId]) context.registry.add(BUILTIN_MODULES[moduleId].setup(context))
  })
}

/**
 * Build the hand-written narrow `MenuContext` a host menu builder receives —
 * explicit construction (not clone+delete), so the runtime object carries
 * EXACTLY the contract members and nothing else. Every member is a lazy
 * closure over the live context: a host monkey-patch of
 * `context.workspace.openProject` (the documented permission-gate pattern)
 * still intercepts calls made through this menu surface.
 */
function toMenuContext(context: WorkbenchContext): MenuContext {
  return {
    appName: context.appName,
    workspace: {
      hasActiveSession: () => context.workspace.hasActiveSession(),
      getProjectPath: () => context.workspace.getProjectPath(),
      openProject: (projectPath) => context.workspace.openProject(projectPath),
      closeProject: () => context.workspace.closeProject(),
      getSession: () => context.workspace.getSession(),
    },
    openSettings: () => context.openSettings(),
    notify: {
      projectStatus: (payload) => context.notify.projectStatus(payload),
      windowNavigateBack: () => context.notify.windowNavigateBack(),
    },
  }
}

function installMenu(config: WorkbenchAppConfig, mainWindow: BrowserWindow, context: WorkbenchContext): void {
  // Menu: use host-provided builder or fall back to default
  if (config.menuBuilder) {
    config.menuBuilder(mainWindow, toMenuContext(context))
  } else {
    installAppMenu(context)
  }
}

async function setupAutomation(instance: WorkbenchAppInstance): Promise<void> {
  // Start automation server if --auto flag is present
  const autoArgs = parseAutoArgs()
  if (autoArgs.auto) {
    const server = await startAutomationServer(instance.context, autoArgs.autoPort)
    instance.automationServer = server
    instance.context.registry.add(() => server.close())
    // Stable, parseable line for e2e harnesses that scrape stdout.
    console.log(`[automation] listening on ws://127.0.0.1:${server.port}`)
  }
}

function setupMcp(): Disposable | null {
  const settings = loadWorkbenchSettings()
  if (!settings.mcp.enabled) return null

  const cdpPortSwitch = app.commandLine.getSwitchValue('remote-debugging-port')
  const cdpPort = cdpPortSwitch ? parseInt(cdpPortSwitch, 10) : settings.cdp.port
  return startMcpServer(cdpPort, settings.mcp.port)
}

function wireAppWindowEvents(config: WorkbenchAppConfig, instance: WorkbenchAppInstance): Disposable {
  const { mainWindow, context } = instance
  // In-flight guard: `closeProject()` is async, and the window stays open
  // (preventDefault'd) while it runs — a second close click during that window
  // would re-enter and tear the same session down twice. Swallow re-entrancy.
  let closing = false
  return wireMainWindowEvents(mainWindow, {
    context,
    onResize: () => context.views.repositionAll(),
    onClose: async (e) => {
      // A real application quit (⌘Q / menu "Quit" / app.quit()) fires
      // `before-quit` first, then this window's `close`. Let it through so the
      // app actually exits — do NOT convert it into "close the project".
      // Without this, `hasActiveSession()` would be true and the quit gets
      // swallowed into closeProject(), so the app can never be quit while a
      // project is open.
      if (isAppQuitting()) return

      // A close arriving while a project teardown is already in flight (the
      // user rapid-double-clicked the close button) MUST keep the window open.
      // This guard runs BEFORE hasActiveSession() on purpose: `closeProject()`
      // → `disposeSession()` synchronously nulls the active session before it
      // finishes awaiting `session.close()`, so by the time the second close
      // arrives `hasActiveSession()` is already false. With the old guard order
      // that second close fell straight through the hasActiveSession() check
      // WITHOUT `preventDefault()`, so Electron destroyed the last window →
      // `window-all-closed` → `app.quit()`, quitting the whole app on a
      // double-click. Swallow the re-entrant close and keep the window.
      if (closing) {
        e.preventDefault()
        return
      }

      if (!context.workspace.hasActiveSession()) return

      // Close button while a project session is open: stay in the workbench
      // and surface the project list. Tear down only the session — do NOT
      // dispose `context.registry`, which owns every IPC handler (projects,
      // dialog, settings…). Disposing it would leave the renderer alive but
      // unable to invoke anything, so subsequent clicks on Import/etc. would
      // raise `No handler registered for ...`.
      e.preventDefault()
      closing = true
      try {
        if (config.onBeforeClose) {
          await config.onBeforeClose(instance)
        }
        await context.workspace.closeProject()
        context.notify.windowNavigateBack()
      }
      finally {
        closing = false
      }
    },
  })
}

function enableDevRendererAutoReload(rendererDir: string): Disposable {
  // Auto-reload renderer windows when dist files change during development
  if (app.isPackaged) {
    return toDisposable(() => {})
  }

  let reloadTimer: ReturnType<typeof setTimeout> | null = null
  const watcher = fs.watch(rendererDir, { recursive: true }, () => {
    if (reloadTimer) clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.reload()
      }
    }, 300)
  })

  return toDisposable(() => {
    if (reloadTimer) {
      clearTimeout(reloadTimer)
      reloadTimer = null
    }
    watcher.close()
  })
}

/**
 * Pre-ready bootstrap side effects (app name, CDP port, CSP suppression,
 * privileged scheme). MUST run before `app.whenReady()`. Extracted so the `RuntimeBackend.beforeReady` hook (which launch()
 * routes through) runs it before the framework awaits app.whenReady().
 */
export function runDevtoolsBootstrap(config: WorkbenchAppConfig = {}): void {
  // Lock the visible app name BEFORE app.whenReady so the dock label, ⌘-Tab
  // card and macOS app-menu first item read the brand in dev + packaged.
  try { app.setName(config.appName ?? 'Dimina DevTools') } catch { /* electron stub in tests */ }
  setupCdpPort()
  // Dev-only: silence Electron Insecure-CSP warning; no-op when packaged.
  suppressInsecureCspWarnings()
  // Privileged scheme registration must run before app.whenReady (else throws).
  registerDifileScheme()
  // The embedded A2 workbench editor (the sole devtools editor) needs
  // SharedArrayBuffer for the TS web ext-host's project-wide IntelliSense.
  // Electron can't flip crossOriginIsolated (electron#35905), but this switch
  // provides SAB independently; it is purely additive (no COEP leak into
  // simulator/console WCVs).
  try { app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer') } catch { /* electron stub in tests */ }
}

/**
 * Domain runtime assembly — the post-whenReady body. Builds the main window +
 * context, registers IPC modules, stands up simulator/storage/CDP/native-host
 * services, and returns the fat {@link WorkbenchAppInstance}. Extracted so the
 * v2 `RuntimeBackend.assemble` reuses the exact same body (parity by shared
 * implementation, not behavioural re-creation).
 */
export async function createDevtoolsRuntime(config: WorkbenchAppConfig = {}): Promise<WorkbenchAppInstance> {
  // Self-gate on Electron readiness: this builds a BrowserWindow immediately, so
  // it must run after `app.whenReady()`. The framework backend path already
  // awaited it (idempotent no-op here); this guards any direct caller against
  // constructing Electron resources before ready.
  await app.whenReady()

  applyTheme(loadWorkbenchSettings().theme)

  const rendererDir = config.rendererDir ?? defaultRendererDir
  const mainWindow = createConfiguredMainWindow(config, rendererDir)
  const context = createContext(config, mainWindow, rendererDir)

  // Anchor the main window's renderer as the first Connection. Resources
  // scoped to the main webContents (acquired by later wiring) tear down with
  // it; see packages/electron-deck/docs/foundation.md §4.
  context.connections.acquire(mainWindow.webContents)

  context.registry.add(registerAppIpc(context))
  // Sandboxed project file-system IPC (the renderer-side project:fs:* surface).
  context.registry.add(registerProjectFsIpc(context))
  // Referer/CORS webRequest policy for the simulator runtime's sessions (shared
  // fallback + every per-project partition). Registered into the context
  // registry so its configurator + per-session listeners are torn down with the
  // context — re-creating the app never leaks a duplicate configurator.
  context.registry.add(setupSimulatorSessionPolicy())
  // One process-wide listener that re-syncs every window's native
  // backgroundColor on theme change — windows otherwise keep the stale
  // creation-time color (see installThemeBackgroundSync).
  context.registry.add(installThemeBackgroundSync())
  registerBuiltinModules(config, context)

  // Wire the simulator-side difile:// protocol handler + temp-file IPC
  // before host onSetup so any host-driven simulator boot sees the
  // protocol live. The module installs its own narrow sender-policy
  // (simulator-session-only) — see file header — because the default
  // workbench policy intentionally rejects the simulator <webview>.
  const simSession = session.fromPartition(SHARED_MINIAPP_PARTITION)
  context.registry.add(setupSimulatorTempFiles(simSession))

  installMenu(config, mainWindow, context)

  // Gated custom-IPC surface for the host. Bound to ctx.senderPolicy so
  // host channels go through the same gateway as built-in IPC, and
  // registered into ctx.registry so its handlers are torn down with the
  // context.
  const hostIpc = new IpcRegistry(context.senderPolicy)
  context.registry.add(hostIpc)

  const instance: WorkbenchAppInstance = {
    mainWindow,
    context,
    ipc: hostIpc,
    // Return the registry wrapper, not the raw disposable: disposing the
    // wrapper splices the registry entry out AND drives the underlying
    // teardown, so a single dispose leaves no dead entry behind.
    registerTrustedWindow: (win: BrowserWindow) =>
      context.registry.add(registerTrustedWindow(context, win)),
    registerSimulatorApi: (name: string, handler: SimulatorApiHandler) =>
      context.registry.add(toDisposable(context.simulatorApis.register(name, handler))),
    dispose: () => disposeContext(context),
  }

  if (config.onSetup) {
    await config.onSetup(instance)
  }

  if (config.updateChecker) {
    instance.updateManager = new UpdateManager({
      checker: config.updateChecker,
      mainWindow,
      senderPolicy: context.senderPolicy,
      checkInterval: config.updateOptions?.checkInterval,
      initialDelay: config.updateOptions?.initialDelay,
      getCurrentVersion: config.updateOptions?.getCurrentVersion,
    })
    context.registry.add(() => instance.updateManager!.dispose())
  }

  await setupAutomation(instance)
  const mcp = setupMcp()
  if (mcp) context.registry.add(mcp)

  // Resolve the active project's appId. Shared by the storage panel filter
  // and the native-host WXML/element-inspect services (which scope the
  // active render guest by appId).
  const getActiveAppId = (): string | null => {
    const session = context.workspace.getSession()
    const appInfo = session?.appInfo as { appId?: string } | undefined
    return appInfo?.appId ?? null
  }

  // Native-host: the real mini-app page runs in a nested render-host
  // <webview> guest, not the localhost:7788 shell. Point the MCP
  // `simulator` CDP target at the active render guest and keep it following
  // the visible page across navigation/tab switches. Only wired under
  // native-host so the default path stays byte-identical.
  if (context.bridge?.isNativeHost()) {
    setNativeHost(true)
    setNativeOverviewProvider(async () => {
      const appId = getActiveAppId()
      const stack = context.bridge?.getPageStack?.(appId ?? undefined) ?? []
      const top = stack[stack.length - 1]
      const overview = {
        currentRoute: top?.pagePath ?? null,
        pageStackDepth: stack.length,
        storageKeys: [] as string[],
        storageCount: 0,
        appDataKeys: [] as string[],
      }

      if (appId) {
        try {
          const info = await context.storageApi?.invoke(appId, 'getStorageInfo', {})
          if (info && typeof info === 'object') {
            const keys = (info as { keys?: unknown }).keys
            if (Array.isArray(keys)) {
              overview.storageKeys = keys.filter((key): key is string => typeof key === 'string')
              overview.storageCount = keys.length
            }
          }
        } catch {
          // Leave native storage empty when it is temporarily unavailable.
        }

        try {
          const snapshot = context.appData?.snapshot?.(appId)
          if (snapshot && typeof snapshot === 'object') {
            const entries = (snapshot as { entries?: unknown }).entries
            if (entries && typeof entries === 'object') {
              overview.appDataKeys = Object.keys(entries)
            }
          }
        } catch {
          // Leave native appdata empty when it has not been initialized yet.
        }
      }

      return overview
    })
    const off = context.bridge.onRenderEvent((ev) => setActiveBridgeId(ev.bridgeId))
    context.registry.add(off)
    context.registry.add(() => setNativeHost(false))
    context.registry.add(() => setNativeOverviewProvider(null))
  }

  // Native-host inspector: injects the render-guest IIFE and drives WXML /
  // element-highlight against the active render-host <webview>. Reused by
  // the storage panel (element inspect) and the WXML panel service.
  const renderInspector = createRenderInspector({ connections: context.connections })

  const storage = setupSimulatorStorage(mainWindow.webContents, {
    senderPolicy: context.senderPolicy,
    connections: context.connections,
    // Per-project filter for the simulator-storage panel: the simulator
    // uses a fixed `persist:simulator` partition + a fixed simulator.html
    // origin, so localStorage is shared across every project that has
    // ever opened. The dimina runtime isolates writes with `${appId}_`
    // prefixes; this callback lets the storage panel filter the CDP
    // snapshot/event stream to the active appId.
    getActiveAppId,
    // Native-host: route element inspection to the active render guest, and
    // read/write storage from the service-host window's file:// store.
    bridge: context.bridge,
    renderInspector,
  })
  context.registry.add(storage)
  // Native-host: expose the async-storage runtime hook so bridge-router
  // routes async wx.setStorage/etc. to the unified service-host store.
  if (storage.storageApi) {
    context.storageApi = storage.storageApi
    context.registry.add(() => { context.storageApi = undefined })
  }

  // Native-host WXML + AppData panels: main sources the data (WXML pulled
  // from the active render guest; AppData tapped from the service→render
  // setData stream in bridge-router) and pushes it to the renderer. Inert on
  // the default dimina-fe path (which sources both from the simulator
  // miniappSnapshot transport), so only wire them when native-host is on.
  if (context.bridge?.isNativeHost()) {
    // Native-host: surface the simulator WCV's network (wx.request/download/
    // upload run there, not in the service host) in the embedded DevTools by
    // injecting its raw Network.* CDP events into the DevTools front-end so the
    // native Network tab renders them (service-host console line is the
    // fallback). The ViewManager calls the forwarder's attachSimulator +
    // setDevtoolsHost from attachNativeSimulator once the simulator WCV +
    // DevTools host exist; getServiceWc here is the fallback sink target.
    const networkForward = createNetworkForwarder({
      getServiceWc: (appId) => context.bridge?.getServiceWc(appId) ?? null,
      connections: context.connections,
    })
    context.networkForward = networkForward
    context.registry.add(networkForward)
    context.registry.add(() => { context.networkForward = undefined })

    context.registry.add(setupSimulatorWxml(mainWindow.webContents, {
      senderPolicy: context.senderPolicy,
      bridge: context.bridge,
      inspector: renderInspector,
      getActiveAppId,
    }))
    const appDataService = setupSimulatorAppData(mainWindow.webContents, {
      senderPolicy: context.senderPolicy,
      getActiveAppId,
    })
    // bridge-router feeds this via ctx.appData (service→render tap + evict).
    context.appData = appDataService
    context.registry.add(appDataService)
    context.registry.add(() => { context.appData = undefined })
    // Push the visible page route to the toolbar on every navigation (the
    // page stack lives in the DeviceShell WCV, invisible to renderer
    // <webview> nav events).
    context.registry.add(setupSimulatorCurrentPage(mainWindow.webContents, {
      bridge: context.bridge,
    }))
  }
  // Embedded A2 workbench editor — the sole devtools editor. Stand up the COI
  // http server that serves the workbench bundle with the SharedArrayBuffer
  // isolation headers and bridges `/__fs/*` onto the active project, then hand its
  // base URL to the view manager so the 'editor' dock slot mounts the workbench
  // WebContentsView. Both the server and the WCV tear down with the context
  // registry.
  const bundleDir =
    config.editorViewConfig?.bundleDir ?? path.join(rendererDir, '..', 'workbench-a2')
  const coiServer = await startWorkbenchCoiServer({
    rootDir: bundleDir,
    getProjectRoot: () => context.workspace.getProjectPath(),
    extensionsDir: config.editorViewConfig?.extensionsDir,
  })
  context.registry.add(() => { void coiServer.close() })
  context.registry.add(() => context.views.detachWorkbenchA2())
  // Fire-and-forget: attaching the workbench creates the WebContentsView
  // synchronously, but loading the bundle (10MB + ext-host init) must NOT gate
  // app assemble — awaiting it here blocks the whole boot behind the editor's
  // first paint. The view's bounds ride the renderer 'editor'-slot anchor once
  // the dock mounts; load completes in the background.
  void context.views.attachWorkbenchA2(coiServer.baseUrl)

  context.registry.add(wireAppWindowEvents(config, instance))
  context.registry.add(enableDevRendererAutoReload(rendererDir))

  return instance
}
