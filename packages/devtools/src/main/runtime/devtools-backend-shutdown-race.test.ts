/**
 * `createDevtoolsBackend`'s `onShutdown` vs. in-flight `assemble()` ordering
 * contract.
 *
 * Background: publishing `instance` EARLY from `assemble` (see
 * `devtools-backend-before-quit.test.ts` — needed so the `before-quit` hook
 * can dispose the host-toolbar view even while a slow host `config.onSetup`
 * is still pending) opened a NEW race. `onShutdown` is driven by the
 * framework's SEPARATE `will-quit` → `shutdown()` chain, independent of
 * `before-quit`. With `instance` non-null early, `onShutdown` could call
 * `instance.dispose()` (→ `disposeContext` → `ctx.registry.dispose()`) WHILE
 * `createDevtoolsRuntime`'s own async body is still running PAST `onSetup`
 * — e.g. the `config.updateChecker` wiring that does
 * `context.registry.add(() => instance.updateManager!.dispose())` right
 * after `onSetup` resolves. `DisposableRegistry.add()` throws "cannot add to
 * disposed registry" in that ordering instead of a clean teardown. The fix:
 * `onShutdown` now awaits `assemble`'s own in-flight promise before
 * disposing.
 *
 * Shares the electron/fs/`@dimina-kit/devkit`/view-manager mock harness with
 * `devtools-backend-before-quit.test.ts` via
 * `devtools-backend-before-quit.harness.ts` (kept in one place to stay under
 * the file-length ratchet without duplicating ~350 lines of mock setup).
 */
import { describe, it, expect, vi } from 'vitest'
import {
  registerBackendTestLifecycle,
  startAssemblingWithGatedOnSetup,
} from './devtools-backend-before-quit.harness.js'

const backendTest = registerBackendTestLifecycle()

describe('createDevtoolsBackend: onShutdown waits for in-flight assembly', () => {
  it('onShutdown firing while onSetup is still pending does not throw — waits for assembly to finish before disposing', async () => {
    vi.useFakeTimers()
    try {
      const { backend, assemblePromise, releaseOnSetup } = await startAssemblingWithGatedOnSetup(
        backendTest.createDevtoolsBackend,
        {
          // Adds `context.registry.add(() => instance.updateManager!.dispose())`
          // right after `onSetup` resolves — the exact post-onSetup registry
          // mutation `onShutdown` must not race ahead of.
          updateChecker: {
            checkForUpdates: vi.fn(async () => null),
            downloadUpdate: vi.fn(async () => ''),
          },
        },
      )

      // `will-quit` → `shutdown()` → `onShutdown()` firing while `onSetup` is
      // still pending — must not reject/throw even though `instance` is
      // already non-null.
      const shutdownPromise = backend.onShutdown?.()

      releaseOnSetup()
      await expect(assemblePromise).resolves.toBeUndefined()
      await expect(shutdownPromise).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
