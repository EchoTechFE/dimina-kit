import { setupCdpPort } from './bootstrap.js'

import { app, BrowserWindow, nativeImage } from 'electron'
import fs from 'fs'
import path from 'path'
import type { BuiltinModuleId, WorkbenchAppConfig } from '../../shared/types.js'
import { rendererDir as defaultRendererDir, defaultPreloadPath } from '../utils/paths.js'
import { registerAppLifecycle } from './lifecycle.js'
import { createMainWindow, wireMainWindowEvents } from '../windows/main-window/index.js'
import { createWorkbenchContext, type WorkbenchContext } from '../services/workbench-context.js'
import { createDefaultAdapter } from '../services/default-adapter.js'
import { loadWorkbenchSettings, applyTheme } from '../services/settings/index.js'
import { installAppMenu } from '../menu/index.js'
import {
  registerAppIpc,
  registerSimulatorIpc,
  registerPanelsIpc,
  registerPopoverIpc,
  registerProjectsIpc,
  registerSessionIpc,
  registerSettingsIpc,
  registerToolbarIpc,
} from '../ipc/index.js'
import { startAutomationServer, type AutomationServer } from '../services/automation/index.js'
import { startMcpServer } from '../services/mcp/index.js'
import { setupSimulatorStorage } from '../services/simulator-storage/index.js'
import { UpdateManager } from '../services/update/index.js'

const DEFAULT_MODULES: Record<BuiltinModuleId, boolean> = {
  projects: true,
  session: true,
  simulator: true,
  popover: true,
  settings: true,
}

type BuiltinRegistrar = (ctx: WorkbenchContext) => void

const MODULE_REGISTRARS: Record<BuiltinModuleId, BuiltinRegistrar> = {
  projects: registerProjectsIpc,
  session: registerSessionIpc,
  simulator: (ctx) => {
    registerSimulatorIpc(ctx)
    registerPanelsIpc(ctx)
    registerToolbarIpc(ctx)
  },
  popover: registerPopoverIpc,
  settings: registerSettingsIpc,
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

async function disposeContext(ctx: WorkbenchContext, updateManager?: UpdateManager): Promise<void> {
  updateManager?.dispose()
  await ctx.workspace.closeProject()
}

function createConfiguredMainWindow(config: WorkbenchAppConfig, rendererDir: string): BrowserWindow {
  const mainWindow = createMainWindow({
    title: config.appName ?? 'Dimina DevTools',
    indexHtml: path.join(rendererDir, 'entries/main/index.html'),
    width: config.window?.width,
    height: config.window?.height,
    minWidth: config.window?.minWidth,
    minHeight: config.window?.minHeight,
  })

  // Set window/taskbar icon if provided (Linux/Windows; macOS uses app bundle icon)
  if (config.icon) {
    const icon = nativeImage.createFromPath(config.icon)
    if (!icon.isEmpty()) mainWindow.setIcon(icon)
  }

  return mainWindow
}

function createContext(config: WorkbenchAppConfig, mainWindow: BrowserWindow, rendererDir: string): WorkbenchContext {
  // A host-provided adapter wins; otherwise build the default with the
  // host-supplied jssdk path so external integrators can swap in their own
  // dimina-fe-container build without bundling devkit's default.
  if (config.adapter && config.jssdkDir) {
    console.warn('[dimina-devtools] `jssdkDir` is ignored when a custom `adapter` is provided; pass jssdkDir to your adapter explicitly.')
  }
  const adapter = config.adapter ?? createDefaultAdapter({ jssdkDir: config.jssdkDir })

  return createWorkbenchContext({
    mainWindow,
    adapter,
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
    if (modules[moduleId]) MODULE_REGISTRARS[moduleId](context)
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
    // Stable, parseable line for e2e harnesses that scrape stdout.
    console.log(`[automation] listening on ws://127.0.0.1:${server.port}`)
  }
}

function setupMcp(): void {
  const settings = loadWorkbenchSettings()
  if (!settings.mcp.enabled) return

  const cdpPortSwitch = app.commandLine.getSwitchValue('remote-debugging-port')
  const cdpPort = cdpPortSwitch ? parseInt(cdpPortSwitch, 10) : settings.cdp.port
  startMcpServer(cdpPort, settings.mcp.port)
}

function wireAppWindowEvents(config: WorkbenchAppConfig, instance: WorkbenchAppInstance): void {
  const { mainWindow, context } = instance
  wireMainWindowEvents(mainWindow, {
    context,
    onResize: () => context.views.repositionAll(),
    onClose: async (e) => {
      if (!context.workspace.hasActiveSession()) return

      e.preventDefault()
      if (config.onBeforeClose) {
        await config.onBeforeClose(instance)
      }
      await disposeContext(context)
      context.notify.windowNavigateBack()
    },
  })
}

function enableDevRendererAutoReload(rendererDir: string): void {
  // Auto-reload renderer windows when dist files change during development
  if (!app.isPackaged) {
    let reloadTimer: ReturnType<typeof setTimeout> | null = null
    fs.watch(rendererDir, { recursive: true }, () => {
      if (reloadTimer) clearTimeout(reloadTimer)
      reloadTimer = setTimeout(() => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.reload()
        }
      }, 300)
    })
  }
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
      registerAppIpc(context)
      registerBuiltinModules(config, context)
      installMenu(config, mainWindow, context)

      const instance: WorkbenchAppInstance = {
        mainWindow,
        context,
        dispose: () => disposeContext(context, instance.updateManager),
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
      }

      await setupAutomation(instance)
      setupMcp()
      setupSimulatorStorage(mainWindow.webContents)
      wireAppWindowEvents(config, instance)
      enableDevRendererAutoReload(rendererDir)

      return instance
    })

    return setupPromise
  }

  function start(): void {
    void setup()
    if (!appEventsRegistered) {
      appEventsRegistered = true
      registerAppLifecycle()
    }
  }

  return {
    setup,
    start,
  }
}
