/**
 * `findTarget` must pick a candidate this connection can actually be
 * attributed to, not merely the first one CDP.List happens to return first.
 *
 * `selectSimulatorTarget` / `selectWorkbenchTarget` apply their priority order
 * over the RAW target list with no idea which window each candidate belongs
 * to. When two project windows both expose a matching surface (two shells on
 * localhost:7788, or a render guest next to the active window's own shell),
 * list order decides — and list order never changes, so a candidate that
 * belongs to the wrong window is picked every single attempt. `connectTarget`
 * then discovers the mismatch via `connectionOwner`, closes the client, and
 * retries — landing on the exact same wrong candidate again, forever.
 *
 * The fix has to filter candidates by ownership (via `connectionOwner`)
 * BEFORE applying the priority order, so the one attempt that CAN reach the
 * active window's target does.
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

const shellUrl = (appId: string) => `http://localhost:7788/simulator.html?appId=${appId}`
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

describe('selecting a simulator target among two project windows', () => {
  it('connects the active window`s shell, not whichever shell is listed first (non-native)', async () => {
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
    tm.setActiveMcpWindowResolver(() => b)
    // A's shell is listed first — the bug is that list order alone decides.
    cdp.listed = [
      { type: 'page', url: shellUrl('app-a') },
      { type: 'page', url: shellUrl('app-b') },
    ]

    await tm.connectTarget('simulator')

    expect(
      cdp.connectedTo,
      'the one attempt must reach B`s shell directly instead of wasting itself on A`s and retrying',
    ).toEqual([shellUrl('app-b')])
    expect(tm.getTargetState('simulator').connected, 'B`s shell is a valid target and must end up connected').toBe(true)
    expect(tm.getTargetState('simulator').owner, 'the published connection must be owned by the active window').toBe(b)
  })

  it('connects the active window`s own shell rather than another window`s render guest (native-host)', async () => {
    const tm = await loadTargetManager()
    const other = {}
    const active = {}
    tm.registerMcpWindow(other, {
      nativeHost: true, activeBridgeId: 'bridge-other', nativeOverviewProvider: null,
      projectPath: '/proj/other', getAppId: () => 'app-other',
    })
    tm.registerMcpWindow(active, {
      nativeHost: true, activeBridgeId: null, nativeOverviewProvider: null,
      projectPath: '/proj/active', getAppId: () => 'app-active',
    })
    tm.setActiveMcpWindowResolver(() => active)
    // The other window's render guest is listed before the active window's
    // shell, and "any render guest" outranks the shell fallback — so without
    // ownership filtering the guest wins even though it belongs to `other`.
    cdp.listed = [
      { type: 'webview', url: guestUrl('bridge-other') },
      { type: 'page', url: shellUrl('app-active') },
    ]

    await tm.connectTarget('simulator')

    expect(
      cdp.connectedTo,
      'the active window has no render guest yet, so its own shell must be the one attempt reaches — never another window`s guest',
    ).toEqual([shellUrl('app-active')])
    expect(tm.getTargetState('simulator').connected).toBe(true)
    expect(tm.getTargetState('simulator').owner).toBe(active)
  })
})
