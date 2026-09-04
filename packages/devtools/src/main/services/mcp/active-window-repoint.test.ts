/**
 * A live MCP CDP connection follows the project window the user moves to.
 *
 * The `simulator` and `workbench` targets are process-wide and carry no window
 * argument, so they always mean "the project the user is working in". Which
 * window that is was only ever read while a connection was being established,
 * so a connection made while project A had focus kept answering from A's pages
 * for as long as it stayed alive — every MCP tool then reported and drove the
 * wrong project once the user switched windows.
 *
 * Two things the re-point must not do: reconnect on focus that ends up back
 * where it started (clicking between windows would otherwise tear the
 * connection down repeatedly), and connect into a window whose facts are
 * already gone because it is being torn down.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cdp = vi.hoisted(() => ({
  listed: [] as { type: string; url: string }[],
  connectedTo: [] as string[],
}))

vi.mock('chrome-remote-interface', () => {
  const noop = () => {}
  const makeClient = () => ({
    Page: { enable: async () => {} },
    Runtime: { enable: async () => {}, on: noop },
    DOM: { enable: async () => {} },
    Network: { enable: async () => {}, on: noop },
    Console: { enable: async () => {}, on: noop },
    on: noop,
    close: async () => {},
  })
  const CDP = Object.assign(
    vi.fn(async ({ target }: { target: { url: string } }) => {
      cdp.connectedTo.push(target.url)
      return makeClient()
    }),
    { List: vi.fn(async () => cdp.listed) },
  )
  return { default: CDP }
})

const guestUrl = (bridgeId: string) =>
  `file:///app/dist/render-host/__frame__.html?appId=x&bridgeId=${bridgeId}`

async function loadTargetManager() {
  vi.resetModules()
  return await import('./target-manager.js')
}

const SHELL_URL = 'http://localhost:7788/simulator.html'

/**
 * Both project windows' render guests, plus the simulator shell — the target a
 * window with no facts of its own degrades to, so "re-pointed at a window that
 * has none" is observable rather than silently finding nothing to connect to.
 */
beforeEach(() => {
  vi.useFakeTimers()
  cdp.listed = [
    { type: 'page', url: SHELL_URL },
    { type: 'webview', url: guestUrl('bridge-a') },
    { type: 'webview', url: guestUrl('bridge-b') },
  ]
  cdp.connectedTo = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the MCP simulator target after the active project window changes', () => {
  it('re-points a live connection at the window the user switched to', async () => {
    const tm = await loadTargetManager()
    const a = {}
    const b = {}
    tm.registerMcpWindow(a, {
      nativeHost: true, activeBridgeId: 'bridge-a', nativeOverviewProvider: null,
      projectPath: '/proj/a',
      getAppId: () => 'app-a',
    })
    tm.registerMcpWindow(b, {
      nativeHost: true, activeBridgeId: 'bridge-b', nativeOverviewProvider: null,
      projectPath: '/proj/b',
      getAppId: () => 'app-b',
    })
    let active: object = a
    tm.setActiveMcpWindowResolver(() => active)

    await tm.connectTarget('simulator')
    expect(cdp.connectedTo, 'the first connection follows the window that was active').toEqual([
      guestUrl('bridge-a'),
    ])

    active = b
    tm.noteActiveMcpWindowChanged()
    await vi.advanceTimersByTimeAsync(1000)

    expect(
      cdp.connectedTo.at(-1),
      'once the user works in project B, MCP tools must drive B — an established connection that stays on A silently reports and drives the wrong project',
    ).toBe(guestUrl('bridge-b'))
  })

  it('leaves the connection alone when focus lands back where it started', async () => {
    const tm = await loadTargetManager()
    const a = {}
    const b = {}
    tm.registerMcpWindow(a, {
      nativeHost: true, activeBridgeId: 'bridge-a', nativeOverviewProvider: null,
      projectPath: '/proj/a',
      getAppId: () => 'app-a',
    })
    tm.registerMcpWindow(b, {
      nativeHost: true, activeBridgeId: 'bridge-b', nativeOverviewProvider: null,
      projectPath: '/proj/b',
      getAppId: () => 'app-b',
    })
    let active: object = a
    tm.setActiveMcpWindowResolver(() => active)

    await tm.connectTarget('simulator')

    // Clicking through B and back to A, faster than the connection can settle.
    active = b
    tm.noteActiveMcpWindowChanged()
    active = a
    tm.noteActiveMcpWindowChanged()
    await vi.advanceTimersByTimeAsync(1000)

    expect(
      cdp.connectedTo,
      'focus that ends up on the window the connection is already bound to must not reconnect — tearing the CDP client down on every click drops buffered console and network events',
    ).toEqual([guestUrl('bridge-a')])
  })

  it('does not re-point into a window that is being torn down', async () => {
    const tm = await loadTargetManager()
    const a = {}
    const b = {}
    tm.registerMcpWindow(a, {
      nativeHost: true, activeBridgeId: 'bridge-a', nativeOverviewProvider: null,
      projectPath: '/proj/a',
      getAppId: () => 'app-a',
    })
    const registrationB = tm.registerMcpWindow(b, {
      nativeHost: true, activeBridgeId: 'bridge-b', nativeOverviewProvider: null,
      projectPath: '/proj/b',
      getAppId: () => 'app-b',
    })
    let active: object = a
    tm.setActiveMcpWindowResolver(() => active)

    await tm.connectTarget('simulator')

    // B is closing: its facts are dropped while it is still the resolver answer.
    active = b
    registrationB.dispose()
    tm.noteActiveMcpWindowChanged()
    await vi.advanceTimersByTimeAsync(1000)

    expect(
      cdp.connectedTo,
      'a window whose facts are already gone is on its way out; connecting into it would bind MCP to pages that are about to be destroyed',
    ).toEqual([guestUrl('bridge-a')])
  })
})
