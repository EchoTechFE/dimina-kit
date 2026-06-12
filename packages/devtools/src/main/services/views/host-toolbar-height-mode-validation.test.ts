/**
 * Feedback fix ⑦ — `hostToolbar.setHeightMode({ fixed })` must VALIDATE.
 *
 * Today's bug, verified against source (view-manager.ts `setHeightMode`):
 * `mode.fixed` is forwarded UNVALIDATED into
 * `ctx.notify.hostToolbarHeightChanged(mode.fixed)`. A host passing NaN /
 * Infinity / a negative number poisons the renderer placeholder (the strip's
 * single height authority) with a value CSS cannot honor — and because the
 * fixed mode also DROPS subsequent advertiser reports, the toolbar is stuck
 * in a corrupt state with no error anywhere.
 *
 * Locked contract (this file is the spec):
 *  - non-finite (`NaN`, `±Infinity`) or negative `fixed` values throw a
 *    `TypeError` synchronously;
 *  - a rejected value must NOT reach `notify.hostToolbarHeightChanged` AND
 *    must NOT change the standing height mode (the previous mode keeps
 *    working — fail-closed, not fail-corrupt);
 *  - `0` and positive integers stay legal; `'auto'` is unaffected.
 *
 * Electron mock + harness: trimmed copy of host-toolbar-port-channel.test.ts
 * (vitest mocks are per-file; main-process suites must vi.mock('electron')).
 *
 * RED today: no validation exists — the toThrow assertions fail and the
 * notify spy records the poisoned values.
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
    hostToolbarHeightChanged: vi.fn(),
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

describe('⑦ setHeightMode({ fixed }) rejects non-finite and negative heights', () => {
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['-1', -1],
    ['-0.5', -0.5],
  ])('throws TypeError for { fixed: %s } and does NOT notify the renderer', (_label, bad) => {
    // BUG CAUGHT: today the raw value rides hostToolbarHeightChanged into the
    // renderer placeholder — `height: NaNpx` / negative heights corrupt the
    // strip silently, and fixed mode then drops the advertiser reports that
    // could have self-healed it.
    const { mgr, notify } = makeManager()

    expect(() => mgr.hostToolbar.setHeightMode({ fixed: bad })).toThrow(TypeError)
    expect(notify.hostToolbarHeightChanged).not.toHaveBeenCalled()
  })

  it('a rejected value does not clobber the standing mode: advertiser reports still flow in auto', () => {
    // BUG CAUGHT: an implementation that assigns the mode BEFORE validating
    // would leave the control pinned to a poisoned fixed mode even though the
    // call threw — auto-mode advertiser reports would be dropped forever.
    const { mgr, notify } = makeManager()

    expect(() => mgr.hostToolbar.setHeightMode({ fixed: Number.NaN })).toThrow(TypeError)

    // Still in the default 'auto' mode: the advertiser report forwards.
    mgr.setHostToolbarHeight(48)
    expect(notify.hostToolbarHeightChanged).toHaveBeenCalledExactlyOnceWith(48)
  })

  it('a rejected value does not unpin a previously valid fixed mode', () => {
    const { mgr, notify } = makeManager()
    mgr.hostToolbar.setHeightMode({ fixed: 40 })
    notify.hostToolbarHeightChanged.mockClear()

    expect(() => mgr.hostToolbar.setHeightMode({ fixed: -1 })).toThrow(TypeError)

    // The valid pin survives: advertiser reports are still ignored.
    mgr.setHostToolbarHeight(99)
    expect(notify.hostToolbarHeightChanged).not.toHaveBeenCalled()
  })
})

describe('⑦ legal values keep working (regression pins)', () => {
  it('{ fixed: 0 } is legal: collapses the strip immediately', () => {
    const { mgr, notify } = makeManager()

    expect(() => mgr.hostToolbar.setHeightMode({ fixed: 0 })).not.toThrow()
    expect(notify.hostToolbarHeightChanged).toHaveBeenCalledExactlyOnceWith(0)
  })

  it('{ fixed: 40 } is legal: pins immediately and drops advertiser reports', () => {
    const { mgr, notify } = makeManager()

    expect(() => mgr.hostToolbar.setHeightMode({ fixed: 40 })).not.toThrow()
    expect(notify.hostToolbarHeightChanged).toHaveBeenCalledExactlyOnceWith(40)

    mgr.setHostToolbarHeight(64)
    expect(notify.hostToolbarHeightChanged).toHaveBeenCalledTimes(1)
  })

  it("'auto' is unaffected: no synthesized notify, advertiser reports drive the height", () => {
    const { mgr, notify } = makeManager()

    expect(() => mgr.hostToolbar.setHeightMode('auto')).not.toThrow()
    expect(notify.hostToolbarHeightChanged).not.toHaveBeenCalled()

    mgr.setHostToolbarHeight(32)
    expect(notify.hostToolbarHeightChanged).toHaveBeenCalledExactlyOnceWith(32)
  })
})
