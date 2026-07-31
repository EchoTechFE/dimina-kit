import { beforeEach, describe, expect, it, vi } from 'vitest'

const stubs = vi.hoisted(() => {
  const ipcMain = {
    on: vi.fn(),
    removeListener: vi.fn(),
  }
  const webContents = {
    id: 41,
    isDestroyed: vi.fn(() => false),
    setWindowOpenHandler: vi.fn(),
    on: vi.fn(),
    loadURL: vi.fn(() => new Promise<void>(() => {})),
    send: vi.fn(),
    close: vi.fn(),
  }
  const view = { webContents }
  const WebContentsView = vi.fn(function WebContentsView() {
    return view
  })
  return { ipcMain, webContents, view, WebContentsView }
})

vi.mock('electron', () => ({
  ipcMain: stubs.ipcMain,
  shell: { openExternal: vi.fn() },
  WebContentsView: stubs.WebContentsView,
}))

vi.mock('./services/views/miniapp-partition.js', () => ({
  configureMiniappSession: vi.fn(),
  miniappPartition: () => 'persist:test',
}))

import {
  createEmbeddedMiniappView,
  ElectronRuntimeSessionDisposedError,
} from './embedded-view.js'

const assets = {
  root: '/runtime/dist',
  simulatorDir: '/runtime/dist/simulator',
  simulatorPreloadPath: '/runtime/dist/preload/simulator.cjs',
  renderHostHtmlPath: '/runtime/dist/render-host/pageFrame.html',
  renderHostPreloadPath: '/runtime/dist/render-host/preload.cjs',
  serviceHostHtmlPath: '/runtime/dist/service-host/service.html',
  serviceHostPreloadPath: '/runtime/dist/service-host/preload.cjs',
}

describe('createEmbeddedMiniappView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stubs.webContents.isDestroyed.mockReturnValue(false)
  })

  it('rejects readiness as disposed and still detaches the view after bridge cleanup fails', async () => {
    const bridgeFailure = new Error('bridge cleanup failed')
    const removeChildView = vi.fn()
    const embedded = createEmbeddedMiniappView({
      apiNamespaces: [],
      assets,
      workspace: {
        getSession: () => null,
        getProjectPath: () => '',
        isClosing: () => true,
      },
      windows: {
        mainWindow: {
          isDestroyed: () => false,
          contentView: { removeChildView },
        },
      },
      bridge: {
        disposeSessionsForSimulator: vi.fn(async () => {
          throw bridgeFailure
        }),
      },
    } as never, {
      appId: 'app',
      projectPath: '/miniapp',
      simulatorUrl: 'http://127.0.0.1:3101/simulator.html',
      assets,
    })
    const readyError = embedded.ready.catch((error: unknown) => error)

    const firstDispose = embedded.dispose()
    expect(embedded.dispose()).toBe(firstDispose)
    await expect(firstDispose).rejects.toThrow('Embedded mini-app view disposal failed')
    expect(await readyError).toBeInstanceOf(ElectronRuntimeSessionDisposedError)
    expect(removeChildView).toHaveBeenCalledWith(stubs.view)
    expect(stubs.webContents.close).toHaveBeenCalledOnce()
    await expect(embedded.dispose()).rejects.toThrow('Embedded mini-app view disposal failed')
  })
})
