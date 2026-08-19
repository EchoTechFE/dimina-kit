/**
 * `OrientationController` tracks one `PageOrientationState` per bridgeId for as long as a page stays mounted (visible or cached in a tab substack) — see orientation-controller.ts's module doc.
 * The map is released through `use-orientation.ts`'s reconcile pass (`orientation.closePage` for any known bridgeId the current `mounted` set no longer contains), which runs off the REAL route reducers via the REAL `DeviceShell` component.
 * A route that forgets to shrink the page stack — or a reconcile pass that forgets to diff against it — leaks one `PageOrientationState` per page opened.
 *
 * This drives that reconcile pass through the real component (same harness shape as device-shell.test.tsx) and reads the controller's own `knownBridgeIds()` — not a debug hook, its existing public API — captured off the single instance `useOrientation` constructs, via a prototype spy that still runs the real implementation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { SIMULATOR_EVENTS as E } from '../../shared/bridge-channels'
import type { NavActionPayload } from '../../shared/bridge-channels'
import { DeviceShell } from './device-shell'
import { OrientationController } from './orientation-controller'

const ROOT_BRIDGE_ID = 'bridge_root'
const DETAIL = 'pages/detail/detail'
const TAB1 = 'pages/tab1/tab1'
const TAB2 = 'pages/tab2/tab2'

interface TabBarSpec { list: Array<{ pagePath: string; text: string }> }

function makeMiniApp(opts: { tabBar?: TabBarSpec; rootPagePath?: string } = {}) {
  const rootPagePath = opts.rootPagePath ?? 'pages/home/home'
  const tabPaths = new Set((opts.tabBar?.list ?? []).map((item) => item.pagePath))
  const listeners = new Map<string, Set<(payload: never) => void>>()
  let openCount = 0

  const subscribe = (channel: string, listener: (payload: never) => void): (() => void) => {
    let bucket = listeners.get(channel)
    if (!bucket) {
      bucket = new Set()
      listeners.set(channel, bucket)
    }
    bucket.add(listener)
    return () => { bucket?.delete(listener) }
  }

  const miniApp = {
    appId: 'demo',
    appSessionId: 's1',
    pagePath: rootPagePath,
    query: {},
    rootWindowConfig: {},
    resourceBaseUrl: '',
    apiRegistry: {},
    getInitialDevice: () => null,
    getRenderPreloadUrl: () => '',
    getTabBarConfig: () => opts.tabBar ?? null,
    getHomePagePath: () => rootPagePath,
    createRenderHostUrl: () => 'about:blank',
    openPage: vi.fn((pagePath: string) => Promise.resolve({
      bridgeId: `bridge_${++openCount}`,
      pagePath,
      isTab: tabPaths.has(pagePath),
      windowConfig: {},
    })),
    closePage: vi.fn(),
    notifyLifecycle: vi.fn(),
    notifyNavCallback: vi.fn(),
    notifyApiResponse: vi.fn(),
    notifyResize: vi.fn(),
    notifyActivePage: vi.fn(),
    notifyPageStack: vi.fn(),
    notifySessionActive: vi.fn(),
    onSimulatorEvent: subscribe,
    onSessionEvent: subscribe,
  }

  return {
    miniApp,
    emitNavAction(payload: Omit<NavActionPayload, 'appSessionId' | 'callbacks'>): void {
      for (const fn of listeners.get(E.NAV_ACTION) ?? []) {
        (fn as unknown as (p: NavActionPayload) => void)({
          appSessionId: 's1',
          callbacks: {},
          ...payload,
        })
      }
    },
  }
}

function mountShell(h: ReturnType<typeof makeMiniApp>) {
  return render(
    <DeviceShell miniApp={h.miniApp as never} bridgeId={ROOT_BRIDGE_ID} active={false} />,
  )
}

/** Let every queued route (and the IPC round trips it awaits) run to completion. */
async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

/**
 * Capture the single `OrientationController` instance `useOrientation` constructs, by spying on a prototype method every instance calls during render — the spy still runs the real implementation, it only observes `this`.
 */
function captureController(): { get: () => OrientationController } {
  let captured: OrientationController | undefined
  const original = OrientationController.prototype.openPage
  vi.spyOn(OrientationController.prototype, 'openPage').mockImplementation(
    function (this: OrientationController, ...args: Parameters<typeof original>) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- capturing the constructed instance is the point of this spy
      captured = this
      return original.apply(this, args)
    },
  )
  return {
    get: () => {
      if (!captured) throw new Error('OrientationController.openPage was never called')
      return captured
    },
  }
}

function knownCount(ctrl: OrientationController): number {
  return Array.from(ctrl.knownBridgeIds()).length
}

