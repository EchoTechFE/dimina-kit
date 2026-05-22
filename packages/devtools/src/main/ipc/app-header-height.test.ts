/**
 * Requirement B (config + IPC half) — a host-configured `headerHeight` must:
 *   1. land on `WorkbenchContext.headerHeight` (default 40 when unset), and
 *   2. be retrievable by the renderer through a new
 *      `AppChannel.GetHeaderHeight` IPC handler registered by `registerAppIpc`.
 *
 * Why this matters: the renderer currently hard-codes `HEADER_H = 40` in
 * `src/renderer/shared/constants.ts`. Without an IPC channel, a host that
 * sets `headerHeight: 64` gets a renderer that still lays its toolbar/popover
 * out at 40px — a real visual bug. `app:getHeaderHeight` is the seam that
 * lets the renderer read the configured value at runtime.
 *
 * These tests are RED today because:
 *   - `AppChannel.GetHeaderHeight` does not exist on the channels enum,
 *   - `registerAppIpc` registers no such handler, and
 *   - `WorkbenchContext` has no `headerHeight` field.
 * Everything is accessed through dynamic casts so the file still compiles.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── electron stub: capture ipcMain.handle registrations by channel ──────────
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

beforeEach(() => {
  stub.handlers.clear()
  stub.ipcMain.handle.mockClear()
  vi.resetModules()
})

/** Minimal ctx accepted by `registerAppIpc` (Pick<…>); `headerHeight` added. */
function makeAppCtx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    preloadPath: '/tmp/preload.js',
    brandingProvider: undefined,
    appName: 'Test App',
    senderPolicy: undefined,
    headerHeight: 40,
    ...overrides,
  }
}

describe('Requirement B: AppChannel.GetHeaderHeight', () => {
  it('the channels enum defines a GetHeaderHeight entry', async () => {
    const channels = (await import('../../shared/ipc-channels.js')) as unknown as {
      AppChannel: Record<string, string>
    }
    expect(
      channels.AppChannel.GetHeaderHeight,
      'AppChannel.GetHeaderHeight must be added to src/shared/ipc-channels.ts',
    ).toBeDefined()
    // Spec suggests the value 'app:getHeaderHeight'; assert the convention,
    // not just presence, so a typo'd channel name is also caught.
    expect(channels.AppChannel.GetHeaderHeight).toBe('app:getHeaderHeight')
  })

  it('registerAppIpc registers a handler on the GetHeaderHeight channel', async () => {
    const { registerAppIpc } = await import('./app.js')
    const { AppChannel } = (await import('../../shared/ipc-channels.js')) as unknown as {
      AppChannel: Record<string, string>
    }

    const disposable = registerAppIpc(makeAppCtx() as never)

    const channel = AppChannel.GetHeaderHeight
    expect(channel, 'AppChannel.GetHeaderHeight must exist for this test').toBeDefined()
    expect(
      stub.handlers.has(channel),
      'registerAppIpc must register a handler for AppChannel.GetHeaderHeight',
    ).toBe(true)

    await (disposable as { dispose: () => Promise<void> }).dispose()
  })

  it('the GetHeaderHeight handler returns ctx.headerHeight (configured value)', async () => {
    const { registerAppIpc } = await import('./app.js')
    const { AppChannel } = (await import('../../shared/ipc-channels.js')) as unknown as {
      AppChannel: Record<string, string>
    }

    // Host configured a non-default header height.
    const disposable = registerAppIpc(makeAppCtx({ headerHeight: 64 }) as never)

    const handler = stub.handlers.get(AppChannel.GetHeaderHeight)
    expect(handler, 'GetHeaderHeight handler must be registered').toBeDefined()

    const fakeEvent = { sender: { id: 1, isDestroyed: () => false, getURL: () => '' } }
    const result = await handler!(fakeEvent)
    expect(result, 'handler must echo the configured ctx.headerHeight, not a hard-coded 40').toBe(64)

    await (disposable as { dispose: () => Promise<void> }).dispose()
  })
})
