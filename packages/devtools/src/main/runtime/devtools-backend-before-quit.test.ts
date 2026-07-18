/**
 * `createDevtoolsBackend`'s `assemble` before-quit teardown wiring contract.
 *
 * Background: Electron's `will-quit` does NOT wait for async teardown, so the
 * host-toolbar `WebContentsView` + its `MessagePortMain` leak into Chromium's
 * native shutdown teardown (a later JS `'destroyed'` handler closing the port
 * then crashes natively — a real Sentry-reported crash). The fix tears the
 * view down EARLIER and SYNCHRONOUSLY, at `before-quit`, by wiring
 * `registerAppLifecycle`'s optional hook (see `lifecycle-before-quit-hook.test.ts`
 * for that half of the contract) to `instance.context.views.disposeAll()`.
 *
 * Approach taken: the FULL integration path (real `createDevtoolsRuntime`
 * against the harness lifted from `quit-flag-onclose.test.ts`) IS practical
 * here — `assemble`'s `runtime` argument is provably unused by the current
 * implementation (`assemble: async () => { ... }` ignores it), so a fake
 * placeholder value satisfies the call without needing to fake the framework
 * `Runtime` shape. The one real obstacle is that `createDevtoolsBackend`
 * closes over its assembled `instance` privately — nothing in the returned
 * `RuntimeBackend` exposes `instance.context.views` for an external
 * `vi.spyOn(...)` post-construction. This is solved by partially mocking
 * `../services/views/view-manager.js`: `createViewManager` is wrapped to
 * `vi.spyOn` the REAL `ViewManager` it returns (behavior untouched, just
 * observed) and record the instance, giving the test a handle equivalent to
 * `instance.context.views` without reaching into the backend's closure.
 *
 * The mock harness (electron/fs/`@dimina-kit/devkit`/view-manager) is shared
 * with `devtools-backend-shutdown-race.test.ts` via
 * `devtools-backend-before-quit.harness.ts` to stay under the file-length
 * ratchet without duplicating ~350 lines of setup between the two files.
 */
import { describe, it, expect } from 'vitest'
import {
  registerBackendTestLifecycle,
  startAssemblingWithGatedOnSetup,
  viewManagerStubs,
} from './devtools-backend-before-quit.harness.js'

const backendTest = registerBackendTestLifecycle()

function emitBeforeQuit(): void {
  ;(backendTest.electron.app as unknown as {
    emit: (event: string, ...args: unknown[]) => void
  }).emit('before-quit', { preventDefault: () => {} })
}

describe('createDevtoolsBackend: assemble wires before-quit teardown', () => {
  it('emitting before-quit after assemble disposes the assembled ViewManager synchronously', async () => {
    const backend = backendTest.createDevtoolsBackend({})

    backend.beforeReady?.(
      {} as unknown as Parameters<NonNullable<typeof backend.beforeReady>>[0],
    )
    await backend.assemble(
      {} as unknown as Parameters<typeof backend.assemble>[0],
    )

    const views = viewManagerStubs.createdManagers.at(-1)
    expect(
      views,
      'assemble must have constructed a ViewManager via createViewManager',
    ).toBeDefined()
    expect(views?.disposeAll).not.toHaveBeenCalled()

    emitBeforeQuit()

    expect(
      views?.disposeAll,
      'before-quit must synchronously tear down the assembled ViewManager '
      + '(host-toolbar view + its MessagePortMain) BEFORE will-quit, so the '
      + 'view never leaks into Chromium native shutdown teardown',
    ).toHaveBeenCalledTimes(1)
  })

  // Regression: adversarial review found that `instance` was only assigned
  // from `createDevtoolsRuntime`'s RETURN VALUE, which resolves only after
  // awaiting `config.onSetup(instance)` — arbitrary host code that can itself
  // load the host-toolbar (a live MessagePort). A quit during that window saw
  // `instance === null` in the before-quit hook and silently no-opped,
  // leaving the original native-crash race reachable. The fix publishes
  // `instance` via an `onInstanceCreated` callback fired the instant the
  // instance is constructed, before `onSetup` is awaited.
  it('before-quit fired WHILE a slow config.onSetup is still pending still disposes the ViewManager', async () => {
    const { assemblePromise, releaseOnSetup } = await startAssemblingWithGatedOnSetup(
      backendTest.createDevtoolsBackend,
    )

    const views = viewManagerStubs.createdManagers.at(-1)
    expect(views?.disposeAll).not.toHaveBeenCalled()

    emitBeforeQuit()

    expect(
      views?.disposeAll,
      'the instance (and its ViewManager) must already be reachable from the '
      + 'before-quit hook while onSetup is still in flight, not only after '
      + 'assemble() fully resolves',
    ).toHaveBeenCalledTimes(1)

    releaseOnSetup()
    await assemblePromise
  })

  // Regression: the reverse race — before-quit fires before the instance
  // exists at all (e.g. during `app.whenReady()`), so the hook above ran
  // with nothing to dispose yet. The instance-creation path self-heals by
  // checking `isAppQuitting()` the moment the instance becomes available.
  it('before-quit fired BEFORE the instance exists still disposes it once created (self-heal)', async () => {
    const backend = backendTest.createDevtoolsBackend({})

    backend.beforeReady?.(
      {} as unknown as Parameters<NonNullable<typeof backend.beforeReady>>[0],
    )
    const assemblePromise = backend.assemble(
      {} as unknown as Parameters<typeof backend.assemble>[0],
    )
    // `registerAppLifecycle()` runs synchronously at the top of `assemble`,
    // before its first `await` — the listener is live now, and the instance
    // does not exist yet. Firing here has nothing to dispose.
    emitBeforeQuit()

    await assemblePromise

    const views = viewManagerStubs.createdManagers.at(-1)
    expect(
      views?.disposeAll,
      'an instance constructed after before-quit already fired must still '
      + 'be torn down immediately once it exists, not left live forever',
    ).toHaveBeenCalledTimes(1)
  })
})
