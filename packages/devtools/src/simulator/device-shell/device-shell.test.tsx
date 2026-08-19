/**
 * DeviceShell routing as an atomic, serialized transaction.
 *
 * A route reads the stack, opens a page over IPC and reduces the result back onto the stack it read.
 * Two of those interleaving — or a React state update standing in for "the stack moved" — lets both reduce from the same stack, so the loser's page disappears from the shell while main keeps it registered and the mini-app is told both calls succeeded.
 * The stack transitions here are therefore driven through the real component and asserted on what main observes (PAGE_STACK, closePage, the nav callbacks).
 */
import { describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { SIMULATOR_EVENTS as E } from '../../shared/bridge-channels'
import type { NavActionPayload } from '../../shared/bridge-channels'
import type { NativeDeviceInfo } from '../../shared/ipc-channels'
import { DeviceShell } from './device-shell'

const DEVICE: NativeDeviceInfo = {
  brand: 'Apple',
  model: 'iPhone 14',
  system: 'iOS 16.0',
  platform: 'ios',
  pixelRatio: 3,
  screenWidth: 390,
  screenHeight: 844,
  statusBarHeight: 47,
  notchType: 'dynamic-island',
  safeAreaInsets: { top: 47, right: 0, bottom: 34, left: 0 },
  deviceOrientation: 'portrait',
}

const ROOT_BRIDGE_ID = 'bridge_root'
const DETAIL = 'pages/detail/detail'

interface PendingOpen {
  pagePath: string
  settle: () => void
}

function makeMiniApp(
  opts: {
    autoOpen?: boolean
    rootWindowConfig?: Record<string, unknown>
    openWindowConfig?: Record<string, unknown>
  } = {},
) {
  const autoOpen = opts.autoOpen ?? true
  const listeners = new Map<string, Set<(payload: never) => void>>()
  const pendingOpens: PendingOpen[] = []
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

  const openResult = (pagePath: string) => ({
    bridgeId: `bridge_${++openCount}`,
    pagePath,
    isTab: false,
    windowConfig: opts.openWindowConfig ?? {},
  })

  const miniApp = {
    appId: 'demo',
    appSessionId: 's1',
    pagePath: 'pages/home/home',
    query: {},
    rootWindowConfig: opts.rootWindowConfig ?? {},
    resourceBaseUrl: '',
    apiRegistry: {},
    getInitialDevice: () => DEVICE,
    getRenderPreloadUrl: () => '',
    getTabBarConfig: () => null,
    getHomePagePath: () => 'pages/home/home',
    createRenderHostUrl: () => 'about:blank',
    openPage: vi.fn((pagePath: string) => {
      if (autoOpen) return Promise.resolve(openResult(pagePath))
      return new Promise((resolve) => {
        pendingOpens.push({ pagePath, settle: () => resolve(openResult(pagePath)) })
      })
    }),
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
    pendingOpens,
    emitNavAction(payload: Omit<NavActionPayload, 'appSessionId' | 'callbacks'>): void {
      for (const fn of listeners.get(E.NAV_ACTION) ?? []) {
        (fn as unknown as (p: NavActionPayload) => void)({
          appSessionId: 's1',
          callbacks: {},
          ...payload,
        })
      }
    },
    emitDeviceChange(device: NativeDeviceInfo): void {
      for (const fn of listeners.get(E.DEVICE_CHANGE) ?? []) {
        (fn as unknown as (p: NativeDeviceInfo) => void)(device)
      }
    },
    /** Geometry the shell last reported to main. */
    lastResize(): { bridgeId: string; size: { windowWidth: number; windowHeight: number } } | undefined {
      return miniApp.notifyResize.mock.calls.at(-1)?.[0] as never
    },
    /** Every report's page-channel verdict, in order, as `bridgeId:dispatchPage`. */
    pageDispatches(): string[] {
      return miniApp.notifyResize.mock.calls.map((c) => {
        const p = c[0] as { bridgeId: string; dispatchPage: boolean }
        return `${p.bridgeId}:${p.dispatchPage}`
      })
    },
    /** Every window height the shell reported to main, in order. */
    reportedHeights(): number[] {
      return miniApp.notifyResize.mock.calls.map(
        c => (c[0] as { size: { windowHeight: number } }).size.windowHeight,
      )
    },
    /** Routes the shell reported to main, most recent first. */
    lastStack(): string[] {
      const calls = miniApp.notifyPageStack.mock.calls
      const last = calls.at(-1)?.[0] as Array<{ pagePath: string }> | undefined
      return (last ?? []).map(e => e.pagePath)
    },
    navVerdicts(): Array<{ ok: boolean; errMsg: string }> {
      return miniApp.notifyNavCallback.mock.calls.map(c => c[0] as { ok: boolean; errMsg: string })
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
 * The toolbar's device selection reaches the shell over DEVICE_CHANGE, and the shell is what tells main the session's geometry.
 * Two facts have to move: the rendered bezel (React state) and the snapshot a SYNCHRONOUS route publishes against — a route arriving in the same batch publishes before React commits, so a device that only advanced with state would hand the incoming page the previous device's metrics in its `onShow`.
 */
describe('DeviceShell follows the selected device', () => {
  const SMALL_DEVICE: NativeDeviceInfo = {
    ...DEVICE,
    model: 'iPhone SE',
    screenWidth: 320,
    screenHeight: 568,
    statusBarHeight: 20,
    notchType: 'none',
    safeAreaInsets: { top: 20, right: 0, bottom: 0, left: 0 },
  }

  it('reports the newly selected device geometry to main', async () => {
    const h = makeMiniApp()
    mountShell(h)
    expect(h.lastResize()?.size.windowWidth).toBe(DEVICE.screenWidth)

    await act(async () => { h.emitDeviceChange(SMALL_DEVICE) })

    expect(
      h.lastResize()?.size.windowWidth,
      'a device switch must move the geometry main holds for the top page',
    ).toBe(SMALL_DEVICE.screenWidth)
  })

  it('publishes the incoming page against the device selected mid-route', async () => {
    const h = makeMiniApp({ autoOpen: false })
    mountShell(h)

    // The route parks on its PAGE_OPEN; the device changes while it is parked.
    await act(async () => {
      h.emitNavAction({ bridgeId: ROOT_BRIDGE_ID, name: 'navigateTo', params: { url: `/${DETAIL}` } })
    })
    await act(async () => { h.emitDeviceChange(SMALL_DEVICE) })
    await act(async () => {
      h.pendingOpens.forEach(p => p.settle())
      h.pendingOpens.length = 0
    })
    await settle()

    const published = h.miniApp.notifyResize.mock.calls
      .map(c => c[0] as { bridgeId: string; size: { windowWidth: number } })
      .filter(r => r.bridgeId === 'bridge_1')
    expect(published.length, 'the pushed page must have been published at all').toBeGreaterThan(0)
    for (const resize of published) {
      expect(
        resize.size.windowWidth,
        'the page being shown must never read the metrics of the device already switched away from',
      ).toBe(SMALL_DEVICE.screenWidth)
    }
  })
})

/**
 * A soft reload keeps two shells mounted at once and swaps them in one commit.
 * Which of them the user is looking at is not something main can infer from who reported geometry last — the outgoing session keeps reporting after the incoming one has taken the screen.
 * The shell that is on screen says so, and republishes its top page so the geometry main mirrors describes the session that is actually visible even though nothing about its size changed.
 */
describe('DeviceShell declares itself as the session on screen', () => {
  it('stays silent while it is the hidden, still-booting session', () => {
    const h = makeMiniApp()
    mountShell(h)
    expect(h.miniApp.notifySessionActive).not.toHaveBeenCalled()
  })

  it('claims the screen on promotion, then republishes the top page behind that claim', () => {
    const h = makeMiniApp()
    const view = mountShell(h)
    h.miniApp.notifyResize.mockClear()

    view.rerender(
      <DeviceShell miniApp={h.miniApp as never} bridgeId={ROOT_BRIDGE_ID} active={true} />,
    )

    expect(h.miniApp.notifySessionActive).toHaveBeenCalledTimes(1)
    const declaredAt = h.miniApp.notifySessionActive.mock.invocationCallOrder[0]!
    const afterClaim = h.miniApp.notifyResize.mock.invocationCallOrder.filter(at => at > declaredAt)
    expect(
      afterClaim.length,
      'a promoted session whose page never changed size still has to republish, or main keeps mirroring the session it replaced',
    ).toBeGreaterThan(0)
    expect(
      (h.miniApp.notifyResize.mock.calls.at(-1)?.[0] as { bridgeId: string }).bridgeId,
      'the republished geometry describes the top of this shell\'s own stack',
    ).toBe(ROOT_BRIDGE_ID)
  })

  /**
   * 这次补发只为「换了前台会话」这一件事。
   * 跟着顶页一起补发的话，MiniAppFrame 路由时已经报过的那份几何会被第二个发布者再报一次，路由几何就不再只有一个 owner。
   */
  it('does not republish again when a route moves the top page of an already-active shell', async () => {
    const h = makeMiniApp()
    const view = render(
      <DeviceShell miniApp={h.miniApp as never} bridgeId={ROOT_BRIDGE_ID} active={true} />,
    )
    await settle()
    h.miniApp.notifyResize.mockClear()
    h.miniApp.notifySessionActive.mockClear()

    await act(async () => {
      h.emitNavAction({ bridgeId: ROOT_BRIDGE_ID, name: 'navigateTo', params: { url: '/pages/a/a' } })
    })
    await settle()

    const claimedAgain = h.miniApp.notifySessionActive.mock.calls.length
    expect(claimedAgain, 'the shell was already the active session').toBe(0)
    expect(
      h.miniApp.notifyResize.mock.calls.filter(
        call => (call[0] as { bridgeId: string }).bridgeId === 'bridge_1',
      ).length,
      'the landing page must be reported exactly once for this route',
    ).toBe(1)
    view.unmount()
  })
})

describe('DeviceShell routing serializes concurrent NAV_ACTIONs', () => {
  it('lands both of two back-to-back navigateTo pushes', async () => {
    const h = makeMiniApp()
    mountShell(h)

    await act(async () => {
      h.emitNavAction({ bridgeId: ROOT_BRIDGE_ID, name: 'navigateTo', params: { url: `/${DETAIL}` } })
      h.emitNavAction({ bridgeId: ROOT_BRIDGE_ID, name: 'navigateTo', params: { url: `/${DETAIL}` } })
    })
    await settle()

    expect(
      h.lastStack(),
      'the second push must reduce from the stack the first one landed',
    ).toEqual(['pages/home/home', DETAIL, DETAIL])
    expect(h.miniApp.closePage, 'neither push may be silently discarded').not.toHaveBeenCalled()
    expect(h.navVerdicts().map(v => v.ok)).toEqual([true, true])
  })

  it('pops two pages for two back-to-back navigateBacks, closing each exactly once', async () => {
    const h = makeMiniApp()
    mountShell(h)

    await act(async () => {
      h.emitNavAction({ bridgeId: ROOT_BRIDGE_ID, name: 'navigateTo', params: { url: `/${DETAIL}` } })
    })
    await settle()
    await act(async () => {
      h.emitNavAction({ bridgeId: 'bridge_1', name: 'navigateTo', params: { url: `/${DETAIL}` } })
    })
    await settle()
    expect(h.lastStack()).toEqual(['pages/home/home', DETAIL, DETAIL])
    h.miniApp.closePage.mockClear()

    await act(async () => {
      h.emitNavAction({ bridgeId: 'bridge_2', name: 'navigateBack', params: { delta: 1 } })
      h.emitNavAction({ bridgeId: 'bridge_2', name: 'navigateBack', params: { delta: 1 } })
    })
    await settle()

    expect(h.lastStack(), 'each back must pop the stack the previous one left').toEqual(['pages/home/home'])
    expect(
      h.miniApp.closePage.mock.calls.map(c => c[0]).sort(),
      'the two backs must close two different pages',
    ).toEqual(['bridge_1', 'bridge_2'])
  })

  it('publishes the restored page geometry before its pageShow lifecycle', async () => {
    const h = makeMiniApp()
    mountShell(h)
    await act(async () => {
      h.emitNavAction({ bridgeId: ROOT_BRIDGE_ID, name: 'navigateTo', params: { url: '/pages/a/a' } })
    })
    h.miniApp.notifyResize.mockClear()
    h.miniApp.notifyLifecycle.mockClear()

    await act(async () => {
      h.emitNavAction({ bridgeId: 'bridge_1', name: 'navigateBack', params: { delta: 1 } })
    })

    const resizeAt = h.miniApp.notifyResize.mock.invocationCallOrder[0]
    const showCall = h.miniApp.notifyLifecycle.mock.calls.findIndex((call) =>
      call[0] === ROOT_BRIDGE_ID && call[1] === 'pageShow')
    expect(showCall).toBeGreaterThanOrEqual(0)
    expect(resizeAt).toBeLessThan(h.miniApp.notifyLifecycle.mock.invocationCallOrder[showCall]!)
  })

  it('runs a navigateBack issued mid-navigateTo after the push it interrupts', async () => {
    const h = makeMiniApp({ autoOpen: false })
    mountShell(h)

    await act(async () => {
      h.emitNavAction({ bridgeId: ROOT_BRIDGE_ID, name: 'navigateTo', params: { url: `/${DETAIL}` } })
    })
    // The back arrives while the push is still waiting for its PAGE_OPEN.
    await act(async () => {
      h.emitNavAction({ bridgeId: ROOT_BRIDGE_ID, name: 'navigateBack', params: { delta: 1 } })
    })
    await act(async () => {
      h.pendingOpens.forEach(p => p.settle())
      h.pendingOpens.length = 0
    })
    await settle()

    expect(
      h.lastStack(),
      'the back must see the pushed page and pop it, not fail on a one-deep stack',
    ).toEqual(['pages/home/home'])
    expect(h.navVerdicts().map(v => v.ok)).toEqual([true, true])
  })

  it('keeps issue order when the first route\'s page opens after the second one\'s', async () => {
    const h = makeMiniApp({ autoOpen: false })
    mountShell(h)

    await act(async () => {
      h.emitNavAction({ bridgeId: ROOT_BRIDGE_ID, name: 'navigateTo', params: { url: '/pages/first/first' } })
      h.emitNavAction({ bridgeId: ROOT_BRIDGE_ID, name: 'navigateTo', params: { url: '/pages/second/second' } })
    })

    // Settle whatever PAGE_OPENs are outstanding, newest first — a route may not depend on its own open winning the race against a later route's.
    for (let round = 0; round < 2; round++) {
      await act(async () => {
        const outstanding = h.pendingOpens.splice(0, h.pendingOpens.length).reverse()
        outstanding.forEach(p => p.settle())
      })
      await settle()
    }

    expect(h.lastStack()).toEqual([
      'pages/home/home',
      'pages/first/first',
      'pages/second/second',
    ])
  })
})

/**
 * The launch page's window geometry is published from the shell's own seed of the frame's layout, before the frame reports a layout of its own.
 * A page declaring `navigationStyle: "custom"` gets the whole screen height; if the seed assumed a default navigation bar, main would cache the short window the page reads in `onShow`, and the correction would arrive as a `Page.onResize` that no real container sends for a page that never resized.
 */
describe('DeviceShell seeds the launch page geometry from its window config', () => {
  const SCREEN_HEIGHT = DEVICE.screenHeight
  const DEFAULT_CHROME = DEVICE.statusBarHeight + 44

  it('publishes the full screen height for a custom navigation style, once', async () => {
    const h = makeMiniApp({ rootWindowConfig: { navigationStyle: 'custom' } })
    mountShell(h)
    await settle()

    expect(h.reportedHeights()).toEqual([SCREEN_HEIGHT])
  })

  it('reserves the navigation bar for a default navigation style', async () => {
    const h = makeMiniApp()
    mountShell(h)
    await settle()

    expect(h.reportedHeights()).toEqual([SCREEN_HEIGHT - DEFAULT_CHROME])
  })
})

/**
 * The page channel carries whichever page a report names, with no geometry test, and a route commit names its landing page.
 * The pages here are `auto` so the fixed-orientation suppression is not what any verdict comes from.
 */
describe('DeviceShell reports the page channel for whichever page a route lands on', () => {
  const AUTO = { pageOrientation: 'auto' }

  it('reports the landing page on a route that moved no geometry, and again when the device rotates', async () => {
    const h = makeMiniApp({ rootWindowConfig: AUTO, openWindowConfig: AUTO })
    mountShell(h)
    await settle()
    expect(h.pageDispatches()).toEqual([`${ROOT_BRIDGE_ID}:true`])
    h.miniApp.notifyResize.mockClear()

    await act(async () => {
      h.emitNavAction({ bridgeId: ROOT_BRIDGE_ID, name: 'navigateTo', params: { url: `/${DETAIL}` } })
    })
    await settle()
    expect(
      h.pageDispatches(),
      'the pushed page lands at the root page geometry and is still the page the report names',
    ).toEqual(['bridge_1:true'])
    h.miniApp.notifyResize.mockClear()

    await act(async () => {
      h.emitDeviceChange({ ...DEVICE, deviceOrientation: 'landscape' })
    })
    await settle()
    expect(h.pageDispatches()).toEqual(['bridge_1:true'])
  })
})
