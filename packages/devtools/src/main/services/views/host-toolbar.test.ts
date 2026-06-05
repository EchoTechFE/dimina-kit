/**
 * Host-controllable toolbar WebContentsView lifecycle.
 *
 * Pins the behaviour of the ViewManager's host-toolbar overlay — a strip
 * above the devtools header whose own renderer drives the reverse
 * size-advertiser. The downstream host loads its own content into it and
 * fully controls it via `hostToolbar.loadURL/loadFile/hide`, while the main
 * renderer positions it via `setHostToolbarBounds` (forward anchor) and the
 * toolbar's renderer advertises its intrinsic height via `setHostToolbarHeight`.
 *
 * Mirrors view-manager.test.ts exactly (same electron mock that tracks
 * constructed WebContentsView instances + addChildView/removeChildView on the
 * main contentView, same makeContext shape). The only extension is a
 * `loadURL` spy on the stub WebContents (the harness stub only had `loadFile`).
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
}

const constructed: StubView[] = []

const mockFromId = vi.fn((_id: number) => null as unknown)

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
    // host-toolbar code never touches ipcMain/shell in these tests, but the
    // module imports them at top level — provide harmless stubs.
    ipcMain: { on: vi.fn(), removeListener: vi.fn() },
    shell: { openExternal: vi.fn() },
  }
})

vi.mock('../../utils/paths.js', () => ({
  mainPreloadPath: '/stub/preload.js',
  hostToolbarPreloadPath: '/stub/host-toolbar-preload.js',
  cjsSiblingPreloadPath: (p: string) => p,
  devtoolsPackageRoot: '/stub/devtools-pkg-root',
}))

// Import AFTER mocks so view-manager picks up the stubs.
import { createViewManager } from './view-manager.js'
import { createConnectionRegistry } from '@dimina-kit/workbench/main'

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
    hostToolbarHeightChanged: vi.fn(),
  }
  return {
    mainWindow,
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

const RECT = { x: 0, y: 0, width: 1280, height: 48 }

describe('ViewManager: host-toolbar bounds (forward anchor, lazy create, idempotent add)', () => {
  it('first non-zero setHostToolbarBounds lazy-creates ONE view, adds it once, and sets those bounds', () => {
    const { addChildView, removeChildView, ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.setHostToolbarBounds(RECT)

    // Exactly one host-toolbar WebContentsView constructed.
    expect(constructed.length).toBe(1)
    const view = constructed[0]!

    // Added to the main contentView once, with this exact view instance.
    expect(addChildView).toHaveBeenCalledTimes(1)
    expect(addChildView.mock.calls[0]![0]).toBe(view)
    expect(removeChildView).not.toHaveBeenCalled()

    // Bounds applied.
    expect(view.setBounds).toHaveBeenCalledTimes(1)
    expect(view.setBounds.mock.calls[0]![0]).toEqual(RECT)
  })

  it('a SECOND non-zero setHostToolbarBounds reuses the SAME view (no 2nd construct, no 2nd add), only re-sets bounds', () => {
    const { addChildView, ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.setHostToolbarBounds(RECT)
    const RECT2 = { x: 0, y: 0, width: 1000, height: 56 }
    mgr.setHostToolbarBounds(RECT2)

    // No second construction.
    expect(constructed.length).toBe(1)
    const view = constructed[0]!

    // addChildView idempotent: still called exactly once total.
    expect(addChildView).toHaveBeenCalledTimes(1)

    // Bounds re-applied with the new rect.
    expect(view.setBounds).toHaveBeenCalledTimes(2)
    expect(view.setBounds.mock.calls[1]![0]).toEqual(RECT2)
  })

  it('zero-area setHostToolbarBounds after shown removes the view but does NOT destroy it; a later non-zero re-adds the SAME instance', () => {
    const { addChildView, removeChildView, ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.setHostToolbarBounds(RECT)
    const view = constructed[0]!

    // Hide via zero-area rect.
    mgr.setHostToolbarBounds({ x: 0, y: 0, width: 0, height: 0 })
    expect(removeChildView).toHaveBeenCalledTimes(1)
    expect(removeChildView.mock.calls[0]![0]).toBe(view)
    // NOT destroyed — kept alive for re-show.
    expect(view.webContents.close).not.toHaveBeenCalled()
    expect(view.webContents.destroyed).toBe(false)

    // Re-show: no new construction, re-adds the SAME instance.
    mgr.setHostToolbarBounds(RECT)
    expect(constructed.length).toBe(1)
    expect(addChildView).toHaveBeenCalledTimes(2)
    expect(addChildView.mock.calls[1]![0]).toBe(view)
  })

  it('zero-area bounds before any view exists does not construct a view just to hide it', () => {
    const { addChildView, removeChildView, ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.setHostToolbarBounds({ x: 0, y: 0, width: 0, height: 0 })

    expect(constructed.length).toBe(0)
    expect(addChildView).not.toHaveBeenCalled()
    expect(removeChildView).not.toHaveBeenCalled()
  })
})

describe('ViewManager: host-toolbar height advertise (reverse size-advertiser)', () => {
  it('setHostToolbarHeight(48) notifies hostToolbarHeightChanged(48) exactly once', () => {
    const { notify, ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.setHostToolbarHeight(48)

    expect(notify.hostToolbarHeightChanged).toHaveBeenCalledTimes(1)
    expect(notify.hostToolbarHeightChanged).toHaveBeenCalledWith(48)
  })

  it('does not require the toolbar view to exist (advertise can precede attach)', () => {
    const { notify, ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.setHostToolbarHeight(72)

    expect(constructed.length).toBe(0)
    expect(notify.hostToolbarHeightChanged).toHaveBeenCalledWith(72)
  })
})

describe('ViewManager: getHostToolbarWebContentsId', () => {
  it('is null before any host-toolbar view exists', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    expect(mgr.getHostToolbarWebContentsId()).toBeNull()
  })

  it('returns the WCV webContents id after setHostToolbarBounds creates it', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.setHostToolbarBounds(RECT)
    const view = constructed[0]!

    expect(mgr.getHostToolbarWebContentsId()).toBe(view.webContents.id)
  })

  it('returns the WCV webContents id after hostToolbar.loadURL creates it', async () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    await mgr.hostToolbar.loadURL('https://x.test')
    const view = constructed[0]!

    expect(mgr.getHostToolbarWebContentsId()).toBe(view.webContents.id)
  })
})

describe('ViewManager: hostToolbar host control surface', () => {
  it('hostToolbar.webContents is null before creation', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    expect(mgr.hostToolbar.webContents).toBeNull()
  })

  it('loadURL lazy-creates the view and calls webContents.loadURL with the url; webContents then returns that wc', async () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    await mgr.hostToolbar.loadURL('https://x.test')

    expect(constructed.length).toBe(1)
    const view = constructed[0]!
    expect(view.webContents.loadURL).toHaveBeenCalledTimes(1)
    expect(view.webContents.loadURL).toHaveBeenCalledWith('https://x.test')

    expect(mgr.hostToolbar.webContents).toBe(view.webContents)
  })

  it('loadFile lazy-creates the view and calls webContents.loadFile with the path', async () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    await mgr.hostToolbar.loadFile('/abs/toolbar.html')

    expect(constructed.length).toBe(1)
    const view = constructed[0]!
    expect(view.webContents.loadFile).toHaveBeenCalledTimes(1)
    expect(view.webContents.loadFile).toHaveBeenCalledWith('/abs/toolbar.html')
  })

  it('loadURL twice reuses the same view (no second construction)', async () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    await mgr.hostToolbar.loadURL('https://a.test')
    await mgr.hostToolbar.loadURL('https://b.test')

    expect(constructed.length).toBe(1)
  })

  it('hostToolbar.hide() removes the view from the contentView (does not destroy it)', async () => {
    const { addChildView, removeChildView, ctx } = makeContext()
    const mgr = createViewManager(ctx)

    // Show it first (via bounds) so it is added to the contentView.
    mgr.setHostToolbarBounds(RECT)
    const view = constructed[0]!
    expect(addChildView).toHaveBeenCalledTimes(1)

    mgr.hostToolbar.hide()

    expect(removeChildView).toHaveBeenCalledTimes(1)
    expect(removeChildView.mock.calls[0]![0]).toBe(view)
    expect(view.webContents.close).not.toHaveBeenCalled()
    expect(view.webContents.destroyed).toBe(false)
  })
})

describe('ViewManager: disposeAll tears down the host-toolbar view', () => {
  it('closes the host-toolbar webContents and getHostToolbarWebContentsId becomes null', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.setHostToolbarBounds(RECT)
    const view = constructed[0]!
    expect(mgr.getHostToolbarWebContentsId()).toBe(view.webContents.id)

    mgr.disposeAll()

    expect(view.webContents.close).toHaveBeenCalledTimes(1)
    expect(view.webContents.destroyed).toBe(true)
    expect(mgr.getHostToolbarWebContentsId()).toBeNull()
  })
})

// ── Sender policy: the host-toolbar WCV is DELIBERATELY NOT globally trusted ──
// The host loads ARBITRARY content into the toolbar WCV, so granting it the
// global white-list would open all ~72 IpcRegistry channels to that content
// (project-fs / panels.executeJavaScript / storage …) — a large blast radius
// (codex review finding (b), HIGH). Its one channel (the reverse size-advertiser)
// is instead a raw `ipcMain.on` gated on its exact wc id in `registerViewsIpc`.
// So the policy must REJECT the toolbar wc, and `getHostToolbarWebContentsId`
// exists only to feed that raw per-id gate.
import { createWorkbenchSenderPolicy } from '../../utils/sender-policy.js'

function makeSenderPolicyCtx(hostToolbarId: number | null) {
  return {
    windows: {
      isMainSender: () => false,
      isSettingsWindowSender: () => false,
    } as unknown as import('../workbench-context.js').WorkbenchContext['windows'],
    trustedWindowSenderIds: new Map<number, number>(),
    views: {
      getSettingsWebContentsId: () => null,
      getPopoverWebContentsId: () => null,
      getHostToolbarWebContentsId: () => hostToolbarId,
    } as unknown as import('../workbench-context.js').WorkbenchContext['views'],
  }
}

function makeSender(id: number, destroyed = false) {
  return { id, isDestroyed: () => destroyed } as unknown as import('electron').WebContents
}

describe('createWorkbenchSenderPolicy: host-toolbar WCV is NOT globally trusted', () => {
  it('does NOT trust the toolbar wc id via the global policy (blast-radius containment)', () => {
    const HOST_TOOLBAR_ID = 99
    const policy = createWorkbenchSenderPolicy(makeSenderPolicyCtx(HOST_TOOLBAR_ID))

    // The advertise channel is gated by a raw per-id ipcMain.on, NOT this policy.
    expect(policy(makeSender(HOST_TOOLBAR_ID))).toBe(false)
  })

  it('rejects a random other sender id', () => {
    const policy = createWorkbenchSenderPolicy(makeSenderPolicyCtx(99))
    expect(policy(makeSender(12345))).toBe(false)
  })

  it('getHostToolbarWebContentsId returns the live WCV id (the per-id gate input)', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.setHostToolbarBounds(RECT)
    const view = constructed[0]!

    expect(mgr.getHostToolbarWebContentsId()).toBe(view.webContents.id)
  })
})
