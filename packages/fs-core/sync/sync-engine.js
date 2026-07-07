/**
 * Sync arbitration engine — the memfs<->disk synchronization core factored
 * out of dimina-kit's workbench `wal-audit.ts` (see
 * devtools-fs-core-feasibility.md §7+§8). A host wires a `client` (the
 * fs-core ledger: write/rm/read/ls) and a `TruthPort` (its external truth
 * source — devtools' `/__fs` bridge + SSE watch, or a future FSA
 * local-directory adapter) and gets back an engine that keeps the ledger,
 * the external truth, and — via `applyToEditor` — the live editor buffer
 * reconciled. `kernel` and turn enforcement never enter this module: a
 * host's own audit-turn surface talks to `client` directly for that (see
 * wal-audit.ts).
 *
 * Echo judgement (both directions):
 *  - Outbound (`onHumanSave`): before recording, compare the saved text
 *    against the ledger's current record for that path — identical content
 *    is a no-op (the ledger already reflects it), skipping a redundant
 *    write.
 *  - Inbound (`changes` batches, via `handleInboundPath`): first check
 *    `pendingWrite` — an entry there was registered by an `onHumanSave` still
 *    in flight for the same path, and its presence means this inbound
 *    notification is that write's own echo, absorbed with no ledger write
 *    and no editor refresh. This check is a structural no-op for a 'push'
 *    port (devtools' SSE): registration and clearing both happen inside the
 *    SAME `ledgerTurn` FIFO slot as the write they guard (see
 *    `onHumanSave`), so by the time any later-queued inbound turn for that
 *    path runs, the entry is already gone — the branch exists for a future
 *    'poll' host whose change detection runs OUTSIDE this FIFO (e.g. an
 *    mtime/size sweep) and can therefore observe the entry while the write
 *    is still in flight. When `pendingWrite` misses, the engine falls back
 *    to today's content comparison (truth-source bytes vs. the ledger's own
 *    record) — the only judgement a push host ever actually exercises.
 *
 * Inbound-echo consumption (`consumeInboundEcho`, `inboundApplied`): a 'poll'
 * host (e.g. the web local-directory adapter) drives its OWN outbound path
 * OUTSIDE this module — it reads the ledger and writes the truth source
 * directly, not through `onHumanSave` — so a change this engine just applied
 * INBOUND (disk -> ledger, via `handleInboundPath`) can race that host's
 * outbound scan and get echoed straight back to disk before the poll
 * baseline ever settles. `inboundApplied` (`rel -> {kind:'text'|'binary'|
 * 'delete', ...}`) records exactly what `handleInboundPath` just applied,
 * overwriting any prior entry for the same path; `consumeInboundEcho(rel,
 * content)` lets such a host check "is this outbound write about to re-emit
 * an inbound change I haven't published yet?" immediately BEFORE writing to
 * the truth source, consuming (clearing) the record on a match so it is a
 * one-shot suppression, not a standing content cache. A miss (different
 * content, or no record at all) returns false and leaves any existing record
 * untouched — it is not this call's echo to consume.
 *
 * Binary layering (v1): the first 8192 bytes of a file are sniffed for a NUL
 * byte to classify it binary. A binary file never reaches the fs-core
 * ledger (`client.write`/`read`) — it is tracked only in the in-memory
 * `binaryIndex` (`rel -> { size, sha256 }`), and echo judgement for it is
 * size+hash equality instead of a ledger content compare. What/why this is
 * narrower than the text path: binary changes get NO WAL audit and NO
 * rollback (the audit turn surface — `diff`/`restore` — is a string-content
 * contract; v1 does not support an agent writing binary inside a turn), and
 * `binaryIndex` is session-scoped — it is cleared and rebuilt from scratch on
 * every `populateLedger()`, exactly like the ledger's own text reconciliation.
 */

const BINARY_SNIFF_BYTES = 8192

/** True when the first `BINARY_SNIFF_BYTES` of `bytes` contain a NUL byte. */
function looksBinary(bytes) {
  const len = Math.min(bytes.length, BINARY_SNIFF_BYTES)
  for (let i = 0; i < len; i++) {
    if (bytes[i] === 0) return true
  }
  return false
}

