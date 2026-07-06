/**
 * New contract under test: `ViewManager` must expose a `disposeProjectViews()`
 * that tears down PROJECT-scoped views (native simulator + its settings/popover
 * aggregate, embedded workbench editor, safe-area) WITHOUT touching the
 * host-toolbar — the toolbar's webContents lifecycle belongs to the HOST, not
 * to any one project (see host-toolbar-view.ts doc comment). `disposeAll()`
 * keeps its existing everything-including-toolbar meaning: it must equal
 * disposeProjectViews() PLUS host-toolbar teardown (view destroy, port-channel
 * close, session-runtime preload ref release).
 *
 * Today `workspace.closeProject()` calls `disposeAll()` directly, so every
 * project close destroys the host's toolbar even though the toolbar's own
 * design doc promises it survives close-project → reopen. This file pins the
 * missing split at the ViewManager layer; the harness mirrors view-manager.test.ts
 * (electron mock tracking constructed WebContentsViews) extended with the
 * session.defaultSession preload-registration stubs from host-toolbar tests
 * (needed because attaching the host-toolbar acquires the session-resident
 * runtime preload).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

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
  executeJavaScript: ReturnType<typeof vi.fn>
}
type StubView = {
  webContents: StubWebContents
  setBounds: ReturnType<typeof vi.fn>
  setBackgroundColor: ReturnType<typeof vi.fn>
  setVisible: ReturnType<typeof vi.fn>
}

// vi.mock('electron', ...) below is hoisted above regular top-level
// statements, so every piece of state it closes over must itself be
// vi.hoisted (mirrors host-toolbar-session-preload.test.ts's `h` pattern).
const h = vi.hoisted(() => ({
  constructed: [] as StubView[],
  mockFromId: vi.fn((_id: number) => null as unknown),
  registerPreloadScript: vi.fn(() => 'stub-preload-script-id'),
  unregisterPreloadScript: vi.fn(),
}))

vi.mock('electron', () => {
  let nextId = 1
  class WebContentsView {
    webContents: StubWebContents
    setBounds = vi.fn()
    setBackgroundColor = vi.fn()
    setVisible = vi.fn()
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
        executeJavaScript: vi.fn(() => Promise.resolve(undefined)),
      }
      h.constructed.push(this as unknown as StubView)
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
      fromId: (id: number) => h.mockFromId(id),
      getAllWebContents: vi.fn(() => []),
    },
    // The host-toolbar's session-runtime module acquires/releases this
    // registration on defaultSession — needed as soon as hostToolbar.loadURL runs.
    session: {
      defaultSession: {
        registerPreloadScript: h.registerPreloadScript,
        unregisterPreloadScript: h.unregisterPreloadScript,
      },
    },
    default: { ipcMain },
  }
})

vi.mock('../../utils/paths.js', () => ({
  mainPreloadPath: '/stub/preload.js',
  hostToolbarRuntimePreloadPath: '/stub/host-toolbar-runtime-preload.cjs',
  cjsSiblingPreloadPath: (p: string) => p.replace(/\.js$/, '.cjs'),
  devtoolsPackageRoot: '/stub/devtools-pkg-root',
}))

import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'

/**
 * Re-import view-manager fresh per test: the host-toolbar session-runtime
 * registration ref-count (host-toolbar-session-runtime.ts) is module state
 * shared across every ViewManager instance in the process, so each test needs
 * its own module instance for `registerPreloadScript`/`unregisterPreloadScript`
 * call counts to mean "this test's toolbar", not "whatever ran before it"
 * (mirrors host-toolbar-session-preload.test.ts).
 */
async function loadCreateViewManager() {
  const mod = await import('./view-manager.js')
  return mod.createViewManager
}

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
      notify: notify as unknown as import('../notifications/renderer-notifier.js').RendererNotifier,
      connections: createConnectionRegistry(),
      preloadPath: '/stub/sim-preload.js',
    },
  }
}

