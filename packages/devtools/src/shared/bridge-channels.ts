import type { NativeDeviceInfo } from './ipc-channels.js'

export const BRIDGE_CHANNELS = {
  SPAWN: 'dmb:spawn',
  DISPOSE: 'dmb:dispose',
  PAGE_OPEN: 'dmb:page:open',
  PAGE_CLOSE: 'dmb:page:close',
  PAGE_LIFECYCLE: 'dmb:page:lifecycle',
  NAV_CALLBACK: 'dmb:nav:callback',
  SERVICE_INVOKE: 'dmb:service:invoke',
  SERVICE_PUBLISH: 'dmb:service:publish',
  RENDER_INVOKE: 'dmb:render:invoke',
  RENDER_PUBLISH: 'dmb:render:publish',
  TO_SERVICE: 'dmb:to-service',
  TO_RENDER: 'dmb:to-render',
  SIMULATOR_API: 'dmb:simulator-api',
  /** simulator → main: ack of an API_CALL request (carries success/fail args). */
  API_RESPONSE: 'dmb:api:response',
  /**
   * simulator webview preload → main (sendSync): "is native-host mode on?".
   * The guest preload can't read the launch `process.env`, so it asks main
   * (which can) at install time. Reply is `e.returnValue = boolean`.
   */
  NATIVE_HOST_ENABLED: 'dmb:native-host-enabled',
  /**
   * simulator (DeviceShell) → main: the visible top-of-stack page bridgeId.
   * Main has no z-order concept — the active page lives only in DeviceShell's
   * ShellState — so devtools panels / automation that must target "the current
   * page's render webContents" resolve it through this signal. Fire-and-forget.
   */
  ACTIVE_PAGE: 'dmb:active-page',
  /**
   * simulator (DeviceShell) → main: the FULL ordered page stack (bottom→top)
   * whenever it changes. Main has no stack of its own (it only learns the
   * active bridgeId via ACTIVE_PAGE), so automation's `App.getPageStack` needs
   * this to report multi-page stacks. Fire-and-forget.
   */
  PAGE_STACK: 'dmb:page-stack',
} as const

export const SIMULATOR_EVENTS = {
  DOM_READY: 'simulator:dom-ready',
  NAV_BAR: 'simulator:navigation-bar',
  NAV_ACTION: 'simulator:nav-action',
  TAB_ACTION: 'simulator:tab-action',
  /** main → simulator: invoke a wx.* API on the simulator-resident MiniApp. */
  API_CALL: 'simulator:api-call',
  /**
   * main → simulator: the renderer toolbar picked a different device. Carries a
   * NativeDeviceInfo; DeviceShell resizes the bezel + re-renders status bar /
   * notch. The race-free INITIAL device rides NativeHostConfig.device (read
   * synchronously at preload bridge-install); this event covers live changes.
   */
  DEVICE_CHANGE: 'simulator:device-change',
} as const

export const CHANNELS = BRIDGE_CHANNELS

/**
 * Reply to a `NATIVE_HOST_ENABLED` sendSync. Main supplies the render-host
 * file:// URLs (computed with node:path/url, which the simulator webview's
 * preload lacks) so the preload can build the native-host bridge.
 */
export interface NativeHostConfig {
  enabled: boolean
  renderHostHtmlUrl: string
  renderPreloadUrl: string
  /**
   * The currently-selected device, if the renderer already pushed it before the
   * simulator WCV's preload installed (it does — SetDeviceInfo precedes
   * AttachNative). DeviceShell reads this as its initial device so it never
   * mounts with the wrong bezel size while waiting for the first DEVICE_CHANGE.
   * Absent only on the pre-spawn default path.
   */
  device?: NativeDeviceInfo
}

export type BridgeChannel = typeof BRIDGE_CHANNELS[keyof typeof BRIDGE_CHANNELS]

export type BridgeTarget = 'service' | 'render' | 'container'

export type BridgeMessageType =
  | 'loadResource'
  | 'serviceResourceLoaded'
  | 'renderResourceLoaded'
  | 'resourceLoaded'
  | 'firstRender'
  | 'appShow'
  | 'appHide'
  | 'stackShow'
  | 'stackHide'
  | 'pageShow'
  | 'pageHide'
  | 'pageReady'
  | 'pageUnload'
  | 'pageScroll'
  | 'pageResize'
  | 'pageRouteDone'
  | 'mC'
  | 'mR'
  | 'mU'
  | 't'
  | 'u'
  | 'ub'
  | 'triggerCallback'
  | 'invokeAPI'
  | 'h5SdkAction'
  | 'componentError'
  | 'domReady'
  | 'print'
  | 'renderHostReady'
  | 'serviceHostError'
  | string

