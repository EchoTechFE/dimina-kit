/**
 * Screen-orientation policy, shared by the simulator shell (which owns the page stack and is therefore the authority on the effective orientation), the renderer panel geometry, and the main-process resize dispatcher.
 *
 * The semantics mirror WeChat's documented `pageOrientation` configuration: each page resolves its own json falling back to `app.json`'s `window` section, and only pages whose resolved config is `auto` follow the device.
 *
 * Everything here is pure so all three consumers derive identical answers from the same inputs — the effective orientation has exactly one authority and nobody re-implements the rules locally.
 */

export type Orientation = 'portrait' | 'landscape'
export type PageOrientationConfig = 'portrait' | 'auto' | 'landscape'

/** Orientation config default when a page and the app both stay silent. */
export const DEFAULT_PAGE_ORIENTATION: PageOrientationConfig = 'portrait'

const PAGE_ORIENTATION_CONFIGS: readonly PageOrientationConfig[] = ['portrait', 'auto', 'landscape']

export interface PageOrientationState {
  /** Config value resolved from `page.json` ?? `app.json`.window ?? portrait. */
  originalPageOrientation: PageOrientationConfig
}

export interface DeviceMetricsInput {
  /** Portrait-baseline screen width in px. */
  screenWidth: number
  /** Portrait-baseline screen height in px. */
  screenHeight: number
  statusBarHeight: number
}

export interface OrientedMetrics {
  screenWidth: number
  screenHeight: number
  statusBarHeight: number
}

export interface ResizeSize {
  windowWidth: number
  windowHeight: number
}

/**
 * The `size` a host reports.
 * The base library passes this object straight through to the callbacks, so what it carries is the host's choice: the documented `windowWidth`/`windowHeight` plus the whole screen, which is the same pair the native hosts send.
 * The two differ by the chrome the system keeps — status bar and navigation bar — and both swap width/height on rotation.
 */
export interface ResizeReportSize extends ResizeSize {
  screenWidth: number
  screenHeight: number
}

/** The object `Page.onResize`, the `resize` page lifetime and
 *  `wx.onWindowResize` listeners all receive, matching WeChat's payload. */
export interface PageResizeDetail {
  size: ResizeReportSize
  deviceOrientation: Orientation
}

/** DeviceShell → main payload for the `PAGE_RESIZE` channel. */
export interface PageResizePayload {
  appSessionId: string
  bridgeId: string
  size: ResizeReportSize
  deviceOrientation: Orientation
  /**
   * Whether this change fires `wx.onWindowResize`.
   * DeviceShell applies the gating rules (see {@link shouldDispatchResize}); main refreshes the host-env snapshot regardless of either dispatch field.
   */
  dispatchWindow: boolean
  /** Whether this change fires `Page.onResize` / component `resize` — independent of {@link dispatchWindow}. */
  dispatchPage: boolean
  /**
   * Whether the top page lets the user rotate the simulated device (see
   * {@link canUserRotate}). Main relays it to the renderer so the rotate
   * control reflects the page currently on screen.
   */
  canRotate: boolean
}

export function isOrientation(value: unknown): value is Orientation {
  return value === 'portrait' || value === 'landscape'
}

export function isPageOrientationConfig(value: unknown): value is PageOrientationConfig {
  return typeof value === 'string' && PAGE_ORIENTATION_CONFIGS.includes(value as PageOrientationConfig)
}

/**
 * Build a page's orientation state from its resolved window config.
 * Unknown or missing values fall back to portrait, which is also WeChat's default.
 */
export function resolvePageOrientationState(configured: unknown): PageOrientationState {
  return {
    originalPageOrientation: isPageOrientationConfig(configured)
      ? configured
      : DEFAULT_PAGE_ORIENTATION,
  }
}

/** The page's resolved orientation configuration. */
export function computedOrientationConfig(state: PageOrientationState): PageOrientationConfig {
  return state.originalPageOrientation
}

/** What the page actually shows: `auto` follows the device, else the config. */
export function effectiveOrientation(
  state: PageOrientationState,
  deviceOrientation: Orientation,
): Orientation {
  const computed = computedOrientationConfig(state)
  return computed === 'auto' ? deviceOrientation : computed
}

