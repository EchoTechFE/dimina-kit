/**
 * `AllocatePlacementGeneration` — the renderer bootstrap's seed pull for
 * renderer-placement-generation.ts (see that file's header for why the seed
 * is main-assigned rather than derived from `Date.now()`). Guards:
 *  - the wire name is the literal 'view:allocate-placement-generation';
 *  - it is an ipcMain.HANDLE (invoke round-trip), not fire-and-forget;
 *  - the handler delegates to `ctx.views.allocatePlacementGeneration()` live;
 *  - it rides the SAME senderPolicy-gated IpcRegistry as PlacementSnapshot /
 *    HostToolbarGetHeight — only the trusted main renderer may seed itself.
 *
 * Electron stub: same handle-capturing pattern as
 * views-host-toolbar-get-height.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stub = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => unknown
  const handlers = new Map<string, Handler>()
  const listeners = new Map<string, Handler>()
  return {
    handlers,
    listeners,
    ipcMain: {
      handle: vi.fn((channel: string, fn: Handler) => { handlers.set(channel, fn) }),
      removeHandler: vi.fn((channel: string) => { handlers.delete(channel) }),
      on: vi.fn((channel: string, fn: Handler) => { listeners.set(channel, fn) }),
      removeListener: vi.fn((channel: string) => { listeners.delete(channel) }),
    },
  }
})

vi.mock('electron', () => ({
  ipcMain: stub.ipcMain,
  default: { ipcMain: stub.ipcMain },
}))

import { registerViewsIpc } from './views.js'
import { ViewChannel } from '../../shared/ipc-channels-overlays.js'

const ALLOCATE_CHANNEL = 'view:allocate-placement-generation'

beforeEach(() => {
  stub.handlers.clear()
  stub.listeners.clear()
  stub.ipcMain.handle.mockClear()
})

function makeViews(seed = 1) {
  return {
    setPlacementSnapshot: vi.fn(),
    getHostToolbarHeight: vi.fn(() => 0),
    getHostSidebarWidth: vi.fn(() => 0),
    allocatePlacementGeneration: vi.fn(() => seed),
  }
}

function makeEvent(senderId: number) {
  return { sender: { id: senderId, isDestroyed: () => false, getURL: () => 'app://stub' } }
}

describe('registerViewsIpc: view:allocate-placement-generation', () => {
  it('registers an ipcMain.handle handler on the literal wire name, matching ViewChannel.AllocatePlacementGeneration', () => {
    const views = makeViews()
    const disposable = registerViewsIpc({ views, senderPolicy: undefined } as never)

    expect(ViewChannel.AllocatePlacementGeneration).toBe(ALLOCATE_CHANNEL)
    expect(stub.handlers.has(ALLOCATE_CHANNEL)).toBe(true)
    expect(stub.listeners.has(ALLOCATE_CHANNEL)).toBe(false)

    disposable.dispose()
  })

  it('the handler returns ctx.views.allocatePlacementGeneration() live — a later call reflects the reconciler\'s advanced state', async () => {
    const views = makeViews(1)
    const disposable = registerViewsIpc({ views, senderPolicy: undefined } as never)
    const handler = stub.handlers.get(ALLOCATE_CHANNEL)!

    await expect(Promise.resolve(handler(makeEvent(1)))).resolves.toBe(1)

    views.allocatePlacementGeneration.mockReturnValue(502)
    await expect(Promise.resolve(handler(makeEvent(1)))).resolves.toBe(502)

    disposable.dispose()
  })

  it('rides the senderPolicy gate — only the trusted main renderer may seed itself', async () => {
    const TRUSTED = 1
    const senderPolicy = (sender: { id: number }) => sender.id === TRUSTED
    const views = makeViews(1)
    const disposable = registerViewsIpc({ views, senderPolicy } as never)
    const handler = stub.handlers.get(ALLOCATE_CHANNEL)!

    await expect(Promise.resolve(handler(makeEvent(TRUSTED)))).resolves.toBe(1)

    views.allocatePlacementGeneration.mockClear()
    await expect(Promise.resolve(handler(makeEvent(999)))).rejects.toThrow(/sender rejected/i)
    expect(views.allocatePlacementGeneration).not.toHaveBeenCalled()

    disposable.dispose()
  })
})
