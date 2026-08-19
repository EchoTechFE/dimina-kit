import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import {
  orientedDeviceMetrics,
  orientedSafeAreaInsets,
  type Orientation,
  type OrientedMetrics,
} from '@dimina-kit/electron-runtime/shared/page-orientation'
import type { NativeDeviceInfo } from '../../shared/ipc-channels'
import type { SimulatorMiniApp } from '../simulator-mini-app'
import type { MiniAppFrameLayoutState } from '@dimina-kit/electron-runtime/simulator-ui'
import {
  computeResizePayload,
  OrientationController,
} from './orientation-controller'

export interface UseOrientationResult {
  /** Oriented device metrics for the current top page; null before a device is known. */
  orientedMetrics: OrientedMetrics | null
  /**
   * Bottom safe-area inset at the top page's effective orientation — the same number the page's window height is computed against, so the chrome the shell paints there and the room the page is told it has agree.
   */
  orientedBottomInset: number
  /**
   * Publish the authoritative `PAGE_RESIZE` for `page` as the visible top page, right now.
   * A synchronous route calls this before dispatching the lifecycle events of the transition, so `onShow` reads a host-env snapshot that already describes the page being shown.
   */
  publishTopResize: (page: MiniAppFrameLayoutState['top'], tabBarVisible?: boolean) => void
  /**
   * Advance the device the next synchronous publish resolves geometry against.
   * DEVICE_CHANGE and a route can arrive in the same batch, and routing publishes before React commits — so the device the shell reports has to move the instant the change arrives, not one commit later.
   */
  applyDevice: (device: NativeDeviceInfo | null) => void
}

/**
 * Everything that goes into a resize report.
 * Two reports built from identical inputs would carry identical geometry, so re-publishing one only adds a `Page.onResize` the host never had a reason to send.
 */
interface ResizeInputs {
  bridgeId: string
  reservesTabBar: boolean
  navBarStyle: MiniAppFrameLayoutState['top']['navBar']['style']
  device: NativeDeviceInfo
  deviceOrientation: Orientation
}

function sameResizeInputs(previous: ResizeInputs | null, next: ResizeInputs): boolean {
  return previous !== null
    && previous.bridgeId === next.bridgeId
    && previous.reservesTabBar === next.reservesTabBar
    && previous.navBarStyle === next.navBarStyle
    && previous.device === next.device
    && previous.deviceOrientation === next.deviceOrientation
}

/** Geometry facts used by synchronous route commits. */
interface LiveSnapshot {
  mounted: MiniAppFrameLayoutState['mounted']
  device: NativeDeviceInfo | null
  deviceOrientation: Orientation
  tabBarVisible: boolean
}

/**
 * DeviceShell's orientation glue: owns the `OrientationController` instance, keeps its tracked pages in sync with what's mounted, reports the visible top page's geometry to main on every relevant change (route, device rotation), and returns the metrics DeviceShell renders the phone shell at.
 * See orientation-controller.ts for the underlying pure, unit-tested semantics this wires into React.
 */
