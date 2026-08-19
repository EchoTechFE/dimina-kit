interface SafeAreaInsets {
  top: number
  right: number
  bottom: number
  left: number
}

interface SpawnContext {
  appId?: string
  hostEnvSnapshot?: Partial<SystemInfo> & { safeAreaInsets?: SafeAreaInsets }
}

export interface SystemInfo {
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
  fontSizeSetting: number
  deviceOrientation: string
  safeArea: {
    width: number
    height: number
    top: number
    bottom: number
    left: number
    right: number
  }
}

export function getSystemInfoSync(this: SpawnContext): SystemInfo {
  const snapshot = this.hostEnvSnapshot ?? {}
  const screenWidth = numberOr(snapshot.screenWidth, globalThis.screen?.width, 390)
  const screenHeight = numberOr(snapshot.screenHeight, globalThis.screen?.height, 844)
  const windowWidth = numberOr(snapshot.windowWidth, globalThis.innerWidth, screenWidth)
  const windowHeight = numberOr(snapshot.windowHeight, globalThis.innerHeight, screenHeight)
  const statusBarHeight = numberOr(snapshot.statusBarHeight, 0)
  const deviceOrientation = stringOr(snapshot.deviceOrientation, 'portrait')

  return {
    brand: stringOr(snapshot.brand, 'devtools'),
    model: stringOr(snapshot.model, 'devtools'),
    pixelRatio: numberOr(snapshot.pixelRatio, globalThis.devicePixelRatio, 2),
    screenWidth,
    screenHeight,
    windowWidth,
    windowHeight,
    statusBarHeight,
    language: stringOr(snapshot.language, navigator.language || 'zh_CN'),
    version: stringOr(snapshot.version, '8.0.5'),
    system: stringOr(snapshot.system, navigator.userAgent || 'iOS 16.0'),
    platform: stringOr(snapshot.platform, navigator.platform || 'ios'),
    fontSizeSetting: 16,
    SDKVersion: stringOr(snapshot.SDKVersion, '3.0.0'),
    deviceOrientation,
    theme: stringOr(snapshot.theme, globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
    // The insets main resolved (`HostEnvSnapshot.safeAreaInsets`, via `orientedSafeAreaInsets`) already describe the orientation on screen — in landscape the notch sits on the sides, not the top — so the rect is measured against the equally-oriented `screenWidth`/`screenHeight`.
    // Pairing oriented insets with un-swapped portrait dimensions would place the edges on the wrong axis entirely.
    safeArea: safeAreaRect(
      screenWidth,
      screenHeight,
      snapshot.safeAreaInsets ?? { top: statusBarHeight, right: 0, bottom: 0, left: 0 },
    ),
  }
}

/** The window subset `wx.getWindowInfo()` reports. */
export interface WindowInfo {
  pixelRatio: number
  screenWidth: number
  screenHeight: number
  windowWidth: number
  windowHeight: number
  statusBarHeight: number
  safeArea: SystemInfo['safeArea']
}

/**
 * `wx.getWindowInfo()` — the window fields of `getSystemInfoSync()`, derived from that same call so both APIs report one geometry.
 *
 * The service's own resolver (`api/common/index.js` `hostEnvResolvers`) picks these keys off the raw `hostEnv.systemInfo` object main pushes, which carries `safeAreaInsets` but no computed `safeArea` rect — so `safeArea` would be missing there.
 * Deriving from `getSystemInfoSync` keeps the rect (and its portrait-baseline definition) identical across both APIs.
 */
export function getWindowInfo(this: SpawnContext): WindowInfo {
  const info = getSystemInfoSync.call(this)
  return {
    pixelRatio: info.pixelRatio,
    screenWidth: info.screenWidth,
    screenHeight: info.screenHeight,
    windowWidth: info.windowWidth,
    windowHeight: info.windowHeight,
    statusBarHeight: info.statusBarHeight,
    safeArea: info.safeArea,
  }
}

/** A safe-area rect from a screen and the insets describing that same screen's orientation. */
function safeAreaRect(screenWidth: number, screenHeight: number, insets: SafeAreaInsets) {
  return {
    left: insets.left,
    top: insets.top,
    right: screenWidth - insets.right,
    bottom: screenHeight - insets.bottom,
    width: screenWidth - insets.left - insets.right,
    height: screenHeight - insets.top - insets.bottom,
  }
}

export function getAccountInfoSync(this: SpawnContext): {
  miniProgram: {
    appId: string
    envVersion: string
    version: string
  }
} {
  return {
    miniProgram: {
      appId: this.appId ?? '',
      envVersion: 'develop',
      version: '',
    },
  }
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function numberOr(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return 0
}
