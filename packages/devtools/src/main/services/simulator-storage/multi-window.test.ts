/**
 * Multi-window ownership regression for `setupSimulatorStorage`.
 *
 * One instance runs per project `BrowserWindow`, but the underlying
 * `webContents`/`app.on('web-contents-created')` APIs are process-global.
 * Without a per-window ownership check, whichever instance's scan or
 * `did-finish-load` callback fires first attaches to ANY simulator webview
 * in the process — so opening a second project window can steal the first
 * window's simulator, and the first window's Storage panel starts reading
 * and writing the second project's partition.
 *
 * Pinned invariant: window A's storage service only ever attaches to a
 * simulator webview that belongs to window A. Window B's simulator
 * finishing load must not cause A to detach from its own simulator, even
 * though both instances share the same global `web-contents-created` event.
 *
 * The CDP debugger 'message' listener count is used as the attach signal
 * (same approach as reattach.test.ts): `attachToSim` registers exactly one
 * on the wc it captures, and `detachFromSim` removes it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (...args: unknown[]) => unknown

const stub = vi.hoisted(() => {
  const ipcHandlers = new Map<string, Handler>()
  const appListeners = new Map<string, Set<Handler>>()
  const wcRegistry: unknown[] = []

  const ipcMainStub = {
    handle: vi.fn((channel: string, fn: Handler) => { ipcHandlers.set(channel, fn) }),
    removeHandler: vi.fn((channel: string) => { ipcHandlers.delete(channel) }),
  }
  const appStub = {
    on: vi.fn((event: string, fn: Handler) => {
      if (!appListeners.has(event)) appListeners.set(event, new Set())
      appListeners.get(event)!.add(fn)
    }),
    removeListener: vi.fn((event: string, fn: Handler) => {
      appListeners.get(event)?.delete(fn)
    }),
  }
  const webContentsStub = { getAllWebContents: vi.fn(() => wcRegistry) }

  return { ipcHandlers, appListeners, wcRegistry, ipcMainStub, appStub, webContentsStub }
})

vi.mock('electron', () => ({
  app: stub.appStub,
  ipcMain: stub.ipcMainStub,
  webContents: stub.webContentsStub,
  BrowserWindow: class {},
  shell: { openPath: vi.fn() },
  nativeImage: { createFromPath: vi.fn(() => ({})) },
}))

import { setupSimulatorStorage } from './index.js'

interface SimWc {
  id: number
  destroyed: boolean
  isDestroyed: () => boolean
  getType: () => string
  getURL: () => string
  hostWebContents: HostWc
  executeJavaScript: ReturnType<typeof vi.fn>
  _wcListeners: Map<string, Handler[]>
  on: (event: string, fn: Handler) => void
  once: (event: string, fn: Handler) => void
  removeListener: (event: string, fn: Handler) => void
  emit: (event: string, ...args: unknown[]) => void
  debugger: {
    attached: boolean
    attach: ReturnType<typeof vi.fn>
    detach: ReturnType<typeof vi.fn>
    isAttached: () => boolean
    sendCommand: ReturnType<typeof vi.fn>
    _dbgListeners: Map<string, Handler[]>
    on: (event: string, fn: Handler) => void
    removeListener: (event: string, fn: Handler) => void
  }
}

interface HostWc {
  id: number
  isDestroyed: () => boolean
  send: ReturnType<typeof vi.fn>
}

interface FakeWin {
  id: number
  webContents: HostWc
  contentView: { children: unknown[] }
  isDestroyed: () => boolean
}

let nextId = 1

function makeHostWc(): HostWc {
  return { id: nextId++, isDestroyed: () => false, send: vi.fn() }
}

function makeWin(webContents: HostWc): FakeWin {
  return { id: nextId++, webContents, contentView: { children: [] }, isDestroyed: () => false }
}

/** A simulator `<webview>` guest embedded in `hostWc`'s page. */
function makeSimWc(hostWebContents: HostWc): SimWc {
  const wc: SimWc = {
    id: nextId++,
    destroyed: false,
    isDestroyed() { return this.destroyed },
    getType: () => 'webview',
    getURL: () => 'http://localhost/simulator.html',
    hostWebContents,
    executeJavaScript: vi.fn(() => Promise.resolve('http://localhost')),
    _wcListeners: new Map(),
    on(event, fn) {
      const arr = this._wcListeners.get(event) ?? []
      arr.push(fn)
      this._wcListeners.set(event, arr)
    },
    once(event, fn) {
      const wrap: Handler = (...args) => {
        this.removeListener(event, wrap)
        fn(...args)
      }
      this.on(event, wrap)
    },
    removeListener(event, fn) {
      const arr = this._wcListeners.get(event)
      if (!arr) return
      const idx = arr.indexOf(fn)
      if (idx >= 0) arr.splice(idx, 1)
    },
    emit(event, ...args) {
      const arr = this._wcListeners.get(event) ?? []
      for (const fn of [...arr]) fn(...args)
    },
    debugger: {
      attached: false,
      attach: vi.fn(),
      detach: vi.fn(),
      isAttached() { return this.attached },
      sendCommand: vi.fn(() => Promise.resolve({ entries: [] })),
      _dbgListeners: new Map(),
      on(event, fn) {
        const arr = this._dbgListeners.get(event) ?? []
        arr.push(fn)
        this._dbgListeners.set(event, arr)
      },
      removeListener(event, fn) {
        const arr = this._dbgListeners.get(event)
        if (!arr) return
        const idx = arr.indexOf(fn)
        if (idx >= 0) arr.splice(idx, 1)
      },
    },
  }
  wc.debugger.attach = vi.fn(() => { wc.debugger.attached = true }) as never
  wc.debugger.detach = vi.fn(() => { wc.debugger.attached = false }) as never
  return wc
}

