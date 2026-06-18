/**
 * Overlay z-order invariant: the SETTINGS and POPOVER overlays are the "top
 * tier" and MUST always sit above the "base tier" overlays (the native
 * simulator content WebContentsView and the console/DevTools host WebContentsView).
 *
 * Native overlays stack by `contentView.addChildView` order: the LAST-added
 * view is topmost. So when a base overlay is (re)attached AFTER settings/popover
 * is already open — e.g. the simulator content view is re-published, or the
 * console/DevTools bounds republish re-adds it — the base overlay's
 * `addChildView` would move it to the top and OCCLUDE the open settings/popover.
 *
 * These tests pin the invariant by inspecting the recorded `addChildView`
 * call ORDER (last call's first arg = topmost view). They are EXPECTED TO FAIL
 * until the fix re-raises settings/popover above any base overlay that is added
 * while they are open.
 *
 * The mock setup (electron WebContentsView stub, `constructed[]` tracking,
 * `makeContext`, paths mock) mirrors `view-manager.test.ts` exactly.
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

const SIM_URL = 'http://localhost:7788/simulator.html?appId=zorder'
const VISIBLE_RECT = { x: 0, y: 0, width: 320, height: 640 }
const VISIBLE_SIM = { x: 0, y: 0, width: 300, height: 600, zoom: 100 }

// Last addChildView call's first arg = the topmost view.
function lastAdded(addChildView: ReturnType<typeof vi.fn>): StubView {
  const calls = addChildView.mock.calls
  return calls[calls.length - 1]![0] as StubView
}

beforeEach(() => {
  constructed.length = 0
})

describe('ViewManager overlay z-order: top tier (settings/popover) stays above base tier', () => {
  it('settings stays on top when the console/devtools overlay is (re)attached', async () => {
    const { addChildView, ctx } = makeContext()
    const mgr = createViewManager(ctx)

    // Create the simulatorView (console/DevTools host) so its bounds can be
    // published. No addChildView fires here (no rect override yet).
    mgr.attachNativeSimulator(SIM_URL, 375)
    const addsAfterAttach = addChildView.mock.calls.length

    // Settings opens on top.
    await mgr.showSettings()
    const settingsView = lastAdded(addChildView)

    // The console/DevTools overlay bounds republish re-adds the base view —
    // which, without the fix, moves it ABOVE the open settings overlay.
    mgr.setSimulatorDevtoolsBounds(VISIBLE_RECT)

    // Two base overlays exist; settings is the distinct top-tier view.
    expect(addChildView.mock.calls.length).toBeGreaterThan(addsAfterAttach + 1)
    // Invariant: settings must end up topmost again.
    expect(lastAdded(addChildView)).toBe(settingsView)
  })

  it('settings stays on top when the native simulator is (re)attached', async () => {
    const { addChildView, ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.attachNativeSimulator(SIM_URL, 375)

    await mgr.showSettings()
    const settingsView = lastAdded(addChildView)

    // Publishing a VISIBLE native-simulator rect adds nativeSimulatorView (base
    // tier), which without the fix would occlude the open settings overlay.
    mgr.setNativeSimulatorViewBounds(VISIBLE_SIM)

    expect(lastAdded(addChildView)).toBe(settingsView)
  })

  it('popover stays on top when the console/devtools overlay is (re)attached', () => {
    const { addChildView, ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.attachNativeSimulator(SIM_URL, 375)

    mgr.showPopover({ z: 1 })
    const popoverView = lastAdded(addChildView)

    mgr.setSimulatorDevtoolsBounds(VISIBLE_RECT)

    expect(lastAdded(addChildView)).toBe(popoverView)
  })

  it('popover stays on top when the native simulator is (re)attached', () => {
    const { addChildView, ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.attachNativeSimulator(SIM_URL, 375)

    mgr.showPopover({ z: 1 })
    const popoverView = lastAdded(addChildView)

    mgr.setNativeSimulatorViewBounds(VISIBLE_SIM)

    expect(lastAdded(addChildView)).toBe(popoverView)
  })

  it('settings + popover both open: a re-added base overlay leaves popover topmost and settings above the base', async () => {
    const { addChildView, ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.attachNativeSimulator(SIM_URL, 375)

    await mgr.showSettings()
    const settingsView = lastAdded(addChildView)
    mgr.showPopover({ z: 1 })
    const popoverView = lastAdded(addChildView)

    // Re-add a base overlay (console/DevTools host) while both top-tier
    // overlays are open.
    mgr.setSimulatorDevtoolsBounds(VISIBLE_RECT)

    // Popover must end up topmost; settings must sit immediately below it
    // (i.e. above the just-added base overlay).
    const calls = addChildView.mock.calls
    const topMost = calls[calls.length - 1]![0]
    const secondTop = calls[calls.length - 2]![0]
    expect(topMost).toBe(popoverView)
    expect(secondTop).toBe(settingsView)
  })
})

describe('ViewManager overlay z-order: no spurious re-raise when nothing is open', () => {
  it('attaching/publishing a base overlay with settings & popover closed performs exactly one addChildView for the base view', () => {
    const { addChildView, ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.attachNativeSimulator(SIM_URL, 375)
    // [0] = native simulator content view (created first in attachNativeSimulator);
    // [1] = console/DevTools host view (created in attachNativeSimulatorDevtoolsHost).
    const nativeSimulatorView = constructed[0]!
    expect(addChildView).not.toHaveBeenCalled()

    // Publish a visible native-simulator rect: the ONLY add should be the base
    // view itself — no spurious re-raise of a non-existent top-tier overlay.
    mgr.setNativeSimulatorViewBounds(VISIBLE_SIM)

    expect(addChildView).toHaveBeenCalledTimes(1)
    expect(addChildView.mock.calls[0]![0]).toBe(nativeSimulatorView)
  })
})
