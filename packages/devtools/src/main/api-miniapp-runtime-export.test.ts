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

// Same guard for the three page-bridge types — a downstream host's sidebar/
// dialog page needs these to type `window.diminaHostSidebar`/`diminaHostDialog`
// without importing the internal runtime module directly.
type ToolbarBridgeFromBarrel = Barrel.DiminaHostToolbarPageBridge
type SidebarBridgeFromBarrel = Barrel.DiminaHostSidebarPageBridge
type DialogBridgeFromBarrel = Barrel.DiminaHostDialogPageBridge
const _bridgeTypePins: [
  ToolbarBridgeFromBarrel | undefined,
  SidebarBridgeFromBarrel | undefined,
  DialogBridgeFromBarrel | undefined,
] = [undefined, undefined, undefined]

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

// Static, module-scope import rather than a per-test dynamic `import()`:
// api.ts's module graph is heavy enough (transitively touches electron at
// module scope) that first evaluation can exceed vitest's default 5s
// per-test timeout under load. A static import pays that cost once during
// test collection, outside any single test's timer, instead of charging it
// against whichever test happens to run the import first.
import * as apiBarrel from './api.js'
import * as internalRuntime from './runtime/miniapp-runtime.js'

const api = apiBarrel as unknown as Record<string, unknown>

describe('R3: api.ts re-exports the MiniappRuntime contract', () => {
  it('exposes `asMiniappRuntime` from the package root barrel', () => {
    // Real bug: the contract module exists but stays internal — downstream
    // hosts can't adopt it without deep-importing dist paths, so they keep
    // depending on `/context` and the contract never actually decouples them.
    expect(
      api.asMiniappRuntime,
      'expected `asMiniappRuntime` to be re-exported from src/main/api.ts (the `.` package entry)',
    ).toBeDefined()
    expect(typeof api.asMiniappRuntime).toBe('function')
  })

  it('the barrel `asMiniappRuntime` is the SAME function as the internal one', () => {
    // Real bug: api.ts grows a second, divergent helper (e.g. a projection
    // copy) instead of re-exporting the sentinel-bearing original — the
    // assignment-compat sentinel then no longer guards what hosts call.
    expect(api.asMiniappRuntime).toBe(internalRuntime.asMiniappRuntime)
  })

  it('the barrel `asMiniappRuntime` is an identity return', () => {
    // Real bug: a wrapper/projection return breaks a downstream host's monkey-patch of
    // workspace.openProject (it would patch a dead copy).
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

  it('also re-exports the toolbar/sidebar/dialog page-bridge types [inverse marker — see header]', () => {
    // The real assertion is the three `Barrel.DiminaHost*PageBridge` type
    // aliases above; this `it` exists so the contract surfaces in the test
    // report and the pins stay consumed.
    expect(_bridgeTypePins).toEqual([undefined, undefined, undefined])
  })
})
