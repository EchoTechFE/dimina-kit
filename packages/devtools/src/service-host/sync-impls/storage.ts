interface StorageContext {
  appId?: string
}

function requireKey(key: string): string {
  if (!key) throw new Error('[service-host] storage key is required')
  return key
}

function storageKey(ctx: StorageContext, key: string): string {
  return `${ctx.appId ?? ''}_${requireKey(key)}`
}

export function setStorageSync(this: StorageContext, { key, data }: { key: string; data: unknown }): void {
  const dataString = typeof data === 'object' ? JSON.stringify(data) : String(data)
  localStorage.setItem(storageKey(this, key), dataString)
}

export function getStorageSync(this: StorageContext, { key }: { key: string }): { data: unknown } {
  const raw = localStorage.getItem(storageKey(this, key))
  if (raw === null) return { data: '' }
  try {
    return { data: JSON.parse(raw) as unknown }
  } catch {
    return { data: raw }
  }
}

export function removeStorageSync(this: StorageContext, { key }: { key: string }): void {
  localStorage.removeItem(storageKey(this, key))
}

export function clearStorageSync(this: StorageContext): void {
  const prefix = `${this.appId ?? ''}_`
  const keysToRemove: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key && key.startsWith(prefix)) keysToRemove.push(key)
  }
  keysToRemove.forEach(key => localStorage.removeItem(key))
}

export function getStorageInfoSync(this: StorageContext): {
  keys: string[]
  currentSize: number
  limitSize: number
} {
  const prefix = `${this.appId ?? ''}_`
  const keys: string[] = []
  let currentSize = 0
  for (let i = 0; i < localStorage.length; i++) {
    const fullKey = localStorage.key(i)
    if (fullKey && fullKey.startsWith(prefix)) {
      keys.push(fullKey.substring(prefix.length))
      const item = localStorage.getItem(fullKey)
      currentSize += item ? item.length * 2 : 0
    }
  }
  return { keys, currentSize, limitSize: 10 * 1024 * 1024 }
}
