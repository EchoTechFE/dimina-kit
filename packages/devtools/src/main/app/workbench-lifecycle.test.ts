/**
 * Verifies that the workbench lifecycle (setup → dispose → setup → dispose)
 * does not leak ipcMain handlers/listeners across re-creation.
 *
 * If `WorkbenchAppInstance.dispose()` correctly tears down every
 * `register*Ipc(ctx)`-installed handler, a second `createWorkbenchApp().setup()`
 * must not throw "Attempted to register a second handler …".
 *
 * The test runs entirely against stubbed electron primitives — no real Electron
 * runtime is started. The stubs intentionally mimic Electron's invariant that
 * `ipcMain.handle(channel, …)` throws if the channel already has a handler,
 * so a regression in the disposable wiring fails the test loudly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── Hoisted state for electron stubs (shared between mock and tests) ─────
const stubs = vi.hoisted(() => {
  type AnyFn = (...args: unknown[]) => unknown
  type EventBag = Record<string, Set<AnyFn>>

  /** Active ipcMain.handle channels — used to mimic Electron's "second handler" guard. */
  const activeHandles = new Set<string>()
  /** Every channel ever registered via ipcMain.handle (across setups). */
  const handleCalls: string[] = []
  /** Every channel ever removed via ipcMain.removeHandler. */
  const removeHandlerCalls: string[] = []
  /** Every channel ever registered via ipcMain.on. */
  const onCalls: string[] = []
  /** Every channel ever removed via ipcMain.removeListener. */
  const removeListenerCalls: string[] = []

  function makeEmitter() {
    const listeners: EventBag = {}
    return {
      listeners,
      on(event: string, fn: AnyFn) {
        ;(listeners[event] ??= new Set()).add(fn)
        return this
      },
      once(event: string, fn: AnyFn) {
        const wrap: AnyFn = (...args: unknown[]) => {
          listeners[event]?.delete(wrap)
          return fn(...args)
        }
        ;(listeners[event] ??= new Set()).add(wrap)
        return this
      },
      off(event: string, fn: AnyFn) {
        listeners[event]?.delete(fn)
        return this
      },
      removeListener(event: string, fn: AnyFn) {
        listeners[event]?.delete(fn)
        return this
      },
      emit(event: string, ...args: unknown[]) {
        for (const fn of [...(listeners[event] ?? [])]) fn(...args)
      },
    }
  }

  /** Reset cross-test counters between cases. */
  function reset() {
    activeHandles.clear()
    handleCalls.length = 0
    removeHandlerCalls.length = 0
    onCalls.length = 0
    removeListenerCalls.length = 0
  }

  return {
    activeHandles,
    handleCalls,
    removeHandlerCalls,
    onCalls,
    removeListenerCalls,
    makeEmitter,
    reset,
  }
})

