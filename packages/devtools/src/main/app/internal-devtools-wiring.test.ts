/**
 * Phase 0 of the standalone floating CDP debug panel: the simulator
 * toolbar's "debug" button must open the main window's Chrome DevTools in
 * detached mode. `registerInternalDevtoolsIpc` (src/main/ipc/internal-devtools.ts)
 * registers the 'internal-devtools:open' handler; this suite drives a REAL
 * `createDevtoolsRuntime` boot (same exhaustive electron stub as
 * open-settings-wiring.test.ts / menu-builder-runtime-context.test.ts) and
 * proves the value-level wiring — unlike the BUILTIN_MODULES surface, this
 * handler is registered unconditionally during app assembly, so a booted
 * instance must always carry it.
 *
 * Electron mock: copied from open-settings-wiring.test.ts (vitest mocks are
 * per-file by convention in this package; main-process suites must
 * vi.mock('electron') because CI has no Electron binary).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stubs = vi.hoisted(() => {
  type AnyFn = (...args: unknown[]) => unknown
  type EventBag = Record<string, Set<AnyFn>>

  const ipcHandlers = new Map<string, AnyFn>()
  /** Every BrowserWindow the code under test constructed, in order. */
  const browserWindows: unknown[] = []

  function makeEmitter() {
    const listeners: EventBag = {}
    return {
      listeners,
      on(event: string, fn: AnyFn) { (listeners[event] ??= new Set()).add(fn); return this },
      once(event: string, fn: AnyFn) {
        const wrap: AnyFn = (...a: unknown[]) => { listeners[event]?.delete(wrap); return fn(...a) }
        ;(listeners[event] ??= new Set()).add(wrap); return this
      },
      off(event: string, fn: AnyFn) { listeners[event]?.delete(fn); return this },
      removeListener(event: string, fn: AnyFn) { listeners[event]?.delete(fn); return this },
      emit(event: string, ...a: unknown[]) { for (const fn of [...(listeners[event] ?? [])]) fn(...a) },
    }
  }

  function reset() {
    ipcHandlers.clear()
    browserWindows.length = 0
  }

  return { ipcHandlers, browserWindows, makeEmitter, reset }
})

vi.mock('electron', () => {
  type AnyFn = (...args: unknown[]) => unknown

  const ipcEmitter = stubs.makeEmitter()
  const ipcMain = {
    ...ipcEmitter,
    handle: vi.fn((channel: string, fn: AnyFn) => { stubs.ipcHandlers.set(channel, fn) }),
    removeHandler: vi.fn((channel: string) => { stubs.ipcHandlers.delete(channel) }),
    on: vi.fn((event: string, fn: AnyFn) => { ipcEmitter.on(event, fn) }),
    removeListener: vi.fn((event: string, fn: AnyFn) => { ipcEmitter.removeListener(event, fn) }),
  }

  const appEmitter = stubs.makeEmitter()
  const app = {
    ...appEmitter,
    isPackaged: true,
    whenReady: vi.fn(() => Promise.resolve()),
    getPath: vi.fn(() => '/tmp/dimina-test-userdata'),
    getVersion: vi.fn(() => '1.0.0'),
    quit: vi.fn(),
    commandLine: { getSwitchValue: vi.fn(() => ''), appendSwitch: vi.fn() },
  }

  let nextWcId = 1

  class WebContents {
    private em = stubs.makeEmitter()
    destroyed = false
    id = nextWcId++
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
    isDevToolsOpened = vi.fn(() => false)
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
    close = vi.fn(() => { this.destroyed = true })
  }

  class WebContentsView {
    webContents = new WebContents()
    setBounds = vi.fn()
    setBackgroundColor = vi.fn()
  }

  class View {
    children: View[] = []
    addChildView(c: View) { this.children.push(c) }
    removeChildView(c: View) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1) }
  }

  class BrowserWindow {
    private em = stubs.makeEmitter()
    destroyed = false
    webContents = new WebContents()
    contentView: View | WebContentsView = new WebContentsView()
    constructor() { stubs.browserWindows.push(this) }
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
    close = vi.fn(() => { this.destroyed = true; this.em.emit('closed') })
    destroy = vi.fn(() => { this.destroyed = true })
    loadFile = vi.fn(() => Promise.resolve())
    loadURL = vi.fn(() => Promise.resolve())
    static getAllWindows = vi.fn(() => [] as BrowserWindow[])
  }

  const sessionStub = {
    fromPartition: vi.fn(() => ({
      webRequest: { onBeforeSendHeaders: vi.fn(), onHeadersReceived: vi.fn() },
      registerPreloadScript: vi.fn(),
      protocol: { handle: vi.fn(), unhandle: vi.fn() },
    })),
    defaultSession: {
      protocol: { handle: vi.fn(), unhandle: vi.fn() },
      registerPreloadScript: vi.fn(() => 'stub-preload-script-id'),
      unregisterPreloadScript: vi.fn(),
    },
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
  const nativeImage = { createFromPath: vi.fn(() => ({ isEmpty: () => true })) }
  const nativeTheme = { ...stubs.makeEmitter(), themeSource: 'system' }
  const globalShortcut = { register: vi.fn(() => false), unregister: vi.fn(), unregisterAll: vi.fn() }
  const webContentsStatic = { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) }
  const Tray = vi.fn()

  return {
    app, ipcMain, BrowserWindow, WebContentsView, BrowserView: WebContentsView, View,
    webContents: webContentsStatic, session: sessionStub,
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn(), unhandle: vi.fn() },
    dialog, Menu, shell,
    nativeImage, nativeTheme, globalShortcut, Tray, default: {},
  }
})

