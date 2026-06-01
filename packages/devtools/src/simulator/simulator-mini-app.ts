import type {
  ActivePagePayload,
  ApiResponsePayload,
  AppManifest,
  HostEnvSnapshot,
  NavCallbackPayload,
  PageLifecycleEvent,
  PageOpenResult,
  PageWindowConfig,
  SpawnRequest,
  SpawnResult,
  TabBarConfig,
} from '../shared/bridge-channels'

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
  createRenderHostUrl(opts: { bridgeId: string; appId: string; pagePath: string }): string
  renderPreloadUrl: string
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
  readonly pagePath: string
  readonly query: Record<string, string>
  readonly apiRegistry: Record<string, ApiHandler | undefined> = {}

  appSessionId: string | null = null
  bridgeId: string | null = null
  resourceBaseUrl: string | null = null
  serviceWcId: number | null = null
  manifest: AppManifest | null = null
  rootWindowConfig: PageWindowConfig | null = null
  readonly platform: 'ios' | 'android'
  private readonly apiNamespaces: string[]

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
    this.serviceWcId = result.serviceWcId
    this.manifest = result.manifest
    this.rootWindowConfig = result.rootWindowConfig
    return result.bridgeId
  }

  dispose(): void {
    if (!this.appSessionId) return
    getNativeHost().dispose(this.appSessionId)
    this.appSessionId = null
    this.bridgeId = null
    this.resourceBaseUrl = null
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

  getTabBarConfig(): TabBarConfig | null {
    return this.manifest?.tabBar ?? null
  }

  getHostEnvSnapshot(): HostEnvSnapshot {
    // Use simulated device dimensions (390x844 = iPhone 14) instead of the
    // actual browser window — the simulator emulates a phone, not Electron's
    // host window. WeChat capsule geometry + status bar height also key off
    // these values via sync-impls/{menu-button,system-info}.ts.
    const width = 390
    const height = 844
    const pixelRatio = 2
    const language = navigator.language || 'zh-CN'
    const statusBarHeight = this.platform === 'ios' ? 44 : 24

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
    }
  }

  createRenderHostUrl(bridgeId: string, pagePath?: string): string {
    return getNativeHost().createRenderHostUrl({
      bridgeId,
      appId: this.appId,
      pagePath: pagePath ?? this.pagePath,
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
