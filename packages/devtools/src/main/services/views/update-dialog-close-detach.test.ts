/**
 * Regression: `ViewManager.hideUpdateDialog()` is the main-side half of the
 * update dialog's close path (see `update-manager.ts`'s `UpdateChannel.Close`
 * handler). Before this fix, nothing ever called it on close — the renderer
 * only unmounted its own DOM, so main kept the update-dialog WebContentsView
 * presented (added to `contentView`) forever, an invisible click-eating
 * overlay sitting above every other view at the `dialog` layer.
 *
 * This pins the ViewManager-level half of that chain: once the panel is
 * actually placed (shown + marked ready, which is what makes the reconciler
 * add it to `contentView`), `hideUpdateDialog()` must detach it —
 * `removeChildView` called with the same WebContentsView instance —
 * without destroying the webContents (a later `show()` reuses it).
 *
 * Harness mirrors view-manager-dispose-scopes.test.ts (electron mock
 * tracking constructed WebContentsViews via `h.constructed`).
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
  hostSidebarRuntimePreloadPath: '/stub/host-sidebar-runtime-preload.cjs',
  hostDialogRuntimePreloadPath: '/stub/host-dialog-runtime-preload.cjs',
  cjsSiblingPreloadPath: (p: string) => p.replace(/\.js$/, '.cjs'),
  devtoolsPackageRoot: '/stub/devtools-pkg-root',
}))

import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'

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
    updateAvailable: vi.fn(),
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

beforeEach(() => {
  vi.resetModules()
  h.constructed.length = 0
  h.registerPreloadScript.mockClear()
  h.unregisterPreloadScript.mockClear()
  h.mockFromId.mockReset()
})

describe('ViewManager.hideUpdateDialog: detaches a placed panel without destroying it', () => {
  it('removeChildView is called with the placed view once shown+ready, not before', async () => {
    const createViewManager = await loadCreateViewManager()
    const { addChildView, removeChildView, ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.showUpdateDialog({ version: '1.2.0', downloadUrl: 'https://example.com/update.zip' })
    const view = h.constructed[h.constructed.length - 1]!
    const webContentsId = mgr.getUpdateDialogWebContentsId()
    expect(webContentsId).toBe(view.webContents.id)

    // `readyMode: 'manual'` gates placement on markReady — before that fires,
    // hide()/setDesired never ran addChildView yet.
    expect(removeChildView).not.toHaveBeenCalled()

    mgr.markOverlayReady(webContentsId!)
    expect(addChildView).toHaveBeenCalledWith(view)

    mgr.hideUpdateDialog()

    expect(removeChildView).toHaveBeenCalledWith(view)
    // Hidden, not destroyed — a later show() must reuse this same instance.
    expect(view.webContents.close).not.toHaveBeenCalled()
    expect(view.webContents.destroyed).toBe(false)
    expect(mgr.getUpdateDialogWebContentsId()).toBe(view.webContents.id)
  })
})
