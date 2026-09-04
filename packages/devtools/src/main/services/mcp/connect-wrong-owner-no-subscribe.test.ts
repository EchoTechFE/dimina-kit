/**
 * A connection that reaches a target it cannot attribute to the active window
 * must leave no trace behind it.
 *
 * MCP exposes exactly ONE client per target kind, so a connection that landed
 * on the wrong window's surface still has its console/network buffers wired up
 * and is still reported as `connected` — the retry that follows only layers a
 * correct attempt on top, it never undoes either. Until the retry lands,
 * `getClient` hands out a client whose events belong to a different project,
 * and the buffers it already collected stay mixed into the ones the eventual
 * correct connection appends to.
 *
 * The fix: a wrong-owner connection closes its client and subscribes nothing,
 * exactly as if no target had been found at all — the retry cadence is the
 * only thing that carries over.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeClient {
  closed: boolean
  subscribedEvents: string[]
}

const cdp = vi.hoisted(() => ({
  listed: [] as { type: string; url: string }[],
  connectedTo: [] as string[],
  clients: [] as FakeClient[],
}))

vi.mock('chrome-remote-interface', () => {
  const CDP = Object.assign(
    vi.fn(async ({ target }: { target: { url: string } }) => {
      cdp.connectedTo.push(target.url)
      const fake: FakeClient = { closed: false, subscribedEvents: [] }
      cdp.clients.push(fake)
      const record = (event: string) => fake.subscribedEvents.push(event)
      return {
        Page: { enable: async () => {} },
        Runtime: { enable: async () => {}, on: (event: string) => record(`Runtime.${event}`) },
        DOM: { enable: async () => {} },
        Network: { enable: async () => {}, on: (event: string) => record(`Network.${event}`) },
        Console: { enable: async () => {}, on: (event: string) => record(`Console.${event}`) },
        on: () => {},
        close: async () => {
          fake.closed = true
        },
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

beforeEach(() => {
  vi.useFakeTimers()
  cdp.listed = []
  cdp.connectedTo = []
  cdp.clients = []
})

afterEach(() => {
  vi.useRealTimers()
})

/**
 * B is the active window, but neither window has a render guest yet, so the
 * only simulator surface the CDP list offers is A's shell — the one target this
 * connection can reach belongs to a window other than the one MCP means to
 * drive.
 */
async function connectToWrongOwner() {
  const tm = await loadTargetManager()
  const a = {}
  tm.registerMcpWindow(a, {
    nativeHost: true, activeBridgeId: null, nativeOverviewProvider: null,
    projectPath: '/proj/a', getAppId: () => 'app-a',
  })
  const b = {}
  tm.registerMcpWindow(b, {
    nativeHost: true, activeBridgeId: 'bridge-b', nativeOverviewProvider: null,
    projectPath: '/proj/b', getAppId: () => 'app-b',
  })
  tm.setActiveMcpWindowResolver(() => b)
  cdp.listed = [{ type: 'page', url: shellUrl('app-a') }]

  await tm.connectTarget('simulator')
  return tm
}

describe('a connection that reaches a target belonging to another window', () => {
  it('closes the client and subscribes no buffers instead of leaving a wrong-owner connection live', async () => {
    const tm = await connectToWrongOwner()

    expect(cdp.connectedTo).toEqual([shellUrl('app-a')])
    const client = cdp.clients[0]
    expect(
      client.closed,
      "a client that reached another window's target must be closed rather than kept open as the live connection",
    ).toBe(true)
    expect(
      client.subscribedEvents,
      'no console/network buffer should ever be wired up for a connection that is not on the window MCP means to drive',
    ).toEqual([])
    expect(
      tm.getTargetState('simulator').connected,
      'a wrong-owner target must not be reported as the live connection',
    ).toBe(false)
    expect(
      tm.getTargetState('simulator').client,
      'no client should be retained in state once its target is known to belong to another window',
    ).toBeNull()
  })

  it('keeps retrying on the usual interval, the same as when no target was found at all', async () => {
    await connectToWrongOwner()

    cdp.connectedTo = []
    await vi.advanceTimersByTimeAsync(3000)

    expect(
      cdp.connectedTo,
      'closing the wrong-owner connection must not also cancel the retry that eventually reaches the right window',
    ).toEqual([shellUrl('app-a')])
  })
})
