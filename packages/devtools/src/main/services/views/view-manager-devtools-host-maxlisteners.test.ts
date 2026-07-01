/**
 * Simulator-DevTools host: max-listeners ceiling on the front-end host
 * WebContents that takes a boot-time burst of `executeJavaScript()` injects.
 *
 * Contract:
 *   `attachNativeSimulator(url, width)` builds the Chrome DevTools front-end
 *   host `WebContentsView` (inside `attachNativeSimulatorDevtoolsHost()`) and
 *   then, during that wc's boot window, injects into it repeatedly — tab
 *   customization, default-panel selection, the 150ms Elements-forward
 *   reconcile, Network-forward probing. Electron's `executeJavaScript()`
 *   registers a transient `did-stop-loading` listener on the target wc while
 *   it is still loading (`waitTillCanExecuteJavaScript` defers the eval until
 *   load finishes, then removes it). Enough concurrent injects before load
 *   completes pushes the pending `did-stop-loading` listener count past Node's
 *   default EventEmitter ceiling of 10.
 *
 * Real bug this guards against:
 *   Left at the default 10, the boot-time inject burst prints
 *   `MaxListenersExceededWarning: 11 did-stop-loading listeners added` — a
 *   spurious leak warning for listeners that drain the moment the wc stops
 *   loading. The fix raises the ceiling on this host wc via the sanctioned
 *   `webContents.setMaxListeners(n)` API so the benign spike stays quiet.
 *
 * Guards that `attachNativeSimulator` calls `setMaxListeners` on the DevTools
 * front-end host wc (constructed[1]) with a ceiling strictly above Node's
 * default of 10.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── electron stub ───────────────────────────────────────────────────────────
// Tracks every WebContentsView ever constructed (construction order:
// attachNativeSimulator builds [0] = the native simulator content view, then
// attachNativeSimulatorDevtoolsHost builds [1] = the DevTools front-end host
// view — this ordering is documented and relied upon by the sibling test
// view-manager-anchor-only-devtools-mount.test.ts).
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
  setMaxListeners: ReturnType<typeof vi.fn>
  getMaxListeners: ReturnType<typeof vi.fn>
}
type StubView = {
  webContents: StubWebContents
  setBounds: ReturnType<typeof vi.fn>
  setBackgroundColor: ReturnType<typeof vi.fn>
}

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
        setWindowOpenHandler: vi.fn(),
        setZoomFactor: vi.fn(),
        send: vi.fn(),
        setMaxListeners: vi.fn(),
        // Node's EventEmitter default.
        getMaxListeners: vi.fn(() => 10),
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
import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'

const SIM_URL = 'http://localhost:7788/simulator.html?appId=maxlisteners'

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

beforeEach(() => {
  constructed.length = 0
})

describe('DevTools front-end host wc: max-listeners ceiling raised above Node default', () => {
  it('attachNativeSimulator raises setMaxListeners on the reused DevTools host wc above 10', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.attachNativeSimulator(SIM_URL, 375)

    // [0] = native simulator content view, [1] = DevTools front-end host view.
    expect(constructed.length).toBe(2)
    const devtoolsHostView = constructed[1]!

    const calls = devtoolsHostView.webContents.setMaxListeners.mock.calls
    const raisedAboveDefault = calls.some(
      (args: unknown[]) => typeof args[0] === 'number' && args[0] > 10,
    )

    expect(
      raisedAboveDefault,
      'the DevTools front-end host wc takes a boot-time burst of executeJavaScript() injects (tab customization / console default / Elements+Network forwarding), each queuing a transient did-stop-loading waiter while the front-end is still loading; without raising setMaxListeners above the Node EventEmitter default of 10 on this host wc, the burst trips MaxListenersExceededWarning: 11 did-stop-loading listeners added',
    ).toBe(true)
  })
})
