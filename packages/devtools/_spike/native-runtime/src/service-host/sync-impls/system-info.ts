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
}

export function getSystemInfoSync(): SystemInfo {
  const screenWidth = globalThis.screen?.width || 390
  const screenHeight = globalThis.screen?.height || 844
  return {
    brand: 'Apple',
    model: 'Electron PoC',
    platform: navigator.platform || 'electron',
    system: navigator.userAgent,
    version: 'native-runtime-spike',
    SDKVersion: 'native-runtime-spike',
    pixelRatio: globalThis.devicePixelRatio || 1,
    screenWidth,
    screenHeight,
    windowWidth: globalThis.innerWidth || screenWidth,
    windowHeight: globalThis.innerHeight || screenHeight,
    statusBarHeight: 24,
    language: navigator.language || 'en-US',
    theme: globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  }
}

export function getAccountInfoSync() {
  return {
    miniProgram: {
      appId: 'hello-world',
      envVersion: 'develop',
      version: '0.0.0',
    },
  }
}
