import { SIMULATOR_EVENTS } from '../shared/bridge-channels'
import type {
  ActivePagePayload,
  ApiResponsePayload,
  AppManifest,
  HostEnvSnapshot,
  NavCallbackPayload,
  PageLifecycleEvent,
  PageOpenResult,
  PageStackEntry,
  PageStackPayload,
  PageWindowConfig,
  SessionActivePayload,
  SpawnRequest,
  SpawnResult,
  TabBarConfig,
} from '../shared/bridge-channels'
import type { PageResizePayload } from '@dimina-kit/electron-runtime/shared/page-orientation'
import type { NativeDeviceInfo } from '../shared/ipc-channels'
import type { DeviceMetrics } from './types'

type ApiHandler = (this: SimulatorMiniApp, params?: unknown) => unknown | Promise<unknown>

interface NativeHostBridge {
  enabled: boolean
  spawn(opts: SpawnRequest): Promise<SpawnResult>
  dispose(bridgeId: string): void
  openPage(opts: {
    appSessionId: string
    pagePath: string
    query?: Record<string, unknown>
    bridgeId?: string
  }): Promise<PageOpenResult>
  closePage(bridgeId: string): void
  notifyLifecycle(payload: { appSessionId: string; bridgeId: string; event: PageLifecycleEvent }): void
  notifyNavCallback(payload: NavCallbackPayload): void
  notifyApiResponse(payload: ApiResponsePayload): void
  notifyActivePage(payload: ActivePagePayload): void
  notifyPageStack(payload: PageStackPayload): void
  notifyResize(payload: PageResizePayload): void
  notifySessionActive(payload: SessionActivePayload): void
  createRenderHostUrl(opts: { bridgeId: string; appId: string; root: string; pagePath: string; isTab?: boolean; backgroundColor?: string }): string
  renderPreloadUrl: string
  device?: NativeDeviceInfo
  onSimulatorEvent<T = unknown>(channel: string, listener: (payload: T) => void): () => void
}

declare global {
  interface Window {
    __diminaNativeHost?: NativeHostBridge
  }
}

export interface SimulatorMiniAppOptions {
  appId: string
  scene: number
  pagePath: string
  query?: Record<string, string>
  apiNamespaces?: string[]
  /**
   * Which mobile platform the simulator emulates. Drives NavigationBar layout
   * (title-center vs title-left), status bar height, and the WeChat capsule
   * geometry returned by `wx.getMenuButtonBoundingClientRect()`.
   */
  platform?: 'ios' | 'android'
}

export class SimulatorMiniApp {
  readonly appId: string
  readonly scene: number
  /**
   * The pagePath this session actually mounted. Starts as the constructor
   * request but is overwritten by `spawn()` with `result.resolvedPagePath` —
   * main may have fallen back to a different root page (the request was
   * absent from the compiled manifest), and every consumer reading this field
   * (DeviceShell's root stack entry, persisted "resume last page" state) must
   * see the page the session was ACTUALLY spawned with, not the request.
   */
  pagePath: string
  readonly query: Record<string, string>
  readonly apiRegistry: Record<string, ApiHandler | undefined> = {}

  appSessionId: string | null = null
  bridgeId: string | null = null
  resourceBaseUrl: string | null = null
  /** The page's resource root inside the mini-app package (e.g. `'main'`); set from `SpawnResult.root` — see `createRenderHostUrl`. */
  root: string | null = null
  serviceWcId: number | null = null
  manifest: AppManifest | null = null
  rootWindowConfig: PageWindowConfig | null = null
  readonly platform: 'ios' | 'android'
  private readonly apiNamespaces: string[]
  /**
   * Latest device delivered over SIMULATOR_EVENTS.DEVICE_CHANGE (live toolbar
   * switches); `getInitialDevice()` prefers it over the boot config, which is a snapshot frozen at preload-install time.
   * Cleared on dispose() along with the subscription — the next spawn re-subscribes before it requests the session, so every change from then on is observed.
   */
  private currentDevice: NativeDeviceInfo | null = null
  private unsubscribeDeviceChange: (() => void) | null = null

