/** Raw per-edge insets and orientation the device picker pushes alongside the
 *  rest of the snapshot — kept separate from `SystemInfo.safeArea` (that one's
 *  the derived left/top/right/bottom/width/height shape this module computes). */
interface HostEnvSnapshotInput extends Partial<SystemInfo> {
  safeAreaInsets?: { top: number; right: number; bottom: number; left: number }
  deviceOrientation?: 'portrait' | 'landscape'
}

interface SpawnContext {
  appId?: string
  hostEnvSnapshot?: HostEnvSnapshotInput
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
  /** Screen-coordinate top of the window — the status bar height. */
  screenTop: number
}

export function getSystemInfoSync(this: SpawnContext): SystemInfo {
  const snapshot = this.hostEnvSnapshot ?? {}
  const screenWidth = numberOr(snapshot.screenWidth, globalThis.screen?.width, 390)
  const screenHeight = numberOr(snapshot.screenHeight, globalThis.screen?.height, 844)
  const windowWidth = numberOr(snapshot.windowWidth, globalThis.innerWidth, screenWidth)
  const windowHeight = numberOr(snapshot.windowHeight, globalThis.innerHeight, screenHeight)
  const statusBarHeight = numberOr(snapshot.statusBarHeight, 0)
  const safeAreaBottom = windowHeight
  const deviceOrientation = snapshot.deviceOrientation ?? 'portrait'
  // A snapshot minted by the runtime's `deviceInfoToHostEnv` already carries
  // the resolved rect — it is the single source of truth for these numbers, so
  // carry it through rather than re-deriving and risking a different answer
  // from the async and per-spawn paths.
  const resolved = snapshot.safeArea
  // Older snapshots carry only the measured per-edge insets (safeAreaInsets):
  // right/bottom are distances from the far edge, so they convert to the
  // left/top-origin safeArea rect by subtracting from the window size. Neither
  // present (no device selected yet) falls back to top=statusBarHeight only.
  const insets = snapshot.safeAreaInsets
  const safeArea = resolved ?? (insets
    ? {
        left: insets.left,
        top: insets.top,
        right: windowWidth - insets.right,
        bottom: windowHeight - insets.bottom,
        width: windowWidth - insets.right - insets.left,
        height: windowHeight - insets.bottom - insets.top,
      }
    : {
        width: windowWidth,
        height: windowHeight - statusBarHeight,
        top: statusBarHeight,
        bottom: safeAreaBottom,
        left: 0,
        right: windowWidth,
      })

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
    safeArea,
    screenTop: numberOr(snapshot.screenTop, statusBarHeight),
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