function dbgMessageListenerCount(wc: SimWc): number {
  return (wc.debugger._dbgListeners.get('message') ?? []).length
}

function allWcCreatedListeners(): Handler[] {
  return Array.from(stub.appListeners.get('web-contents-created') ?? [])
}

beforeEach(() => {
  nextId = 1
  stub.ipcHandlers.clear()
  stub.appListeners.clear()
  stub.wcRegistry.length = 0
  stub.ipcMainStub.handle.mockClear()
  stub.ipcMainStub.removeHandler.mockClear()
  stub.appStub.on.mockClear()
  stub.appStub.removeListener.mockClear()
  stub.webContentsStub.getAllWebContents.mockClear()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('setupSimulatorStorage — per-window simulator ownership', () => {
  it('window B finishing load does not steal window A\'s already-attached simulator', async () => {
    const hostA = makeHostWc()
    const winA = makeWin(hostA)
    const simA = makeSimWc(hostA)
    stub.wcRegistry.push(simA)

    const svcA = setupSimulatorStorage(hostA as unknown as Electron.WebContents, {
      getActiveAppId: () => 'wxA',
      window: winA as unknown as Electron.BrowserWindow,
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(dbgMessageListenerCount(simA)).toBe(1)

    const hostB = makeHostWc()
    const winB = makeWin(hostB)
    const svcB = setupSimulatorStorage(hostB as unknown as Electron.WebContents, {
      getActiveAppId: () => 'wxB',
      window: winB as unknown as Electron.BrowserWindow,
    })

    // Window B opens its project: its simulator webview is created and
    // finishes loading. BOTH svcA's and svcB's global 'web-contents-created'
    // listeners observe it (that's the process-global API this test guards
    // against) — only svcB may attach.
    const simB = makeSimWc(hostB)
    for (const onCreated of allWcCreatedListeners()) onCreated({}, simB)
    simB.emit('did-finish-load')
    await Promise.resolve()
    await Promise.resolve()

    expect(dbgMessageListenerCount(simB)).toBe(1)
    // A's simulator must still carry its OWN attach — untouched by B's load.
    expect(dbgMessageListenerCount(simA)).toBe(1)

    await svcA.dispose()
    await svcB.dispose()
  })

  it('initial scan only attaches to the simulator inside the given window, even when the other window\'s webview is listed first', async () => {
    const hostA = makeHostWc()
    const winA = makeWin(hostA)
    const simA = makeSimWc(hostA)

    const hostB = makeHostWc()
    const simB = makeSimWc(hostB)

    // B's webview registered before A's in the process-global registry.
    stub.wcRegistry.push(simB, simA)

    const svcA = setupSimulatorStorage(hostA as unknown as Electron.WebContents, {
      getActiveAppId: () => 'wxA',
      window: winA as unknown as Electron.BrowserWindow,
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(dbgMessageListenerCount(simA)).toBe(1)
    expect(dbgMessageListenerCount(simB)).toBe(0)

    await svcA.dispose()
  })
})
