/**
 * `WorkbenchContext.internalDevtoolsWindow` — the standalone internal
 * DevTools debug window controller (src/main/windows/internal-devtools-window)
 * — must be assembled during `createDevtoolsRuntime` and torn down when the
 * app instance disposes, same as every other optional context field wired at
 * boot (see open-settings-wiring.test.ts / internal-devtools-wiring.test.ts
 * for the pattern this suite follows).
 *
 * This suite drives a REAL `createDevtoolsRuntime` boot (same exhaustive
 * electron stub as those files) and proves:
 *  - `instance.context.internalDevtoolsWindow` exists and exposes
 *    `open`/`dispose` functions after assembly;
 *  - a live host window opened via that controller gets closed when
 *    `instance.dispose()` runs — nothing about tearing down the app should
 *    leave a standalone DevTools window dangling.
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

/** Narrow stub shape for the host window `open()` constructs. Mirrors the
 * pattern in open-settings-wiring.test.ts: the real Electron BrowserWindow
 * type doesn't expose the mock's vi.fn() spies, so assertions go through a
 * local structural type instead of the module's real return type. */
interface StubBrowserWindow {
  destroy: ReturnType<typeof vi.fn>
}

interface InternalDevtoolsWindowContext {
  internalDevtoolsWindow?: {
    open: () => void
    dispose: () => void
  }
}

describe('main-process wiring: WorkbenchContext.internalDevtoolsWindow is assembled and torn down', () => {
  it('a booted createDevtoolsRuntime instance carries an internalDevtoolsWindow controller with open/dispose', async () => {
    const instance = await createDevtoolsRuntime({})
    try {
      const ctx = instance.context as unknown as InternalDevtoolsWindowContext

      // BUG CAUGHT: internalDevtoolsWindow declared on WorkbenchContext but
      // never assembled — registerInternalDevtoolsIpc's ctx.internalDevtoolsWindow?.open()
      // would silently no-op forever (optional chaining swallows the gap).
      expect(
        ctx.internalDevtoolsWindow,
        'createDevtoolsRuntime must assemble context.internalDevtoolsWindow via createInternalDevtoolsWindow(mainWindow)',
      ).toBeTruthy()
      expect(typeof ctx.internalDevtoolsWindow!.open).toBe('function')
      expect(typeof ctx.internalDevtoolsWindow!.dispose).toBe('function')
    } finally {
      await instance.dispose()
    }
  })

  it('instance.dispose() closes a host window that was opened via ctx.internalDevtoolsWindow.open()', async () => {
    const instance = await createDevtoolsRuntime({})
    const ctx = instance.context as unknown as InternalDevtoolsWindowContext

    expect(ctx.internalDevtoolsWindow).toBeTruthy()

    const windowCountBeforeOpen = stubs.browserWindows.length
    ctx.internalDevtoolsWindow!.open()

    // The controller must have built exactly one new host window (on top of
    // whatever windows app assembly already created, e.g. the main window).
    expect(stubs.browserWindows.length).toBe(windowCountBeforeOpen + 1)
    const hostWindow = stubs.browserWindows[stubs.browserWindows.length - 1] as StubBrowserWindow

    await instance.dispose()

    // Nothing about tearing down the app instance should leave a standalone
    // internal-DevTools window dangling — dispose() must reach the window
    // controller's own dispose() (registered on ctx.registry), which
    // destroys (not merely hides) the host window.
    expect(
      hostWindow.destroy,
      'createDevtoolsRuntime must register internalDevtoolsWindow.dispose on context.registry so instance.dispose() destroys any open host window',
    ).toHaveBeenCalled()
  })
})
