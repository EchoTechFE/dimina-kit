/**
 * A live MCP CDP connection is bound to the window it ACTUALLY reached.
 *
 * Target selection degrades on purpose: a workbench window whose compile has
 * not recorded a project path yet has no exact target, and a page that has not
 * finished loading is not in the CDP list at all. Connecting to another
 * project's surface is better than refusing to connect. What must not happen is
 * recording that degraded connection as if it had reached the window MCP means
 * to drive — nothing then re-aims it, so every MCP tool keeps answering from
 * the other project for as long as the app stays open, no matter where the user
 * clicks.
 *
 * The mirror rule matters just as much: a connection that IS on the right
 * surface must settle, or the connection would be torn down and rebuilt every
 * few seconds and lose its buffered console and network events.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cdp = vi.hoisted(() => ({
  listed: [] as { type: string; url: string }[],
  connectedTo: [] as string[],
}))

vi.mock('chrome-remote-interface', () => {
  const noop = () => {}
  const makeClient = () => {
    const listeners: (() => void)[] = []
    return {
      Page: { enable: async () => {} },
      Runtime: { enable: async () => {}, on: noop },
      DOM: { enable: async () => {} },
      Network: { enable: async () => {}, on: noop },
      Console: { enable: async () => {}, on: noop },
      // A real CDP client emits `disconnect` when it is closed, including when
      // the manager closes it itself to re-aim.
      on: (event: string, cb: () => void) => { if (event === 'disconnect') listeners.push(cb) },
      close: async () => { for (const cb of listeners.splice(0)) cb() },
    }
  }
  const CDP = Object.assign(
    vi.fn(async ({ target }: { target: { url: string } }) => {
      cdp.connectedTo.push(target.url)
      return makeClient()
    }),
    { List: vi.fn(async () => cdp.listed) },
  )
  return { default: CDP }
})

async function loadTargetManager() {
  vi.resetModules()
  return await import('./target-manager.js')
}

const LIST_URL = 'file:///app/dist/entries/main/index.html'
const shellUrl = (appId: string) => `http://localhost:7788/simulator.html?appId=${appId}`
const workbenchUrl = (path: string) =>
  `file:///app/dist/entries/workbench/index.html?path=${encodeURIComponent(path)}&name=p`
const guestUrl = (bridgeId: string) =>
  `file:///app/dist/render-host/__frame__.html?appId=x&bridgeId=${bridgeId}`

beforeEach(() => {
  vi.useFakeTimers()
  cdp.listed = []
  cdp.connectedTo = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('an MCP connection that could not reach the active project window', () => {
  it('keeps trying until it reaches the workbench of the project the user is in', async () => {
    const tm = await loadTargetManager()
    const a = {}
    const b = {}
    tm.registerMcpWindow(a, {
      nativeHost: true, activeBridgeId: null, nativeOverviewProvider: null,
      getProjectPath: () => '/proj/a', getAppId: () => 'app-a',
    })
    // B is the window the user just opened: its compile has not recorded a
    // path, so nothing tells target selection which renderer is B's.
    let pathB = ''
    tm.registerMcpWindow(b, {
      nativeHost: true, activeBridgeId: null, nativeOverviewProvider: null,
      getProjectPath: () => pathB, getAppId: () => 'app-b',
    })
    tm.setActiveMcpWindowResolver(() => b)
    cdp.listed = [
      { type: 'page', url: LIST_URL },
      { type: 'page', url: workbenchUrl('/proj/a') },
      { type: 'page', url: workbenchUrl('/proj/b') },
    ]

    await tm.connectTarget('workbench')
    expect(
      cdp.connectedTo,
      'with no way to tell which renderer belongs to the new window, connecting to another workbench is the usable answer',
    ).toEqual([workbenchUrl('/proj/a')])

    // B's compile records its path — from here its own renderer is findable.
    pathB = '/proj/b'
    await vi.advanceTimersByTimeAsync(10_000)

    expect(
      cdp.connectedTo,
      'the connection must find its way to the project the user is working in on its own; a degraded connection recorded as if it had arrived leaves MCP driving the other project forever',
    ).toEqual([workbenchUrl('/proj/a'), workbenchUrl('/proj/b')])
  })

  it('keeps trying until the active page of that window is reachable', async () => {
    const tm = await loadTargetManager()
    const a = {}
    const b = {}
    tm.registerMcpWindow(a, {
      nativeHost: true, activeBridgeId: 'bridge-a', nativeOverviewProvider: null,
      getProjectPath: () => '/proj/a', getAppId: () => 'app-a',
    })
    tm.registerMcpWindow(b, {
      nativeHost: true, activeBridgeId: 'bridge-b', nativeOverviewProvider: null,
      getProjectPath: () => '/proj/b', getAppId: () => 'app-b',
    })
    tm.setActiveMcpWindowResolver(() => b)
    // B's page is still loading, so its render guest is not a CDP target yet.
    cdp.listed = [
      { type: 'page', url: shellUrl('app-b') },
      { type: 'webview', url: guestUrl('bridge-a') },
    ]

    await tm.connectTarget('simulator')
    expect(cdp.connectedTo).toEqual([guestUrl('bridge-a')])

    cdp.listed = [...cdp.listed, { type: 'webview', url: guestUrl('bridge-b') }]
    await vi.advanceTimersByTimeAsync(10_000)

    expect(
      cdp.connectedTo,
      'the simulator tools must end up on the page of the window the user is in once it exists, without the user having to click anywhere',
    ).toEqual([guestUrl('bridge-a'), guestUrl('bridge-b')])
  })

  it('knows it is already there when the user moves to the window it did reach', async () => {
    const tm = await loadTargetManager()
    const a = {}
    const b = {}
    tm.registerMcpWindow(a, {
      nativeHost: true, activeBridgeId: 'bridge-a', nativeOverviewProvider: null,
      getProjectPath: () => '/proj/a', getAppId: () => 'app-a',
    })
    tm.registerMcpWindow(b, {
      nativeHost: true, activeBridgeId: 'bridge-b', nativeOverviewProvider: null,
      getProjectPath: () => '/proj/b', getAppId: () => 'app-b',
    })
    let active: object = b
    tm.setActiveMcpWindowResolver(() => active)
    // B's page is not reachable, so the connection lands on A's.
    cdp.listed = [{ type: 'webview', url: guestUrl('bridge-a') }]

    await tm.connectTarget('simulator')
    expect(cdp.connectedTo).toEqual([guestUrl('bridge-a')])

    // The user moves to A — where this connection actually is.
    active = a
    tm.noteActiveMcpWindowChanged()
    await vi.advanceTimersByTimeAsync(1000)

    expect(
      cdp.connectedTo,
      'a connection recorded as the window it really reached knows this focus change needs nothing; rebuilding it drops the console and network events it has buffered',
    ).toEqual([guestUrl('bridge-a')])
  })

  it('keeps trying when the only simulator surface belongs to another project', async () => {
    const tm = await loadTargetManager()
    const a = {}
    const b = {}
    // B — the window the user is in — is registered first, so a shell taken to
    // belong to whichever window comes to hand would be taken for B's.
    tm.registerMcpWindow(b, {
      nativeHost: true, activeBridgeId: 'bridge-b', nativeOverviewProvider: null,
      getProjectPath: () => '/proj/b', getAppId: () => 'app-b',
    })
    tm.registerMcpWindow(a, {
      nativeHost: true, activeBridgeId: null, nativeOverviewProvider: null,
      getProjectPath: () => '/proj/a', getAppId: () => 'app-a',
    })
    tm.setActiveMcpWindowResolver(() => b)
    // Neither window has a render guest yet, so the only simulator surface in
    // the CDP list is project A's shell.
    cdp.listed = [{ type: 'page', url: shellUrl('app-a') }]

    await tm.connectTarget('simulator')
    expect(cdp.connectedTo).toEqual([shellUrl('app-a')])

    cdp.listed = [...cdp.listed, { type: 'webview', url: guestUrl('bridge-b') }]
    await vi.advanceTimersByTimeAsync(4000)

    expect(
      cdp.connectedTo,
      'a shell belongs to the project whose appId it carries; recording another project\'s shell as an arrival leaves every simulator tool driving that project',
    ).toEqual([shellUrl('app-a'), guestUrl('bridge-b')])
  })

  it('does not settle on a simulator shell no open window claims', async () => {
    const tm = await loadTargetManager()
    const b = {}
    tm.registerMcpWindow(b, {
      nativeHost: true, activeBridgeId: 'bridge-b', nativeOverviewProvider: null,
      getProjectPath: () => '/proj/b', getAppId: () => 'app-b',
    })
    tm.setActiveMcpWindowResolver(() => b)
    // The only shell in the list is the one a project window that has just
    // closed was showing; B's own simulator has not loaded yet.
    cdp.listed = [{ type: 'page', url: shellUrl('app-gone') }]

    await tm.connectTarget('simulator')
    expect(cdp.connectedTo).toEqual([shellUrl('app-gone')])

    cdp.listed = [...cdp.listed, { type: 'webview', url: guestUrl('bridge-b') }]
    await vi.advanceTimersByTimeAsync(4000)

    expect(
      cdp.connectedTo,
      'the appId a shell carries is what says whose it is; being the only window open does not make another project\'s shell yours',
    ).toEqual([shellUrl('app-gone'), guestUrl('bridge-b')])
  })

  it('does not settle on a simulator surface that names no project at all', async () => {
    const tm = await loadTargetManager()
    const b = {}
    tm.registerMcpWindow(b, {
      nativeHost: true, activeBridgeId: 'bridge-b', nativeOverviewProvider: null,
      getProjectPath: () => '/proj/b', getAppId: () => 'app-b',
    })
    tm.setActiveMcpWindowResolver(() => b)
    cdp.listed = [{ type: 'page', url: 'http://localhost:7788/simulator.html' }]

    await tm.connectTarget('simulator')
    expect(cdp.connectedTo).toEqual(['http://localhost:7788/simulator.html'])

    cdp.listed = [...cdp.listed, { type: 'webview', url: guestUrl('bridge-b') }]
    await vi.advanceTimersByTimeAsync(4000)

    expect(
      cdp.connectedTo,
      'a surface carrying no project identity cannot be shown to be the right one, and assuming it is leaves MCP wherever it happened to land',
    ).toEqual(['http://localhost:7788/simulator.html', guestUrl('bridge-b')])
  })

  it('keeps trying when two project windows claim the shell\'s appId', async () => {
    const tm = await loadTargetManager()
    const a = {}
    const b = {}
    // Two projects can declare the same appId, and then the shell URL no longer
    // says which window it is.
    // Registered before the other claimant, so picking the first window that
    // reports the appId would land on B and call it an arrival.
    tm.registerMcpWindow(b, {
      nativeHost: true, activeBridgeId: 'bridge-b', nativeOverviewProvider: null,
      getProjectPath: () => '/proj/b', getAppId: () => 'app-shared',
    })
    tm.registerMcpWindow(a, {
      nativeHost: true, activeBridgeId: null, nativeOverviewProvider: null,
      getProjectPath: () => '/proj/a', getAppId: () => 'app-shared',
    })
    tm.setActiveMcpWindowResolver(() => b)
    cdp.listed = [{ type: 'page', url: shellUrl('app-shared') }]

    await tm.connectTarget('simulator')
    expect(cdp.connectedTo).toEqual([shellUrl('app-shared')])

    cdp.listed = [...cdp.listed, { type: 'webview', url: guestUrl('bridge-b') }]
    await vi.advanceTimersByTimeAsync(4000)

    expect(
      cdp.connectedTo,
      'an ambiguous shell may be the wrong project; only a target that names one window may stop the retries',
    ).toEqual([shellUrl('app-shared'), guestUrl('bridge-b')])
  })
})

describe('an MCP connection that is on the surface it was meant to reach', () => {
  it('settles on the project list while no project window is open', async () => {
    const tm = await loadTargetManager()
    tm.setActiveMcpWindowResolver(() => null)
    cdp.listed = [{ type: 'page', url: LIST_URL }]

    await tm.connectTarget('workbench')
    await vi.advanceTimersByTimeAsync(10_000)

    expect(
      cdp.connectedTo,
      'with no project open the list IS the workbench surface; treating it as a miss would rebuild the connection every few seconds and drop its buffered events',
    ).toEqual([LIST_URL])
  })

  it('settles on the simulator shell of the window the user is in', async () => {
    const tm = await loadTargetManager()
    const a = {}
    tm.registerMcpWindow(a, {
      nativeHost: false, activeBridgeId: null, nativeOverviewProvider: null,
      getProjectPath: () => '/proj/a', getAppId: () => 'app-a',
    })
    tm.setActiveMcpWindowResolver(() => a)
    cdp.listed = [{ type: 'page', url: shellUrl('app-a') }]

    await tm.connectTarget('simulator')
    await vi.advanceTimersByTimeAsync(10_000)

    expect(
      cdp.connectedTo,
      'a shell that carries the appId of the window the user is in IS that window\'s surface; rebuilding it every few seconds would drop its buffered console and network events',
    ).toEqual([shellUrl('app-a')])
  })
})
