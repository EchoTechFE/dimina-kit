/**
 * Guards the DEFAULT (non-pooled) service-host spawn path against swallowing a
 * navigation failure: `createServiceHostWindow` issues the spawn `loadURL`
 * itself, so unless it threads `opts.onLoadFailed` through to
 * `navigateServiceHost`, a rejected load produces zero signal — did-finish-load
 * never fires and the only symptom is the launch watchdog's late timeout
 * instead of the real cause.
 */
import { describe, expect, it, vi } from 'vitest'

const { loadUrlError } = vi.hoisted(() => ({ loadUrlError: new Error('ERR_FILE_NOT_FOUND') }))

vi.mock('electron', () => ({
  app: { isPackaged: true, getLocale: () => 'en-US', getPath: vi.fn(() => '/tmp/dimina-test') },
  BrowserWindow: class {
    webContents = {}
    isDestroyed = (): boolean => false
    loadURL = vi.fn(() => Promise.reject(loadUrlError))
  },
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

import { createServiceHostWindow } from './create.js'

describe('createServiceHostWindow — fresh-path onLoadFailed threading', () => {
  it('forwards the spawn-navigation loadURL rejection to opts.onLoadFailed', async () => {
    const onLoadFailed = vi.fn()
    createServiceHostWindow({
      bridgeId: 'bridge-1',
      appId: 'fresh-app',
      pagePath: 'pages/index/index',
      pkgRoot: '/tmp',
      resourceBaseUrl: 'http://127.0.0.1:1/',
      onLoadFailed,
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onLoadFailed).toHaveBeenCalledTimes(1)
    expect(onLoadFailed).toHaveBeenCalledWith(loadUrlError)
  })
})
