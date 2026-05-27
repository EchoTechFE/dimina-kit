import { getAccountInfoSync, getSystemInfoSync } from './sync-impls/system-info.js'
import {
  clearStorageSync,
  getStorageInfoSync,
  getStorageSync,
  removeStorageSync,
  setStorageSync,
} from './sync-impls/storage.js'
import { getMenuButtonBoundingClientRect } from './sync-impls/menu-button.js'

type ApiNamespace = Record<string, unknown>

interface SpawnContext {
  appId?: string
  hostEnvSnapshot?: Record<string, unknown>
}

const spawnContext = ((globalThis as unknown as { __diminaSpawnContext?: SpawnContext }).__diminaSpawnContext ?? {}) as SpawnContext

function patchNamespace(ns: ApiNamespace | undefined): void {
  if (!ns) return
  ns.getStorageSync = (key: string) => getStorageSync.call(spawnContext, { key }).data ?? ''
  ns.setStorageSync = (key: string, data: unknown) => setStorageSync.call(spawnContext, { key, data })
  ns.removeStorageSync = (key: string) => removeStorageSync.call(spawnContext, { key })
  ns.clearStorageSync = () => clearStorageSync.call(spawnContext)
  ns.getStorageInfoSync = () => getStorageInfoSync.call(spawnContext)
  ns.getSystemInfoSync = () => getSystemInfoSync.call(spawnContext)
  ns.getAccountInfoSync = () => getAccountInfoSync.call(spawnContext)
  ns.getMenuButtonBoundingClientRect = () => getMenuButtonBoundingClientRect.call(spawnContext)
}

const globalScope = globalThis as unknown as {
  wx?: ApiNamespace
  dd?: ApiNamespace
  qd?: ApiNamespace
}

patchNamespace(globalScope.wx)
patchNamespace(globalScope.dd)
patchNamespace(globalScope.qd)
