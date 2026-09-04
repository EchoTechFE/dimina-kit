/**
 * Only the newest MCP connection attempt may publish itself.
 *
 * Establishing a CDP connection is a long chain of awaits (list targets,
 * connect, enable five domains), and the reason to establish one — which window
 * is active, which page it shows — can change while that chain runs. A
 * connection that finishes after a newer one was started is aimed at a page the
 * user has already left; publishing it pins every MCP tool to that stale page,
 * and closing the live client on its way out leaves MCP reporting "not
 * connected" while a good connection existed.
 *
 * The connections here are held open deliberately: without controlling when
 * each `CDP()` resolves there is no interleaving to test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface PendingConnect {
  url: string
  resolve: () => void
  isClosed: () => boolean
}

const cdp = vi.hoisted(() => ({
  listed: [] as { type: string; url: string }[],
  attempted: [] as string[],
  pending: [] as PendingConnect[],
}))

vi.mock('chrome-remote-interface', () => {
  const noop = () => {}
  const CDP = Object.assign(
    vi.fn(async ({ target }: { target: { url: string } }) => {
      cdp.attempted.push(target.url)
      const listeners: (() => void)[] = []
      let closed = false
      const client = {
        url: target.url,
        Page: { enable: async () => {} },
        Runtime: { enable: async () => {}, on: noop },
        DOM: { enable: async () => {} },
        Network: { enable: async () => {}, on: noop },
        Console: { enable: async () => {}, on: noop },
        // A real CDP client emits `disconnect` when it is closed.
        on: (event: string, cb: () => void) => { if (event === 'disconnect') listeners.push(cb) },
        close: async () => { closed = true; for (const cb of listeners.splice(0)) cb() },
      }
      // The test decides when this connect finishes.
      await new Promise<void>((resolve) => {
        cdp.pending.push({ url: target.url, resolve, isClosed: () => closed })
      })
      return client
    }),
    { List: vi.fn(async () => cdp.listed) },
  )
  return { default: CDP }
})

async function loadTargetManager() {
  vi.resetModules()
  return await import('./target-manager.js')
}

const SHELL_URL = 'http://localhost:7788/simulator.html'
const guestUrl = (bridgeId: string) =>
  `file:///app/dist/render-host/__frame__.html?appId=x&bridgeId=${bridgeId}`

/** Let every already-resolved promise in the connect chain run. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

/** Finish the in-flight connect to `url` and hand back its record. */
async function release(url: string): Promise<PendingConnect> {
  const index = cdp.pending.findIndex((p) => p.url === url)
  if (index < 0) throw new Error(`no in-flight CDP connect to ${url}`)
  const [entry] = cdp.pending.splice(index, 1)
  entry.resolve()
  await settle()
  return entry
}

/**
 * The user works in project B; its page navigates while the connect aimed at
 * the previous page is still in flight, and that older connect finishes last.
 */
async function interleavedNavigation() {
  const tm = await loadTargetManager()
  const b = {}
  const facts = {
    nativeHost: true,
    activeBridgeId: 'bridge-b1' as string | null,
    nativeOverviewProvider: null,
    projectPath: '/proj/b',
    getAppId: () => 'app-b',
  }
  tm.registerMcpWindow(b, facts)
  tm.setActiveMcpWindowResolver(() => b)
  cdp.listed = [
    { type: 'page', url: SHELL_URL },
    { type: 'webview', url: guestUrl('bridge-b1') },
    { type: 'webview', url: guestUrl('bridge-b2') },
  ]

  const older = tm.connectTarget('simulator')
  await settle()
  expect(cdp.pending.map((p) => p.url), 'the first connect is held open').toEqual([
    guestUrl('bridge-b1'),
  ])

  // B navigates to the next page, which starts a second connect.
  facts.activeBridgeId = 'bridge-b2'
  const newer = tm.connectTarget('simulator')
  await settle()

  await release(guestUrl('bridge-b2'))
  await newer
  const stale = await release(guestUrl('bridge-b1'))
  await older

  return { tm, stale }
}

beforeEach(() => {
  vi.useFakeTimers()
  cdp.listed = []
  cdp.attempted = []
  cdp.pending = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('two MCP connection attempts overlapping', () => {
  it('leaves MCP on the page the window shows now, not the one it was leaving', async () => {
    const { tm, stale } = await interleavedNavigation()

    expect(
      (tm.getTargetState('simulator').client as unknown as { url: string } | null)?.url,
      'a connect that finishes after a newer one must not take the simulator tools back to the page the user already navigated away from',
    ).toBe(guestUrl('bridge-b2'))
    expect(
      stale.isClosed(),
      'the discarded connect owns an open CDP client; dropping it without closing leaks the connection for the life of the app',
    ).toBe(true)
  })

  it('keeps the live connection usable when the discarded one is dropped', async () => {
    const { tm } = await interleavedNavigation()

    expect(
      () => tm.getClient('simulator'),
      'closing the discarded connection must not report the live one as gone — MCP tools would refuse to run while a good connection exists',
    ).not.toThrow()

    cdp.attempted = []
    await vi.advanceTimersByTimeAsync(10_000)
    expect(
      cdp.attempted,
      'the discarded connection must not schedule a reconnect that tears the live one down again',
    ).toEqual([])
  })

  it('does not read a connection closed for re-aiming as one that was lost', async () => {
    const tm = await loadTargetManager()
    const a = {}
    const b = {}
    tm.registerMcpWindow(a, {
      nativeHost: true, activeBridgeId: 'bridge-b1', nativeOverviewProvider: null,
      projectPath: '/proj/a',
      getAppId: () => 'app-a',
    })
    tm.registerMcpWindow(b, {
      nativeHost: true, activeBridgeId: 'bridge-b2', nativeOverviewProvider: null,
      projectPath: '/proj/b',
      getAppId: () => 'app-b',
    })
    let active: object = a
    tm.setActiveMcpWindowResolver(() => active)
    cdp.listed = [
      { type: 'webview', url: guestUrl('bridge-b1') },
      { type: 'webview', url: guestUrl('bridge-b2') },
    ]

    const established = tm.connectTarget('simulator')
    await settle()
    await release(guestUrl('bridge-b1'))
    await established

    // The user moves to B: the live client is closed on purpose and the connect
    // that replaces it is held open.
    active = b
    tm.noteActiveMcpWindowChanged()
    await vi.advanceTimersByTimeAsync(200)
    expect(cdp.pending.map((p) => p.url), 'the re-aim is in flight').toEqual([
      guestUrl('bridge-b2'),
    ])

    cdp.attempted = []
    await vi.advanceTimersByTimeAsync(10_000)
    expect(
      cdp.attempted,
      'a client closed to re-aim it did not lose its target; treating it as lost arms a reconnect that races the connect already running and opens CDP clients nobody asked for',
    ).toEqual([])
  })
})
