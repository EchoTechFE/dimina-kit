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
    wx.request = (opts: {
      url: string
      data?: unknown
      header?: Record<string, string>
      timeout?: number
      method?: string
      dataType?: 'json' | 'text' | 'arraybuffer'
      success?: Callback<unknown>
      fail?: Callback<unknown>
      complete?: Callback<void>
    }) => {
      const controller = new AbortController()
      const method = (opts.method || 'GET').toUpperCase()
      let requestUrl = opts.url
      const init: RequestInit = {
        method,
        headers: { 'Content-Type': 'application/json', ...(opts.header || {}) },
        signal: controller.signal,
      }

      if (method === 'GET' && opts.data && typeof opts.data === 'object') {
        const url = new URL(requestUrl, window.location.href)
        Object.entries(opts.data as Record<string, unknown>).forEach(([key, value]) => {
          url.searchParams.append(key, String(value))
        })
        requestUrl = url.toString()
      } else if (opts.data != null) {
        init.body = typeof opts.data === 'string' ? opts.data : JSON.stringify(opts.data)
      }

      const timeoutId = Number(opts.timeout) > 0
        ? window.setTimeout(() => controller.abort(), Number(opts.timeout))
        : null

      fetch(requestUrl, init)
        .then(async (response) => {
          const headers = Object.fromEntries(response.headers.entries())
          let data: unknown
          if (opts.dataType === 'arraybuffer') data = await response.arrayBuffer()
          else {
            const text = await response.text()
            if (opts.dataType === 'text') data = text
            else {
              try {
                data = JSON.parse(text)
              } catch {
                data = text
              }
            }
          }
          call(opts.success, { data, statusCode: response.status, header: headers, errMsg: 'request:ok' })
        })
        .catch((error) => {
          call(opts.fail, { errMsg: `request:fail ${error instanceof Error ? error.message : String(error)}` })
        })
        .finally(() => {
          if (timeoutId != null) window.clearTimeout(timeoutId)
          call(opts.complete, undefined)
        })

      return {
        abort: () => controller.abort(),
      }
    }
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
