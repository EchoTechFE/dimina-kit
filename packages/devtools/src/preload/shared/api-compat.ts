import { performRequest } from '../../shared/request-core.js'

type Callback<T = unknown> = ((payload: T) => void) | undefined

function call<T>(fn: Callback<T>, payload: T): void {
  try {
    fn?.(payload)
  } catch {
    // Ignore callback errors in compat shims.
  }
}

function buildWindowInfo() {
  const width = window.innerWidth || document.documentElement.clientWidth || 375
  const height = window.innerHeight || document.documentElement.clientHeight || 812
  const pixelRatio = window.devicePixelRatio || 2
  const statusBarHeight = 0
  return {
    pixelRatio,
    screenWidth: width,
    screenHeight: height,
    windowWidth: width,
    windowHeight: height,
    statusBarHeight,
    safeArea: {
      width,
      height,
      top: statusBarHeight,
      bottom: height,
      left: 0,
      right: width,
    },
  }
}

function makeStorageKey(key: string): string {
  return `dimina:${key}`
}

function ensureWxApi(wx: Record<string, unknown>): void {
  if (typeof wx.canIUse !== 'function') {
    wx.canIUse = (_schema: unknown) => true
  }

  if (typeof wx.getWindowInfo !== 'function') {
    wx.getWindowInfo = (opts: { success?: Callback<unknown>; complete?: Callback<void> } = {}) => {
      const info = buildWindowInfo()
      call(opts.success, info)
      call(opts.complete, undefined)
      return info
    }
  }

  if (typeof wx.getSystemSetting !== 'function') {
    wx.getSystemSetting = (opts: { success?: Callback<unknown>; complete?: Callback<void> } = {}) => {
      const info = {
        bluetoothEnabled: false,
        locationEnabled: true,
        wifiEnabled: true,
        deviceOrientation: 'portrait',
      }
      call(opts.success, info)
      call(opts.complete, undefined)
      return info
    }
  }

  if (typeof wx.getSystemInfoSync !== 'function') {
    wx.getSystemInfoSync = () => ({
      brand: 'simulator',
      model: 'web',
      platform: 'simulator',
      system: 'web',
      language: 'zh_CN',
      SDKVersion: '3.0.0',
      ...buildWindowInfo(),
    })
  }

  if (typeof wx.setStorageSync !== 'function') {
    wx.setStorageSync = (key: string, data: unknown) => {
      const value = typeof data === 'string' ? data : JSON.stringify(data)
      localStorage.setItem(makeStorageKey(String(key)), value)
    }
  }

  if (typeof wx.getStorageSync !== 'function') {
    wx.getStorageSync = (key: string) => {
      const raw = localStorage.getItem(makeStorageKey(String(key)))
      if (raw == null) return ''
      try {
        return JSON.parse(raw)
      } catch {
        return raw
      }
    }
  }

  if (typeof wx.removeStorageSync !== 'function') {
    wx.removeStorageSync = (key: string) => {
      localStorage.removeItem(makeStorageKey(String(key)))
    }
  }

  if (typeof wx.clearStorageSync !== 'function') {
    wx.clearStorageSync = () => {
      const prefix = 'dimina:'
      const keys: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key?.startsWith(prefix)) keys.push(key)
      }
      keys.forEach((key) => localStorage.removeItem(key))
    }
  }

  if (typeof wx.getStorageInfoSync !== 'function') {
    wx.getStorageInfoSync = () => {
      const prefix = 'dimina:'
      const keys: string[] = []
      let currentSize = 0
      for (let i = 0; i < localStorage.length; i++) {
        const fullKey = localStorage.key(i)
        if (!fullKey?.startsWith(prefix)) continue
        keys.push(fullKey.slice(prefix.length))
        currentSize += (localStorage.getItem(fullKey) || '').length * 2
      }
      return { keys, currentSize, limitSize: 10 * 1024 * 1024 }
    }
  }

  if (typeof wx.request !== 'function') {
    // Delegates to the shared wx.request core (shared/request-core.ts) — the
    // single owner of success/fail semantics, header dedup, timeout default,
    // and body encoding. This shim only adapts the wx.request option bag onto
    // the core's callbacks.
    wx.request = (opts: {
      url: string
      data?: unknown
      header?: Record<string, string>
      timeout?: number
      method?: string
      dataType?: string
      responseType?: string
      success?: Callback<unknown>
      fail?: Callback<unknown>
      complete?: Callback<unknown>
    }) =>
      performRequest(
        {
          url: opts.url,
          data: opts.data,
          header: opts.header,
          timeout: opts.timeout,
          method: opts.method,
          dataType: opts.dataType,
          responseType: opts.responseType,
        },
        {
          success: (res) => call(opts.success, res),
          fail: (err) => call(opts.fail, err),
          complete: (res) => call(opts.complete, res),
        },
      )
  }
}

export function setupApiCompatHook(): void {
  const apply = () => {
    const target = window as unknown as { wx?: Record<string, unknown> }
    if (!target.wx || typeof target.wx !== 'object') {
      target.wx = {}
    }
    const wx = target.wx
    ensureWxApi(wx)
    return true
  }

  if (apply()) return

  const timer = window.setInterval(() => {
    if (apply()) window.clearInterval(timer)
  }, 200)
}
