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
import { SimulatorStorageChannel } from '../../../shared/ipc-channels.js'
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
    // 3 ipc handlers per setup (GetSnapshot + Element.Inspect + Element.Clear) × 2 cycles
    expect(ipcMainStub.handle).toHaveBeenCalledTimes(6)
    expect(ipcMainStub.removeHandler).toHaveBeenCalledTimes(6)
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