export function useOrientation(
  miniApp: SimulatorMiniApp,
  layout: MiniAppFrameLayoutState,
  device: NativeDeviceInfo | null,
): UseOrientationResult {
  const { top, mounted, tabBarVisible } = layout
  const deviceOrientation: Orientation = device?.deviceOrientation ?? 'portrait'

  const [orientation] = useState(() => new OrientationController())
  // The top page is registered during RENDER, before `orientedMetrics` below reads it.
  // Registering only from the layout effect would measure every freshly routed page one render too late: the shell would paint the orientation of the page it replaced and nothing would schedule the render that corrects it. `openPage` returns the existing state for a page it already tracks, so repeating it every render (twice under StrictMode) changes nothing.
  orientation.openPage(top.bridgeId, top.windowConfig.pageOrientation)
  // The live snapshot advances in the same layout effect that reconciles the controller's page ledger, so synchronous route commits cannot publish against a page set that has already been torn down.
  const liveRef = useRef<LiveSnapshot>({ mounted, device, deviceOrientation, tabBarVisible })
  const publishedRef = useRef<ResizeInputs | null>(null)

  useLayoutEffect(() => {
    liveRef.current = { mounted, device, deviceOrientation, tabBarVisible }
    const live = new Set(mounted.map(m => m.entry.bridgeId))
    for (const { entry } of mounted) {
      orientation.openPage(entry.bridgeId, entry.windowConfig.pageOrientation)
    }
    for (const bridgeId of orientation.knownBridgeIds()) {
      if (!live.has(bridgeId)) orientation.closePage(bridgeId)
    }
    if (!device) return
    const inputs: ResizeInputs = {
      bridgeId: top.bridgeId,
      reservesTabBar: top.isTab && tabBarVisible,
      navBarStyle: top.navBar.style,
      device,
      deviceOrientation,
    }
    // The layout state is rebuilt for anything the frame renders — a navigation bar title, a loading spinner — and none of that moves the page's window.
    // Publishing per layout object would put a `Page.onResize` behind `setNavigationBarTitle`, since the page channel is not geometry-deduped downstream (see shouldDispatchResize).
    // Route commits publish through `publishTopResize` and record their inputs here, so the effect that follows one of them stays quiet.
    if (sameResizeInputs(publishedRef.current, inputs)) return
    publishedRef.current = inputs
    miniApp.notifyResize(computeResizePayload(
      orientation,
      miniApp.appSessionId ?? '',
      { bridgeId: inputs.bridgeId, reservesTabBar: inputs.reservesTabBar, navBarStyle: inputs.navBarStyle },
      device,
      deviceOrientation,
    ))
  }, [mounted, orientation, deviceOrientation, device, miniApp, top, tabBarVisible])

  // Routing is synchronous: the reducer decides the new top and immediately dispatches its lifecycle events.
  // The resize has to ride that same tick — the layout effect below only runs after React commits, by which time the page has already read its metrics in `onShow`, and a restored page whose own size did not change would never get a corrective `onResize`.
  // Reads the live snapshot rather than this render's closure so the caller cannot publish against a device selection that has already moved on.
  const applyDevice = useCallback((next: NativeDeviceInfo | null) => {
    liveRef.current = {
      ...liveRef.current,
      device: next,
      deviceOrientation: next?.deviceOrientation ?? 'portrait',
    }
  }, [])

  const publishTopResize = useCallback((
    page: MiniAppFrameLayoutState['top'],
    committedTabBarVisible?: boolean,
  ) => {
    const snap = liveRef.current
    const visibleTabBar = committedTabBarVisible ?? snap.tabBarVisible
    if (committedTabBarVisible !== undefined) {
      publishedRef.current = snap.device
        ? {
            bridgeId: page.bridgeId,
            reservesTabBar: page.isTab && committedTabBarVisible,
            navBarStyle: page.navBar.style,
            device: snap.device,
            deviceOrientation: snap.deviceOrientation,
          }
        : null
      const committedMounted = snap.mounted.some(item => item.entry.bridgeId === page.bridgeId)
        ? snap.mounted.map(item => ({
            ...item,
            visible: item.entry.bridgeId === page.bridgeId,
          }))
        : [{ entry: page, visible: true }, ...snap.mounted.map(item => ({ ...item, visible: false }))]
      liveRef.current = { ...snap, mounted: committedMounted, tabBarVisible: committedTabBarVisible }
    }
    if (!snap.device) return
    orientation.openPage(page.bridgeId, page.windowConfig.pageOrientation)
    miniApp.notifyResize(computeResizePayload(
      orientation,
      miniApp.appSessionId ?? '',
      {
        bridgeId: page.bridgeId,
        reservesTabBar: page.isTab && visibleTabBar,
        navBarStyle: page.navBar.style,
      },
      snap.device,
      snap.deviceOrientation,
    ))
  }, [miniApp, orientation])

  const topEffective = orientation.effectiveFor(top.bridgeId, deviceOrientation)
  return {
    orientedMetrics: device ? orientedDeviceMetrics(device, topEffective) : null,
    // What the shell PAINTS at the bottom (home indicator, tab-bar padding) has to be the same inset `computeResizePayload` takes out of the page's window, or the page would be told it has less room than the chrome actually occupies.
    orientedBottomInset: device
      ? orientedSafeAreaInsets({ ...device, hasNotch: device.notchType !== 'none' }, topEffective).bottom
      : 0,
    publishTopResize,
    applyDevice,
  }
}
