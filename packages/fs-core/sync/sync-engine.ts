/**
 * Sync arbitration engine — the memfs<->disk synchronization core shared by
 * every host that pairs an fs-core ledger with an external truth source.
 * A host wires a `client` (the
 * fs-core ledger: write/rm/read/ls) and a `TruthPort` (its external truth
 * source — devtools' `/__fs` bridge + SSE watch, or a future FSA
 * local-directory adapter) and gets back an engine that keeps the ledger,
 * the external truth, and — via `applyToEditor` — the live editor buffer
 * reconciled. `kernel` and turn enforcement never enter this module: a
 * host's own audit-turn surface talks to `client` directly for that (see
 * wal-audit.ts).
 *
 * Echo judgement (both directions, content comparison against the ledger's
 * own record):
 *  - Outbound (`onHumanSave`): before recording, compare the saved text
 *    against the ledger's current record for that path — identical content
 *    is a no-op (the ledger already reflects it), skipping a redundant
 *    write. The onHumanSave accounting step and inbound batches run through
 *    the same `ledgerTurn` FIFO, so an inbound notification for a path whose
 *    save is still in flight always observes the completed ledger write and
 *    absorbs itself via that same comparison.
 *  - Inbound (`changes` batches, via `handleInboundPath`): truth-source
 *    bytes equal to the ledger's record are the echo of our own last write —
 *    dropped with no ledger write and no editor refresh.
 * This engine serves 'push' ports only (the port notifies; the host's
 * outbound writes go through `onHumanSave`). A future 'poll' host whose
 * outbound scan runs outside this module must own its own one-shot echo
 * suppression — see the README's「两套磁盘机制的划界」section for the
 * invariants such an adapter has to satisfy.
 *
 * Degradation is loud (`onDegraded`): a dead watcher and a path that failed
 * to sync (truth-source read failure, or a ledger write/rm failure while
 * reconciling) are surfaced to the host through {@link SyncDegradation} in
 * addition to the console warning — silently skipping them would let the
 * ledger drift with no operator-visible signal.
 *
 * Binary layering: classification (NUL sniff), the `rel -> {size, sha256}`
 * index, and echo judgement (size+hash equality instead of a ledger content
 * compare) are all owned by ./binary-sidecar.ts — see that module's doc; this
 * engine holds an INDEX-ONLY sidecar. A binary file never reaches the fs-core
 * ledger (`client.write`/`read`). What/why this is narrower than the text
 * path: binary changes get NO WAL audit and NO rollback (the audit turn
 * surface — `diff`/`restore` — is a string-content contract; the engine does
 * not support an agent writing binary inside a turn), and the sidecar is
 * session-scoped — cleared and rebuilt from scratch on every
 * `populateLedger()`, exactly like the ledger's own text reconciliation.
 */

import { createBinarySidecar, looksBinary } from './binary-sidecar.js'
import type { TruthPort } from './truth-port.js'

export type { TruthPort, TruthPortCapabilities } from './truth-port.js'

/**
 * The slice of the fs-core ledger client the sync engine calls. Kept narrow
 * (vs. the full `ProjectFsClient` surface) so a host/test double only has to
 * implement what this module actually uses. Turn enforcement
 * (turnBegin/turnEnd/diff/restore) and destroy() are NOT part of this
 * surface — they belong to a host's own audit-turn surface, which talks to
 * the real client directly (see dimina-kit workbench's wal-audit.ts).
 */
export interface SyncClientLike {
  write(path: string, content: string, opts?: Record<string, unknown>): Promise<unknown>
  rm(path: string, opts?: Record<string, unknown>): Promise<unknown>
  read(path: string): Promise<{ content: string; rev?: number }>
  ls(): Promise<{ paths: string[] }>
}

/**
 * A host-visible sync degradation (see the module doc's "Degradation is
 * loud" paragraph):
 *  - `watcher-dead`: the port's change subscription died — from now on the
 *    ledger only reflects the open-time mirror plus already-processed
 *    batches.
 *  - `path-sync-failed`: one path failed to reconcile and was skipped;
 *    `stage` says where — `truth-read` (the truth source's read rejected
 *    transiently) or `reconcile` (the ledger write/rm itself failed).
 */