async function sha256hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Byte-for-byte equality — used by `consumeInboundEcho`'s binary-content match. */
function bytesEqual(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * True when `error` denotes "path does not exist" per the TruthPort error
 * contract (see truth-port.d.ts): `error.code === 'not-found'` or
 * `error.status === 404`. Every other rejection is "unavailable" (transient
 * I/O failure, permission loss, dead connection, ...).
 */
function isNotFoundError(error) {
  return Boolean(error) && (error.code === 'not-found' || error.status === 404)
}

export function createSyncEngine(client, port, opts = {}) {
  const decoder = new TextDecoder()
  const applyToEditor = opts.applyToEditor

  /**
   * Paths with an `onHumanSave` write in flight — see the module doc's
   * "Echo judgement" section. Registered synchronously when `onHumanSave` is
   * called and cleared unconditionally (`finally`) once that write's own
   * ledgerTurn slot finishes, success or failure.
   */
  const pendingWrite = new Set()

  /**
   * Binary files never enter the fs-core ledger — see the module doc's
   * "Binary layering" section. Session-scoped: rebuilt from scratch on every
   * `populateLedger()`.
   */
  const binaryIndex = new Map()

  /**
   * `rel -> { kind: 'text', text } | { kind: 'binary', bytes } | { kind: 'delete' }`
   * — see the module doc's "Inbound-echo consumption" section. Written by
   * `handleInboundPath` immediately after it actually applies an inbound
   * change (ledger write/rm, or a binary/delete index update); consumed
   * (checked + cleared on a match) by `consumeInboundEcho`. Session-scoped,
   * same as `binaryIndex` — cleared on every `populateLedger()`.
   */
  const inboundApplied = new Map()

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
  let ledgerTurn = Promise.resolve()
  function enqueueLedgerTurn(fn) {
    const next = ledgerTurn.then(fn, fn)
    ledgerTurn = next.catch(() => {})
    return next
  }

  /** Walk the port's tree into the ledger, then reconcile: ledger paths the
   * walk did not produce are residue (e.g. from a previous session under the
   * same persisted ledger identity) and are removed so the ledger ends up
   * exactly matching the walked tree. */
  async function seedFromDisk() {
    binaryIndex.clear()
    inboundApplied.clear()
    const seen = new Set()
    await port.walk(async (rel, bytes) => {
      seen.add(rel)
      if (looksBinary(bytes)) {
        binaryIndex.set(rel, { size: bytes.length, sha256: await sha256hex(bytes) })
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
   * Process one inbound path. `pendingWrite` is checked first (see module
   * doc); a miss falls back to content comparison: identical content is the
   * echo of our own last write and is dropped with no ledger write and no
   * `applyToEditor` call. A `port.read` rejection classified as not-found
   * (see truth-port.d.ts) is a deletion; any other rejection
   * ("unavailable") is transient and skips the path entirely — inferring a
   * deletion from it would rm the ledger record and close the file in the
   * editor while it still exists at the truth source.
   */
  async function handleInboundPath(rel) {
    if (pendingWrite.has(rel)) {
      pendingWrite.delete(rel)
      return
    }

    let bytes
    try {
      bytes = await port.read(rel)
    } catch (e) {
      if (!isNotFoundError(e)) {
        console.warn('[fs-core/sync] transient port read failure, skipping', rel, e)
        return
      }
      bytes = null
    }

    if (bytes === null) {
      // Deletion. A path the binaryIndex knows about was never in the
      // ledger (it never took the client.write path), so removal here is
      // index-only — no client.rm.
      if (binaryIndex.has(rel)) {
        binaryIndex.delete(rel)
        inboundApplied.set(rel, { kind: 'delete' })
        await applyToEditor?.(rel, null)
        return
      }
      let ledgerContent
      try {
        ledgerContent = (await client.read(rel)).content
      } catch {
        ledgerContent = undefined
      }
      if (ledgerContent === undefined) return // already absent from both sides
      await client.rm(rel, { actor: 'human' })
      inboundApplied.set(rel, { kind: 'delete' })
      await applyToEditor?.(rel, null)
      return
    }

    if (looksBinary(bytes)) {
      const prior = binaryIndex.get(rel)
      const sha256 = await sha256hex(bytes)
      if (prior && prior.size === bytes.length && prior.sha256 === sha256) return // echo: same bytes already indexed
      binaryIndex.set(rel, { size: bytes.length, sha256 })
      inboundApplied.set(rel, { kind: 'binary', bytes })
      await applyToEditor?.(rel, bytes)
      return
    }

    let ledgerContent
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
    inboundApplied.set(rel, { kind: 'text', text })
    await applyToEditor?.(rel, bytes)
  }

  /**
   * One-shot check for a 'poll' host's own outbound path: "is `content` (the
   * bytes/text about to be written to the truth source for `rel`, or `null`
   * for a delete) exactly what `handleInboundPath` just applied FROM that
   * same truth source?" A match means writing it back out would be a pure
   * echo — the host should skip the write entirely — and the record is
   * cleared (consumed) so it cannot match again. See the module doc's
   * "Inbound-echo consumption" section for why a push host (devtools) never
   * needs this: its outbound path goes through `onHumanSave`/`pendingWrite`
   * instead.
   */
  function consumeInboundEcho(rel, content) {
    const entry = inboundApplied.get(rel)
    if (!entry) return false
    let matches
    if (content === null) matches = entry.kind === 'delete'
    else if (typeof content === 'string') matches = entry.kind === 'text' && entry.text === content
    else matches = entry.kind === 'binary' && bytesEqual(entry.bytes, content)
    if (matches) inboundApplied.delete(rel)
    return matches
  }

  async function handleBatch(paths) {
    for (const rel of paths) {
      try {
        // Per-path (not per-batch) queue turns, so a long batch cannot
        // starve an interleaved onHumanSave accounting step of its FIFO
        // position.
        await enqueueLedgerTurn(() => handleInboundPath(rel))
      } catch (e) {
        console.warn('[fs-core/sync] disk sync failed for', rel, e)
      }
    }
  }

  let stopWatching = () => {}

  /** Subscribe to `port.changes`. `active` gates BOTH callbacks so a
   * late/duplicate event delivered after `onDead` (or after a fresh
   * `start()` superseded this subscription) is a guaranteed no-op, not just
   * best-effort. */
  function start() {
    let active = true
    const dispose = port.changes(
      (paths) => {
        if (!active) return
        void handleBatch(paths)
      },
      () => {
        if (!active) return
        active = false
        console.warn('[fs-core/sync] watcher died — reverting to open-time mirror only')
        dispose()
      },
    )
    stopWatching = () => {
      active = false
      dispose()
    }
  }

  function stop() {
    stopWatching()
    stopWatching = () => {}
  }

  /**
   * Outbound accounting for a human save: registers `rel` in `pendingWrite`
   * for the duration of the ledger compare-then-write (see module doc),
   * skips the ledger write when the saved text already matches the ledger's
   * record, and runs inside the same `ledgerTurn` FIFO as inbound batches so
   * the two can never interleave. Errors propagate to the caller — a host's
   * onSave wrapper decides whether a ledger-write failure should be
   * swallowed (best-effort accounting must never unwind a save that already
   * landed at the truth source).
   *
   * `content` may be the decoded text (string, unchanged legacy path) or the
   * raw saved bytes (`Uint8Array`) — passing raw bytes lets this function
   * sniff for binary (see module doc's "Binary layering" section) before
   * deciding whether to decode. A binary save skips the ledger write
   * entirely and only updates `binaryIndex`.
   */
  async function onHumanSave(rel, content) {
    pendingWrite.add(rel)
    try {
      if (content instanceof Uint8Array && looksBinary(content)) {
        await enqueueLedgerTurn(async () => {
          binaryIndex.set(rel, { size: content.length, sha256: await sha256hex(content) })
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
    } finally {
      pendingWrite.delete(rel)
    }
  }

  return {
    populateLedger: seedFromDisk,
    onHumanSave,
    consumeInboundEcho,
    start,
    stop,
  }
}
