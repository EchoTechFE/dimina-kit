import type { DisposableRegistry } from '@dimina-kit/electron-deck/main'
import type { BuiltinModuleId, WorkbenchAppConfig } from '../../shared/types.js'
import {
  popoverModule,
  projectsModule,
  sessionModule,
  settingsModule,
  simulatorModule,
} from '../ipc/index.js'
import type { WorkbenchModule } from '../services/module.js'
import type { WindowContextRouter } from '../services/window-contexts/context-router.js'
import type { ProjectWindow } from './project-window.js'

/**
 * The window context type, taken from `ProjectWindow` so this module doesn't
 * import `WorkbenchContext` directly (see eslint-workbench-context-gate).
 */
type WindowContext = ProjectWindow['context']

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
export function registerModuleIpc(
  config: WorkbenchAppConfig,
  router: WindowContextRouter<WindowContext>,
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
  context: WindowContext,
): void {
  const modules = resolveModules(config)
  ;(Object.keys(modules) as BuiltinModuleId[]).forEach((moduleId) => {
    if (!modules[moduleId]) return
    const module = BUILTIN_MODULES[moduleId]
    if (module.setupWindow) context.registry.add(module.setupWindow(context))
  })
}