  constructor(opts: SimulatorMiniAppOptions) {
    this.appId = opts.appId
    this.scene = opts.scene
    this.pagePath = opts.pagePath
    this.query = { ...(opts.query ?? {}) }
    this.apiNamespaces = opts.apiNamespaces ?? []
    this.platform = opts.platform ?? 'ios'
  }

  registerApi(name: string, handler: ApiHandler): void {
    this.apiRegistry[name] = handler
  }

  invokeApi(name: string, params?: unknown): unknown | Promise<unknown> {
    const handler = this.apiRegistry[name]
    if (!handler) return undefined
    return handler.call(this, params)
  }

  async spawn(): Promise<string> {
    const nativeHost = getNativeHost()
    // Track live device switches: main pushes SIMULATOR_EVENTS.DEVICE_CHANGE on
    // bridge.setDevice (toolbar device picker). The simulator-resident wx.* API
    // handlers read the device through getDeviceMetrics(), so the forwarded
    // async getSystemInfo/getWindowInfo path follows the selection instead of
    // answering a constant fallback rect forever.
    this.unsubscribeDeviceChange ??= nativeHost.onSimulatorEvent<NativeDeviceInfo>(
      SIMULATOR_EVENTS.DEVICE_CHANGE,
      (device) => {
        this.currentDevice = device
      },
    )
    const result = await nativeHost.spawn({
      appId: this.appId,
      scene: this.scene,
      pagePath: this.pagePath,
      query: this.query,
      apiNamespaces: this.apiNamespaces,
      hostEnvSnapshot: this.getHostEnvSnapshot(),
      // The simulator page is served by the dev server at
      // `http://localhost:<port>/simulator.html`; that same origin statically
      // serves the compiled `<appId>/<root>/…` resources (app-config, logic.js,
      // page bundles). Hand it to main so the render/service hosts fetch from
      // the same place the default dimina-fe path does — no separate resource
      // server, no local compiled-output path needed.
      resourceBaseUrl: `${window.location.origin}/`,
    })
    this.appSessionId = result.appSessionId
    this.bridgeId = result.bridgeId
    this.resourceBaseUrl = result.resourceBaseUrl
    this.root = result.root
    this.serviceWcId = result.serviceWcId
    this.manifest = result.manifest
    this.rootWindowConfig = result.rootWindowConfig
    // Reconcile with main's actual root page: a fallback (request absent from
    // the compiled manifest) means main mounted `resolvedPagePath`, not the
    // constructor's request — every later reader of `this.pagePath` must agree
    // with what is actually live.
    this.pagePath = result.resolvedPagePath
    return result.bridgeId
  }

  dispose(): void {
    this.unsubscribeDeviceChange?.()
    this.unsubscribeDeviceChange = null
    this.currentDevice = null
    if (!this.appSessionId) return
    getNativeHost().dispose(this.appSessionId)
    this.appSessionId = null
    this.bridgeId = null
    this.resourceBaseUrl = null
    this.root = null
    this.serviceWcId = null
    this.manifest = null
    this.rootWindowConfig = null
  }

  /**
   * Allocate a new render page within the active app session. Returns the new
   * bridgeId + the merged page window config so the device shell can paint
   * NavigationBar before the bundle finishes loading.
   */
  async openPage(pagePath: string, query: Record<string, unknown> = {}): Promise<PageOpenResult> {
    const appSessionId = this.requireAppSessionId()
    return getNativeHost().openPage({ appSessionId, pagePath, query })
  }

  closePage(bridgeId: string): void {
    if (!this.appSessionId) return
    getNativeHost().closePage(bridgeId)
  }

  notifyLifecycle(bridgeId: string, event: PageLifecycleEvent): void {
    const appSessionId = this.appSessionId
    if (!appSessionId) return
    getNativeHost().notifyLifecycle({ appSessionId, bridgeId, event })
  }

