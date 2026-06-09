import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SimulatorCustomApiBridgeChannel } from '../../shared/ipc-channels.js'

// custom-apis.ts has no module-level state, but each test wants a fresh
// `buildBridge()` closure (its own `pending` map / id counter), so the module
// is re-imported per test. electron must be mocked before any import (vi.mock
// is hoisted).

const send = vi.fn()
let responseHandler: ((event: unknown, payload: unknown) => void) | undefined

vi.mock('electron', () => ({
  // Throwing forces `exposeOnMainWorld` down its fallback path, which assigns
  // the bridge straight onto `window` so the test can read it back.
  contextBridge: {
    exposeInMainWorld: vi.fn(() => {
      throw new Error('contextIsolation is not enabled')
    }),
  },
  ipcRenderer: {
    on: (channel: string, handler: (event: unknown, payload: unknown) => void) => {
      if (channel === SimulatorCustomApiBridgeChannel.Response) responseHandler = handler
    },
    // native-host is the sole runtime: the bridge sends Requests straight to
    // ipcMain via `ipcRenderer.send` (no `<webview>` embedder to `sendToHost`).
    send: (...args: unknown[]) => send(...args),
  },
}))

interface ListRequest { id: number; op: string }

/** Pull the requests sent so far on the bridge `Request` channel. */
function sentRequests(): ListRequest[] {
  return send.mock.calls
    .filter(([channel]) => channel === SimulatorCustomApiBridgeChannel.Request)
    .map(([, req]) => req as ListRequest)
}

async function loadBridge() {
  vi.resetModules()
  const { installCustomApisBridge } = await import('./custom-apis.js')
  installCustomApisBridge()
  return (window as unknown as Record<string, unknown>).__diminaCustomApis as {
    list: () => Promise<string[]>
    invoke: (name: string, params: unknown) => Promise<unknown>
  }
}

describe('custom-apis bridge — list() re-send', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    send.mockClear()
    responseHandler = undefined
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('re-sends list() when the first request lands before the host listener attaches', async () => {
    // The bug: the simulator fires list() before the main-side `ipcMain.on`
    // listener is live, so the first `ipcRenderer.send` is dropped. Only a
    // re-send reaches a late-attaching listener.
    const bridge = await loadBridge()
    const result = bridge.list()

    // First attempt fires synchronously; the "host" is not listening yet.
    expect(sentRequests()).toHaveLength(1)

    // Host still absent across two retry intervals -> two more re-sends.
    await vi.advanceTimersByTimeAsync(320)
    const reqs = sentRequests()
    expect(reqs.length).toBeGreaterThanOrEqual(3)
    // Every attempt carries a distinct id so stale duplicate responses
    // cannot cross-resolve.
    expect(new Set(reqs.map((r) => r.id)).size).toBe(reqs.length)
    expect(reqs.every((r) => r.op === 'list')).toBe(true)

    // Host finally attaches and answers the latest re-send.
    const latest = reqs[reqs.length - 1]!
    responseHandler!({}, { id: latest.id, result: ['wx.login'] })
    await expect(result).resolves.toEqual(['wx.login'])
  })

  it('stops re-sending once a response resolves the call', async () => {
    const bridge = await loadBridge()
    const result = bridge.list()
    const firstId = sentRequests()[0]!.id

    responseHandler!({}, { id: firstId, result: [] })
    await expect(result).resolves.toEqual([])

    // No further re-sends after the call settled.
    const countAfterResolve = sentRequests().length
    await vi.advanceTimersByTimeAsync(1000)
    expect(sentRequests()).toHaveLength(countAfterResolve)
  })

  it('rejects when the host proxy never responds (ceiling reached)', async () => {
    const bridge = await loadBridge()
    const result = bridge.list()
    const rejection = expect(result).rejects.toThrow(/no response/)

    await vi.advanceTimersByTimeAsync(3000)
    await rejection

    // No re-sends keep firing past the ceiling.
    const countAtCeiling = sentRequests().length
    await vi.advanceTimersByTimeAsync(1000)
    expect(sentRequests()).toHaveLength(countAtCeiling)
  })

  it('does not re-send invoke() — non-idempotent calls fire exactly once', async () => {
    const bridge = await loadBridge()
    void bridge.invoke('wx.login', { code: 1 })

    const before = send.mock.calls.length
    await vi.advanceTimersByTimeAsync(2000)
    expect(send.mock.calls.length).toBe(before)
  })
})
