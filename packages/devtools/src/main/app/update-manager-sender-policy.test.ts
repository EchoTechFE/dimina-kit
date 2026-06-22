/**
 * Requirement C — `createDevtoolsRuntime` must pass `context.senderPolicy` into
 * the `UpdateManager` it constructs (app.ts ~line 261).
 *
 * `UpdateManagerOptions` already has an optional `senderPolicy`, and
 * `UpdateManager` already forwards it to its internal `IpcRegistry`. The
 * defect is purely the *wiring*: `app.ts` builds `new UpdateManager({...})`
 * WITHOUT `senderPolicy`, so the `updates:check` / `updates:download` /
 * `updates:install` handlers are ungated — a hostile/untrusted WebContents
 * can invoke them while every other workbench built-in is gated. That is a
 * security hole (`install` calls `shell.openPath` + `app.quit`).
 *
 * The primary test drives the real behavior: build the app with an
 * `updateChecker`, then invoke a registered `updates:*` handler with an
 * untrusted sender and assert it is rejected (the IpcRegistry sender gate
 * throws `IPC sender rejected for channel updates:*`). This guards that the
 * policy is wired: without it the handler would run ungated and resolve
 * normally for any sender.
 *
 * `UpdateChannel.*` values are imported from the real channels module so a
 * channel rename can't silently pass the test.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── electron stub: records ipcMain.handle channel → guarded fn ──────────────
const stubs = vi.hoisted(() => {
  type AnyFn = (...args: unknown[]) => unknown
  type EventBag = Record<string, Set<AnyFn>>

  // channel → the (guarded) function actually registered by IpcRegistry.
  const ipcHandlers = new Map<string, AnyFn>()

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

  function reset() { ipcHandlers.clear() }

  return { ipcHandlers, makeEmitter, reset }
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
    close = vi.fn()
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

import { UpdateChannel } from '../../shared/ipc-channels.js'
import type { UpdateChecker } from '../../shared/types.js'

let createDevtoolsRuntime: typeof import('./app.js').createDevtoolsRuntime

beforeEach(async () => {
  vi.resetModules()
  stubs.reset()
  ;({ createDevtoolsRuntime } = await import('./app.js'))
})

function makeChecker(): UpdateChecker {
  return {
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => '/tmp/fake.dmg'),
  }
}

/** A WebContents-shaped object the workbench sender-policy will NOT trust. */
function untrustedSender() {
  return { id: 999_999, isDestroyed: () => false, getURL: () => 'https://evil.example' }
}

const UPDATE_CHANNELS = [UpdateChannel.Check, UpdateChannel.Download, UpdateChannel.Install]

describe('Requirement C: app wires senderPolicy into UpdateManager', () => {
  it('registers all three updates:* handlers when an updateChecker is provided', async () => {
    const instance = await createDevtoolsRuntime({ updateChecker: makeChecker() })
    for (const ch of UPDATE_CHANNELS) {
      expect(
        stubs.ipcHandlers.has(ch),
        `expected '${ch}' handler to be registered`,
      ).toBe(true)
    }
    await instance.dispose()
  })

  it('updates:check rejects an untrusted sender (handler must be sender-gated)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const instance = await createDevtoolsRuntime({ updateChecker: makeChecker() })

    const handler = stubs.ipcHandlers.get(UpdateChannel.Check)
    expect(handler, 'updates:check handler must be registered').toBeDefined()

    // With the senderPolicy correctly threaded through, the IpcRegistry gate
    // throws for an untrusted sender. Without it (today's bug) the handler
    // runs ungated and resolves to `{ hasUpdate: false }`.
    await expect(
      Promise.resolve(handler!({ sender: untrustedSender() })),
    ).rejects.toThrow(/IPC sender rejected for channel updates:check/)

    warnSpy.mockRestore()
    await instance.dispose()
  })

  it('updates:download and updates:install also reject an untrusted sender', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const instance = await createDevtoolsRuntime({ updateChecker: makeChecker() })

    for (const ch of [UpdateChannel.Download, UpdateChannel.Install]) {
      const handler = stubs.ipcHandlers.get(ch)
      expect(handler, `${ch} handler must be registered`).toBeDefined()
      await expect(
        Promise.resolve(handler!({ sender: untrustedSender() })),
        `${ch} must reject an untrusted sender`,
      ).rejects.toThrow(new RegExp(`IPC sender rejected for channel ${ch}`))
    }

    warnSpy.mockRestore()
    await instance.dispose()
  })
})
