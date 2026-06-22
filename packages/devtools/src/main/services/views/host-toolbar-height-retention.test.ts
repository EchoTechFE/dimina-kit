/**
 * Host-toolbar height RETENTION — main keeps the last notified height.
 *
 * THE BUG (downstream feedback, verified against source): the dynamic-height
 * chain is event-driven end to end with NO replay anywhere —
 *  - the toolbar WCV's advertiser deduplicates (view-anchor measure-loop: a
 *    height already reported is never re-sent),
 *  - `setHostToolbarHeight` (view-manager.ts) explicitly does "the height is
 *    not retained in main" and fire-and-forgets the notify,
 *  - the main-window renderer subscribes only after the project view mounts
 *    (`useState(0)` + `useEffect` in project-runtime.tsx).
 * So any notify that fires before the project view is mounted is PERMANENTLY
 * lost: cold-starting on the project list is a race, and close-project →
 * reopen reproduces it 100% (the placeholder component is rebuilt at 0 and
 * the deduped advertiser never re-reports).
 *
 * Locked contract (this file is the spec for the MAIN half of the fix):
 * the ViewManager retains the last height it notified and exposes it via a
 * NEW getter `getHostToolbarHeight(): number` so the renderer can pull/replay
 * it on mount (the invoke channel is pinned in
 * src/main/ipc/views-host-toolbar-get-height.test.ts):
 *  - initial value is 0;
 *  - auto mode: `setHostToolbarHeight(48)` → getter 48 (works with NO toolbar
 *    view constructed — advertise-precede-attach, same semantics as the pin
 *    in host-toolbar.test.ts);
 *  - fixed mode: `setHeightMode({ fixed: 40 })` → getter 40; a subsequent
 *    advertiser report is dropped (existing pin) AND must NOT pollute the
 *    retained value;
 *  - fixed → 'auto': getter keeps the pinned 40 and NO notify is synthesized
 *    (coexists with the pin in host-toolbar-height-mode-validation.test.ts);
 *    the NEXT advertiser report notifies and updates the getter;
 *  - `hostToolbar.hide()` notifies 0 (existing) AND the getter follows to 0;
 *  - a setHeightMode validation reject must not clobber the retained value.
 *
 * The getter is reached structurally (not via the typed interface) so this
 * file COMPILES before the implementation lands and fails as RED assertions
 * instead of a build break (same convention as
 * use-session-compile-events.test.tsx).
 *
 * Electron mock + harness: trimmed copy of
 * host-toolbar-height-mode-validation.test.ts (vitest mocks are per-file;
 * main-process suites must vi.mock('electron')).
 *
 * Guards that `getHostToolbarHeight` exists on the ViewManager.
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
import { createViewManager, type ViewManager } from './view-manager.js'
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

/**
 * Structural lookup of the FUTURE `getHostToolbarHeight` getter (see header).
 * The typed `ViewManager` interface does not declare it yet; the runtime
 * assertion is what goes red.
 */
function readRetainedHeight(mgr: ViewManager): number {
  const getter = (mgr as unknown as { getHostToolbarHeight?: unknown }).getHostToolbarHeight
  expect(
    typeof getter,
    'ViewManager must expose getHostToolbarHeight(): number — the retained last-notified toolbar height the renderer replays on mount',
  ).toBe('function')
  return (getter as () => number)()
}

describe('height retention: auto mode (advertiser-driven)', () => {
  it('starts at 0 before any advertise / pin', () => {
    const { mgr } = makeManager()
    expect(readRetainedHeight(mgr)).toBe(0)
  })

  it('setHostToolbarHeight(48) retains 48 (and still notifies exactly once)', () => {
    // BUG CAUGHT: today the height "is not retained in main" by design — a
    // renderer that mounts after this notify can never learn the 48 again
    // (the advertiser deduplicates and will not re-report).
    const { mgr, notify } = makeManager()

    mgr.setHostToolbarHeight(48)

    expect(notify.hostToolbarHeightChanged).toHaveBeenCalledExactlyOnceWith(48)
    expect(readRetainedHeight(mgr)).toBe(48)
  })

  it('retains under advertise-precede-attach: no toolbar view needs to exist', () => {
    // Same semantics as the host-toolbar.test.ts pin "advertise can precede
    // attach": the retention must not be coupled to view creation either.
    const { mgr } = makeManager()

    // No setHostToolbarBounds / loadURL / loadFile happened — no view exists.
    mgr.setHostToolbarHeight(72)

    expect(readRetainedHeight(mgr)).toBe(72)
  })

  it('a later report replaces the retained value', () => {
    const { mgr } = makeManager()

    mgr.setHostToolbarHeight(48)
    mgr.setHostToolbarHeight(64)

    expect(readRetainedHeight(mgr)).toBe(64)
  })
})

