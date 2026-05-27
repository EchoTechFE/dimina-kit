const storagePrefix = 'dimina-native-runtime-spike:'

function storageKey(key: string) {
  if (!key) {
    throw new Error('[service-host] storage key is required')
  }
  return `${storagePrefix}${key}`
}

export function getStorageSync(key: string) {
  const raw = globalThis.localStorage.getItem(storageKey(key))
  if (raw == null) {
    return ''
  }
  return JSON.parse(raw)
}

export function setStorageSync(key: string, data: unknown) {
  globalThis.localStorage.setItem(storageKey(key), JSON.stringify(data))
}

export function removeStorageSync(key: string) {
  globalThis.localStorage.removeItem(storageKey(key))
}

export function clearStorageSync() {
  for (const key of Object.keys(globalThis.localStorage)) {
    if (key.startsWith(storagePrefix)) {
      globalThis.localStorage.removeItem(key)
    }
  }
}

export function getStorageInfoSync() {
  const keys = Object.keys(globalThis.localStorage)
    .filter(key => key.startsWith(storagePrefix))
    .map(key => key.slice(storagePrefix.length))

  return {
    keys,
    currentSize: JSON.stringify(keys.map(key => getStorageSync(key))).length,
    limitSize: 10 * 1024,
  }
}
