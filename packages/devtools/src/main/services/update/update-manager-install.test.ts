/**
 * Regression coverage for two adversarial-review findings on the
 * download → install path:
 *
 * 1. install() must not blindly quit the app after firing
 *    shell.openPath() — that call resolves (never rejects) with an error
 *    message on failure, not an exception. Firing it without awaiting and
 *    quitting immediately after silently closed the app on a failed
 *    install with no way for the renderer to know anything went wrong.
 * 2. check() must only discard a completed download when the update
 *    identity actually changed. Comparing only `version` let a
 *    re-uploaded/replaced asset (same version, different downloadUrl)
 *    keep serving install() the previous, unrelated download.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

vi.mock('electron', () => ({
  app: stub.appStub,
  ipcMain: stub.ipcMainStub,
  shell: stub.shellStub,
  BrowserWindow: class {},
  webContents: { getAllWebContents: () => [] },
  nativeImage: { createFromPath: () => ({}) },
}))

import type { UpdateChecker, UpdateInfo } from '../../../shared/types.js'
import { UpdateManager } from './update-manager.js'

function makeMainWindow() {
  return {
    webContents: { send: vi.fn(), isDestroyed: () => false },
  } as unknown as Electron.BrowserWindow
}

function makeChecker(sequence: Array<UpdateInfo | null>, downloadPath = '/tmp/fake-update.dmg'): UpdateChecker {
  let i = 0
  return {
    checkForUpdates: vi.fn(async () => {
      const r = sequence[Math.min(i, sequence.length - 1)]
      i++
      return r
    }),
    downloadUpdate: vi.fn(async () => downloadPath),
  }
}

beforeEach(() => {
  stub.ipcHandlers.clear()
  stub.appStub.quit.mockClear()
  stub.shellStub.openPath.mockReset().mockResolvedValue('')
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('UpdateManager.install()', () => {
  it('returns success:false without touching shell when nothing was downloaded', async () => {
    const m = new UpdateManager({ checker: makeChecker([null]), mainWindow: makeMainWindow() })

    const result = await m.install()

    expect(result).toEqual({ success: false, error: 'No update downloaded' })
    expect(stub.shellStub.openPath).not.toHaveBeenCalled()
    expect(stub.appStub.quit).not.toHaveBeenCalled()
    await m.dispose()
  })

  it('quits the app only after shell.openPath resolves success (empty string)', async () => {
    const info: UpdateInfo = { version: '2.0.0', downloadUrl: 'https://example.com/2.0.0.dmg' }
    const checker = makeChecker([info])
    const m = new UpdateManager({ checker, mainWindow: makeMainWindow() })
    await m.check()
    await m.download()
    stub.shellStub.openPath.mockResolvedValueOnce('')

    const result = await m.install()

    expect(stub.shellStub.openPath).toHaveBeenCalledWith('/tmp/fake-update.dmg')
    expect(stub.appStub.quit).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ success: true })
    await m.dispose()
  })

  it('does NOT quit and surfaces the failure when shell.openPath resolves an error message', async () => {
    const info: UpdateInfo = { version: '2.0.0', downloadUrl: 'https://example.com/2.0.0.dmg' }
    const checker = makeChecker([info])
    const m = new UpdateManager({ checker, mainWindow: makeMainWindow() })
    await m.check()
    await m.download()
    stub.shellStub.openPath.mockResolvedValueOnce('no application associated with this file')

    const result = await m.install()

    expect(stub.appStub.quit).not.toHaveBeenCalled()
    expect(result).toEqual({ success: false, error: 'no application associated with this file' })
    await m.dispose()
  })
})

describe('UpdateManager: downloadedPath survives a same-identity re-check, clears on a real change', () => {
  it('a periodic re-check reporting the identical update (same version + downloadUrl) preserves the completed download', async () => {
    const info: UpdateInfo = { version: '2.0.0', downloadUrl: 'https://example.com/2.0.0.dmg' }
    const checker = makeChecker([info, info]) // two checks, same identity
    const m = new UpdateManager({ checker, mainWindow: makeMainWindow() })

    await m.check()
    await m.download()
    await m.check() // simulates the periodic timer firing again before Install was clicked

    const result = await m.install()

    expect(stub.shellStub.openPath).toHaveBeenCalledWith('/tmp/fake-update.dmg')
    expect(result).toEqual({ success: true })
    await m.dispose()
  })

  it('a re-check with the same version but a different downloadUrl discards the stale download', async () => {
    const first: UpdateInfo = { version: '2.0.0', downloadUrl: 'https://example.com/2.0.0-a.dmg' }
    const replaced: UpdateInfo = { version: '2.0.0', downloadUrl: 'https://example.com/2.0.0-b.dmg' }
    const checker = makeChecker([first, replaced])
    const m = new UpdateManager({ checker, mainWindow: makeMainWindow() })

    await m.check()
    await m.download()
    await m.check() // same version string, but the asset was replaced under a new URL

    const result = await m.install()

    expect(result).toEqual({ success: false, error: 'No update downloaded' })
    expect(stub.shellStub.openPath).not.toHaveBeenCalled()
    await m.dispose()
  })
})
