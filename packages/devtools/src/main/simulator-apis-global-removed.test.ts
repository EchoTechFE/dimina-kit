/**
 * Step 3 of the devtools extension model — "simulator-api per-context",
 * Requirement D: the process-global registration surface is DELETED.
 *
 * `docs/extension-model.md` §4 / step 3 ("删进程全局 `registerSimulatorApi`
 * 与 `simulatorApiRegistry` 单例") mandates a clean break:
 *
 *  D1. `src/main/services/simulator/custom-apis.ts` no longer exports a
 *      process-global `simulatorApiRegistry` singleton.
 *  D2. `src/main/simulator-apis.ts` — the thin wrapper holding the free
 *      `registerSimulatorApi(name, handler)` function — is deleted entirely.
 *  D3. `src/main/api.ts` (the package root barrel) no longer re-exports
 *      `registerSimulatorApi`; the `SimulatorApiHandler` TYPE is still
 *      exported (it is part of `instance.registerSimulatorApi`'s signature),
 *      re-routed through `./services/simulator/custom-apis.js`.
 *  D4. `package.json` drops the `./simulator-apis` subpath export.
 *  D5. The factory + interface + handler type SURVIVE in custom-apis.ts:
 *      `SimulatorApiHandler`, `SimulatorApiRegistry`, `createSimulatorApiRegistry`.
 *
 * All assertions are RED today: the global, the wrapper file, the barrel
 * export and the subpath all still exist. After step 3 they go green.
 *
 * Strategy: this suite mixes a runtime value import (for `api.ts` — its
 * exports have runtime presence) with source-text scans (for the deleted
 * file, the deleted subpath, and the type-only `SimulatorApiHandler`
 * re-export — types have no runtime presence). The source-scan technique
 * mirrors `api-ipc-registry-export.test.ts`'s `SenderPolicy` assertion.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFile, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url)) // …/src/main
const repoFile = (rel: string) => resolve(HERE, rel)

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

// `api.ts` transitively touches `electron` (ipcMain) — stub it so a value
// import of the barrel works outside Electron.
vi.mock('electron', () => {
  const ipcMain = { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
  const session = {
    fromPartition: vi.fn(() => ({
      webRequest: { onBeforeSendHeaders: vi.fn(), onHeadersReceived: vi.fn() },
      registerPreloadScript: vi.fn(),
    })),
  }
  return { ipcMain, session, app: { getPath: vi.fn(() => '/tmp') }, default: { ipcMain } }
})

async function loadBarrel(): Promise<Record<string, unknown>> {
  return (await import('./api.js')) as unknown as Record<string, unknown>
}

// ── D2 — src/main/simulator-apis.ts is deleted ──────────────────────────────

describe('Requirement D2: the simulator-apis.ts wrapper file is deleted', () => {
  it('src/main/simulator-apis.ts no longer exists on disk', async () => {
    // Catches: the file (and its free `registerSimulatorApi`) was kept around.
    expect(
      await exists(repoFile('simulator-apis.ts')),
      'src/main/simulator-apis.ts must be deleted (step 3 — clean break)',
    ).toBe(false)
  })
})

// ── D1 — the process-global singleton export is removed ─────────────────────

describe('Requirement D1: custom-apis.ts drops the global simulatorApiRegistry', () => {
  it('custom-apis.ts has no `export const simulatorApiRegistry` line', async () => {
    const src = await readFile(repoFile('services/simulator/custom-apis.ts'), 'utf8')
    // Catches: the process-global singleton kept (the multi-context bug).
    expect(
      /export\s+const\s+simulatorApiRegistry\b/.test(src),
      'custom-apis.ts must NOT export a process-global `simulatorApiRegistry` singleton',
    ).toBe(false)
  })

  it('the custom-apis module no longer exposes a `simulatorApiRegistry` value', async () => {
    const mod = (await import('./services/simulator/custom-apis.js')) as unknown as Record<string, unknown>
    // Runtime confirmation: even an aliased re-export would be caught here.
    expect(
      mod.simulatorApiRegistry,
      'custom-apis.js must not export a `simulatorApiRegistry` value',
    ).toBeUndefined()
  })
})

// ── D5 — the factory / interface / handler type survive ─────────────────────

describe('Requirement D5: createSimulatorApiRegistry + types survive in custom-apis.ts', () => {
  it('custom-apis.js still exports a working `createSimulatorApiRegistry` factory', async () => {
    const mod = (await import('./services/simulator/custom-apis.js')) as unknown as {
      createSimulatorApiRegistry?: () => unknown
    }
    expect(typeof mod.createSimulatorApiRegistry).toBe('function')

    const reg = mod.createSimulatorApiRegistry!() as {
      register: (n: string, h: () => unknown) => unknown
      list: () => string[]
      invoke: (n: string, p: unknown) => Promise<unknown>
      clear: () => void
    }
    expect(typeof reg.register).toBe('function')
    expect(typeof reg.list).toBe('function')
    expect(typeof reg.invoke).toBe('function')
    expect(typeof reg.clear).toBe('function')
  })

  it('custom-apis.ts still declares the SimulatorApiHandler / SimulatorApiRegistry types', async () => {
    const src = await readFile(repoFile('services/simulator/custom-apis.ts'), 'utf8')
    expect(
      /\bSimulatorApiHandler\b/.test(src),
      'custom-apis.ts must keep the SimulatorApiHandler type',
    ).toBe(true)
    expect(
      /\bSimulatorApiRegistry\b/.test(src),
      'custom-apis.ts must keep the SimulatorApiRegistry interface',
    ).toBe(true)
  })
})

// ── D3 — api.ts barrel: drop the value, keep the type ───────────────────────

describe('Requirement D3: api.ts drops registerSimulatorApi, keeps SimulatorApiHandler', () => {
  it('api.ts no longer exports the `registerSimulatorApi` value', async () => {
    const api = await loadBarrel()
    // Catches: the barrel still surfacing the deleted free function.
    expect(
      api.registerSimulatorApi,
      'api.ts must NOT export `registerSimulatorApi` anymore (step 3 — clean break)',
    ).toBeUndefined()
  })

  it('api.ts source has no `registerSimulatorApi` export statement', async () => {
    const src = await readFile(repoFile('api.ts'), 'utf8')
    expect(
      /\bregisterSimulatorApi\b/.test(src),
      'api.ts must not reference `registerSimulatorApi` at all',
    ).toBe(false)
  })

  it('api.ts no longer imports from the deleted ./simulator-apis.js path', async () => {
    const src = await readFile(repoFile('api.ts'), 'utf8')
    // Catches: a dangling import of the deleted wrapper file.
    expect(
      /['"]\.\/simulator-apis(\.js)?['"]/.test(src),
      'api.ts must not import from ./simulator-apis.js (the file is deleted)',
    ).toBe(false)
  })

  it('api.ts STILL re-exports the `SimulatorApiHandler` type (signature of instance.registerSimulatorApi)', async () => {
    const src = await readFile(repoFile('api.ts'), 'utf8')
    // `SimulatorApiHandler` is a type — no runtime presence — so scan source.
    // It must still be exported, just re-routed away from the deleted wrapper.
    expect(
      /\bSimulatorApiHandler\b/.test(src),
      'api.ts must still re-export the `SimulatorApiHandler` type',
    ).toBe(true)
    // And it must come from the surviving custom-apis module, not the
    // deleted ./simulator-apis.js wrapper.
    const reExportsFromCustomApis =
      /export\s+type\s*\{[^}]*\bSimulatorApiHandler\b[^}]*\}\s*from\s*['"][^'"]*services\/simulator\/custom-apis(\.js)?['"]/
        .test(src)
    expect(
      reExportsFromCustomApis,
      'SimulatorApiHandler must be re-exported from ./services/simulator/custom-apis.js',
    ).toBe(true)
  })
})

// ── D4 — package.json drops the ./simulator-apis subpath ────────────────────

describe('Requirement D4: package.json drops the ./simulator-apis subpath export', () => {
  it('the `exports` map has no `./simulator-apis` entry', async () => {
    const pkgRaw = await readFile(repoFile('../../package.json'), 'utf8')
    const pkg = JSON.parse(pkgRaw) as {
      exports?: Record<string, unknown>
      typesVersions?: Record<string, Record<string, unknown>>
    }
    expect(
      pkg.exports?.['./simulator-apis'],
      'package.json `exports` must not keep the ./simulator-apis subpath',
    ).toBeUndefined()
  })

  it('the `typesVersions` map has no `simulator-apis` entry either', async () => {
    const pkgRaw = await readFile(repoFile('../../package.json'), 'utf8')
    const pkg = JSON.parse(pkgRaw) as {
      typesVersions?: Record<string, Record<string, unknown>>
    }
    const star = pkg.typesVersions?.['*']
    expect(
      star?.['simulator-apis'],
      'package.json `typesVersions` must not keep the simulator-apis mapping',
    ).toBeUndefined()
  })
})
