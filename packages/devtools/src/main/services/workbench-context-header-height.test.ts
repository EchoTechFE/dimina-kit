/**
 * Requirement B (context-flow half) — a host-configured `headerHeight` must
 * land on `WorkbenchContext.headerHeight`, and default to 40 when unset.
 *
 * `WorkbenchAppConfig` gains an optional `headerHeight?: number`;
 * `CreateContextOptions` carries it through; `createWorkbenchContext`
 * resolves it (with a `?? 40` default) onto `ctx.headerHeight`.
 *
 * RED today: neither `CreateContextOptions` nor `WorkbenchContext` has a
 * `headerHeight` field, so `ctx.headerHeight` is `undefined`. Accessed
 * through dynamic casts so the file compiles while the field is missing.
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

/** Build createWorkbenchContext opts; `headerHeight` is the new field. */
function makeOpts(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mainWindow: fakeMainWindow(),
    preloadPath: '/fake/preload.js',
    rendererDir: '/fake/renderer',
    ...extra,
  }
}

describe('Requirement B: headerHeight flows onto WorkbenchContext', () => {
  it('a host-configured headerHeight lands on ctx.headerHeight', () => {
    const ctx = createWorkbenchContext(makeOpts({ headerHeight: 72 }) as never) as unknown as Record<string, unknown>
    expect(
      ctx.headerHeight,
      'createWorkbenchContext must propagate the configured headerHeight onto the context',
    ).toBe(72)
  })

  it('ctx.headerHeight defaults to 40 when the host omits it', () => {
    const ctx = createWorkbenchContext(makeOpts() as never) as unknown as Record<string, unknown>
    expect(
      ctx.headerHeight,
      'ctx.headerHeight must default to 40 when no headerHeight is configured',
    ).toBe(40)
  })

  it('ctx.headerHeight is a number, not undefined', () => {
    const ctx = createWorkbenchContext(makeOpts({ headerHeight: 56 }) as never) as unknown as Record<string, unknown>
    expect(typeof ctx.headerHeight).toBe('number')
  })
})
