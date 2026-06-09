/**
 * Workbench model refactor — "custom IPC extension surface".
 *
 * The `onSetup(instance)` hook hands the host a `WorkbenchAppInstance`. This
 * suite pins down two NEW capabilities that surface object must grow
 * (`docs/workbench-model.md`):
 *
 *  Requirement A — `instance.ipc`:
 *    A gated `IpcRegistry` bound to `context.senderPolicy`. Channels
 *    registered through it reject untrusted senders (gateway parity with the
 *    built-in IPC), accept trusted ones, and are torn down when the context
 *    is disposed (the registry lives in `ctx.registry`).
 *
 *  Requirement B — `instance.registerTrustedWindow(win)`:
 *    Adds a host-owned BrowserWindow's webContents to the trusted-sender set
 *    so `context.senderPolicy(win.webContents)` returns true. The returned
 *    Disposable removes it again; closing the window auto-removes it; and the
 *    Disposable is registered into `ctx.registry` for context-scoped cleanup.
 *
 * Each assertion below pins one of these two capabilities. A failure must
 * point at the feature itself (`instance.ipc` / `instance.registerTrustedWindow`
 * undefined, or the policy not honoring a registered window), not at a broken
 * harness.
 *
 * Seam: there is no standalone factory for `WorkbenchAppInstance` — the
 * object is built inline inside `createDevtoolsRuntime()`. The closest
 * stable seam is the `onSetup` hook itself, which receives that very
 * instance. We drive the full app under the same exhaustive electron mock
 * used by `update-manager-sender-policy.test.ts` and capture the instance
 * from `onSetup`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── electron stub: records ipcMain.handle channel → guarded fn ──────────────
const stubs = vi.hoisted(() => {
  type AnyFn = (...args: unknown[]) => unknown
  type EventBag = Record<string, Set<AnyFn>>

  // channel → the (guarded) function actually registered by IpcRegistry.
  const ipcHandlers = new Map<string, AnyFn>()
  // every channel passed to ipcMain.removeHandler, in order.
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
    quit: vi.fn(),
    commandLine: { getSwitchValue: vi.fn(() => ''), appendSwitch: vi.fn() },
  }

  // Monotonic id allocator so every WebContents (main window + host windows)
  // gets a distinct, stable id — the sender-policy keys on `webContents.id`.
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
    // defaultSession stub — consumed by `registerEditorProtocolHandler`
    // (dmieditor:// scheme handler) during workbench setup.
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

// Imported lazily inside beforeEach so the electron mock is installed before
// app.ts (and its transitive module graph) captures `ipcMain` / `app`.
let createDevtoolsRuntime: typeof import('./app.js').createDevtoolsRuntime
let IpcRegistry: typeof import('../utils/ipc-registry.js').IpcRegistry
let BrowserWindowMock: typeof import('electron').BrowserWindow

beforeEach(async () => {
  vi.resetModules()
  stubs.reset()
  ;({ createDevtoolsRuntime } = await import('./app.js'))
  ;({ IpcRegistry } = await import('../utils/ipc-registry.js'))
  ;({ BrowserWindow: BrowserWindowMock } = await import('electron'))
})

/**
 * Drives `createDevtoolsRuntime` and returns the `WorkbenchAppInstance` captured
 * from the `onSetup` hook — the runtime object whose extension surface this
 * suite verifies.
 */
async function setupInstance(): Promise<import('./app.js').WorkbenchAppInstance> {
  let captured: import('./app.js').WorkbenchAppInstance | undefined
  const instance = await createDevtoolsRuntime({
    onSetup(inst) {
      captured = inst as import('./app.js').WorkbenchAppInstance
    },
  })
  // `onSetup` runs synchronously inside setup(); if it didn't capture, the
  // hook contract itself regressed.
  expect(captured, 'onSetup must receive the WorkbenchAppInstance').toBeDefined()
  // The captured instance and the returned instance are the same object.
  expect(captured).toBe(instance)
  return instance
}

/** A WebContents-shaped object the workbench sender-policy will NOT trust. */
function untrustedSender() {
  return { id: 987_654, isDestroyed: () => false, getURL: () => 'https://evil.example' }
}

// ── Requirement A — instance.ipc ────────────────────────────────────────────

