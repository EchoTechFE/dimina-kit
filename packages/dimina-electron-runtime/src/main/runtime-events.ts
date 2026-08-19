import type { SyncStorageChange } from '../shared/runtime-types.js'
import type { MessageEnvelope } from '../shared/bridge-channels.js'
import type { Orientation } from '../shared/page-orientation.js'

export interface SessionRuntimeStatus {
  appId: string
  phase: 'launching' | 'running' | 'launch-failed' | 'crashed'
  code?: string
  reason?: string
  pageFallback?: { requested: string; resolved: string }
}

/**
 * Broadcast on every PAGE_RESIZE and on session teardown so the renderer's host-env mirror can track the orientation an app session forces, without recomputing it — DeviceShell is the sole authority (see `shared/page-orientation.ts`). `orientation: null` means no session is forcing one (falls back to the device orientation); `canRotate` mirrors whether the top page lets the user rotate the simulated device.
 */
export interface SessionOrientationEvent {
  appSessionId: string
  /**
   * The page this orientation belongs to.
   * Consumers doing per-page work — the CSS `env(safe-area-inset-*)` override of that page's own render guest — route by it, so a hidden tab-substack guest is never given the top page's orientation. `null` on teardown, where no page is reporting one.
   */
  bridgeId: string | null
  orientation: Orientation | null
  canRotate: boolean
  /**
   * Whether this report comes from the session the simulator declared as the one on screen (`SESSION_ACTIVE`).
   * Consumers mirroring "what the user is looking at" — the renderer's panel geometry and rotate control — must honor nothing else: during a soft reload the outgoing session keeps reporting after the incoming one has taken the screen, and its eventual teardown arrives last of all.
   * Per-page consumers (a render guest's own safe-area override) ignore this and route by `bridgeId` instead.
   */
  active: boolean
}

/**
 * A page's own end — `PAGE_CLOSE` or the teardown of the session it belongs to.
 * Consumers holding per-page state keyed by `bridgeId` release it here rather than off the render guest's `'destroyed'`: a page outlives its guest across a render-host swap, and a page can exist before any guest attaches.
 */
export interface PageClosedEvent {
  appSessionId: string
  bridgeId: string
}

export interface RuntimeEventMap {
  'session-status': SessionRuntimeStatus
  'app-data-evict': { appId: string; bridgeId: string }
  'app-data-message': { appId: string; message: MessageEnvelope }
  'storage-changed': { appId: string; change: SyncStorageChange }
  'session-orientation': SessionOrientationEvent
  'page-closed': PageClosedEvent
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
      for (const listener of listeners.get(name) ?? []) {
        try {
          listener(payload as never)
        } catch (error) {
          console.error(`[electron-runtime] '${String(name)}' listener failed`, error)
        }
      }
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
