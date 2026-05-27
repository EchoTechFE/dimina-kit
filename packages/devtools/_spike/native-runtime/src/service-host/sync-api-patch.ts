import { getAccountInfoSync, getSystemInfoSync } from './sync-impls/system-info.js'
import {
  clearStorageSync,
  getStorageInfoSync,
  getStorageSync,
  removeStorageSync,
  setStorageSync,
} from './sync-impls/storage.js'

type ApiNamespace = Record<string, unknown>

function patchNamespace(name: string, ns: ApiNamespace | undefined) {
  if (!ns) {
    throw new Error(`[service-host] cannot patch missing namespace: ${name}`)
  }

  ns.getStorageSync = getStorageSync
  ns.setStorageSync = setStorageSync
  ns.removeStorageSync = removeStorageSync
  ns.clearStorageSync = clearStorageSync
  ns.getStorageInfoSync = getStorageInfoSync
  ns.getSystemInfoSync = getSystemInfoSync
  ns.getAccountInfoSync = getAccountInfoSync
}

const globalScope = globalThis as unknown as Record<string, ApiNamespace | undefined>

patchNamespace('wx', globalScope.wx)
patchNamespace('dd', globalScope.dd)

console.log('[service-host] sync APIs patched')
