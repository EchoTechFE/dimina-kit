/**
 * Ambient typings for the dimina `dd` / `wx` global API.
 *
 * dimina exposes `dd`/`wx` in two distinct realms, both covered here:
 *
 *  - Logic layer (`.js` page / component logic): a Proxy over every named export
 *    under dimina/fe/packages/service/src/api/core/**\/index.js
 *    (service/src/api/index.js assembles `api` from `import.meta.glob('./core/**\/index.js')`
 *    then wraps it in a Proxy). Every exported function name there becomes a
 *    `wx.<name>` / `dd.<name>`. This is the request / setStorage / showToast / route
 *    surface. Each method below is grounded in its source export + the official
 *    WeChat doc URL the source JSDoc cites.
 *
 *  - Webview / H5 layer (pages rendered as H5 inside a web-view): a much narrower
 *    bridge from dimina/fe/packages/jdimina/src/index.js
 *    (`window.wx = window.dd = { openLocation, getLocation, miniProgram }`,
 *    miniProgram = navigateTo / redirectTo / switchTab / reLaunch / navigateBack /
 *    postMessage / getEnv / goSuperAppTab / getSystemInfo). Exposed as
 *    `dd.miniProgram.*`.
 *
 * Only APIs that actually exist in those sources are typed — no invented methods.
 * Parameter shapes follow the WeChat option-object contract the sources document
 * (success / fail / complete callbacks); fields not provable from the dimina
 * source are typed permissively rather than asserted precisely.
 *
 * Written into the project as `dimina.d.ts` so the web ext-host tsserver picks it
 * up via the workspace and drives `.js` IntelliSense.
 */
