/**
 * Step 6 of the devtools extension model — "收尾", Requirement A:
 * the module-assembly route is no longer part of the package's PUBLIC
 * export surface.
 *
 * `docs/extension-model.md` §4 / step 6 ("撤模块组装公共导出") + §6 ("不在本文
 * 范围：模块组装路线 … 保留，仅撤对外导出"):
 *
 *  A1. `src/main/api.ts` (the package root barrel) no longer re-exports the
 *      eight `register*Ipc` functions: registerAppIpc / registerSimulatorIpc
 *      / registerPanelsIpc / registerPopoverIpc / registerSettingsIpc /
 *      registerProjectsIpc / registerSessionIpc / registerToolbarIpc.
 *  A2. `package.json` `exports` drops the seven `./ipc-*` subpaths
 *      (./ipc-simulator, ./ipc-panels, ./ipc-toolbar, ./ipc-popover,
 *      ./ipc-settings, ./ipc-projects, ./ipc-session).
 *  A3. `package.json` `typesVersions['*']` drops the same seven `ipc-*`
 *      mappings.
 *  A4. GUARDRAIL — the mechanism itself SURVIVES for devtools-internal use:
 *      the `src/main/ipc/*.ts` implementation files still exist, and
 *      `src/main/ipc/index.ts` still internally re-exports the eight
 *      `register*Ipc` functions. This catches an implementer who "deletes
 *      too far" and removes the internal module-assembly plumbing that
 *      `app.ts` / `registerBuiltinModules` still depends on.
 *
 * A1/A2/A3 are RED today (the barrel exports + the subpaths + the
 * typesVersions entries all still exist). A4 is GREEN today and must STAY
 * green after the refactor.
 *
 * Strategy: a runtime value import for `api.ts` (the eight functions have
 * runtime presence), plus JSON / source-text scans for package.json and the
 * surviving internal plumbing — mirrors `simulator-apis-global-removed.test.ts`
 * and `api-ipc-registry-export.test.ts`.
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

// `api.ts` transitively touches `electron` (ipcMain / session) — stub it so a
// value import of the barrel works outside Electron.
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

async function loadPackageJson(): Promise<{
  exports?: Record<string, unknown>
  typesVersions?: Record<string, Record<string, unknown>>
}> {
  const raw = await readFile(repoFile('../../package.json'), 'utf8')
  return JSON.parse(raw) as {
    exports?: Record<string, unknown>
    typesVersions?: Record<string, Record<string, unknown>>
  }
}

/** The eight module-assembly registration functions that must leave the public surface. */
const REGISTER_FNS = [
  'registerAppIpc',
  'registerSimulatorIpc',
  'registerPanelsIpc',
  'registerPopoverIpc',
  'registerSettingsIpc',
  'registerProjectsIpc',
  'registerSessionIpc',
  'registerToolbarIpc',
] as const

/** The seven `./ipc-*` subpaths that must leave package.json. */
const IPC_SUBPATHS = [
  './ipc-simulator',
  './ipc-panels',
  './ipc-toolbar',
  './ipc-popover',
  './ipc-settings',
  './ipc-projects',
  './ipc-session',
] as const

// ── A1 — api.ts barrel drops the eight register*Ipc value exports ───────────

