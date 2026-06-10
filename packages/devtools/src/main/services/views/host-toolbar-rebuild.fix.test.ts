/**
 * Host-toolbar WebContentsView rebuild regression.
 *
 * The host-toolbar is a WebContentsView the downstream host owns; the
 * view-manager lazily creates it on the first non-empty `setHostToolbarBounds`
 * rect and mounts it via `contentView.addChildView`. The host can close /
 * destroy the underlying webContents out from under the view-manager (e.g. the
 * host navigates or tears its toolbar window down). On the NEXT
 * `setHostToolbarBounds` the view-manager must REBUILD the view (its lazy
 * ensure-path checks `webContents.isDestroyed()`).
 *
 * The behaviour users care about: after such a rebuild the toolbar must STILL
 * be visible. Concretely:
 *   - the freshly-built view MUST be `addChildView`'d into the main window's
 *     contentView (otherwise the toolbar silently disappears forever), and
 *   - the dead/destroyed view MUST be `removeChildView`'d (otherwise a
 *     destroyed WebContentsView lingers in the contentView).
 *
 * The current implementation keeps an `hostToolbarViewAdded = true` flag that
 * is NOT reset when the underlying webContents is found destroyed during the
 * lazy rebuild, so the "added?" guard skips the addChildView for the new view
 * (toolbar never re-mounts) and the dead view is never removed.
 *
 * Harness mirrors view-manager.test.ts: `vi.mock('electron')` (CI has no
 * electron binary) with a WebContentsView whose webContents close() flips a
 * `destroyed` flag, and a stub contentView that records add/removeChildView.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type StubWebContents = {
  destroyed: boolean
  id: number
  isDestroyed: () => boolean
  close: ReturnType<typeof vi.fn> & (() => void)
  loadURL: ReturnType<typeof vi.fn>
  loadFile: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  off: ReturnType<typeof vi.fn>
  removeListener: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  setZoomFactor: ReturnType<typeof vi.fn>
}
type StubView = {
  webContents: StubWebContents
  setBounds: ReturnType<typeof vi.fn>
  setBackgroundColor: ReturnType<typeof vi.fn>
}

// Every WebContentsView ever constructed, in order, so we can assert which
// instance was added/removed.
const constructed: StubView[] = []

vi.mock('electron', () => {
  let nextId = 1
  class WebContentsView {
    webContents: StubWebContents
    setBounds = vi.fn()
    setBackgroundColor = vi.fn()
    constructor(_opts?: unknown) {
      const id = nextId++
      this.webContents = {
        destroyed: false,
        id,
        isDestroyed() { return this.destroyed },
        close: vi.fn(function (this: StubWebContents) { this.destroyed = true }),
        loadURL: vi.fn(() => Promise.resolve()),
        loadFile: vi.fn(() => Promise.resolve()),
        on: vi.fn(),
        once: vi.fn(),
        off: vi.fn(),
        removeListener: vi.fn(),
        send: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        setZoomFactor: vi.fn(),
      }
      constructed.push(this as unknown as StubView)
    }
  }
  return {
    WebContentsView,
    ipcMain: { on: vi.fn(), removeListener: vi.fn(), handle: vi.fn(), removeHandler: vi.fn() },
    webContents: { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) },
    shell: { openExternal: vi.fn(() => Promise.resolve()) },
  }
})

vi.mock('../../utils/paths.js', () => ({
  mainPreloadPath: '/stub/preload.js',
  devtoolsPackageRoot: '/stub/devtools-pkg-root',
  hostToolbarPreloadPath: '/stub/host-toolbar-preload.cjs',
  cjsSiblingPreloadPath: (p: string) => (p.endsWith('.js') ? p.slice(0, -'.js'.length) + '.cjs' : p),
}))

// Import AFTER mocks so view-manager picks up the stubs.
import { createViewManager } from './view-manager.js'
import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'

function makeContext() {
  const addChildView = vi.fn()
  const removeChildView = vi.fn()
  const contentView = { addChildView, removeChildView, children: [] as unknown[] }
  const mainWindow = {
    destroyed: false,
    contentView,
    isDestroyed() { return this.destroyed },
    getContentSize: () => [1280, 980],
  }
  const notify = {
    hostToolbarHeightChanged: vi.fn(),
  }
  const ctx = {
    windows: {
      mainWindow: mainWindow as unknown as import('electron').BrowserWindow,
    } as import('../window-service.js').WindowService,
    rendererDir: '/stub/renderer',
    panels: ['console', 'wxml', 'storage', 'appdata'],
    notify: notify as unknown as import('../notifications/renderer-notifier.js').RendererNotifier,
    connections: createConnectionRegistry(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
  return { ctx, addChildView, removeChildView }
}

const RECT = { x: 0, y: 0, width: 800, height: 44 }

beforeEach(() => {
  constructed.length = 0
})

describe('host-toolbar view: rebuild after the underlying webContents is destroyed', () => {
  it('mounts the rebuilt view and removes the dead one', () => {
    const { ctx, addChildView, removeChildView } = makeContext()
    const mgr = createViewManager(ctx)

    // 1. First non-empty bounds: lazy-create + mount the toolbar view #1.
    mgr.setHostToolbarBounds(RECT)

    expect(constructed.length, 'first setHostToolbarBounds must lazily create the toolbar view').toBe(1)
    const firstView = constructed[0]!
    expect(addChildView, 'the first toolbar view must be mounted into the contentView').toHaveBeenCalledTimes(1)
    expect(addChildView.mock.calls[0]![0]).toBe(firstView)

    // 2. The host destroys the toolbar's webContents out from under us.
    firstView.webContents.close()
    expect(firstView.webContents.isDestroyed()).toBe(true)

    // 3. Next non-empty bounds must REBUILD the view (ensure-path sees the
    //    webContents is destroyed) and re-mount it so the toolbar stays visible.
    mgr.setHostToolbarBounds(RECT)

    expect(constructed.length, 'the destroyed toolbar view must be rebuilt').toBe(2)
    const secondView = constructed[1]!
    expect(secondView).not.toBe(firstView)

    // ── PINNED ASSERTION A: the freshly-built view IS mounted. ──────────────
    // Current bug: hostToolbarViewAdded stays true across the rebuild, so the
    // "already added?" guard skips this addChildView and the toolbar vanishes.
    const addedSecond = addChildView.mock.calls.some((c) => c[0] === secondView)
    expect(addedSecond, 'the rebuilt toolbar view must be addChildView-ed (otherwise the toolbar is invisible)').toBe(true)

    // ── PINNED ASSERTION B: the dead view is removed from the contentView. ──
    const removedFirst = removeChildView.mock.calls.some((c) => c[0] === firstView)
    expect(removedFirst, 'the destroyed toolbar view must be removeChildView-ed from the contentView').toBe(true)
  })
})
