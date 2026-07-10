/**
 * WAL audit decorator: wraps a base {@link WorkspaceSource} (devtools'
 * `diskMirrorSource`) with an `@dimina-kit/fs-core` OPFS ledger, without
 * touching which side is authoritative. Disk (and git) stay the truth: a
 * human save lands on disk first and the ledger write is best-effort
 * accounting afterward (a ledger failure never blocks or unwinds the save).
 * An agent write is the mirror image — fs-core's turn enforcement runs FIRST
 * and gates whether anything reaches disk at all, so a rejected turn leaves
 * disk untouched. `kernel` never enters this package: the turn surface below
 * calls fs-core's own turnBegin/turnEnd/diff/restore directly.
 *
 * This module is a THIN ADAPTER over two pieces that now live in
 * `@dimina-kit/fs-core`:
 *  - `./sync`'s `createSyncEngine` — the memfs<->disk arbitration engine
 *    (ledgerTurn FIFO, echo judgement, seed/reconcile, inbound batches; see
 *    that module's header for the full design, devtools-fs-core-feasibility.md
 *    §7+§8). This file's only job on that front is assembling devtools' own
 *    `TruthPort`: reads/writes/deletes/walks go over the `/__fs` bridge
 *    (fs-bridge.ts), and change notifications come from an `EventSource`
 *    against the main process's `/__fs/watch` SSE stream — a 'push' port.
 *    Raw watch batches are only HINTS (macOS FSEvents coalesces bursts and
 *    drops children of a recursive delete); before reaching the engine they
 *    pass through `@dimina-kit/fs-core/sync/watch-expander`'s stat-level disk
 *    compare — see that module's header — and the engine trusts the expanded
 *    batch as-is.
 *  - the fs-core `client` directly, for the parts that are NOT the sync
 *    engine's job: the programmatic turn-door surface below
 *    (beginTurn/endTurn/agentWrite/agentRm/diff/rollback/status) calls
 *    `client.turnBegin`/`turnEnd`/`diff`/`restore` itself — this is
 *    audit/turn bookkeeping, not disk<->editor sync, and stays here per the
 *    architecture's `kernel`-free boundary (§6.4 of the feasibility doc).
 *
 * The OPFS ledger is reseeded from disk on every `populate()` (a devtools
 * project open is a one-shot mirror with no disk watcher, so the ledger
 * mirrors that same one-shot semantics — mid-session external edits, e.g. a
 * `git checkout`, are only picked up once the sync engine's watch
 * subscription observes them). The ledger persists across sessions under a
 * fixed projectId, so reseeding also reconciles: ledger paths absent from
 * the current disk tree (residue from a previously opened project) are
 * removed, leaving the ledger's current state exactly equal to the disk tree.
 * OPFS/worker init failures degrade to plain base behavior: `populate`/`onSave`
 * keep working, and every `audit` method rejects with 'wal audit unavailable'.
 *
 * Editor propagation for the turn-door: `agentWrite`/`agentRm`/`rollback`
 * write disk through the `/__fs` bridge (devtools has no disk watcher for
 * that path), then push the new content into the live editor buffer through
 * the SAME `applyToEditor` seam the sync engine's inbound path uses —
 * best-effort: disk and ledger are already consistent by then, so an editor
 * refresh failure only logs (the buffer converges on the next reconcile or
 * reopen) and never fails the agent operation itself.
 */
