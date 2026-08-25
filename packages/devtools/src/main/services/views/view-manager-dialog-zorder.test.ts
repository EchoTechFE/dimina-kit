/**
 * Dialog overlay z-order invariant: `showUpdateDialog`/`showProjectCreateDialog`
 * (VIEW_LAYER.dialog = 40) replaced the Radix `fixed inset-0` DOM portal
 * precisely because a native WebContentsView mounted on top of the main
 * window's own renderer tree — host-toolbar / host-sidebar, VIEW_LAYER 5 each
 * — paints above any DOM z-index (see view-ids.ts's VIEW_LAYER doc-comment).
 *
 * These tests pin the reconciler's ACTUAL `addChildView` order (last call =
 * topmost view): a dialog shown while both host slots are already open must
 * attach above them, and must STAY above them when the host slots republish
 * bounds afterwards — the same re-attach hazard view-manager-overlay-zorder.test.ts
 * pins for settings/popover against the base tier.
 *
 * Mock setup mirrors host-toolbar.test.ts (same electron/paths.js stubs);
 * `markOverlayReady` is required because both dialog panels use
 * `readyMode: 'manual'` — `show()` alone leaves them desired-hidden.
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
    constructor() {
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
        send: vi.fn(),
      }
      constructed.push(this as unknown as StubView)
    }
  }
  return {
    WebContentsView,
    webContents: { fromId: vi.fn(() => null) },
    ipcMain: { on: vi.fn(), removeListener: vi.fn() },
    shell: { openExternal: vi.fn() },
    session: {
      defaultSession: {
        registerPreloadScript: vi.fn(() => 'stub-preload-script-id'),
        unregisterPreloadScript: vi.fn(),
      },
    },
  }
})

vi.mock('../../utils/paths.js', () => ({
  mainPreloadPath: '/stub/preload.js',
  hostToolbarRuntimePreloadPath: '/stub/host-toolbar-runtime-preload.cjs',
  // view-manager wires the sidebar/dialog slots unconditionally — their
  // session-runtime modules read these at import time.
  hostSidebarRuntimePreloadPath: '/stub/host-sidebar-runtime-preload.cjs',
  hostDialogRuntimePreloadPath: '/stub/host-dialog-runtime-preload.cjs',
  cjsSiblingPreloadPath: (p: string) => p,
  devtoolsPackageRoot: '/stub/devtools-pkg-root',
}))

// Import AFTER mocks so view-manager picks up the stubs.
import { createViewManager } from './view-manager.js'
import { hostToolbarBounds, hostSidebarBounds } from './placement-test-driver.js'
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
    hostToolbarHeightChanged: vi.fn(),
    tooltipInit: vi.fn(),
    projectCreateInit: vi.fn(),
    updateAvailable: vi.fn(),
  }
  return {
    addChildView,
    ctx: {
      windows: {
        mainWindow: mainWindow as unknown as import('electron').BrowserWindow,
      } as import('../window-service.js').WindowService,
      rendererDir: '/stub/renderer',
      panels: ['console', 'wxml', 'storage', 'appdata'],
      notify: notify as unknown as import('../notifications/renderer-notifier.js').RendererNotifier,
      connections: createConnectionRegistry(),
    },
  }
}

const TOOLBAR_RECT = { x: 0, y: 0, width: 1280, height: 48 }
const SIDEBAR_RECT = { x: 0, y: 48, width: 240, height: 900 }

// Last addChildView call's first arg = the topmost view.
function lastAdded(addChildView: ReturnType<typeof vi.fn>): StubView {
  const calls = addChildView.mock.calls
  return calls[calls.length - 1]![0] as StubView
}

function viewFor(webContentsId: number): StubView {
  const view = constructed.find((v) => v.webContents.id === webContentsId)
  if (!view) throw new Error(`no constructed view for webContents id ${webContentsId}`)
  return view
}

beforeEach(() => {
  constructed.length = 0
})

describe('ViewManager dialog overlay z-order: dialogs stay above host-toolbar/host-sidebar', () => {
  it('update dialog attaches above already-open host-toolbar and host-sidebar, and stays above them when the slots republish bounds', () => {
    const { addChildView, ctx } = makeContext()
    const mgr = createViewManager(ctx)

    // Both host slots present first (VIEW_LAYER.hostToolbar/hostSidebar = 5).
    hostToolbarBounds(mgr, TOOLBAR_RECT)
    hostSidebarBounds(mgr, SIDEBAR_RECT)
    expect(lastAdded(addChildView)).not.toBe(undefined)

    // Dialog shown on top (VIEW_LAYER.dialog = 40) — readyMode 'manual' means
    // show() alone stays desired-hidden until markOverlayReady flushes it.
    mgr.showUpdateDialog({ version: '2.0.0', downloadUrl: 'https://example.com/2.0.0.dmg' })
    const webContentsId = mgr.getUpdateDialogWebContentsId()
    expect(webContentsId).not.toBeNull()
    mgr.markOverlayReady(webContentsId!)
    const dialogView = viewFor(webContentsId!)

    expect(lastAdded(addChildView)).toBe(dialogView)

    // Re-publish BOTH host slots' bounds while the dialog stays open — a
    // base-tier re-attach (e.g. on host resize) must not move it above the
    // open dialog.
    hostToolbarBounds(mgr, { ...TOOLBAR_RECT, height: 52 })
    hostSidebarBounds(mgr, { ...SIDEBAR_RECT, width: 260 })

    expect(lastAdded(addChildView)).toBe(dialogView)
  })

  it('project-create dialog attaches above already-open host-toolbar and host-sidebar, and stays above them when the slots republish bounds', () => {
    const { addChildView, ctx } = makeContext()
    const mgr = createViewManager(ctx)

    hostToolbarBounds(mgr, TOOLBAR_RECT)
    hostSidebarBounds(mgr, SIDEBAR_RECT)

    mgr.showProjectCreateDialog({ templates: [], defaultBaseDir: '/tmp/projects' })
    const webContentsId = mgr.getProjectCreateDialogWebContentsId()
    expect(webContentsId).not.toBeNull()
    mgr.markOverlayReady(webContentsId!)
    const dialogView = viewFor(webContentsId!)

    expect(lastAdded(addChildView)).toBe(dialogView)

    hostToolbarBounds(mgr, { ...TOOLBAR_RECT, height: 52 })
    hostSidebarBounds(mgr, { ...SIDEBAR_RECT, width: 260 })

    expect(lastAdded(addChildView)).toBe(dialogView)
  })
})
