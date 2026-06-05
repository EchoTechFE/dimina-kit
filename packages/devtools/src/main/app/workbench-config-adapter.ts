/**
 * Pure adapter: `@dimina-kit/workbench`'s declarative `WorkbenchConfig` →
 * dimina-devtools' own `WorkbenchAppConfig` (consumed by `createWorkbenchApp`).
 *
 * Splits the input into:
 *  - `appConfig`  — the directly-mappable declarative fields. Only present
 *                   fields are emitted (no `undefined` own-keys), so
 *                   `createWorkbenchApp`'s presence/`??` defaulting still works.
 *  - `deferred`   — cross-process / runtime contributions
 *                   (toolbar/windows/events/hostServices/simulatorApis/menu/
 *                   lifecycle/setup) that `workbench()` wires up separately
 *                   (U4/U6); these must NOT leak into `appConfig`.
 *
 * Pure — touches no electron. Type mismatches between the two packages'
 * `CompilationAdapter` / `ProjectsProvider` / `UpdateChecker` shapes are bridged
 * by reference pass-through with targeted casts; structural compatibility is the
 * caller's contract (see workbench-model.md §3.1).
 */
import type { WorkbenchConfig } from '@dimina-kit/workbench'
import type { WorkbenchAppConfig } from '../../shared/types.js'

export interface DeferredContributions {
  toolbar?: WorkbenchConfig['toolbar']
  windows?: WorkbenchConfig['windows']
  events?: WorkbenchConfig['events']
  hostServices?: WorkbenchConfig['hostServices']
  simulatorApis?: WorkbenchConfig['simulatorApis']
  menu?: WorkbenchConfig['menu']
  setup?: WorkbenchConfig['setup']
}

/** Race a host hook against its timeout; on timeout log + continue (never block shutdown). */
async function runWithTimeout(work: Promise<void> | void, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.error(`[workbench] lifecycle.beforeClose timed out after ${timeoutMs}ms`)
      resolve()
    }, timeoutMs)
  })
  try {
    await Promise.race([Promise.resolve(work), timeout])
  }
  finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export interface WorkbenchConfigAdaptResult {
  appConfig: WorkbenchAppConfig
  deferred: DeferredContributions
}

export function toWorkbenchAppConfig(config: WorkbenchConfig): WorkbenchConfigAdaptResult {
  const appConfig: Record<string, unknown> = {}

  const app = config.app
  if (app) {
    if (app.name !== undefined) appConfig.appName = app.name
    if (app.headerHeight !== undefined) appConfig.headerHeight = app.headerHeight
    if (app.icon !== undefined) appConfig.icon = app.icon
    if (app.window !== undefined) appConfig.window = app.window
    if (app.adapter !== undefined) appConfig.adapter = app.adapter
  }

  if (config.projects !== undefined) appConfig.projectsProvider = config.projects

  if (config.templates) {
    if (config.templates.custom !== undefined) {
      appConfig.projectTemplates = config.templates.custom
    }
    if (config.templates.builtins !== undefined) {
      appConfig.builtinTemplates = config.templates.builtins
    }
  }

  if (config.lifecycle?.beforeClose) {
    // Map the host close hook onto createWorkbenchApp's onBeforeClose so it
    // actually runs when the main window closes with an active session.
    const beforeClose = config.lifecycle.beforeClose
    const timeoutMs = config.lifecycle.timeoutMs ?? 10_000
    appConfig.onBeforeClose = () => runWithTimeout(beforeClose(), timeoutMs)
  }

  if (config.update) {
    // `UpdateContribution` carries checker methods + option fields in one
    // object; split them into the devtools `updateChecker` / `updateOptions`.
    const { checkForUpdates, downloadUpdate, checkInterval, initialDelay, getCurrentVersion } =
      config.update
    appConfig.updateChecker = { checkForUpdates, downloadUpdate }

    const updateOptions: Record<string, unknown> = {}
    if (checkInterval !== undefined) updateOptions.checkInterval = checkInterval
    if (initialDelay !== undefined) updateOptions.initialDelay = initialDelay
    if (getCurrentVersion !== undefined) updateOptions.getCurrentVersion = getCurrentVersion
    if (Object.keys(updateOptions).length > 0) appConfig.updateOptions = updateOptions
  }

  const deferred: DeferredContributions = {}
  if (config.toolbar !== undefined) deferred.toolbar = config.toolbar
  if (config.windows !== undefined) deferred.windows = config.windows
  if (config.events !== undefined) deferred.events = config.events
  if (config.hostServices !== undefined) deferred.hostServices = config.hostServices
  if (config.simulatorApis !== undefined) deferred.simulatorApis = config.simulatorApis
  if (config.menu !== undefined) deferred.menu = config.menu
  if (config.setup !== undefined) deferred.setup = config.setup

  return { appConfig: appConfig as unknown as WorkbenchAppConfig, deferred }
}
