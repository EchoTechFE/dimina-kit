/**
 * miniappSnapshot — preload-side host.
 *
 * The hub that owns every data source's lifecycle plus the push/pull
 * transport. preload registers sources, then calls `install()` once.
 *
 * See `./types.ts` for the contract and `docs/miniapp-snapshot.md` for the
 * architecture rationale.
 */

import { contextBridge } from 'electron'
import { MiniappSnapshotChannel } from '../../shared/ipc-channels.js'
import { onHostMessage, sendToHost } from '../runtime/host.js'
import type {
  MiniappSnapshotApi,
  MiniappSnapshotHost,
  MiniappSnapshotSource,
  SnapshotEnvelope,
  SnapshotSourceId,
} from './types.js'

/** Page-global key under which the automation accessor is exposed. */
const ACCESSOR_KEY = '__miniappSnapshot'

/**
 * Expose `api` on the page global as `__miniappSnapshot`, preferring
 * `contextBridge.exposeInMainWorld` and falling back to a direct `window`
 * assignment when the context bridge is unavailable. Returns a disposer that
 * restores the previous `window` state — mirroring `bridge.ts`.
 */
function exposeApi(api: MiniappSnapshotApi): () => void {
  try {
    contextBridge.exposeInMainWorld(ACCESSOR_KEY, api)
  } catch {
    ;(window as unknown as Record<string, unknown>).__miniappSnapshot = api
  }

  return () => {
    const windowRef = window as unknown as Record<string, unknown>
    if (windowRef[ACCESSOR_KEY] === api) {
      delete windowRef[ACCESSOR_KEY]
    }
  }
}

export function createMiniappSnapshotHost(): MiniappSnapshotHost {
  const sources: Array<MiniappSnapshotSource<unknown>> = []
  const byId = new Map<SnapshotSourceId, MiniappSnapshotSource<unknown>>()
  let installed = false
  let disposed = false
  // Global, strictly-increasing publish counter shared across every source.
  let seq = 0

  /**
   * Read a fresh snapshot of `source` and push it over the Push channel with
   * a freshly-allocated global `seq`. The single publish path shared by the
   * initial install, runtime `emit()`, and renderer-initiated `pull`.
   */
  function publish(source: MiniappSnapshotSource<unknown>): void {
    if (disposed) return
    seq += 1
    const envelope: SnapshotEnvelope = {
      id: source.id,
      seq,
      ts: Date.now(),
      data: source.snapshot(),
    }
    sendToHost(MiniappSnapshotChannel.Push, envelope)
  }

  function register<T>(source: MiniappSnapshotSource<T>): void {
    if (installed) {
      throw new Error('MiniappSnapshotHost: register() called after install()')
    }
    if (byId.has(source.id)) {
      throw new Error(`MiniappSnapshotHost: duplicate source id "${source.id}"`)
    }
    const erased = source as MiniappSnapshotSource<unknown>
    byId.set(source.id, erased)
    sources.push(erased)
  }

  function install(): () => void {
    if (installed) {
      throw new Error('MiniappSnapshotHost: install() called twice')
    }
    installed = true

    for (const source of sources) {
      // Each source gets its own emit callback bound to that source, so
      // emit() publishes exactly the calling source (fresh snapshot, fresh
      // seq). After disposal `publish` is a no-op via the `disposed` guard.
      source.start(() => publish(source))
      // Fixed framework step: publish the initial snapshot immediately after
      // start() — reload re-sync is install() re-running, not a per-source
      // responsibility.
      publish(source)
    }

    const disposePull = onHostMessage(MiniappSnapshotChannel.Pull, (...args) => {
      const payload = args[0] as { id?: unknown } | undefined
      const id = payload?.id
      if (typeof id !== 'string') return
      const source = byId.get(id)
      if (!source) return
      publish(source)
    })

    // Synchronous automation accessor — lets the main process / e2e / MCP
    // read any panel's current snapshot via `executeJavaScript`. `get` reads
    // `source.snapshot()` fresh on every call (never cached).
    const api: MiniappSnapshotApi = {
      get: (id) => byId.get(id)?.snapshot(),
      ids: () => sources.map((source) => source.id),
    }
    const disposeApi = exposeApi(api)

    return () => {
      if (disposed) return
      disposed = true
      disposePull()
      disposeApi()
      for (const source of sources) {
        source.dispose()
      }
    }
  }

  return { register, install }
}
