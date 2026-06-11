/**
 * Feedback fix ② (RUNTIME half) — `ctx.openSettings()` must actually open the
 * settings window through the real `openSettingsWindow` path.
 *
 * The type half (src/main/runtime/miniapp-runtime-open-settings.test.ts)
 * pins that `WorkbenchContext` / `MiniappRuntime` carry
 * `openSettings: () => Promise<void>`. A declared member can still be wired
 * to nothing; this suite drives a REAL `createDevtoolsRuntime` boot (same
 * exhaustive electron stub as menu-builder-runtime-context.test.ts) and
 * proves the value-level wiring:
 *
 *  - `instance.context.openSettings` is a function [RED today: undefined];
 *  - calling it lands in the `openSettingsWindow` path: a settings
 *    BrowserWindow is created, registered on `ctx.windows.settingsWindow`,
 *    loads `entries/workbench-settings/index.html`, and is shown/focused;
 *  - calling it AGAIN while the window is alive reuses the same window
 *    (openSettingsWindow's documented reuse branch), not a second one.
 *
 * Electron mock: copied from menu-builder-runtime-context.test.ts (vitest
 * mocks are per-file by convention in this package; main-process suites must
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

/** Stub-window view used by the assertions below. */
type StubWindow = {
  loadFile: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
  isDestroyed: () => boolean
}

type OpenSettingsContext = {
  openSettings?: () => Promise<void>
  windows: { settingsWindow: StubWindow | null }
}

describe('feedback ② (runtime): ctx.openSettings is wired to the openSettingsWindow path', () => {
  it('openSettings exists on the booted context and opens + shows the settings window [RED today]', async () => {
    const instance = await createDevtoolsRuntime({})
    try {
      const ctx = instance.context as unknown as OpenSettingsContext

      // BUG CAUGHT: a contract member declared but never assembled — a
      // MiniappRuntime host calls openSettings() and gets a TypeError.
      expect(
        typeof ctx.openSettings,
        'WorkbenchContext.openSettings must be wired during app assembly',
      ).toBe('function')

      await ctx.openSettings!()

      // The openSettingsWindow path: window created, registered on the
      // WindowService, settings entry loaded, shown and focused.
      const win = ctx.windows.settingsWindow
      expect(win, 'openSettings must register the window on ctx.windows.settingsWindow').toBeTruthy()
      expect(win!.loadFile).toHaveBeenCalledWith(
        expect.stringContaining('entries/workbench-settings/index.html'),
      )
      expect(win!.show).toHaveBeenCalled()
      expect(win!.focus).toHaveBeenCalled()
    } finally {
      await instance.dispose()
    }
  })

  it('a second openSettings() call reuses the live settings window instead of creating another [RED today]', async () => {
    const instance = await createDevtoolsRuntime({})
    try {
      const ctx = instance.context as unknown as OpenSettingsContext
      expect(typeof ctx.openSettings).toBe('function')

      await ctx.openSettings!()
      const first = ctx.windows.settingsWindow
      expect(first).toBeTruthy()
      const windowCountAfterFirst = stubs.browserWindows.length

      await ctx.openSettings!()

      // openSettingsWindow's reuse branch: same window object, no new
      // BrowserWindow constructed, re-shown for focus.
      expect(ctx.windows.settingsWindow).toBe(first)
      expect(stubs.browserWindows.length).toBe(windowCountAfterFirst)
      expect(first!.show.mock.calls.length).toBeGreaterThanOrEqual(2)
    } finally {
      await instance.dispose()
    }
  })
})