export const DIMINA_DTS = `// Auto-provided by the dimina workbench — dd/wx global API typings.
declare namespace Dimina {
  // ── Common callback option shape ───────────────────────────────────────────
  interface CallbackOptions<TSuccess = unknown> {
    /** Called on success. */
    success?: (res: TSuccess) => void
    /** Called on failure. */
    fail?: (err: { errMsg: string; [key: string]: unknown }) => void
    /** Called on either success or failure. */
    complete?: (res?: unknown) => void
  }

  // ── Geolocation (logic: location/index.js; webview: jdimina index.js) ───────
  interface GetLocationOptions extends CallbackOptions<{
    latitude: number
    longitude: number
    speed?: number
    accuracy?: number
    altitude?: number
    horizontalAccuracy?: number
    verticalAccuracy?: number
  }> {
    /** Coordinate system, default 'wgs84'. */
    type?: 'wgs84' | 'gcj02'
    /** Whether to resolve high-accuracy location. */
    isHighAccuracy?: boolean
  }
  interface OpenLocationOptions extends CallbackOptions {
    latitude: number
    longitude: number
    /** Location name. */
    name?: string
    /** Detailed address. */
    address?: string
    /** Map zoom level, 5~18. */
    scale?: number
  }

  // ── System info (logic: base/system/index.js) ──────────────────────────────
  interface SystemInfo {
    platform?: string
    system?: string
    brand?: string
    model?: string
    pixelRatio?: number
    screenWidth?: number
    screenHeight?: number
    windowWidth?: number
    windowHeight?: number
    statusBarHeight?: number
    language?: string
    version?: string
    SDKVersion?: string
    safeArea?: { top: number; bottom: number; left: number; right: number; width: number; height: number }
    [key: string]: unknown
  }

  // ── Route (logic: route/index.js) ──────────────────────────────────────────
  interface NavigateToOptions extends CallbackOptions {
    /** Target page path, e.g. '/pages/index/index'. */
    url: string
  }
  interface NavigateBackOptions extends CallbackOptions {
    /** Number of pages to go back; defaults to 1. */
    delta?: number
  }

  // ── Storage (logic: storage/index.js) ──────────────────────────────────────
  interface SetStorageOptions extends CallbackOptions {
    key: string
    data: unknown
  }
  interface GetStorageOptions extends CallbackOptions<{ data: unknown }> {
    key: string
  }
  interface RemoveStorageOptions extends CallbackOptions {
    key: string
  }
  interface StorageInfo {
    keys: string[]
    currentSize: number
    limitSize: number
  }

  // ── Interaction (logic: ui/interaction/index.js) ───────────────────────────
  interface ShowToastOptions extends CallbackOptions {
    /** Toast text. */
    title: string
    /** Icon to show with the toast. */
    icon?: 'success' | 'error' | 'loading' | 'none'
    /** Custom icon image path; overrides \`icon\`. */
    image?: string
    /** Display duration in ms, default 1500. */
    duration?: number
    /** Whether a transparent mask blocks page touches. */
    mask?: boolean
  }
  interface ShowLoadingOptions extends CallbackOptions {
    title: string
    mask?: boolean
  }
  interface ShowModalOptions extends CallbackOptions<{ confirm: boolean; cancel: boolean; content?: string }> {
    /** Dialog title. */
    title?: string
    /** Dialog body text. */
    content?: string
    /** Whether to show the cancel button. */
    showCancel?: boolean
    cancelText?: string
    cancelColor?: string
    confirmText?: string
    confirmColor?: string
    /** Whether the content is an editable input. */
    editable?: boolean
    placeholderText?: string
  }
  interface ShowActionSheetOptions extends CallbackOptions<{ tapIndex: number }> {
    /** Button labels, max 6. */
    itemList: string[]
    itemColor?: string
  }

  // ── Network request (logic: network/request/index.js) ──────────────────────
  interface RequestOptions extends CallbackOptions<{
    data: unknown
    statusCode: number
    header: Record<string, string>
    cookies?: string[]
  }> {
    url: string
    data?: string | object | ArrayBuffer
    header?: Record<string, string>
    /** HTTP method, default 'GET'. */
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'OPTIONS' | 'HEAD' | 'TRACE' | 'CONNECT'
    timeout?: number
    dataType?: 'json' | string
    responseType?: 'text' | 'arraybuffer'
  }
  interface UploadFileOptions extends CallbackOptions<{ data: string; statusCode: number }> {
    url: string
    filePath: string
    name: string
    header?: Record<string, string>
    formData?: Record<string, unknown>
  }
  interface DownloadFileOptions extends CallbackOptions<{ tempFilePath: string; statusCode: number }> {
    url: string
    header?: Record<string, string>
    filePath?: string
    timeout?: number
  }

  // ── Navigation bar (logic: ui/navigation-bar/index.js) ─────────────────────
  interface SetNavigationBarTitleOptions extends CallbackOptions {
    title: string
  }
  interface SetNavigationBarColorOptions extends CallbackOptions {
    frontColor: '#ffffff' | '#000000' | string
    backgroundColor: string
    animation?: { duration?: number; timingFunc?: string }
  }

  // ── Webview-layer sub-app navigation: dd.miniProgram.* (jdimina index.js) ───
  interface WebViewNavigateOptions {
    /** Target page path, e.g. '/pages/index/index'. */
    url: string
  }
  interface MiniProgram {
    /** Navigate to a page, keeping the current page in the stack. */
    navigateTo(options: WebViewNavigateOptions): void
    /** Replace the current page with the target page. */
    redirectTo(options: WebViewNavigateOptions): void
    /** Switch to a tabBar page. */
    switchTab(options: WebViewNavigateOptions): void
    /** Close all pages and open the target page. */
    reLaunch(options: WebViewNavigateOptions): void
    /** Go back in the page stack. */
    navigateBack(options?: { delta?: number }): void
    /** Post a message to the host. Consumed when the host web-view triggers postMessage. */
    postMessage(data: { data: unknown }): void
    /** Resolve the runtime environment. */
    getEnv(callback: (env: Record<string, unknown>) => void): void
    /** Switch a super-app tab by name. */
    goSuperAppTab(tabName: string, callback?: (res: unknown) => void): void
    /** Read device / window system info. */
    getSystemInfo(callback: (info: Dimina.SystemInfo) => void): void
  }

  // ── Combined dd / wx surface ───────────────────────────────────────────────
  interface DD {
    // Webview-layer bridge (also present in logic layer as namespace object).
    miniProgram: MiniProgram

    // Route — route/index.js
    /** Keep the current page, navigate to a non-tabBar page. */
    navigateTo(options: NavigateToOptions): void
    /** Close the current page, navigate to a non-tabBar page. */
    redirectTo(options: NavigateToOptions): void
    /** Close all pages, open a page within the app. */
    reLaunch(options: NavigateToOptions): void
    /** Switch to a tabBar page, closing all non-tabBar pages. */
    switchTab(options: NavigateToOptions): void
    /** Close the current page, return to a previous page. */
    navigateBack(options?: NavigateBackOptions): void

    // Storage — storage/index.js
    setStorage(options: SetStorageOptions): void
    getStorage(options: GetStorageOptions): void
    removeStorage(options: RemoveStorageOptions): void
    clearStorage(options?: CallbackOptions): void
    getStorageInfo(options: CallbackOptions<StorageInfo>): void
    setStorageSync(key: string, data: unknown): void
    getStorageSync(key: string): unknown
    removeStorageSync(key: string): void
    clearStorageSync(): void
    getStorageInfoSync(): StorageInfo

    // Interaction — ui/interaction/index.js
    showToast(options: ShowToastOptions): void
    hideToast(options?: CallbackOptions): void
    showLoading(options: ShowLoadingOptions): void
    hideLoading(options?: CallbackOptions): void
    showModal(options: ShowModalOptions): void
    showActionSheet(options: ShowActionSheetOptions): void
    enableAlertBeforeUnload(options: { message: string } & CallbackOptions): void
    disableAlertBeforeUnload(options?: CallbackOptions): void

    // Network — network/request|upload|download/index.js
    request(options: RequestOptions): { abort(): void }
    uploadFile(options: UploadFileOptions): { abort(): void }
    downloadFile(options: DownloadFileOptions): { abort(): void }

    // Navigation bar — ui/navigation-bar/index.js
    setNavigationBarTitle(options: SetNavigationBarTitleOptions): void
    setNavigationBarColor(options: SetNavigationBarColorOptions): void
    showNavigationBarLoading(options?: CallbackOptions): void
    hideNavigationBarLoading(options?: CallbackOptions): void

    // Pull-down refresh — ui/pull-down-refresh/index.js
    startPullDownRefresh(options?: CallbackOptions): void
    stopPullDownRefresh(options?: CallbackOptions): void

    // Scroll — ui/scroll/index.js
    pageScrollTo(options: { scrollTop?: number; selector?: string; duration?: number } & CallbackOptions): void

    // System — base/system/index.js
    getSystemInfo(options?: CallbackOptions<SystemInfo>): Promise<SystemInfo> | void
    getSystemInfoSync(): SystemInfo
    getSystemInfoAsync(options?: CallbackOptions<SystemInfo>): void
    getWindowInfo(options?: CallbackOptions): SystemInfo
    getAppBaseInfo(): Record<string, unknown>
    getDeviceInfo(): Record<string, unknown>

    // Base — base/index.js
    /** Environment variables. \`env.USER_DATA_PATH\` is the user data dir. */
    env: { USER_DATA_PATH: string;[key: string]: string }
    /** Whether a given API / callback / param / component is available. */
    canIUse(schema: string): boolean
    /** Defer work to the next tick. */
    nextTick(callback: () => void): void

    // Location — location/index.js (logic layer) + jdimina (webview layer)
    getLocation(options: GetLocationOptions): void
    openLocation(options: OpenLocationOptions): void
    startLocationUpdate(options?: CallbackOptions): void
    stopLocationUpdate(options?: CallbackOptions): void
    onLocationChange(listener: (res: { latitude: number; longitude: number;[key: string]: unknown }) => void): void
    offLocationChange(listener?: (...args: unknown[]) => void): void

    // Open API — open-api/**/index.js
    login(options?: CallbackOptions<{ code: string }>): void
    getUserInfo(options?: CallbackOptions): void
    getSetting(options?: CallbackOptions): void
    openSetting(options?: CallbackOptions): void
    authorize(options: { scope: string } & CallbackOptions): void
    getAccountInfoSync(): Record<string, unknown>

    // Payment — payment/index.js
    requestPayment(options: CallbackOptions): void

    // Device — device/**/index.js
    getNetworkType(options?: CallbackOptions<{ networkType: string }>): void
    makePhoneCall(options: { phoneNumber: string } & CallbackOptions): void
    scanCode(options?: CallbackOptions): void
    setClipboardData(options: { data: string } & CallbackOptions): void
    getClipboardData(options?: CallbackOptions<{ data: string }>): void
    vibrateShort(options?: { type?: 'heavy' | 'medium' | 'light' } & CallbackOptions): void
    vibrateLong(options?: CallbackOptions): void

    // Media — media/image|video/index.js
    chooseImage(options?: CallbackOptions<{ tempFilePaths: string[] }>): void
    previewImage(options: { urls: string[]; current?: string } & CallbackOptions): void
    saveImageToPhotosAlbum(options: { filePath: string } & CallbackOptions): void
    chooseMedia(options?: CallbackOptions): void

    // Index signature: any other forwarded API name resolves at runtime via the
    // service Proxy (api/index.js). Typed loosely so unknown-but-valid calls
    // are not flagged as errors.
    [api: string]: unknown
  }
}

declare const dd: Dimina.DD
declare const wx: Dimina.DD
`
