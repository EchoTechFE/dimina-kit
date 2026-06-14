/**
 * Header avatar provider IPC.
 *
 * The built-in project header owns the rendering, while downstream hosts own
 * the current-user source of truth. This test pins the narrow bridge between
 * them: `app:getHeaderAvatar` returns a small serialisable DTO, never the
 * host's raw user object.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stub = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => unknown
  const handlers = new Map<string, Handler>()
  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, fn: Handler) => {
        handlers.set(channel, fn)
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel)
      }),
      on: vi.fn(),
      removeListener: vi.fn(),
    },
  }
})

vi.mock('electron', () => ({
  ipcMain: stub.ipcMain,
  default: { ipcMain: stub.ipcMain },
}))

vi.mock('../utils/ipc-registry.js', () => {
  class IpcRegistry {
    private channels: string[] = []
    constructor(_policy?: unknown) {}
    handle(channel: string, fn: (...args: unknown[]) => unknown) {
      this.channels.push(channel)
      stub.ipcMain.handle(channel, fn)
      return this
    }
    async dispose() {
      for (const channel of this.channels.splice(0)) {
        stub.ipcMain.removeHandler(channel)
      }
    }
  }
  return { IpcRegistry }
})

beforeEach(() => {
  stub.handlers.clear()
  stub.ipcMain.handle.mockClear()
  vi.resetModules()
})

function makeAppCtx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    brandingProvider: undefined,
    appName: 'Test App',
    senderPolicy: undefined,
    ...overrides,
  }
}

describe('registerAppIpc: app:getHeaderAvatar', () => {
  it('registers a getter that resolves null when no provider is configured', async () => {
    const { registerAppIpc } = await import('./app.js')
    const { AppChannel } = await import('../../shared/ipc-channels.js')

    const disposable = registerAppIpc(makeAppCtx() as never)
    const handler = stub.handlers.get(AppChannel.GetHeaderAvatar)

    expect(handler, 'app:getHeaderAvatar must be registered for the renderer header').toBeDefined()
    await expect(handler!({})).resolves.toBeNull()

    await (disposable as { dispose: () => Promise<void> }).dispose()
  })

  it('normalises the host user object to the public header avatar DTO', async () => {
    const { registerAppIpc } = await import('./app.js')
    const { AppChannel } = await import('../../shared/ipc-channels.js')

    const disposable = registerAppIpc(makeAppCtx({
      headerAvatarProvider: async () => ({
        displayName: ' Ada Lovelace ',
        displayInitial: ' A ',
        avatarUrl: ' https://example.com/avatar.png ',
        tooltip: ' Current user ',
        internalToken: 'must-not-cross-ipc',
      }),
    }) as never)

    const handler = stub.handlers.get(AppChannel.GetHeaderAvatar)!
    await expect(handler({})).resolves.toEqual({
      displayName: 'Ada Lovelace',
      displayInitial: 'A',
      avatarUrl: 'https://example.com/avatar.png',
      tooltip: 'Current user',
    })

    await (disposable as { dispose: () => Promise<void> }).dispose()
  })

  it('returns null for an empty provider result so the header slot stays hidden', async () => {
    const { registerAppIpc } = await import('./app.js')
    const { AppChannel } = await import('../../shared/ipc-channels.js')

    const disposable = registerAppIpc(makeAppCtx({
      headerAvatarProvider: () => ({ tooltip: 'tooltip alone is not enough to render an avatar' }),
    }) as never)

    const handler = stub.handlers.get(AppChannel.GetHeaderAvatar)!
    await expect(handler({})).resolves.toBeNull()

    await (disposable as { dispose: () => Promise<void> }).dispose()
  })
})

describe('registerAppIpc: header actions', () => {
  it('normalises host header actions and drops invalid or duplicate entries', async () => {
    const { registerAppIpc } = await import('./app.js')
    const { AppChannel } = await import('../../shared/ipc-channels.js')

    const disposable = registerAppIpc(makeAppCtx({
      headerActionsProvider: async () => [
        {
          id: ' upload ',
          label: ' 上传 ',
          placement: 'right',
          tooltip: ' 上传版本 ',
          icon: 'U',
          disabled: true,
          handler: 'must-not-cross-ipc',
        },
        { id: 'upload', label: 'duplicate' },
        { id: 'preview', label: '预览', placement: 'center' },
        { id: 'bad', label: 'Bad', placement: 'elsewhere' },
        { id: '', label: 'missing id' },
        { id: 'missing-label', label: '' },
      ],
    }) as never)

    const handler = stub.handlers.get(AppChannel.GetHeaderActions)!
    await expect(handler({})).resolves.toEqual([
      {
        id: 'upload',
        label: '上传',
        placement: 'right',
        tooltip: '上传版本',
        icon: 'U',
        disabled: true,
      },
      { id: 'preview', label: '预览', placement: 'center' },
      { id: 'bad', label: 'Bad' },
    ])

    await (disposable as { dispose: () => Promise<void> }).dispose()
  })

  it('invokes the host avatar and action handlers without exposing them to the renderer', async () => {
    const { registerAppIpc } = await import('./app.js')
    const { AppChannel } = await import('../../shared/ipc-channels.js')
    const headerAvatarActionHandler = vi.fn()
    const headerActionHandler = vi.fn()

    const disposable = registerAppIpc(makeAppCtx({
      headerAvatarActionHandler,
      headerActionHandler,
    }) as never)

    await stub.handlers.get(AppChannel.InvokeHeaderAvatar)!({})
    await stub.handlers.get(AppChannel.InvokeHeaderAction)!({}, 'upload')
    await stub.handlers.get(AppChannel.InvokeHeaderAction)!({}, '')

    expect(headerAvatarActionHandler).toHaveBeenCalledTimes(1)
    expect(headerActionHandler).toHaveBeenCalledTimes(1)
    expect(headerActionHandler).toHaveBeenCalledWith('upload')

    await (disposable as { dispose: () => Promise<void> }).dispose()
  })
})
