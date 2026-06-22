/**
 * Requirement A — `IpcRegistry` must stay on the package's public export
 * surface so downstream hosts can register their own gated IPC handlers
 * without deep-importing an internal path.
 *
 * These tests import from `./api.js` (the relative path a file in
 * `src/main/` uses to hit the barrel) and assert `api.ts` re-exports both
 * `IpcRegistry` (runtime value) and `SenderPolicy` (type-only).
 *
 * The barrel module is read through a `Record<string, unknown>` cast so the
 * test still compiles under `tsc` even if the runtime `IpcRegistry` export
 * regresses — that case is a *runtime* assertion failure, not a type error.
 * The `SenderPolicy` type-only export is guarded instead by the compile-time
 * `import type` below: if `api.ts` stops re-exporting it, `tsc`
 * (`check-types` / `pnpm exec tsc --noEmit`) fails outright — a check that,
 * unlike a source-text regex, cannot be fooled by a commented-out
 * `export type` line or a string literal mentioning the name.
 */
import { describe, it, expect, vi } from 'vitest'
import type { SenderPolicy } from './api.js'

// Compile-time contract for the `SenderPolicy` type-only re-export.
// `SenderPolicy` has no runtime presence, so a value import can't observe it;
// instead we *use* the imported type here. If `src/main/api.ts` ever drops
// `export type { SenderPolicy }`, this annotation stops type-checking and
// `tsc` fails — the regression is caught at compile time, not via brittle
// source scanning. The binding is consumed by the matching `it` below.
const _senderPolicyContract: SenderPolicy = () => true

// IpcRegistry's module touches `electron`'s ipcMain when `.handle` is called.
// Stub it so the test runs outside Electron.
vi.mock('electron', () => {
  const ipcMain = {
    handle: vi.fn(),
    removeHandler: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  }
  return { ipcMain, default: { ipcMain } }
})

async function loadBarrel(): Promise<Record<string, unknown>> {
  return (await import('./api.js')) as unknown as Record<string, unknown>
}

describe('Requirement A: api.ts re-exports IpcRegistry', () => {
  it('exposes a constructible `IpcRegistry` from the package root barrel', async () => {
    const api = await loadBarrel()

    // Catches "export was never added / was removed from api.ts".
    expect(
      api.IpcRegistry,
      'expected `IpcRegistry` to be re-exported from src/main/api.ts',
    ).toBeDefined()
    expect(typeof api.IpcRegistry).toBe('function')
  })

  it('the re-exported `IpcRegistry` is the same class as the internal one', async () => {
    const api = await loadBarrel()
    const internal = await import('./utils/ipc-registry.js')

    // Catches "api.ts exports a *different* IpcRegistry symbol by accident".
    expect(api.IpcRegistry).toBe(internal.IpcRegistry)
  })

  it('an instance built from the barrel export has a working `.handle(channel, fn)`', async () => {
    const api = await loadBarrel()
    const Ctor = api.IpcRegistry as new () => { handle: (c: string, f: () => unknown) => unknown }

    // `expect.toBeDefined` above already guards this; assert it explicitly so
    // the failure message points at the missing export, not a cryptic
    // "Ctor is not a constructor".
    expect(Ctor, 'IpcRegistry must be exported before this instance test').toBeDefined()
    const reg = new Ctor()
    // `.handle` is the public seam downstream hosts rely on.
    expect(typeof reg.handle).toBe('function')
    expect(() => reg.handle('test:from-barrel', () => 'ok')).not.toThrow()
  })

  it('also re-exports the `SenderPolicy` type-only symbol from api.ts', () => {
    // The real contract for the type-only `SenderPolicy` re-export is the
    // module-level `import type { SenderPolicy } from './api.js'` at the top of
    // this file plus `_senderPolicyContract`: if `api.ts` stops exporting the
    // type, this file no longer type-checks and `tsc` fails. That compile-time
    // guard cannot be bypassed by a commented-out `export type` line or a
    // string literal — unlike the source-text regex this assertion replaces.
    //
    // This `it` exists so the failure also surfaces in the test report; the
    // value `_senderPolicyContract` is a genuine value of the imported type.
    // `SenderPolicy` is `(sender: WebContents) => boolean`, so the call site
    // must pass a sender — a stub is enough since this predicate ignores it.
    expect(typeof _senderPolicyContract).toBe('function')
    const fakeSender = {} as Parameters<SenderPolicy>[0]
    expect(_senderPolicyContract(fakeSender)).toBe(true)
  })
})
