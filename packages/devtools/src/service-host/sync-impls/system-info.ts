interface SpawnContext {
  appId?: string
  hostEnvSnapshot?: Partial<SystemInfo>
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
  const safeAreaBottom = windowHeight

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
    deviceOrientation: 'portrait',
    theme: stringOr(snapshot.theme, globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
    safeArea: {
      width: windowWidth,
      height: windowHeight - statusBarHeight,
      top: statusBarHeight,
      bottom: safeAreaBottom,
      left: 0,
      right: windowWidth,
    },
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
