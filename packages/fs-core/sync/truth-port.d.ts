/**
 * TruthPort: the external-truth-source adapter the sync engine (see
 * sync-engine.d.ts) talks to. Concrete adapters live with their host: devtools'
 * is `/__fs` HTTP bridge reads/writes + an SSE change stream (workbench's
 * wal-audit.ts); a future web local-directory adapter would wrap the File
 * System Access API with poll-based change detection instead.
 *
 * Error contract for `read`/`delete`: a rejection MUST be classifiable as
 * either "not-found" (the path does not exist — safe to treat as a deletion)
 * or "unavailable" (anything else: a transient I/O failure, a permission
 * loss, a dead connection, ...). A rejection counts as not-found when either:
 *   - `error.code === 'not-found'`, or
 *   - `error.status === 404`
 * every other rejection shape is unavailable. The engine never infers a
 * deletion from an "unavailable" rejection.
 */
export interface TruthPortCapabilities {
  /**
   * How this port delivers change notifications: 'push' (an event stream —
   * devtools' SSE `/__fs/watch`) or 'poll' (no push channel; a future FSA
   * local-directory adapter would need its own polling loop outside the
   * engine). The two channels do not commit to equivalent latency/ordering
   * guarantees.
   */
  watch: 'push' | 'poll'
}

export interface TruthPort {
  readonly capabilities: TruthPortCapabilities

  /**
   * Read a path's current bytes. Rejects per the error contract above: a
   * not-found rejection means the path does not exist; any other rejection
   * is unavailable (transient) and must NOT be read as a deletion.
   */
  read(rel: string): Promise<Uint8Array>

  /** Write bytes to a path (create or overwrite). */
  write(rel: string, bytes: Uint8Array): Promise<void>

  /** Delete a path. Same not-found/unavailable error contract as {@link read}. */
  delete(rel: string): Promise<void>

  /**
   * Walk every file under the port's root, calling `onFile` once per file
   * (awaited before moving on to the next). Directories are not reported
   * individually — only the files within them.
   */
  walk(onFile: (rel: string, bytes: Uint8Array) => Promise<void>): Promise<void>

  /**
   * Subscribe to inbound change batches. `onBatch` receives a batch of
   * changed relative paths; `onDead` fires at most once when the change
   * channel is permanently gone (the host should treat this as a downgrade
   * to no live sync, not a transient hiccup — see sync-engine.d.ts's `stop`).
   * Returns a `dispose` that tears down the subscription.
   */
  changes(onBatch: (paths: string[]) => void, onDead: () => void): () => void
}