import { ProjectFsClient } from '@dimina-kit/fs-core/client'
import { createSyncEngine } from '@dimina-kit/fs-core/sync'
import type { SyncEngine, TruthPort } from '@dimina-kit/fs-core/sync'
import { createWatchExpander } from '@dimina-kit/fs-core/sync/watch-expander'
import { relFromWorkspaceUri } from '../fs-bridge'
import { defaultBridge, defaultWatchEvents, walkDisk, diffPaths } from './wal-audit-transport'
import type { WalAuditBridge } from './wal-audit-transport'
export type { WalAuditBridge } from './wal-audit-transport'
import type { WorkspaceSource } from './types'
import type { IFileService } from '@codingame/monaco-vscode-api'
// Type-only import — erased at build time, so it does not pull the real
// monaco-vscode-api runtime (and its CSS assets) into this module, unlike a
// value import from file-workspace.ts would.
import type { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'

/** The slice of `ProjectFsClient`'s surface the audit decorator calls. Kept
 * narrow (vs. importing the whole class as a type) so a test double only has
 * to implement what this module actually uses. Structurally a superset of
 * fs-core sync's `SyncClientLike` (write/rm/read/ls), so the same connected
 * client can be handed to both `createSyncEngine` and the turn-door surface
 * below. */
export interface WalAuditClientLike {
  write(path: string, content: string, opts?: Record<string, unknown>): Promise<unknown>
  rm(path: string, opts?: Record<string, unknown>): Promise<unknown>
  restore(cpId: string, opts?: Record<string, unknown>): Promise<unknown>
  turnBegin(turnId: string, opts?: Record<string, unknown>): Promise<unknown>
  turnEnd(turnId: string): Promise<unknown>
  diff(turnId?: string): Promise<{ changes: Array<{ path?: string; from?: string; to?: string; op?: string }>; cpId?: string }>
  read(path: string): Promise<{ content: string; rev?: number }>
  ls(): Promise<{ paths: string[] }>
  // client.d.ts's status() now mirrors the worker's real opStatus payload
  // (fs-core.worker.js) — per-stage gens (walGen/memGen/appendedGen/…), no
  // plain `gen`. This is a deliberately narrowed subset: only the fields this
  // module actually reads are declared here; the real client returns the
  // richer object typed in client.d.ts.
  status(): Promise<{ mode: string; walGen: number; epoch: number }>
  destroy(): void
}

/** Predetermined 'wal audit unavailable' surface — thrown when OPFS/worker init failed. */
const UNAVAILABLE = () => Promise.reject(new Error('wal audit unavailable'))

/** Programmatic turn-door surface for a future agent host: begin/end a turn,
 * write/rm inside it (fs-core turn enforcement gates disk), and inspect/undo
 * a turn's changes. Every method rejects with 'wal audit unavailable' when
 * the OPFS ledger never initialized. */
export interface WalAuditSurface {
  beginTurn(turnId: string): Promise<unknown>
  endTurn(turnId: string): Promise<unknown>
  agentWrite(rel: string, content: string, turnId: string): Promise<void>
  agentRm(rel: string, turnId: string): Promise<void>
  diff(turnId: string): Promise<unknown>
  rollback(turnId: string): Promise<void>
  /** Read-only ledger status (mode/walGen/epoch) — lets a host observe the WAL
   * advancing (e.g. after a human save) without needing turn-door access. */
  status(): Promise<{ mode: string; walGen: number; epoch: number }>
}

export interface WalAuditOptions {
  /** Base URL of the COI server exposing `/__fs/*` (same value passed to `diskMirrorSource`). */
  fsBaseUrl: string
  /** fs-core OPFS project namespace. A constant is correct here: the ledger is
   * fully reseeded every populate(), so it needs no identity stable across the
   * different real projects a devtools session may open over time. */
  projectId?: string
  /** Test/host seam: construct the fs-core client. Defaults to a real `ProjectFsClient.connect`
   * wired to the bundled fs-core worker scripts. */
  createClient?: (opts: { projectId: string }) => Promise<WalAuditClientLike>
  /** Test/host seam: the `/__fs` bridge calls. Defaults to file-workspace.ts's bridge. */
  bridge?: WalAuditBridge
  /**
   * Test/host seam: subscribe to inbound disk-change batches. Called once the
   * ledger is up; returns an unsubscribe function. Defaults to an
   * `EventSource` against `${fsBaseUrl}__fs/watch` (see {@link defaultWatchEvents}).
   */
  watchEvents?: (onBatch: (paths: string[]) => void, onDead: () => void) => () => void
  /**
   * Host seam: push an inbound disk change into the live editor buffer.
   * `content === null` means the path was deleted. Omitted → the ledger still
   * records the change but the editor's memfs is left untouched (matching
   * today's open-time-only mirror for the visible buffer). Never touches
   * monaco/vscode from THIS module — the host implements it.
   */
  applyToEditor?: (rel: string, content: Uint8Array | null) => Promise<void>
}

const DEFAULT_PROJECT_ID = 'devtools-workspace'

/**
 * The worker-URL resolution lives in its own module (fs-core-worker-urls.ts)
 * reached only through this lazy `import()` — see that file's header for why:
 * the `?worker&url` specifiers must stay STATIC imports there for the build
 * to split them into discrete worker chunks, while this call site stays LAZY
 * so a host that never constructs the real client (every unit test injects
 * its own `createClient`) never has to resolve them at all.
 */
async function defaultCreateClient({ projectId }: { projectId: string }): Promise<WalAuditClientLike> {
  const { coreWorkerUrl, queryWorkerUrl } = await import('./fs-core-worker-urls')
  const client = await ProjectFsClient.connect({
    projectId,
    coreUrl: new URL(coreWorkerUrl, import.meta.url).toString(),
    queryUrl: new URL(queryWorkerUrl, import.meta.url).toString(),
  })
  // client.d.ts types `diff()`'s `changes` as `unknown[]` (it mirrors fs-core's
  // untyped WAL audit records); this module only reads the `path`/`from`/`to`
  // shape fs-core's opDiff actually returns (fs-core.worker.js `opDiff`), so the
  // narrower WalAuditClientLike is a safe reinterpretation of the same runtime object.
  return client as unknown as WalAuditClientLike
}

export function walAuditSource(base: WorkspaceSource, opts: WalAuditOptions): WorkspaceSource & { audit: WalAuditSurface } {
  const projectId = opts.projectId ?? DEFAULT_PROJECT_ID
  const bridge = opts.bridge ?? defaultBridge
  const createClient = opts.createClient ?? defaultCreateClient
  const encoder = new TextEncoder()

  let client: WalAuditClientLike | undefined
  let engine: SyncEngine | undefined

  /** Turns a raw watch batch (possibly coalesced/lossy — see that module's
   * doc) into the paths worth re-examining, via a stat-level disk compare
   * against a session-scoped index instead of re-reading content. Reset on
   * every `initLedger()` (a fresh ledger needs a fresh index — see
   * {@link createWatchExpander}'s "Index lifecycle" doc). The expander's one
   * dependency is a stat-capable readdir — the `/__fs` bridge's, curried
   * with this source's base URL. */
  const watchExpander = createWatchExpander((rel) => bridge.readdir(opts.fsBaseUrl, rel))

  async function expandWatchBatch(paths: string[]): Promise<string[]> {
    const ledgerPaths = await (client
      ? client.ls().then((r) => r.paths).catch(() => [] as string[]) // unavailable — disk-side expansion still applies
      : Promise.resolve([] as string[]))
    return watchExpander.expandWatchBatch(paths, ledgerPaths)
  }

  /** Serialize + coalesce watch batches through the expansion: during a burst
   * the SSE stream delivers a batch every debounce window, and each one
   * expands to (roughly) the same directory's full listing — expanding them
   * one-by-one floods the engine's ledger FIFO with thousands of duplicate
   * no-op turns and queues a subsequent deletion burst tens of seconds out.
   * Raw paths accumulate in `pendingRaw` while one expansion is in flight;
   * each loop iteration drains EVERYTHING accumulated so far into a single
   * expansion pass, so a burst costs one pass per pass-duration, not one per
   * SSE batch. */
  let pendingRaw = new Set<string>()
  let expansionRunning = false
  function enqueueWatchPaths(paths: string[], onBatch: (paths: string[]) => void): void {
    for (const p of paths) pendingRaw.add(p)
    if (expansionRunning) return
    expansionRunning = true
    void (async () => {
      try {
        while (pendingRaw.size) {
          const raw = [...pendingRaw]
          pendingRaw = new Set<string>()
          try {
            const expanded = await expandWatchBatch(raw)
            if (expanded.length) onBatch(expanded)
          } catch (e) {
            console.warn('[workbench] watch batch expansion failed', e)
          }
        }
      } finally {
        expansionRunning = false
      }
    })()
  }

  /** Devtools' `TruthPort`: reads/writes/deletes/walks over the `/__fs`
   * bridge, change notifications over `watchEvents` (default: the `/__fs/watch`
   * SSE stream) — a 'push' port whose batches are directory-expanded first
   * (see {@link expandWatchBatch}). */
  function makeTruthPort(): TruthPort {
    return {
      capabilities: { watch: 'push' },
      read: (rel) => bridge.read(opts.fsBaseUrl, rel),
      write: (rel, bytes) => bridge.write(opts.fsBaseUrl, rel, bytes),
      delete: (rel) => bridge.delete(opts.fsBaseUrl, rel),
      walk: (onFile) => walkDisk(bridge, opts.fsBaseUrl, onFile),
      changes: (onBatch, onDead) =>
        (opts.watchEvents ?? defaultWatchEvents(opts.fsBaseUrl))(
          (paths) => enqueueWatchPaths(paths, onBatch),
          onDead,
        ),
    }
  }

  async function initLedger(): Promise<void> {
    try {
      engine?.stop()
      client?.destroy()
      client = undefined
      engine = undefined
      // A fresh ledger needs a fresh watch-expansion stat index — a path's
      // last-seen stat from a previous project/session must never suppress
      // a report against the NEW ledger's content.
      watchExpander.resetIndex()
      const c = await createClient({ projectId })
      const eng = createSyncEngine(c, makeTruthPort(), { applyToEditor: opts.applyToEditor })
      await eng.populateLedger()
      // Seed the stat index from the now-reconciled disk tree BEFORE the
      // watch subscription goes live, so the first post-open watch batch
      // only reports genuine post-seed changes instead of re-treating the
      // whole tree as "new" (see the watch-expander module's "Index
      // lifecycle" doc).
      await watchExpander.warmFromDisk()
      client = c
      engine = eng
      eng.start()
    } catch (e) {
      client = undefined
      engine = undefined
      console.warn('[workbench] wal audit unavailable — falling back to disk-only', e)
    }
  }

  /** Turn-door editor propagation (see the module doc's "Editor propagation"
   * paragraph): disk and ledger are already consistent when this runs, so a
   * refresh failure only logs — it must never fail the agent operation. */
  async function refreshEditor(rel: string, content: Uint8Array | null): Promise<void> {
    try {
      await opts.applyToEditor?.(rel, content)
    } catch (e) {
      console.warn('[workbench] turn-door editor refresh failed (disk and ledger are already consistent)', rel, e)
    }
  }

  async function replayPath(rel: string): Promise<void> {
    // client is checked non-null by every caller of this helper before the loop starts.
    try {
      const { content } = await client!.read(rel)
      const bytes = encoder.encode(content)
      await bridge.write(opts.fsBaseUrl, rel, bytes)
      await refreshEditor(rel, bytes)
      return
    } catch (e) {
      // ONLY fs-core's 'not-found' rejection (fs-core.worker.js opRead → rpcErr
      // code 'not-found', surfaced on the client Error as `.code`) means "this
      // path was deleted by the rollback" → mirror the deletion to disk. Any
      // other failure (worker crash, timeout) is transient and must abort the
      // rollback instead — disk is the source of truth, and deleting a real
      // file on a transient read error would destroy it.
      if ((e as { code?: string } | null)?.code !== 'not-found') throw e
      await bridge.delete(opts.fsBaseUrl, rel)
      await refreshEditor(rel, null)
    }
  }

  const audit: WalAuditSurface = {
    beginTurn: (turnId) => (client ? client.turnBegin(turnId) : UNAVAILABLE()),
    endTurn: (turnId) => (client ? client.turnEnd(turnId) : UNAVAILABLE()),
    async agentWrite(rel, content, turnId) {
      if (!client) return UNAVAILABLE()
      // Snapshot the prior ledger record BEFORE writing — the compensation
      // below needs it. `null` = the path did not exist in the ledger.
      const prior = await client
        .read(rel)
        .then((r) => r.content)
        .catch(() => null)
      // WAL first: fs-core's turn enforcement decides before anything touches disk.
      // A rejection here (e.g. turn-closed) must propagate — the bridge write below
      // must never run for a write the ledger refused.
      await client.write(rel, content, { actor: 'agent', turnId })
      const bytes = encoder.encode(content)
      try {
        await bridge.write(opts.fsBaseUrl, rel, bytes)
      } catch (e) {
        // Truth-source write failed (oversize 413, disk full, bridge down):
        // the ledger now records content the disk never received — left
        // uncompensated, every later diff/rollback reasons from a forked
        // ledger. Put the ledger back to its prior state INSIDE the same
        // turn (the WAL keeps an honest attempt+undo trail), then surface
        // the original failure. Compensation errors are swallowed: the
        // primary failure must win, and a still-forked path converges back
        // toward disk on the next reconcile (disk is the truth source).
        if (prior === null) await client.rm(rel, { actor: 'agent', turnId }).catch(() => {})
        else await client.write(rel, prior, { actor: 'agent', turnId }).catch(() => {})
        throw e
      }
      await refreshEditor(rel, bytes)
    },
    async agentRm(rel, turnId) {
      if (!client) return UNAVAILABLE()
      const prior = await client
        .read(rel)
        .then((r) => r.content)
        .catch(() => null)
      await client.rm(rel, { actor: 'agent', turnId })
      try {
        await bridge.delete(opts.fsBaseUrl, rel)
      } catch (e) {
        // Mirror of agentWrite's compensation: disk still has the file, so
        // the ledger must keep its record too.
        if (prior !== null) await client.write(rel, prior, { actor: 'agent', turnId }).catch(() => {})
        throw e
      }
      await refreshEditor(rel, null)
    },
    diff: (turnId) => (client ? client.diff(turnId) : UNAVAILABLE()),
    async rollback(turnId) {
      if (!client) return UNAVAILABLE()
      const { cpId, changes } = await client.diff(turnId)
      if (!cpId) throw new Error(`no checkpoint anchor recorded for turn ${turnId}`)
      await client.restore(cpId)
      // Best-effort replay: one path's bridge failure must not strand every
      // OTHER path un-replayed (that would maximize the ledger/disk fork).
      // Failures are collected and surfaced explicitly — for those paths the
      // ledger is restored while disk still holds the turn's content, and
      // the next reconcile converges the ledger back toward disk (truth
      // source wins), so the fork is bounded, visible, and self-healing.
      const failed: string[] = []
      let firstCause: unknown
      for (const rel of diffPaths(changes)) {
        try {
          await replayPath(rel)
        } catch (e) {
          failed.push(rel)
          firstCause ??= e
        }
      }
      if (failed.length) {
        throw Object.assign(
          new Error(
            `rollback replayed the ledger but disk replay failed for ${failed.length} path(s): ` +
              `${failed.join(', ')} — these stay at the turn's content on disk until the next reconcile; ` +
              `first cause: ${String(firstCause)}`,
          ),
          { failedPaths: failed, cause: firstCause },
        )
      }
    },
    status: () => (client ? client.status() : UNAVAILABLE()),
  }

  return {
    folderUri: base.folderUri,
    async populate(fileService: IFileService): Promise<number> {
      const n = await base.populate(fileService)
      await initLedger()
      return n
    },
    onSave: base.onSave
      ? async (uri: URI, content: Uint8Array) => {
          await base.onSave!(uri, content)
          // Capture the live engine: a re-populate() may swap it while this
          // save's queued ledger turn is still waiting its FIFO slot.
          const eng = engine
          if (!eng) return
          try {
            const rel = relFromWorkspaceUri(uri)
            if (rel === null) return
            // Raw bytes, not pre-decoded text: onHumanSave sniffs for binary
            // content itself (fs-core/sync's binary layering) before deciding
            // whether to decode.
            await eng.onHumanSave(rel, content)
          } catch (e) {
            console.warn('[workbench] wal ledger write failed (save already landed on disk)', e)
          }
        }
      : undefined,
    audit,
  }
}
