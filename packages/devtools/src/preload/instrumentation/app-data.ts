import { SimulatorChannel, BridgeChannel } from '../../shared/ipc-channels.js'
import { onHostMessage, sendToHost } from '../runtime/host.js'
import {
  clearAppDataSnapshot,
  setAppDataSnapshot,
} from '../runtime/bridge.js'
import { createDisposableSet } from './disposable.js'

// Window augmentation is in ../types.ts

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

const appDataCache = new Map<string, CacheEntry>()
// Bridges in insertion order — drives the `bridges` array in snapshots so
// renderer tabs render in a stable, chronological sequence.
const bridgeOrder: string[] = []
// Page path per bridge: set from `page_*` init's body.path. Component init
// also carries a path but it's the component's own path, not the page route.
const bridgePagePath = new Map<string, string>()

type SnapshotPayload = {
  bridges: Array<{ id: string; pagePath: string | null }>
  entries: Record<string, Record<string, unknown>>
}

function recordBridge(bridgeId: string): void {
  if (!bridgeOrder.includes(bridgeId)) bridgeOrder.push(bridgeId)
}

function buildSnapshot(): SnapshotPayload {
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
  // Push a refreshed snapshot so the renderer can drop the evicted bridge
  // immediately, without waiting for the user to hit the refresh button.
  sendToHost(SimulatorChannel.AppDataAll, buildSnapshot())
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

function createInstrumentedWorker(OriginalWorker: typeof Worker): typeof Worker {
  function InstrumentedWorker(
    this: unknown,
    scriptURL: string | URL,
    options?: WorkerOptions
  ): Worker {
    const resolvedScriptURL = scriptURL instanceof URL
      ? scriptURL
      : new URL(scriptURL, window.location.href)
    const worker = Reflect.construct(
      OriginalWorker,
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

  Object.setPrototypeOf(InstrumentedWorker, OriginalWorker)
  Object.defineProperty(InstrumentedWorker, 'prototype', {
    value: OriginalWorker.prototype,
  })

  return InstrumentedWorker as unknown as typeof Worker
}

export function installAppDataInstrumentation(): () => void {
  const disposables = createDisposableSet()
  const originalHook = window.__simulatorHook
  const originalDescriptor = Object.getOwnPropertyDescriptor(window, 'Worker')
  const OriginalWorker = window.Worker

  window.__simulatorHook = {
    appData: (body: unknown) => {
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
      const payload: Record<string, unknown> = {
        bridgeId: record.bridgeId,
        moduleId: record.moduleId,
        data: merged,
      }
      if (componentPath !== undefined) payload.componentPath = componentPath
      sendToHost(SimulatorChannel.AppData, payload)
    },
  }

  Object.defineProperty(window, 'Worker', {
    configurable: true,
    writable: true,
    value: createInstrumentedWorker(OriginalWorker),
  })

  disposables.add(
    onHostMessage(BridgeChannel.AppDataGetAllRequest, () => sendAllAppData()),
  )

  publishSnapshot()

  disposables.add(() => {
    if (originalDescriptor) {
      Object.defineProperty(window, 'Worker', originalDescriptor)
    } else {
      window.Worker = OriginalWorker
    }
  })

  disposables.add(() => {
    if (originalHook) {
      window.__simulatorHook = originalHook
    } else {
      delete window.__simulatorHook
    }
  })

  disposables.add(() => {
    appDataCache.clear()
    bridgeOrder.length = 0
    bridgePagePath.clear()
    clearAppDataSnapshot()
    publishSnapshot()
  })

  return () => {
    disposables.disposeAll()
  }
}

export function sendAllAppData(): void {
  publishSnapshot()
  sendToHost(SimulatorChannel.AppDataAll, buildSnapshot())
}
