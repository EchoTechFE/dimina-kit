/**
 * `getClient` must answer for the window MCP means to drive right now, not
 * for whichever window the live connection last reached.
 *
 * A focus change re-aims connections only after they settle
 * (`ACTIVE_WINDOW_SETTLE_MS`, coalesced on purpose), but `getClient` checked
 * only `state.connected && state.client` — both still true for the OLD
 * owner's client during that settle window. A caller asking on the new
 * window's behalf in that gap silently got the old window's client instead of
 * an error, and every tool call it drove (console reads, DOM queries, network
 * inspection) reported on the wrong project.
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

async function loadTargetManager() {
  vi.resetModules()
  return await import('./target-manager.js')
}

const workbenchUrl = (path: string) =>
  `file:///app/dist/entries/workbench/index.html?path=${encodeURIComponent(path)}&name=p`

beforeEach(() => {
  vi.useFakeTimers()
  cdp.listed = []
  cdp.connectedTo = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('getClient synced against the active window', () => {
  it('throws immediately when the active window changes, before the repoint settles', async () => {
    const tm = await loadTargetManager()
    const a = {}
    const b = {}
    tm.registerMcpWindow(a, {
      nativeHost: true, activeBridgeId: null, nativeOverviewProvider: null,
      projectPath: '/proj/a', getAppId: () => 'app-a',
    })
    tm.registerMcpWindow(b, {
      nativeHost: true, activeBridgeId: null, nativeOverviewProvider: null,
      projectPath: '/proj/b', getAppId: () => 'app-b',
    })
    let active: object = a
    tm.setActiveMcpWindowResolver(() => active)
    cdp.listed = [
      { type: 'page', url: workbenchUrl('/proj/a') },
      { type: 'page', url: workbenchUrl('/proj/b') },
    ]

    await tm.connectTarget('workbench')
    expect(
      () => tm.getClient('workbench'),
      "the freshly established connection is on the window that is active — getClient must not refuse it",
    ).not.toThrow()

    active = b
    tm.noteActiveMcpWindowChanged()

    expect(
      () => tm.getClient('workbench'),
      "A's client must not be handed to a caller asking on B's behalf just because the settle delay has not landed the repoint yet",
    ).toThrow()
  })

  it('keeps returning the client while the resolver still names the window the connection reached', async () => {
    const tm = await loadTargetManager()
    const a = {}
    tm.registerMcpWindow(a, {
      nativeHost: true, activeBridgeId: null, nativeOverviewProvider: null,
      projectPath: '/proj/a', getAppId: () => 'app-a',
    })
    tm.setActiveMcpWindowResolver(() => a)
    cdp.listed = [{ type: 'page', url: workbenchUrl('/proj/a') }]

    await tm.connectTarget('workbench')
    tm.noteActiveMcpWindowChanged()
    await vi.advanceTimersByTimeAsync(200)

    expect(
      () => tm.getClient('workbench'),
      'a resolver that keeps naming the window the connection already reached must never make getClient refuse it',
    ).not.toThrow()
  })
})
