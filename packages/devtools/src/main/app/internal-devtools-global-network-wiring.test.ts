/**
 * `createDevtoolsRuntime` must wire `context.internalDevtoolsWindow`'s
 * `onHostChanged` subscription to `context.networkForward.setGlobalDevtoolsHost`
 * so the independent floating internal-DevTools window (once its own
 * front-end host view exists) receives the full, unfiltered CDP Network
 * mirror — see network-forward/index.ts's `setGlobalDevtoolsHost(wc)` (already
 * implemented+tested) and internal-devtools-window/index.ts's `open()` (which
 * builds the host view attached via `target.webContents.setDevToolsWebContents`).
 *
 * The subscription must be attached AFTER `context.networkForward` is
 * assigned: `internalDevtoolsWindow.onHostChanged((hostWc) => {
 * context.networkForward?.setGlobalDevtoolsHost(hostWc) })` reads
 * `context.networkForward` at CALL time (not subscribe time) only because the
 * callback re-reads the mutable `context.networkForward` field each time it
 * fires — if instead the wiring captured `networkForward` by value BEFORE it
 * was ever assigned (assignment ordered after the subscribe call), the
 * closure would be built while the local was still undefined and later
 * re-assignments to `context.networkForward` wouldn't reach it depending on
 * how the closure captures the reference. This suite proves the field is
 * live-read through to a real `setGlobalDevtoolsHost` call when
 * `context.networkForward` exists at open() time.
 *
 * `context.networkForward` is only assembled when `context.bridge?.isNativeHost()`
 * is true (see app.ts around the `createNetworkForwarder` call). EMPIRICAL
 * FINDING (verified by actually running `createDevtoolsRuntime({})` in this
 * suite, not assumed): on this branch the default boot path's bridge IS a
 * native-host bridge (native-host is the only runtime left — see
 * native-only-decommission history), so `context.networkForward` is ALWAYS
 * assembled (truthy) for `createDevtoolsRuntime({})`, no special adapter
 * config needed. This suite therefore asserts the wiring's real
 * value-passing end-to-end against the REAL `NetworkForwarder` instance
 * (spied via `vi.spyOn`, not a hand-rolled stub — replacing
 * `context.networkForward` with an incomplete fake object breaks unrelated
 * teardown code in `disposeProjectViews`/`view-manager.ts` that expects the
 * full `NetworkForwarder` shape, e.g. `detachSimulator`).
 *
 * Electron mock: copied verbatim from internal-devtools-window-wiring.test.ts
 * (this package's convention: main-process suites vi.mock('electron') per
 * file because CI has no Electron binary), extended with the WebContents
 * `debugger.sendCommand` used by native-host CDP wiring paths.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stubs = vi.hoisted(() => {
  type AnyFn = (...args: unknown[]) => unknown
  type EventBag = Record<string, Set<AnyFn>>

  const ipcHandlers = new Map<string, AnyFn>()
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
    show = vi.fn(() => { this.em.emit('show') })
    showInactive = vi.fn(() => { this.em.emit('show') })
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

interface StubWebContents {
  id: number
}

interface NetworkForwardWiringContext {
  internalDevtoolsWindow?: {
    open: () => void
    dispose: () => void
    onHostChanged: (handler: (hostWc: unknown) => void) => () => void
  }
  networkForward?: {
    setGlobalDevtoolsHost: (wc: StubWebContents | null) => void
  }
}

describe('main-process wiring: internalDevtoolsWindow host changes drive networkForward.setGlobalDevtoolsHost', () => {
  it('context.networkForward IS assembled under the default createDevtoolsRuntime({}) boot (empirical baseline for the tests below)', async () => {
    const instance = await createDevtoolsRuntime({})
    try {
      const ctx = instance.context as unknown as NetworkForwardWiringContext

      // Empirical finding this suite locks in (verified by actually running
      // createDevtoolsRuntime({}), not assumed): on this branch the default
      // bridge is native-host, so context.networkForward is truthy without
      // any special adapter config. If this assertion starts failing, the
      // default assembly path changed — the two tests below (which spy on
      // the REAL networkForward instance) would need re-checking.
      expect(ctx.networkForward).toBeTruthy()
      expect(typeof ctx.networkForward!.setGlobalDevtoolsHost).toBe('function')
    } finally {
      await instance.dispose()
    }
  })

  it('context.internalDevtoolsWindow.open() does not throw regardless of whether networkForward is wired up', async () => {
    const instance = await createDevtoolsRuntime({})
    try {
      const ctx = instance.context as unknown as NetworkForwardWiringContext

      // Guards the optional-chaining wiring: `context.networkForward?.setGlobalDevtoolsHost(...)`
      // must not throw. On this branch's default boot networkForward is
      // actually assembled (see the baseline test above), so this mainly
      // guards against the wiring itself throwing — a real undefined case
      // would additionally need a boot path without native-host, which was
      // not found under `createDevtoolsRuntime({})`.
      expect(() => ctx.internalDevtoolsWindow!.open()).not.toThrow()
    } finally {
      await instance.dispose()
    }
  })

  it('forwards the fresh host webContents to the REAL networkForward.setGlobalDevtoolsHost on open()', async () => {
    const instance = await createDevtoolsRuntime({})
    try {
      const ctx = instance.context as unknown as NetworkForwardWiringContext
      // Spy on the method of the REAL NetworkForwarder assembled by boot —
      // not a hand-rolled stub swapped into context.networkForward, which
      // would break unrelated teardown code (disposeProjectViews expects the
      // full NetworkForwarder shape, e.g. detachSimulator).
      const spy = vi.spyOn(ctx.networkForward!, 'setGlobalDevtoolsHost')

      ctx.internalDevtoolsWindow!.open()

      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith(expect.anything())
      expect(spy).not.toHaveBeenCalledWith(null)
    } finally {
      await instance.dispose()
    }
  })

  it('forwards null to the REAL networkForward.setGlobalDevtoolsHost when the internal devtools window closes', async () => {
    const instance = await createDevtoolsRuntime({})
    try {
      const ctx = instance.context as unknown as NetworkForwardWiringContext
      const spy = vi.spyOn(ctx.networkForward!, 'setGlobalDevtoolsHost')

      ctx.internalDevtoolsWindow!.open()
      spy.mockClear()

      // dispose() closes the internal devtools window (see
      // internal-devtools-window-wiring.test.ts), which must fire
      // onHostChanged(null) and reach networkForward.setGlobalDevtoolsHost(null).
      ctx.internalDevtoolsWindow!.dispose()

      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith(null)
    } finally {
      await instance.dispose()
    }
  })
})
