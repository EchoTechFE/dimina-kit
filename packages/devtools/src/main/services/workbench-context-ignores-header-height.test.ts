/**
 * headerHeight decommission — context half. The deprecated
 * `WorkbenchAppConfig.headerHeight` must be a runtime no-op:
 * `createWorkbenchContext` must NOT place a `headerHeight` key on the
 * returned context, even when the host configures one.
 *
 * Real bug each test catches:
 *  - If the implementer leaves `headerHeight: opts.headerHeight ?? 40` in
 *    the constructor, a host-configured 72 keeps flowing into
 *    `view-manager.ts` (`ctx.headerHeight ?? 40`) and the main process
 *    carves the WCV layout at y=72 while the renderer draws its fixed 40px
 *    toolbar — a 32px dead band between toolbar and views.
 *  - The "absent key" assertion (vs `toBe(undefined)`) also catches a
 *    half-removal that keeps the key with a default (`headerHeight: 40`):
 *    a present key invites downstream code to keep reading ctx instead of
 *    the layout call sites passing the constant explicitly.
 *
 * RED today: ctx.headerHeight is assigned in createWorkbenchContext
 * (workbench-context.ts), so the key exists with value 72 / 40.
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

let createWorkbenchContext: typeof import('./workbench-context.js').createWorkbenchContext

beforeEach(async () => {
  vi.resetModules()
  ;({ createWorkbenchContext } = await import('./workbench-context.js'))
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

describe('headerHeight decommission: createWorkbenchContext ignores the config', () => {
  it('a host-configured headerHeight: 72 does NOT land on the context (key absent)', () => {
    const ctx = createWorkbenchContext(
      makeOpts({ headerHeight: 72 }) as never,
    ) as unknown as Record<string, unknown>
    expect(
      'headerHeight' in ctx,
      'createWorkbenchContext must not copy the deprecated headerHeight config onto the context — a present key means 72 still transparently reaches view layout',
    ).toBe(false)
  })

  it('no headerHeight key materializes even with default opts (no `?? 40` fallback assignment)', () => {
    const ctx = createWorkbenchContext(makeOpts() as never) as unknown as Record<string, unknown>
    expect(
      'headerHeight' in ctx,
      'the constructor must not synthesize a default headerHeight key — consumers take the height as an explicit parameter, not from ctx',
    ).toBe(false)
  })
})
