/**
 * Shared vitest mock harness for `devtools-backend-before-quit.test.ts` and
 * `devtools-backend-shutdown-race.test.ts` — both drive the REAL
 * `createDevtoolsBackend`/`createDevtoolsRuntime` against the electron/fs/
 * `@dimina-kit/devkit` mock set defined in `./devtools-runtime-mock.harness.ts`,
 * plus the view-manager spy shim and backend-lifecycle helpers below that
 * only these two tests need.
 *
 * `vi.mock(...)` calls in the imported core module run once per importing
 * test file's own isolated module graph (vitest scopes mocking per test
 * file); chaining through this module has the same effect as if they were
 * written directly in the importing file — both test files' `beforeEach`
 * still dynamically `await import('./devtools-backend.js')` AFTER
 * `vi.resetModules()`, well after the core module's mock registrations have
 * already run.
 */
import { beforeEach, expect, vi } from 'vitest'
import type { WorkbenchAppConfig } from '../../shared/types.js'
import type { RuntimeBackend } from '@dimina-kit/electron-deck'
import { stubs, devkitStubs } from './devtools-runtime-mock.harness.js'

// ── view-manager spy shim ───────────────────────────────────────────────
// `createDevtoolsBackend` keeps its assembled `instance` in a private
// closure — the returned `RuntimeBackend` exposes no getter for
// `instance.context.views`. Wrapping `createViewManager` here (real
// implementation, just observed) gives the test a handle on the exact
// `ViewManager` the backend's `assemble` wires up, equivalent to
// `vi.spyOn(instance.context.views, 'disposeAll')` without needing the
// backend to leak its internals.
const viewManagerStubs = vi.hoisted(() => ({
  createdManagers: [] as Array<{ disposeAll: () => void }>,
}))

vi.mock('../services/views/view-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/views/view-manager.js')>()
  return {
    ...actual,
    createViewManager: (ctx: Parameters<typeof actual.createViewManager>[0]) => {
      const real = actual.createViewManager(ctx)
      vi.spyOn(real, 'disposeAll')
      viewManagerStubs.createdManagers.push(real)
      return real
    },
  }
})

export { stubs, devkitStubs } from './devtools-runtime-mock.harness.js'
export { viewManagerStubs }

/**
 * Shared per-test setup both `devtools-backend-before-quit.test.ts` and
 * `devtools-backend-shutdown-race.test.ts` need identically: reset modules
 * (fresh `let`-scoped module-level state in `devtools-backend.ts` each
 * test), reset the mock harness above, and dynamically re-import `electron`
 * + `createDevtoolsBackend` — dynamic, not a static top-level import,
 * because it must happen AFTER `vi.resetModules()` picks up a fresh module
 * instance each test. Registers its own `beforeEach`; call once per
 * describing test file. Returns a mutable state object (not individual
 * values) because `beforeEach` reassigns its fields once per test, after
 * this function itself has already returned.
 */
export interface BackendTestState {
  createDevtoolsBackend: typeof import('./devtools-backend.js').createDevtoolsBackend
  electron: typeof import('electron')
}

export function registerBackendTestLifecycle(): BackendTestState {
  const state = {} as BackendTestState
  beforeEach(async () => {
    vi.resetModules()
    stubs.reset()
    devkitStubs.sessionClose.mockClear()
    viewManagerStubs.createdManagers.length = 0
    state.electron = await import('electron')
    ;({ createDevtoolsBackend: state.createDevtoolsBackend } = await import('./devtools-backend.js'))
  })
  return state
}

/**
 * Shared setup for the two tests (one in `devtools-backend-before-quit.test.ts`,
 * one in `devtools-backend-shutdown-race.test.ts`) that need to observe
 * `assemble()` PAUSED mid-flight, inside a still-pending `config.onSetup`:
 * builds the backend with a gated `onSetup`, runs `beforeReady`/`assemble`,
 * and waits until the assembled `ViewManager` is actually reachable (proof
 * `createDevtoolsRuntime` has progressed past instance construction) before
 * handing control back — the caller then fires whatever quit-path event it's
 * testing while `onSetup` is still gated, and is responsible for calling
 * `releaseOnSetup()` + awaiting `assemblePromise` itself.
 */
export async function startAssemblingWithGatedOnSetup(
  createDevtoolsBackend: BackendTestState['createDevtoolsBackend'],
  extraConfig: Omit<WorkbenchAppConfig, 'onSetup'> = {},
): Promise<{
  backend: RuntimeBackend
  assemblePromise: Promise<void>
  releaseOnSetup: () => void
}> {
  let releaseOnSetup: () => void = () => {}
  const onSetupGate = new Promise<void>((resolve) => {
    releaseOnSetup = resolve
  })

  const backend = createDevtoolsBackend({
    ...extraConfig,
    onSetup: async () => {
      await onSetupGate
    },
  })

  backend.beforeReady?.(
    {} as unknown as Parameters<NonNullable<typeof backend.beforeReady>>[0],
  )
  const assemblePromise = Promise.resolve(
    backend.assemble({} as unknown as Parameters<typeof backend.assemble>[0]),
  )

  // Let `assemble` progress through `createDevtoolsRuntime` up to (and into)
  // the pending `onSetup` gate — the instance must exist by then.
  await vi.waitFor(() => {
    expect(viewManagerStubs.createdManagers.length).toBeGreaterThan(0)
  })

  return { backend, assemblePromise, releaseOnSetup }
}
