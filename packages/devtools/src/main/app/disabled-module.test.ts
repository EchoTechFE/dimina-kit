/**
 * Verifies that disabling a built-in module via `WorkbenchAppConfig.modules`
 * actually skips its `register*Ipc(ctx)` call — no channels from the disabled
 * module's namespace should appear in the set of ipcMain.handle channels.
 *
 * Mirrors the electron-stub setup used in `workbench-lifecycle.test.ts` so
 * the two tests stay aligned. Inlined rather than extracted because the
 * inline form is short and centralising the stub adds more coupling than it
 * removes for two consumers.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stubs = vi.hoisted(() => {
  type AnyFn = (...args: unknown[]) => unknown
  type EventBag = Record<string, Set<AnyFn>>

  const activeHandles = new Set<string>()
  const handleCalls: string[] = []
  const removeHandlerCalls: string[] = []
  const onCalls: string[] = []
  const removeListenerCalls: string[] = []

  function makeEmitter() {
    const listeners: EventBag = {}
    return {
      listeners,
      on(event: string, fn: AnyFn) {
        ;(listeners[event] ??= new Set()).add(fn)
        return this
      },
      once(event: string, fn: AnyFn) {
        const wrap: AnyFn = (...args: unknown[]) => {
          listeners[event]?.delete(wrap)
          return fn(...args)
        }
        ;(listeners[event] ??= new Set()).add(wrap)
        return this
      },
      off(event: string, fn: AnyFn) {
        listeners[event]?.delete(fn)
        return this
      },
      removeListener(event: string, fn: AnyFn) {
        listeners[event]?.delete(fn)
        return this
      },
      emit(event: string, ...args: unknown[]) {
        for (const fn of [...(listeners[event] ?? [])]) fn(...args)
      },
    }
  }

  function reset() {
    activeHandles.clear()
    handleCalls.length = 0
    removeHandlerCalls.length = 0
    onCalls.length = 0
    removeListenerCalls.length = 0
  }

  return {
    activeHandles,
    handleCalls,
    removeHandlerCalls,
    onCalls,
    removeListenerCalls,
    makeEmitter,
    reset,
  }
})

vi.mock('electron', () => {
  type AnyFn = (...args: unknown[]) => unknown

  const ipcEmitter = stubs.makeEmitter()
  const ipcMain = {
    ...ipcEmitter,
    handle: vi.fn((channel: string, _fn: AnyFn) => {
      if (stubs.activeHandles.has(channel)) {
        throw new Error(
          `Attempted to register a second handler for '${channel}'`,
        )
      }
      stubs.activeHandles.add(channel)
      stubs.handleCalls.push(channel)
    }),
    removeHandler: vi.fn((channel: string) => {
      stubs.activeHandles.delete(channel)
      stubs.removeHandlerCalls.push(channel)
    }),
    on: vi.fn((event: string, fn: AnyFn) => {
      stubs.onCalls.push(event)
      ipcEmitter.on(event, fn)
    }),
    removeListener: vi.fn((event: string, fn: AnyFn) => {
      stubs.removeListenerCalls.push(event)
      ipcEmitter.removeListener(event, fn)
    }),
  }

  const appEmitter = stubs.makeEmitter()
  const app = {
    ...appEmitter,
    isPackaged: true,
    whenReady: vi.fn(() => Promise.resolve()),
    getPath: vi.fn(() => '/tmp/dimina-test-userdata'),
    quit: vi.fn(),
    commandLine: {
      getSwitchValue: vi.fn(() => ''),
      appendSwitch: vi.fn(),
    },
  }

  class WebContents {
    private em = stubs.makeEmitter()
    destroyed = false
    id = Math.floor(Math.random() * 1e6)
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
    addChildView(child: View) { this.children.push(child) }
    removeChildView(child: View) {
      const i = this.children.indexOf(child)
      if (i >= 0) this.children.splice(i, 1)
    }
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
    close = vi.fn()
    destroy = vi.fn(() => { this.destroyed = true })
    loadFile = vi.fn(() => Promise.resolve())
    loadURL = vi.fn(() => Promise.resolve())
    static getAllWindows = vi.fn(() => [] as BrowserWindow[])
  }

  const sessionStub = {
    fromPartition: vi.fn(() => ({
      webRequest: {
        onBeforeSendHeaders: vi.fn(),
        onHeadersReceived: vi.fn(),
      },
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

  const nativeImage = {
    createFromPath: vi.fn(() => ({ isEmpty: () => true })),
  }

  const nativeTheme = { themeSource: 'system' }

  const globalShortcut = {
    register: vi.fn(() => false),
    unregister: vi.fn(),
    unregisterAll: vi.fn(),
  }

  const webContentsStatic = {
    fromId: vi.fn(() => null),
    getAllWebContents: vi.fn(() => [] as WebContents[]),
  }

  const Tray = vi.fn()

  return {
    app,
    ipcMain,
    BrowserWindow,
    WebContentsView,
    BrowserView: WebContentsView,
    View,
    webContents: webContentsStatic,
    session: sessionStub,
    dialog,
    Menu,
    shell,
    nativeImage,
    nativeTheme,
    globalShortcut,
    Tray,
    default: {},
  }
})

vi.mock('fs', async () => {
  const real = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...real,
    default: { ...real, watch: vi.fn() },
    watch: vi.fn(),
    realpathSync: vi.fn((p: string) => p),
  }
})

vi.mock('@dimina-kit/devkit', () => ({
  openProject: vi.fn(() => Promise.resolve({
    port: 0,
    appInfo: {},
    close: () => Promise.resolve(),
  })),
}))

import {
  ProjectsChannel,
  SettingsChannel,
  WorkbenchSettingsChannel,
} from '../../shared/ipc-channels.js'

let createWorkbenchApp: typeof import('./app.js').createWorkbenchApp

beforeEach(async () => {
  vi.resetModules()
  stubs.reset()
  ;({ createWorkbenchApp } = await import('./app.js'))
})

function channelsWithPrefix(ns: Record<string, string>): string[] {
  return Object.values(ns)
}

describe('disabled module → no IPC registration', () => {
  it('modules.projects=false skips every ProjectsChannel.* handler', async () => {
    const instance = await createWorkbenchApp({ modules: { projects: false } }).setup()
    const handled = new Set(stubs.handleCalls)

    for (const ch of channelsWithPrefix(ProjectsChannel)) {
      expect(
        handled.has(ch),
        `expected ProjectsChannel '${ch}' to NOT be registered when projects module is disabled`,
      ).toBe(false)
    }
    await instance.dispose()
  })

  it('modules.settings=false skips every WorkbenchSettingsChannel.* and SettingsChannel.* handler', async () => {
    const instance = await createWorkbenchApp({ modules: { settings: false } }).setup()
    const handled = new Set(stubs.handleCalls)

    for (const ch of channelsWithPrefix(WorkbenchSettingsChannel)) {
      expect(
        handled.has(ch),
        `expected WorkbenchSettingsChannel '${ch}' to NOT be registered when settings module is disabled`,
      ).toBe(false)
    }
    for (const ch of channelsWithPrefix(SettingsChannel)) {
      expect(
        handled.has(ch),
        `expected SettingsChannel '${ch}' to NOT be registered when settings module is disabled`,
      ).toBe(false)
    }
    await instance.dispose()
  })

  it('default config (no modules override) registers ProjectsChannel.List as a sanity check', async () => {
    const instance = await createWorkbenchApp({}).setup()
    const handled = new Set(stubs.handleCalls)
    expect(handled.has(ProjectsChannel.List)).toBe(true)
    expect(handled.has(WorkbenchSettingsChannel.Get)).toBe(true)
    await instance.dispose()
  })
})
