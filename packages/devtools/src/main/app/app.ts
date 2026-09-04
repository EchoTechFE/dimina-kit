import { setupCdpPort, registerDifileScheme, suppressInsecureCspWarnings } from './bootstrap.js'
import { installMaxListenersWarningDiagnostic } from './max-listeners-diagnostic.js'

import { app, BrowserWindow, session } from 'electron'
import type { BuiltinModuleId, WorkbenchAppConfig } from '../../shared/types.js'
import type {
  SimulatorUiExtensionHandle,
  SimulatorUiExtensionRegistration,
} from '../../shared/simulator-ui.js'
import type { SimulatorApiHandler } from '../services/simulator/custom-apis.js'
import { rendererDir as defaultRendererDir } from '../utils/paths.js'
// eslint-disable-next-line no-restricted-syntax -- grandfathered(workbench-context): shrink-only
import type { WorkbenchContext } from '../services/workbench-context.js'
import { createAppServices, registerTrustedWindow } from '../services/app-services.js'
import { createWindowContextRouter, type WindowContextRouter } from '../services/window-contexts/context-router.js'
import type { WorkbenchModule } from '../services/module.js'
import { createInternalDevtoolsWindow } from '../windows/internal-devtools-window/index.js'
import {
  registerAppIpc,
  registerInternalDevtoolsIpc,
  registerTooltipIpc,
  registerProjectCreateIpc,
  registerViewsIpc,
  popoverModule,
  projectsModule,
  sessionModule,
  settingsModule,
  simulatorModule,
} from '../ipc/index.js'
import { registerProjectFsIpc } from '../ipc/project-fs.js'
import { setupSimulatorSessionPolicy } from '../services/views/simulator-session-policy.js'
import { setupCompileWorkerStandby } from '../services/compile-standby.js'
import { installThemeBackgroundSync } from '../utils/theme.js'
import { isAppQuitting } from './lifecycle.js'
import { loadWorkbenchSettings, applyTheme } from '../services/settings/index.js'
import type { AutomationServer } from '../services/automation/index.js'
import { SHARED_MINIAPP_PARTITION } from '../services/views/miniapp-partition.js'
import { setupSimulatorTempFiles } from '../services/simulator-temp-files/index.js'
import { UpdateManager } from '../services/update/index.js'
import { toDisposable, DisposableRegistry, type Disposable } from '@dimina-kit/electron-deck/main'
import { IpcRegistry } from '../utils/ipc-registry.js'
import { createLauncherWindow, type ProjectRef, type ProjectWindow } from './project-window.js'
import { createWorkbenchWindowManager } from './workbench-window.js'
import { createUiExtensionTargets } from './ui-extension-targets.js'
import { installGlobalMirrors } from './global-mirrors.js'
import { installHostSidebarDefault } from './host-sidebar-default.js'
import { installMenu } from './menu-setup.js'
import {
  createOpenForMcp,
  createTargetForMcp,
  noteActiveMcpWindowChanged,
  setActiveMcpWindowResolver,
} from '../services/mcp/index.js'
import { setupAutomation, setupMcp } from './servers.js'
import { enableDevRendererAutoReload, revealWindow } from './window-events.js'
import { wireMainWindowEvents } from '../windows/main-window/index.js'
import { WindowChannel } from '../../shared/ipc-channels.js'

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

function resolveModules(config: WorkbenchAppConfig): Record<BuiltinModuleId, boolean> {
  return {
    ...DEFAULT_MODULES,
    ...config.modules,
  }
}

/**
 * The IPC half of the built-in modules: registered ONCE for the application.
 * Each handler answers whichever window a message came from (it takes the
 * router), so a second window needs no second registration — and must not make
 * one, since `ipcMain.handle` is a process-wide singleton per channel.
 */
function registerModuleIpc(
  config: WorkbenchAppConfig,
  router: WindowContextRouter<WorkbenchContext>,
  appRegistry: DisposableRegistry,
): void {
  const modules = resolveModules(config)
  ;(Object.keys(modules) as BuiltinModuleId[]).forEach((moduleId) => {
    if (!modules[moduleId]) return
    appRegistry.add(BUILTIN_MODULES[moduleId].setup(router))
  })
}

/**
 * The per-window half: wiring that mutates one concrete context (the
 * simulator's bridge router assigning `ctx.bridge` / `ctx.consoleForwarder`).
 * Runs once per window and is parked on that window's own registry.
 */
