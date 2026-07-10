/**
 * Binary side-car — the authoritative owner of "binary files live OUTSIDE the
 * fs-core string ledger". The ledger's write/read surface is a string-content
 * contract (WAL audit, diff/restore all reason over text), so every host that
 * meets a binary file needs the same three things this module owns exactly
 * once:
 *
 *  - classification: {@link looksBinary} (a NUL byte in the first 8192 bytes);
 *  - a unified index: `rel -> { size, sha256 }`, maintained for every entry
 *    regardless of whether bytes are retained;
 *  - echo judgement: {@link BinarySidecar.put} compares size+sha256 against
 *    the prior entry and reports `false` (unchanged) for a re-arrival of the
 *    same bytes — the exact judgement the sync engine uses to absorb a binary
 *    file's own write echo.
 *
 * Two host shapes, one abstraction:
 *  - dimina-kit's sync engine (sync-engine.ts) keeps an INDEX-ONLY sidecar —
 *    it never needs the bytes back, only membership + echo judgement;
 *  - a host whose ledger snapshot must be re-joined with the binary set
 *    (qdmp-web-workbench feeding compile/export/disk-mirror) constructs it
 *    with `retainBytes: true` and uses {@link BinarySidecar.overlay} as the
 *    ONE place that merges "ledger text + binary side-car" (ledger text wins
 *    on a path present in both — the ledger is the authority for anything it
 *    holds).
 *
 * Change events (`onChange`) fire on every effective mutation (`put` that
 * actually changed, `remove` of an existing entry) — `clear()`/`reset()` are
 * session reseeds (project switch / ledger repopulate) and deliberately do
 * NOT emit per-entry removals; a subscriber that survives a reseed should
 * re-read the sidecar wholesale, same as it re-reads the ledger.
 */

const BINARY_SNIFF_BYTES = 8192

/** True when the first {@link BINARY_SNIFF_BYTES} of `bytes` contain a NUL
 * byte — the classification gate for the whole binary layering. */
export function looksBinary(bytes: Uint8Array): boolean {
  const len = Math.min(bytes.length, BINARY_SNIFF_BYTES)
  for (let i = 0; i < len; i++) {
    if (bytes[i] === 0) return true
  }
  return false
}

export async function sha256hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Byte-for-byte equality. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export interface BinarySidecarEntry {
  size: number
  sha256: string
}

export interface BinarySidecarOptions {
  /** Keep the actual bytes alongside the index (for hosts that re-join the
   * binary set with ledger snapshots — see the module doc). Default: index
   * only. */
  retainBytes?: boolean
}

export interface BinarySidecar {
  /** Record `bytes` for `rel`. Returns `false` when the entry is an echo of
   * what is already recorded (same size + sha256) — nothing changes and no
   * event fires — and `true` when the entry was created or updated. */
  put(rel: string, bytes: Uint8Array): Promise<boolean>
  /** Remove `rel`. Resolves to whether an entry actually existed. */
  remove(rel: string): Promise<boolean>
  has(rel: string): boolean
  entry(rel: string): BinarySidecarEntry | undefined
  /** The retained bytes for `rel` — always `undefined` without `retainBytes`. */
  bytes(rel: string): Uint8Array | undefined
  keys(): string[]
  readonly size: number
  /** Session reseed: drop everything, silently (see the module doc). */
  clear(): Promise<void>
  /** Bulk session reseed: replace the whole content with `files` — the reseed
   * a host's project-open path uses. */
  reset(files: Record<string, Uint8Array>): Promise<void>
  /** Snapshot of the retained bytes (`retainBytes` hosts only; empty otherwise). */
  toRecord(): Record<string, Uint8Array>
  /** THE merge of "ledger text + binary side-car": entries of `files` win
   * over sidecar bytes for a path present in both. Requires `retainBytes`. */
  overlay<T>(files: Record<string, T>): Record<string, T | Uint8Array>
  /** Subscribe to effective mutations (`bytes === null` = removal). Returns
   * an unsubscribe function. */
  onChange(cb: (rel: string, bytes: Uint8Array | null) => void): () => void
}

