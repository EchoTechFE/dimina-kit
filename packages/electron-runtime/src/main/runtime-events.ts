import type { SyncStorageChange } from '../shared/runtime-types.js'
import type { MessageEnvelope } from '../shared/bridge-channels.js'

export interface SessionRuntimeStatus {
  appId: string
  phase: 'launching' | 'running' | 'launch-failed' | 'crashed'
  code?: string
  reason?: string
  pageFallback?: { requested: string; resolved: string }
}

export interface RuntimeEventMap {
  'session-status': SessionRuntimeStatus
  'app-data-evict': { appId: string; bridgeId: string }
  'app-data-message': { appId: string; message: MessageEnvelope }
  'storage-changed': { appId: string; change: SyncStorageChange }
}

export interface RuntimeEvents {
  emit<K extends keyof RuntimeEventMap>(name: K, payload: RuntimeEventMap[K]): void
  on<K extends keyof RuntimeEventMap>(
    name: K,
    listener: (payload: RuntimeEventMap[K]) => void,
  ): () => void
  clear(): void
}

export function createRuntimeEvents(): RuntimeEvents {
  const listeners = new Map<keyof RuntimeEventMap, Set<(payload: never) => void>>()
  return {
    emit(name, payload) {
      for (const listener of listeners.get(name) ?? []) listener(payload as never)
    },
    on(name, listener) {
      let bucket = listeners.get(name)
      if (!bucket) {
        bucket = new Set()
        listeners.set(name, bucket)
      }
      bucket.add(listener as (payload: never) => void)
      return () => bucket?.delete(listener as (payload: never) => void)
    },
    clear() {
      listeners.clear()
    },
  }
}