  notifyNavCallback(payload: Omit<NavCallbackPayload, 'appSessionId'>): void {
    const appSessionId = this.appSessionId
    if (!appSessionId) return
    getNativeHost().notifyNavCallback({ appSessionId, ...payload })
  }

  /**
   * Ack a `simulator:api-call` from main. Forwards the captured success/fail
   * args back over the native-host bridge so main can drive the original
   * service-side success/fail/complete callbacks against the registered ids.
   */
  notifyApiResponse(payload: Omit<ApiResponsePayload, 'appSessionId'>): void {
    const appSessionId = this.appSessionId
    if (!appSessionId) return
    getNativeHost().notifyApiResponse({ appSessionId, ...payload })
  }

  /**
   * Tell main which page is now the visible top-of-stack. DeviceShell calls
   * this whenever the stack top changes so main-side panels/automation can
   * target the active page's render webContents.
   */
  notifyActivePage(bridgeId: string): void {
    const appSessionId = this.appSessionId
    if (!appSessionId) return
    getNativeHost().notifyActivePage({ appSessionId, bridgeId })
  }

  /**
   * Report the full ordered page stack (bottom→top) so automation's
   * `App.getPageStack` can return a multi-page stack. DeviceShell calls this on
   * every stack change (push / pop / switchTab).
   */
  notifyPageStack(stack: PageStackEntry[]): void {
    const appSessionId = this.appSessionId
    if (!appSessionId) return
    getNativeHost().notifyPageStack({ appSessionId, stack })
  }

  /**
   * Report the visible top page's window geometry (PAGE_RESIZE).
   * Main always refreshes the host-env snapshot from this; it also dispatches `pageResize` to the service host when `payload.dispatchPage` is true and fires `wx.onWindowResize` listeners when `payload.dispatchWindow` is true (DeviceShell already applied WeChat's gating — see orientation-controller.ts).
   */
  notifyResize(payload: PageResizePayload): void {
    if (!this.appSessionId) return
    getNativeHost().notifyResize(payload)
  }

  /**
   * Claim the screen for this session.
   * DeviceShell calls it the moment it becomes the visible shell — during a soft reload two shells are mounted and both report geometry, so main only learns which one the user sees because the visible one says so.
   */
  notifySessionActive(): void {
    const appSessionId = this.appSessionId
    if (!appSessionId) return
    getNativeHost().notifySessionActive({ appSessionId })
  }

  getTabBarConfig(): TabBarConfig | null {
    return this.manifest?.tabBar ?? null
  }

  /**
   * The app's own home page.
   * A fallback manifest reflects the launch request, not the compiled home page, so it deliberately disables the home rule.
   */
  getHomePagePath(): string {
    const manifest = this.manifest
    if (!manifest || manifest.source !== 'app-config') return ''
    return manifest.entryPagePath || manifest.pages?.[0] || ''
  }

  /**
   * The newest live device selection, falling back to the boot-time bridge snapshot before DEVICE_CHANGE has been observed.
   */
  getInitialDevice(): NativeDeviceInfo | null {
    return this.currentDevice ?? getNativeHost().device ?? null
  }

  /**
   * Metric fallbacks for the simulator-resident wx.* API handlers
   * (readWindowMetrics in simulator-api.ts): the current device, or — when no device was ever selected — the host-env snapshot defaults (the same source the sync service-host wx.getSystemInfoSync reports).
   */
  getDeviceMetrics(): DeviceMetrics {
    const device = this.getInitialDevice()
    if (device) {
      return {
        pixelRatio: device.pixelRatio,
        screenWidth: device.screenWidth,
        screenHeight: device.screenHeight,
        statusBarHeight: device.statusBarHeight,
        safeAreaInsets: device.safeAreaInsets,
        hasNotch: device.notchType !== 'none',
        deviceOrientation: device.deviceOrientation ?? 'portrait',
      }
    }
    const snap = this.getHostEnvSnapshot()
    return {
      pixelRatio: snap.pixelRatio,
      screenWidth: snap.screenWidth,
      screenHeight: snap.screenHeight,
      statusBarHeight: snap.statusBarHeight,
      safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      hasNotch: false,
      deviceOrientation: snap.deviceOrientation ?? 'portrait',
    }
  }

