// ── Primary API ──────────────────────────────────────────────────────────
export { launch, buildDefaultMenu, openSettingsWindow } from './app/launch.js'
export { createWorkbenchApp } from './app/app.js'
export type { WorkbenchAppInstance } from './app/app.js'

// ── Host-shell entry: workbench(config) ───────────────────────────────────
// Per the foundation's dependency direction the declarative host-shell entry
// lives here (not in @dimina-kit/workbench) so it can drive the devtools
// runtime without a cycle. Hosts import `workbench` from @dimina-kit/devtools;
// `defineEvent` / types / preload / client still come from @dimina-kit/workbench.
export { workbench } from './app/workbench-entry.js'

// ── Bootstrap utilities ──────────────────────────────────────────────────
export { suppressEpipe, setupCdpPort } from './app/bootstrap.js'

// ── Context & views (for module-assembly consumers) ──────────────────────
export { createWorkbenchContext, hasBuiltinPanel, getDefaultTab } from './services/workbench-context.js'
export type { WorkbenchContext, CreateContextOptions } from './services/workbench-context.js'
export { createMainWindow } from './windows/main-window/index.js'
export { createViewManager } from './services/views/view-manager.js'
export type { ViewManager } from './services/views/view-manager.js'
export type { WorkspaceService } from './services/workspace/workspace-service.js'
export type { Project, ProjectPages, ProjectSettings } from './services/projects/project-repository.js'

// ── Simulator extension surface ──────────────────────────────────────────
export type { SimulatorApiHandler } from './services/simulator/custom-apis.js'

// ── Paths ────────────────────────────────────────────────────────────────
export {
  rendererDir,
  defaultPreloadPath,
  simulatorDir,
  getRendererDir,
  getPreloadDir,
  getRendererHtml,
} from './utils/paths.js'

// ── IPC gateway (for host-registered custom IPC) ─────────────────────────
export { IpcRegistry } from './utils/ipc-registry.js'
export type { SenderPolicy } from './utils/ipc-registry.js'

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