/**
 * Whether the user may rotate the simulated device while this page is on top.
 * Pages pinned to a fixed orientation ignore device rotation, so the control is inert for them.
 */
export function canUserRotate(state: PageOrientationState): boolean {
  return computedOrientationConfig(state) === 'auto'
}

/**
 * Device metrics for a given orientation.
 * Landscape swaps the portrait baseline width/height and drops the status bar, which is what WeChat does on phones; the navigation bar and tab bar keep their heights.
 */
export function orientedDeviceMetrics(
  device: DeviceMetricsInput,
  orientation: Orientation,
): OrientedMetrics {
  if (orientation !== 'landscape') {
    return {
      screenWidth: device.screenWidth,
      screenHeight: device.screenHeight,
      statusBarHeight: device.statusBarHeight,
    }
  }
  return {
    screenWidth: device.screenHeight,
    screenHeight: device.screenWidth,
    statusBarHeight: 0,
  }
}

export interface SafeAreaInsetsShape {
  top: number
  right: number
  bottom: number
  left: number
}

export interface SafeAreaInput {
  /** Portrait-baseline status bar height. In landscape the notch eats this much off each side. */
  statusBarHeight: number
  /** Whether the screen has a notch or dynamic island cutting into it. */
  hasNotch: boolean
  /** Portrait-baseline insets. */
  safeAreaInsets: SafeAreaInsetsShape
}

/**
 * Home-indicator inset a notched iPhone keeps at the bottom in landscape.
 * WeChat lists 21 for every notched iPhone it ships a profile for, and its base library's safe-area fallback for 812x375@3x resolves `--safe-area-inset-bottom: 21px` — two independent statements of the same number, against 34 in portrait.
 */
const LANDSCAPE_HOME_INDICATOR = 21

/**
 * Safe-area insets for a given orientation.
 * Landscape is not the portrait insets rotated: the notch moves from the top edge to BOTH side edges, the top frees up entirely, and the home indicator gets thinner.
 *
 * WeChat's own client recomputes this rather than transforming — on every orientation change its base library re-asks native for a fresh `safeArea` instead of deriving one — so the simulator, which stands in for native here, has to produce the landscape values itself.
 * The side inset equals the status bar height because that is the notch's own depth.
 */
export function orientedSafeAreaInsets(
  device: SafeAreaInput,
  orientation: Orientation,
): SafeAreaInsetsShape {
  if (orientation !== 'landscape') return device.safeAreaInsets
  const side = device.hasNotch ? device.statusBarHeight : 0
  return {
    top: 0,
    right: side,
    bottom: device.hasNotch ? LANDSCAPE_HOME_INDICATOR : 0,
    left: side,
  }
}

/** Navigation bar height; fixed, it does not follow the orientation. */
export const NAV_BAR_HEIGHT = 44

/**
 * The tab bar row's own content height.
 * This is not the height the tab bar occupies in the layout — see {@link tabBarReservedHeight}.
 */
export const TAB_BAR_HEIGHT = 50

/**
 * Height a tab bar actually reserves in the layout flow: the row's content box (`content-box` sizing puts padding on top of the row height), the home-indicator inset its background pads into, and its 1px top border.
 */
export function tabBarReservedHeight(bottomInset: number): number {
  return TAB_BAR_HEIGHT + bottomInset + 1
}

/** The chrome a page keeps in the layout flow around its window area. */
export interface PageChrome {
  /** `custom` takes the navigation bar out of flow, so nothing is reserved above the page. */
  navigationStyle?: 'default' | 'custom'
  /** Whether this is a tabBar page, which keeps the tab bar in flow below it. */
  isTab: boolean
  /** Portrait-baseline bottom safe-area inset the tab bar pads its background into. */
  bottomInset: number
}

/**
 * A page's window size on a given oriented screen: the screen minus the chrome that stays in the layout flow.
 * The status bar never reserves flow space by itself — the default navigation bar's box already spans it — so a `custom` navigation style leaves the full screen height above the tab bar.
 *
 * Every consumer that reports `windowWidth`/`windowHeight` to a mini-app goes through here: the simulator shell when it measures a live page, and the router when it seeds a spawn's host env before the shell has measured anything.
 * One formula, so the seed and the first measured frame agree.
 */
