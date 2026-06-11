import type { RuntimeBackend } from '@dimina-kit/electron-deck'
import type { WorkbenchAppConfig } from '../../shared/types.js'
import { runDevtoolsBootstrap, createDevtoolsRuntime } from '../app/app.js'
import type { WorkbenchAppInstance } from '../app/app.js'
import { registerAppLifecycle } from '../app/lifecycle.js'

/**
 * Adapts the devtools runtime into a {@link RuntimeBackend} the framework
 * (`@dimina-kit/electron-deck`) orchestrates. The framework owns the process
 * lifecycle gate (whenReady) + wire/trust primitives; the backend supplies the
 * full devtools assembly — reusing the exact same `runDevtoolsBootstrap` / `createDevtoolsRuntime`
 * assembly bodies (extracted from the former createWorkbenchApp), so the app is
 * byte-identical to the pre-extraction behaviour (no behavioural re-creation).
 *
 * v2 scope: the backend owns window creation (the framework skips its own when a
 * backend is present), so `assemble` ignores the framework `runtime` and builds
 * the real devtools main window itself. Trust/frame unification and surfacing
 * the runtime facade are deferred (see framework-extraction-v2.md §7).
 */
export function createDevtoolsBackend(config: WorkbenchAppConfig = {}): RuntimeBackend {
  // Hoisted so `onShutdown` can reach the assembled context (assigned by `assemble`).
  let instance: WorkbenchAppInstance | null = null
  return {
    // The backend builds the devtools main window itself (framework skips its own).
    // Its only construction-time needs are the host preload + `sandbox:false`
    // (main-window/create.ts) and wrapping contentView in a `View` container.
    // NOTE: `ownsWindows` is NOT structurally required — the framework's
    // `mainWindowWebPreferences()` + `onMainWindowCreated()` hooks can supply both,
    // and the project close→back lifecycle maps onto the Window facade's
    // `onClose`/`newSession` (probe-validated). Retained for now; migrating to
    // `runtime.windows.main` is the documented next step. (The `persist:simulator`
    // partition is a fixed session used by child WCVs, not main-window state.)
    ownsWindows: true,
    // Pre-ready: app name / CDP port / CSP / privileged scheme — must run before
    // the framework awaits app.whenReady().
    beforeReady: () => {
      runDevtoolsBootstrap(config)
    },
    // Setup (post-whenReady): app lifecycle (window-all-closed → quit) + the
    // full devtools assembly.
    assemble: async () => {
      registerAppLifecycle()
      instance = await createDevtoolsRuntime(config)
    },
    // Dispose the devtools context during the framework's deterministic shutdown
    // (app.on('will-quit') → shutdown() → runShutdownCleanup(), awaited once).
    // Without this, the compile session (a child process, torn down by
    // closeProject) and the IPC registry would leak on exit. The framework awaits
    // this hook, so teardown is no longer a best-effort before-quit reach-around.
    onShutdown: () => instance?.dispose(),
  }
}
