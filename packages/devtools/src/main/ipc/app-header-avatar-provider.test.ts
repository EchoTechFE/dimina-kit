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

describe('registerAppIpc: avatar action', () => {
  it('invokes the host avatar handler without exposing it to the renderer', async () => {
    const { registerAppIpc } = await import('./app.js')
    const { AppChannel } = await import('../../shared/ipc-channels.js')
    const headerAvatarActionHandler = vi.fn()

    const disposable = registerAppIpc(makeAppCtx({
      headerAvatarActionHandler,
    }) as never)

    await stub.handlers.get(AppChannel.InvokeHeaderAvatar)!({})

    expect(headerAvatarActionHandler).toHaveBeenCalledTimes(1)

    await (disposable as { dispose: () => Promise<void> }).dispose()
  })
})

describe('registerAppIpc: header actions', () => {
  it('normalises host actions to public DTOs and drops invalid/duplicate entries', async () => {
    const { registerAppIpc } = await import('./app.js')
    const { AppChannel } = await import('../../shared/ipc-channels.js')

    const disposable = registerAppIpc(makeAppCtx({
      headerActionsProvider: async () => [
        {
          id: ' open ',
          label: ' 打开 ',
          placement: 'left',
          tooltip: ' Open project ',
          internalToken: 'must-not-cross-ipc',
        },
        { id: 'preview', label: '真机预览', placement: 'center', disabled: true },
        { id: 'upload', label: '上传', placement: 'right' },
        { id: 'upload', label: 'duplicate is ignored', placement: 'right' },
        { id: '', label: 'invalid' },
        { id: 'bad', label: '' },
      ],
    }) as never)

    const handler = stub.handlers.get(AppChannel.GetHeaderActions)!
    await expect(handler({})).resolves.toEqual([
      {
        id: 'open',
        label: '打开',
        placement: 'left',
        tooltip: 'Open project',
      },
      {
        id: 'preview',
        label: '真机预览',
        placement: 'center',
        disabled: true,
      },
      {
        id: 'upload',
        label: '上传',
        placement: 'right',
      },
    ])

    await (disposable as { dispose: () => Promise<void> }).dispose()
  })

  it('invokes the host action handler with the normalised action id', async () => {
    const { registerAppIpc } = await import('./app.js')
    const { AppChannel } = await import('../../shared/ipc-channels.js')
    const headerActionHandler = vi.fn()

    const disposable = registerAppIpc(makeAppCtx({
      headerActionHandler,
    }) as never)

    await stub.handlers.get(AppChannel.InvokeHeaderAction)!({}, ' upload ')

    expect(headerActionHandler).toHaveBeenCalledTimes(1)
    expect(headerActionHandler).toHaveBeenCalledWith('upload')

    await (disposable as { dispose: () => Promise<void> }).dispose()
  })
})