export function setupWindowModules(
  config: WorkbenchAppConfig,
  context: WorkbenchContext,
): void {
  const modules = resolveModules(config)
  ;(Object.keys(modules) as BuiltinModuleId[]).forEach((moduleId) => {
    if (!modules[moduleId]) return
    const module = BUILTIN_MODULES[moduleId]
    if (module.setupWindow) context.registry.add(module.setupWindow(context))
  })
}

/**
 * Registers the workbench's IPC surface against the router, so each message is
 * answered with the context of the window it came from.
 */
function registerWorkbenchIpc(
  config: WorkbenchAppConfig,
  router: WindowContextRouter<WorkbenchContext>,
  context: WorkbenchContext,
  mainWindow: BrowserWindow,
  appRegistry: DisposableRegistry,
): void {
  appRegistry.add(registerAppIpc(router))
  // Sandboxed project file-system IPC (the renderer-side project:fs:* surface).
  appRegistry.add(registerProjectFsIpc(router))
  // Standalone internal (app-wide) DevTools debug window controller — the
  // independent floating CDP panel that debugs the whole Electron app (as
  // opposed to the right-panel CDP, which inspects only the user's
  // mini-program). Assembled before the IPC handler below so a request
  // arriving right after boot always finds it.
  // `isAppQuitting` lets the controller stop intercepting 'close' during a
  // real quit — its habitual preventDefault()+hide() would otherwise cancel
  // the quit itself and strand the process with a hidden window.
  // One per window (each debugs its own renderer), so it is parked on the
  // window's context registry, not the app's.
  context.internalDevtoolsWindow = createInternalDevtoolsWindow(mainWindow, { isAppQuitting })
  context.registry.add(toDisposable(() => context.internalDevtoolsWindow?.dispose()))
  // Unconditional (not a toggleable BUILTIN_MODULES entry): it's core dev
  // tooling, not a host-configurable feature.
  appRegistry.add(registerInternalDevtoolsIpc(router))
  // Unconditional (not a toggleable BUILTIN_MODULES entry): the tooltip
  // overlay is core UI chrome (every toolbar in this app relies on it), not a
  // host-configurable feature.
  appRegistry.add(registerTooltipIpc(router))
  // Unconditional: the project-create dialog is core UI chrome (the built-in
  // "新建项目" flow every host falls back to), not a host-configurable feature.
  appRegistry.add(registerProjectCreateIpc(router))
  // Unconditional (not a toggleable BUILTIN_MODULES entry): placement/host-
  // slot IPC has no real dependency on the simulator module — `ctx.views`
  // (ViewManager) is constructed unconditionally regardless of
  // `modules.simulator`, and host-sidebar in particular lives on the
  // project-list page, unrelated to the simulator webview. Every renderer
  // entry point also blocks its first render on `AllocatePlacementGeneration`
  // (see renderer-placement-generation.ts) — gating any of this behind the
  // simulator toggle would strand a host that disables it on the fatal
  // boot-failure page, or leave placement silently non-functional.
  appRegistry.add(registerViewsIpc(router))
  // Referer/CORS webRequest policy for the simulator runtime's sessions (shared
  // fallback + every per-project partition). Registered into the app registry so
  // its configurator + per-session listeners are torn down with the app —
  // re-creating the app never leaks a duplicate configurator, and a window
  // closing must not strip the policy off the sessions other windows still use.
  appRegistry.add(setupSimulatorSessionPolicy())
  // One process-wide listener that re-syncs every window's native
  // backgroundColor on theme change — windows otherwise keep the stale
  // creation-time color (see installThemeBackgroundSync).
  appRegistry.add(installThemeBackgroundSync())
  // Warm-standby compile worker: only meaningful for the devkit-backed
  // default adapter (a host-injected adapter has no devkit fork to adopt the
  // spare). Registered into the registry so the spare dies with the app.
  if (!config.adapter) appRegistry.add(setupCompileWorkerStandby(context))
  registerModuleIpc(config, router, appRegistry)
}

