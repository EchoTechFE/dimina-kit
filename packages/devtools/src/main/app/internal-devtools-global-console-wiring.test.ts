/**
 * `createDevtoolsRuntime` must wire `context.internalDevtoolsWindow`'s
 * `onHostChanged` subscription to a `createGlobalConsoleMirror` instance built
 * over `context.consoleForwarder`, so the independent floating internal-DevTools
 * window (once its own front-end host view exists) receives EVERY guest
 * console entry (service + render, UNFILTERED — no isInternalLogMessage
 * gating) mirrored into its own console — see
 * services/console-forward/global-console-mirror.ts's `createGlobalConsoleMirror`
 * (already implemented+tested) and internal-devtools-window/index.ts's `open()`
 * (which builds the host view attached via `target.webContents.setDevToolsWebContents`).
 *
 * `context.consoleForwarder` is assembled by the simulator module's
 * `installBridgeRouter` inside `registerBuiltinModules` (see app.ts around the
 * `if (context.consoleForwarder)` wiring block) — this suite first proves it
 * is actually truthy under the default `createDevtoolsRuntime({})` boot path
 * (a precondition for the wiring below to matter at all: if it were
 * `undefined`, the whole block would be a no-op and every test in this file
 * would trivially observe no forwarding).
 *
 * Electron mock: copied verbatim from internal-devtools-global-network-wiring.test.ts
 * (this package's convention: main-process suites vi.mock('electron') per file
 * because CI has no Electron binary).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * `createOpenGatedRelay`'s `deliver()` now always routes `inject()` through
 * `Promise.resolve().then(...)` — even a synchronously-successful injection —
 * so it can react to the confirmed success/failure outcome (see that
 * module's doc comment). Tests asserting on `executeJavaScript` having been
 * called must flush that microtask first.
 */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

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
    // Modifying test fixture: `createGlobalConsoleMirror` gained an
    // `isFrontendSettled(wc)` gate (Bug C fix), which requires a non-empty,
    // non-`about:blank` `getURL()` plus a non-loading main frame — a bare
    // `''` (this mock's prior default) always reads as "unsettled" and
    // silently no-ops every injection. Real webContents (mainWindow included)
    // have genuinely loaded a URL by the time these assertions run.
    getURL = () => 'file:///mock-loaded.html'
    isLoadingMainFrame = () => false
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

interface StubExecuteJavaScript {
  executeJavaScript: (...args: unknown[]) => Promise<unknown>
}
interface StubView {
  children: { webContents: StubExecuteJavaScript }[]
}
interface StubBrowserWindowLike {
  contentView: StubView
}

interface GuestConsoleEntryLike {
  source?: string
  bridgeId?: string
  level?: string
  args?: unknown[]
}

interface ConsoleForwardWiringContext {
  internalDevtoolsWindow?: {
    open: () => void
    dispose: () => void
    onHostChanged: (handler: (hostWc: unknown) => void) => () => void
  }
  consoleForwarder?: {
    emit: (entry: unknown) => void
    subscribe: (sink: (entry: GuestConsoleEntryLike) => void) => { dispose: () => void }
  }
}

function lastBrowserWindow(): StubBrowserWindowLike {
  return stubs.browserWindows[stubs.browserWindows.length - 1] as StubBrowserWindowLike
}

/** The internal-devtools window's freshly-built host wc (see on-host-changed.test.ts's hostWcOf). */
function currentHostWc(): StubExecuteJavaScript {
  return lastBrowserWindow().contentView.children[0].webContents
}

