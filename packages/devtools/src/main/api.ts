// ── Primary API ──────────────────────────────────────────────────────────
// `launch` boots through the @dimina-kit/electron-deck framework
// (process-lifecycle gate + wire/trust) with the devtools RuntimeBackend
// supplying the full runtime. The instance builder (`createDevtoolsRuntime`) is
// internal — hosts integrate via `launch(config)`; the `WorkbenchAppInstance`
// type (what `onSetup(instance)` receives) is re-exported for typing host callbacks.
export { launch, buildDefaultMenu, openSettingsWindow } from './app/launch.js'
export type { WorkbenchAppInstance } from './app/app.js'

// ── Bootstrap utilities ──────────────────────────────────────────────────
export { suppressEpipe, setupCdpPort } from './app/bootstrap.js'

// ── Miniapp runtime contract (host-facing, stable) ───────────────────────
// The hand-written kernel surface a downstream host consumes; prefer this
// over depending on the full `WorkbenchContext`.
export { asMiniappRuntime } from './runtime/miniapp-runtime.js'
export type { MiniappRuntime } from './runtime/miniapp-runtime.js'

// ── Context & views (for module-assembly consumers) ──────────────────────
export { createWorkbenchContext } from './services/workbench-context.js'
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
  BuiltinPanelId,
  BuiltinModuleId,
  UpdateChecker,
  UpdateInfo,
} from '../shared/types.js'