export function pageWindowSize(oriented: OrientedMetrics, chrome: PageChrome): ResizeSize {
  const reservedTop = chrome.navigationStyle === 'custom'
    ? 0
    : oriented.statusBarHeight + NAV_BAR_HEIGHT
  const reservedBottom = chrome.isTab ? tabBarReservedHeight(chrome.bottomInset) : 0
  return {
    windowWidth: oriented.screenWidth,
    windowHeight: Math.max(0, oriented.screenHeight - reservedTop - reservedBottom),
  }
}

/** Screen metrics plus the window fields a host-env snapshot reports. */
export interface WindowMetricsFields extends OrientedMetrics {
  windowWidth: number
  windowHeight: number
}

/**
 * Rewrite a snapshot's window size to what `chrome` leaves of the snapshot's own (already oriented) screen metrics, leaving every other field untouched.
 */
export function withPageWindowSize<T extends WindowMetricsFields>(env: T, chrome: PageChrome): T {
  return { ...env, ...pageWindowSize(env, chrome) }
}

/**
 * WeChat's own guidance is to trust the window dimensions over a reported orientation, so an absent or malformed value is derived from the size.
 */
export function normalizeDeviceOrientation(
  size: ResizeSize,
  deviceOrientation?: unknown,
): Orientation {
  if (isOrientation(deviceOrientation)) return deviceOrientation
  return size.windowWidth > size.windowHeight ? 'landscape' : 'portrait'
}

/** App-global geometry baseline a resize report is compared against. */
export interface ResizeBaseline {
  windowWidth: number
  windowHeight: number
  deviceOrientation: string
}

/**
 * Sentinel baseline before any resize has ever been reported, mirroring WeChat's own `d="",p=0,h=0` module-level init — it is guaranteed to differ from any real geometry, so the very first-ever report already counts as a change instead of being special-cased as silent.
 */
export const EMPTY_RESIZE_BASELINE: ResizeBaseline = { windowWidth: 0, windowHeight: 0, deviceOrientation: '' }

export interface ResizeDispatchInput {
  state: PageOrientationState
  /** App-global geometry baseline, shared by every page. */
  previous: ResizeBaseline
  next: { windowWidth: number, windowHeight: number, deviceOrientation: Orientation }
}

export interface ResizeDispatchResult {
  /** Gates `wx.onWindowResize`: fires only when the app-global baseline actually moved. */
  dispatchWindow: boolean
  /** Gates `Page.onResize` / component `resize`: fires for whichever page is being reported. */
  dispatchPage: boolean
}

/**
 * Resize gating. Two channels with different rules:
 *
 * - The window channel (`wx.onWindowResize`) is app-global: it fires when the
 * geometry moved against the baseline every page shares.
 * One baseline for the whole mini-app, not one per page.
 * - The page channel (`Page.onResize` / component `resize`) applies no geometry
 * test at all: it carries whichever page the report names, so deciding WHEN to report is the host's job.
 *
 * Both stay silent for a page pinned to a fixed orientation. `resolveResizeDispatch` in dimina's `fe/packages/service/src/core/runtime.js` encodes the same two rules.
 *
 * A route commit reports its landing page unconditionally.
 * Suppressing it when the geometry happens to match would leave a page returning from a landscape page into a still-landscape window rendering at the portrait rpx basis, with no callback to correct it — reporting the landing page is what keeps its layout answering to the window it is actually in.
 *
 * Deciding WHEN to report is the caller's job — see `OrientationController`, which publishes on every route commit and on device rotation.
 *
 * Main's `wx.onWindowResize` listener table forks off this same decision point — see `applyPageResize` in bridge-router.ts.
 * Any change belongs in both.
 */
export function shouldDispatchResize(
  { state, previous, next }: ResizeDispatchInput,
): ResizeDispatchResult {
  const suppressed = computedOrientationConfig(state) !== 'auto'

  return {
    dispatchWindow: movedAgainst(previous, next) && !suppressed,
    dispatchPage: !suppressed,
  }
}

function movedAgainst(
  baseline: ResizeBaseline,
  next: { windowWidth: number, windowHeight: number, deviceOrientation: Orientation },
): boolean {
  return baseline.windowWidth !== next.windowWidth
    || baseline.windowHeight !== next.windowHeight
    || baseline.deviceOrientation !== next.deviceOrientation
}
