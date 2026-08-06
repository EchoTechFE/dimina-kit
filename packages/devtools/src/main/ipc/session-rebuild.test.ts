/**
 * `project:rebuild` IPC — the popover "重新编译" button's channel to a real
 * compiler recompile. Today the button only re-mounts the simulator against
 * whatever the compiler last produced, so with autoBuild off (or a dead
 * watcher) clicking it after an edit shows nothing new.
 *
 * Contract under test (registerSessionIpc in ./session.js):
 *  - `ProjectChannel.Rebuild` forwards to the active session's `rebuild()`.
 *  - No active session → the invoke rejects (there is nothing to recompile).
 *  - An active session whose adapter never implemented `rebuild` (a
 *    host-supplied CompilationAdapter predating this feature) must NOT
 *    reject — the handler degrades instead of breaking a custom adapter, and
 *    the degraded result must be distinguishable from a real success so the
 *    renderer can fall back to its pre-existing reattach-only relaunch.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectChannel } from '../../shared/ipc-channels.js'

// Read via a loose cast: `Rebuild` does not exist on ProjectChannel's type yet
// (that's exactly the missing contract this file pins), so a direct typed
// property access would fail `tsc` before the runtime assertion ever runs.
const REBUILD_CHANNEL = (ProjectChannel as unknown as Record<string, string>).Rebuild

const stub = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => unknown
  const handled = new Map<string, Handler>()
  return {
    handled,
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
  ipcMain: stub.ipcMain,
  default: { ipcMain: stub.ipcMain },
}))

beforeEach(() => {
  stub.handled.clear()
  stub.ipcMain.handle.mockClear()
})

interface FakeSession {
  rebuild?: () => Promise<void>
}

async function setupSessionIpc(getSession: () => FakeSession | null) {
  const { registerSessionIpc } = await import('./session.js')
  const disposable = registerSessionIpc({
    workspace: { getSession } as never,
    senderPolicy: undefined,
  } as never)
  const handler = stub.handled.get(REBUILD_CHANNEL)
  expect(handler, 'registerSessionIpc must register a handler for ProjectChannel.Rebuild').toBeDefined()
  return { handler: handler!, disposable }
}

describe('registerSessionIpc: project:rebuild forwards to the active session', () => {
  it('invokes the active session\'s rebuild() and resolves once it does', async () => {
    const rebuild = vi.fn(async () => {})
    const { handler, disposable } = await setupSessionIpc(() => ({ rebuild }))

    await handler({})

    expect(rebuild, 'the handler must call the session\'s own rebuild(), not reimplement recompilation').toHaveBeenCalledTimes(1)
    await disposable.dispose()
  })

  it('propagates a rebuild() rejection to the invoke caller (renderer surfaces the compile error)', async () => {
    const rebuild = vi.fn(async () => { throw new Error('syntax error: unexpected token') })
    const { handler, disposable } = await setupSessionIpc(() => ({ rebuild }))

    await expect(Promise.resolve(handler({}))).rejects.toThrow(/unexpected token/)
    await disposable.dispose()
  })

  it('rejects when there is no active session — nothing to recompile', async () => {
    const { handler, disposable } = await setupSessionIpc(() => null)

    await expect(Promise.resolve(handler({}))).rejects.toBeTruthy()
    await disposable.dispose()
  })

  it('does NOT reject when the active session has no rebuild() (older/custom adapter) — degrades instead', async () => {
    const { handler, disposable } = await setupSessionIpc(() => ({})) // no rebuild method at all

    let rejected = false
    const result = await Promise.resolve(handler({})).catch(() => { rejected = true; return undefined })

    expect(
      rejected,
      'a session without rebuild() must degrade gracefully — the renderer\'s legacy reattach-only relaunch is the fallback, not a thrown error',
    ).toBe(false)
    // The degraded result must be distinguishable from a genuine success so
    // the renderer knows to skip waiting on a real recompile.
    const isDiscernibleUnsupported =
      result === undefined ||
      (typeof result === 'object' && result !== null && (result as { supported?: unknown }).supported === false)
    expect(
      isDiscernibleUnsupported,
      'the "unsupported" outcome must be discernible (e.g. undefined or { supported: false }), not an opaque truthy value',
    ).toBe(true)
    await disposable.dispose()
  })
})