vi.mock('fs', async () => {
  const real = await vi.importActual<typeof import('fs')>('fs')
  return { ...real, default: { ...real, watch: vi.fn() }, watch: vi.fn(), realpathSync: vi.fn((p: string) => p) }
})

vi.mock('@dimina-kit/devkit', () => ({
  openProject: vi.fn(() => Promise.resolve({ port: 0, appInfo: {}, close: () => Promise.resolve() })),
}))

let createDevtoolsRuntime: typeof import('./app.js').createDevtoolsRuntime

beforeEach(async () => {
  vi.resetModules()
  stubs.reset()
  ;({ createDevtoolsRuntime } = await import('./app.js'))
})

/** Stub-window webContents view used by the assertions below. */
type StubWebContents = {
  openDevTools: ReturnType<typeof vi.fn>
}

type InternalDevtoolsInstance = {
  mainWindow: { webContents: StubWebContents }
}

describe('main-process wiring: internal-devtools:open is registered and drives detached DevTools', () => {
  it('a booted createDevtoolsRuntime instance registers the internal-devtools:open ipcMain handler', async () => {
    const instance = await createDevtoolsRuntime({})
    try {
      // BUG CAUGHT: registerInternalDevtoolsIpc declared but never called from
      // the app-assembly path — the button's invoke() would hit main.ipcMain
      // with no handler registered and reject.
      expect(
        stubs.ipcHandlers.has('internal-devtools:open'),
        'createDevtoolsRuntime must unconditionally wire registerInternalDevtoolsIpc alongside registerAppIpc/registerProjectFsIpc',
      ).toBe(true)
    } finally {
      await instance.dispose()
    }
  })

  it('invoking the handler opens the main window devtools in detached mode', async () => {
    const instance = await createDevtoolsRuntime({})
    try {
      const handler = stubs.ipcHandlers.get('internal-devtools:open')
      expect(typeof handler).toBe('function')

      // Modifying test: WorkbenchContext has no top-level `mainWindow` field
      // (only `ctx.windows.mainWindow`, per src/main/services/window-service.ts).
      // The real top-level `mainWindow: BrowserWindow` lives on
      // `WorkbenchAppInstance` itself — the SAME object `createContext` wires
      // into `ctx.windows` — so the assertion reads `instance.mainWindow`,
      // not `instance.context.mainWindow`.
      const inst = instance as unknown as InternalDevtoolsInstance
      const openDevTools = inst.mainWindow.webContents.openDevTools

      // Modifying test: `IpcRegistry.handle` wraps every handler with the
      // senderPolicy gate (src/main/utils/ipc-registry.ts), which reads
      // `event.sender.isDestroyed()` / `ctx.windows.isMainSender(sender.id)`
      // — a bare `{}` event throws before reaching the handler body. The
      // fake event must carry a `sender` the policy actually trusts: the
      // main window's own webContents (the button's real caller).
      await handler!({ sender: inst.mainWindow.webContents } as unknown, undefined)

      expect(
        openDevTools,
        'the handler must call mainWindow.webContents.openDevTools',
      ).toHaveBeenCalled()
      // Modifying test: Phase 1 (internal-devtools-window) now routes this
      // handler through `ctx.internalDevtoolsWindow.open()`, which calls
      // `openDevTools({ mode: 'detach', activate: false })` — the extra
      // `activate: false` matches the established
      // native-simulator-devtools-host.ts convention for a non-focus-stealing
      // repoint. The contract this test pins is "detached mode", not the
      // exact options object, so relax the strict-equality to an
      // objectContaining check.
      expect(
        openDevTools.mock.calls[0]?.[0],
        "must open in detached mode ({ mode: 'detach' }) — an attached DevTools would cramp the main window instead of floating alongside it",
      ).toEqual(expect.objectContaining({ mode: 'detach' }))
    } finally {
      await instance.dispose()
    }
  })

  it('calling the handler repeatedly (rapid button clicks) does not throw', async () => {
    const instance = await createDevtoolsRuntime({})
    try {
      const handler = stubs.ipcHandlers.get('internal-devtools:open')
      expect(typeof handler).toBe('function')

      const inst = instance as unknown as InternalDevtoolsInstance
      const event = { sender: inst.mainWindow.webContents } as unknown

      await handler!(event, undefined)
      await handler!(event, undefined)
      await handler!(event, undefined)

      // Modifying test: Phase 0 pinned "3 clicks → openDevTools called 3+
      // times" (naive re-open every click). Phase 1's internalDevtoolsWindow
      // controller intentionally replaces that with idempotent reuse —
      // `setDevToolsWebContents`'s host argument may only navigate once, so
      // a second/third click must re-show/focus the SAME host window rather
      // than re-navigating it (covered in detail by
      // internal-devtools-window/index.test.ts's "reuses it" suite). This
      // test's remaining job is just "repeated clicks don't throw" — assert
      // the FIRST call still opened detached DevTools exactly once.
      expect(inst.mainWindow.webContents.openDevTools.mock.calls.length).toBe(1)
    } finally {
      await instance.dispose()
    }
  })
})
