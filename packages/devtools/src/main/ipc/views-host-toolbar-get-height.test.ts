/**
 * Host-toolbar height replay — IPC half. `registerViewsIpc` must register an
 * INVOKE handler `view:host-toolbar:get-height` that returns the ViewManager's
 * retained last-notified toolbar height (`views.getHostToolbarHeight()` — the
 * new getter pinned in
 * src/main/services/views/host-toolbar-height-retention.test.ts).
 *
 * Why this channel exists: the height chain is push-only today
 * (`HostToolbarHeightChanged` notify), and the main-window renderer's listener
 * mounts strictly AFTER the project view mounts — any notify that fired before
 * that (cold start on the project list; ALWAYS on close-project → reopen) is
 * permanently lost because the toolbar's size-advertiser deduplicates and
 * never re-reports. The renderer needs a pull channel to replay the retained
 * value on mount.
 *
 * Locked contract:
 *  - the wire name is the string literal 'view:host-toolbar:get-height'
 *    (asserted literally, not via the enum, so re-registering a different wire
 *    under the same constant is also caught; the `ViewChannel.HostToolbarGetHeight`
 *    entry carries this exact string);
 *  - it is an ipcMain.HANDLE registration (invoke round-trip — the renderer
 *    needs the value back), not a fire-and-forget `on`;
 *  - the handler delegates to `ctx.views.getHostToolbarHeight()` (live, not
 *    captured at registration time);
 *  - it rides the SAME senderPolicy-gated IpcRegistry as HostToolbarBounds
 *    (GetBranding precedent in app.ts) — the toolbar WCV's own arbitrary
 *    content must NOT be able to reach it, only the trusted main renderer.
 *
 * Electron stub: same handle-capturing pattern as
 * app-no-header-height-channel.test.ts.
 *
 * Guards that views.ts registers this pull channel.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── electron stub: capture ipcMain.handle registrations by channel ──────────
const stub = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => unknown
  const handlers = new Map<string, Handler>()
  const listeners = new Map<string, Handler>()
  return {
    handlers,
    listeners,
    ipcMain: {
      handle: vi.fn((channel: string, fn: Handler) => {
        handlers.set(channel, fn)
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel)
      }),
      on: vi.fn((channel: string, fn: Handler) => {
        listeners.set(channel, fn)
      }),
      removeListener: vi.fn((channel: string) => {
        listeners.delete(channel)
      }),
    },
  }
})

vi.mock('electron', () => ({
  ipcMain: stub.ipcMain,
  default: { ipcMain: stub.ipcMain },
}))

import { registerViewsIpc } from './views.js'
import { ViewChannel } from '../../shared/ipc-channels.js'

// Future wire name, asserted literally on purpose (see header).
const GET_HEIGHT_CHANNEL = 'view:host-toolbar:get-height'

beforeEach(() => {
  stub.handlers.clear()
  stub.listeners.clear()
  stub.ipcMain.handle.mockClear()
  stub.ipcMain.on.mockClear()
})

/** Minimal `views` stub satisfying registerViewsIpc's runtime needs. */
function makeViews(height = 48) {
  return {
    setPlacementSnapshot: vi.fn(),
    setHostToolbarHeight: vi.fn(),
    getHostToolbarWebContentsId: vi.fn(() => 7),
    // The retention getter under test (pinned in
    // host-toolbar-height-retention.test.ts). Mutable so the live-delegation
    // test can move it after registration.
    getHostToolbarHeight: vi.fn(() => height),
  }
}

/** Fake invoke event: frame-unaware stub → IpcRegistry's main-frame check passes. */
function makeEvent(senderId: number) {
  return {
    sender: {
      id: senderId,
      isDestroyed: () => false,
      getURL: () => 'app://stub',
    },
  }
}