describe('main-process wiring: internalDevtoolsWindow host changes drive the global console mirror', () => {
  it('context.consoleForwarder IS assembled under the default createDevtoolsRuntime({}) boot (empirical baseline for the tests below)', async () => {
    const instance = await createDevtoolsRuntime({})
    try {
      const ctx = instance.context as unknown as ConsoleForwardWiringContext

      // Empirical finding this suite locks in (verified by actually running
      // createDevtoolsRuntime({}), not assumed): registerBuiltinModules's
      // simulator installBridgeRouter assembles context.consoleForwarder by
      // default, so the `if (context.consoleForwarder)` wiring block in
      // app.ts is live (not a no-op) for this config. If this assertion ever
      // fails, the mirror wiring below never installed a subscription at all
      // and the remaining tests in this file would need re-checking against
      // whatever boot path makes consoleForwarder undefined.
      expect(ctx.consoleForwarder).toBeTruthy()
      expect(typeof ctx.consoleForwarder!.emit).toBe('function')
      expect(typeof ctx.consoleForwarder!.subscribe).toBe('function')
    } finally {
      await instance.dispose()
    }
  })

  // Modifying test: this suite originally had a test here asserting that
  // executeJavaScript fires on `currentHostWc()` (the independent window's
  // own front-end host wc) — that was the PRE-Bug-A (buggy) target. The Bug A
  // fix below intentionally changed the mirror's target to
  // `mainWindow.webContents` (see its doc comment), so that assertion now
  // contradicts the corrected, intentional behavior. The replacement coverage
  // — "mirrors console entries into mainWindow.webContents ... not the
  // independent host wc" further down — asserts both halves (mainWc IS
  // called, hostWc is NOT) more precisely than the old test did, so it is not
  // re-added here, just removed.

  it('does not throw when consoleForwarder emits before the internal devtools window has ever been opened', async () => {
    const instance = await createDevtoolsRuntime({})
    try {
      const ctx = instance.context as unknown as ConsoleForwardWiringContext

      // No open() call yet — getTargetWc() must resolve to null and the
      // mirror must no-op rather than throw.
      expect(() => ctx.consoleForwarder!.emit({ source: 'render', level: 'warn', args: ['before-open'] })).not.toThrow()
    } finally {
      await instance.dispose()
    }
  })

  // Modifying test: this suite originally also had a "stops forwarding to
  // the old host wc once disposed" test here, spying on `currentHostWc()`.
  // Since the Bug A fix (below), hostWc was never the mirror's target to
  // begin with, so a "not called after dispose" assertion against it is now
  // vacuously true regardless of the dispose behavior being tested — it no
  // longer exercises anything. The equivalent, meaningful coverage against
  // the CORRECT target lives in "stops mirroring into mainWindow.webContents
  // once ... disposed" further down, so this vacuous test is removed rather
  // than kept alongside it.

  // Bug A: the mirror's target must be the INSPECTED side (mainWindow.webContents
  // — see internal-devtools-window/index.ts's `target.webContents.setDevToolsWebContents(hostView.webContents)`),
  // never the independent window's own front-end host wc. A console.log executed
  // inside the front-end host's own JS realm only reaches that realm's own
  // (unwatched) console — never the Console panel it itself renders — so wiring
  // getTargetWc to follow `hostWc` makes the whole mirror invisible in practice.
  it('mirrors console entries into mainWindow.webContents (the inspected target), not the independent host wc', async () => {
    const instance = await createDevtoolsRuntime({})
    try {
      const ctx = instance.context as unknown as ConsoleForwardWiringContext
      ctx.internalDevtoolsWindow!.open()

      const hostWc = currentHostWc()
      const mainWc = instance.mainWindow.webContents
      const mainSpy = vi.spyOn(mainWc, 'executeJavaScript')
      const hostSpy = vi.spyOn(hostWc, 'executeJavaScript')

      ctx.consoleForwarder!.emit({ source: 'service', level: 'log', args: ['target-check'] })
      await flushMicrotasks()

      expect(mainSpy).toHaveBeenCalledTimes(1)
      expect(hostSpy).not.toHaveBeenCalled()
    } finally {
      await instance.dispose()
    }
  })

  // Bug A, window-open-state variant: getTargetWc must go null when the window is
  // CLOSED (onHostChanged(null)) even though mainWindow.webContents itself is very
  // much alive and open — the mirror is gated on "is the standalone window open",
  // not on mainWindow's own lifecycle.
  it('stops mirroring into mainWindow.webContents once the internal devtools window is disposed (closed), even though mainWindow itself stays alive', async () => {
    const instance = await createDevtoolsRuntime({})
    try {
      const ctx = instance.context as unknown as ConsoleForwardWiringContext
      ctx.internalDevtoolsWindow!.open()
      const mainWc = instance.mainWindow.webContents
      const mainSpy = vi.spyOn(mainWc, 'executeJavaScript')

      ctx.internalDevtoolsWindow!.dispose()
      ctx.consoleForwarder!.emit({ source: 'service', level: 'error', args: ['after-close'] })

      expect(mainSpy).not.toHaveBeenCalled()
    } finally {
      await instance.dispose()
    }
  })
})
