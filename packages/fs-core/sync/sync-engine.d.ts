/**
 * Type declaration for sync-engine.js (kept as plain JS at runtime, matching
 * this package's existing src/*.js + *.d.ts pairing).
 */
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

export interface SyncEngineOptions {
  /**
   * Host seam: push an inbound change into the live editor buffer.
   * `bytes === null` means the path was deleted. Omitted — the ledger still
   * records the change but the editor buffer is left untouched.
   */
  applyToEditor?: (rel: string, bytes: Uint8Array | null) => Promise<void>
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
   */
  onHumanSave(rel: string, text: string): Promise<void>
  /** Subscribe to `port.changes` and start reconciling inbound batches. */
  start(): void
  /** Tear down the `port.changes` subscription. Idempotent. */
  stop(): void
}

/**
 * Build a sync engine that reconciles a fs-core ledger (`client`), an
 * external truth source (`port`), and — via `opts.applyToEditor` — a live
 * editor buffer. See sync-engine.js's header for the full echo-judgement
 * design (outbound content comparison, inbound pendingWrite + content
 * comparison fallback).
 */
export declare function createSyncEngine(
  client: SyncClientLike,
  port: TruthPort,
  opts?: SyncEngineOptions,
): SyncEngine
