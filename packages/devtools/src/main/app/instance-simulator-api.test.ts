/**
 * Workbench model refactor — "simulator-api per-context",
 * Requirement B: `instance.registerSimulatorApi`.
 *
 * `docs/workbench-model.md`: the `WorkbenchHostInstance`
 * (and its runtime superset `WorkbenchAppInstance`) must grow a
 * `registerSimulatorApi(name, handler): Disposable` method that:
 *
 *  - registers the handler into THIS context's `ctx.simulatorApis` registry
 *    (per-context — never the deleted process-global),
 *  - returns a `Disposable`; disposing it removes the registration,
 *  - is auto-released when the context is disposed (the registration joins
 *    `ctx.registry`), and
 *  - is present on the instance BEFORE `onSetup(instance)` is invoked.
 *
 * Each assertion pins one of those guarantees: a failure points at a missing
 * method / missing per-context wiring, not at a broken harness.
 *
 * Seam: identical to `instance-ipc-extension.test.ts` — there is no standalone
 * factory for `WorkbenchAppInstance`; the object is built inline inside
 * `createDevtoolsRuntime()`. The `onSetup` hook receives that very
 * instance, so we drive the full app under an exhaustive electron mock and
 * capture the instance from `onSetup`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── electron stub: records ipcMain.handle channel → guarded fn ──────────────
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
    defaultSession: { protocol: { handle: vi.fn(), unhandle: vi.fn() } },
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

type SimulatorApiHandler = (params: unknown) => unknown | Promise<unknown>
type SimulatorApiRegistry = import('../services/simulator/custom-apis.js').SimulatorApiRegistry
type Disposable = import('../utils/disposable.js').Disposable
type AppInstance = import('./app.js').WorkbenchAppInstance

/** The extra method this suite asserts onto the instance. */
type WithRegisterSimulatorApi = {
  registerSimulatorApi: (name: string, handler: SimulatorApiHandler) => Disposable
}

/**
 * Drives `createDevtoolsRuntime` and returns the `WorkbenchAppInstance` captured
 * from `onSetup`. Also asserts the instance carries `registerSimulatorApi`
 * AT `onSetup` time — the method must exist before the hook runs.
 */
async function setupInstance(): Promise<AppInstance & WithRegisterSimulatorApi> {
  let sawMethodInOnSetup = false
  let captured: AppInstance | undefined
  const instance = await createDevtoolsRuntime({
    onSetup(inst) {
      captured = inst as AppInstance
      sawMethodInOnSetup =
        typeof (inst as unknown as Partial<WithRegisterSimulatorApi>).registerSimulatorApi
        === 'function'
    },
  })

  expect(captured, 'onSetup must receive the WorkbenchAppInstance').toBeDefined()
  expect(captured).toBe(instance)
  // Catches a registerSimulatorApi that is bolted on AFTER onSetup runs —
  // hosts register their APIs inside onSetup, so it must be ready by then.
  expect(
    sawMethodInOnSetup,
    'instance.registerSimulatorApi must exist before onSetup(instance) is called',
  ).toBe(true)
  return instance as AppInstance & WithRegisterSimulatorApi
}

/** The per-context simulator registry the instance must register into. */
function ctxRegistry(instance: AppInstance): SimulatorApiRegistry {
  const reg = (instance.context as unknown as { simulatorApis?: SimulatorApiRegistry }).simulatorApis
  expect(reg, 'ctx.simulatorApis must exist (Requirement A)').toBeDefined()
  return reg!
}

