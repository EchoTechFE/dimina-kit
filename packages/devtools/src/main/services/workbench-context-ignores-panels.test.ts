/**
 * panels decommission — context half (headerHeight 同款). The deprecated
 * `WorkbenchConfig.panels` must become a runtime no-op:
 * `createWorkbenchContext` must NOT place a `panels` key on the returned
 * context, and the `panels`-derived module exports (`getDefaultTab`,
 * `hasBuiltinPanel`) must be deleted with it.
 *
 * Real bug each test catches:
 *  - "key absent" (an `in` check, NOT `toBe(undefined)`): leaving
 *    `panels: opts.panels ?? [...]` in the constructor lets a host passing
 *    `panels: ['wxml']` still materialize a filtered panel list on ctx — a
 *    present key (even the 4-entry default) invites main-process code to grow
 *    panel-filtering behavior back, while the renderer always shows all four
 *    tabs. Config and UI silently disagree.
 *  - "getDefaultTab / hasBuiltinPanel exports gone": both read `ctx.panels`;
 *    once the key is gone they would crash on `undefined.includes` for any
 *    caller. Asserted via a namespace-object key check (not a direct import)
 *    so this file still COMPILES after the exports are deleted — a direct
 *    import would turn the expected deletion into a build break of the test
 *    itself. `src/main/api.ts` re-exports both; they must be dropped there in
 *    the same change or check-types fails.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/userdata'),
    isPackaged: true,
  },
  webContents: { fromId: vi.fn(() => null) },
  default: {},
}))

vi.mock('fs', async () => {
  const real = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...real,
    default: real,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  }
})

let contextModule: typeof import('./workbench-context.js')

beforeEach(async () => {
  vi.resetModules()
  contextModule = await import('./workbench-context.js')
})

function fakeMainWindow(): import('electron').BrowserWindow {
  const wc = { id: 1, isDestroyed: () => false, send: vi.fn(), getURL: () => '' }
  return { webContents: wc } as unknown as import('electron').BrowserWindow
}

function makeOpts(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mainWindow: fakeMainWindow(),
    preloadPath: '/fake/preload.js',
    rendererDir: '/fake/renderer',
    ...extra,
  }
}

describe('panels decommission: createWorkbenchContext ignores the config', () => {
  it("a host-configured panels: ['wxml'] does NOT land on the context (key absent)", () => {
    const ctx = contextModule.createWorkbenchContext(
      makeOpts({ panels: ['wxml'] }) as never,
    ) as unknown as Record<string, unknown>
    expect(
      'panels' in ctx,
      'createWorkbenchContext must not copy the deprecated panels config onto the context — a present key means a host filter still reaches main-process consumers while the renderer renders all tabs unconditionally',
    ).toBe(false)
  })

  it('no panels key materializes even with default opts (no `?? [all four]` fallback assignment)', () => {
    const ctx = contextModule.createWorkbenchContext(
      makeOpts() as never,
    ) as unknown as Record<string, unknown>
    expect(
      'panels' in ctx,
      'the constructor must not synthesize a default panels key — there are no remaining consumers; a present key is pure re-growth surface',
    ).toBe(false)
  })
})

describe('panels decommission: the panels-derived module exports are deleted', () => {
  it('getDefaultTab is no longer exported from workbench-context', () => {
    expect(
      'getDefaultTab' in contextModule,
      'getDefaultTab reads ctx.panels — with the key gone it would crash on undefined.includes; with the key kept it preserves a dead tab-selection policy nothing consumes (sole remaining consumer was the api.ts re-export)',
    ).toBe(false)
  })

  it('hasBuiltinPanel is no longer exported from workbench-context', () => {
    expect(
      'hasBuiltinPanel' in contextModule,
      'hasBuiltinPanel exists only to serve getDefaultTab over ctx.panels; keeping it exported re-advertises the decommissioned panel-filter concept to hosts via api.ts',
    ).toBe(false)
  })

  it('survivor pin: createWorkbenchContext itself stays exported (module not over-deleted)', () => {
    expect(typeof contextModule.createWorkbenchContext).toBe('function')
  })
})