export interface MessageEnvelope<TBody extends Record<string, unknown> = Record<string, unknown>> {
  type: BridgeMessageType
  target: BridgeTarget
  body: TBody
}

export interface HostEnvSnapshot {
  brand: string
  model: string
  platform: string
  system: string
  version: string
  SDKVersion: string
  pixelRatio: number
  screenWidth: number
  screenHeight: number
  windowWidth: number
  windowHeight: number
  statusBarHeight: number
  language: string
  theme: string
  [key: string]: unknown
}

/**
 * Map the renderer's logical device metrics onto the subset of a
 * HostEnvSnapshot the service-host window's `getSystemInfoSync` consumes.
 * `windowHeight` excludes the status bar (the page area); `windowWidth` has no
 * horizontal chrome. Zoom is intentionally absent — it is a display scale, not
 * a logical-size change.
 *
 * Single source of truth for the device→host-env mapping, shared by the live
 * `SetDeviceInfo` IPC path (main/ipc/simulator.ts) and the per-spawn host-env
 * seeding (main/ipc/bridge-router.ts). Keeping them identical guarantees a
 * service-host RESPAWN after a device change reports the same dims the live
 * update pushed — otherwise a respawn would silently revert to the boot device.
 */
export function deviceInfoToHostEnv(d: NativeDeviceInfo): Partial<HostEnvSnapshot> {
  return {
    brand: d.brand,
    model: d.model,
    system: d.system,
    platform: d.platform,
    pixelRatio: d.pixelRatio,
    screenWidth: d.screenWidth,
    screenHeight: d.screenHeight,
    windowWidth: d.screenWidth,
    windowHeight: Math.max(0, d.screenHeight - d.statusBarHeight),
    statusBarHeight: d.statusBarHeight,
  }
}

/**
 * Subset of WeChat page `window` config plus tabBar list, parsed from
 * `app-config.json` (`{app:{window,tabBar,pages,entryPagePath}, modules:{[pagePath]:{window}}}`).
 * Mirrors mergePageConfig in dimina-fe: page-level keys override app-level.
 */
export interface PageWindowConfig {
  navigationBarTitleText?: string
  navigationBarBackgroundColor?: string
  navigationBarTextStyle?: 'black' | 'white'
  navigationStyle?: 'default' | 'custom'
  homeButton?: boolean
  backgroundColor?: string
  backgroundTextStyle?: 'dark' | 'light'
  enablePullDownRefresh?: boolean
  disableScroll?: boolean
  [key: string]: unknown
}

export interface TabBarItem {
  pagePath: string
  text?: string
  iconPath?: string
  selectedIconPath?: string
}

export interface TabBarConfig {
  color?: string
  selectedColor?: string
  backgroundColor?: string
  borderStyle?: 'black' | 'white'
  position?: 'bottom' | 'top'
  custom?: boolean
  list: TabBarItem[]
}

export interface AppManifest {
  entryPagePath: string
  pages: string[]
  tabBar?: TabBarConfig
}

export interface SpawnRequest {
  simulatorWcId?: number
  appId: string
  bridgeId?: string
  pagePath?: string
  scene?: number
  query?: Record<string, unknown>
  apiNamespaces?: string[]
  hostEnvSnapshot?: Partial<HostEnvSnapshot>
  pkgRoot?: string
  root?: string
  /**
   * Base URL of the dev server that serves the compiled mini-app, i.e. the
   * SAME origin the simulator page was loaded from (`http://localhost:<port>/`).
   * The dev server statically serves `<appId>/<root>/…` (app-config.json,
   * logic.js, page bundles, styles) — exactly what the default dimina-fe
   * `<webview>` fetches. The native-host render + service hosts source every
   * resource from here, so we don't need a second resource server or a local
   * compiled-output path. Trailing slash expected.
   */
  resourceBaseUrl?: string
}

export interface SpawnResult {
  appSessionId: string
  bridgeId: string
  pagePath: string
  serviceWcId: number
  resourceBaseUrl: string
  manifest: AppManifest
  rootWindowConfig: PageWindowConfig
}

export interface PageOpenRequest {
  appSessionId: string
  pagePath: string
  query?: Record<string, unknown>
  bridgeId?: string
}

export interface PageOpenResult {
  bridgeId: string
  pagePath: string
  windowConfig: PageWindowConfig
  isTab: boolean
}

export interface PageClosePayload {
  bridgeId: string
}

export interface DisposePayload {
  /** AppSession root bridgeId (legacy) or any page bridgeId. */
  bridgeId: string
}