// ── electron stub ────────────────────────────────────────────────────────
vi.mock('electron', () => {
  type AnyFn = (...args: unknown[]) => unknown

  // ipcMain ----------------------------------------------------------------
  const ipcEmitter = stubs.makeEmitter()
  const ipcMain = {
    ...ipcEmitter,
    handle: vi.fn((channel: string, _fn: AnyFn) => {
      // Mimic Electron: throwing on duplicate `handle` is the bug we guard against.
      if (stubs.activeHandles.has(channel)) {
        throw new Error(
          `Attempted to register a second handler for '${channel}'`,
        )
      }
      stubs.activeHandles.add(channel)
      stubs.handleCalls.push(channel)
    }),
    removeHandler: vi.fn((channel: string) => {
      stubs.activeHandles.delete(channel)
      stubs.removeHandlerCalls.push(channel)
    }),
    on: vi.fn((event: string, fn: AnyFn) => {
      stubs.onCalls.push(event)
      ipcEmitter.on(event, fn)
    }),
    removeListener: vi.fn((event: string, fn: AnyFn) => {
      stubs.removeListenerCalls.push(event)
      ipcEmitter.removeListener(event, fn)
    }),
  }

  // app --------------------------------------------------------------------
  const appEmitter = stubs.makeEmitter()
  const app = {
    ...appEmitter,
    isPackaged: true, // skip dev-only fs.watch and openDevTools
    whenReady: vi.fn(() => Promise.resolve()),
    getPath: vi.fn(() => '/tmp/dimina-test-userdata'),
    quit: vi.fn(),
    commandLine: {
      getSwitchValue: vi.fn(() => ''),
      appendSwitch: vi.fn(),
    },
  }

  // BrowserWindow ----------------------------------------------------------
  class WebContents {
    private em = stubs.makeEmitter()
    destroyed = false
    id = Math.floor(Math.random() * 1e6)
    on = this.em.on.bind(this.em)
    once = this.em.once.bind(this.em)
    off = this.em.off.bind(this.em)
    removeListener = this.em.removeListener.bind(this.em)
    emit = this.em.emit.bind(this.em)
    send = vi.fn()
    isDestroyed = () => this.destroyed
    openDevTools = vi.fn()
    closeDevTools = vi.fn()
    setDevToolsWebContents = vi.fn()
    setWindowOpenHandler = vi.fn()
    loadFile = vi.fn(() => Promise.resolve())
    loadURL = vi.fn(() => Promise.resolve())
    executeJavaScript = vi.fn(() => Promise.resolve(undefined))
    reload = vi.fn()
    getType = () => 'window'
    getURL = () => ''
    debugger = {
      attach: vi.fn(),
      detach: vi.fn(),
      isAttached: () => false,
      on: vi.fn(),
      removeListener: vi.fn(),
      sendCommand: vi.fn(() => Promise.resolve({ entries: [] })),
    }
    close = vi.fn(() => {
      this.destroyed = true
    })
  }

  class WebContentsView {
    webContents = new WebContents()
    setBounds = vi.fn()
    setBackgroundColor = vi.fn()
  }

  class View {
    children: View[] = []
    addChildView(child: View) {
      this.children.push(child)
    }
    removeChildView(child: View) {
      const i = this.children.indexOf(child)
      if (i >= 0) this.children.splice(i, 1)
    }
  }

  class BrowserWindow {
    private em = stubs.makeEmitter()
    destroyed = false
    webContents = new WebContents()
    // Initially the window's contentView is the WebContentsView root.
    // createMainWindow wraps it in a `View` container after construction.
    contentView: View | WebContentsView = new WebContentsView()
    on = this.em.on.bind(this.em)
    once = this.em.once.bind(this.em)
    off = this.em.off.bind(this.em)
    removeListener = this.em.removeListener.bind(this.em)
    emit = this.em.emit.bind(this.em)
    isDestroyed = () => this.destroyed
    getContentSize = () => [1280, 980]
    setIcon = vi.fn()
    setTitle = vi.fn()
    show = vi.fn()
    showInactive = vi.fn()
    focus = vi.fn()
    close = vi.fn()
    destroy = vi.fn(() => {
      this.destroyed = true
    })
    loadFile = vi.fn(() => Promise.resolve())
    loadURL = vi.fn(() => Promise.resolve())
    static getAllWindows = vi.fn(() => [] as BrowserWindow[])
  }

  // session, dialog, menu, shell, nativeImage -----------------------------
  const sessionStub = {
    fromPartition: vi.fn(() => ({
      webRequest: {
        onBeforeSendHeaders: vi.fn(),
        onHeadersReceived: vi.fn(),
      },
      registerPreloadScript: vi.fn(),
    })),
  }

  const dialog = {
    showOpenDialog: vi.fn(() => Promise.resolve({ canceled: true, filePaths: [] })),
    showMessageBox: vi.fn(() => Promise.resolve({ response: 0 })),
  }

  const Menu = {
    buildFromTemplate: vi.fn((tpl: unknown) => ({ template: tpl })),
    setApplicationMenu: vi.fn(),
  }

  const shell = {
    openExternal: vi.fn(() => Promise.resolve()),
    openPath: vi.fn(() => Promise.resolve('')),
  }

  const nativeImage = {
    createFromPath: vi.fn(() => ({ isEmpty: () => true })),
  }

  const nativeTheme = {
    themeSource: 'system',
  }

  const globalShortcut = {
    register: vi.fn(() => false),
    unregister: vi.fn(),
    unregisterAll: vi.fn(),
  }

  const webContentsStatic = {
    fromId: vi.fn(() => null),
    getAllWebContents: vi.fn(() => [] as WebContents[]),
  }

  const Tray = vi.fn()

  return {
    app,
    ipcMain,
    BrowserWindow,
    WebContentsView,
    BrowserView: WebContentsView,
    View,
    webContents: webContentsStatic,
    session: sessionStub,
    dialog,
    Menu,
    shell,
    nativeImage,
    nativeTheme,
    globalShortcut,
    Tray,
    default: {},
  }
})

// fs.watch is called in dev to live-reload renderer windows. We force
// `app.isPackaged === true` above to skip it, but mock it as a safety net.
vi.mock('fs', async () => {
  const real = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...real,
    default: { ...real, watch: vi.fn() },
    watch: vi.fn(),
    realpathSync: vi.fn((p: string) => p),
  }
})

