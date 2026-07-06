/**
 * Full-application teardown must still destroy the host toolbar, even though
 * `workspace.closeProject()` is changing to call `views.disposeProjectViews()`
 * instead of `views.disposeAll()` (see view-manager-dispose-scopes.test.ts and
 * workspace-lifecycle-race.test.ts / workspace-session-teardown.test.ts). The
 * toolbar's session-resident runtime preload (host-toolbar-session-runtime.ts)
 * is only released by `disposeAll()`; if nothing calls it at app-teardown, the
 * defaultSession keeps a dead ViewManager's preload registration forever.
 *
 * app.ts's `disposeContext` today reaches `views.disposeAll` transitively
 * through `ctx.workspace.closeProject()` (which currently calls disposeAll
 * itself) BEFORE `ctx.registry.dispose()`. Once closeProject narrows to
 * disposeProjectViews, that transitive path disappears — `ctx.registry`
 * (the application-level DisposableRegistry created in `createWorkbenchContext`)
 * must itself register the full views teardown so `ctx.registry.dispose()`
 * alone guarantees the host toolbar (and everything else) gets torn down.
 *
 * Today nothing registers it (grep for `registry.add` in workbench-context.ts
 * turns up nothing view-related), so this pins the missing wiring directly —
 * independent of whichever call site (closeProject vs registry) currently
 * happens to reach disposeAll.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/dimina-test-userdata'), isPackaged: true },
  webContents: {
    fromId: vi.fn(() => null),
    getAllWebContents: vi.fn(() => []),
  },
  default: {},
}))

// Settings reads all ENOENT so defaults kick in (loadWorkbenchSettings) and no
// real file I/O happens against this test's machine.
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

/**
 * `createWorkbenchContext` is documented side-effect-free (see its own doc
 * comment: "the constructor stays side-effect-free so focused unit tests can
 * build a context with a minimal mainWindow fake") — mirrors the fake used by
 * workspace-thumbnail-provider.test.ts.
 */
function fakeMainWindow(): import('electron').BrowserWindow {
  const wc = { id: 1, isDestroyed: () => false, send: vi.fn(), getURL: () => '' }
  return {
    webContents: wc,
    isDestroyed: () => false,
  } as unknown as import('electron').BrowserWindow
}

describe('workbench-context: application-level registry teardown must still reach the full view teardown', () => {
  it('ctx.registry.dispose() calls ctx.views.disposeAll() exactly once (host toolbar released at app teardown)', async () => {
    const ctx = createWorkbenchContext({
      mainWindow: fakeMainWindow(),
      preloadPath: '/fake/preload.js',
      rendererDir: '/fake/renderer',
    })

    const disposeAllSpy = vi.spyOn(ctx.views, 'disposeAll')

    await ctx.registry.dispose()

    expect(
      disposeAllSpy,
      'ctx.registry.dispose() (the application-level teardown hook run by app.ts\'s '
      + 'disposeContext) must itself trigger the full view teardown — once workspace.closeProject() '
      + 'no longer calls disposeAll, this registration is the ONLY remaining path that '
      + 'releases the host toolbar\'s session-runtime preload on app shutdown',
    ).toHaveBeenCalledTimes(1)
  })
})
