/**
 * The MiniappRuntime contract must be on the package's PUBLIC export surface
 * (`.` entry → src/main/api.ts), so a downstream host is not forced onto
 * `import type { WorkbenchContext } from '@dimina-kit/devtools/context'` (the
 * whole internal grab-bag) and broken by every internal refactor.
 *
 * `api.ts` must re-export both `asMiniappRuntime` and the `MiniappRuntime` type.
 * Pattern mirrors api-ipc-registry-export.test.ts: the barrel is read through a
 * `Record<string, unknown>` cast so a missing runtime export is a RUNTIME
 * assertion failure, while the type re-export is pinned by the `MiniappRuntime`
 * type alias below as a permanent compile-time guard.
 */
import { describe, expect, it, vi } from 'vitest'
import type * as Barrel from './api.js'

// Compile-time contract for the `MiniappRuntime` type-only re-export.
type MiniappRuntimeFromBarrel = Barrel.MiniappRuntime
const _barrelTypePin: MiniappRuntimeFromBarrel | undefined = undefined

// api.ts transitively touches electron at module scope (launch/app wiring).
// Stub it so the barrel loads outside Electron — same stub as the existing
// barrel-export test.
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

describe('R3: api.ts re-exports the MiniappRuntime contract', () => {
  it('exposes `asMiniappRuntime` from the package root barrel', async () => {
    // Real bug: the contract module exists but stays internal — downstream
    // hosts can't adopt it without deep-importing dist paths, so they keep
    // depending on `/context` and the contract never actually decouples them.
    const api = await loadBarrel()
    expect(
      api.asMiniappRuntime,
      'expected `asMiniappRuntime` to be re-exported from src/main/api.ts (the `.` package entry)',
    ).toBeDefined()
    expect(typeof api.asMiniappRuntime).toBe('function')
  })

  it('the barrel `asMiniappRuntime` is the SAME function as the internal one', async () => {
    // Real bug: api.ts grows a second, divergent helper (e.g. a projection
    // copy) instead of re-exporting the sentinel-bearing original — the
    // assignment-compat sentinel then no longer guards what hosts call.
    const api = await loadBarrel()
    const internal = await import('./runtime/miniapp-runtime.js')
    expect(api.asMiniappRuntime).toBe(internal.asMiniappRuntime)
  })

  it('the barrel `asMiniappRuntime` is an identity return', async () => {
    // Real bug: a wrapper/projection return breaks a downstream host's monkey-patch of
    // workspace.openProject (it would patch a dead copy).
    const api = await loadBarrel()
    const fn = api.asMiniappRuntime as ((ctx: unknown) => unknown) | undefined
    expect(fn, 'asMiniappRuntime must be exported before identity can be checked').toBeDefined()
    const fake = { tag: 'fake-context' }
    expect(fn?.(fake)).toBe(fake)
  })

  it('also re-exports the `MiniappRuntime` type-only symbol [inverse marker — see header]', () => {
    // The real assertion is the `Barrel.MiniappRuntime` type alias at the top
    // of this file; this `it` exists so the contract surfaces in the test
    // report and the pin stays consumed.
    expect(_barrelTypePin).toBeUndefined()
  })
})
