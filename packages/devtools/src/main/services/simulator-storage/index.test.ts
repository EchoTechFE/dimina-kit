/**
 * Disposable lifecycle regression for setupSimulatorStorage.
 *
 * We do NOT exercise CDP attach (would require a real Electron renderer).
 * The contract verified here:
 *   - registers ipcMain.handle(SimulatorStorageChannel.GetSnapshot)
 *   - registers an app.on('web-contents-created', ...) listener
 *   - dispose() removes both
 *   - setup → dispose → setup → dispose is symmetric
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Electron stub (hoisted so vi.mock factory can reference it) ─────────
const stub = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => unknown
  const ipcHandlers = new Map<string, Handler>()
  const appListeners = new Map<string, Set<Handler>>()
  const wcRegistry: unknown[] = []

  const ipcMainStub = {
    handle: vi.fn((channel: string, fn: Handler) => {
      ipcHandlers.set(channel, fn)
    }),
    removeHandler: vi.fn((channel: string) => {
      ipcHandlers.delete(channel)
    }),
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

const { ipcHandlers, appListeners, wcRegistry, ipcMainStub, appStub, webContentsStub } = stub

vi.mock('electron', () => ({
  app: stub.appStub,
  ipcMain: stub.ipcMainStub,
  webContents: stub.webContentsStub,
  BrowserWindow: class {},
  shell: { openPath: vi.fn() },
  nativeImage: { createFromPath: vi.fn(() => ({})) },
}))

// Import AFTER the mock so the module picks up the stubs.
import { EventEmitter } from 'node:events'
import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'
import { SimulatorStorageChannel, type SyncStorageChange } from '../../../shared/ipc-channels.js'
import { setupSimulatorStorage } from './index.js'

function makeHost() {
  return {
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  } as unknown as Electron.WebContents
}

beforeEach(() => {
  ipcHandlers.clear()
  appListeners.clear()
  wcRegistry.length = 0
  ipcMainStub.handle.mockClear()
  ipcMainStub.removeHandler.mockClear()
  appStub.on.mockClear()
  appStub.removeListener.mockClear()
  webContentsStub.getAllWebContents.mockClear()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('setupSimulatorStorage lifecycle', () => {
  it('returns a Disposable', () => {
    const d = setupSimulatorStorage(makeHost(), { getActiveAppId: () => null })
    expect(typeof d.dispose).toBe('function')
    void d.dispose()
  })

  it('registers ipcMain.handle for GetSnapshot', () => {
    const d = setupSimulatorStorage(makeHost(), { getActiveAppId: () => null })
    expect(ipcMainStub.handle).toHaveBeenCalledWith(
      SimulatorStorageChannel.GetSnapshot,
      expect.any(Function),
    )
    expect(ipcHandlers.has(SimulatorStorageChannel.GetSnapshot)).toBe(true)
    void d.dispose()
  })

  it('registers an app.on("web-contents-created") listener', () => {
    const d = setupSimulatorStorage(makeHost(), { getActiveAppId: () => null })
    expect(appStub.on).toHaveBeenCalledWith(
      'web-contents-created',
      expect.any(Function),
    )
    expect(appListeners.get('web-contents-created')?.size).toBe(1)
    void d.dispose()
  })

  it('dispose() unregisters ipc handler and app listener', async () => {
    const d = setupSimulatorStorage(makeHost(), { getActiveAppId: () => null })
    expect(ipcHandlers.has(SimulatorStorageChannel.GetSnapshot)).toBe(true)
    expect(appListeners.get('web-contents-created')?.size).toBe(1)

    await d.dispose()

    expect(ipcMainStub.removeHandler).toHaveBeenCalledWith(
      SimulatorStorageChannel.GetSnapshot,
    )
    expect(appStub.removeListener).toHaveBeenCalledWith(
      'web-contents-created',
      expect.any(Function),
    )
    expect(ipcHandlers.has(SimulatorStorageChannel.GetSnapshot)).toBe(false)
    expect(appListeners.get('web-contents-created')?.size ?? 0).toBe(0)
  })

  it('supports repeated setup→dispose cycles', async () => {
    for (let i = 0; i < 2; i++) {
      const d = setupSimulatorStorage(makeHost(), { getActiveAppId: () => null })
      expect(ipcHandlers.has(SimulatorStorageChannel.GetSnapshot)).toBe(true)
      await d.dispose()
      expect(ipcHandlers.has(SimulatorStorageChannel.GetSnapshot)).toBe(false)
    }
    // 8 ipc handlers per setup (Storage.GetSnapshot + GetActivePrefix + Set
    // + Remove + Clear + ClearAll + Element.Inspect + Element.Clear) × 2 cycles
    expect(ipcMainStub.handle).toHaveBeenCalledTimes(16)
    expect(ipcMainStub.removeHandler).toHaveBeenCalledTimes(16)
    expect(appStub.on).toHaveBeenCalledTimes(2)
    expect(appStub.removeListener).toHaveBeenCalledTimes(2)
  })

  it('dispose() is idempotent', async () => {
    const d = setupSimulatorStorage(makeHost(), { getActiveAppId: () => null })
    await d.dispose()
    const removeCalls = ipcMainStub.removeHandler.mock.calls.length
    await d.dispose()
    expect(ipcMainStub.removeHandler.mock.calls.length).toBe(removeCalls)
  })
})

describe('setupSimulatorStorage connection-registry teardown', () => {
  /**
   * A fake webContents backed by a real EventEmitter so `acquire(wc)` can arm a
   * real `'destroyed'` hook and `emit('destroyed')` drives the connection close.
   * Each gets a unique id (the registry keys connections by `wc.id`).
   */
  let nextId = 1
  function makeFakeWc(): Electron.WebContents {
    const ee = new EventEmitter()
    const wc = ee as unknown as Electron.WebContents & EventEmitter
    Object.assign(wc, {
      id: nextId++,
      isDestroyed: () => false,
      getType: () => 'webview',
      getURL: () => 'http://localhost/simulator.html',
    })
    return wc
  }

  it('routes per-wc destroy through connections.own and resets state without leaking', async () => {
    const connections = createConnectionRegistry()
    const d = setupSimulatorStorage(makeHost(), {
      getActiveAppId: () => null,
      connections,
    })

    // Fire the module's app.on('web-contents-created') with a fresh wc.
    const onCreated = [...(appListeners.get('web-contents-created') ?? [])][0] as (
      ev: unknown,
      wc: Electron.WebContents,
    ) => void
    expect(onCreated).toBeTypeOf('function')

    const childWc = makeFakeWc()
    onCreated({}, childWc)

    // A connection is now alive and owns this wc's per-wc cleanup.
    const conn = connections.get((childWc as unknown as { id: number }).id)
    expect(conn?.alive).toBe(true)

    // Destroying the wc closes the connection (own() disposer runs).
    ;(childWc as unknown as EventEmitter).emit('destroyed')

    // Connection is closed (deterministic teardown) and de-registered — not leaked.
    expect(conn?.alive).toBe(false)
    expect(connections.get((childWc as unknown as { id: number }).id)).toBeUndefined()

    await d.dispose()
  })
})