describe('Requirement A: instance.ipc is a gated IpcRegistry', () => {
  it('exposes `ipc` as an IpcRegistry instance on the onSetup instance', async () => {
    const instance = await setupInstance()

    // Catches "instance.ipc was never added".
    expect(
      (instance as unknown as { ipc?: unknown }).ipc,
      'expected instance.ipc to be defined',
    ).toBeDefined()
    // Catches "instance.ipc is some ad-hoc object, not an IpcRegistry".
    expect((instance as unknown as { ipc: unknown }).ipc).toBeInstanceOf(IpcRegistry)
    expect(
      typeof (instance as unknown as { ipc: { handle?: unknown } }).ipc.handle,
    ).toBe('function')

    await instance.dispose()
  })

  it('a channel registered via instance.ipc rejects an untrusted sender', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const instance = await setupInstance()
    const ipc = (instance as unknown as { ipc: InstanceType<typeof IpcRegistry> }).ipc

    ipc.handle('host:custom-ipc', () => 'host-data')

    const guarded = stubs.ipcHandlers.get('host:custom-ipc')
    expect(guarded, 'instance.ipc.handle must register the channel on ipcMain').toBeDefined()

    // instance.ipc is bound to ctx.senderPolicy → an untrusted sender must be
    // rejected with the IpcRegistry gate's rejection. Without the policy
    // binding the handler would run ungated and resolve to 'host-data'.
    await expect(
      Promise.resolve(guarded!({ sender: untrustedSender() })),
    ).rejects.toThrow(/IPC sender rejected for channel host:custom-ipc/)

    warnSpy.mockRestore()
    await instance.dispose()
  })

  it('a channel registered via instance.ipc accepts the trusted main-window sender', async () => {
    const instance = await setupInstance()
    const ipc = (instance as unknown as { ipc: InstanceType<typeof IpcRegistry> }).ipc

    ipc.handle('host:custom-ipc-ok', () => 'host-data')
    const guarded = stubs.ipcHandlers.get('host:custom-ipc-ok')!

    // The main window's renderer IS on the default trusted set; a call from it
    // must pass the gate and return the handler's value.
    const mainSender = instance.mainWindow.webContents
    await expect(
      Promise.resolve(guarded({ sender: mainSender })),
    ).resolves.toBe('host-data')

    await instance.dispose()
  })

  it('handlers registered via instance.ipc are torn down when the context is disposed', async () => {
    const instance = await setupInstance()
    const ipc = (instance as unknown as { ipc: InstanceType<typeof IpcRegistry> }).ipc

    ipc.handle('host:disposed-ipc', () => 'x')
    expect(stubs.ipcHandlers.has('host:disposed-ipc')).toBe(true)

    // instance.ipc must live inside ctx.registry, so disposing the context
    // (instance.dispose → ctx.registry.dispose) cascades to removeHandler.
    await instance.dispose()

    expect(
      stubs.removeHandlerCalls,
      "expected ctx dispose to removeHandler('host:disposed-ipc') — instance.ipc must be in ctx.registry",
    ).toContain('host:disposed-ipc')
    expect(stubs.ipcHandlers.has('host:disposed-ipc')).toBe(false)
  })
})

// ── Requirement B — instance.registerTrustedWindow ──────────────────────────

