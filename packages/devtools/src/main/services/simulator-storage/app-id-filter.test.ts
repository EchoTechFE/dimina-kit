/**
 * Per-appId filter regression for `setupSimulatorStorage`.
 *
 * The simulator BrowserView reuses a fixed `persist:simulator` partition
 * + fixed simulator.html origin across project switches, so the underlying
 * localStorage accumulates keys from every project ever run. The dimina
 * runtime isolates writes by prefixing keys with `${appId}_`; this test
 * pins that the storage watcher applies the matching read-side filter.
 *
 * Verified contracts:
 *   - `getSnapshot()` returns only entries whose key starts with
 *     `${activeAppId}_` when `getActiveAppId` is wired.
 *   - When `getActiveAppId` returns null (no active session), filtering is
 *     skipped and every entry is forwarded — the documented fallback so a
 *     misconfigured callback can never silently empty the panel.
 *   - Forwarded CDP `domStorageItem*` events are filtered with the same
 *     prefix rule before being emitted to the renderer host.
 *   - `DOMStorage.domStorageItemsCleared` always forwards unfiltered
 *     (documented: only fires on origin-wide `localStorage.clear()`).
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

import { SimulatorStorageChannel, type StorageItem } from '../../../shared/ipc-channels.js'
import { setupSimulatorStorage } from './index.js'

interface SimWc {
  destroyed: boolean
  isDestroyed: () => boolean
  getType: () => string
  getURL: () => string
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
    emit: (event: string, ...args: unknown[]) => void
  }
}

function makeSimWc(entries: Array<[string, string]> = []): SimWc {
  const wc: SimWc = {
    destroyed: false,
    isDestroyed() { return this.destroyed },
    getType: () => 'webview',
    getURL: () => 'http://localhost/simulator.html',
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
      sendCommand: vi.fn((method: string) => {
        if (method === 'DOMStorage.getDOMStorageItems') {
          return Promise.resolve({ entries })
        }
        return Promise.resolve({})
      }),
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
      emit(event, ...args) {
        const arr = this._dbgListeners.get(event) ?? []
        for (const fn of [...arr]) fn(...args)
      },
    },
  }
  wc.debugger.attach = vi.fn(() => { wc.debugger.attached = true }) as never
  wc.debugger.detach = vi.fn(() => { wc.debugger.attached = false }) as never
  return wc
}

function makeHost() {
  return {
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  } as unknown as Electron.WebContents & { send: ReturnType<typeof vi.fn> }
}

function getSnapshotHandler(): () => Promise<StorageItem[]> {
  const fn = stub.ipcHandlers.get(SimulatorStorageChannel.GetSnapshot)
  expect(fn).toBeTruthy()
  return fn as () => Promise<StorageItem[]>
}

beforeEach(() => {
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

describe('setupSimulatorStorage — getActiveAppId filter', () => {
  it('getSnapshot returns only entries with the active `${appId}_` prefix', async () => {
    const wc = makeSimWc([
      ['wx123_foo', '1'],
      ['wx999_bar', '2'],
      ['wx123_baz', '3'],
      ['unprefixed', '4'],
    ])
    stub.wcRegistry.push(wc)

    const d = setupSimulatorStorage(makeHost(), {
      getActiveAppId: () => 'wx123',
    })
    // Let attach + DOMStorage.enable settle.
    await Promise.resolve()
    await Promise.resolve()

    const snapshot = await getSnapshotHandler()()
    expect(snapshot).toEqual([
      { key: 'wx123_foo', value: '1' },
      { key: 'wx123_baz', value: '3' },
    ])

    await d.dispose()
  })

  it('getSnapshot returns every entry when getActiveAppId returns null', async () => {
    const wc = makeSimWc([
      ['wx123_foo', '1'],
      ['wx999_bar', '2'],
    ])
    stub.wcRegistry.push(wc)

    const d = setupSimulatorStorage(makeHost(), {
      getActiveAppId: () => null,
    })
    await Promise.resolve()
    await Promise.resolve()

    const snapshot = await getSnapshotHandler()()
    expect(snapshot).toEqual([
      { key: 'wx123_foo', value: '1' },
      { key: 'wx999_bar', value: '2' },
    ])

    await d.dispose()
  })

  it('forwarded CDP events drop keys outside the active prefix', async () => {
    const wc = makeSimWc()
    stub.wcRegistry.push(wc)
    const host = makeHost()

    const d = setupSimulatorStorage(host, {
      getActiveAppId: () => 'wx123',
    })
    await Promise.resolve()
    await Promise.resolve()

    // Sanity: the attach loop wired exactly one debugger message listener.
    const listeners = wc.debugger._dbgListeners.get('message') ?? []
    expect(listeners.length).toBe(1)

    // Active appId key → forwarded.
    wc.debugger.emit('message', {}, 'DOMStorage.domStorageItemAdded', {
      key: 'wx123_x',
      newValue: 'v1',
    })
    // Foreign appId key → dropped.
    wc.debugger.emit('message', {}, 'DOMStorage.domStorageItemAdded', {
      key: 'wx999_y',
      newValue: 'v2',
    })
    // Update + remove on foreign key → also dropped.
    wc.debugger.emit('message', {}, 'DOMStorage.domStorageItemUpdated', {
      key: 'wx999_y',
      oldValue: 'v2',
      newValue: 'v3',
    })
    wc.debugger.emit('message', {}, 'DOMStorage.domStorageItemRemoved', {
      key: 'wx999_y',
    })
    // Active appId remove → forwarded.
    wc.debugger.emit('message', {}, 'DOMStorage.domStorageItemRemoved', {
      key: 'wx123_x',
    })

    const sendMock = (host as unknown as { send: ReturnType<typeof vi.fn> }).send
    const calls = sendMock.mock.calls.filter(
      (c) => c[0] === SimulatorStorageChannel.Event,
    )
    expect(calls).toHaveLength(2)
    expect(calls[0]![1]).toEqual({ type: 'added', key: 'wx123_x', newValue: 'v1' })
    expect(calls[1]![1]).toEqual({ type: 'removed', key: 'wx123_x' })

    await d.dispose()
  })

  it('domStorageItemsCleared always forwards even when filtering is active', async () => {
    const wc = makeSimWc()
    stub.wcRegistry.push(wc)
    const host = makeHost()

    const d = setupSimulatorStorage(host, {
      getActiveAppId: () => 'wx123',
    })
    await Promise.resolve()
    await Promise.resolve()

    wc.debugger.emit('message', {}, 'DOMStorage.domStorageItemsCleared', {})

    const sendMock = (host as unknown as { send: ReturnType<typeof vi.fn> }).send
    const calls = sendMock.mock.calls.filter(
      (c) => c[0] === SimulatorStorageChannel.Event,
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]![1]).toEqual({ type: 'cleared' })

    await d.dispose()
  })

  it('appId changes between calls are reflected (filter re-evaluates per event)', async () => {
    const wc = makeSimWc([
      ['wx123_a', '1'],
      ['wx999_b', '2'],
    ])
    stub.wcRegistry.push(wc)

    let activeAppId: string | null = 'wx123'
    const d = setupSimulatorStorage(makeHost(), {
      getActiveAppId: () => activeAppId,
    })
    await Promise.resolve()
    await Promise.resolve()

    const handler = getSnapshotHandler()
    expect(await handler()).toEqual([{ key: 'wx123_a', value: '1' }])

    activeAppId = 'wx999'
    expect(await handler()).toEqual([{ key: 'wx999_b', value: '2' }])

    activeAppId = null
    expect(await handler()).toEqual([
      { key: 'wx123_a', value: '1' },
      { key: 'wx999_b', value: '2' },
    ])

    await d.dispose()
  })
})
