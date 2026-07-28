import type { RuntimeBackend } from '@dimina-kit/electron-deck'
import type { WorkbenchAppConfig } from '../../shared/types.js'
import { runDevtoolsBootstrap, createDevtoolsRuntime } from '../app/app.js'
import type { WorkbenchAppInstance } from '../app/app.js'
import { isAppQuitting, registerAppLifecycle } from '../app/lifecycle.js'

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
 * the runtime facade are deferred.
 *
 * NOT migrating onto deck's high-level host API (Window facade / runtime.view /
 * DeckSession / grants) is a DELIBERATE, reviewed decision — not a backlog item.
 * The ROI matrix (every candidate NO-GO) + revisit conditions live in
 * docs/deck-adoption-decision.md. Read it before re-proposing such a migration.
 */
export function createDevtoolsBackend(config: WorkbenchAppConfig = {}): RuntimeBackend {
  // Hoisted so `onShutdown` can reach the assembled context (assigned by `assemble`).
  let instance: WorkbenchAppInstance | null = null
  // `assemble`'s own in-flight promise: `instance` is now published EARLY (see
  // below), before `createDevtoolsRuntime`'s async body — including the host's
  // `config.onSetup(instance)` and everything after it — has finished running.
  // `onShutdown` must wait for THIS to settle before disposing: disposing
  // `instance.context.registry` while `createDevtoolsRuntime` is still adding
  // entries to that same registry (e.g. the `updateChecker`/`setupMcp` wiring
  // that runs after `onSetup`) hits `DisposableRegistry.add()`'s "cannot add
  // to disposed registry" throw instead of a clean teardown.
  let assembling: Promise<void> | null = null
  return {
    // The backend builds the devtools main window itself (framework skips its own).
    // Its only construction-time needs are the host preload + `sandbox:false`
    // (main-window/create.ts) and wrapping contentView in a `View` container.
    // NOTE: `ownsWindows` is NOT structurally required — the framework's
    // `mainWindowWebPreferences()` + `onMainWindowCreated()` hooks can supply both,
    // and the project close→back lifecycle maps onto the Window facade's
    // `onClose`/`newSession` (probe-validated). It is RETAINED BY DECISION, not
    // inertia: migrating to `runtime.windows.main` buys no user value at high
    // regression cost (see docs/deck-adoption-decision.md, F1). (The
    // `persist:simulator` partition is a fixed session used by child WCVs, not
    // main-window state.)
    ownsWindows: true,
    // Pre-ready: app name / CDP port / CSP / privileged scheme — must run before
    // the framework awaits app.whenReady().
    beforeReady: () => {
      runDevtoolsBootstrap(config)
    },
    // Setup (post-whenReady): app lifecycle (window-all-closed → quit) + the
    // full devtools assembly.
    assemble: async () => {
      // `onBeforeQuit` runs synchronously at Electron's `before-quit` — main
      // loop still fully healthy, well before `will-quit`'s unawaited
      // `shutdown()` and any window/WebContentsView destruction. Disposing
      // the host-scoped views (host-toolbar's WebContentsView + its
      // MessagePortMain) here, instead of leaving them to `onShutdown`'s
      // best-effort async teardown, keeps them from surviving into
      // Chromium's native shutdown sequence, where a late `'destroyed'`
      // handler closing an already-torn-down MessagePort segfaults natively.
      // Safe to run again from `onShutdown`'s `instance.dispose()` afterwards
      // — `views.disposeAll()` and its constituents are dispose-idempotent.
      registerAppLifecycle(() => instance?.context.views.disposeAll())
      // `onInstanceCreated` (not the return value) is what assigns `instance`:
      // `createDevtoolsRuntime` awaits the host's `config.onSetup(instance)`
      // — which may run arbitrarily long and can itself load the host toolbar
      // (a live MessagePort) — before returning. Waiting for the return value
      // would leave `instance` null, and the before-quit hook above a no-op,
      // for that entire window. Publishing from the callback closes it.
      assembling = createDevtoolsRuntime(config, (created) => {
        instance = created
        // Quit may have already started (before-quit already fired) before
        // this instance existed, so the hook above ran with nothing to
        // dispose. Self-heal: run the same teardown now that there is.
        if (isAppQuitting()) instance.context.views.disposeAll()
      }).then(() => {})
      await assembling
    },
    // Dispose the devtools context during the framework's deterministic shutdown
    // (app.on('will-quit') → shutdown() → runShutdownCleanup(), awaited once).
    // Without this, the compile session (a child process, torn down by
    // closeProject) and the IPC registry would leak on exit. The framework awaits
    // this hook, so teardown is no longer a best-effort before-quit reach-around.
    //
    // Waits for `assembling` first: `instance` can be non-null (published
    // early, above) while `createDevtoolsRuntime`'s own async body — the
    // host's `onSetup` and everything scheduled after it — is still running
    // and still adding entries to `instance.context.registry`. Disposing
    // that registry out from under an in-flight assembly throws instead of
    // tearing down cleanly (`DisposableRegistry.add` rejects post-dispose).
    // `.catch()` here: assembly failing is `assemble`'s problem to surface,
    // not a reason to skip disposing whatever DID get constructed.
    onShutdown: async () => {
      await assembling?.catch(() => {})
      await instance?.dispose()
    },
  }
}
