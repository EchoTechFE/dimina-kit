/**
 * Native child-tree lifecycle regressions. Hard teardown, lazy recreation and
 * renderer readiness all converge through the reconciler's applied-state
 * ledger, so several rebuilt views can attach after the same project close.
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
import {
  showSettingsReady,
  showTooltipReady,
  simulatorDevtoolsBounds,
  simulatorBounds,
} from './placement-test-driver.js'
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

const SIM_URL = 'http://localhost:7788/simulator.html?appId=native-tree-rebuild'
const VISIBLE_RECT = { x: 0, y: 0, width: 320, height: 640 }
const VISIBLE_SIM = { x: 0, y: 0, width: 300, height: 600, zoom: 100 }
const TOOLTIP_PAYLOAD = { anchor: { x: 0, y: 0, width: 10, height: 10 }, text: 'hi' }

beforeEach(() => {
  constructed.length = 0
})

describe('ViewManager rebuild after detachSimulator', () => {
  it('re-attaches a fresh settings instance, not a silent no-op', async () => {
    const { addChildView, ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.attachNativeSimulator(SIM_URL, 375)
    await showSettingsReady(mgr)
    const oldSettingsId = mgr.getSettingsWebContentsId()
    expect(oldSettingsId).not.toBeNull()

    // Aggregate teardown destroys simulator, settings, tooltip and DevTools
    // host through the same native-tree owner.
    mgr.detachSimulator()
    expect(mgr.getSettingsWebContentsId()).toBeNull()

    const addsBefore = addChildView.mock.calls.length
    await showSettingsReady(mgr)

    // A recreated instance must generate a real native attach, not inherit the
    // destroyed instance's applied state.
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
    showTooltipReady(mgr, TOOLTIP_PAYLOAD)
    const oldTooltipId = mgr.getTooltipWebContentsId()
    expect(oldTooltipId).not.toBeNull()

    mgr.detachSimulator()
    expect(mgr.getTooltipWebContentsId()).toBeNull()

    const addsBefore = addChildView.mock.calls.length
    showTooltipReady(mgr, TOOLTIP_PAYLOAD)

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

    // Rebuild with a fresh attach and republished DevTools bounds.
    mgr.attachNativeSimulator(SIM_URL, 375)
    const newDevtoolsView = constructed[constructedBefore + 1]!
    simulatorDevtoolsBounds(mgr, VISIBLE_RECT)

    expect(addChildView.mock.calls.length).toBeGreaterThan(addsBefore)
    expect(addChildView.mock.calls.map((c) => c[0])).toContain(newDevtoolsView)
  })
})

describe('ViewManager rebuild after project close', () => {
  it('reattaches every rebuilt view when one reconcile lands before the overlays reopen', async () => {
    const { addChildView, ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.attachNativeSimulator(SIM_URL, 375)
    simulatorDevtoolsBounds(mgr, VISIBLE_RECT)
    await showSettingsReady(mgr)
    showTooltipReady(mgr, TOOLTIP_PAYLOAD)

    mgr.detachSimulator()
    const constructedBeforeReopen = constructed.length
    mgr.attachNativeSimulator(SIM_URL, 375)
    simulatorDevtoolsBounds(mgr, VISIBLE_RECT)
    await showSettingsReady(mgr)
    showTooltipReady(mgr, TOOLTIP_PAYLOAD)

    const rebuilt = constructed.slice(constructedBeforeReopen)
    const added = addChildView.mock.calls.map((call) => call[0])
    const settings = rebuilt.find((view) => view.webContents.id === mgr.getSettingsWebContentsId())
    const tooltip = rebuilt.find((view) => view.webContents.id === mgr.getTooltipWebContentsId())
    const devtoolsHost = rebuilt[1]

    expect(settings).toBeDefined()
    expect(tooltip).toBeDefined()
    expect(devtoolsHost).toBeDefined()
    expect(added).toEqual(expect.arrayContaining([settings, tooltip, devtoolsHost]))
  })
})

describe('Overlay renderer readiness and tooltip measurement', () => {
  it('keeps settings hidden until its renderer subscriptions are ready', async () => {
    const { addChildView, ctx } = makeContext()
    const mgr = createViewManager(ctx)
    let settled = false

    const shown = mgr.showSettings().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(addChildView).not.toHaveBeenCalled()

    const webContentsId = mgr.getSettingsWebContentsId()
    expect(webContentsId).not.toBeNull()
    mgr.markOverlayReady(webContentsId!)
    await shown

    expect(settled).toBe(true)
    expect(addChildView).toHaveBeenCalledTimes(1)
  })

  it('measures and shows only the latest tooltip request', () => {
    const { addChildView, notify, ctx } = makeContext()
    const mgr = createViewManager(ctx)
    mgr.prepareTooltip()
    const tooltipId = mgr.getTooltipWebContentsId()!

    mgr.showTooltip({ anchor: { x: 20, y: 10, width: 20, height: 20 }, text: 'first' })
    mgr.showTooltip({ anchor: { x: 100, y: 40, width: 20, height: 20 }, text: 'second' })
    expect(notify.tooltipInit).not.toHaveBeenCalled()
    expect(addChildView).not.toHaveBeenCalled()

    mgr.markOverlayReady(tooltipId)
    expect(notify.tooltipInit).toHaveBeenCalledTimes(1)
    expect(notify.tooltipInit.mock.calls[0]![1]).toEqual({
      requestId: 2,
      text: 'second',
      maxWidth: 1272,
    })

    mgr.applyTooltipMeasurement(tooltipId, { requestId: 1, width: 200, height: 40 })
    expect(addChildView).not.toHaveBeenCalled()

    mgr.applyTooltipMeasurement(tooltipId, { requestId: 2, width: 90, height: 28 })
    expect(addChildView).toHaveBeenCalledTimes(1)
    const tooltipView = constructed.find((view) => view.webContents.id === tooltipId)!
    expect(tooltipView.setBounds).toHaveBeenLastCalledWith({
      x: 65,
      y: 66,
      width: 90,
      height: 28,
    })

    mgr.hideTooltip()
    const addsAfterHide = addChildView.mock.calls.length
    mgr.applyTooltipMeasurement(tooltipId, { requestId: 2, width: 120, height: 30 })
    expect(addChildView).toHaveBeenCalledTimes(addsAfterHide)
  })
})

describe('ViewManager detach: multiple same-tick removals share the native-tree owner', () => {
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
