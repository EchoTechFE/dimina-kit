/**
 * `hostSidebar.setWidthMode({ fixed })` validation — inline-axis counterpart
 * of host-toolbar-height-mode-validation.test.ts. Both slots share the same
 * `createHostSlotView` extent-mode guard (host-slot-view.ts `setExtentMode`),
 * so this file pins that the sidebar wrapper actually wires into it rather
 * than re-deriving the contract: non-finite / negative `fixed` values must
 * throw synchronously, must not reach `notify.hostSidebarWidthChanged`, and
 * must not clobber whatever mode was standing before the rejected call.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => {
  class WebContentsView {
    webContents = {
      destroyed: false,
      id: 1,
      isDestroyed() { return this.destroyed },
      close: vi.fn(),
      loadFile: vi.fn(() => Promise.resolve()),
      loadURL: vi.fn(() => Promise.resolve()),
      postMessage: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    }
    setBounds = vi.fn()
    setBackgroundColor = vi.fn()
  }
  class MessageChannelMain {
    port1 = { postMessage: vi.fn(), start: vi.fn(), close: vi.fn(), on: vi.fn(), once: vi.fn() }
    port2 = { postMessage: vi.fn(), start: vi.fn(), close: vi.fn(), on: vi.fn(), once: vi.fn() }
  }
  return {
    WebContentsView,
    MessageChannelMain,
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
  hostSidebarRuntimePreloadPath: '/stub/host-sidebar-runtime-preload.cjs',
  hostDialogRuntimePreloadPath: '/stub/host-dialog-runtime-preload.cjs',
  cjsSiblingPreloadPath: (p: string) => p,
  devtoolsPackageRoot: '/stub/devtools-pkg-root',
}))

// Import AFTER mocks so view-manager picks up the stubs.
import { createViewManager } from './view-manager.js'
import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'

function makeManager() {
  const contentView = { addChildView: vi.fn(), removeChildView: vi.fn(), children: [] }
  const mainWindow = {
    destroyed: false,
    contentView,
    isDestroyed() { return this.destroyed },
    getContentSize: () => [1280, 980],
  }
  const notify = {
    popoverInit: vi.fn(),
    popoverClosed: vi.fn(),
    hostSidebarWidthChanged: vi.fn(),
  }
  const ctx = {
    windows: {
      mainWindow: mainWindow as unknown as import('electron').BrowserWindow,
    } as import('../window-service.js').WindowService,
    rendererDir: '/stub/renderer',
    panels: ['console', 'wxml', 'storage', 'appdata'],
    notify: notify as unknown as import('../notifications/renderer-notifier.js').RendererNotifier,
    connections: createConnectionRegistry(),
  }
  const mgr = createViewManager(ctx)
  return { mgr, notify }
}

describe('hostSidebar.setWidthMode({ fixed }) rejects non-finite and negative widths', () => {
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['-1', -1],
    ['-0.5', -0.5],
  ])('throws TypeError for { fixed: %s } and does NOT notify the renderer', (_label, bad) => {
    const { mgr, notify } = makeManager()

    expect(() => mgr.hostSidebar.setWidthMode({ fixed: bad })).toThrow(TypeError)
    expect(notify.hostSidebarWidthChanged).not.toHaveBeenCalled()
  })

  it('a rejected value does not clobber the standing mode: advertiser reports still flow in auto', () => {
    const { mgr, notify } = makeManager()

    expect(() => mgr.hostSidebar.setWidthMode({ fixed: Number.NaN })).toThrow(TypeError)

    mgr.setHostSidebarWidth(240)
    expect(notify.hostSidebarWidthChanged).toHaveBeenCalledExactlyOnceWith(240)
  })

  it('a rejected value does not unpin a previously valid fixed mode', () => {
    const { mgr, notify } = makeManager()
    mgr.hostSidebar.setWidthMode({ fixed: 200 })
    notify.hostSidebarWidthChanged.mockClear()

    expect(() => mgr.hostSidebar.setWidthMode({ fixed: -1 })).toThrow(TypeError)

    mgr.setHostSidebarWidth(300)
    expect(notify.hostSidebarWidthChanged).not.toHaveBeenCalled()
  })
})

describe('hostSidebar.setWidthMode legal values keep working', () => {
  it('{ fixed: 0 } is legal: collapses the strip immediately', () => {
    const { mgr, notify } = makeManager()

    expect(() => mgr.hostSidebar.setWidthMode({ fixed: 0 })).not.toThrow()
    expect(notify.hostSidebarWidthChanged).toHaveBeenCalledExactlyOnceWith(0)
  })

  it('{ fixed: 200 } is legal: pins immediately and drops advertiser reports', () => {
    const { mgr, notify } = makeManager()

    expect(() => mgr.hostSidebar.setWidthMode({ fixed: 200 })).not.toThrow()
    expect(notify.hostSidebarWidthChanged).toHaveBeenCalledExactlyOnceWith(200)

    mgr.setHostSidebarWidth(320)
    expect(notify.hostSidebarWidthChanged).toHaveBeenCalledTimes(1)
  })

  it("'auto' is unaffected: no synthesized notify, advertiser reports drive the width", () => {
    const { mgr, notify } = makeManager()

    expect(() => mgr.hostSidebar.setWidthMode('auto')).not.toThrow()
    expect(notify.hostSidebarWidthChanged).not.toHaveBeenCalled()

    mgr.setHostSidebarWidth(180)
    expect(notify.hostSidebarWidthChanged).toHaveBeenCalledExactlyOnceWith(180)
  })
})
