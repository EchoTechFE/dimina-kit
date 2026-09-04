/**
 * The console/network ring buffers belong to the WINDOW a connection is
 * publishing for, not to the target-kind slot forever.
 *
 * `subscribeBuffers` always pushes onto `state.consoleLogs` /
 * `state.networkRequests`, and nothing ever clears them — so switching the
 * live connection from window A to window B leaves A's events sitting in the
 * buffer `${kind}_console_logs` / `${kind}_network_log` (and
 * `simulator_get_overview`'s summaries) hand back for B. A reconnect that
 * lands on the SAME owner (e.g. after a transient disconnect) must not lose
 * anything, so the fix is to key the buffer's contents to the owner it was
 * published for and clear on a genuine owner change, not on every publish.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface CapturedHandlers {
  url: string
  disconnect: (() => void)[]
  on: Map<string, (...args: unknown[]) => void>
}

const cdp = vi.hoisted(() => ({
  listed: [] as { type: string; url: string }[],
  connectedTo: [] as string[],
  clients: [] as CapturedHandlers[],
}))

vi.mock('chrome-remote-interface', () => {
  const CDP = Object.assign(
    vi.fn(async ({ target }: { target: { url: string } }) => {
      cdp.connectedTo.push(target.url)
      const captured: CapturedHandlers = { url: target.url, disconnect: [], on: new Map() }
      cdp.clients.push(captured)
      return {
        Page: { enable: async () => {} },
        Runtime: {
          enable: async () => {},
          on: (event: string, cb: (...args: unknown[]) => void) => captured.on.set(`Runtime.${event}`, cb),
        },
        DOM: { enable: async () => {} },
        Network: {
          enable: async () => {},
          on: (event: string, cb: (...args: unknown[]) => void) => captured.on.set(`Network.${event}`, cb),
        },
        Console: {
          enable: async () => {},
          on: (event: string, cb: (...args: unknown[]) => void) => captured.on.set(`Console.${event}`, cb),
        },
        on: (event: string, cb: () => void) => { if (event === 'disconnect') captured.disconnect.push(cb) },
        close: async () => {},
      }
    }),
    { List: vi.fn(async () => cdp.listed) },
  )
  return { default: CDP }
})

async function loadTargetManager() {
  vi.resetModules()
  return await import('./target-manager.js')
}

const shellUrl = (appId: string) => `http://localhost:7788/simulator.html?appId=${appId}`

function emitConsoleLog(client: CapturedHandlers, text: string) {
  client.on.get('Runtime.consoleAPICalled')?.({ type: 'log', args: [{ value: text }], timestamp: Date.now() })
}

function emitNetworkRequest(client: CapturedHandlers, url: string) {
  const requestId = `req-${url}`
  client.on.get('Network.requestWillBeSent')?.({ requestId, request: { url, method: 'GET' }, timestamp: 0 })
  client.on.get('Network.responseReceived')?.({
    requestId,
    response: { status: 200, mimeType: 'text/plain', encodedDataLength: 10 },
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  cdp.listed = []
  cdp.connectedTo = []
  cdp.clients = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('buffers scoped to the connection owner', () => {
  it('drops the previous owner`s console/network entries when the live connection re-aims at a different window', async () => {
    const tm = await loadTargetManager()
    const a = {}
    const b = {}
    tm.registerMcpWindow(a, {
      nativeHost: false, activeBridgeId: null, nativeOverviewProvider: null,
      projectPath: '/proj/a', getAppId: () => 'app-a',
    })
    tm.registerMcpWindow(b, {
      nativeHost: false, activeBridgeId: null, nativeOverviewProvider: null,
      projectPath: '/proj/b', getAppId: () => 'app-b',
    })

    tm.setActiveMcpWindowResolver(() => a)
    cdp.listed = [{ type: 'page', url: shellUrl('app-a') }]
    await tm.connectTarget('simulator')
    emitConsoleLog(cdp.clients[0], 'hello from A')
    emitNetworkRequest(cdp.clients[0], 'https://a.example/data')

    expect(tm.getTargetState('simulator').consoleLogs.length).toBe(1)
    expect(tm.getTargetState('simulator').networkRequests.length).toBe(1)

    tm.setActiveMcpWindowResolver(() => b)
    cdp.listed = [{ type: 'page', url: shellUrl('app-b') }]
    await tm.connectTarget('simulator')

    expect(
      tm.getTargetState('simulator').consoleLogs,
      'B must not inherit A`s console entries just because they share the simulator buffer slot',
    ).toEqual([])
    expect(
      tm.getTargetState('simulator').networkRequests,
      'B must not inherit A`s network entries just because they share the simulator buffer slot',
    ).toEqual([])
  })

  it('keeps buffered entries across a disconnect/reconnect that lands on the same owner', async () => {
    const tm = await loadTargetManager()
    const a = {}
    tm.registerMcpWindow(a, {
      nativeHost: false, activeBridgeId: null, nativeOverviewProvider: null,
      projectPath: '/proj/a', getAppId: () => 'app-a',
    })
    tm.setActiveMcpWindowResolver(() => a)
    cdp.listed = [{ type: 'page', url: shellUrl('app-a') }]
    await tm.connectTarget('simulator')
    emitConsoleLog(cdp.clients[0], 'hello from A')

    // Simulate the transport dropping: fires `disconnect`, which schedules a
    // reconnect back onto the same still-active owner A.
    cdp.clients[0].disconnect.forEach((cb) => cb())
    await vi.advanceTimersByTimeAsync(3000)

    expect(
      tm.getTargetState('simulator').consoleLogs,
      'a reconnect that lands back on the SAME owner must not discard what was already collected for it',
    ).toEqual([expect.objectContaining({ text: 'hello from A' })])
  })
})