describe('registerViewsIpc: view:host-toolbar:get-height (height replay pull channel)', () => {
  it('registers an ipcMain.handle handler on the literal wire name', () => {
    const views = makeViews()
    const disposable = registerViewsIpc({ views, senderPolicy: undefined } as never)

    expect(
      stub.handlers.has(GET_HEIGHT_CHANNEL),
      'registerViewsIpc must handle view:host-toolbar:get-height — without it the renderer cannot replay the retained toolbar height on mount and the close→reopen strip stays collapsed at 0',
    ).toBe(true)
    // Invoke semantics, not fire-and-forget: must NOT be an ipcMain.on listener.
    expect(stub.listeners.has(GET_HEIGHT_CHANNEL)).toBe(false)

    disposable.dispose()
  })

  it('the handler returns ctx.views.getHostToolbarHeight() — live delegation, not a snapshot', async () => {
    const views = makeViews(48)
    const disposable = registerViewsIpc({ views, senderPolicy: undefined } as never)

    const handler = stub.handlers.get(GET_HEIGHT_CHANNEL)
    expect(typeof handler, `no handler registered on ${GET_HEIGHT_CHANNEL}`).toBe('function')

    await expect(Promise.resolve(handler!(makeEvent(1)))).resolves.toBe(48)

    // The retained value moves (a new advertise landed) — the channel must
    // reflect the CURRENT getter result, not a value captured at registration.
    views.getHostToolbarHeight.mockReturnValue(64)
    await expect(Promise.resolve(handler!(makeEvent(1)))).resolves.toBe(64)

    disposable.dispose()
  })

  it('rides the senderPolicy gate — same trust surface as HostToolbarBounds', async () => {
    // The toolbar WCV hosts ARBITRARY downstream content and is deliberately
    // NOT in the global sender policy (see views.ts blast-radius comment). The
    // new pull channel must sit behind the SAME IpcRegistry policy gate as
    // HostToolbarBounds — registering it as a raw ungated ipcMain.handle would
    // hand untrusted content a new channel.
    const TRUSTED = 1
    const senderPolicy = (sender: { id: number }) => sender.id === TRUSTED
    const views = makeViews(48)
    const disposable = registerViewsIpc({ views, senderPolicy } as never)

    const handler = stub.handlers.get(GET_HEIGHT_CHANNEL)
    expect(typeof handler, `no handler registered on ${GET_HEIGHT_CHANNEL}`).toBe('function')

    // Trusted main renderer → value comes back.
    await expect(Promise.resolve(handler!(makeEvent(TRUSTED)))).resolves.toBe(48)

    // Untrusted sender (e.g. the toolbar WCV's own content) → rejected, and
    // the getter is never consulted for it.
    views.getHostToolbarHeight.mockClear()
    await expect(Promise.resolve(handler!(makeEvent(999)))).rejects.toThrow(/sender rejected/i)
    expect(views.getHostToolbarHeight).not.toHaveBeenCalled()

    // Sanity that the gate above is the SHARED registry gate: the sibling
    // placement-snapshot handler rejects the same untrusted sender.
    const snapshotHandler = stub.handlers.get(ViewChannel.PlacementSnapshot)
    expect(typeof snapshotHandler).toBe('function')
    await expect(
      Promise.resolve(snapshotHandler!(makeEvent(999), { generation: 0, epoch: 0, views: [] })),
    ).rejects.toThrow(/sender rejected/i)

    disposable.dispose()
  })

  it('sanity: the existing views channels are still registered (targeted addition, not a rewrite)', () => {
    const views = makeViews()
    const disposable = registerViewsIpc({ views, senderPolicy: undefined } as never)

    expect(stub.handlers.has(ViewChannel.PlacementSnapshot)).toBe(true)
    expect(stub.handlers.has(ViewChannel.HostToolbarGetHeight)).toBe(true)
    // The reverse size-advertiser stays a RAW per-id-gated ipcMain.on (send,
    // not invoke) — the new pull channel must not have disturbed it.
    expect(stub.listeners.has(ViewChannel.HostToolbarAdvertiseHeight)).toBe(true)

    disposable.dispose()
  })
})