describe('Requirement B: instance.registerTrustedWindow', () => {
  it('exposes `registerTrustedWindow` as a function on the onSetup instance', async () => {
    const instance = await setupInstance()
    expect(
      typeof (instance as unknown as { registerTrustedWindow?: unknown }).registerTrustedWindow,
    ).toBe('function')
    await instance.dispose()
  })

  it('an unregistered host window is NOT trusted by the sender policy', async () => {
    const instance = await setupInstance()
    const hostWin = new BrowserWindowMock()

    // A fresh host BrowserWindow is not the main window / settings / overlay,
    // so the default policy must reject it.
    expect(
      instance.context.senderPolicy(hostWin.webContents),
      'a host window must be untrusted before registerTrustedWindow',
    ).toBe(false)

    await instance.dispose()
  })

  it('registerTrustedWindow(win) makes win.webContents trusted', async () => {
    const instance = await setupInstance()
    const hostWin = new BrowserWindowMock()
    const reg = instance as unknown as {
      registerTrustedWindow: (w: import('electron').BrowserWindow) => import('../utils/disposable.js').Disposable
    }

    expect(instance.context.senderPolicy(hostWin.webContents)).toBe(false)

    reg.registerTrustedWindow(hostWin)

    // After registration the same webContents must pass the gate.
    expect(
      instance.context.senderPolicy(hostWin.webContents),
      'registerTrustedWindow must add win.webContents to the trusted set',
    ).toBe(true)

    await instance.dispose()
  })

  it('disposing the returned Disposable un-trusts the window again', async () => {
    const instance = await setupInstance()
    const hostWin = new BrowserWindowMock()
    const reg = instance as unknown as {
      registerTrustedWindow: (w: import('electron').BrowserWindow) => import('../utils/disposable.js').Disposable
    }

    const disposable = reg.registerTrustedWindow(hostWin)
    expect(instance.context.senderPolicy(hostWin.webContents)).toBe(true)
    expect(
      typeof disposable?.dispose,
      'registerTrustedWindow must return a Disposable',
    ).toBe('function')

    await disposable.dispose()

    expect(
      instance.context.senderPolicy(hostWin.webContents),
      'disposing the returned Disposable must remove the window from the trusted set',
    ).toBe(false)

    await instance.dispose()
  })

  it("auto-removes the window from the trusted set when it emits 'closed'", async () => {
    const instance = await setupInstance()
    const hostWin = new BrowserWindowMock()
    const reg = instance as unknown as {
      registerTrustedWindow: (w: import('electron').BrowserWindow) => import('../utils/disposable.js').Disposable
    }

    reg.registerTrustedWindow(hostWin)
    expect(instance.context.senderPolicy(hostWin.webContents)).toBe(true)

    // Host closes its own dialog without calling dispose() — the window's
    // 'closed' event must auto-evict it from the trusted set.
    ;(hostWin as unknown as { emit: (e: string) => void }).emit('closed')

    expect(
      instance.context.senderPolicy(hostWin.webContents),
      "a closed host window must no longer be trusted (auto-cleanup on 'closed')",
    ).toBe(false)

    await instance.dispose()
  })

  it('the registerTrustedWindow Disposable is in ctx.registry — context dispose un-trusts the window', async () => {
    const instance = await setupInstance()
    const hostWin = new BrowserWindowMock()
    const reg = instance as unknown as {
      registerTrustedWindow: (w: import('electron').BrowserWindow) => import('../utils/disposable.js').Disposable
    }

    reg.registerTrustedWindow(hostWin)
    expect(instance.context.senderPolicy(hostWin.webContents)).toBe(true)

    // Without ever calling the returned disposable, disposing the context
    // must still un-trust the window — proof the disposable joined
    // ctx.registry and is released by the context-scoped cascade.
    await instance.dispose()

    expect(
      instance.context.senderPolicy(hostWin.webContents),
      'context dispose must release the registerTrustedWindow disposable (it must live in ctx.registry)',
    ).toBe(false)
  })

  // ── Reference-counting semantics for repeated registration ────────────────
  //
  // `trustedWindowSenderIds` is a `Map<number, number>` keyed on
  // `webContents.id` whose value is a reference count, so registering the SAME
  // window twice bumps the count to 2 under a single key. A naive
  // implementation that just `map.delete(id)` on dispose lets the FIRST
  // dispose evict the window even though a second, still-live registration
  // exists. The trusted state must be reference-counted: the entry survives
  // until EVERY registration's Disposable has been disposed (count → 0).

  it('registering the same window twice keeps it trusted until BOTH disposables are disposed', async () => {
    const instance = await setupInstance()
    const hostWin = new BrowserWindowMock()
    const reg = instance as unknown as {
      registerTrustedWindow: (w: import('electron').BrowserWindow) => import('../utils/disposable.js').Disposable
    }

    const first = reg.registerTrustedWindow(hostWin)
    const second = reg.registerTrustedWindow(hostWin)

    // Two registrations → trusted.
    expect(
      instance.context.senderPolicy(hostWin.webContents),
      'a window registered twice must be trusted',
    ).toBe(true)

    // Dispose ONE of the two registrations. The other is still live, so the
    // window MUST remain trusted. (A non-ref-counted impl fails here: the
    // first dispose deletes the shared Set entry and the window goes dark
    // while `second` is still holding a reference.)
    await first.dispose()
    expect(
      instance.context.senderPolicy(hostWin.webContents),
      'disposing one of two registrations must NOT un-trust the window — the other registration is still live',
    ).toBe(true)

    // Dispose the LAST registration → ref-count hits zero → un-trusted.
    await second.dispose()
    expect(
      instance.context.senderPolicy(hostWin.webContents),
      'disposing the final registration must un-trust the window',
    ).toBe(false)
  })

  it("a window registered twice is un-trusted immediately on 'closed', regardless of outstanding disposables", async () => {
    const instance = await setupInstance()
    const hostWin = new BrowserWindowMock()
    const reg = instance as unknown as {
      registerTrustedWindow: (w: import('electron').BrowserWindow) => import('../utils/disposable.js').Disposable
    }

    reg.registerTrustedWindow(hostWin)
    reg.registerTrustedWindow(hostWin)
    expect(instance.context.senderPolicy(hostWin.webContents)).toBe(true)

    // The window is gone — `closed` must zero the ref-count outright. It must
    // NOT take two `closed` events (one per registration) to evict it; the
    // window is dead, so a single `closed` un-trusts it even though neither
    // Disposable was disposed.
    ;(hostWin as unknown as { emit: (e: string) => void }).emit('closed')

    expect(
      instance.context.senderPolicy(hostWin.webContents),
      "'closed' must un-trust a twice-registered window in one shot — the window is dead, ref-count goes straight to zero",
    ).toBe(false)
  })

  it("after one dispose + 'closed' on a twice-registered window, disposing the remaining disposable is a safe no-op", async () => {
    const instance = await setupInstance()
    const hostWin = new BrowserWindowMock()
    const reg = instance as unknown as {
      registerTrustedWindow: (w: import('electron').BrowserWindow) => import('../utils/disposable.js').Disposable
    }

    const first = reg.registerTrustedWindow(hostWin)
    const second = reg.registerTrustedWindow(hostWin)
    expect(instance.context.senderPolicy(hostWin.webContents)).toBe(true)

    // Dispose one registration, then close the window. The window is dead and
    // there is still one outstanding registration (`second`) that was never
    // disposed.
    await first.dispose()
    ;(hostWin as unknown as { emit: (e: string) => void }).emit('closed')
    expect(
      instance.context.senderPolicy(hostWin.webContents),
      "'closed' must un-trust the window even with an outstanding registration",
    ).toBe(false)

    // Disposing the leftover registration after the window already closed must
    // not throw and must not resurrect / mis-decrement anything.
    await expect(Promise.resolve(second.dispose())).resolves.not.toThrow()
    expect(
      instance.context.senderPolicy(hostWin.webContents),
      'window stays un-trusted after disposing the leftover registration post-close',
    ).toBe(false)
  })

  // ── Registry-entry leak: the returned Disposable must be the registry wrapper ─
  //
  // `instance.registerTrustedWindow` does `ctx.registry.add(disposable)` but
  // `DisposableRegistry.add()` RETURNS a wrapper — only disposing that wrapper
  // splices the entry out of `registry.entries`. If the method returns the raw
  // `disposable` instead of the wrapper, the host can dispose it (un-trusting
  // the window) yet the dead registry entry lingers, accumulating until the
  // whole context is torn down. The fix must return the wrapper so a single
  // dispose does BOTH: un-trust the window AND drop the registry entry.

  it('disposing the returned Disposable drops its ctx.registry entry (no leak)', async () => {
    const instance = await setupInstance()
    const reg = instance as unknown as {
      registerTrustedWindow: (w: import('electron').BrowserWindow) => import('../utils/disposable.js').Disposable
    }
    const registry = instance.context.registry as unknown as { size: number }

    // `size` is the only stable window into live registry entries — the fix
    // adds it as a readonly getter on DisposableRegistry.
    const baseline = registry.size

    const hostWin = new BrowserWindowMock()
    const disposable = reg.registerTrustedWindow(hostWin)

    // Registration added exactly one live entry to ctx.registry.
    expect(
      registry.size,
      'registerTrustedWindow must add exactly one entry to ctx.registry',
    ).toBe(baseline + 1)

    await disposable.dispose()

    // The returned disposable must be the registry wrapper, not the RAW
    // disposable: disposing it splices the entry out so size returns to
    // baseline. (A raw disposable would never splice the entry, leaving a
    // leaked dead entry at baseline+1.)
    expect(
      registry.size,
      'disposing the returned Disposable must remove its ctx.registry entry — return the wrapper from registry.add(), not the raw disposable',
    ).toBe(baseline)

    // The dispose must ALSO release the underlying resource: the window is
    // un-trusted. So the single dispose does both jobs.
    expect(
      instance.context.senderPolicy(hostWin.webContents),
      'disposing the returned Disposable must also un-trust the window',
    ).toBe(false)

    await instance.dispose()
  })
})
