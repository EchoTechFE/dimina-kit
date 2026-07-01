import { getAccountInfoSync, getSystemInfoSync } from './sync-impls/system-info.js'
import {
  clearStorageSync,
  getStorageInfoSync,
  getStorageSync,
  removeStorageSync,
  setStorageSync,
} from './sync-impls/storage.js'
import { getMenuButtonBoundingClientRect } from './sync-impls/menu-button.js'
import type { SyncStorageChange } from '../shared/ipc-channels.js'

type ApiNamespace = Record<string, unknown>

interface SpawnContext {
  appId?: string
  hostEnvSnapshot?: Record<string, unknown>
}

interface ServiceBridge {
  invoke(msg: { type: string; target: string; body: unknown }): void
}

const spawnContext = ((globalThis as unknown as { __diminaSpawnContext?: SpawnContext }).__diminaSpawnContext ?? {}) as SpawnContext

/**
 * Notify main that a SYNC storage API just mutated the service-host store, so the
 * Storage panel updates live. Sync APIs write `localStorage` directly here and
 * never round-trip through main (the async path already does), so without this
 * the panel would only reflect sync writes on a manual reload. Best-effort: no
 * bridge (pool-warming stub, or non-native runtime) → silently skip.
 */
function notifyStorageChange(change: SyncStorageChange): void {
  const bridge = (globalThis as unknown as { DiminaServiceBridge?: ServiceBridge }).DiminaServiceBridge
  if (!bridge || typeof bridge.invoke !== 'function') return
  bridge.invoke({ type: 'storageChanged', target: 'container', body: change })
}

/** Full storage key with the active appId namespace prefix (matches sync-impls). */
function fullKey(key: string): string {
  return `${spawnContext.appId ?? ''}_${key}`
}

/** localStorage string form of a wx storage value (matches sync-impls/storage.ts). */
function encode(data: unknown): string {
  return typeof data === 'object' ? JSON.stringify(data) : String(data)
}

function patchNamespace(ns: ApiNamespace | undefined): void {
  if (!ns) return
  ns.getStorageSync = (key: string) => getStorageSync.call(spawnContext, { key }).data ?? ''
  ns.setStorageSync = (key: string, data: unknown) => {
    setStorageSync.call(spawnContext, { key, data })
    notifyStorageChange({ op: 'set', key: fullKey(key), value: encode(data) })
  }
  ns.removeStorageSync = (key: string) => {
    removeStorageSync.call(spawnContext, { key })
    notifyStorageChange({ op: 'remove', key: fullKey(key) })
  }
  ns.clearStorageSync = () => {
    clearStorageSync.call(spawnContext)
    notifyStorageChange({ op: 'clear' })
  }
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
