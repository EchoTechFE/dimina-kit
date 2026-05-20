import {
  clearAppDataSnapshot,
  setAppDataSnapshot,
} from '../runtime/bridge.js'
import type { MiniappSnapshotSource } from '../miniapp-snapshot/types.js'

// Window augmentation is in ../types.ts

/**
 * The AppData snapshot — the full, cumulative panel state.
 *
 * - `bridges` lists every page bridge in chronological (insertion) order, each
 *   carrying its page route (`pagePath`), so renderer tabs render in a stable
 *   sequence.
 * - `entries` maps `bridgeId → (componentPath | moduleId) → setData state`.
 */
export interface AppDataSnapshot {
  bridges: Array<{ id: string; pagePath: string | null }>
  entries: Record<string, Record<string, unknown>>
}

type AppDataBody = {
  bridgeId?: string
  moduleId?: string
  componentPath?: string
  data?: unknown
  mode?: 'init' | 'patch'
}

type CacheEntry = {
  componentPath?: string
  data: Record<string, unknown>
}

type DecodedEntry =
  | { mode: 'patch'; bridgeId: string; moduleId: string; data: unknown }
  | {
      mode: 'init'
      bridgeId: string
      moduleId: string
      componentPath: string
      data: Record<string, unknown>
    }

// dimina runtime emits two kinds of service→main messages relevant to the
// AppData panel:
//  • update batches `{type:'ub', body:{bridgeId, updates:[{moduleId,data}]}}`
//    where each `data` is a partial setData patch.
//  • instance init: type === instance id (prefixed `page_`/`component_`),
//    body `{bridgeId, path, data}` with the COMPLETE initial state.
//
// Policy: surface PAGE entries only. Component entries are dropped — they
// sometimes flow on a bridge id distinct from their owning page's and never
// receive pageUnload, which would manifest as ghost tabs in the panel.
function decodeWorkerMessage(message: unknown): DecodedEntry[] | null {
  let payload = message
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload)
    } catch {
      return null
    }
  }
  if (!payload || typeof payload !== 'object') return null
  const record = payload as { type?: unknown; body?: unknown }

  if (record.type === 'ub') {
    const body = record.body as { bridgeId?: unknown; updates?: unknown } | null
    if (!body || typeof body !== 'object') return null
    if (typeof body.bridgeId !== 'string' || !Array.isArray(body.updates)) return null
    const out: DecodedEntry[] = []
    for (const u of body.updates as Array<{ moduleId?: unknown; data?: unknown }>) {
      if (!u || typeof u.moduleId !== 'string') continue
      if (!u.moduleId.startsWith('page_')) continue
      out.push({ mode: 'patch', bridgeId: body.bridgeId, moduleId: u.moduleId, data: u.data })
    }
    return out.length > 0 ? out : null
  }

  if (typeof record.type === 'string' && record.type.startsWith('page_')) {
    const body = record.body as { bridgeId?: unknown; path?: unknown; data?: unknown } | null
    if (!body || typeof body !== 'object') return null
    if (typeof body.bridgeId !== 'string' || typeof body.path !== 'string') return null
    if (!body.data || typeof body.data !== 'object') return null
    return [{
      mode: 'init',
      bridgeId: body.bridgeId,
      moduleId: record.type,
      componentPath: body.path,
      data: body.data as Record<string, unknown>,
    }]
  }

  return null
}

// main→worker direction: container signals page teardown so cache can evict.
function decodeOutgoingMessage(message: unknown): { type: string; bridgeId?: string } | null {
  let payload = message
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload)
    } catch {
      return null
    }
  }
  if (!payload || typeof payload !== 'object') return null
  const r = payload as { type?: unknown; body?: { bridgeId?: unknown } | null }
  if (typeof r.type !== 'string') return null
  return {
    type: r.type,
    bridgeId: typeof r.body?.bridgeId === 'string' ? r.body.bridgeId : undefined,
  }
}