describe('OrientationController resource census across route churn', () => {
  // Each test installs its own prototype spy to capture the instance `useOrientation` constructs; left in place it would wrap the previous test's wrapper instead of the real method on the next `captureController()`.
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns to its baseline page count after repeated navigateTo/navigateBack round trips', async () => {
    const spy = captureController()
    const h = makeMiniApp()
    mountShell(h)
    await settle()

    const ctrl = spy.get()
    const baseline = knownCount(ctrl)
    expect(baseline, 'only the root page is mounted before any route runs').toBe(1)

    const ROUNDS = 6
    for (let round = 0; round < ROUNDS; round++) {
      await act(async () => {
        h.emitNavAction({ bridgeId: ROOT_BRIDGE_ID, name: 'navigateTo', params: { url: `/${DETAIL}` } })
      })
      await settle()
      expect(knownCount(ctrl), `round ${round}: pushing a page must register its orientation state`).toBe(baseline + 1)

      await act(async () => {
        h.emitNavAction({ bridgeId: 'irrelevant', name: 'navigateBack', params: { delta: 1 } })
      })
      await settle()
      expect(knownCount(ctrl), `round ${round}: popping it back must release that state, not accumulate it`).toBe(baseline)
    }
  })

  it('returns to its baseline page count after repeated redirectTo/reLaunch churn', async () => {
    const spy = captureController()
    const h = makeMiniApp()
    mountShell(h)
    await settle()

    const ctrl = spy.get()
    const baseline = knownCount(ctrl)

    const ROUNDS = 5
    for (let round = 0; round < ROUNDS; round++) {
      await act(async () => {
        h.emitNavAction({ bridgeId: 'irrelevant', name: 'redirectTo', params: { url: `/${DETAIL}` } })
      })
      await settle()
      expect(knownCount(ctrl), `round ${round}: redirectTo replaces the top in place, count must not grow`).toBe(baseline)

      await act(async () => {
        h.emitNavAction({ bridgeId: 'irrelevant', name: 'reLaunch', params: { url: '/pages/home/home' } })
      })
      await settle()
      expect(knownCount(ctrl), `round ${round}: reLaunch tears down every prior page, count must fall back to one`).toBe(baseline)
    }
  })

  /**
   * switchTab is the one route that LEAVES a page alive, cached inside a tab substack, instead of tearing it down — so its count contract is not "returns to baseline" but "grows by exactly what got cached, and a cache restore neither duplicates a registration nor releases a substack it didn't touch". reLaunch is the one route that tears every substack down regardless of which tab is active, so it is what brings the count back to one at the end.
   */
  it('grows and restores precisely across switchTab, and reLaunch releases every cached substack', async () => {
    const spy = captureController()
    const h = makeMiniApp({
      tabBar: { list: [{ pagePath: TAB1, text: 'Tab1' }, { pagePath: TAB2, text: 'Tab2' }] },
      rootPagePath: TAB1,
    })
    mountShell(h)
    await settle()

    const ctrl = spy.get()
    const baseline = knownCount(ctrl)
    expect(baseline, 'only the root tab page is mounted before any route runs').toBe(1)

    // A tab that has never been visited must be opened fresh — and the tab switched away from must stay cached, not released.
    await act(async () => {
      h.emitNavAction({ bridgeId: ROOT_BRIDGE_ID, name: 'switchTab', params: { url: `/${TAB2}` } })
    })
    await settle()
    expect(knownCount(ctrl), 'a freshly-opened tab grows the count by one; the tab left behind stays cached').toBe(baseline + 1)

    // Switching back must restore tab1 from its cache — no re-registration — and must not release tab2's substack behind it.
    await act(async () => {
      h.emitNavAction({ bridgeId: 'irrelevant', name: 'switchTab', params: { url: `/${TAB1}` } })
    })
    await settle()
    expect(knownCount(ctrl), 'restoring a cached tab must neither duplicate its registration nor release the other tab').toBe(baseline + 1)

    // Push a page onto the active tab's own substack, then leave via switchTab: the pushed page is now cached inside that hidden substack.
    await act(async () => {
      h.emitNavAction({ bridgeId: ROOT_BRIDGE_ID, name: 'navigateTo', params: { url: `/${DETAIL}` } })
    })
    await settle()
    expect(knownCount(ctrl), 'the pushed page registers its own orientation state').toBe(baseline + 2)

    await act(async () => {
      h.emitNavAction({ bridgeId: 'irrelevant', name: 'switchTab', params: { url: `/${TAB2}` } })
    })
    await settle()
    expect(
      knownCount(ctrl),
      'a page cached inside a hidden tab substack stays tracked — an unrelated switchTab must not release it',
    ).toBe(baseline + 2)

    // Repeated cache restores must not duplicate either tab root or the depth-two hidden substack.
    // Exact count after every hop catches both leaks and premature release.
    for (let round = 0; round < 8; round++) {
      const target = round % 2 === 0 ? TAB1 : TAB2
      await act(async () => {
        h.emitNavAction({ bridgeId: 'irrelevant', name: 'switchTab', params: { url: `/${target}` } })
      })
      await settle()
      expect(
        knownCount(ctrl),
        `switchTab round ${round}: cached depth-two substack must remain exactly accounted for`,
      ).toBe(baseline + 2)
    }

    // reLaunch to a non-tab page tears every tab substack down in one shot, including whatever is cached inside them.
    await act(async () => {
      h.emitNavAction({ bridgeId: 'irrelevant', name: 'reLaunch', params: { url: '/pages/home/home' } })
    })
    await settle()
    expect(knownCount(ctrl), 'reLaunch releases every tab substack and everything cached inside them').toBe(baseline)
  })
})
