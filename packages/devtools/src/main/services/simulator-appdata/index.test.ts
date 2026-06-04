/**
 * Behavior tests for setupSimulatorAppData.
 *
 * Native-host AppData panel service. Mirrors simulator-storage / simulator-wxml's
 * main→renderer contract, but the source of truth is the SHARED
 * `AppDataAccumulator` (one per appId), fed from the service→render message
 * stream:
 *   - PULL: answers `SimulatorAppDataChannel.GetSnapshot` with the ACTIVE app's
 *     `accumulator.snapshot()` (empty snapshot when the active app has no data).
 *   - PUSH: on each accepted message / bridge eviction for the ACTIVE app,
 *     pushes `accumulator.snapshot()` via `SimulatorAppDataChannel.Event`.
 *
 * We mock electron's ipcMain (capturing the GetSnapshot handler so we can invoke
 * it directly) and pass a fake host with a `send` spy. The shared accumulator is
 * NOT mocked — we let it decode/merge for real and assert on snapshot contents.
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
import type { MessageEnvelope } from '../../../shared/bridge-channels.js'
import type { AppDataSnapshot } from '../../../shared/appdata-accumulator.js'
import { SimulatorAppDataChannel } from '../../../shared/ipc-channels.js'
import { setupSimulatorAppData } from './index.js'

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

// ── Real service→render message fixtures (shapes the accumulator decodes) ──
const APP = 'wx123'
const OTHER = 'wxOTHER'

/** Page instance init: full initial state for a page bridge. */
function pageInit(bridgeId: string, path: string, data: Record<string, unknown>): MessageEnvelope {
  return { type: 'page_1', target: 'render', body: { bridgeId, path, data } }
}

/** Update batch: a partial setData patch onto a page moduleId. */
function updateBatch(
  bridgeId: string,
  moduleId: string,
  data: Record<string, unknown>,
): MessageEnvelope {
  return { type: 'ub', target: 'render', body: { bridgeId, updates: [{ moduleId, data }] } }
}

/** A non-AppData message: decodeWorkerMessage returns null → ignored. */
function nonAppData(bridgeId: string): MessageEnvelope {
  return { type: 'u', target: 'render', body: { bridgeId } }
}

/** Pull the snapshot argument of the most recent host.send(Event, snapshot). */
function lastPushed(host: Electron.WebContents): AppDataSnapshot {
  const send = host.send as unknown as ReturnType<typeof vi.fn>
  const calls = send.mock.calls.filter((c) => c[0] === SimulatorAppDataChannel.Event)
  if (calls.length === 0) throw new Error('host.send was never called with the Event channel')
  return calls[calls.length - 1]![1] as AppDataSnapshot
}

function eventSendCount(host: Electron.WebContents): number {
  const send = host.send as unknown as ReturnType<typeof vi.fn>
  return send.mock.calls.filter((c) => c[0] === SimulatorAppDataChannel.Event).length
}

