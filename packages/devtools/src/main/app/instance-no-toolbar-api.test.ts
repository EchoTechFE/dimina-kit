/**
 * `instance.toolbar` is deleted (breaking change). The host-injected
 * toolbar-button mechanism
 * (`instance.toolbar.set(actions)` → 'toolbar:getActions' / 'toolbar:invoke'
 * IPC → ProjectToolbar host-actions row) goes away as a whole cluster.
 *
 * Real bug each test catches:
 *  - "'toolbar' not in instance" (an `in` check, NOT `toBeUndefined`):
 *    catches a left-behind shell (`toolbar: undefined` or a `{ set }` that
 *    silently no-ops) — a present key invites hosts to keep calling a dead
 *    surface instead of failing fast at the property access.
 *  - "'toolbar' not in instance.context": catches a leftover
 *    `createToolbarStore()` assignment — a dead store that retains
 *    host-provided handler closures for the context lifetime and invites the
 *    cluster to grow back.
 *  - wire checks at the FULL-APP level: catches a re-registration anywhere
 *    in app boot (e.g. via the host `instance.ipc` plumbing or a module that
 *    simulator-module-toolbar-eval-decommission.test.ts's narrower seam
 *    doesn't see).
 *  - survivor pins: catches over-deletion — `registerSimulatorApi` (custom
 *    APIs, e2e-driven 'simulator:custom-apis:invoke') is adjacent code in
 *    app.ts and MUST keep working.
 *
 * Wire names are STRING LITERALS so the file still compiles after the
 * ToolbarChannel enum is deleted.
 *
 * Seam: identical to `instance-simulator-api.test.ts` — there is no
 * standalone factory for `WorkbenchAppInstance`; we drive
 * `createDevtoolsRuntime()` under an exhaustive electron mock and capture the
 * instance from `onSetup`.
 *
 * Guards the decommission: app.ts must NOT build `toolbar: { set: … }` onto
 * the instance, createWorkbenchContext must NOT assign
 * `ctx.toolbar = createToolbarStore()`, and registerToolbarIpc must NOT
 * register either wire channel.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── electron stub: records ipcMain.handle/on channels ───────────────────────
const stubs = vi.hoisted(() => {
  type AnyFn = (...args: unknown[]) => unknown
  type EventBag = Record<string, Set<AnyFn>>

  const ipcHandlers = new Map<string, AnyFn>()
  const ipcOnChannels = new Set<string>()

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
    ipcOnChannels.clear()
  }

  return { ipcHandlers, ipcOnChannels, makeEmitter, reset }
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
    }),
    on: vi.fn((event: string, fn: AnyFn) => {
      stubs.ipcOnChannels.add(event)
      ipcEmitter.on(event, fn)
    }),
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

type AppInstance = import('./app.js').WorkbenchAppInstance

/** True when the channel is reachable on the wire by EITHER mechanism. */
function wireRegistered(channel: string): boolean {
  return stubs.ipcHandlers.has(channel) || stubs.ipcOnChannels.has(channel)
}

/**
 * Drives `createDevtoolsRuntime` and captures the instance from `onSetup` —
 * the exact moment a downstream host would touch `instance.toolbar`, so a
 * toolbar bolted on AFTER onSetup is caught too.
 */
async function setupInstance(): Promise<{ instance: AppInstance; toolbarKeyInOnSetup: boolean }> {
  let toolbarKeyInOnSetup = true
  let captured: AppInstance | undefined
  const instance = await createDevtoolsRuntime({
    onSetup(inst) {
      captured = inst as AppInstance
      toolbarKeyInOnSetup = 'toolbar' in (inst as unknown as Record<string, unknown>)
    },
  })
  expect(captured, 'onSetup must receive the WorkbenchAppInstance').toBeDefined()
  expect(captured).toBe(instance)
  return { instance, toolbarKeyInOnSetup }
}

describe('instance.toolbar decommission (host API surface)', () => {
  it("the onSetup instance carries NO 'toolbar' key (not even a shell)", async () => {
    const { instance, toolbarKeyInOnSetup } = await setupInstance()
    expect(
      toolbarKeyInOnSetup,
      "host-injected toolbar buttons are removed — a present `toolbar` key (even `undefined` or a no-op `{ set }`) lets hosts keep calling a dead surface instead of failing fast",
    ).toBe(false)
    expect('toolbar' in (instance as unknown as Record<string, unknown>)).toBe(false)
    await instance.dispose()
  })

  it("the context carries NO 'toolbar' key (no orphaned ToolbarStore)", async () => {
    const { instance } = await setupInstance()
    expect(
      'toolbar' in (instance.context as unknown as Record<string, unknown>),
      'a leftover createToolbarStore() on the context is a dead store that pins host handler closures for the context lifetime and invites the cluster to grow back',
    ).toBe(false)
    await instance.dispose()
  })

  it("no registrar anywhere in app boot registers 'toolbar:getActions' / 'toolbar:invoke'", async () => {
    const { instance } = await setupInstance()
    expect(
      wireRegistered('toolbar:getActions'),
      'full-app check: toolbar:getActions must not be answerable on the wire after boot — narrower module tests cannot see a re-registration from another registrar',
    ).toBe(false)
    expect(wireRegistered('toolbar:invoke')).toBe(false)
    await instance.dispose()
  })

  it("no registrar anywhere in app boot registers 'panel:eval'", async () => {
    const { instance } = await setupInstance()
    expect(
      wireRegistered('panel:eval'),
      'panel:eval (arbitrary executeJavaScript into the simulator WCV) is decommissioned — a leftover handler keeps the eval primitive open to every trusted sender',
    ).toBe(false)
    await instance.dispose()
  })

  it('survivor pin: registerSimulatorApi keeps working (custom API mechanism is NOT part of the removal)', async () => {
    const { instance } = await setupInstance()
    // Adjacent code in app.ts — catches over-deletion while excising toolbar.
    expect(typeof instance.registerSimulatorApi).toBe('function')
    const d = instance.registerSimulatorApi('e2eProbe', () => ({ ok: true }))
    expect(typeof d.dispose).toBe('function')
    expect(
      stubs.ipcHandlers.has('simulator:custom-apis:invoke'),
      'the custom-apis invoke channel must stay registered (e2e drives it via e2eEcho)',
    ).toBe(true)
    await instance.dispose()
  })
})
