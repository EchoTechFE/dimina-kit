/**
 * Disposable lifecycle regression for UpdateManager.
 *
 * Asserts the construct-time registrations (3 ipcMain handlers + 2 timers)
 * and that dispose() cleans every one of them up. Real fetches are avoided
 * by stubbing the UpdateChecker; real Electron is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Electron stub (hoisted so vi.mock factory can reference it) ─────────
const stub = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => unknown
  const ipcHandlers = new Map<string, Handler>()
  const ipcMainStub = {
    handle: vi.fn((channel: string, fn: Handler) => {
      ipcHandlers.set(channel, fn)
    }),
    removeHandler: vi.fn((channel: string) => {
      ipcHandlers.delete(channel)
    }),
  }
  const appStub = {
    getVersion: vi.fn(() => '1.0.0'),
    quit: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  }
  const shellStub = { openPath: vi.fn(async () => '') }
  return { ipcHandlers, ipcMainStub, appStub, shellStub }
})

const { ipcHandlers, ipcMainStub } = stub

vi.mock('electron', () => ({
  app: stub.appStub,
  ipcMain: stub.ipcMainStub,
  shell: stub.shellStub,
  BrowserWindow: class {},
  webContents: { getAllWebContents: () => [] },
  nativeImage: { createFromPath: () => ({}) },
}))

import type { UpdateChecker, UpdateInfo } from '../../../shared/types.js'
import { UpdateChannel } from '../../../shared/ipc-channels.js'
import { UpdateManager } from './update-manager.js'

const CHANNELS = [UpdateChannel.Check, UpdateChannel.Download, UpdateChannel.Install]

function makeMainWindow() {
  return {
    webContents: { send: vi.fn(), isDestroyed: () => false },
  } as unknown as Electron.BrowserWindow
}

function makeChecker(info: UpdateInfo | null = null): UpdateChecker {
  return {
    checkForUpdates: vi.fn(async () => info),
    downloadUpdate: vi.fn(async () => '/tmp/fake.dmg'),
  }
}

beforeEach(() => {
  ipcHandlers.clear()
  ipcMainStub.handle.mockClear()
  ipcMainStub.removeHandler.mockClear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('UpdateManager lifecycle', () => {
  it('registers three ipcMain handlers on construct', async () => {
    const m = new UpdateManager({ checker: makeChecker(), mainWindow: makeMainWindow() })
    for (const ch of CHANNELS) {
      expect(ipcHandlers.has(ch)).toBe(true)
    }
    expect(ipcMainStub.handle).toHaveBeenCalledTimes(3)
    await m.dispose()
  })

  it('schedules an initial timeout and a periodic interval', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const m = new UpdateManager({ checker: makeChecker(), mainWindow: makeMainWindow() })

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1)
    expect(setIntervalSpy).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(2)

    await m.dispose()
  })

  it('dispose() removes all three handlers', async () => {
    const m = new UpdateManager({ checker: makeChecker(), mainWindow: makeMainWindow() })
    await m.dispose()

    for (const ch of CHANNELS) {
      expect(ipcMainStub.removeHandler).toHaveBeenCalledWith(ch)
      expect(ipcHandlers.has(ch)).toBe(false)
    }
  })

  it('dispose() clears both timers so no callbacks fire afterwards', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')

    const checker = makeChecker()
    const m = new UpdateManager({
      checker,
      mainWindow: makeMainWindow(),
      checkInterval: 10_000,
      initialDelay: 1_000,
    })

    await m.dispose()

    expect(clearTimeoutSpy).toHaveBeenCalled()
    expect(clearIntervalSpy).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)

    // Advance well past both intervals — nothing should fire.
    vi.advanceTimersByTime(60_000)
    expect(checker.checkForUpdates).not.toHaveBeenCalled()
  })

  it('supports construct → dispose → construct → dispose cycles', async () => {
    for (let i = 0; i < 2; i++) {
      const m = new UpdateManager({ checker: makeChecker(), mainWindow: makeMainWindow() })
      expect(ipcHandlers.size).toBe(3)
      await m.dispose()
      expect(ipcHandlers.size).toBe(0)
    }
    expect(ipcMainStub.handle).toHaveBeenCalledTimes(6)
    expect(ipcMainStub.removeHandler).toHaveBeenCalledTimes(6)
  })

  it('dispose() before any timer fires leaves the checker untouched', async () => {
    const checker = makeChecker()
    const m = new UpdateManager({
      checker,
      mainWindow: makeMainWindow(),
      checkInterval: 5_000,
      initialDelay: 500,
    })
    await m.dispose()
    vi.advanceTimersByTime(30_000)
    expect(checker.checkForUpdates).not.toHaveBeenCalled()
  })

})