// Avoid pulling in the real @dimina-kit/devkit during default-adapter import.
vi.mock('@dimina-kit/devkit', () => ({
  openProject: vi.fn(() => Promise.resolve({
    port: 0,
    appInfo: {},
    close: () => Promise.resolve(),
  })),
}))

// ── Tests ────────────────────────────────────────────────────────────────
//
// Import lazily so the electron mock above is in place before the module
// graph (which captures `app`, `ipcMain` references at import time) is
// loaded.
let createWorkbenchApp: typeof import('./app.js').createWorkbenchApp
type WorkbenchAppInstance = import('./app.js').WorkbenchAppInstance

beforeEach(async () => {
  vi.resetModules()
  stubs.reset()
  ;({ createWorkbenchApp } = await import('./app.js'))
})

describe('Workbench lifecycle: setup → dispose × 2', () => {
  it('first setup() returns an instance with mainWindow + context + dispose', async () => {
    const app = createWorkbenchApp({})
    const instance = await app.setup()
    expect(instance).toBeDefined()
    expect(instance.mainWindow).toBeDefined()
    expect(instance.context).toBeDefined()
    expect(typeof instance.dispose).toBe('function')
    expect(stubs.handleCalls.length).toBeGreaterThan(0)
    await instance.dispose()
  })

  it('dispose() calls removeHandler for every channel registered via ipcMain.handle, and removeListener for every ipcMain.on listener', async () => {
    const instance = await createWorkbenchApp({}).setup()

    const firstHandles = new Set(stubs.handleCalls)
    const firstOns = new Set(stubs.onCalls)
    expect(firstHandles.size).toBeGreaterThan(0)

    await instance.dispose()

    const removedHandles = new Set(stubs.removeHandlerCalls)
    const removedListeners = new Set(stubs.removeListenerCalls)

    for (const ch of firstHandles) {
      expect(
        removedHandles.has(ch),
        `expected ipcMain.removeHandler('${ch}') to be called during dispose`,
      ).toBe(true)
    }
    for (const ch of firstOns) {
      expect(
        removedListeners.has(ch),
        `expected ipcMain.removeListener('${ch}') to be called during dispose`,
      ).toBe(true)
    }

    // After dispose, no channel should remain hot.
    expect(stubs.activeHandles.size).toBe(0)
  })

  it('second setup() after dispose does NOT throw "Attempted to register a second handler"', async () => {
    const first = await createWorkbenchApp({}).setup()
    await first.dispose()

    // Re-create. If any handler from the first setup was leaked, the stubbed
    // ipcMain.handle (which mimics Electron) will throw here.
    let second: WorkbenchAppInstance | undefined
    let err: unknown
    try {
      second = await createWorkbenchApp({}).setup()
    } catch (e) {
      err = e
    }
    expect(err, err instanceof Error ? err.stack : String(err)).toBeUndefined()
    expect(second).toBeDefined()
    await second!.dispose()
  })

  it('second dispose symmetrically releases every handler/listener registered by the second setup', async () => {
    const first = await createWorkbenchApp({}).setup()
    await first.dispose()

    // Snapshot counts after first dispose so we only inspect deltas from setup #2.
    const handleBeforeSecond = stubs.handleCalls.length
    const onBeforeSecond = stubs.onCalls.length
    const removeHandlerBeforeSecond = stubs.removeHandlerCalls.length
    const removeListenerBeforeSecond = stubs.removeListenerCalls.length

    const second = await createWorkbenchApp({}).setup()

    const secondHandles = new Set(stubs.handleCalls.slice(handleBeforeSecond))
    const secondOns = new Set(stubs.onCalls.slice(onBeforeSecond))
    expect(secondHandles.size).toBeGreaterThan(0)

    await second.dispose()

    const secondRemovedHandles = new Set(
      stubs.removeHandlerCalls.slice(removeHandlerBeforeSecond),
    )
    const secondRemovedListeners = new Set(
      stubs.removeListenerCalls.slice(removeListenerBeforeSecond),
    )

    for (const ch of secondHandles) {
      expect(
        secondRemovedHandles.has(ch),
        `(second cycle) expected removeHandler('${ch}')`,
      ).toBe(true)
    }
    for (const ch of secondOns) {
      expect(
        secondRemovedListeners.has(ch),
        `(second cycle) expected removeListener('${ch}')`,
      ).toBe(true)
    }
    expect(stubs.activeHandles.size).toBe(0)
  })

  it('dispose is idempotent — calling it twice does not throw', async () => {
    const instance = await createWorkbenchApp({}).setup()
    await expect(instance.dispose()).resolves.not.toThrow()
    await expect(instance.dispose()).resolves.not.toThrow()
  })
})