/**
 * `onSyncStorageChange` (final-contract.md §5) — the SimulatorStorageHandle
 * method bridge-router calls on a `storageChanged` container message from the
 * service-host's SYNC wx storage APIs (setStorageSync/removeStorageSync/
 * clearStorageSync write `localStorage` directly, bypassing main, so without
 * this hook the panel would only reflect them after a manual reload).
 *
 * Pinned contract:
 *   - `appId !== getActiveAppId()` → no push (the panel shows one active app).
 *   - `set`    → pushes `{ type:'added', key, newValue: value }`.
 *   - `remove` → pushes `{ type:'removed', key }`.
 *   - `clear`  → pushes `{ type:'cleared' }`.
 *   - a destroyed host webContents → no push.
 * `key` already carries the full `${appId}_` prefix (set by the caller), so
 * this method must forward it unchanged — it must NOT re-prefix or strip it.
 */
describe('setupSimulatorStorage — onSyncStorageChange (service-host sync write notify)', () => {
  it('set pushes an "added" StorageEvent carrying the change key/value verbatim', () => {
    const host = makeHost()
    const svc = setupSimulatorStorage(host, { getActiveAppId: () => 'wx123' })

    const change: SyncStorageChange = { op: 'set', key: 'wx123_foo', value: '"bar"' }
    svc.onSyncStorageChange('wx123', change)

    expect(host.send).toHaveBeenCalledWith(SimulatorStorageChannel.Event, {
      type: 'added',
      key: 'wx123_foo',
      newValue: '"bar"',
    })
    void svc.dispose()
  })

  it('remove pushes a "removed" StorageEvent', () => {
    const host = makeHost()
    const svc = setupSimulatorStorage(host, { getActiveAppId: () => 'wx123' })

    const change: SyncStorageChange = { op: 'remove', key: 'wx123_foo' }
    svc.onSyncStorageChange('wx123', change)

    expect(host.send).toHaveBeenCalledWith(SimulatorStorageChannel.Event, {
      type: 'removed',
      key: 'wx123_foo',
    })
    void svc.dispose()
  })

  it('clear pushes a "cleared" StorageEvent', () => {
    const host = makeHost()
    const svc = setupSimulatorStorage(host, { getActiveAppId: () => 'wx123' })

    const change: SyncStorageChange = { op: 'clear' }
    svc.onSyncStorageChange('wx123', change)

    expect(host.send).toHaveBeenCalledWith(SimulatorStorageChannel.Event, { type: 'cleared' })
    void svc.dispose()
  })

  it('does NOT push when the change appId does not match the active app', () => {
    const host = makeHost()
    const svc = setupSimulatorStorage(host, { getActiveAppId: () => 'wx123' })

    svc.onSyncStorageChange('wxOTHER', { op: 'set', key: 'wxOTHER_foo', value: '1' })

    expect(host.send).not.toHaveBeenCalled()
    void svc.dispose()
  })

  it('does NOT push when the host webContents is destroyed', () => {
    const host = makeHost()
    ;(host.isDestroyed as ReturnType<typeof vi.fn>).mockReturnValue(true)
    const svc = setupSimulatorStorage(host, { getActiveAppId: () => 'wx123' })

    svc.onSyncStorageChange('wx123', { op: 'set', key: 'wx123_foo', value: '1' })

    expect(host.send).not.toHaveBeenCalled()
    void svc.dispose()
  })
})
