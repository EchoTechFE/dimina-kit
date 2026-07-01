/**
 * Native simulator relaunch (hot-reload / project re-open): the REBUILT
 * simulator WebContentsView must be re-mounted onto `mainWindow.contentView`,
 * not left invisible forever.
 *
 * Contract: `tearDownNativeSimulatorView` (view-manager.ts ~1396) manually
 * `removeChildView`s the outgoing simulator WCV — bypassing the level-triggered
 * reconciler's own `detach` op — then `attachNativeSimulator` (~1478) tears the
 * old view down and builds a fresh `WebContentsView` for the new one. The
 * reconciler's `placementState.actual` map is the single source of truth for
 * "is VIEW_ID.simulator currently attached"; if teardown does not also forget
 * that record, the next reconcile still believes the (now-destroyed) old view
 * is attached, never emits an `attach` op for the rebuilt view, and
 * `addChildView` is never called on it.
 *
 * Bug this guards against: after a relaunch (e.g. a dev-server hot reload that
 * re-invokes `attachNativeSimulator` for the same project), the simulator
 * becomes permanently invisible — the DeviceShell region stays blank because
 * the new WCV was constructed but never attached to the window's content view.
 *
 * Fix: `tearDownNativeSimulatorView` calls
 * `placementState.actual.delete(VIEW_ID.simulator)` right after clearing
 * `nativeSimulatorView`, so the next `reconcileNow()` (fired at the end of the
 * following `attachNativeSimulator`) treats the rebuilt view as a fresh attach.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── electron stub ───────────────────────────────────────────────────────────
// Tracks every WebContentsView ever constructed (construction order:
// attachNativeSimulator builds [0] = the native simulator content view, then
// attachNativeSimulatorDevtoolsHost builds [1] = the DevTools overlay view —
// same ordering documented in the sibling anchor-only/max-listeners tests).
type StubWebContents = {
  destroyed: boolean
  id: number
  isDestroyed: () => boolean
  close: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  loadFile: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  setZoomFactor: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
}
type StubView = {
  webContents: StubWebContents
  setBounds: ReturnType<typeof vi.fn>
  setBackgroundColor: ReturnType<typeof vi.fn>
  setVisible: ReturnType<typeof vi.fn>
}

const constructed: StubView[] = []

vi.mock('electron', () => {
  let nextId = 1
  class WebContentsView {
    webContents: StubWebContents
    setBounds = vi.fn()
    setBackgroundColor = vi.fn()
    setVisible = vi.fn()
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
        setWindowOpenHandler: vi.fn(),
        setZoomFactor: vi.fn(),
        send: vi.fn(),
      }
      constructed.push(this as unknown as StubView)
    }
  }
  const ipcMain = {
    on: vi.fn(),
    removeListener: vi.fn(),
    handle: vi.fn(),
    removeHandler: vi.fn(),
  }
  return {
    WebContentsView,
    ipcMain,
    shell: { openExternal: vi.fn() },
    // attachNativeSimulator paints the WCV with simDeskBg() and subscribes to
    // nativeTheme `updated` to keep it in sync.
    nativeTheme: { shouldUseDarkColors: false, on: vi.fn(), removeListener: vi.fn() },
    webContents: {
      fromId: vi.fn(() => undefined),
      getAllWebContents: vi.fn(() => []),
    },
    default: { ipcMain },
  }
})

vi.mock('../../utils/paths.js', () => ({
  mainPreloadPath: '/stub/preload.js',
  hostToolbarPreloadPath: '/stub/host-toolbar-preload.js',
  cjsSiblingPreloadPath: (p: string) => p.replace(/\.js$/, '.cjs'),
  // workbench-context transitively imports builtin-templates.ts which reads
  // this at module load.
  devtoolsPackageRoot: '/stub/devtools-pkg-root',
}))

// Import AFTER mocks so view-manager picks up the stubs.
import { createViewManager } from './view-manager.js'
import { simulatorBounds } from './placement-test-driver.js'
import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'

const SIM_URL = 'http://localhost:7788/simulator.html?appId=relaunch'

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
    addChildView,
    removeChildView,
    ctx: {
      windows: {
        mainWindow: mainWindow as unknown as import('electron').BrowserWindow,
      } as import('../window-service.js').WindowService,
      rendererDir: '/stub/renderer',
      panels: ['console', 'wxml', 'storage', 'appdata'],
      notify: notify as unknown as import('../notifications/renderer-notifier.js').RendererNotifier,
      connections: createConnectionRegistry(),
      preloadPath: '/stub/sim-preload.js',
    },
  }
}

/** All addChildView calls that targeted `view`. */
function addsOf(addChildView: ReturnType<typeof vi.fn>, view: StubView): unknown[][] {
  return addChildView.mock.calls.filter((c) => c[0] === view)
}

beforeEach(() => {
  constructed.length = 0
})

describe('native simulator relaunch: the rebuilt WCV is re-attached to contentView', () => {
  it('re-attaches the second (rebuilt) simulator view after attachNativeSimulator relaunches onto an already-visible placement', () => {
    const { addChildView, ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.attachNativeSimulator(SIM_URL, 375)
    // [0] = the first native simulator content view.
    const firstSimulatorView = constructed[0]!
    expect(constructed.length).toBeGreaterThanOrEqual(1)

    // The renderer publishes a non-zero anchor rect: the first simulator view
    // becomes visible (mounted onto contentView).
    simulatorBounds(mgr, { x: 0, y: 0, width: 375, height: 812, zoom: 1 })
    expect(
      addsOf(addChildView, firstSimulatorView).length,
      'the first simulator view must mount once the renderer publishes a non-zero rect',
    ).toBe(1)

    // Relaunch: attachNativeSimulator is invoked again for the same manager
    // (hot reload / project re-open) — this tears the first view down (via
    // tearDownNativeSimulatorView) and builds a brand-new WebContentsView.
    // The renderer's last-published placement for VIEW_ID.simulator is still
    // the same non-zero rect (nothing re-publishes a fresh snapshot yet — the
    // level-triggered baseDesired table simply carries the prior value
    // forward), so the ONLY thing that can gate the rebuilt view's mount is
    // whether the reconciler still (wrongly) believes the outgoing view is
    // attached.
    mgr.attachNativeSimulator(SIM_URL, 375)

    // Per-attach construction order is [simulator view, DevTools overlay
    // view] (documented in the sibling anchor-only/max-listeners tests).
    // Relaunch's teardown removes/destroys the OLD views without
    // constructing anything, so the second attach's pair lands at
    // constructed[2] (simulator) / constructed[3] (devtools overlay).
    expect(
      constructed.length,
      'relaunch must rebuild a fresh simulator WebContentsView (and its DevTools overlay)',
    ).toBe(4)
    const rebuiltSimulatorView = constructed[2]!

    expect(rebuiltSimulatorView).not.toBe(firstSimulatorView)
    expect(
      addsOf(addChildView, rebuiltSimulatorView).length,
      'the rebuilt simulator view must be re-attached to contentView — the reconciler must not still think the destroyed outgoing view is attached',
    ).toBe(1)
  })
})
