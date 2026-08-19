/**
 * The runtime's `'session-orientation'` event is what tells main which orientation a page now shows.
 * Two consumers read it, and they must not be collapsed into one: the renderer mirror wants the SESSION's orientation, the render guest's CSS `env(safe-area-inset-*)` wants the reporting PAGE's — the insets have to keep agreeing with the `safeArea` that page's own `wx.getSystemInfoSync()` returns.
 *
 * Routing the guest side by `bridgeId` is the load-bearing part: a tab substack keeps hidden pages mounted at their own orientation, so a session-wide re-push would stamp the top page's orientation onto them.
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
  return {
    webContents: wc,
    isDestroyed: () => false,
  } as unknown as import('electron').BrowserWindow
}

function buildContext() {
  return createWorkbenchContext({
    mainWindow: fakeMainWindow(),
    preloadPath: '/fake/preload.js',
    rendererDir: '/fake/renderer',
  })
}

describe('workbench-context: session-orientation drives the reporting page\'s safe area', () => {
  it('routes the orientation to that one bridgeId', () => {
    const ctx = buildContext()
    const spy = vi.spyOn(ctx.views, 'setPageSafeAreaOrientation').mockImplementation(() => {})

    ctx.events.emit('session-orientation', {
      appSessionId: 'app_1',
      bridgeId: 'bridge_detail',
      orientation: 'landscape',
      canRotate: false,
      active: true,
    })

    expect(
      spy,
      'the guest showing this page must have its env(safe-area-inset-*) resolved '
      + 'against the orientation the page reported, not the device orientation',
    ).toHaveBeenCalledWith('bridge_detail', 'landscape')
  })

  /**
   * `active` says which session the USER is looking at; a page's own `env(safe-area-inset-*)` is per-page and has to be right before the page is ever shown — a soft-reload session paints its first frame while still hidden.
   */
  it('routes the orientation of a page in a session that is not on screen too', () => {
    const ctx = buildContext()
    const spy = vi.spyOn(ctx.views, 'setPageSafeAreaOrientation').mockImplementation(() => {})

    ctx.events.emit('session-orientation', {
      appSessionId: 'app_2',
      bridgeId: 'bridge_booting',
      orientation: 'landscape',
      canRotate: false,
      active: false,
    })

    expect(spy).toHaveBeenCalledWith('bridge_booting', 'landscape')
  })

  it('leaves every guest alone when no page is reporting (session teardown)', () => {
    const ctx = buildContext()
    const spy = vi.spyOn(ctx.views, 'setPageSafeAreaOrientation').mockImplementation(() => {})

    ctx.events.emit('session-orientation', {
      appSessionId: 'app_1',
      bridgeId: null,
      orientation: null,
      canRotate: true,
      active: true,
    })

    expect(spy).not.toHaveBeenCalled()
  })

  /**
   * The recorded orientation belongs to the PAGE. `'page-closed'` is the only event that carries the page's own end — a render guest being destroyed does not mean the page ended (the same bridgeId can be handed a replacement guest), and the session-level teardown signal names no page at all.
   */
  it('releases the page\'s recorded orientation when the page closes', () => {
    const ctx = buildContext()
    const spy = vi.spyOn(ctx.views, 'forgetPageSafeAreaOrientation').mockImplementation(() => {})

    ctx.events.emit('page-closed', { appSessionId: 'app_1', bridgeId: 'bridge_detail' })

    expect(spy).toHaveBeenCalledWith('bridge_detail')
  })

  it('still mirrors the session orientation to the renderer', () => {
    const ctx = buildContext()
    vi.spyOn(ctx.views, 'setPageSafeAreaOrientation').mockImplementation(() => {})
    const sessionOrientationChanged = vi.fn()
    ctx.notify = { sessionOrientationChanged } as unknown as typeof ctx.notify

    ctx.events.emit('session-orientation', {
      appSessionId: 'app_1',
      bridgeId: 'bridge_detail',
      orientation: 'landscape',
      canRotate: false,
      active: true,
    })

    expect(sessionOrientationChanged).toHaveBeenCalledTimes(1)
  })
})
