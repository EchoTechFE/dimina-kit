/**
 * Simulator soft reload: after a recompile, main re-loads the SAME native
 * simulator `WebContentsView` in place (`simWc.send('simulator:relaunch', …)`)
 * instead of tearing it down and rebuilding it — the guest's own preload
 * handles the relaunch and briefly runs the old and new app sessions
 * side-by-side. `softReloadNativeSimulator` is the single gate for that send:
 * it must refuse to fire before there is a live, fully-attached simulator
 * SHELL to receive it — a shell counts as attached only once its own
 * DeviceShell chrome has painted, i.e. its first render-host guest reports
 * `did-finish-load` (the same readiness signal `attachNativeSimulator`'s
 * returned promise already waits on). Sending into a shell that never
 * finished its own boot would either be silently dropped by a preload that
 * hasn't registered its relaunch listener yet, or hit a shell whose DOM isn't
 * there to receive it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── electron stub (emitter-capable, mirrors view-manager.test.ts) ──────────
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
  devtoolsPackageRoot: '/stub/devtools-pkg-root',
}))

// Import AFTER mocks so view-manager picks up the stubs.
import { createViewManager } from './view-manager.js'
import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'

const SIM_URL = 'http://localhost:7788/simulator.html?appId=softreload'

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

/** A minimal render-host guest wc, shaped like `did-attach-webview`'s callback arg. */
function makeGuestWc(): { wc: unknown; fireDidFinishLoad: () => void } {
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const wc = {
    isDestroyed: () => false,
    once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler)
    }),
    on: vi.fn(),
    setZoomFactor: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  }
  return { wc, fireDidFinishLoad: () => handlers.get('did-finish-load')?.() }
}

/** Drives the shell-ready signal: attach a render-host guest and finish its load. */
function markShellReady(simWc: StubWebContents): void {
  const { wc, fireDidFinishLoad } = makeGuestWc()
  simWc.emit('did-attach-webview', {}, wc)
  fireDidFinishLoad()
}

/** The native simulator content view is constructed first on every attach
 *  (index [0] of that attach's pair; the DevTools overlay host is [1]). */
function simWcOf(attachIndex: number): StubWebContents {
  return constructed[attachIndex * 2]!.webContents
}

beforeEach(() => {
  constructed.length = 0
})

describe('softReloadNativeSimulator', () => {
  it('returns false and sends nothing when no native simulator has ever been attached', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    expect(mgr.softReloadNativeSimulator(SIM_URL)).toBe(false)
  })

  it('returns false and sends nothing while the freshly attached shell has not finished loading its first render guest', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.attachNativeSimulator(SIM_URL, 375)
    const simWc = simWcOf(0)

    expect(mgr.softReloadNativeSimulator(SIM_URL)).toBe(false)
    expect(simWc.send).not.toHaveBeenCalledWith('simulator:relaunch', expect.anything())
  })

  it('sends simulator:relaunch to the simulator webContents and returns true once the shell\'s first render guest has finished loading', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.attachNativeSimulator(SIM_URL, 375)
    const simWc = simWcOf(0)
    markShellReady(simWc)

    expect(mgr.softReloadNativeSimulator(SIM_URL)).toBe(true)
    expect(simWc.send).toHaveBeenCalledWith('simulator:relaunch', { url: SIM_URL })
  })

  it('returns false again once the native simulator view is torn down, even though its shell was previously ready', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.attachNativeSimulator(SIM_URL, 375)
    const simWc = simWcOf(0)
    markShellReady(simWc)
    expect(mgr.softReloadNativeSimulator(SIM_URL)).toBe(true)

    mgr.detachSimulator()

    expect(mgr.softReloadNativeSimulator(SIM_URL)).toBe(false)
  })

  it('returns false for a rebuilt shell (relaunch/re-attach) until ITS OWN first render guest finishes loading — readiness does not carry over from the prior generation', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.attachNativeSimulator(SIM_URL, 375)
    markShellReady(simWcOf(0))
    expect(mgr.softReloadNativeSimulator(SIM_URL)).toBe(true)

    // Re-attach: tearDownNativeSimulatorView destroys the first view and
    // attachNativeSimulator builds a brand-new one (relaunch / re-open path).
    mgr.attachNativeSimulator(SIM_URL, 375)
    const rebuiltSimWc = simWcOf(1)

    expect(mgr.softReloadNativeSimulator(SIM_URL)).toBe(false)
    expect(rebuiltSimWc.send).not.toHaveBeenCalledWith('simulator:relaunch', expect.anything())

    markShellReady(rebuiltSimWc)
    expect(mgr.softReloadNativeSimulator(SIM_URL)).toBe(true)
  })
})