describe('height retention: fixed mode interactions', () => {
  it('setHeightMode({ fixed: 40 }) retains 40', () => {
    const { mgr, notify } = makeManager()

    mgr.hostToolbar.setHeightMode({ fixed: 40 })

    expect(notify.hostToolbarHeightChanged).toHaveBeenCalledExactlyOnceWith(40)
    expect(readRetainedHeight(mgr)).toBe(40)
  })

  it('an advertiser report DROPPED by fixed mode must not pollute the retained value', () => {
    // BUG CAUGHT (future regression): an implementation that records the
    // height at the TOP of setHostToolbarHeight — before the fixed-mode drop
    // gate — would replay 99 to the next mounting renderer while the strip is
    // actually pinned at 40: retention must record what was NOTIFIED, not
    // what was reported.
    const { mgr, notify } = makeManager()
    mgr.hostToolbar.setHeightMode({ fixed: 40 })
    notify.hostToolbarHeightChanged.mockClear()

    mgr.setHostToolbarHeight(99)

    // Existing drop pin (host-toolbar-height-mode-validation.test.ts) + the
    // retention corollary.
    expect(notify.hostToolbarHeightChanged).not.toHaveBeenCalled()
    expect(readRetainedHeight(mgr)).toBe(40)
  })

  it("fixed → 'auto' keeps the retained 40 and synthesizes NO notify; the next report drives both again", () => {
    // Coexists with the existing pin "'auto' is unaffected: no synthesized
    // notify" — switching back must not flash a replayed stale height, but
    // the RETAINED value must survive the switch (a freshly-mounting renderer
    // still needs the 40 until the next report).
    const { mgr, notify } = makeManager()
    mgr.hostToolbar.setHeightMode({ fixed: 40 })
    notify.hostToolbarHeightChanged.mockClear()

    mgr.hostToolbar.setHeightMode('auto')

    expect(notify.hostToolbarHeightChanged).not.toHaveBeenCalled()
    expect(readRetainedHeight(mgr)).toBe(40)

    mgr.setHostToolbarHeight(32)

    expect(notify.hostToolbarHeightChanged).toHaveBeenCalledExactlyOnceWith(32)
    expect(readRetainedHeight(mgr)).toBe(32)
  })

  it('a setHeightMode validation reject does not clobber the retained value', () => {
    // Companion to the fail-closed pins in
    // host-toolbar-height-mode-validation.test.ts: the throw path must leave
    // the retained value untouched too.
    const { mgr } = makeManager()
    mgr.setHostToolbarHeight(48)

    expect(() => mgr.hostToolbar.setHeightMode({ fixed: -1 })).toThrow(TypeError)

    expect(readRetainedHeight(mgr)).toBe(48)
  })
})

describe('height retention: hide()', () => {
  it('hostToolbar.hide() notifies 0 (existing) and the retained value follows to 0', () => {
    // hide() collapses the renderer placeholder via notify(0); a renderer
    // mounting AFTER the hide must replay 0, not the stale pre-hide height.
    const { mgr, notify } = makeManager()
    mgr.setHostToolbarHeight(48)
    notify.hostToolbarHeightChanged.mockClear()

    mgr.hostToolbar.hide()

    expect(notify.hostToolbarHeightChanged).toHaveBeenCalledExactlyOnceWith(0)
    expect(readRetainedHeight(mgr)).toBe(0)
  })
})