  getHostEnvSnapshot(): HostEnvSnapshot {
    // Use the selected device's simulated dimensions (default iPhone 14 =
    // 390x844) instead of the actual browser window — the simulator emulates a
    // phone, not Electron's host window. WeChat capsule geometry + status bar
    // height also key off these via sync-impls/{menu-button,system-info}.ts.
    const device = this.getInitialDevice()
    const width = device?.screenWidth ?? 390
    const height = device?.screenHeight ?? 844
    const pixelRatio = device?.pixelRatio ?? 2
    const language = navigator.language || 'zh-CN'
    const statusBarHeight = device?.statusBarHeight ?? (this.platform === 'ios' ? 44 : 24)

    return {
      brand: this.platform === 'ios' ? 'iPhone' : 'Android',
      model: this.platform === 'ios' ? 'iPhone' : 'Android',
      platform: this.platform,
      system: this.platform === 'ios' ? 'iOS 16.0' : 'Android 13',
      version: '8.0.5',
      SDKVersion: '3.0.0',
      pixelRatio,
      screenWidth: width,
      screenHeight: height,
      windowWidth: width,
      windowHeight: height,
      statusBarHeight,
      language,
      theme: prefersDarkMode() ? 'dark' : 'light',
      deviceOrientation: device?.deviceOrientation ?? 'portrait',
    }
  }

  createRenderHostUrl(bridgeId: string, pagePath?: string, isTab?: boolean, backgroundColor?: string): string {
    return getNativeHost().createRenderHostUrl({
      bridgeId,
      appId: this.appId,
      // Session-level, not per-call: root is resolved server-side (spawn()
      // response), not requested per page. Falls back to 'main' to match the
      // server-side default (`opts.root || 'main'`) if called before spawn().
      root: this.root ?? 'main',
      pagePath: pagePath ?? this.pagePath,
      isTab,
      backgroundColor,
    })
  }

  getRenderPreloadUrl(): string {
    return getNativeHost().renderPreloadUrl
  }

  /**
   * Subscribe to a main→simulator event channel (SIMULATOR_EVENTS) via the
   * native-host preload bridge. DeviceShell uses this instead of importing
   * `ipcRenderer` from electron (the simulator main world has no electron).
   * Returns an unsubscribe fn.
   */
  onSimulatorEvent<T = unknown>(channel: string, listener: (payload: T) => void): () => void {
    return getNativeHost().onSimulatorEvent<T>(channel, listener)
  }

  /**
   * Session-scoped variant of {@link onSimulatorEvent}: drops payloads that
   * name a DIFFERENT app session. During a soft reload two DeviceShells (the
   * live one + the incoming one) share one simulator WCV, and every
   * SIMULATOR_EVENTS broadcast reaches both — without this filter a
   * session-scoped event (API_CALL / NAV_ACTION / TAB_ACTION) is executed by
   * BOTH shells, e.g. a wx.request issued by the incoming session's onLoad
   * fires twice. Payloads without an `appSessionId` field (DEVICE_CHANGE) pass
   * through unfiltered.
   */
  onSessionEvent<T = unknown>(channel: string, listener: (payload: T) => void): () => void {
    return this.onSimulatorEvent<T>(channel, (payload) => {
      const sid = (payload as { appSessionId?: unknown } | null | undefined)?.appSessionId
      if (typeof sid === 'string' && sid !== this.appSessionId) return
      listener(payload)
    })
  }

  private requireAppSessionId(): string {
    if (!this.appSessionId) {
      throw new Error('[simulator] miniApp has not been spawned yet')
    }
    return this.appSessionId
  }
}

function getNativeHost(): NativeHostBridge {
  const nativeHost = window.__diminaNativeHost
  if (!nativeHost) {
    throw new Error('[simulator] native host bridge is unavailable')
  }
  return nativeHost
}

function prefersDarkMode(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}
