import { app } from 'electron'
import type { RuntimeBackend } from '@dimina-kit/electron-deck'
import type { WorkbenchAppConfig } from '../../shared/types.js'
import { runDevtoolsBootstrap, createDevtoolsRuntime } from '../app/app.js'
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
  return {
    // The devtools window needs a per-session simulator preload partition set at
    // construction time, so the backend builds it (framework skips its own).
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
      const instance = await createDevtoolsRuntime(config)
      // Dispose the devtools context on quit: this is the backend's window, so
      // the framework's closed→shutdown is not wired to it — without this, the
      // compile session (a child process, torn down by closeProject) and the IPC
      // registry would leak on exit. Best-effort (before-quit doesn't await), but
      // it initiates the teardown the framework can't reach.
      app.once('before-quit', () => { void instance.dispose() })
    },
  }
}