/**
 * The AppData snapshot data source.
 *
 * Instruments `window.Worker` (incoming `message` decoding + outgoing
 * `postMessage` interception) and installs `window.__simulatorHook.appData`,
 * accumulating per-(bridgeId, moduleId) setData state in an internal cache.
 * Every cache mutation — an accepted `ub`/`page_*` worker message, or a
 * `pageUnload` evicting a bridge — calls `emit()` so the `miniappSnapshot`
 * host republishes the full snapshot. The source itself never touches IPC:
 * the host owns push, pull and the install-time publish.
 *
 * It keeps the `__simulatorData.getAppdata()` automation surface working by
 * mirroring the flat cache into the simulator bridge via `setAppDataSnapshot`
 * / `clearAppDataSnapshot`.
 */
export function createAppDataSource(): MiniappSnapshotSource<AppDataSnapshot> {
  const appDataCache = new Map<string, CacheEntry>()
  // Bridges in insertion order — drives the `bridges` array in snapshots so
  // renderer tabs render in a stable, chronological sequence.
  const bridgeOrder: string[] = []
  // Page path per bridge: set from `page_*` init's body.path. Component init
  // also carries a path but it's the component's own path, not the page route.
  const bridgePagePath = new Map<string, string>()

  let emit: (() => void) | null = null
  let installed = false
  let originalHook: Window['__simulatorHook']
  let originalDescriptor: PropertyDescriptor | undefined
  let OriginalWorker: typeof Worker | undefined

  function recordBridge(bridgeId: string): void {
    if (!bridgeOrder.includes(bridgeId)) bridgeOrder.push(bridgeId)
  }

  function buildSnapshot(): AppDataSnapshot {
    const bridges: Array<{ id: string; pagePath: string | null }> = []
    for (const id of bridgeOrder) {
      bridges.push({ id, pagePath: bridgePagePath.get(id) ?? null })
    }
    const entries: Record<string, Record<string, unknown>> = {}
    for (const [key, entry] of appDataCache) {
      const slash = key.indexOf('/')
      if (slash < 0) continue
      const bridgeId = key.slice(0, slash)
      const moduleId = key.slice(slash + 1)
      if (!entries[bridgeId]) entries[bridgeId] = {}
      const displayKey = entry.componentPath ?? moduleId
      entries[bridgeId][displayKey] = entry.data
    }
    return { bridges, entries }
  }

  // Mirror the flat cache into the `__simulatorData.getAppdata()` automation
  // surface so MCP / e2e reads keep working after the snapshot migration.
  function publishSnapshot(): void {
    const data: Record<string, unknown> = {}
    for (const [key, entry] of appDataCache) {
      data[key] = entry.data
    }
    setAppDataSnapshot(data)
  }

  function clearBridge(bridgeId: string): void {
    const prefix = `${bridgeId}/`
    for (const key of [...appDataCache.keys()]) {
      if (key.startsWith(prefix)) appDataCache.delete(key)
    }
    const idx = bridgeOrder.indexOf(bridgeId)
    if (idx >= 0) bridgeOrder.splice(idx, 1)
    bridgePagePath.delete(bridgeId)
    publishSnapshot()
    // The eviction is a cache mutation — notify the host so the renderer can
    // drop the evicted bridge's tab immediately.
    emit?.()
  }

  function applyAppData(body: unknown): void {
    const record = body as AppDataBody | null
    if (!record?.bridgeId || !record?.moduleId) return
    // R6: drop ub patches whose bridge has never been initialised. dimina
    // dispatches pageUnload to the service worker, which fires onUnload —
    // and onUnload's setData (e.g. console-test's stopTimer) produces a
    // late `ub` that arrives AFTER our clearBridge. Without this gate the
    // late patch would resurrect the unloaded bridge as a ghost tab.
    if (record.mode !== 'init' && !bridgePagePath.has(record.bridgeId)) return
    const key = `${record.bridgeId}/${record.moduleId}`
    const prev = appDataCache.get(key)
    const incoming = (record.data && typeof record.data === 'object'
      ? (record.data as Record<string, unknown>)
      : {})
    // init = full-state replace; patch = merge into previous (setData semantics)
    const merged = record.mode === 'init'
      ? { ...incoming }
      : { ...(prev?.data ?? {}), ...incoming }
    const componentPath = record.componentPath ?? prev?.componentPath
    const next: CacheEntry = componentPath !== undefined
      ? { componentPath, data: merged }
      : { data: merged }
    appDataCache.set(key, next)
    recordBridge(record.bridgeId)
    if (record.mode === 'init'
      && record.moduleId.startsWith('page_')
      && record.componentPath) {
      bridgePagePath.set(record.bridgeId, record.componentPath)
    }
    publishSnapshot()
    emit?.()
  }

  function instrumentPostMessage(worker: Worker): void {
    const orig = worker.postMessage.bind(worker) as (msg: unknown, ...rest: unknown[]) => void
    worker.postMessage = function (msg: unknown, ...rest: unknown[]) {
      const decoded = decodeOutgoingMessage(msg)
      if (decoded?.type === 'pageUnload' && decoded.bridgeId) {
        clearBridge(decoded.bridgeId)
      }
      return orig(msg, ...rest)
    } as Worker['postMessage']
  }

  function createInstrumentedWorker(Original: typeof Worker): typeof Worker {
    function InstrumentedWorker(
      this: unknown,
      scriptURL: string | URL,
      options?: WorkerOptions
    ): Worker {
      const resolvedScriptURL = scriptURL instanceof URL
        ? scriptURL
        : new URL(scriptURL, window.location.href)
      const worker = Reflect.construct(
        Original,
        [resolvedScriptURL, options],
        new.target ?? InstrumentedWorker
      ) as Worker

      instrumentPostMessage(worker)

      worker.addEventListener('message', (event: MessageEvent) => {
        const entries = decodeWorkerMessage(event.data)
        if (!entries) return
        for (const entry of entries) {
          const hookBody: AppDataBody = {
            bridgeId: entry.bridgeId,
            moduleId: entry.moduleId,
            data: entry.data,
            mode: entry.mode,
          }
          if (entry.mode === 'init') hookBody.componentPath = entry.componentPath
          window.__simulatorHook?.appData(hookBody)
        }
      })

      return worker
    }

    Object.setPrototypeOf(InstrumentedWorker, Original)
    Object.defineProperty(InstrumentedWorker, 'prototype', {
      value: Original.prototype,
    })

    return InstrumentedWorker as unknown as typeof Worker
  }

  return {
    id: 'appdata',
    snapshot: () => buildSnapshot(),
    start(onChange) {
      if (installed) return
      installed = true
      emit = onChange
      originalHook = window.__simulatorHook
      originalDescriptor = Object.getOwnPropertyDescriptor(window, 'Worker')
      OriginalWorker = window.Worker

      window.__simulatorHook = {
        appData: (body: unknown) => applyAppData(body),
      }

      Object.defineProperty(window, 'Worker', {
        configurable: true,
        writable: true,
        value: createInstrumentedWorker(OriginalWorker),
      })
    },
    dispose() {
      if (!installed) return
      installed = false
      if (originalDescriptor) {
        Object.defineProperty(window, 'Worker', originalDescriptor)
      } else if (OriginalWorker) {
        window.Worker = OriginalWorker
      }
      if (originalHook) {
        window.__simulatorHook = originalHook
      } else {
        delete window.__simulatorHook
      }
      originalDescriptor = undefined
      OriginalWorker = undefined
      originalHook = undefined
      appDataCache.clear()
      bridgeOrder.length = 0
      bridgePagePath.clear()
      clearAppDataSnapshot()
      emit = null
    },
  }
}
