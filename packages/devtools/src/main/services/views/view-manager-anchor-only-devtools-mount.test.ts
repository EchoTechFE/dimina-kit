/**
 * Simulator-DevTools overlay: anchor-published bounds become the ONLY mount
 * path (static-layout fallback decommission), plus removal of the legacy
 * `<webview>`-route `attachSimulator` method.
 *
 * Contract (B1 + B2-11 + A5):
 *   B1-7  After `attachNativeSimulator` and BEFORE the renderer's first anchor
 *         bounds publish, the DevTools overlay view must be neither
 *         addChildView'd nor setBounds'd. (Old behavior: attach computed a
 *         `computeSimulatorBounds` fallback rect and mounted immediately.)
 *   B1-8  The first non-zero publish mounts the view with EXACTLY the
 *         published rect — never a statically computed one.
 *   B1-9  A window resize before the first publish still mounts nothing and
 *         sets no bounds (no static-layout resurrection via resize()/
 *         repositionAll()).
 *   B2-11 Visibility is the anchor single path: a 0×0 publish removes the
 *         child view (WebContents kept alive); a later non-zero publish
 *         re-mounts it. Every setBounds the view ever sees is a published
 *         rect. (Not covered by the existing view-manager.test.ts, which only
 *         exercises settings/popover/getSimulatorWebContents.)
 *   A5    `createViewManager(...)`'s returned object no longer exposes
 *         `attachSimulator` (old `<webview>` route; native-host is the sole
 *         runtime and mounts DevTools via `attachNativeSimulator`).
 *
 * Real bug each test catches:
 *   - B1-7/8: the attach-time fallback mount races the renderer's precise
 *     anchor rect — the overlay flashes at a wrong static rectangle (the old
 *     clip/surround flips) before the real rect lands. Deleting
 *     `computeSimulatorBounds` but keeping ANY attach-time
 *     addChildView/setBounds (e.g. an inlined replacement rect) fails these.
 *   - B1-9: deleting the attach fallback but leaving `resize()`/
 *     `repositionAll()` able to apply a static rect resurrects the same race
 *     on the first window resize.
 *   - B2-11: while deleting the Resize/SetVisible/Select channels, breaking
 *     the surviving 0×0-hide / non-zero-remount path would leave the overlay
 *     painted over a collapsed panel (or destroyed, re-paying the DevTools
 *     bootstrap on re-show).
 *   - A5: keeping `attachSimulator` keeps a second, divergent DevTools mount
 *     path alive that no caller maintains (its `webContents.fromId` lookup +
 *     static fallback diverge from the native path's invariants).
 *
 * Guards that view-manager.ts attachNativeSimulatorDevtoolsHost (getDefaultTab
 * === 'simulator' branch) does NOT mount or apply `computeSimulatorBounds`
 * when no override has been published yet, that `resize()` does not re-apply
 * it, and that `attachSimulator` is no longer on the returned object.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── electron stub ───────────────────────────────────────────────────────────
// Tracks every WebContentsView ever constructed (construction order:
// attachNativeSimulator builds [0] = the native simulator content view, then
// attachNativeSimulatorDevtoolsHost builds [1] = the DevTools overlay view).
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
import { simulatorDevtoolsBounds } from './placement-test-driver.js'
import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'

const SIM_URL = 'http://localhost:7788/simulator.html?appId=anchoronly'

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
      // 'console' present → getDefaultTab() === 'simulator', i.e. exactly the
      // branch that used to take the attach-time static-fallback mount.
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
function removesOf(removeChildView: ReturnType<typeof vi.fn>, view: StubView): unknown[][] {
  return removeChildView.mock.calls.filter((c) => c[0] === view)
}

beforeEach(() => {
  constructed.length = 0
})

describe('A5: the legacy <webview>-route attachSimulator method is removed', () => {
  it('createViewManager(...) returns an object WITHOUT attachSimulator', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    // `in` (not just typeof) so a renamed-but-still-exported stub is caught too.
    expect(
      'attachSimulator' in mgr,
      'attachSimulator is the dead <webview>-route mount path; native-host mounts DevTools via attachNativeSimulator only',
    ).toBe(false)
  })
})

describe('B1: DevTools overlay mounts ONLY from a published anchor rect', () => {
  it('7: after attachNativeSimulator, before the first publish, the overlay is neither added nor sized', () => {
    const { addChildView, ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.attachNativeSimulator(SIM_URL, 375)

    // [0] = native simulator content view, [1] = DevTools overlay view.
    expect(constructed.length).toBe(2)
    const devtoolsView = constructed[1]!

    // No renderer publish has arrived → nothing may be mounted or sized.
    // (The native simulator view is also rect-gated — Model A — so NOTHING
    // should have been added at all.)
    expect(
      addsOf(addChildView, devtoolsView).length,
      'attach must not mount the DevTools overlay from a statically computed fallback rect',
    ).toBe(0)
    expect(
      devtoolsView.setBounds,
      'attach must not size the DevTools overlay before the renderer reports its anchor rect',
    ).not.toHaveBeenCalled()
    expect(addChildView).not.toHaveBeenCalled()
  })

  it('9: a window resize before the first publish still mounts nothing and sets no bounds', () => {
    const { addChildView, ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.attachNativeSimulator(SIM_URL, 375)
    const devtoolsView = constructed[1]!

    // Both window-resize entry points of the manager.
    mgr.resize(520)
    mgr.repositionAll()

    expect(
      addsOf(addChildView, devtoolsView).length,
      'resize/repositionAll must not resurrect a static-layout mount while no anchor rect exists',
    ).toBe(0)
    expect(devtoolsView.setBounds).not.toHaveBeenCalled()
  })

  it('8: the first non-zero publish mounts the overlay with EXACTLY the published rect', () => {
    const { addChildView, ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.attachNativeSimulator(SIM_URL, 375)
    const devtoolsView = constructed[1]!

    const r1 = { x: 17, y: 23, width: 301, height: 203 }
    simulatorDevtoolsBounds(mgr,r1)

    expect(addsOf(addChildView, devtoolsView).length).toBe(1)
    // EVERY setBounds the overlay ever saw is the published rect — a leading
    // computeSimulatorBounds-style fallback call fails this exact-list check.
    expect(
      devtoolsView.setBounds.mock.calls,
      'the overlay must be sized by the published rect and ONLY ever by published rects',
    ).toEqual([[r1]])
  })
})

describe('B2-11: visibility is the anchor 0×0 single path', () => {
  it('0×0 publish unmounts (WebContents kept alive); a later non-zero publish re-mounts', () => {
    const { addChildView, removeChildView, ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.attachNativeSimulator(SIM_URL, 375)
    const devtoolsView = constructed[1]!

    const r1 = { x: 10, y: 20, width: 300, height: 200 }
    const r2 = { x: 12, y: 22, width: 320, height: 240 }

    simulatorDevtoolsBounds(mgr,r1)
    simulatorDevtoolsBounds(mgr,{ x: 0, y: 0, width: 0, height: 0 })

    // Hidden via setVisible(false), NOT removeChildView: the overlay stays
    // attached (hidden) so a re-show never re-pays the DevTools bootstrap; the
    // WebContents is kept alive.
    expect(removesOf(removeChildView, devtoolsView).length).toBe(0)
    expect(devtoolsView.setVisible).toHaveBeenCalledWith(false)
    expect(devtoolsView.webContents.close).not.toHaveBeenCalled()
    expect(devtoolsView.webContents.destroyed).toBe(false)

    simulatorDevtoolsBounds(mgr,r2)

    // Mounted EXACTLY once (the r1 publish); the 0×0 hide and the r2 re-show ride
    // setVisible(false)/(true), so there is never a second addChildView.
    expect(
      addsOf(addChildView, devtoolsView).length,
      'the overlay mounts once (r1); hide/re-show is setVisible, not re-mount',
    ).toBe(1)
    expect(devtoolsView.setVisible).toHaveBeenLastCalledWith(true)
    // The 0×0 hide call sets no bounds; every applied rect is a published one.
    expect(devtoolsView.setBounds.mock.calls).toEqual([[r1], [r2]])
  })
})
