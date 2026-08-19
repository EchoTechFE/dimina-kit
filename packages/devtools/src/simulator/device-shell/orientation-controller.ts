/**
 * DeviceShell's authority over screen orientation (see shared/page-orientation.ts for the semantics this wraps).
 * One `PageOrientationState` lives per bridgeId for as long as that page stays mounted (visible or cached in a tab substack); DeviceShell registers/releases entries as pages open and close, reads the current top page's effective orientation to size the phone shell, and reports resize payloads gated the same way WeChat's base library gates `Page.onResize` / `wx.onWindowResize`.
 *
 * Effective orientation is a pure function of page configuration and device orientation.
 * Bringing a cached page back to the foreground recomputes from its own immutable configuration without an explicit restore step.
 */
import {
  canUserRotate,
  EMPTY_RESIZE_BASELINE,
  effectiveOrientation,
  orientedDeviceMetrics,
  orientedSafeAreaInsets,
  pageWindowSize,
  resolvePageOrientationState,
  shouldDispatchResize,
  type DeviceMetricsInput,
  type Orientation,
  type PageOrientationState,
  type PageResizePayload,
  type ResizeBaseline,
  type ResizeReportSize,
  type SafeAreaInput,
} from '@dimina-kit/electron-runtime/shared/page-orientation'

/**
 * The chrome geometry the phone shell renders is the same formula the router seeds a spawn's host env with — one implementation in shared/page-orientation.ts, re-exported here for the shell-side callers.
 */
export {
  NAV_BAR_HEIGHT,
  pageWindowSize,
  TAB_BAR_HEIGHT,
  tabBarReservedHeight,
} from '@dimina-kit/electron-runtime/shared/page-orientation'

export class OrientationController {
  private readonly states = new Map<string, PageOrientationState>()
  /** App-global geometry baseline, shared by every bridgeId — see shouldDispatchResize's module doc. */
  private lastDispatched: ResizeBaseline = EMPTY_RESIZE_BASELINE
  /** Registers a freshly-mounted page's orientation state from its resolved window config. Re-registering an already-known bridgeId is a no-op — a page's config never changes after it opens. */
  openPage(bridgeId: string, pageOrientation: unknown): PageOrientationState {
    const existing = this.states.get(bridgeId)
    if (existing) return existing
    const state = resolvePageOrientationState(pageOrientation)
    this.states.set(bridgeId, state)
    return state
  }

  /** Releases a torn-down page's orientation config so the map never outlives its page. */
  closePage(bridgeId: string): void {
    this.states.delete(bridgeId)
  }

  /** Bridge ids this controller currently tracks — used to diff against the live mounted set. */
  knownBridgeIds(): IterableIterator<string> {
    return this.states.keys()
  }

  getState(bridgeId: string): PageOrientationState | undefined {
    return this.states.get(bridgeId)
  }

  /** What `bridgeId` should currently show. Falls back to the device orientation for an unregistered page (shouldn't happen once `openPage` runs before first paint). */
  effectiveFor(bridgeId: string, deviceOrientation: Orientation): Orientation {
    const state = this.states.get(bridgeId)
    return state ? effectiveOrientation(state, deviceOrientation) : deviceOrientation
  }

  /**
   * Build the `PAGE_RESIZE` payload for `bridgeId` at its current effective orientation. `dispatchWindow`/`dispatchPage` follow the gating rules (`shouldDispatchResize`): the window channel fires on a change against the app-global baseline, the page channel carries whichever page this report names without any geometry comparison, and both are silent together for a fixed-orientation page.
   * Every report records the app-global baseline whether or not it dispatched, so a suppressed report still becomes the next comparison's basis.
   */
  buildResizePayload(
    appSessionId: string,
    bridgeId: string,
    deviceOrientation: Orientation,
    size: ResizeReportSize,
  ): PageResizePayload {
    const state = this.states.get(bridgeId)
    if (!state) {
      throw new Error(`[orientation-controller] buildResizePayload: unknown bridgeId ${bridgeId}`)
    }
    const effective = effectiveOrientation(state, deviceOrientation)
    const next = { ...size, deviceOrientation: effective }
    const { dispatchWindow, dispatchPage } = shouldDispatchResize({ state, previous: this.lastDispatched, next })
    this.lastDispatched = next
    return {
      appSessionId,
      bridgeId,
      size,
      deviceOrientation: effective,
      dispatchWindow,
      dispatchPage,
      canRotate: canUserRotate(state),
    }
  }
}

/** The subset of a `PageEntry` a resize computation needs — kept structural so this module doesn't depend on page-stack-controller's types. */
export interface ResizeTargetPage {
  bridgeId: string
  /**
   * Whether the tab bar currently takes layout space away from this page — `page.isTab && tabBarState.visible`, NOT `page.isTab` alone: `wx.hideTabBar` unmounts the bar and hands its height back to the page viewport.
   */
  reservesTabBar: boolean
  navBarStyle: 'default' | 'custom'
}

/**
 * A device profile as the shell holds it: portrait-baseline metrics plus the notch descriptor.
 * Takes `notchType` rather than `SafeAreaInput`'s `hasNotch` so callers hand over `NativeDeviceInfo` untouched and the one boolean the inset formula needs is derived in a single place.
 */
export type ResizeDeviceProfile = DeviceMetricsInput & {
  notchType: string
  safeAreaInsets: SafeAreaInput['safeAreaInsets']
}

/**
 * Full "did the visible page's geometry change" pipeline: derive the page's window size at its effective orientation, record it as on-screen, and build the gated resize payload.
 * DeviceShell's one call site for every trigger — route change or device rotation.
 */
export function computeResizePayload(
  ctrl: OrientationController,
  appSessionId: string,
  page: ResizeTargetPage,
  device: ResizeDeviceProfile,
  deviceOrientation: Orientation,
): PageResizePayload {
  const effective = ctrl.effectiveFor(page.bridgeId, deviceOrientation)
  // The tab bar reserves the inset the page is actually displayed with, which follows the page's effective orientation — a notched phone's landscape home indicator is thinner than its portrait one.
  // Deriving it here rather than taking it as a parameter keeps it the same rule the spawn seed applies (`bridge-router` feeds `withPageWindowSize` the host env's already-oriented insets), so `getSystemInfoSync().windowHeight` cannot answer one number at launch and another on the first frame.
  const bottomInset = orientedSafeAreaInsets(
    { ...device, hasNotch: device.notchType !== 'none' },
    effective,
  ).bottom
  const oriented = orientedDeviceMetrics(device, effective)
  const window = pageWindowSize(oriented, {
    navigationStyle: page.navBarStyle,
    // `PageChrome.isTab` means "the tab bar is in the layout flow below this page", which on a live shell also depends on whether it is hidden.
    isTab: page.reservesTabBar,
    bottomInset,
  })
  // The screen dimensions ride along with the window ones: the base library hands `size` to the callbacks untouched, and the native hosts put both pairs in it.
  const size = {
    screenWidth: oriented.screenWidth,
    screenHeight: oriented.screenHeight,
    ...window,
  }
  return ctrl.buildResizePayload(appSessionId, page.bridgeId, deviceOrientation, size)
}