const SIM_URL = 'http://localhost:7788/simulator.html?appId=vmtest'
const COI_URL = 'http://localhost:7799/'

beforeEach(() => {
  vi.resetModules()
  h.constructed.length = 0
  h.registerPreloadScript.mockClear()
  h.unregisterPreloadScript.mockClear()
  h.mockFromId.mockReset()
})

describe('ViewManager.disposeProjectViews: tears down project-scoped views, leaves the host toolbar alive', () => {
  it('destroys the simulator + settings + workbench views, but the toolbar webContents survives', async () => {
    const createViewManager = await loadCreateViewManager()
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    // Host toolbar is set up first, independent of any project.
    await mgr.hostToolbar.loadURL('https://host.example/toolbar')
    const toolbarView = h.constructed[h.constructed.length - 1]!
    expect(mgr.getHostToolbarWebContentsId()).toBe(toolbarView.webContents.id)

    // Project-scoped views: simulator + settings + embedded workbench. Not
    // awaited: attachNativeSimulator's returned promise only settles once a
    // render guest reports 'did-finish-load' (see view-manager.test.ts's
    // "keeps attach pending" case) — the simulator webContents id is already
    // assigned synchronously before that point, which is all this test needs.
    mgr.attachNativeSimulator(SIM_URL, 375)
    await mgr.showSettings()
    await mgr.attachWorkbench(COI_URL)

    // Sanity: the simulator id is resolvable before teardown.
    expect(mgr.getSimulatorWebContentsId()).not.toBeNull()

    const disposeProjectViews = (mgr as unknown as { disposeProjectViews?: () => void })
      .disposeProjectViews
    expect(
      typeof disposeProjectViews,
      'ViewManager must expose disposeProjectViews() — the project-scoped teardown '
      + 'that workspace.closeProject() should call instead of disposeAll()',
    ).toBe('function')

    disposeProjectViews!.call(mgr)

    // Project views are gone.
    expect(mgr.getSimulatorWebContentsId(), 'simulator must be detached').toBeNull()
    expect(mgr.getSettingsWebContentsId(), 'settings overlay must be destroyed').toBeNull()

    // The host toolbar must be UNTOUCHED: still alive, id unchanged.
    expect(
      mgr.getHostToolbarWebContentsId(),
      'disposeProjectViews must not touch the host toolbar — its lifecycle belongs to the HOST',
    ).toBe(toolbarView.webContents.id)
    expect(toolbarView.webContents.destroyed).toBe(false)
    expect(toolbarView.webContents.close).not.toHaveBeenCalled()
  })
})

describe('ViewManager.disposeAll: unchanged semantics — project views AND the host toolbar', () => {
  it('still destroys the host toolbar (view + session-runtime preload ref) in addition to project views', async () => {
    const createViewManager = await loadCreateViewManager()
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    await mgr.hostToolbar.loadURL('https://host.example/toolbar')
    const toolbarView = h.constructed[h.constructed.length - 1]!
    expect(h.registerPreloadScript, 'toolbar creation must acquire the session-runtime preload ref').toHaveBeenCalledTimes(1)

    mgr.attachNativeSimulator(SIM_URL, 375)

    mgr.disposeAll()

    expect(mgr.getSimulatorWebContentsId()).toBeNull()
    expect(
      mgr.getHostToolbarWebContentsId(),
      'disposeAll must still tear down the host toolbar — only workspace.closeProject() '
      + 'is changing to the narrower disposeProjectViews()',
    ).toBeNull()
    expect(toolbarView.webContents.close).toHaveBeenCalledTimes(1)
    expect(toolbarView.webContents.destroyed).toBe(true)
    expect(
      h.unregisterPreloadScript,
      'the last ViewManager releasing the toolbar must unregister the session-runtime preload',
    ).toHaveBeenCalledTimes(1)
  })
})
