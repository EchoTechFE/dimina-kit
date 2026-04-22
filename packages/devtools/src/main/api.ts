// ── Primary API ──────────────────────────────────────────────────────────
export { launch, buildDefaultMenu, openSettingsWindow } from './app/launch.js'
export { createWorkbenchApp } from './app/app.js'
export type { WorkbenchAppInstance } from './app/app.js'

// ── Bootstrap utilities ──────────────────────────────────────────────────
export { suppressEpipe, setupCdpPort } from './app/bootstrap.js'

// ── Context & views (for module-assembly consumers) ──────────────────────
export { createWorkbenchContext, hasBuiltinPanel, getDefaultTab } from './services/workbench-context.js'
export type { WorkbenchContext, CreateContextOptions } from './services/workbench-context.js'
export { createMainWindow } from './windows/main-window/index.js'
export { createViewManager } from './services/views/view-manager.js'
export type { ViewManager } from './services/views/view-manager.js'

// ── IPC module registration ──────────────────────────────────────────────
export { registerAppIpc } from './ipc/app.js'
export { registerSimulatorIpc } from './ipc/simulator.js'
export { registerPanelsIpc } from './ipc/panels.js'
export { registerPopoverIpc } from './ipc/popover.js'
export { registerSettingsIpc } from './ipc/settings.js'
export { registerProjectsIpc } from './ipc/projects.js'
export { registerSessionIpc } from './ipc/session.js'
export { registerToolbarIpc } from './ipc/toolbar.js'

// ── Paths ────────────────────────────────────────────────────────────────
export { rendererDir, defaultPreloadPath, getRendererDir, getPreloadDir, getRendererHtml } from './utils/paths.js'
export { simulatorDir } from './services/simulator/dir.js'

// ── Update checker ───────────────────────────────────────────────────────
export { UpdateManager, createGitHubReleaseChecker } from './services/update/index.js'
export type {
  UpdateManagerOptions,
  GitHubReleaseCheckerOptions,
  PickAssetContext,
  VersionScheme,
} from './services/update/index.js'

// ── Types (re-export for convenience) ────────────────────────────────────
export type {
  WorkbenchConfig,
  WorkbenchAppConfig,
  CompilationAdapter,
  ProjectSession,
  ToolbarAction,
  BuiltinPanelId,
  BuiltinModuleId,
  UpdateChecker,
  UpdateInfo,
} from '../shared/types.js'
