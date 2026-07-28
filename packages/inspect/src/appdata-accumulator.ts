/**
 * Framework-agnostic AppData accumulator.
 *
 * The dimina runtime emits two service→render messages relevant to the AppData
 * panel, identical in shape on BOTH container paths:
 *   • update batches `{type:'ub', body:{bridgeId, updates:[{moduleId,data}]}}`
 *     — each `data` is a partial setData patch.
 *   • instance init: `type === 'page_*'`, body `{bridgeId, path, data}` with the
 *     COMPLETE initial state.
 *
 * Hosts differ only in where they tap that stream — an Electron preload
 * sniffing Worker `message` events, a main-process service→render forward, or
 * a same-origin web workbench observing the pageFrame's Worker. Every tap
 * feeds this one accumulator so the decode/merge/page-only/init-gate policy
 * can't drift between hosts.
 */

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

export type DecodedEntry =
  | { mode: 'patch'; bridgeId: string; moduleId: string; data: unknown }
  | {
      mode: 'init'
      bridgeId: string
      moduleId: string
      componentPath: string
      data: Record<string, unknown>
    }

/** Normalized input to the accumulator (built from a DecodedEntry or the hook). */
export interface AppDataInput {
  bridgeId?: string
  moduleId?: string
  componentPath?: string
  data?: unknown
  mode?: 'init' | 'patch'
}

interface CacheEntry {
  componentPath?: string
  data: Record<string, unknown>
}

/** Parse a service/worker message payload; a non-string is passed through as-is. */
function parseMessagePayload(message: unknown): unknown {
  if (typeof message !== 'string') return message
  try {
    return JSON.parse(message)
  } catch {
    return null
  }
}

/**
 * Decode a `ub` (update batch) body into patch entries, PAGE modules only —
 * component-module updates are dropped (see `decodeWorkerMessage`).
 */
