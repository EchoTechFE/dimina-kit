/**
 * Tab-bar visibility is shell state that changes the geometry the session reports: `wx.hideTabBar` hands the bar's reserved height back to the page viewport and `wx.showTabBar` takes it away again.
 * A mini-app may read `wx.getWindowInfo()` synchronously inside that very call's success callback, so the new geometry has to be on the wire BEFORE the call is acked — which means the mutation lands through the shell's commit authority, in the same "commit → publish → tell the caller" order a route uses.
 */
import { describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { SIMULATOR_EVENTS as E } from '../../shared/bridge-channels'
import type { TabActionPayload } from '../../shared/bridge-channels'
import type { NativeDeviceInfo } from '../../shared/ipc-channels'
import { tabBarReservedHeight } from './orientation-controller'
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

const HOME = 'pages/home/home'
const ROOT_BRIDGE_ID = 'bridge_root'
const RESERVED = tabBarReservedHeight(DEVICE.safeAreaInsets.bottom)

/** What the shell told main, in the order it told it. */
type Trace =
  | { kind: 'resize'; windowHeight: number }
  | { kind: 'ack'; ok: boolean; errMsg: string }

function makeMiniApp() {
  const listeners = new Map<string, Set<(payload: never) => void>>()
  const trace: Trace[] = []

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
    pagePath: HOME,
    query: {},
    rootWindowConfig: {},
    resourceBaseUrl: '',
    apiRegistry: {},
    getInitialDevice: () => DEVICE,
    getRenderPreloadUrl: () => '',
    getTabBarConfig: () => ({ list: [{ pagePath: HOME, text: 'Home' }] }),
    getHomePagePath: () => HOME,
    createRenderHostUrl: () => 'about:blank',
    openPage: vi.fn(),
    closePage: vi.fn(),
    notifyLifecycle: vi.fn(),
    notifyApiResponse: vi.fn(),
    notifyActivePage: vi.fn(),
    notifyPageStack: vi.fn(),
    notifySessionActive: vi.fn(),
    notifyResize: vi.fn((payload: { size: { windowHeight: number } }) => {
      trace.push({ kind: 'resize', windowHeight: payload.size.windowHeight })
    }),
    notifyNavCallback: vi.fn((payload: { ok: boolean; errMsg: string }) => {
      trace.push({ kind: 'ack', ok: payload.ok, errMsg: payload.errMsg })
    }),
    onSimulatorEvent: subscribe,
    onSessionEvent: subscribe,
  }

  return {
    miniApp,
    trace,
    emitTabAction(name: TabActionPayload['name'], params: Record<string, unknown> = {}): void {
      for (const fn of listeners.get(E.TAB_ACTION) ?? []) {
        (fn as unknown as (p: TabActionPayload) => void)({
          appSessionId: 's1',
          bridgeId: ROOT_BRIDGE_ID,
          name,
          params,
          callbacks: {},
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

/** Height of the last geometry the shell published, or -1 if it published none. */
function lastHeight(trace: Trace[]): number {
  for (let i = trace.length - 1; i >= 0; i--) {
    const entry = trace[i]!
    if (entry.kind === 'resize') return entry.windowHeight
  }
  return -1
}

/**
 * Height the mini-app would read in the ack's callback: the newest geometry published strictly BEFORE the shell acked. -1 when nothing was published first, which is exactly the failure this file guards against.
 */
function heightVisibleAtAck(trace: Trace[]): number {
  const ackAt = trace.findIndex(entry => entry.kind === 'ack')
  expect(ackAt, 'the shell must have acked the tab-bar call').toBeGreaterThanOrEqual(0)
  return lastHeight(trace.slice(0, ackAt))
}

describe('DeviceShell commits a tab-bar geometry change before acking it', () => {
  it('hideTabBar publishes the grown viewport before the success callback can read it', () => {
    const h = makeMiniApp()
    mountShell(h)
    const withBar = lastHeight(h.trace)
    expect(withBar, 'the mounted tab page must have reported its geometry').toBeGreaterThan(0)
    h.trace.length = 0

    act(() => { h.emitTabAction('hideTabBar') })

    expect(
      heightVisibleAtAck(h.trace),
      'hideTabBar hands the bar height to the page, and its success callback reads the window synchronously',
    ).toBe(withBar + RESERVED)
  })

  it('showTabBar publishes the shrunk viewport before its own ack', () => {
    const h = makeMiniApp()
    mountShell(h)
    const withBar = lastHeight(h.trace)
    act(() => { h.emitTabAction('hideTabBar') })
    h.trace.length = 0

    act(() => { h.emitTabAction('showTabBar') })

    expect(
      heightVisibleAtAck(h.trace),
      'showTabBar takes the height back, and is symmetric with hideTabBar',
    ).toBe(withBar)
  })

  it('acks only after the geometry publish, never the other way round', () => {
    const h = makeMiniApp()
    mountShell(h)
    h.trace.length = 0

    act(() => { h.emitTabAction('hideTabBar') })

    const kinds = h.trace.map(entry => entry.kind)
    expect(kinds.indexOf('resize'), 'the geometry must go out at all').toBeGreaterThanOrEqual(0)
    expect(
      kinds.indexOf('resize'),
      'the caller is told the call succeeded only once main already holds the new geometry',
    ).toBeLessThan(kinds.indexOf('ack'))
    expect(kinds.filter(kind => kind === 'resize')).toHaveLength(1)
  })

  it('leaves the reported geometry alone for a tab-bar change that does not move it', () => {
    const h = makeMiniApp()
    mountShell(h)
    const withBar = lastHeight(h.trace)
    h.trace.length = 0

    act(() => { h.emitTabAction('setTabBarItem', { index: 0, text: 'Renamed' }) })

    const ack = h.trace.find(entry => entry.kind === 'ack')
    expect(ack, 'the call must still be acked').toEqual({ kind: 'ack', ok: true, errMsg: 'setTabBarItem:ok' })
    expect(
      lastHeight(h.trace) === -1 ? withBar : lastHeight(h.trace),
      'text/icon edits keep the bar in the layout flow, so the page viewport must not move',
    ).toBe(withBar)
  })
})
