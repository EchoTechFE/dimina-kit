/**
 * Regression tests for the Compositor-mediated detach change
 * (placement-reconciler.ts) and the two `forgetActual` gaps it required
 * fixing:
 *
 *   - `overlay-panels-view.ts`'s `destroySettings()` raw-removes the
 *     settings + tooltip views but never told the reconciler, so its
 *     `actual` map kept thinking they were still attached — a rebuild after
 *     teardown silently never re-emitted the attach op (a permanently
 *     invisible view, no error).
 *   - `native-simulator-devtools-host.ts`'s `destroyHostView()` had the same
 *     gap for the DevTools host view.
 *
 * Each rebuild case below re-shows ONLY the one overlay it's testing, with
 * no OTHER reconciler-touching call in between `detachSimulator()` and the
 * re-show. That restriction is deliberate, not incidental: any other
 * reconcileNow() landing in that window — a second overlay's own show(),
 * `attachNativeSimulator()`'s internal reconcile, `workbench.detachWorkbench()`
 * inside the fuller `disposeProjectViews()` — hits a separate, PRE-EXISTING
 * reconcile-core quirk (confirmed present with or without this change's
 * `forgetActual` fix, same end state either way): `classifyView` optimistically
 * marks a still-desired, still-unattached id `attached: true` the moment
 * ANY reconcile runs, with no native call backing it (the view is still
 * null); a later `show()` with identical bounds then looks like a no-op
 * change to the core and never re-attaches. That means today, re-opening
 * MORE THAN ONE of settings/tooltip/devtools-host after a project
 * close→reopen only reliably recovers the first one shown — a real bug in
 * the reopen-after-close path, but orthogonal to the Compositor-detach
 * change this file verifies, so intentionally left unfixed and untested
 * here (flagged separately).
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
  setZoomFactor: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
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
    constructor(_opts?: unknown) {
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
    nativeTheme: { shouldUseDarkColors: false, on: vi.fn(), removeListener: vi.fn() },
    webContents: {
      fromId: (id: number) => mockFromId(id),
      getAllWebContents: vi.fn(() => []),
    },
    default: { ipcMain },
  }
})

vi.mock('../../utils/paths.js', () => ({
  mainPreloadPath: '/stub/preload.js',
  hostToolbarPreloadPath: '/stub/host-toolbar-preload.js',
  cjsSiblingPreloadPath: (p: string) => p.replace(/\.js$/, '.cjs'),
  devtoolsPackageRoot: '/stub/devtools-pkg-root',
}))

// Import AFTER mocks so view-manager picks up the stubs.
import { createViewManager } from './view-manager.js'
import { simulatorDevtoolsBounds, simulatorBounds } from './placement-test-driver.js'
import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'

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
    tooltipInit: vi.fn(),
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
      preloadPath: '/stub/sim-preload.js',
    },
  }
}

const SIM_URL = 'http://localhost:7788/simulator.html?appId=compositor-rebuild'
const VISIBLE_RECT = { x: 0, y: 0, width: 320, height: 640 }
const VISIBLE_SIM = { x: 0, y: 0, width: 300, height: 600, zoom: 100 }
const TOOLTIP_PAYLOAD = { anchor: { x: 0, y: 0, width: 10, height: 10 }, text: 'hi' }

beforeEach(() => {
  constructed.length = 0
})

describe('ViewManager rebuild after detachSimulator: previously-missing forgetActual calls', () => {
  it('re-attaches a fresh settings instance, not a silent no-op', async () => {
    const { addChildView, ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.attachNativeSimulator(SIM_URL, 375)
    await mgr.showSettings()
    const oldSettingsId = mgr.getSettingsWebContentsId()
    expect(oldSettingsId).not.toBeNull()

    // detachSimulator() aggregates tearDownNativeSimulatorView() +
    // overlayPanels.destroySettings() (settings + tooltip) +
    // devtoolsHost.destroyHostView() — the previously-unpaired raw
    // removeChildView sites this change fixed.
    mgr.detachSimulator()
    expect(mgr.getSettingsWebContentsId()).toBeNull()

    const addsBefore = addChildView.mock.calls.length
    await mgr.showSettings()

    // Without the forgetActual fix, the reconciler's stale `actual` map
    // treats settings as already-attached and never re-emits the attach op
    // — the view would silently never rejoin the contentView (a
    // permanently invisible overlay, no thrown error).
    expect(addChildView.mock.calls.length).toBeGreaterThan(addsBefore)
    expect(mgr.getSettingsWebContentsId()).not.toBeNull()
    expect(mgr.getSettingsWebContentsId()).not.toBe(oldSettingsId)
    const newSettingsView = constructed.find((v) => v.webContents.id === mgr.getSettingsWebContentsId())!
    expect(addChildView.mock.calls.map((c) => c[0])).toContain(newSettingsView)
  })

  it('re-attaches a fresh tooltip instance, not a silent no-op', () => {
    const { addChildView, ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.attachNativeSimulator(SIM_URL, 375)
    mgr.showTooltip(TOOLTIP_PAYLOAD)
    const oldTooltipId = mgr.getTooltipWebContentsId()
    expect(oldTooltipId).not.toBeNull()

    mgr.detachSimulator()
    expect(mgr.getTooltipWebContentsId()).toBeNull()

    const addsBefore = addChildView.mock.calls.length
    mgr.showTooltip(TOOLTIP_PAYLOAD)

    expect(addChildView.mock.calls.length).toBeGreaterThan(addsBefore)
    expect(mgr.getTooltipWebContentsId()).not.toBeNull()
    expect(mgr.getTooltipWebContentsId()).not.toBe(oldTooltipId)
    const newTooltipView = constructed.find((v) => v.webContents.id === mgr.getTooltipWebContentsId())!
    expect(addChildView.mock.calls.map((c) => c[0])).toContain(newTooltipView)
  })

  it('re-attaches a fresh devtools-host instance, not a silent no-op', () => {
    const { addChildView, ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.attachNativeSimulator(SIM_URL, 375)
    // [0] = native simulator content view, [1] = console/DevTools host view
    // (both constructed eagerly inside attachNativeSimulator).
    simulatorDevtoolsBounds(mgr, VISIBLE_RECT)
    const devtoolsAddedBefore = addChildView.mock.calls.map((c) => c[0])
    expect(devtoolsAddedBefore).toContain(constructed[1])

    mgr.detachSimulator()

    const constructedBefore = constructed.length
    const addsBefore = addChildView.mock.calls.length

    // Rebuild: a fresh attach + re-publish the devtools bounds.
    mgr.attachNativeSimulator(SIM_URL, 375)
    const newDevtoolsView = constructed[constructedBefore + 1]!
    simulatorDevtoolsBounds(mgr, VISIBLE_RECT)

    expect(addChildView.mock.calls.length).toBeGreaterThan(addsBefore)
    expect(addChildView.mock.calls.map((c) => c[0])).toContain(newDevtoolsView)
  })
})

describe('ViewManager batched detach: multiple same-tick removals go through one compositor.commit()', () => {
  it('removes both views when they drop out of a single placement snapshot publish', () => {
    const { addChildView, removeChildView, ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.attachNativeSimulator(SIM_URL, 375)
    const simView = constructed[0]!
    const devtoolsView = constructed[1]!

    simulatorBounds(mgr, VISIBLE_SIM)
    simulatorDevtoolsBounds(mgr, VISIBLE_RECT)
    expect(addChildView.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining([simView, devtoolsView]),
    )

    removeChildView.mockClear()

    // Publish a snapshot where BOTH views are entirely absent — one
    // reconcileNow() tick, two real detach ops, one batched commit().
    mgr.setPlacementSnapshot({ generation: 1, epoch: 999, views: [] })

    expect(removeChildView).toHaveBeenCalledWith(simView)
    expect(removeChildView).toHaveBeenCalledWith(devtoolsView)
    expect(removeChildView).toHaveBeenCalledTimes(2)
  })
})
