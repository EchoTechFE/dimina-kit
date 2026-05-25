/**
 * Step 6 of the devtools extension model — "收尾", Requirement B, RUNTIME half.
 *
 * `src/shared/menu-builder-context-narrowed.test.ts` proves the `menuBuilder`
 * hook's `context` parameter is narrowed to `MenuContext` at COMPILE time
 * (via `@ts-expect-error` / `Expect<Equal<…>>`). But a compile-time type
 * narrowing says nothing about the OBJECT actually passed at runtime: a
 * `Parameters<…>` extraction reflects the declared signature, while
 * `installMenu` can still hand `config.menuBuilder` the full
 * `WorkbenchContext` value.
 *
 * This suite closes that gap. It drives a real app through `createWorkbenchApp`
 * (same exhaustive electron mock + `onSetup`-style capture seam as
 * `instance-ipc-extension.test.ts`), passes a host `menuBuilder`, and
 * inspects the *value* it receives:
 *
 *  - the runtime object MUST NOT carry the five internal-pipeline fields
 *    (`registry` / `senderPolicy` / `trustedWindowSenderIds` /
 *    `simulatorApis` / `toolbar`) — those are what `MenuContext` omits;
 *  - the runtime object MUST still carry the menu-relevant fields
 *    (`workspace` / `views`) a host menu builder legitimately reads.
 *
 * RED TODAY: `installMenu` in `app.ts` does `config.menuBuilder(mainWindow,
 * context)` — it passes the full `WorkbenchContext`, so `'registry' in
 * captured` is `true`. The fix is to hand `menuBuilder` a narrowed value.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── electron stub: minimal but exhaustive enough to boot createWorkbenchApp ──
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

/**
 * Drives `createWorkbenchApp` with a host `menuBuilder` and returns the
 * runtime `context` value that `installMenu` actually handed to it.
 */
async function captureMenuContext(): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined
  const instance = await createWorkbenchApp({
    menuBuilder: (_mainWindow, menuContext) => {
      captured = menuContext as unknown as Record<string, unknown>
    },
  }).setup()

  expect(captured, 'menuBuilder must be invoked with the runtime menu context').toBeDefined()
  await instance.dispose()
  return captured!
}

describe('Requirement B (runtime): menuBuilder receives the narrowed MenuContext value', () => {
  it('the runtime object does NOT carry the five internal-pipeline fields', async () => {
    const captured = await captureMenuContext()

    // RED TODAY: `installMenu` passes the full `WorkbenchContext`, so every
    // one of these is still present on the runtime object. The narrowing is
    // purely type-level until `installMenu` hands `menuBuilder` a value with
    // the internal plumbing stripped.
    expect('registry' in captured, 'menuBuilder must not receive ctx.registry').toBe(false)
    expect('senderPolicy' in captured, 'menuBuilder must not receive ctx.senderPolicy').toBe(false)
    expect(
      'trustedWindowSenderIds' in captured,
      'menuBuilder must not receive ctx.trustedWindowSenderIds',
    ).toBe(false)
    expect('simulatorApis' in captured, 'menuBuilder must not receive ctx.simulatorApis').toBe(false)
    expect('toolbar' in captured, 'menuBuilder must not receive ctx.toolbar').toBe(false)
  })

  it('the runtime object still carries the menu-relevant fields', async () => {
    const captured = await captureMenuContext()

    // The narrowing must keep the fields a host menu builder legitimately
    // reads — stripping these too would break the hook.
    expect(captured.workspace, 'menuBuilder needs ctx.workspace').toBeDefined()
    expect(captured.views, 'menuBuilder needs ctx.views').toBeDefined()
  })
})
