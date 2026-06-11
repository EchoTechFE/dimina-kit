/**
 * R3 — the MiniappRuntime contract must be on the package's PUBLIC export
 * surface (`.` entry → src/main/api.ts).
 *
 * Today `src/main/runtime/miniapp-runtime.ts` exists but is reachable only by
 * deep-importing an internal path; qdmp is forced onto
 * `import type { WorkbenchContext } from '@dimina-kit/devtools/context'` —
 * the whole internal grab-bag — and gets broken by every internal refactor.
 *
 * RED today (vitest): `api.ts` re-exports neither `asMiniappRuntime` nor the
 * `MiniappRuntime` type. Pattern mirrors api-ipc-registry-export.test.ts: the
 * barrel is read through a `Record<string, unknown>` cast so the missing
 * runtime export is a deliberate RUNTIME assertion failure, while the missing
 * TYPE export is expressed inversely via a `@ts-expect-error RED` marker that
 * turns into an unused-directive compile error (TS2578) the moment the
 * re-export lands — the implementer then deletes the directive, leaving the
 * type alias as the permanent compile-time guard.
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
  it('exposes `asMiniappRuntime` from the package root barrel [RED today]', async () => {
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

  it('the barrel `asMiniappRuntime` is the SAME function as the internal one [RED today]', async () => {
    // Real bug: api.ts grows a second, divergent helper (e.g. a projection
    // copy) instead of re-exporting the sentinel-bearing original — the
    // assignment-compat sentinel then no longer guards what hosts call.
    const api = await loadBarrel()
    const internal = await import('./runtime/miniapp-runtime.js')
    expect(api.asMiniappRuntime).toBe(internal.asMiniappRuntime)
  })

  it('the barrel `asMiniappRuntime` is an identity return [RED today]', async () => {
    // Real bug: a wrapper/projection return breaks qdmp's monkey-patch of
    // workspace.openProject (it would patch a dead copy).
    const api = await loadBarrel()
    const fn = api.asMiniappRuntime as ((ctx: unknown) => unknown) | undefined
    expect(fn, 'asMiniappRuntime must be exported before identity can be checked').toBeDefined()
    const fake = { tag: 'fake-context' }
    expect(fn?.(fake)).toBe(fake)
  })

  it('also re-exports the `MiniappRuntime` type-only symbol [inverse marker — see header]', () => {
    // The real assertion is the `@ts-expect-error RED(R3)` marker on the
    // `Barrel.MiniappRuntime` alias at the top of this file; this `it` exists
    // so the contract surfaces in the test report and the pin stays consumed.
    expect(_barrelTypePin).toBeUndefined()
  })
})