export type PageLifecycleEvent =
  | 'pageShow'
  | 'pageHide'
  | 'pageUnload'
  | 'stackShow'
  | 'stackHide'
  | 'appShow'
  | 'appHide'

export interface PageLifecyclePayload {
  appSessionId: string
  bridgeId: string
  event: PageLifecycleEvent
}

/**
 * Sent by simulator after a routing action (navigateTo etc.) completes so the
 * main process can call sendCallback() against the original service-issued
 * success/fail/complete ids.
 */
export interface NavCallbackPayload {
  appSessionId: string
  ok: boolean
  errMsg: string
  callbacks: { success?: unknown; fail?: unknown; complete?: unknown }
}

export interface ServiceInvokePayload {
  bridgeId: string
  msg: MessageEnvelope
}

export interface ServicePublishPayload {
  bridgeId: string
  targetBridgeId?: string
  msg: MessageEnvelope
}

/**
 * `dmb:active-page` — simulator (DeviceShell) → main. Records which page is the
 * visible top-of-stack so main-side services (WXML/element-inspect, automation)
 * can resolve "the active page's render webContents" by bridgeId.
 */
export interface ActivePagePayload {
  appSessionId: string
  bridgeId: string
}

/**
 * `dmb:page-stack` — simulator (DeviceShell) → main. The full ordered page
 * stack (bottom→top) so `App.getPageStack` can report multi-page stacks.
 */
export interface PageStackEntry {
  pagePath: string
  query: Record<string, unknown>
}

export interface PageStackPayload {
  appSessionId: string
  stack: PageStackEntry[]
}

export interface RenderInvokePayload {
  bridgeId: string
  msg: MessageEnvelope
}

export interface RenderPublishPayload {
  bridgeId: string
  msg: MessageEnvelope
}

export interface ToServicePayload {
  msg: MessageEnvelope
}

export interface ToRenderPayload {
  msg: MessageEnvelope
}

export interface SimulatorApiInvokePayload {
  bridgeId: string
  name: string
  params: unknown
}

/**
 * `simulator:nav-action` — main → simulator window, carries router/tabBar
 * intentions. Simulator owns the visual stack state and decides whether to
 * push/pop webviews; it then calls back PAGE_LIFECYCLE + NAV_CALLBACK.
 */
export interface NavActionPayload {
  appSessionId: string
  bridgeId: string
  name: 'navigateTo' | 'navigateBack' | 'redirectTo' | 'reLaunch' | 'switchTab'
  params: Record<string, unknown>
  callbacks: { success?: unknown; fail?: unknown; complete?: unknown }
}

/**
 * `simulator:api-call` — main → simulator. Fallback path used when an
 * invokeAPI name is not registered in the main-process `ctx.simulatorApis`
 * registry: the simulator-resident MiniApp owns the wx.* handler (it can
 * read DOM, open file pickers, etc.), so we forward the call there and wait
 * for an `API_RESPONSE` ack.
 */
export interface ApiCallPayload {
  appSessionId: string
  bridgeId: string
  requestId: string
  name: string
  params: Record<string, unknown>
  callbacks: { success?: unknown; fail?: unknown; complete?: unknown }
}

/**
 * `dmb:api:response` — simulator → main. Ack for an `API_CALL`. Main looks
 * up `requestId` in its pending map and fires the original service-side
 * success/fail/complete callbacks accordingly.
 */
export interface ApiResponsePayload {
  appSessionId: string
  requestId: string
  ok: boolean
  /** Argument the simulator-side success/fail callback was invoked with. */
  result?: unknown
  errMsg?: string
  /**
   * Persistent-subscription marker (`keep: true` APIs, e.g.
   * `audioListen`). When set, this response is one of potentially many
   * fires of the same subscription: main re-fires the service-side success
   * callback but keeps the pendingApiCall alive (does not delete it or fire
   * `complete`) so subsequent fires of the same `requestId` are delivered.
   * Cleanup happens on page/app teardown instead.
   */
  keep?: boolean
}

/**
 * `simulator:tab-action` — main → simulator window, carries dynamic TabBar
 * API calls. Simulator updates TabBar React state and acknowledges via
 * NAV_CALLBACK so the service-side wx.* callback fires.
 */
export interface TabActionPayload {
  appSessionId: string
  bridgeId: string
  name:
    | 'setTabBarStyle'
    | 'setTabBarItem'
    | 'showTabBar'
    | 'hideTabBar'
    | 'setTabBarBadge'
    | 'removeTabBarBadge'
    | 'showTabBarRedDot'
    | 'hideTabBarRedDot'
  params: Record<string, unknown>
  callbacks: { success?: unknown; fail?: unknown; complete?: unknown }
}