beforeEach(() => {
  ipcHandlers.clear()
  ipcMainStub.handle.mockClear()
  ipcMainStub.removeHandler.mockClear()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('setupSimulatorAppData — registration', () => {
  it('registers ipcMain.handle for GetSnapshot and returns a Disposable', () => {
    const svc = setupSimulatorAppData(makeHost(), { getActiveAppId: () => APP })
    expect(ipcMainStub.handle).toHaveBeenCalledWith(
      SimulatorAppDataChannel.GetSnapshot,
      expect.any(Function),
    )
    expect(typeof svc.dispose).toBe('function')
    void svc.dispose()
  })
})

describe('setupSimulatorAppData — onServiceToRender (decode + accumulate + push)', () => {
  it('pushes a snapshot whose entries reflect init→ub merged data and bridges include the bridge', () => {
    const host = makeHost()
    const svc = setupSimulatorAppData(host, { getActiveAppId: () => APP })

    svc.onServiceToRender(APP, pageInit('b1', 'pages/index/index', { count: 0 }))
    svc.onServiceToRender(APP, updateBatch('b1', 'page_1', { count: 5 }))

    const snap = lastPushed(host)
    // bridge recorded with its page route
    expect(snap.bridges).toEqual([{ id: 'b1', pagePath: 'pages/index/index' }])
    // ub merged onto init under the componentPath display key
    expect(snap.entries.b1!['pages/index/index']).toEqual({ count: 5 })

    void svc.dispose()
  })

  it('does NOT call host.send for a non-active appId', () => {
    const host = makeHost()
    const svc = setupSimulatorAppData(host, { getActiveAppId: () => APP })

    svc.onServiceToRender(OTHER, pageInit('b9', 'pages/other/other', { n: 1 }))

    expect(eventSendCount(host)).toBe(0)
    void svc.dispose()
  })

  it('keeps separate accumulators per appId (non-active app accumulates without leaking into active push)', () => {
    const host = makeHost()
    const svc = setupSimulatorAppData(host, { getActiveAppId: () => APP })

    // Feed the OTHER (non-active) app — no push, and must not appear in the
    // active app's snapshot.
    svc.onServiceToRender(OTHER, pageInit('bOther', 'pages/other/other', { n: 1 }))
    // Now feed the active app — its snapshot should contain only its own bridge.
    svc.onServiceToRender(APP, pageInit('b1', 'pages/index/index', { count: 0 }))

    const snap = lastPushed(host)
    expect(snap.bridges.map((b) => b.id)).toEqual(['b1'])
    expect(snap.entries.bOther).toBeUndefined()
    void svc.dispose()
  })

  it('does NOT call host.send for a non-AppData message (decode → null → no mutation)', () => {
    const host = makeHost()
    const svc = setupSimulatorAppData(host, { getActiveAppId: () => APP })

    svc.onServiceToRender(APP, nonAppData('b1'))

    expect(eventSendCount(host)).toBe(0)
    void svc.dispose()
  })

  it('does NOT call host.send when the host is destroyed', () => {
    const host = makeHost()
    ;(host.isDestroyed as ReturnType<typeof vi.fn>).mockReturnValue(true)
    const svc = setupSimulatorAppData(host, { getActiveAppId: () => APP })

    svc.onServiceToRender(APP, pageInit('b1', 'pages/index/index', { count: 0 }))

    expect(host.send).not.toHaveBeenCalled()
    void svc.dispose()
  })
})

describe('setupSimulatorAppData — GetSnapshot (pull)', () => {
  it("returns the active app's accumulator.snapshot() with accumulated data", () => {
    const host = makeHost()
    const svc = setupSimulatorAppData(host, { getActiveAppId: () => APP })

    svc.onServiceToRender(APP, pageInit('b1', 'pages/index/index', { count: 0 }))
    svc.onServiceToRender(APP, updateBatch('b1', 'page_1', { count: 7 }))

    const result = getHandler(SimulatorAppDataChannel.GetSnapshot)({}) as AppDataSnapshot
    expect(result.bridges).toEqual([{ id: 'b1', pagePath: 'pages/index/index' }])
    expect(result.entries.b1!['pages/index/index']).toEqual({ count: 7 })
    void svc.dispose()
  })

  it('returns an EMPTY snapshot { bridges: [], entries: {} } when the active app has no data', () => {
    const host = makeHost()
    const svc = setupSimulatorAppData(host, { getActiveAppId: () => APP })

    const result = getHandler(SimulatorAppDataChannel.GetSnapshot)({})
    expect(result).toEqual({ bridges: [], entries: {} })
    void svc.dispose()
  })
})

describe('setupSimulatorAppData — evictBridge', () => {
  it('removes the bridge from the snapshot and pushes the update when active', () => {
    const host = makeHost()
    const svc = setupSimulatorAppData(host, { getActiveAppId: () => APP })

    svc.onServiceToRender(APP, pageInit('b1', 'pages/index/index', { count: 0 }))
    svc.onServiceToRender(APP, pageInit('b2', 'pages/list/list', { items: [] }))

    const before = eventSendCount(host)
    svc.evictBridge(APP, 'b1')

    // A fresh push happened…
    expect(eventSendCount(host)).toBe(before + 1)
    // …and b1 is gone while b2 remains.
    const snap = lastPushed(host)
    expect(snap.bridges.map((b) => b.id)).toEqual(['b2'])
    expect(snap.entries.b1).toBeUndefined()
    void svc.dispose()
  })
})

describe('setupSimulatorAppData — getPageData (active app reactive page data)', () => {
  it("returns the active app's accumulator.pageData(bridgeId) (init→ub merged)", () => {
    const host = makeHost()
    const svc = setupSimulatorAppData(host, { getActiveAppId: () => APP })

    svc.onServiceToRender(APP, pageInit('b1', 'pages/index/index', { count: 0, title: 'hi' }))
    svc.onServiceToRender(APP, updateBatch('b1', 'page_1', { count: 9 }))

    expect(svc.getPageData('b1')).toEqual({ count: 9, title: 'hi' })
    void svc.dispose()
  })

  it('returns {} when the bridge belongs to a different (non-active) app', () => {
    const host = makeHost()
    const svc = setupSimulatorAppData(host, { getActiveAppId: () => APP })

    // Feed the OTHER (non-active) app — its bridge must NOT be visible via the
    // active app's getPageData.
    svc.onServiceToRender(OTHER, pageInit('bOther', 'pages/other/other', { n: 1 }))

    expect(svc.getPageData('bOther')).toEqual({})
    void svc.dispose()
  })

  it('reads from whichever app is active when getActiveAppId switches', () => {
    const host = makeHost()
    let active: string | null = APP
    const svc = setupSimulatorAppData(host, { getActiveAppId: () => active })

    svc.onServiceToRender(APP, pageInit('b1', 'pages/index/index', { who: 'app' }))
    svc.onServiceToRender(OTHER, pageInit('b1', 'pages/other/other', { who: 'other' }))

    // APP active → APP's b1
    expect(svc.getPageData('b1')).toEqual({ who: 'app' })
    // switch active → OTHER's b1
    active = OTHER
    expect(svc.getPageData('b1')).toEqual({ who: 'other' })
    void svc.dispose()
  })

  it('returns {} when there is no active app (getActiveAppId null)', () => {
    const host = makeHost()
    let active: string | null = APP
    const svc = setupSimulatorAppData(host, { getActiveAppId: () => active })

    svc.onServiceToRender(APP, pageInit('b1', 'pages/index/index', { count: 0 }))

    active = null
    expect(svc.getPageData('b1')).toEqual({})
    void svc.dispose()
  })

  it('returns {} when the active app has no accumulator / no data', () => {
    const host = makeHost()
    const svc = setupSimulatorAppData(host, { getActiveAppId: () => APP })

    // No messages fed for APP → no data for any bridge.
    expect(svc.getPageData('b1')).toEqual({})
    void svc.dispose()
  })
})

describe('setupSimulatorAppData — dispose', () => {
  it('removes the GetSnapshot IPC handler', () => {
    const svc = setupSimulatorAppData(makeHost(), { getActiveAppId: () => APP })
    expect(ipcHandlers.has(SimulatorAppDataChannel.GetSnapshot)).toBe(true)

    void svc.dispose()

    expect(ipcMainStub.removeHandler).toHaveBeenCalledWith(SimulatorAppDataChannel.GetSnapshot)
    expect(ipcHandlers.has(SimulatorAppDataChannel.GetSnapshot)).toBe(false)
  })
})