export function createBinarySidecar(opts: BinarySidecarOptions = {}): BinarySidecar {
  const retainBytes = opts.retainBytes === true
  // `let` (not const): reset() swaps in fully-built replacement maps in one
  // synchronous step — see its body.
  let index = new Map<string, BinarySidecarEntry>()
  let store = new Map<string, Uint8Array>()
  const changeCbs = new Set<(rel: string, bytes: Uint8Array | null) => void>()

  /**
   * FIFO serializing every MUTATION (put/remove/clear/reset) in caller order.
   * Without it, a put whose (async) hashing straddles an in-flight reset()
   * lands on maps the reset is about to swap away — the mutation silently
   * vanishes — and two overlapping resets resolve as "last swapper wins"
   * instead of "last caller wins". Serialized, a mutation issued after
   * reset() runs after it and lands in the NEW session; one issued before is
   * superseded by it — nothing races across a session boundary. READS
   * (has/entry/bytes/keys/overlay/toRecord) stay synchronous against the
   * currently visible maps: reset's one-step swap keeps them consistent.
   * The chain swallows step rejections so one failed mutation cannot wedge
   * the queue.
   */
  let mutationTurn: Promise<unknown> = Promise.resolve()
  function enqueueMutation<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = mutationTurn.then(fn, fn) as Promise<T>
    mutationTurn = next.catch(() => {})
    return next
  }

  function emit(rel: string, bytes: Uint8Array | null): void {
    for (const cb of changeCbs) {
      try {
        cb(rel, bytes)
      } catch {
        // A subscriber's failure is its own — it must not break the mutation
        // that already happened, nor starve later subscribers.
      }
    }
  }

  return {
    put(rel, bytes) {
      return enqueueMutation(async () => {
        const sha256 = await sha256hex(bytes)
        const prior = index.get(rel)
        if (prior && prior.size === bytes.length && prior.sha256 === sha256) return false
        index.set(rel, { size: bytes.length, sha256 })
        if (retainBytes) store.set(rel, bytes)
        emit(rel, bytes)
        return true
      })
    },
    remove(rel) {
      return enqueueMutation(() => {
        const existed = index.delete(rel)
        store.delete(rel)
        if (existed) emit(rel, null)
        return existed
      })
    },
    has: (rel) => index.has(rel),
    entry: (rel) => index.get(rel),
    bytes: (rel) => store.get(rel),
    keys: () => [...index.keys()],
    get size() {
      return index.size
    },
    clear() {
      return enqueueMutation(() => {
        index.clear()
        store.clear()
      })
    },
    reset(files) {
      return enqueueMutation(async () => {
        // Atomic to readers: hashing runs against LOCAL maps and the visible
        // state is swapped in one synchronous step at the end — a concurrent
        // overlay()/toRecord()/entry() sees either the old set or the new
        // set, never an empty or half-built one. Silent by design (see the
        // module doc): a session reseed fires no per-entry events. Ordering
        // vs other mutations comes from the mutation FIFO above.
        const nextIndex = new Map<string, BinarySidecarEntry>()
        const nextStore = new Map<string, Uint8Array>()
        for (const [rel, bytes] of Object.entries(files)) {
          nextIndex.set(rel, { size: bytes.length, sha256: await sha256hex(bytes) })
          if (retainBytes) nextStore.set(rel, bytes)
        }
        index = nextIndex
        store = nextStore
      })
    },
    toRecord: () => Object.fromEntries(store),
    overlay(files) {
      if (!retainBytes) throw new Error('overlay() requires a retainBytes sidecar — an index-only sidecar has no bytes to merge')
      return { ...Object.fromEntries(store), ...files }
    },
    onChange(cb) {
      changeCbs.add(cb)
      return () => changeCbs.delete(cb)
    },
  }
}
