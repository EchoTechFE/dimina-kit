/**
 * Connection wiring — app bootstrap anchors the main-window renderer as the
 * first Connection.
 *
 * `createWorkbenchContext` builds an EMPTY ConnectionRegistry (side-effect-free
 * constructor). The actual anchoring happens in `createWorkbenchApp().setup()`
 * (app.ts ~349-353), which calls `context.connections.acquire(mainWindow.webContents)`
 * right after `createContext`. This suite pins that wiring:
 *
 *  1. After setup(), `context.connections.get(mainWindow.webContents.id)` is a
 *     LIVE connection (alive===true, webContents===the main window's wc).
 *  2. When the main window's wc emits 'destroyed', the connection closes:
 *     `get(id)` → undefined and `all()` no longer contains it (connection.ts
 *     close(): byId.delete(id), alive=false).
 *
 * A failure here points at the bootstrap wiring (the `acquire` line removed /
 * pointed at the wrong webContents) or at the connection lifecycle hook — not
 * at a broken harness.
 *
 * Seam: there is no standalone factory for the runtime instance — it is built
 * inline in setup(). The stable seam is the `onSetup` hook, which receives the
 * `WorkbenchAppInstance` exposing `mainWindow` + `context`. The electron mock
 * here is copied from `instance-ipc-extension.test.ts` so the suite is
 * self-contained; the WebContents fake carries id/on/once/emit/isDestroyed,
 * and `BrowserWindow.webContents` is a WebContents instance.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── electron stub (self-contained; mirrors instance-ipc-extension.test.ts) ──
const stubs = vi.hoisted(() => {
  type AnyFn = (...args: unknown[]) => unknown
  type EventBag = Record<string, Set<AnyFn>>

  const ipcHandlers = new Map<string, AnyFn>()
  const removeHandlerCalls: string[] = []

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
    removeHandlerCalls.length = 0
  }

  return { ipcHandlers, removeHandlerCalls, makeEmitter, reset }
})

vi.mock('electron', () => {
  type AnyFn = (...args: unknown[]) => unknown

  const ipcEmitter = stubs.makeEmitter()
  const ipcMain = {
    ...ipcEmitter,
    handle: vi.fn((channel: string, fn: AnyFn) => {
      stubs.ipcHandlers.set(channel, fn)
    }),
    removeHandler: vi.fn((channel: string) => {
      stubs.ipcHandlers.delete(channel)
      stubs.removeHandlerCalls.push(channel)
    }),
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
    setName: vi.fn(),
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

let createWorkbenchApp: typeof import('./app.js').createWorkbenchApp

beforeEach(async () => {
  vi.resetModules()
  stubs.reset()
  ;({ createWorkbenchApp } = await import('./app.js'))
})

/** Drives setup() and returns the WorkbenchAppInstance captured from onSetup. */
async function setupInstance(): Promise<import('./app.js').WorkbenchAppInstance> {
  let captured: import('./app.js').WorkbenchAppInstance | undefined
  const instance = await createWorkbenchApp({
    onSetup(inst) {
      captured = inst as import('./app.js').WorkbenchAppInstance
    },
  }).setup()
  expect(captured, 'onSetup must receive the WorkbenchAppInstance').toBeDefined()
  expect(captured).toBe(instance)
  return instance
}

describe('app bootstrap anchors the main-window renderer as the first Connection', () => {
  it('exposes a LIVE connection for the main window webContents after setup()', async () => {
    const instance = await setupInstance()
    const mainWc = instance.mainWindow.webContents

    const conn = instance.context.connections.get(mainWc.id)

    // Catches "the acquire() bootstrap line was removed / never ran".
    expect(
      conn,
      'context.connections.get(mainWindow.webContents.id) must return a connection after setup()',
    ).toBeDefined()
    expect(conn!.alive, 'the main-window connection must be alive').toBe(true)
    // Catches "acquired the wrong webContents" (e.g. an overlay/view wc).
    expect(
      conn!.webContents,
      'the connection must wrap the main window webContents, not some other wc',
    ).toBe(mainWc)

    // And it is part of all().
    expect(instance.context.connections.all()).toContain(conn)

    await instance.dispose()
  })

  it("closes the main-window connection when its webContents emits 'destroyed'", async () => {
    const instance = await setupInstance()
    const mainWc = instance.mainWindow.webContents
    const id = mainWc.id

    const conn = instance.context.connections.get(id)
    expect(conn, 'precondition: connection exists before destroy').toBeDefined()
    expect(conn!.alive).toBe(true)

    // Hard destroy — the terminal hook armed by connection.build via
    // wc.once('destroyed'). close() flips alive=false and de-registers.
    ;(mainWc as unknown as { emit: (e: string) => void }).emit('destroyed')

    expect(
      instance.context.connections.get(id),
      "get(id) must return undefined after the wc emits 'destroyed'",
    ).toBeUndefined()
    expect(
      instance.context.connections.all().some((c) => c.id === id),
      "all() must no longer contain the closed connection",
    ).toBe(false)
    // The connection object itself reports dead.
    expect(conn!.alive, 'the closed connection must report alive===false').toBe(false)

    await instance.dispose()
  })
})
