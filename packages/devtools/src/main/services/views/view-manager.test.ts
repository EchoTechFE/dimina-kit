/**
 * View lifecycle regression: repeated show/hide of the settings and popover
 * overlays must not leak `WebContentsView` instances and must keep
 * `addChildView` / `removeChildView` calls balanced on the main contentView.
 *
 * Two implementation strategies are asserted as the *current* observed
 * behaviour (the test does NOT prescribe them — it just pins them so any
 * future change is intentional):
 *   - settings overlay: the view is created once and re-used across show/hide
 *     cycles (lazy create + cache; never destroyed by hideSettings)
 *   - popover overlay: a fresh view is created on every showPopover and
 *     destroyed on every hidePopover (no cache)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Track every WebContentsView instance ever constructed so we can assert
// construction counts and per-view add/remove pairing.
type StubWebContents = {
  destroyed: boolean
  id: number
  isDestroyed: () => boolean
  close: ReturnType<typeof vi.fn>
  loadFile: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  setWindowOpenHandler: ReturnType<typeof vi.fn>
}
type StubView = {
  webContents: StubWebContents
  setBounds: ReturnType<typeof vi.fn>
  setBackgroundColor: ReturnType<typeof vi.fn>
}

const constructed: StubView[] = []

vi.mock('electron', () => {
  let nextId = 1
  class WebContentsView {
    webContents: StubWebContents
    setBounds = vi.fn()
    setBackgroundColor = vi.fn()
    constructor() {
      const id = nextId++
      this.webContents = {
        destroyed: false,
        id,
        isDestroyed() { return this.destroyed },
        close: vi.fn(function (this: StubWebContents) { this.destroyed = true }),
        loadFile: vi.fn(() => Promise.resolve()),
        on: vi.fn(),
        once: vi.fn(),
        setWindowOpenHandler: vi.fn(),
      }
      constructed.push(this as unknown as StubView)
    }
  }
  return {
    WebContentsView,
    webContents: { fromId: vi.fn(() => null) },
  }
})

vi.mock('../../utils/paths.js', () => ({
  mainPreloadPath: '/stub/preload.js',
}))

// Import AFTER mocks so view-manager picks up the stubs.
import { createViewManager } from './view-manager.js'

function makeContext() {
  const addChildView = vi.fn()
  const removeChildView = vi.fn()
  const contentView = { addChildView, removeChildView, children: [] }
  const mainWindow = {
    destroyed: false,
    contentView,
    isDestroyed() { return this.destroyed },
    getContentSize: () => [1280, 980],
  }
  const notify = {
    popoverInit: vi.fn(),
    popoverClosed: vi.fn(),
  }
  return {
    mainWindow,
    addChildView,
    removeChildView,
    contentView,
    notify,
    ctx: {
      mainWindow: mainWindow as unknown as import('electron').BrowserWindow,
      rendererDir: '/stub/renderer',
      panels: ['console', 'wxml', 'storage', 'appdata'],
      notify: notify as unknown as import('../notifications/renderer-notifier.js').RendererNotifier,
    },
  }
}

beforeEach(() => {
  constructed.length = 0
})

describe('ViewManager: repeated show/hide cycles do not leak', () => {
  it('settings overlay: 10 show/hide cycles balance addChildView / removeChildView and reuse a single WebContentsView', async () => {
    const { addChildView, removeChildView, ctx } = makeContext()
    const mgr = createViewManager(ctx)

    const N = 10
    for (let i = 0; i < N; i++) {
      await mgr.showSettings()
      mgr.hideSettings()
    }

    expect(addChildView).toHaveBeenCalledTimes(N)
    expect(removeChildView).toHaveBeenCalledTimes(N)

    // Settings is lazy-create-once-and-cache: only ONE WebContentsView built.
    expect(constructed.length).toBe(1)

    // The view's webContents was never closed across the cycles (kept alive).
    expect(constructed[0]!.webContents.destroyed).toBe(false)
    expect(constructed[0]!.webContents.close).not.toHaveBeenCalled()

    // Every add and every remove used the SAME view instance.
    for (let i = 0; i < N; i++) {
      expect(addChildView.mock.calls[i]![0]).toBe(constructed[0])
      expect(removeChildView.mock.calls[i]![0]).toBe(constructed[0])
    }
  })

  it('settings overlay: redundant showSettings() does not re-add an already-added view', async () => {
    const { addChildView, removeChildView, ctx } = makeContext()
    const mgr = createViewManager(ctx)

    await mgr.showSettings()
    await mgr.showSettings()
    await mgr.showSettings()
    expect(addChildView).toHaveBeenCalledTimes(1)
    expect(removeChildView).not.toHaveBeenCalled()

    mgr.hideSettings()
    mgr.hideSettings() // second hide while already hidden is a no-op
    expect(removeChildView).toHaveBeenCalledTimes(1)
  })

  it('popover overlay: 5 show/hide cycles construct & destroy 5 distinct views (no reuse) and balance add/remove', () => {
    const { addChildView, removeChildView, notify, ctx } = makeContext()
    const mgr = createViewManager(ctx)

    const N = 5
    for (let i = 0; i < N; i++) {
      mgr.showPopover({ i })
      mgr.hidePopover()
    }

    // Each showPopover creates a fresh WebContentsView.
    expect(constructed.length).toBe(N)

    // Each show adds and each hide removes.
    expect(addChildView).toHaveBeenCalledTimes(N)
    expect(removeChildView).toHaveBeenCalledTimes(N)

    // Each popover view was closed exactly once (destroyed on hide).
    for (let i = 0; i < N; i++) {
      expect(constructed[i]!.webContents.close).toHaveBeenCalledTimes(1)
      expect(constructed[i]!.webContents.destroyed).toBe(true)
    }

    // No add-after-destroy: the j-th add precedes the j-th remove which
    // precedes the (j+1)-th add. Verify by checking add and remove targets pair up.
    for (let i = 0; i < N; i++) {
      const view = constructed[i]
      expect(addChildView.mock.calls[i]![0]).toBe(view)
      expect(removeChildView.mock.calls[i]![0]).toBe(view)
    }

    // popoverClosed notified once per hide.
    expect(notify.popoverClosed).toHaveBeenCalledTimes(N)
  })

  it('popover overlay: showPopover while one is already up tears down the previous instance first', () => {
    const { addChildView, removeChildView, notify, ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.showPopover({ i: 1 })
    mgr.showPopover({ i: 2 })
    mgr.showPopover({ i: 3 })

    // 3 created, but only 2 prior ones torn down so far; final still attached.
    expect(constructed.length).toBe(3)
    expect(addChildView).toHaveBeenCalledTimes(3)
    expect(removeChildView).toHaveBeenCalledTimes(2)
    expect(notify.popoverClosed).toHaveBeenCalledTimes(2)

    // First two are destroyed; the latest is alive.
    expect(constructed[0]!.webContents.destroyed).toBe(true)
    expect(constructed[1]!.webContents.destroyed).toBe(true)
    expect(constructed[2]!.webContents.destroyed).toBe(false)

    mgr.hidePopover()
    expect(removeChildView).toHaveBeenCalledTimes(3)
    expect(constructed[2]!.webContents.destroyed).toBe(true)
  })
})