function decodeUpdateBatchBody(rawBody: unknown): DecodedEntry[] | null {
  const body = rawBody as { bridgeId?: unknown; updates?: unknown } | null
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

/** Decode a `page_*` instance-init body into its single init entry. */
function decodePageInitBody(moduleId: string, rawBody: unknown): DecodedEntry[] | null {
  const body = rawBody as { bridgeId?: unknown; path?: unknown; data?: unknown } | null
  if (!body || typeof body !== 'object') return null
  if (typeof body.bridgeId !== 'string' || typeof body.path !== 'string') return null
  if (!body.data || typeof body.data !== 'object') return null
  return [{
    mode: 'init',
    bridgeId: body.bridgeId,
    moduleId,
    componentPath: body.path,
    data: body.data as Record<string, unknown>,
  }]
}

/**
 * Decode a service→render message into AppData entries, or null when it is not
 * AppData-relevant. Policy: surface PAGE entries only — component entries are
 * dropped (they sometimes flow on a bridge id distinct from their owning page's
 * and never receive pageUnload, which would manifest as ghost tabs).
 */
export function decodeWorkerMessage(message: unknown): DecodedEntry[] | null {
  const payload = parseMessagePayload(message)
  if (!payload || typeof payload !== 'object') return null
  const record = payload as { type?: unknown; body?: unknown }

  if (record.type === 'ub') return decodeUpdateBatchBody(record.body)
  if (typeof record.type === 'string' && record.type.startsWith('page_')) {
    return decodePageInitBody(record.type, record.body)
  }
  return null
}

/** main→worker direction: container signals page teardown so cache can evict. */
export function decodeOutgoingMessage(message: unknown): { type: string; bridgeId?: string } | null {
  const payload = parseMessagePayload(message)
  if (!payload || typeof payload !== 'object') return null
  const r = payload as { type?: unknown; body?: { bridgeId?: unknown } | null }
  if (typeof r.type !== 'string') return null
  return {
    type: r.type,
    bridgeId: typeof r.body?.bridgeId === 'string' ? r.body.bridgeId : undefined,
  }
}

/** Convert a decoded entry to the normalized accumulator input. */
export function decodedToInput(entry: DecodedEntry): AppDataInput {
  const input: AppDataInput = {
    bridgeId: entry.bridgeId,
    moduleId: entry.moduleId,
    data: entry.data,
    mode: entry.mode,
  }
  if (entry.mode === 'init') input.componentPath = entry.componentPath
  return input
}

/**
 * Cumulative per-(bridgeId, moduleId) setData state. Pure data structure — no
 * Worker / IPC / DOM. Callers own transport (publish/emit) and the automation
 * mirror.
 */
export class AppDataAccumulator {
  private readonly cache = new Map<string, CacheEntry>()
  // Bridges in insertion order — drives the `bridges` array (stable tab order).
  private readonly bridgeOrder: string[] = []
  // Page path per bridge: set from `page_*` init's body.path (the page route).
  private readonly bridgePagePath = new Map<string, string>()

  private recordBridge(bridgeId: string): void {
    if (!this.bridgeOrder.includes(bridgeId)) this.bridgeOrder.push(bridgeId)
  }

  /**
   * Apply one entry. Returns true if it was accepted (a mutation worth
   * republishing), false if dropped (missing ids, or the init-gate).
   */
  apply(input: AppDataInput): boolean {
    if (!input.bridgeId || !input.moduleId) return false
    // Drop ub patches whose bridge has never been initialised. dimina
    // dispatches pageUnload → onUnload, whose setData produces a late `ub`
    // arriving AFTER clearBridge; without this gate it would resurrect the
    // unloaded bridge as a ghost tab.
    if (input.mode !== 'init' && !this.bridgePagePath.has(input.bridgeId)) return false
    const key = `${input.bridgeId}/${input.moduleId}`
    const prev = this.cache.get(key)
    const incoming = input.data && typeof input.data === 'object'
      ? (input.data as Record<string, unknown>)
      : {}
    // init = full-state replace; patch = merge into previous (setData semantics)
    const merged = input.mode === 'init'
      ? { ...incoming }
      : { ...(prev?.data ?? {}), ...incoming }
    const componentPath = input.componentPath ?? prev?.componentPath
    const next: CacheEntry = componentPath !== undefined
      ? { componentPath, data: merged }
      : { data: merged }
    this.cache.set(key, next)
    this.recordBridge(input.bridgeId)
    if (input.mode === 'init' && input.moduleId.startsWith('page_') && input.componentPath) {
      this.bridgePagePath.set(input.bridgeId, input.componentPath)
    }
    return true
  }

  /** Evict every entry for a bridge (page teardown). */
  clearBridge(bridgeId: string): void {
    const prefix = `${bridgeId}/`
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(prefix)) this.cache.delete(key)
    }
    const idx = this.bridgeOrder.indexOf(bridgeId)
    if (idx >= 0) this.bridgeOrder.splice(idx, 1)
    this.bridgePagePath.delete(bridgeId)
  }

  /** The full cumulative snapshot for the panel. */
  snapshot(): AppDataSnapshot {
    const bridges: Array<{ id: string; pagePath: string | null }> = []
    for (const id of this.bridgeOrder) {
      bridges.push({ id, pagePath: this.bridgePagePath.get(id) ?? null })
    }
    const entries: Record<string, Record<string, unknown>> = {}
    for (const [key, entry] of this.cache) {
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

  /**
   * The current reactive page state for a bridge: shallow-merge of `entry.data`
   * across every cache entry whose key starts with `${bridgeId}/`, in insertion
   * order (later entries win on key conflicts). `{}` when no entries match
   * (unknown bridge / after clearBridge). Pure, no side effects.
   */
  pageData(bridgeId: string): Record<string, unknown> {
    const merged: Record<string, unknown> = {}
    for (const [key, entry] of this.cache) {
      const slash = key.indexOf('/')
      if (slash < 0) continue
      if (key.slice(0, slash) !== bridgeId) continue
      Object.assign(merged, entry.data)
    }
    return merged
  }

  /** Flat `key → data` map for the `__simulatorData.getAppdata()` mirror. */
  flat(): Record<string, unknown> {
    const data: Record<string, unknown> = {}
    for (const [key, entry] of this.cache) data[key] = entry.data
    return data
  }

  clear(): void {
    this.cache.clear()
    this.bridgeOrder.length = 0
    this.bridgePagePath.clear()
  }
}
