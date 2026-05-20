/**
 * miniappSnapshot — preload-side contract.
 *
 * `miniappSnapshot` is the unified snapshot framework shared by devtools
 * panels (AppData, WXML, …). preload is the single source of truth; the
 * renderer is a pure projection of immutable full snapshots.
 *
 * This file is the CONTRACT only — it declares the interfaces every data
 * source and the host must satisfy. The host implementation lives in
 * `./host.ts`.
 *
 * See `docs/miniapp-snapshot.md` for the architecture rationale.
 */

/** Identifier of one snapshot data source, e.g. 'appdata' | 'wxml'. */
export type SnapshotSourceId = string

/**
 * The transport unit: a full snapshot plus its metadata.
 *
 * - `seq` is a GLOBAL strictly-increasing integer shared across every
 *   source, so the renderer can drop stale envelopes and panels can be
 *   aligned to the same moment.
 * - `ts` is `Date.now()` at publish time.
 * - `data` is the full, immutable snapshot — the renderer replaces its
 *   state wholesale, never merges.
 */
export interface SnapshotEnvelope<T = unknown> {
  id: SnapshotSourceId
  seq: number
  ts: number
  data: T
}

/** A preload-side data source that produces full snapshots of one panel's state. */
export interface MiniappSnapshotSource<T = unknown> {
  readonly id: SnapshotSourceId
  /** Current full snapshot — the source of truth. Called fresh at each publish. */
  snapshot(): T
  /** Begin observing. `emit` must be called by the source whenever its snapshot changes. */
  start(emit: () => void): void
  /** Tear down observers. */
  dispose(): void
}

/**
 * The hub: manages every data source's lifecycle plus the push/pull
 * transport. preload registers sources, then calls `install()` once.
 */
export interface MiniappSnapshotHost {
  register<T>(source: MiniappSnapshotSource<T>): void
  /** Starts every source, publishes each initial snapshot, wires the pull channel. Returns a disposer. */
  install(): () => void
}

/**
 * Synchronous automation accessor exposed on the page global as
 * `__miniappSnapshot` by `install()`. Lets the main process / e2e / MCP read
 * any registered panel's current snapshot via `webContents.executeJavaScript`.
 */
export interface MiniappSnapshotApi {
  /** Fresh `source.snapshot()` result for `id`, or `undefined` for an unknown id. */
  get(id: SnapshotSourceId): unknown
  /** Registered source ids, in registration order. */
  ids(): SnapshotSourceId[]
}
