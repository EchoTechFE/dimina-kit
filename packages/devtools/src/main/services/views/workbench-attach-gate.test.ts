/**
 * Workbench attach gate: while the app boot critical window is open (old
 * session teardown + first compile), `holdWorkbenchAttach()` defers the
 * workbench WebContentsView's heavy creation (`new WebContentsView` +
 * `loadURL`) even when the editor slot's desired placement is already
 * visible. The gate only postpones creation — it never hides or destroys an
 * already-existing workbench view.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type StubWebContents = {
  destroyed: boolean
  id: number
  isDestroyed: () => boolean
  close: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  executeJavaScript: ReturnType<typeof vi.fn>
  setWindowOpenHandler: ReturnType<typeof vi.fn>
}
type StubView = {
  webContents: StubWebContents
  setBounds: ReturnType<typeof vi.fn>
}

const constructed: StubView[] = []

vi.mock('electron', () => {
  let nextId = 1
  class WebContentsView {
    webContents: StubWebContents
    setBounds = vi.fn()
    constructor(_opts?: unknown) {
      const id = nextId++
      this.webContents = {
        destroyed: false,
        id,
        isDestroyed() { return this.destroyed },
        close: vi.fn(function (this: StubWebContents) { this.destroyed = true }),
        loadURL: vi.fn(() => Promise.resolve()),
        executeJavaScript: vi.fn(() => Promise.resolve(null)),
        setWindowOpenHandler: vi.fn(),
      }
      constructed.push(this as unknown as StubView)
    }
  }
  const ipcMain = { on: vi.fn(), removeListener: vi.fn(), handle: vi.fn(), removeHandler: vi.fn() }
  return {
    WebContentsView,
    ipcMain,
    shell: { openExternal: vi.fn() },
    nativeTheme: { shouldUseDarkColors: false, on: vi.fn(), removeListener: vi.fn() },
    webContents: { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) },
    default: { ipcMain },
  }
})

vi.mock('../../utils/paths.js', () => ({
  mainPreloadPath: '/stub/preload.js',
  hostToolbarPreloadPath: '/stub/host-toolbar-preload.js',
  cjsSiblingPreloadPath: (p: string) => p.replace(/\.js$/, '.cjs'),
  devtoolsPackageRoot: '/stub/devtools-pkg-root',
}))

import { createViewManager } from './view-manager.js'
import { workbenchBounds } from './placement-test-driver.js'
import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'
import { createCdpSessionBroker } from '../cdp-session/index.js'

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
  return {
    mainWindow,
    ctx: {
      windows: { mainWindow: mainWindow as unknown as import('electron').BrowserWindow } as import('../window-service.js').WindowService,
      rendererDir: '/stub/renderer',
      panels: ['console', 'wxml', 'storage', 'appdata'],
      notify: { popoverInit: vi.fn(), popoverClosed: vi.fn() } as unknown as import('../notifications/renderer-notifier.js').RendererNotifier,
      connections: createConnectionRegistry(),
      cdpSessionBroker: createCdpSessionBroker(),
      preloadPath: '/stub/sim-preload.js',
    },
  }
}

const WORKBENCH_URL = 'http://127.0.0.1:9000/'
const VISIBLE_RECT = { x: 0, y: 0, width: 800, height: 600 }

// The gate has to have created zero views and issued zero loadURL calls yet.
function expectNoAttachYet(): void {
  expect(constructed.length).toBe(0)
}

beforeEach(() => {
  constructed.length = 0
  vi.useFakeTimers()
})

describe('workbench attach gate: holdWorkbenchAttach defers the lazy WebContentsView creation', () => {
  it('does not create the workbench view while held, even with a source set and the editor slot visible', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.setWorkbenchSource(WORKBENCH_URL)
    expect(typeof mgr.holdWorkbenchAttach).toBe('function')
    mgr.holdWorkbenchAttach()
    workbenchBounds(mgr, VISIBLE_RECT)

    expectNoAttachYet()
  })

  it('releasing the hold replays reconcileNow and creates + loads the workbench view', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.setWorkbenchSource(WORKBENCH_URL)
    const release = mgr.holdWorkbenchAttach()
    workbenchBounds(mgr, VISIBLE_RECT)
    expectNoAttachYet()

    release()

    expect(constructed.length).toBe(1)
    expect(constructed[0]!.webContents.loadURL).toHaveBeenCalledTimes(1)
  })

  it('self-releases 3000ms after the hold with a console.warn fail-loud marker, and does not act twice', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.setWorkbenchSource(WORKBENCH_URL)
    mgr.holdWorkbenchAttach()
    workbenchBounds(mgr, VISIBLE_RECT)
    expectNoAttachYet()

    vi.advanceTimersByTime(3000)

    expect(constructed.length).toBe(1)
    expect(constructed[0]!.webContents.loadURL).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledTimes(1)

    // No second self-release action: further elapsed time is a no-op.
    vi.advanceTimersByTime(10_000)
    expect(constructed.length).toBe(1)
    expect(warnSpy).toHaveBeenCalledTimes(1)

    warnSpy.mockRestore()
  })

  it('a new hold supersedes the previous one: the old release is a no-op and the cap timer restarts', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.setWorkbenchSource(WORKBENCH_URL)
    const releaseA = mgr.holdWorkbenchAttach()
    workbenchBounds(mgr, VISIBLE_RECT)

    // Two seconds pass before the second hold supersedes the first.
    vi.advanceTimersByTime(2000)
    const releaseB = mgr.holdWorkbenchAttach()

    // A's release is stale — it must not open the gate.
    releaseA()
    expectNoAttachYet()

    // B's timer restarts from its own hold: 2999ms after B is still held.
    vi.advanceTimersByTime(2999)
    expectNoAttachYet()
    expect(warnSpy).not.toHaveBeenCalled()

    releaseB()
    expect(constructed.length).toBe(1)
    expect(constructed[0]!.webContents.loadURL).toHaveBeenCalledTimes(1)

    warnSpy.mockRestore()
  })

  it('calling the same release twice only replays the gate once (idempotent, no throw)', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.setWorkbenchSource(WORKBENCH_URL)
    const release = mgr.holdWorkbenchAttach()
    workbenchBounds(mgr, VISIBLE_RECT)

    expect(() => {
      release()
      release()
    }).not.toThrow()

    expect(constructed.length).toBe(1)
    expect(constructed[0]!.webContents.loadURL).toHaveBeenCalledTimes(1)
  })

  it('openFileInWorkbench passes straight through the gate on explicit user intent', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.setWorkbenchSource(WORKBENCH_URL)
    mgr.holdWorkbenchAttach()
    workbenchBounds(mgr, VISIBLE_RECT)
    expectNoAttachYet()

    const dispatched = mgr.openFileInWorkbench('pages/index.js', 1, 1)

    expect(dispatched).toBe(true)
    expect(constructed.length).toBe(1)
    expect(constructed[0]!.webContents.loadURL).toHaveBeenCalledTimes(1)
  })

  it('detachWorkbench during a hold does not release the gate', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.setWorkbenchSource(WORKBENCH_URL)
    mgr.holdWorkbenchAttach()
    workbenchBounds(mgr, VISIBLE_RECT)

    mgr.detachWorkbench()
    vi.advanceTimersByTime(2000)

    expectNoAttachYet()
  })

  it('holding after the view already exists has no effect: the live view is untouched and stays usable', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.setWorkbenchSource(WORKBENCH_URL)
    workbenchBounds(mgr, VISIBLE_RECT)
    expect(constructed.length).toBe(1)
    const liveView = constructed[0]!

    mgr.holdWorkbenchAttach()

    // The already-existing view must not be hidden or destroyed by the hold.
    expect(constructed.length).toBe(1)
    expect(liveView.webContents.destroyed).toBe(false)
    expect(liveView.webContents.close).not.toHaveBeenCalled()

    const dispatched = mgr.openFileInWorkbench('pages/index.js', 1, 1)
    expect(dispatched).toBe(true)
    // No second view constructed by the follow-up user-intent call.
    expect(constructed.length).toBe(1)
  })

  it('detachWorkbench during a hold preserves the desired placement, so release recreates the view (project-switch teardown)', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    // A workbench is already live (the outgoing project's editor).
    mgr.setWorkbenchSource(WORKBENCH_URL)
    workbenchBounds(mgr, VISIBLE_RECT)
    expect(constructed.length).toBe(1)
    const firstView = constructed[0]!

    // The incoming project's openProject holds the gate, then its teardown
    // section destroys the outgoing view — the desired placement must
    // survive this so release() can rebuild it for the new project.
    const release = mgr.holdWorkbenchAttach()
    mgr.detachWorkbench()
    expect(firstView.webContents.close).toHaveBeenCalledTimes(1)

    release()

    // A second WebContentsView is created and loaded — the editor comes
    // back for the new project once the gate opens.
    expect(constructed.length).toBe(2)
    expect(constructed[1]!.webContents.loadURL).toHaveBeenCalledTimes(1)
  })

  it('cancelWorkbenchAttachHold vetoes a hold outright: a close-path teardown after cancel never rebuilds a zombie view', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.setWorkbenchSource(WORKBENCH_URL)
    workbenchBounds(mgr, VISIBLE_RECT)
    expect(constructed.length).toBe(1)

    const release = mgr.holdWorkbenchAttach()
    expect(typeof mgr.cancelWorkbenchAttachHold).toBe('function')
    mgr.cancelWorkbenchAttachHold()
    // close-path teardown after the cancel (app teardown / closeProject).
    mgr.detachWorkbench()

    // Neither the (now-canceled) hold's late cap timer nor its late release
    // may rebuild the view: the request that owned this hold is gone.
    vi.advanceTimersByTime(3000)
    release()

    expect(constructed.length).toBe(1)
    expect(warnSpy).not.toHaveBeenCalled()

    warnSpy.mockRestore()
  })

  it('cancelWorkbenchAttachHold with no active hold is a no-op and leaves an existing view untouched', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.setWorkbenchSource(WORKBENCH_URL)
    workbenchBounds(mgr, VISIBLE_RECT)
    expect(constructed.length).toBe(1)
    const liveView = constructed[0]!

    expect(() => mgr.cancelWorkbenchAttachHold()).not.toThrow()

    expect(constructed.length).toBe(1)
    expect(liveView.webContents.destroyed).toBe(false)
    expect(liveView.webContents.close).not.toHaveBeenCalled()
  })
})