export type SyncDegradation =
  | { kind: 'watcher-dead' }
  | { kind: 'path-sync-failed'; rel: string; stage: 'truth-read' | 'reconcile'; error: unknown }

export interface SyncEngineOptions {
  /**
   * Host seam: push an inbound change into the live editor buffer.
   * `bytes === null` means the path was deleted. Omitted — the ledger still
   * records the change but the editor buffer is left untouched.
   */
  applyToEditor?: (rel: string, bytes: Uint8Array | null) => Promise<void>
  /**
   * Host seam: surface a {@link SyncDegradation}. Called in addition to the
   * console warning, never instead of it; a throwing callback is the host's
   * own bug and never breaks the engine.
   */
  onDegraded?: (degradation: SyncDegradation) => void
}

export interface SyncEngine {
  /**
   * Walk the port's tree into the ledger and reconcile residue: ledger paths
   * absent from the walk are removed, so the ledger ends up exactly matching
   * the truth source. Call once (per session) before `start()`.
   */
  populateLedger(): Promise<void>
  /**
   * Record a human save's content in the ledger — skipped when it already
   * matches the ledger's current record for that path. Call AFTER the save
   * has landed at the truth source: this is best-effort accounting, never a
   * gate on the save itself.
   *
   * `content` accepts either the already-decoded text (legacy string path)
   * or the raw saved bytes (`Uint8Array`) — pass raw bytes so the engine can
   * sniff for binary content (see this module's "Binary layering" doc) and
   * route it to the session-scoped `binaryIndex` instead of the ledger.
   */
  onHumanSave(rel: string, content: string | Uint8Array): Promise<void>
  /** Subscribe to `port.changes` and start reconciling inbound batches. */
  start(): void
  /** Tear down the `port.changes` subscription. Idempotent. */
  stop(): void
}

/**
 * True when `error` denotes "path does not exist" per the TruthPort error
 * contract (see truth-port.ts): `error.code === 'not-found'` or
 * `error.status === 404`. Every other rejection is "unavailable" (transient
 * I/O failure, permission loss, dead connection, ...).
 */
function isNotFoundError(error: unknown): boolean {
  const e = error as { code?: unknown; status?: unknown } | null | undefined
  return Boolean(e) && (e!.code === 'not-found' || e!.status === 404)
}

