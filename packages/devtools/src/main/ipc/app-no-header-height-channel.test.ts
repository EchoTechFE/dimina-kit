/**
 * headerHeight decommission — IPC half. `registerAppIpc` must no longer
 * register the legacy `app:getHeaderHeight` handler: the renderer's toolbar
 * height is the fixed HEADER_H constant, so there is nothing for the
 * renderer to fetch.
 *
 * Real bug each test catches:
 *  - Leftover `.handle(AppChannel.GetHeaderHeight, …)` in app.ts keeps the
 *    legacy channel alive. Any renderer code (or a downstream host's
 *    renderer fork) that still invokes it would read the host-configured 72
 *    and lay out at a height the main process no longer honors — the exact
 *    desync this decommission removes. The channel must be gone at the
 *    wire level, regardless of what the host configures.
 *  - The wire name is asserted as a string literal (not via the enum) so
 *    the test still compiles after the implementer deletes the
 *    `GetHeaderHeight` enum entry, and so re-registering the same wire
 *    name under a new constant is also caught.
 *  - The companion sanity test pins that GetBranding is still registered —
 *    proving "channel absent" comes from targeted removal, not from
 *    registerAppIpc failing to register anything.
 *
 * RED today: app.ts line 16 registers AppChannel.GetHeaderHeight.
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

// Legacy wire name, asserted literally on purpose (see header comment).
const LEGACY_CHANNEL = 'app:getHeaderHeight'

beforeEach(() => {
  stub.handlers.clear()
  stub.ipcMain.handle.mockClear()
  vi.resetModules()
})

/** Minimal ctx accepted by `registerAppIpc` (Pick<…>). */
function makeAppCtx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    preloadPath: '/tmp/preload.js',
    brandingProvider: undefined,
    appName: 'Test App',
    senderPolicy: undefined,
    ...overrides,
  }
}

describe('headerHeight decommission: registerAppIpc drops app:getHeaderHeight', () => {
  it('registers NO handler on the legacy app:getHeaderHeight channel', async () => {
    const { registerAppIpc } = await import('./app.js')

    const disposable = registerAppIpc(makeAppCtx() as never)

    expect(
      stub.handlers.has(LEGACY_CHANNEL),
      'registerAppIpc must not register app:getHeaderHeight — a live handler lets renderers keep fetching a height the layout no longer honors',
    ).toBe(false)

    await (disposable as { dispose: () => Promise<void> }).dispose()
  })

  it('stays unregistered even when a stale ctx still carries headerHeight: 72', async () => {
    const { registerAppIpc } = await import('./app.js')

    // A host (or stale context shape) sneaking the field back in must not
    // resurrect the channel via conditional registration.
    const disposable = registerAppIpc(makeAppCtx({ headerHeight: 72 }) as never)

    expect(
      stub.handlers.has(LEGACY_CHANNEL),
      'the channel must be gone unconditionally, not only when ctx lacks headerHeight',
    ).toBe(false)

    await (disposable as { dispose: () => Promise<void> }).dispose()
  })

  it('sanity: the surviving app channel (GetBranding) is still registered', async () => {
    const { registerAppIpc } = await import('./app.js')
    const { AppChannel } = await import('../../shared/ipc-channels.js')

    const disposable = registerAppIpc(makeAppCtx() as never)

    // Guards against "test passes because registerAppIpc registered nothing".
    // (GetPreloadPath was decommissioned with the renderer's dead preloadPath
    // pipe — see dead-channels-decommission.test.ts — so GetBranding is the
    // remaining anchor.)
    expect(stub.handlers.has(AppChannel.GetBranding)).toBe(true)

    await (disposable as { dispose: () => Promise<void> }).dispose()
  })
})