export interface WorkbenchAppInstance {
  /** The project-list window. It stays open for the whole session. */
  mainWindow: BrowserWindow
  /** The project-list window's context. Workbench windows have their own. */
  context: WorkbenchContext
  /**
   * Open `project` in its own workbench window, or focus the window already
   * showing it. This is the only way a project is opened: the list window never
   * turns into a workbench.
   */
  openProjectWindow: (project: ProjectRef) => Promise<BrowserWindow>
  /** Every open workbench window, in the order they were opened. */
  projectWindows: () => ProjectWindow[]
  /**
   * Dispose every live window's WebContentsViews. Called at `before-quit`,
   * while the main loop is still healthy, so no view survives into Chromium's
   * native shutdown. Idempotent, and covers every window — a workbench window's
   * views hold the MessagePorts that segfault if torn down natively.
   */
  disposeViews: () => void
  /** Gated custom-IPC registration surface; admits every workbench window. */
  readonly ipc: IpcRegistry
  /** Adds a host-owned BrowserWindow to the trusted-sender set. */
  registerTrustedWindow: (win: BrowserWindow) => Disposable
  /** Registers a simulator custom API into this context's registry. */
  registerSimulatorApi: (name: string, handler: SimulatorApiHandler) => Disposable
  /** Registers a downstream renderer extension for the simulator device UI. */
  registerSimulatorUiExtension: (
    registration: SimulatorUiExtensionRegistration,
  ) => SimulatorUiExtensionHandle
  automationServer?: AutomationServer
  updateManager?: UpdateManager
  dispose: () => Promise<void>
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
  // Dev-only: decode any MaxListenersExceededWarning to the concrete wc that
  // tripped it (id/type/url), so a stray listener accrual is pinned rather than
  // guessed. Registered once, pre-ready; harmless if it never fires.
  if (!app.isPackaged) installMaxListenersWarningDiagnostic()
  // Privileged scheme registration must run before app.whenReady (else throws).
  registerDifileScheme()
  // The embedded workbench editor (the sole devtools editor) needs
  // SharedArrayBuffer for the TS web ext-host's project-wide IntelliSense.
  // Electron can't flip crossOriginIsolated (electron#35905), but this switch
  // provides SAB independently; it is purely additive (no COEP leak into
  // simulator/console WCVs).
  try { app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer') } catch { /* electron stub in tests */ }
}

/**
 * Domain runtime assembly — the post-whenReady body. Builds the app-wide
 * services and the context router, opens the project window, registers IPC
 * against the router, stands up simulator/storage/CDP/native-host services, and
 * returns the fat {@link WorkbenchAppInstance}. Extracted so the v2
 * `RuntimeBackend.assemble` reuses the exact same body (parity by shared
 * implementation, not behavioural re-creation).
 */
export async function createDevtoolsRuntime(
  config: WorkbenchAppConfig = {},
  /**
   * Fired the instant the `WorkbenchAppInstance` exists — BEFORE `config.onSetup`
   * is awaited below, which may run arbitrarily long host code (including
   * loading the host-toolbar, which opens a live MessagePort). A caller that
   * only learns `instance` from this function's return value would not see it
   * until `onSetup` resolves, leaving a window where an app-quit teardown hook
   * has nothing to dispose yet a live toolbar port already exists.
   */
  onInstanceCreated?: (instance: WorkbenchAppInstance) => void,
): Promise<WorkbenchAppInstance> {
  // Self-gate on Electron readiness: this builds a BrowserWindow immediately, so
  // it must run after `app.whenReady()`. The framework backend path already
  // awaited it (idempotent no-op here); this guards any direct caller against
  // constructing Electron resources before ready.
  await app.whenReady()

  applyTheme(loadWorkbenchSettings().theme)

  const rendererDir = config.rendererDir ?? defaultRendererDir

  // App-wide, built once: the project list, the templates, the trusted-sender
  // ledger and the host's simulator APIs are properties of the application, not
  // of any single window.
  const appServices = createAppServices({
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
  })
  const router = createWindowContextRouter<WorkbenchContext>()

  // App-lifetime registry. `ipcMain.handle` is a process-wide singleton per
  // channel, so the IPC surface is registered exactly once and answers
  // whichever window a message came from. Keeping it OFF the launcher
  // context's registry is what lets the user close the project list without
  // stripping every handler out from under the workbench windows still open.
  const appRegistry = new DisposableRegistry()

  const launcher = createLauncherWindow({ config, rendererDir, appServices, router })
  const { window: mainWindow, context } = launcher

  registerWorkbenchIpc(config, router, context, mainWindow, appRegistry)
  // No `setupWindowModules` here: the only per-window module is the simulator's
  // bridge router, and the project list runs no mini-app — it has no simulator,
  // no service host and no page stack. Installing one here would also claim the
  // process-global `dmb:*` invoke channels before the first workbench window
  // could. `installGlobalMirrors` skips the console/diagnostics mirrors when the
  // router never ran, so the list window keeps its own internal DevTools.
  installGlobalMirrors(context, mainWindow)

  // Wire the simulator-side difile:// protocol handler + temp-file IPC
  // before host onSetup so any host-driven simulator boot sees the
  // protocol live. The module installs its own narrow sender-policy
  // (simulator-session-only) — see file header — because the default
  // workbench policy intentionally rejects the simulator <webview>.
  const simSession = session.fromPartition(SHARED_MINIAPP_PARTITION)
  appRegistry.add(setupSimulatorTempFiles(simSession))

  // Gated custom-IPC surface for the host. Admits any sender the router places
  // in a live window, so a host channel invoked from a workbench window is
  // answered the same as one invoked from the list — binding it to the
  // launcher's own policy would reject every workbench renderer.
  const hostIpc = new IpcRegistry((sender) => router.resolve(sender) !== null)
  appRegistry.add(hostIpc)

  // Host-registered simulator UI extensions are app-level, but an extension can
  // only live in a project window, so the ledger keeps one copy per window.
  const uiExtensions = createUiExtensionTargets<WorkbenchContext>({
    projectWindows: () => workbenchWindows.list().map((pw) => pw.context),
    activeWindow: () => workbenchWindows.activeContext(),
  })

  const workbenchWindows = createWorkbenchWindowManager({
    config,
    rendererDir,
    appServices,
    router,
    setupWindowModules: (ctx) => {
      setupWindowModules(config, ctx)
      uiExtensions.attachTo(ctx)
    },
    // MCP's CDP connections are aimed at the active project window and have to
    // follow it when the user moves.
    onActiveContextChanged: noteActiveMcpWindowChanged,
    onBeforeClose: async (closing, project) => {
      try {
        await config.onBeforeClose?.(instance, {
          path: project.path,
          name: project.name,
          window: closing.window,
          context: closing.context,
        })
      } catch (err) {
        // The host gets to react to the close, not to cancel it: revealing the
        // list window below is what keeps something on screen, and it must not
        // be skipped because host code threw.
        console.error('[workbench] host onBeforeClose hook failed:', err)
      }
      // The closing window keeps its place in the manager's list until its
      // teardown finishes, so "the last project" means no OTHER window is
      // open. The list window may be hidden behind it (see the close handler
      // below) — leaving it hidden strands the user with a running app and
      // nothing on screen.
      if (workbenchWindows.list().every((pw) => pw === closing)) revealWindow(mainWindow)
    },
  })

  // Menu, automation and MCP drive whatever project the user is working in, so
  // they read the active WORKBENCH context, resolved per call — never the list
  // window, which owns no session. With no project open they fall back to the
  // launcher context, whose `hasActiveSession()` is false, while MCP's CDP
  // targets and native-host state live in the window itself: null instead.
  const activeProjectContext = (): WorkbenchContext => workbenchWindows.activeContext() ?? context
  setActiveMcpWindowResolver(() => workbenchWindows.activeContext())
  appRegistry.add(toDisposable(() => setActiveMcpWindowResolver(() => null)))
  installMenu(config, mainWindow, activeProjectContext)

  // Opening a project from the list — and from MCP's project_open, which the
  // list renderer forwards here — always means "give it its own window".
  const windowIpc = new IpcRegistry(router)
  windowIpc.handleRouted(
    WindowChannel.OpenProjectWindow,
    async (_ctx, _event, ...args: unknown[]) => {
      const project = args[0] as ProjectRef | undefined
      if (!project?.path) throw new Error('openProjectWindow requires a project path')
      await workbenchWindows.open({ path: project.path, name: project.name })
    },
  )
  appRegistry.add(windowIpc)

  const instance: WorkbenchAppInstance = {
    mainWindow,
    context,
    ipc: hostIpc,
    openProjectWindow: (project: ProjectRef) => workbenchWindows.open(project),
    projectWindows: () => workbenchWindows.list(),
    disposeViews: () => {
      for (const ctx of router.list()) ctx.views.disposeAll()
    },
    // Return the registry wrapper, not the raw disposable: disposing the
    // wrapper splices the registry entry out AND drives the underlying
    // teardown, so a single dispose leaves no dead entry behind.
    // App-level: the trusted-sender ledger and the simulator API map are
    // shared by every window, so they outlive any one of them.
    registerTrustedWindow: (win: BrowserWindow) =>
      appRegistry.add(registerTrustedWindow(appServices, win)),
    // Simulator APIs live in the ONE registry AppServices owns, which every
    // window's context points at, so a single registration serves every
    // window — including windows opened later, since the service host reads
    // the registered names off it when it spawns. The disposer therefore
    // belongs to the app: parking it on a window would let that window's close
    // delete the handler out from under every other open window.
    registerSimulatorApi: (name: string, handler: SimulatorApiHandler) =>
      appRegistry.add(toDisposable(appServices.simulatorApis.register(name, handler))),
    registerSimulatorUiExtension: (registration) => uiExtensions.register(registration),
    dispose: async () => {
      await workbenchWindows.disposeAll()
      await launcher.dispose()
      await appRegistry.dispose()
    },
  }
  onInstanceCreated?.(instance)

  // Built-in simulator APIs: devtools-supplied wx.* implementations that run
  // in the main process. Hosts can override any of these in their onSetup by
  // re-registering the same name (last-write-wins on the Map).
  instance.registerSimulatorApi('login', async () => {
    return 'hello'
  })

  installHostSidebarDefault(context, rendererDir)

  if (config.onSetup) {
    await config.onSetup(instance)
  }

  if (config.updateChecker) {
    instance.updateManager = new UpdateManager({
      checker: config.updateChecker,
      showUpdatePanel: (info) => context.views.showUpdateDialog(info),
      notifyDownloadProgress: (percent) => context.views.notifyUpdateDownloadProgress(percent),
      hideUpdatePanel: () => context.views.hideUpdateDialog(),
      senderPolicy: context.senderPolicy,
      checkInterval: config.updateOptions?.checkInterval,
      initialDelay: config.updateOptions?.initialDelay,
      getCurrentVersion: config.updateOptions?.getCurrentVersion,
    })
    appRegistry.add(() => instance.updateManager!.dispose())
  }

  const automation = await setupAutomation(instance, activeProjectContext, router)
  if (automation) appRegistry.add(automation)
  const mcp = setupMcp(createTargetForMcp({
    list: () => workbenchWindows.list(),
    activeContext: activeProjectContext,
    // `close()` (not `destroy()`) so the window's own close handling runs the
    // same teardown a user-driven close does.
    close: (window) => { if (!window.isDestroyed()) window.close() },
  }), createOpenForMcp(workbenchWindows))
  if (mcp) appRegistry.add(mcp)

  // The list window opens no project, so its close needs none of the workbench
  // teardown: just unregister its context, or a recycled `webContents.id`
  // could later resolve to a destroyed window.
  context.registry.add(wireMainWindowEvents(mainWindow, {
    context,
    onResize: () => context.views.repositionAll(),
    onClose: (e) => {
      if (isAppQuitting()) return
      // With projects still open, this window must survive its own close
      // button: it is the only way back to the project list, and the
      // app-level IPC it registered cannot be registered again on a
      // replacement window. Hide it — every path back calls `revealWindow`,
      // including the last project window closing.
      if (workbenchWindows.list().length > 0) {
        e.preventDefault()
        mainWindow.hide()
        return
      }
      void launcher.dispose()
    },
  }))

  // macOS keeps the app running with no window on screen. Clicking the dock
  // icon then has to bring something back, and the project list is the app's
  // home — a workbench window only exists for a project the user already
  // chose.
  const onActivate = (): void => {
    if (mainWindow.isDestroyed()) return
    if (mainWindow.isVisible()) return
    if (workbenchWindows.list().some((pw) => !pw.window.isDestroyed() && pw.window.isVisible())) return
    revealWindow(mainWindow)
  }
  app.on('activate', onActivate)
  appRegistry.add(toDisposable(() => { app.removeListener('activate', onActivate) }))

  appRegistry.add(enableDevRendererAutoReload(rendererDir))

  return instance
}
