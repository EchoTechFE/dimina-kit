import { setupCdpPort } from './bootstrap.js'

import { app, BrowserWindow, nativeImage } from 'electron'
import fs from 'fs'
import path from 'path'
import type { BuiltinModuleId, WorkbenchAppConfig } from '../../shared/types.js'
import { rendererDir as defaultRendererDir, defaultPreloadPath } from '../utils/paths.js'
import { registerAppLifecycle } from './lifecycle.js'
import { createMainWindow, wireMainWindowEvents } from '../windows/main-window/index.js'
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
import { startMcpServer } from '../services/mcp/index.js'
import { setupSimulatorStorage } from '../services/simulator-storage/index.js'
import { UpdateManager } from '../services/update/index.js'
import { toDisposable, type Disposable } from '../utils/disposable.js'

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
  automationServer?: AutomationServer
  updateManager?: UpdateManager
  dispose: () => Promise<void>
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
    // P1: pass the same preload path the workbench context stores on
    // ctx.preloadPath so hosts that ship a custom simulator preload are the
    // ones registered on the persist:simulator session — otherwise the
    // backstop wouldn't be the host's script.
    simulatorPreloadPath: config.preloadPath ?? defaultPreloadPath,
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
    panels: config.panels,
    appName: config.appName,
    apiNamespaces: config.apiNamespaces,
    brandingProvider: config.brandingProvider,
    toolbarActions: config.toolbarActions,
  })
}

function registerBuiltinModules(config: WorkbenchAppConfig, context: WorkbenchContext): void {
  const modules = resolveModules(config)
  ;(Object.keys(modules) as BuiltinModuleId[]).forEach((moduleId) => {
    if (modules[moduleId]) context.registry.add(BUILTIN_MODULES[moduleId].setup(context))
  })
}

function installMenu(config: WorkbenchAppConfig, mainWindow: BrowserWindow, context: WorkbenchContext): void {
  // Menu: use host-provided builder or fall back to default
  if (config.menuBuilder) {
    config.menuBuilder(mainWindow, context)
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
  return wireMainWindowEvents(mainWindow, {
    context,
    onResize: () => context.views.repositionAll(),
    onClose: async (e) => {
      if (!context.workspace.hasActiveSession()) return

      // Close button while a project session is open: stay in the workbench
      // and surface the project list. Tear down only the session — do NOT
      // dispose `context.registry`, which owns every IPC handler (projects,
      // dialog, settings…). Disposing it would leave the renderer alive but
      // unable to invoke anything, so subsequent clicks on Import/etc. would
      // raise `No handler registered for ...`.
      e.preventDefault()
      if (config.onBeforeClose) {
        await config.onBeforeClose(instance)
      }
      await context.workspace.closeProject()
      context.notify.windowNavigateBack()
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

export function createWorkbenchApp(config: WorkbenchAppConfig = {}) {
  let setupPromise: Promise<WorkbenchAppInstance> | null = null
  let appEventsRegistered = false

  setupCdpPort()

  async function setup(): Promise<WorkbenchAppInstance> {
    if (setupPromise) return setupPromise

    setupPromise = app.whenReady().then(async () => {
      applyTheme(loadWorkbenchSettings().theme)

      const rendererDir = config.rendererDir ?? defaultRendererDir
      const mainWindow = createConfiguredMainWindow(config, rendererDir)
      const context = createContext(config, mainWindow, rendererDir)
      context.registry.add(registerAppIpc(context))
      registerBuiltinModules(config, context)
      installMenu(config, mainWindow, context)

      const instance: WorkbenchAppInstance = {
        mainWindow,
        context,
        dispose: () => disposeContext(context),
      }

      if (config.onSetup) {
        await config.onSetup(instance)
      }

      if (config.updateChecker) {
        instance.updateManager = new UpdateManager({
          checker: config.updateChecker,
          mainWindow,
          checkInterval: config.updateOptions?.checkInterval,
          initialDelay: config.updateOptions?.initialDelay,
          getCurrentVersion: config.updateOptions?.getCurrentVersion,
        })
        context.registry.add(() => instance.updateManager!.dispose())
      }

      await setupAutomation(instance)
      const mcp = setupMcp()
      if (mcp) context.registry.add(mcp)
      context.registry.add(setupSimulatorStorage(mainWindow.webContents, {
        senderPolicy: context.senderPolicy,
        // Per-project filter for the simulator-storage panel: the simulator
        // uses a fixed `persist:simulator` partition + a fixed simulator.html
        // origin, so localStorage is shared across every project that has
        // ever opened. The dimina runtime isolates writes with `${appId}_`
        // prefixes; this callback lets the storage panel filter the CDP
        // snapshot/event stream to the active appId.
        getActiveAppId: () => {
          const session = context.workspace.getSession()
          const appInfo = session?.appInfo as { appId?: string } | undefined
          return appInfo?.appId ?? null
        },
      }))
      context.registry.add(wireAppWindowEvents(config, instance))
      context.registry.add(enableDevRendererAutoReload(rendererDir))

      return instance
    })

    return setupPromise
  }

  function start(): Promise<void> {
    if (!appEventsRegistered) {
      appEventsRegistered = true
      registerAppLifecycle()
    }
    return setup().then(() => undefined)
  }

  return {
    setup,
    start,
  }
}
