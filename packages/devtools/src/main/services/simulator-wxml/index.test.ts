/**
 * Behavior tests for setupSimulatorWxml.
 *
 * Native-host WXML panel service. Mirrors simulator-storage's main→renderer
 * contract:
 *   - PULL: answers `SimulatorWxmlChannel.GetSnapshot` by reading the active
 *     render guest's WXML tree via the injected RenderInspector.
 *   - PUSH: on bridge render-side activity (domReady / active-page), pulls the
 *     tree and pushes it to the renderer host via `SimulatorWxmlChannel.Event`.
 *
 * We mock electron's ipcMain (capturing the handler so we can invoke it) and
 * pass fake bridge/inspector/host objects. We do NOT exercise a real renderer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Electron stub (hoisted so vi.mock factory can reference it) ─────────
const stub = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => unknown
  const ipcHandlers = new Map<string, Handler>()

  const ipcMainStub = {
    handle: vi.fn((channel: string, fn: Handler) => {
      ipcHandlers.set(channel, fn)
    }),
    removeHandler: vi.fn((channel: string) => {
      ipcHandlers.delete(channel)
    }),
  }

  return { ipcHandlers, ipcMainStub }
})

const { ipcHandlers, ipcMainStub } = stub

vi.mock('electron', () => ({
  ipcMain: stub.ipcMainStub,
  app: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { getAllWebContents: vi.fn(() => []) },
  BrowserWindow: class {},
}))

// Import AFTER the mock so the module picks up the stubs.
import type { BridgeRouterHandle, RenderEvent } from '../../ipc/bridge-router.js'
import type { RenderInspector } from '../render-inspect/index.js'
import { SimulatorWxmlChannel } from '../../../shared/ipc-channels.js'
import { setupSimulatorWxml } from './index.js'

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown

function getHandler(channel: string): IpcHandler {
  const fn = ipcHandlers.get(channel)
  if (!fn) throw new Error(`no ipc handler registered for ${channel}`)
  return fn as IpcHandler
}

function makeHost() {
  return {
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  } as unknown as Electron.WebContents
}

const FAKE_WC = { id: 42 } as unknown as Electron.WebContents

/**
 * Mock BridgeRouterHandle. `onRenderEvent` captures the listener so a test can
 * fire a synthetic render event, and returns an unsubscribe spy so the dispose
 * test can assert it ran. `getActiveRenderWc` is overridable per test.
 */
function makeBridge() {
  const unsubscribe = vi.fn()
  let listener: ((event: RenderEvent) => void) | null = null
  const bridge = {
    isNativeHost: vi.fn(() => true),
    resolveRenderWc: vi.fn(() => null),
    getServiceWc: vi.fn(() => null),
    getActiveBridgeId: vi.fn(() => null),
    getActiveRenderWc: vi.fn((_appId?: string) => FAKE_WC as Electron.WebContents | null),
    onRenderEvent: vi.fn((cb: (event: RenderEvent) => void) => {
      listener = cb
      return unsubscribe
    }),
  } satisfies BridgeRouterHandle
  return {
    bridge,
    unsubscribe,
    fireRenderEvent: (event: RenderEvent) => {
      if (!listener) throw new Error('onRenderEvent listener not captured')
      listener(event)
    },
  }
}

function makeInspector() {
  return {
    getWxml: vi.fn(async () => ({ tagName: 'view', attrs: {}, children: [] })),
    highlight: vi.fn(async () => null),
    unhighlight: vi.fn(async () => {}),
  } satisfies RenderInspector
}