describe('Requirement A1: api.ts no longer re-exports the register*Ipc functions', () => {
  it.each(REGISTER_FNS)('api.ts does not export `%s` (runtime)', async (name) => {
    const api = await loadBarrel()
    // Catches: the barrel still surfacing a module-assembly registration fn.
    expect(
      api[name],
      `api.ts must NOT re-export \`${name}\` — module-assembly is internal-only after step 6`,
    ).toBeUndefined()
  })

  it.each(REGISTER_FNS)('api.ts source has no `%s` export statement', async (name) => {
    const src = await readFile(repoFile('api.ts'), 'utf8')
    // Catches: a `export { registerXIpc } from './ipc/x.js'` line kept around.
    expect(
      new RegExp(`\\b${name}\\b`).test(src),
      `api.ts must not reference \`${name}\` at all`,
    ).toBe(false)
  })

  it('api.ts source has no `./ipc/` re-export line', async () => {
    const src = await readFile(repoFile('api.ts'), 'utf8')
    // Catches: any surviving `... from './ipc/<file>.js'` barrel re-export.
    expect(
      /from\s*['"]\.\/ipc\//.test(src),
      'api.ts must not re-export anything from ./ipc/* — that subtree is internal-only',
    ).toBe(false)
  })
})

// ── A2 — package.json `exports` drops the seven ./ipc-* subpaths ────────────

describe('Requirement A2: package.json `exports` drops the ./ipc-* subpaths', () => {
  it.each(IPC_SUBPATHS)('the `exports` map has no `%s` entry', async (subpath) => {
    const pkg = await loadPackageJson()
    expect(
      pkg.exports?.[subpath],
      `package.json \`exports\` must not keep the ${subpath} subpath`,
    ).toBeUndefined()
  })

  it('no `exports` key matches the `./ipc-*` pattern (catches renamed/extra entries)', async () => {
    const pkg = await loadPackageJson()
    const leftover = Object.keys(pkg.exports ?? {}).filter((k) => /^\.\/ipc-/.test(k))
    expect(
      leftover,
      `package.json \`exports\` must not keep any ./ipc-* subpath, found: ${leftover.join(', ')}`,
    ).toEqual([])
  })
})

// ── A3 — package.json `typesVersions` drops the seven ipc-* mappings ────────

describe('Requirement A3: package.json `typesVersions` drops the ipc-* mappings', () => {
  it('no `typesVersions["*"]` key matches the `ipc-*` pattern', async () => {
    const pkg = await loadPackageJson()
    const star = pkg.typesVersions?.['*'] ?? {}
    const leftover = Object.keys(star).filter((k) => /^ipc-/.test(k))
    expect(
      leftover,
      `package.json \`typesVersions\` must not keep any ipc-* mapping, found: ${leftover.join(', ')}`,
    ).toEqual([])
  })
})

// ── A4 — GUARDRAIL: the module-assembly mechanism survives internally ───────

describe('Requirement A4 (guardrail): module-assembly plumbing survives for internal use', () => {
  it('the src/main/ipc/*.ts implementation files still exist', async () => {
    // Catches: an implementer deleting the implementation instead of just the
    // public export face. `app.ts` / `registerBuiltinModules` still need these.
    for (const file of [
      'app.ts',
      'simulator.ts',
      'panels.ts',
      'popover.ts',
      'settings.ts',
      'projects.ts',
      'session.ts',
      'toolbar.ts',
      'index.ts',
    ]) {
      expect(
        await exists(repoFile(`ipc/${file}`)),
        `src/main/ipc/${file} must still exist (internal module-assembly is kept)`,
      ).toBe(true)
    }
  })

  it('src/main/ipc/index.ts still internally re-exports the eight register*Ipc functions', async () => {
    const src = await readFile(repoFile('ipc/index.ts'), 'utf8')
    for (const name of REGISTER_FNS) {
      expect(
        new RegExp(`\\b${name}\\b`).test(src),
        `src/main/ipc/index.ts must keep its internal re-export of \`${name}\``,
      ).toBe(true)
    }
  })

  it('the ipc modules are still runtime-importable from inside the package', async () => {
    // Deep-importing the internal index must keep working — only the *public*
    // (package.json `exports`) surface is being withdrawn.
    const mod = (await import('./ipc/index.js')) as unknown as Record<string, unknown>
    for (const name of REGISTER_FNS) {
      expect(
        typeof mod[name],
        `src/main/ipc/index.js must still export a callable \`${name}\``,
      ).toBe('function')
    }
  })
})
