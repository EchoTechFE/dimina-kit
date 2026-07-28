/**
 * Workbench settings restart IPC.
 *
 * MCP/CDP listeners are startup-only, so the settings window offers a restart
 * action after those settings change. The handler must schedule an Electron
 * relaunch and then quit through the normal app lifecycle.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const stub = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => unknown
  const handled = new Map<string, Handler>()
  return {
    handled,
    app: {
      isPackaged: false,
      commandLine: { getSwitchValue: vi.fn(() => '') },
      relaunch: vi.fn(),
      quit: vi.fn(),
    },
    ipcMain: {
      handle: vi.fn((channel: string, fn: Handler) => {
        handled.set(channel, fn)
      }),
      removeHandler: vi.fn((channel: string) => {
        handled.delete(channel)
      }),
      on: vi.fn(),
      removeListener: vi.fn(),
      removeAllListeners: vi.fn(),
    },
  }
})

vi.mock('electron', () => ({
  app: stub.app,
  ipcMain: stub.ipcMain,
  default: { app: stub.app, ipcMain: stub.ipcMain },
}))

vi.mock('../services/settings/index.js', () => ({
  loadWorkbenchSettings: vi.fn(() => ({
    theme: 'system',
    cdp: { enabled: false, port: 9222 },
    mcp: { enabled: false, port: 7789 },
    compile: { autoBuild: true },
    preview: { autoReload: true },
    lastCreateBaseDir: null,
  })),
  saveWorkbenchSettings: vi.fn(),
  applyTheme: vi.fn(),
}))

vi.mock('../services/mcp/status.js', () => ({
  getMcpStatus: vi.fn(() => ({ running: false, port: null, error: null })),
}))

beforeEach(() => {
  stub.handled.clear()
  stub.app.relaunch.mockClear()
  stub.app.quit.mockClear()
  stub.ipcMain.handle.mockClear()
  vi.resetModules()
})

async function setupSettings() {
  const { registerSettingsIpc } = await import('./settings.js')
  return registerSettingsIpc({
    views: {} as never,
    notify: {} as never,
    workspace: {} as never,
    rendererDir: '/tmp/renderer',
    senderPolicy: undefined,
  } as never)
}

describe('registerSettingsIpc: workbenchSettings:restart', () => {
  it('schedules an app relaunch and quits the current process', async () => {
    const d = await setupSettings()
    const handler = stub.handled.get('workbenchSettings:restart')
    expect(handler).toBeDefined()

    await handler?.({})

    expect(stub.app.relaunch).toHaveBeenCalledTimes(1)
    expect(stub.app.quit).toHaveBeenCalledTimes(1)
    await d.dispose()
  })
})