beforeEach(() => {
  ipcHandlers.clear()
  ipcMainStub.handle.mockClear()
  ipcMainStub.removeHandler.mockClear()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('setupSimulatorWxml — registration', () => {
  it('registers ipcMain.handle for GetSnapshot and returns a Disposable', () => {
    const { bridge } = makeBridge()
    const d = setupSimulatorWxml(makeHost(), {
      bridge,
      inspector: makeInspector(),
      getActiveAppId: () => 'wx123',
    })
    expect(ipcMainStub.handle).toHaveBeenCalledWith(
      SimulatorWxmlChannel.GetSnapshot,
      expect.any(Function),
    )
    expect(typeof d.dispose).toBe('function')
    void d.dispose()
  })

  it('subscribes to bridge.onRenderEvent', () => {
    const { bridge } = makeBridge()
    const d = setupSimulatorWxml(makeHost(), {
      bridge,
      inspector: makeInspector(),
      getActiveAppId: () => 'wx123',
    })
    expect(bridge.onRenderEvent).toHaveBeenCalledWith(expect.any(Function))
    void d.dispose()
  })
})

describe('setupSimulatorWxml — GetSnapshot (pull)', () => {
  it('resolves inspector.getWxml(active render wc)', async () => {
    const { bridge } = makeBridge()
    const inspector = makeInspector()
    const tree = { tagName: 'page', attrs: {}, children: [] }
    inspector.getWxml.mockResolvedValueOnce(tree)

    const d = setupSimulatorWxml(makeHost(), {
      bridge,
      inspector,
      getActiveAppId: () => 'wx123',
    })

    const result = await getHandler(SimulatorWxmlChannel.GetSnapshot)({})

    expect(inspector.getWxml).toHaveBeenCalledWith(FAKE_WC)
    expect(result).toEqual(tree)
    void d.dispose()
  })

  it('passes getActiveAppId() through to bridge.getActiveRenderWc', async () => {
    const { bridge } = makeBridge()
    const inspector = makeInspector()
    const d = setupSimulatorWxml(makeHost(), {
      bridge,
      inspector,
      getActiveAppId: () => 'wxABC',
    })

    await getHandler(SimulatorWxmlChannel.GetSnapshot)({})

    expect(bridge.getActiveRenderWc).toHaveBeenCalledWith('wxABC')
    void d.dispose()
  })

  it('resolves null and does NOT call inspector.getWxml when active wc is null', async () => {
    const { bridge } = makeBridge()
    bridge.getActiveRenderWc.mockReturnValue(null)
    const inspector = makeInspector()
    const d = setupSimulatorWxml(makeHost(), {
      bridge,
      inspector,
      getActiveAppId: () => 'wx123',
    })

    const result = await getHandler(SimulatorWxmlChannel.GetSnapshot)({})

    expect(result).toBeNull()
    expect(inspector.getWxml).not.toHaveBeenCalled()
    void d.dispose()
  })
})

describe('setupSimulatorWxml — render event (push)', () => {
  it('pushes the tree to host.send on a domReady event', async () => {
    const { bridge, fireRenderEvent } = makeBridge()
    const inspector = makeInspector()
    const tree = { tagName: 'page', attrs: {}, children: [] }
    inspector.getWxml.mockResolvedValue(tree)
    const host = makeHost()

    const d = setupSimulatorWxml(host, {
      bridge,
      inspector,
      getActiveAppId: () => 'wx123',
    })

    fireRenderEvent({ kind: 'domReady', appId: 'wx123', bridgeId: 'bridge_1' })
    // The push pulls the tree asynchronously; let microtasks drain.
    await vi.waitFor(() => {
      expect(inspector.getWxml).toHaveBeenCalledWith(FAKE_WC)
      expect(host.send).toHaveBeenCalledWith(SimulatorWxmlChannel.Event, tree)
    })
    void d.dispose()
  })

  it('does NOT call host.send when the host is destroyed', async () => {
    const { bridge, fireRenderEvent } = makeBridge()
    const inspector = makeInspector()
    const host = makeHost()
    ;(host.isDestroyed as ReturnType<typeof vi.fn>).mockReturnValue(true)

    const d = setupSimulatorWxml(host, {
      bridge,
      inspector,
      getActiveAppId: () => 'wx123',
    })

    fireRenderEvent({ kind: 'domReady', appId: 'wx123', bridgeId: 'bridge_1' })
    // Give any async pull a chance to (wrongly) reach host.send.
    await Promise.resolve()
    await Promise.resolve()

    expect(host.send).not.toHaveBeenCalled()
    void d.dispose()
  })
})

describe('setupSimulatorWxml — dispose', () => {
  it('unsubscribes onRenderEvent and removes the IPC handler', async () => {
    const { bridge, unsubscribe } = makeBridge()
    const d = setupSimulatorWxml(makeHost(), {
      bridge,
      inspector: makeInspector(),
      getActiveAppId: () => 'wx123',
    })
    expect(ipcHandlers.has(SimulatorWxmlChannel.GetSnapshot)).toBe(true)

    await d.dispose()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(ipcMainStub.removeHandler).toHaveBeenCalledWith(SimulatorWxmlChannel.GetSnapshot)
    expect(ipcHandlers.has(SimulatorWxmlChannel.GetSnapshot)).toBe(false)
  })
})
