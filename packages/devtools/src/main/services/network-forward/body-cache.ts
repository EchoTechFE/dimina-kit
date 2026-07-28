/**
 * PrefetchCache — a bounded, TTL'd "prime now / read later" promise cache.
 *
 * The network forwarder prefetches `Network.getResponseBody` /
 * `Network.getRequestPostData` from the simulator's CDP session the moment a
 * request finishes (the renderer may evict the resource soon after), keyed by
 * the namespaced virtual requestId. A later Response-tab click resolves from
 * here instead of re-issuing a debugger round-trip against a session that may
 * have moved on.
 *
 * Contract:
 *  - `prime(id, fetch)` is idempotent per id: while an entry is pending or a
 *    settled entry is still live, later primes are ignored.
 *  - A fetch rejection — or a resolved value whose `sizeOf` exceeds
 *    `perEntryMaxChars` — becomes an ERROR SENTINEL: the id stays known but
 *    every lookup rejects with the canonical not-found message (the same
 *    answer a real CDP backend gives for an unknown requestId, so the
 *    front-end renders its normal failure state).
 *  - `lookup(id)` resolves the cached value, awaits a still-pending fetch (a
 *    panel click can land before the prefetch settles), and rejects
 *    not-found for unknown / expired / evicted / sentinel entries.
 *  - Bounds apply to SETTLED entries only: LRU by settle/lookup recency up to
 *    `maxEntries`, plus a `maxTotalChars` budget over `sizeOf`. A pending
 *    entry counts 0 and is never evicted — evicting an in-flight prefetch
 *    would strand its waiters.
 *  - TTL is anchored to the SETTLE time (not the prime() call time) and is
 *    enforced lazily on the next prime/lookup.
 */

const NOT_FOUND = 'No resource with given identifier found'

/**
 * Default per-entry size ceiling (chars). Exported so callers that need to
 * pre-screen a fetch BEFORE issuing it (e.g. skipping a CDP round-trip for a
 * response already known to be oversized) reference the exact same number
 * `PrefetchCache`'s own default enforces — one source of truth, not two
 * independently-configured limits that could silently drift apart.
 */
export const DEFAULT_PER_ENTRY_MAX_CHARS = 16 * 1024 * 1024

export interface PrefetchCacheOptions {
  maxEntries?: number
  maxTotalChars?: number
  perEntryMaxChars?: number
  ttlMs?: number
  /** Injectable clock for TTL tests. */
  now?: () => number
}

interface Entry<V> {
  /** Normalized fetch: resolves the validated value or rejects not-found. */
  promise: Promise<V>
  pending: boolean
  failed: boolean
  /**
   * The settled value. `null` doubles as "not stored" (pending / sentinel);
   * a cached value type that legitimately contains `null` would be
   * indistinguishable from it — the CDP payloads cached here are objects.
   */
  value: V | null
  size: number
  settledAt: number
}

export class PrefetchCache<V> {
  private readonly map = new Map<string, Entry<V>>()
  private readonly maxEntries: number
  private readonly maxTotalChars: number
  private readonly perEntryMaxChars: number
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(
    private readonly sizeOf: (v: V) => number,
    opts: PrefetchCacheOptions = {},
  ) {
    this.maxEntries = opts.maxEntries ?? 256
    this.maxTotalChars = opts.maxTotalChars ?? 64 * 1024 * 1024
    this.perEntryMaxChars = opts.perEntryMaxChars ?? DEFAULT_PER_ENTRY_MAX_CHARS
    this.ttlMs = opts.ttlMs ?? 5 * 60_000
    this.now = opts.now ?? (() => Date.now())
  }

  /**
   * Returns `true` when this call actually started a new fetch, `false` when
   * it was a no-op (idempotent re-prime of an id that's already pending or
   * still live). Callers that admission-gate priming (a concurrency cap) need
   * this to know whether they actually consumed a slot — incrementing a
   * counter unconditionally would leak a slot on every no-op re-prime.
   */
  prime(id: string, fetch: () => Promise<V>): boolean {
    this.sweepExpired()
    const existing = this.map.get(id)
    if (existing && (existing.pending || !this.isExpired(existing))) return false
    if (existing) this.map.delete(id)

    // A synchronously-throwing fetch (destroyed webContents) is a rejection.
    let fetched: Promise<V>
    try {
      fetched = fetch()
    } catch (err) {
      fetched = Promise.reject(err instanceof Error ? err : new Error(String(err)))
    }

    const entry: Entry<V> = {
      promise: fetched,
      pending: true,
      failed: false,
      value: null,
      size: 0,
      settledAt: 0,
    }
    entry.promise = fetched.then(
      (v) => {
        entry.pending = false
        entry.settledAt = this.now()
        const size = this.sizeOf(v)
        if (size > this.perEntryMaxChars) {
          entry.failed = true
          throw new Error(NOT_FOUND)
        }
        entry.value = v
        entry.size = size
        // Refresh recency at settle time (identity-checked: a clear() while
        // pending must not resurrect the entry) and enforce the bounds now
        // that this entry's real size is known.
        if (this.map.get(id) === entry) {
          this.map.delete(id)
          this.map.set(id, entry)
          this.evict()
        }
        return v
      },
      () => {
        entry.pending = false
        entry.failed = true
        entry.settledAt = this.now()
        throw new Error(NOT_FOUND)
      },
    )
    // A never-looked-up sentinel must not surface as an unhandled rejection.
    entry.promise.catch(() => {})
    this.map.set(id, entry)
    return true
  }

  lookup(id: string): Promise<V> {
    this.sweepExpired()
    const e = this.map.get(id)
    if (!e) return Promise.reject(new Error(NOT_FOUND))
    // A pending entry's normalized promise already carries the outcome the
    // waiter needs (value, sentinel, or size overflow) — hand it out directly
    // so the answer never races the map bookkeeping.
    if (e.pending) return e.promise
    if (e.failed || this.isExpired(e)) {
      if (!e.failed) this.map.delete(id)
      return Promise.reject(new Error(NOT_FOUND))
    }
    const v = e.value
    if (v === null) return Promise.reject(new Error(NOT_FOUND))
    // A hit refreshes LRU recency.
    this.map.delete(id)
    this.map.set(id, e)
    return Promise.resolve(v)
  }

  clear(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }

  private isExpired(e: Entry<V>): boolean {
    return !e.pending && this.now() - e.settledAt > this.ttlMs
  }

  private sweepExpired(): void {
    for (const [k, e] of this.map) {
      if (this.isExpired(e)) this.map.delete(k)
    }
  }

  /** Evict oldest SETTLED entries until both bounds hold; pending are exempt. */
  private evict(): void {
    let settled = 0
    let total = 0
    for (const e of this.map.values()) {
      if (!e.pending) {
        settled++
        total += e.size
      }
    }
    if (settled <= this.maxEntries && total <= this.maxTotalChars) return
    for (const [k, e] of this.map) {
      if (settled <= this.maxEntries && total <= this.maxTotalChars) break
      if (e.pending) continue
      this.map.delete(k)
      settled--
      total -= e.size
    }
  }
}
