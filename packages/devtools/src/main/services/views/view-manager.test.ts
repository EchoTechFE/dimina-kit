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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Track every WebContentsView instance ever constructed so we can assert
// construction counts and per-view add/remove pairing.
type StubWebContents = {
  destroyed: boolean
  id: number
  emit: (event: string, ...args: unknown[]) => void
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

// Exported so getSimulatorWebContents tests can override return values.
const mockFromId = vi.fn((_id: number) => null as unknown)

vi.mock('electron', () => {
  let nextId = 1
  class WebContentsView {
    webContents: StubWebContents
    setBounds = vi.fn()
    setBackgroundColor = vi.fn()
    constructor(_opts?: unknown) {
      const id = nextId++
      const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
      this.webContents = {
        destroyed: false,
        id,
        emit(event: string, ...args: unknown[]) {
          for (const handler of [...(handlers.get(event) ?? [])]) handler(...args)
        },
        isDestroyed() { return this.destroyed },
        close: vi.fn(function (this: StubWebContents) { this.destroyed = true }),
        loadFile: vi.fn(() => Promise.resolve()),
        loadURL: vi.fn(() => Promise.resolve()),
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          handlers.set(event, [...(handlers.get(event) ?? []), handler])
        }),
        once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          const onceHandler = (...args: unknown[]) => {
            handlers.set(
              event,
              (handlers.get(event) ?? []).filter((item) => item !== onceHandler),
            )
            handler(...args)
          }
          handlers.set(event, [...(handlers.get(event) ?? []), onceHandler])
        }),
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
    // attachNativeSimulator paints the WCV with simDeskBg() (reads
    // shouldUseDarkColors) and subscribes to `updated` to keep it in sync.
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
  // attachNativeSimulator hands the WCV the `.cjs` sibling of the preload.
  cjsSiblingPreloadPath: (p: string) => p.replace(/\.js$/, '.cjs'),
  // workbench-context transitively imports builtin-templates.ts which reads
  // this at module load to build the BUILTIN_TEMPLATES catalog.
  devtoolsPackageRoot: '/stub/devtools-pkg-root',
}))

// Import AFTER mocks so view-manager picks up the stubs.
import { createViewManager, resolveProjectEditorTarget } from './view-manager.js'
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
      // ViewManagerContext now requires the connection registry (P1 DoD #3).
      // These overlay-lifecycle tests don't touch the native simulator, so an
      // empty real registry satisfies the type without affecting behaviour.
      connections: createConnectionRegistry(),
      // Lets attachNativeSimulator proceed past its preload guard in the
      // getSimulatorWebContents tests below; inert for the overlay tests.
      preloadPath: '/stub/sim-preload.js',
    },
  }
}

beforeEach(() => {
  constructed.length = 0
})

describe('resolveProjectEditorTarget', () => {
  const serviceHostUrl =
    'file:///app/service-host/service.html?appId=wxabc123' +
    '&pkgRoot=%2Fworkspace%2Fdemo&root=main' +
    '&resourceBaseUrl=http%3A%2F%2F127.0.0.1%3A5173%2F'

  it('uses URL pkgRoot, verifies the file, and converts DevTools positions for Monaco', () => {
    const isFile = vi.fn(() => true)

    expect(resolveProjectEditorTarget(
      serviceHostUrl,
      '/workspace/demo',
      {
        url: 'http://127.0.0.1:5173/pages/console-test.js',
        line: 74,
        column: 2,
      },
      isFile,
    )).toEqual({
      path: 'pages/console-test.js',
      line: 75,
      column: 3,
    })
    expect(isFile).toHaveBeenCalledWith('/workspace/demo/pages/console-test.js')
  })

  it('rejects missing files and a workspace inconsistent with the URL pkgRoot', () => {
    expect(resolveProjectEditorTarget(
      serviceHostUrl,
      '/workspace/demo',
      { url: 'http://127.0.0.1:5173/pages/missing.js' },
      () => false,
    )).toBeNull()

    const isFile = vi.fn(() => true)
    expect(resolveProjectEditorTarget(
      serviceHostUrl,
      '/workspace/other-project',
      { url: 'http://127.0.0.1:5173/pages/console-test.js' },
      isFile,
    )).toBeNull()
    expect(isFile).not.toHaveBeenCalled()
  })
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

// ── getSimulatorWebContents (native-host attach path) ───────────────────────
// `attachNativeSimulator` creates the simulator content WebContentsView itself
// and records its webContents id as THE simulator id; `getSimulatorWebContents`
// resolves that id through `webContents.fromId` on every call so it never hands
// out a stale/destroyed reference.

const SIM_URL = 'http://localhost:7788/simulator.html?appId=vmtest'

describe('getSimulatorWebContents', () => {
  afterEach(() => {
    mockFromId.mockReset()
  })

  it('returns null when no simulator has been attached (simulatorWebContentsId is null)', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    expect(mgr.getSimulatorWebContents()).toBeNull()
    expect(mockFromId).not.toHaveBeenCalled()
  })

  it('returns null when webContents.fromId returns falsy for the stored id', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.attachNativeSimulator(SIM_URL, 375)
    // The simulator wc is gone from Electron's registry (e.g. destroyed).
    mockFromId.mockReturnValue(undefined)

    expect(mgr.getSimulatorWebContents()).toBeNull()
  })

  it('returns null when the webContents returned by fromId has isDestroyed() === true', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.attachNativeSimulator(SIM_URL, 375)
    mockFromId.mockReturnValue({ isDestroyed: () => true })

    expect(mgr.getSimulatorWebContents()).toBeNull()
  })

  it('returns the live webContents object when the simulator is attached and alive', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.attachNativeSimulator(SIM_URL, 375)

    // [0] = the native simulator content view (created first), [1] = the
    // DevTools overlay host view. The manager must resolve the SIM's id.
    const simWc = constructed[constructed.length - 2]!.webContents
    const liveWc = { isDestroyed: () => false }
    mockFromId.mockReturnValue(liveWc)

    expect(mgr.getSimulatorWebContents()).toBe(liveWc)
    expect(mockFromId).toHaveBeenCalledWith(simWc.id)
  })

  it('keeps attach pending until the first render guest finishes loading', async () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    let settled = false

    const attached = Promise.resolve(mgr.attachNativeSimulator(SIM_URL, 375))
      .then(() => {
        settled = true
      })
    await Promise.resolve()
    expect(settled).toBe(false)

    const simWc = constructed[constructed.length - 2]!.webContents
    const guestHandlers = new Map<string, (...args: unknown[]) => void>()
    const guestWc = {
      isDestroyed: () => false,
      once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        guestHandlers.set(event, handler)
      }),
      setZoomFactor: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
    }
    simWc.emit('did-attach-webview', {}, guestWc)
    await Promise.resolve()
    expect(settled).toBe(false)

    guestHandlers.get('did-finish-load')?.()
    await attached
    expect(settled).toBe(true)
  })
})
