/**
 * Step 4 of the devtools extension model — "toolbar 合一".
 *
 * `docs/extension-model.md` §3.3 / §4 / step 4: the split toolbar surface
 * (`WorkbenchConfig.toolbarActions` for the *list* + bare `toolbar:action:*`
 * dynamic channels for the *behavior*) is merged into a single
 * `instance.toolbar.set(actions)`.
 *
 * This suite pins down Requirement A — `instance.toolbar`:
 *
 *  - `WorkbenchHostInstance` / `WorkbenchAppInstance` grow a
 *    `readonly toolbar: { set(actions: ToolbarActionInput[]): void }`.
 *  - `toolbar.set(actions)` is an ATOMIC whole-table replace: it validates
 *    that every `id` is unique (duplicate id → throw), stores the batch on
 *    THIS context, and notifies the renderer (fires
 *    `ToolbarChannel.ActionsChanged`). A second `set` fully replaces the
 *    first — no stale actions linger.
 *  - `instance.toolbar` must be present on the instance BEFORE
 *    `onSetup(instance)` runs (hosts call `instance.toolbar.set()` inside
 *    onSetup).
 *
 * Every assertion is RED until step 4 lands: `instance.toolbar` does not
 * exist yet. Failures must point at the missing surface / missing wiring,
 * not at a broken harness.
 *
 * Seam: identical to `instance-ipc-extension.test.ts` /
 * `instance-simulator-api.test.ts` — there is no standalone factory for
 * `WorkbenchAppInstance`; the object is built inline inside
 * `createWorkbenchApp().setup()`. We drive the full app under an exhaustive
 * electron mock and capture the instance from the `onSetup` hook.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── electron stub: records ipcMain.handle + main-window webContents.send ─────
const stubs = vi.hoisted(() => {
  type AnyFn = (...args: unknown[]) => unknown
  type EventBag = Record<string, Set<AnyFn>>

  const ipcHandlers = new Map<string, AnyFn>()
  const removeHandlerCalls: string[] = []
  // every (channel, ...args) passed to a webContents.send, in order.
  const sendCalls: Array<{ channel: string; args: unknown[] }> = []

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
    sendCalls.length = 0
  }

  return { ipcHandlers, removeHandlerCalls, sendCalls, makeEmitter, reset }
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
    // Record every send so a test can prove the toolbar change notification
    // reached the main-window renderer.
    send = vi.fn((channel: string, ...args: unknown[]) => {
      stubs.sendCalls.push({ channel, args })
    })
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
  const nativeImage = { createFromPath: vi.fn(() => ({ isEmpty: () => true })) }
  const nativeTheme = { ...stubs.makeEmitter(), themeSource: 'system' }
  const globalShortcut = { register: vi.fn(() => false), unregister: vi.fn(), unregisterAll: vi.fn() }
  const webContentsStatic = { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) }
  const Tray = vi.fn()

  return {
    app, ipcMain, BrowserWindow, WebContentsView, BrowserView: WebContentsView, View,
    webContents: webContentsStatic, session: sessionStub, dialog, Menu, shell,
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
let ToolbarChannel: typeof import('../../shared/ipc-channels.js').ToolbarChannel

beforeEach(async () => {
  vi.resetModules()
  stubs.reset()
  ;({ createWorkbenchApp } = await import('./app.js'))
  ;({ ToolbarChannel } = await import('../../shared/ipc-channels.js'))
})

type AppInstance = import('./app.js').WorkbenchAppInstance
/** host-facing input action shape (id + label + handler). */
type ToolbarActionInput = { id: string; label: string; handler: () => void | Promise<void> }
/** The extra surface this suite asserts onto the instance. */
type WithToolbar = { toolbar: { set(actions: ToolbarActionInput[]): void } }

/**
 * Drives `createWorkbenchApp` and returns the `WorkbenchAppInstance` captured
 * from `onSetup`. Also asserts the instance carries `toolbar` AT `onSetup`
 * time — hosts call `instance.toolbar.set()` inside the hook, so it must be
 * ready before the hook runs.
 */
async function setupInstance(): Promise<AppInstance & WithToolbar> {
  let sawToolbarInOnSetup = false
  let captured: AppInstance | undefined
  const instance = await createWorkbenchApp({
    onSetup(inst) {
      captured = inst as AppInstance
      const t = (inst as unknown as Partial<WithToolbar>).toolbar
      sawToolbarInOnSetup = !!t && typeof t.set === 'function'
    },
  }).setup()

  expect(captured, 'onSetup must receive the WorkbenchAppInstance').toBeDefined()
  expect(captured).toBe(instance)
  // Catches a `toolbar` bolted on AFTER onSetup runs.
  expect(
    sawToolbarInOnSetup,
    'instance.toolbar.set must exist before onSetup(instance) is called',
  ).toBe(true)
  return instance as AppInstance & WithToolbar
}

