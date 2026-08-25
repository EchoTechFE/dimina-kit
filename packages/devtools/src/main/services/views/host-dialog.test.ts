/**
 * Host-controllable dialog WebContentsView lifecycle.
 *
 * Unlike host-toolbar/host-sidebar (persistent, renderer-anchored strips),
 * the dialog is a by-demand, main-centered overlay: `show()`/`hide()` drive
 * `setOverlayDesired`/`deleteOverlayDesired` directly (see host-dialog-view.ts),
 * and its size self-advertises on BOTH axes from a single reverse-advertiser
 * channel instead of being positioned by a renderer placeholder. There is no
 * async wait for that first measurement — `show()` must apply a conservative
 * default immediately (no setTimeout/polling for the race) and self-correct
 * via `reportMeasuredExtent` the moment a report lands, re-centering while
 * visible.
 *
 * Harness mirrors host-toolbar.test.ts (same electron mock shape tracking
 * constructed WebContentsView instances + addChildView/removeChildView/
 * setBounds on the main contentView).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type StubWebContents = {
  destroyed: boolean
  id: number
  isDestroyed: () => boolean
  close: ReturnType<typeof vi.fn>
  loadFile: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  setWindowOpenHandler: ReturnType<typeof vi.fn>
}
type StubView = {
  webContents: StubWebContents
  setBounds: ReturnType<typeof vi.fn>
  setBackgroundColor: ReturnType<typeof vi.fn>
  setVisible: ReturnType<typeof vi.fn>
}

const constructed: StubView[] = []

const mockFromId = vi.fn((_id: number) => null as unknown)

vi.mock('electron', () => {
  let nextId = 1
  class WebContentsView {
    webContents: StubWebContents
    setBounds = vi.fn()
    setBackgroundColor = vi.fn()
    setVisible = vi.fn()
    constructor() {
      const id = nextId++
      this.webContents = {
        destroyed: false,
        id,
        isDestroyed() { return this.destroyed },
        close: vi.fn(function (this: StubWebContents) { this.destroyed = true }),
        loadFile: vi.fn(() => Promise.resolve()),
        loadURL: vi.fn(() => Promise.resolve()),
        on: vi.fn(),
        once: vi.fn(),
        setWindowOpenHandler: vi.fn(),
      }
      constructed.push(this as unknown as StubView)
    }
  }
  return {
    WebContentsView,
    webContents: { fromId: (id: number) => mockFromId(id) },
    ipcMain: { on: vi.fn(), removeListener: vi.fn() },
    shell: { openExternal: vi.fn() },
    session: {
      defaultSession: {
        registerPreloadScript: vi.fn(() => 'stub-preload-script-id'),
        unregisterPreloadScript: vi.fn(),
      },
    },
  }
})

vi.mock('../../utils/paths.js', () => ({
  mainPreloadPath: '/stub/preload.js',
  hostToolbarRuntimePreloadPath: '/stub/host-toolbar-runtime-preload.cjs',
  hostSidebarRuntimePreloadPath: '/stub/host-sidebar-runtime-preload.cjs',
  hostDialogRuntimePreloadPath: '/stub/host-dialog-runtime-preload.cjs',
  cjsSiblingPreloadPath: (p: string) => p,
  devtoolsPackageRoot: '/stub/devtools-pkg-root',
}))

// Import AFTER mocks so view-manager picks up the stubs.
import { createViewManager } from './view-manager.js'
import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'

// Matches the mocked mainWindow.getContentSize() below.
const WINDOW_WIDTH = 1280
const WINDOW_HEIGHT = 980
const DEFAULT_WIDTH = 480
const DEFAULT_HEIGHT = 320

function centeredBounds(width: number, height: number) {
  return {
    x: Math.round((WINDOW_WIDTH - width) / 2),
    y: Math.round((WINDOW_HEIGHT - height) / 2),
    width,
    height,
  }
}

function makeContext() {
  const addChildView = vi.fn()
  const removeChildView = vi.fn()
  const contentView = { addChildView, removeChildView, children: [] }
  const mainWindow = {
    destroyed: false,
    contentView,
    isDestroyed() { return this.destroyed },
    getContentSize: () => [WINDOW_WIDTH, WINDOW_HEIGHT],
  }
  const notify = {
    popoverInit: vi.fn(),
    popoverClosed: vi.fn(),
  }
  return {
    addChildView,
    removeChildView,
    contentView,
    notify,
    ctx: {
      windows: {
        mainWindow: mainWindow as unknown as import('electron').BrowserWindow,
      } as import('../window-service.js').WindowService,
      rendererDir: '/stub/renderer',
      panels: ['console', 'wxml', 'storage', 'appdata'],
      notify: notify as unknown as import('../notifications/renderer-notifier.js').RendererNotifier,
      connections: createConnectionRegistry(),
    },
  }
}

beforeEach(() => {
  constructed.length = 0
})

describe('ViewManager: hostDialog.show() with both axes already measured centers on the measured size', () => {
  it('applies bounds centered around the reported width/height, not the default', () => {
    const { addChildView, ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.reportHostDialogMeasuredExtent('inline', 640)
    mgr.reportHostDialogMeasuredExtent('block', 400)
    mgr.hostDialog.show()

    expect(constructed.length).toBe(1)
    const view = constructed[0]!
    expect(addChildView).toHaveBeenCalledTimes(1)
    expect(addChildView.mock.calls[0]![0]).toBe(view)
    expect(view.setBounds).toHaveBeenCalledTimes(1)
    expect(view.setBounds.mock.calls[0]![0]).toEqual(centeredBounds(640, 400))
    expect(mgr.hostDialog.isVisible()).toBe(true)
  })
})

describe('ViewManager: hostDialog.show() with nothing measured yet', () => {
  it('shows immediately at a conservative default size instead of waiting for a measurement', () => {
    // Guards against a setTimeout/polling fallback: show() must be
    // synchronous and non-blocking even though no reverse-advertiser report
    // has ever landed for this dialog instance.
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.hostDialog.show()

    expect(constructed.length).toBe(1)
    const view = constructed[0]!
    expect(view.setBounds).toHaveBeenCalledTimes(1)
    expect(view.setBounds.mock.calls[0]![0]).toEqual(centeredBounds(DEFAULT_WIDTH, DEFAULT_HEIGHT))
    expect(mgr.hostDialog.isVisible()).toBe(true)
  })
})

describe('ViewManager: hostDialog reportHostDialogMeasuredExtent while visible', () => {
  it('re-centers immediately with the newly measured extent', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    mgr.hostDialog.show()
    const view = constructed[0]!
    expect(view.setBounds).toHaveBeenCalledTimes(1)

    mgr.reportHostDialogMeasuredExtent('inline', 700)

    expect(view.setBounds).toHaveBeenCalledTimes(2)
    expect(view.setBounds.mock.calls[1]![0]).toEqual(centeredBounds(700, DEFAULT_HEIGHT))
  })

  it('does not re-center while hidden — the report is only retained for the next show()', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    // No view exists yet: a report before any show() must not construct one.
    mgr.reportHostDialogMeasuredExtent('block', 500)
    expect(constructed.length).toBe(0)

    mgr.hostDialog.show()
    const view = constructed[0]!
    expect(view.setBounds.mock.calls[0]![0]).toEqual(centeredBounds(DEFAULT_WIDTH, 500))
  })

  it('drops non-finite and non-positive reports without touching the retained size', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    mgr.hostDialog.show()
    const view = constructed[0]!
    view.setBounds.mockClear()

    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -10]) {
      mgr.reportHostDialogMeasuredExtent('inline', bad)
    }

    expect(view.setBounds).not.toHaveBeenCalled()
  })
})

describe('ViewManager: hostDialog.hide()', () => {
  it('removes the view from the contentView and clears isVisible', () => {
    const { addChildView, removeChildView, ctx } = makeContext()
    const mgr = createViewManager(ctx)
    mgr.hostDialog.show()
    const view = constructed[0]!
    expect(addChildView).toHaveBeenCalledTimes(1)

    mgr.hostDialog.hide()

    expect(removeChildView).toHaveBeenCalledTimes(1)
    expect(removeChildView.mock.calls[0]![0]).toBe(view)
    expect(mgr.hostDialog.isVisible()).toBe(false)
    // Hidden, not destroyed: the WCV survives for a later re-show.
    expect(view.webContents.close).not.toHaveBeenCalled()
  })

  it('a later report while hidden does not resurrect the overlay', () => {
    const { removeChildView, ctx } = makeContext()
    const mgr = createViewManager(ctx)
    mgr.hostDialog.show()
    mgr.hostDialog.hide()
    removeChildView.mockClear()

    mgr.reportHostDialogMeasuredExtent('inline', 900)

    expect(mgr.hostDialog.isVisible()).toBe(false)
    expect(removeChildView).not.toHaveBeenCalled()
  })
})

describe('ViewManager: hostDialog content swap resets the advertised size', () => {
  it('loadFile() drops the previous document\'s measured extent so the next show() falls back to the default, not the stale size', async () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.reportHostDialogMeasuredExtent('inline', 640)
    mgr.reportHostDialogMeasuredExtent('block', 400)
    mgr.hostDialog.show()
    const view = constructed[0]!
    expect(view.setBounds.mock.calls[0]![0]).toEqual(centeredBounds(640, 400))

    // The host swaps content into the SAME dialog view — nothing has
    // re-measured yet, so the next present() must not keep sizing the new
    // (unmeasured) document as if it were the old one.
    await mgr.hostDialog.loadFile('/other-content.html')
    mgr.hostDialog.show()

    const lastBounds = view.setBounds.mock.calls[view.setBounds.mock.calls.length - 1]![0]
    expect(lastBounds).toEqual(centeredBounds(DEFAULT_WIDTH, DEFAULT_HEIGHT))
  })

  it('loadURL() resets the same way', async () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.reportHostDialogMeasuredExtent('inline', 700)
    mgr.hostDialog.show()
    const view = constructed[0]!
    expect(view.setBounds.mock.calls[0]![0]).toEqual(centeredBounds(700, DEFAULT_HEIGHT))

    await mgr.hostDialog.loadURL('https://example.com/other')
    mgr.hostDialog.show()

    const lastBounds = view.setBounds.mock.calls[view.setBounds.mock.calls.length - 1]![0]
    expect(lastBounds).toEqual(centeredBounds(DEFAULT_WIDTH, DEFAULT_HEIGHT))
  })

  it('while already visible, loadFile() re-presents the default bounds immediately — WITHOUT a follow-up show()', async () => {
    // BUG CAUGHT: resetMeasuredExtent() used to only reset the closure's
    // width/height variables, never push them to the screen. A dialog
    // already open when the host re-purposes it for different content (the
    // documented use case — HostDialogControl.loadURL/loadFile do not
    // require the caller to call show() again) would keep displaying the
    // PREVIOUS document's exact bounds — forever, if the new document never
    // reports its own size (e.g. missing [data-host-dialog-root]) — instead
    // of falling back to the default the moment the swap happens.
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.reportHostDialogMeasuredExtent('inline', 640)
    mgr.reportHostDialogMeasuredExtent('block', 400)
    mgr.hostDialog.show()
    const view = constructed[0]!
    expect(view.setBounds.mock.calls[0]![0]).toEqual(centeredBounds(640, 400))

    await mgr.hostDialog.loadFile('/other-content.html')

    const lastBounds = view.setBounds.mock.calls[view.setBounds.mock.calls.length - 1]![0]
    expect(lastBounds).toEqual(centeredBounds(DEFAULT_WIDTH, DEFAULT_HEIGHT))
  })
})

describe('ViewManager: hostDialog re-centers on repositionAll (main-window resize entry point)', () => {
  it('reposition() recomputes centered bounds against the CURRENT window content size', () => {
    const { ctx } = makeContext()
    const mainWindow = ctx.windows.mainWindow as unknown as { getContentSize: () => number[] }
    const mgr = createViewManager(ctx)

    mgr.hostDialog.show()
    const view = constructed[0]!
    expect(view.setBounds.mock.calls[0]![0]).toEqual(centeredBounds(DEFAULT_WIDTH, DEFAULT_HEIGHT))

    // Simulate the main window resizing — repositionAll is the resize entry
    // point (window-service.ts), so the dialog must re-center against the
    // window's NEW content rect instead of staying at its old position.
    const NEW_WIDTH = 1600
    const NEW_HEIGHT = 1000
    mainWindow.getContentSize = () => [NEW_WIDTH, NEW_HEIGHT]
    mgr.repositionAll()

    const lastBounds = view.setBounds.mock.calls[view.setBounds.mock.calls.length - 1]![0]
    expect(lastBounds).toEqual({
      x: Math.round((NEW_WIDTH - DEFAULT_WIDTH) / 2),
      y: Math.round((NEW_HEIGHT - DEFAULT_HEIGHT) / 2),
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
    })
  })

  it('is a no-op while hidden — nothing to reapply, the next show() computes fresh bounds', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.repositionAll()

    expect(constructed.length).toBe(0)
  })
})

describe('ViewManager: getHostDialogWebContentsId', () => {
  it('is null before the dialog is ever shown/loaded', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    expect(mgr.getHostDialogWebContentsId()).toBeNull()
  })

  it('returns the WCV webContents id once shown', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.hostDialog.show()
    const view = constructed[0]!

    expect(mgr.getHostDialogWebContentsId()).toBe(view.webContents.id)
  })
})