export function createSyncEngine(
  client: SyncClientLike,
  port: TruthPort,
  opts: SyncEngineOptions = {},
): SyncEngine {
  const decoder = new TextDecoder()
  const applyToEditor = opts.applyToEditor

  /** Surface a degradation to the host — a throwing callback is the host's
   * own bug and must not break the reconciliation that reported it. */
  function degrade(degradation: SyncDegradation): void {
    try {
      opts.onDegraded?.(degradation)
    } catch (e) {
      console.warn('[fs-core/sync] onDegraded callback threw', e)
    }
  }

  /**
   * Binary files never enter the fs-core ledger — see the module doc's
   * "Binary layering" section. Index-only (this engine never needs the bytes
   * back); session-scoped: rebuilt from scratch on every `populateLedger()`.
   */
  const binaryIndex = createBinarySidecar()

  /**
   * FIFO queue serializing every compare-then-record against the ledger
   * (inbound change batches AND the onHumanSave accounting step). Without it
   * the two race: an inbound echo's compare-read can run while an
   * onHumanSave ledger write is still in flight, see stale content, and
   * re-record the identical bytes. Serialized, the loser of the race sees
   * the winner's write and absorbs it as an echo. The chain swallows step
   * rejections (each caller handles its own errors), so one failed step can
   * never wedge the queue.
   */
  let ledgerTurn: Promise<unknown> = Promise.resolve()
  function enqueueLedgerTurn<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = ledgerTurn.then(fn, fn) as Promise<T>
    ledgerTurn = next.catch(() => {})
    return next
  }

  /** Walk the port's tree into the ledger, then reconcile: ledger paths the
   * walk did not produce are residue (e.g. from a previous session under the
   * same persisted ledger identity) and are removed so the ledger ends up
   * exactly matching the walked tree. */
  async function seedFromDisk(): Promise<void> {
    await binaryIndex.clear()
    const seen = new Set<string>()
    await port.walk(async (rel, bytes) => {
      seen.add(rel)
      if (looksBinary(bytes)) {
        await binaryIndex.put(rel, bytes)
        return // binary never enters the ledger
      }
      await client.write(rel, decoder.decode(bytes), { actor: 'human' })
    })
    const { paths } = await client.ls()
    for (const p of paths) {
      // Residue from a previous session, OR a path that used to be
      // ledgered as text but is now classified binary (migration cleanup —
      // binaryIndex.has(p) is authoritative once the walk above ran).
      if (!seen.has(p) || binaryIndex.has(p)) await client.rm(p, { actor: 'human' })
    }
  }

  /**
   * Process one inbound path via content comparison: identical content is
   * the echo of our own last write and is dropped with no ledger write and
   * no `applyToEditor` call. A `port.read` rejection classified as not-found
   * (see truth-port.ts) is a deletion; any other rejection
   * ("unavailable") is transient and skips the path entirely (surfaced as a
   * `truth-read` degradation) — inferring a deletion from it would rm the
   * ledger record and close the file in the editor while it still exists at
   * the truth source.
   */
  async function handleInboundPath(rel: string): Promise<void> {
    let bytes: Uint8Array | null
    try {
      bytes = await port.read(rel)
    } catch (e) {
      if (!isNotFoundError(e)) {
        console.warn('[fs-core/sync] transient port read failure, skipping', rel, e)
        degrade({ kind: 'path-sync-failed', rel, stage: 'truth-read', error: e })
        return
      }
      bytes = null
    }

    if (bytes === null) {
      // Deletion. A path the binaryIndex knows about was never in the
      // ledger (it never took the client.write path), so removal here is
      // index-only — no client.rm.
      if (binaryIndex.has(rel)) {
        await binaryIndex.remove(rel)
        await applyToEditor?.(rel, null)
        return
      }
      let ledgerContent: string | undefined
      try {
        ledgerContent = (await client.read(rel)).content
      } catch (e) {
        if (!isNotFoundError(e)) {
          // A transient ledger read failure is NOT "already absent" — rm'ing
          // (or silently skipping) on unknown ledger state would either drop
          // a record we could not confirm or leave it stale with no signal.
          // Skip the path and surface it; the next change event retries.
          console.warn('[fs-core/sync] ledger read failed while confirming a deletion, skipping', rel, e)
          degrade({ kind: 'path-sync-failed', rel, stage: 'reconcile', error: e })
          return
        }
        ledgerContent = undefined
      }
      if (ledgerContent === undefined) return // already absent from both sides
      await client.rm(rel, { actor: 'human' })
      await applyToEditor?.(rel, null)
      return
    }

    if (looksBinary(bytes)) {
      // Echo judgement is the sidecar's put(): `false` = same size+sha256
      // already indexed, i.e. the echo of our own last write.
      if (!(await binaryIndex.put(rel, bytes))) return
      await applyToEditor?.(rel, bytes)
      return
    }

    let ledgerContent: string | undefined
    try {
      ledgerContent = (await client.read(rel)).content
    } catch {
      // Not in the ledger yet (or a transient read failure) — treated the
      // same as "no prior recorded content", so a real file at the truth
      // source always gets recorded/applied below rather than silently
      // dropped.
      ledgerContent = undefined
    }

    const text = decoder.decode(bytes)
    if (ledgerContent !== undefined && text === ledgerContent) return // echo of our own write

    await client.write(rel, text, { actor: 'human' })
    await applyToEditor?.(rel, bytes)
  }

  /**
   * A batch is trusted as-is: the port adapter (see truth-port.ts's
   * `changes` doc) is responsible for turning a watcher's coalesced/lossy
   * events into the actual set of paths worth re-examining BEFORE calling
   * this engine — devtools' adapter (dimina-kit workbench's wal-audit.ts +
   * this package's ./watch-expander.ts) does that via a stat-level disk
   * compare against a session index, so paths arriving here have already earned
   * their re-examination and no further expansion happens at this layer.
   */
  async function handleBatch(paths: string[]): Promise<void> {
    for (const rel of paths) {
      try {
        // Per-path (not per-batch) queue turns, so a long batch cannot
        // starve an interleaved onHumanSave accounting step of its FIFO
        // position.
        await enqueueLedgerTurn(() => handleInboundPath(rel))
      } catch (e) {
        console.warn('[fs-core/sync] disk sync failed for', rel, e)
        degrade({ kind: 'path-sync-failed', rel, stage: 'reconcile', error: e })
      }
    }
  }

  let pendingInboundPaths = new Set<string>()
  let inboundBatchRunning = false
  function enqueueInboundBatch(paths: string[]): void {
    for (const rel of paths) pendingInboundPaths.add(rel)
    if (inboundBatchRunning) return
    inboundBatchRunning = true
    void (async () => {
      try {
        while (pendingInboundPaths.size) {
          const raw = [...pendingInboundPaths]
          pendingInboundPaths = new Set<string>()
          await handleBatch(raw)
        }
      } finally {
        inboundBatchRunning = false
        if (pendingInboundPaths.size) enqueueInboundBatch([])
      }
    })()
  }

  let stopWatching = () => {}

  /** Subscribe to `port.changes`. `active` gates BOTH callbacks so a
   * late/duplicate event delivered after `onDead` (or after a fresh
   * `start()` superseded this subscription) is a guaranteed no-op, not just
   * best-effort. The subscription is torn down through `disposeOnce`: the
   * TruthPort contract does not require an idempotent dispose, and a host's
   * `onDegraded` callback may synchronously call `engine.stop()` — without
   * the guard that re-enters the same dispose a second time. */
  function start(): void {
    let active = true
    let disposed = false
    // "dispose requested" and "dispose implementation available" are split:
    // a port may fire onDead synchronously DURING the changes() call, before
    // its dispose function even exists — the request is recorded via
    // `disposed` and the implementation is invoked right after the
    // subscription call returns it (see below). Declared-then-assigned (not
    // `const`) precisely so that a during-subscription disposeOnce() reads
    // `undefined` instead of hitting a temporal dead zone.
    let disposeImpl: (() => void) | undefined = undefined
    function disposeOnce(): void {
      if (disposed) return
      disposed = true
      disposeImpl?.()
    }
    disposeImpl = port.changes(
      (paths) => {
        if (!active) return
        enqueueInboundBatch(paths)
      },
      () => {
        if (!active) return
        active = false
        console.warn('[fs-core/sync] watcher died — reverting to open-time mirror only')
        disposeOnce()
        degrade({ kind: 'watcher-dead' })
      },
    )
    // Dispose was requested during subscription (synchronous onDead): the
    // implementation exists now — honor the request exactly once.
    if (disposed) disposeImpl()
    stopWatching = () => {
      active = false
      disposeOnce()
    }
  }

  function stop(): void {
    stopWatching()
    stopWatching = () => {}
  }

  /**
   * Outbound accounting for a human save: skips the ledger write when the
   * saved text already matches the ledger's record, and runs inside the same
   * `ledgerTurn` FIFO as inbound batches so the two can never interleave
   * (see module doc's "Echo judgement"). Errors propagate to the caller — a
   * host's onSave wrapper decides whether a ledger-write failure should be
   * swallowed (best-effort accounting must never unwind a save that already
   * landed at the truth source).
   *
   * `content` may be the decoded text (string, unchanged legacy path) or the
   * raw saved bytes (`Uint8Array`) — passing raw bytes lets this function
   * sniff for binary (see module doc's "Binary layering" section) before
   * deciding whether to decode. A binary save skips the ledger write
   * entirely and only updates `binaryIndex`.
   */
  async function onHumanSave(rel: string, content: string | Uint8Array): Promise<void> {
    if (content instanceof Uint8Array && looksBinary(content)) {
      await enqueueLedgerTurn(async () => {
        await binaryIndex.put(rel, content)
      })
      return
    }
    const text = typeof content === 'string' ? content : decoder.decode(content)
    await enqueueLedgerTurn(async () => {
      const unchanged = await client
        .read(rel)
        .then((r) => r.content === text)
        .catch(() => false)
      if (!unchanged) await client.write(rel, text, { actor: 'human' })
    })
  }

  return {
    populateLedger: seedFromDisk,
    onHumanSave,
    start,
    stop,
  }
}
