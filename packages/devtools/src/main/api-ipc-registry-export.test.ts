/**
 * Requirement A — `IpcRegistry` must be on the package's public export surface.
 *
 * The class already exists and is `export`ed from
 * `src/main/utils/ipc-registry.ts`, but the package root barrel
 * `src/main/api.ts` (the `.` entry in package.json `exports`) does NOT
 * re-export it. Downstream hosts that want to register their own gated IPC
 * handlers can't reach it without deep-importing an internal path.
 *
 * These tests import from `./api.js` (the relative path a file in
 * `src/main/` uses to hit the barrel). They are RED today because
 * `api.ts` has no `IpcRegistry` / `SenderPolicy` export.
 *
 * NOTE: the barrel module is read through a `Record<string, unknown>` cast
 * so this test file still compiles under `tsc` while the export is absent —
 * the failure is a deliberate *runtime* assertion failure, not a type error.
 * Once `api.ts` adds the export, the runtime assertions go green; the
 * type-level contract is covered separately by `api-types.test-d`-style
 * reasoning in the final assertion below.
 */
import { describe, it, expect, vi } from 'vitest'

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

  it('also re-exports the `SenderPolicy` type-only symbol from api.ts', async () => {
    // `SenderPolicy` is a *type*, with no runtime presence — a value import
    // can't observe it. Instead, scan api.ts's source text for the export so
    // a regression (dropping `export type { SenderPolicy }`) is still caught
    // by this runtime suite without forcing a separate `.test-d.ts` file.
    const fs = await import('node:fs/promises')
    const url = await import('node:url')
    const path = await import('node:path')
    const apiPath = path.resolve(
      path.dirname(url.fileURLToPath(import.meta.url)),
      'api.ts',
    )
    const src = await fs.readFile(apiPath, 'utf8')

    expect(
      /\bSenderPolicy\b/.test(src),
      'expected src/main/api.ts to re-export the `SenderPolicy` type',
    ).toBe(true)
  })
})