describe('Requirement B: instance.registerSimulatorApi', () => {
  it('exposes `registerSimulatorApi` as a function on the onSetup instance', async () => {
    const instance = await setupInstance()
    expect(typeof instance.registerSimulatorApi).toBe('function')
    await instance.dispose()
  })

  it('registered handler is visible in THIS context\'s registry (list + invoke)', async () => {
    const instance = await setupInstance()
    const handler = vi.fn((p: unknown) => ({ echoed: p }))

    instance.registerSimulatorApi('host.api', handler)

    const reg = ctxRegistry(instance)
    // Catches: registerSimulatorApi was a no-op, or wrote somewhere other
    // than ctx.simulatorApis (e.g. the deleted process-global).
    expect(reg.list()).toContain('host.api')

    const result = await reg.invoke('host.api', { v: 1 })
    expect(handler).toHaveBeenCalledWith({ v: 1 })
    expect(result).toEqual({ echoed: { v: 1 } })

    await instance.dispose()
  })

  it('returns a Disposable; disposing it removes the registration', async () => {
    const instance = await setupInstance()

    const disposable = instance.registerSimulatorApi('temp.api', () => 'x')
    // Catches: registerSimulatorApi returning void / a bare disposer fn.
    expect(typeof disposable?.dispose, 'registerSimulatorApi must return a Disposable').toBe('function')

    const reg = ctxRegistry(instance)
    expect(reg.list()).toContain('temp.api')

    await disposable.dispose()

    // Catches: the returned Disposable is a no-op.
    expect(reg.list()).not.toContain('temp.api')
    await expect(reg.invoke('temp.api', null)).rejects.toThrowError(/temp\.api/)

    await instance.dispose()
  })

  it('the registration is released when the context is disposed (it joins ctx.registry)', async () => {
    const instance = await setupInstance()
    const reg = ctxRegistry(instance)

    // Never call the returned disposable — context dispose alone must clean up.
    instance.registerSimulatorApi('ctx.scoped.api', () => 'y')
    expect(reg.list()).toContain('ctx.scoped.api')

    await instance.dispose()

    // Catches: registerSimulatorApi forgot to add its disposable to
    // ctx.registry, so context teardown leaves the handler dangling.
    expect(
      reg.list(),
      'context dispose must release the registerSimulatorApi registration (it must live in ctx.registry)',
    ).not.toContain('ctx.scoped.api')
  })

  it('two app instances do not share simulator APIs (per-context isolation)', async () => {
    const a = await setupInstance()
    a.registerSimulatorApi('a.only', () => 'A')

    const b = await setupInstance()

    const regA = ctxRegistry(a)
    const regB = ctxRegistry(b)

    // The bug the old process-global caused: an API registered on one app
    // leaking into a second app. Per-context kills it.
    expect(regA.list()).toContain('a.only')
    expect(regB.list()).not.toContain('a.only')

    await a.dispose()
    await b.dispose()
  })

  // ── Registry-entry leak: the returned Disposable must be the registry wrapper ─
  //
  // `instance.registerSimulatorApi` does `ctx.registry.add(disposable)` but
  // `DisposableRegistry.add()` RETURNS a wrapper — only disposing that wrapper
  // splices the entry out of `registry.entries`. If the method returns the raw
  // `disposable` instead of the wrapper, the host can dispose it (removing the
  // API) yet the dead registry entry lingers, accumulating until the whole
  // context is torn down. The fix must return the wrapper so a single dispose
  // does BOTH: remove the API AND drop the registry entry.

  it('disposing the returned Disposable drops its ctx.registry entry (no leak)', async () => {
    const instance = await setupInstance()
    const reg = ctxRegistry(instance)
    const registry = instance.context.registry as unknown as { size: number }

    // `size` is the only stable window into live registry entries — the fix
    // adds it as a readonly getter on DisposableRegistry.
    const baseline = registry.size

    const disposable = instance.registerSimulatorApi('leak.api', () => 'z')

    // Registration added exactly one live entry to ctx.registry.
    expect(
      registry.size,
      'registerSimulatorApi must add exactly one entry to ctx.registry',
    ).toBe(baseline + 1)

    await disposable.dispose()

    // The returned disposable is the registry wrapper, not the RAW
    // toDisposable(disposer): disposing it splices the entry out, so size
    // returns to baseline rather than lingering at baseline+1 as a leaked
    // dead entry.
    expect(
      registry.size,
      'disposing the returned Disposable must remove its ctx.registry entry — return the wrapper from registry.add(), not the raw disposable',
    ).toBe(baseline)

    // The dispose must ALSO release the underlying resource: the API is gone.
    // So the single dispose does both jobs.
    expect(
      reg.list(),
      'disposing the returned Disposable must also remove the simulator API',
    ).not.toContain('leak.api')

    await instance.dispose()
  })
})