/** Read the per-context toolbar `{id,label}` projection via the GetActions IPC. */
async function getActionsViaIpc(instance: AppInstance): Promise<Array<{ id: string; label: string }>> {
  const handler = stubs.ipcHandlers.get(ToolbarChannel.GetActions)
  expect(handler, 'GetActions handler must be registered by the toolbar module').toBeDefined()
  const mainSender = instance.mainWindow.webContents
  return (await handler!({ sender: mainSender })) as Array<{ id: string; label: string }>
}

describe('Requirement A: instance.toolbar.set', () => {
  it('exposes `toolbar` with a `set` method on the onSetup instance', async () => {
    const instance = await setupInstance()
    const toolbar = (instance as unknown as { toolbar?: { set?: unknown } }).toolbar
    // Catches "instance.toolbar was never added".
    expect(toolbar, 'expected instance.toolbar to be defined').toBeDefined()
    // Catches "toolbar is an ad-hoc object without set()".
    expect(typeof toolbar!.set).toBe('function')
    await instance.dispose()
  })

  it('set([{id,label,handler}]) stores the batch on the context (visible via GetActions)', async () => {
    const instance = await setupInstance()

    instance.toolbar.set([
      { id: 'login', label: '登录', handler: vi.fn() },
      { id: 'logout', label: '注销', handler: vi.fn() },
    ])

    // The GetActions handler must surface exactly what was just set.
    const actions = await getActionsViaIpc(instance)
    expect(actions).toEqual([
      { id: 'login', label: '登录' },
      { id: 'logout', label: '注销' },
    ])

    await instance.dispose()
  })

  it('throws when the same id appears twice in a single set() call', async () => {
    const instance = await setupInstance()

    // Duplicate id is a host bug — set() must reject the whole batch atomically.
    expect(() =>
      instance.toolbar.set([
        { id: 'dup', label: 'A', handler: vi.fn() },
        { id: 'dup', label: 'B', handler: vi.fn() },
      ]),
    ).toThrow()

    // Atomic: the rejected batch must NOT have been partially applied.
    const actions = await getActionsViaIpc(instance)
    expect(actions, 'a rejected set() must leave the toolbar unchanged').toEqual([])

    await instance.dispose()
  })

  it('a second set() fully replaces the first — no stale actions linger', async () => {
    const instance = await setupInstance()

    instance.toolbar.set([
      { id: 'a', label: 'A', handler: vi.fn() },
      { id: 'b', label: 'B', handler: vi.fn() },
    ])
    expect(await getActionsViaIpc(instance)).toEqual([
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ])

    // Whole-table replace: 'a'/'b' must be gone, only 'c' remains.
    instance.toolbar.set([{ id: 'c', label: 'C', handler: vi.fn() }])
    expect(
      await getActionsViaIpc(instance),
      'set() must atomically replace the whole table, not merge',
    ).toEqual([{ id: 'c', label: 'C' }])

    await instance.dispose()
  })

  it('set([]) clears the toolbar', async () => {
    const instance = await setupInstance()

    instance.toolbar.set([{ id: 'x', label: 'X', handler: vi.fn() }])
    expect(await getActionsViaIpc(instance)).toEqual([{ id: 'x', label: 'X' }])

    instance.toolbar.set([])
    expect(await getActionsViaIpc(instance)).toEqual([])

    await instance.dispose()
  })

  it('set() notifies the renderer — fires ToolbarChannel.ActionsChanged on the main window', async () => {
    const instance = await setupInstance()

    const before = stubs.sendCalls.filter((c) => c.channel === ToolbarChannel.ActionsChanged).length

    instance.toolbar.set([{ id: 'n', label: 'N', handler: vi.fn() }])

    const after = stubs.sendCalls.filter((c) => c.channel === ToolbarChannel.ActionsChanged).length
    // Without the notify call the renderer never re-fetches and the new
    // toolbar silently never appears.
    expect(
      after - before,
      'set() must send ToolbarChannel.ActionsChanged to the renderer',
    ).toBeGreaterThanOrEqual(1)

    await instance.dispose()
  })

  it('a rejected (duplicate-id) set() does NOT notify the renderer', async () => {
    const instance = await setupInstance()

    const before = stubs.sendCalls.filter((c) => c.channel === ToolbarChannel.ActionsChanged).length

    expect(() =>
      instance.toolbar.set([
        { id: 'same', label: 'A', handler: vi.fn() },
        { id: 'same', label: 'B', handler: vi.fn() },
      ]),
    ).toThrow()

    const after = stubs.sendCalls.filter((c) => c.channel === ToolbarChannel.ActionsChanged).length
    // A throw must short-circuit before the notify — no phantom "changed".
    expect(
      after,
      'a rejected set() must not emit ActionsChanged',
    ).toBe(before)

    await instance.dispose()
  })
})
