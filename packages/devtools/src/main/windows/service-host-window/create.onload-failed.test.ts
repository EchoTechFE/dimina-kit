/**
 * Behavior tests for the `opts.onLoadFailed` hook added to `navigateServiceHost`.
 *
 * `navigateServiceHost` intentionally swallows a `loadURL` rejection (the
 * pooled-window recycle path expects failed loads not to crash the caller) —
 * but swallowing silently means a service host that fails to navigate (bad
 * partition, crashed renderer, disk full on a `file://` load, …) produces zero
 * signal anywhere. The fix keeps the "Promise still resolves" contract (no
 * caller starts awaiting a rejection it didn't expect) while giving the caller
 * an optional hook to observe the original failure and route it into the
 * diagnostics bus.
 */
import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

vi.mock('electron', () => ({
  app: { isPackaged: true, getLocale: () => 'en-US', getPath: vi.fn(() => '/tmp/dimina-test') },
  BrowserWindow: class {},
  protocol: { handle: vi.fn(), unhandle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  session: {
    fromPartition: vi.fn(() => ({
      webRequest: { onBeforeSendHeaders: vi.fn(), onHeadersReceived: vi.fn() },
      registerPreloadScript: vi.fn(),
      protocol: { handle: vi.fn(), unhandle: vi.fn() },
    })),
    defaultSession: { protocol: { handle: vi.fn(), unhandle: vi.fn() } },
  },
}))

import { navigateServiceHost } from './create.js'

/**
 * `app.isPackaged: true` (mocked above) short-circuits the dev-only detached
 * DevTools hook inside `navigateServiceHost`, so this fake window never needs
 * `webContents.once`/`getURL` — only `loadURL` and `isDestroyed` are read.
 */
function makeWin(loadURL: () => Promise<void>): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: {},
    loadURL: vi.fn(loadURL),
  } as unknown as BrowserWindow
}

describe('navigateServiceHost(win, url, opts) — onLoadFailed hook', () => {
  it('invokes opts.onLoadFailed with the original rejection reason when loadURL rejects', async () => {
    const err = new Error('ERR_FILE_NOT_FOUND')
    const win = makeWin(() => Promise.reject(err))
    const onLoadFailed = vi.fn()

    await navigateServiceHost(win, 'file:///service.html', { onLoadFailed })

    expect(onLoadFailed).toHaveBeenCalledTimes(1)
    expect(onLoadFailed).toHaveBeenCalledWith(err)
  })

  it('still resolves (never rejects the caller) when loadURL rejects, even with onLoadFailed provided', async () => {
    const win = makeWin(() => Promise.reject(new Error('boom')))

    await expect(
      navigateServiceHost(win, 'file:///service.html', { onLoadFailed: vi.fn() }),
    ).resolves.toBeUndefined()
  })

  it('does not call onLoadFailed when loadURL resolves', async () => {
    const win = makeWin(() => Promise.resolve())
    const onLoadFailed = vi.fn()

    await navigateServiceHost(win, 'file:///service.html', { onLoadFailed })

    expect(onLoadFailed).not.toHaveBeenCalled()
  })

  it('does not throw and still resolves when opts is omitted and loadURL rejects (back-compat, pre-existing swallow semantics)', async () => {
    const win = makeWin(() => Promise.reject(new Error('boom')))

    await expect(navigateServiceHost(win, 'file:///service.html')).resolves.toBeUndefined()
  })

  it('does not throw when opts is provided but onLoadFailed is omitted, and loadURL rejects', async () => {
    const win = makeWin(() => Promise.reject(new Error('boom')))

    await expect(navigateServiceHost(win, 'file:///service.html', {})).resolves.toBeUndefined()
  })
})
