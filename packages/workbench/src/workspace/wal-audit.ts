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
 * Known limitation: `agentWrite`/`agentRm`/`rollback` write disk through the
 * `/__fs` bridge but do not push the new content back into the editor's memfs
 * mirror (devtools has no disk watcher for the turn-door path), so an
 * already-open editor buffer can keep showing pre-agent content until the
 * project is reopened.
 */
import { ProjectFsClient } from '@dimina-kit/fs-core/client'
import { createSyncEngine } from '@dimina-kit/fs-core/sync'
import type { SyncEngine, TruthPort } from '@dimina-kit/fs-core/sync'
import { bridgeReaddir, bridgeRead, bridgeWrite, bridgeDelete, relFromWorkspaceUri } from '../fs-bridge'
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

/** The `/__fs` bridge calls this module needs — defaults to the real bridge
 * (file-workspace.ts); injectable for tests. Also the raw material the
 * devtools `TruthPort` below is assembled from. */
export interface WalAuditBridge {
  readdir(baseUrl: string, rel: string): Promise<Array<[string, number]>>
  read(baseUrl: string, rel: string): Promise<Uint8Array>
  write(baseUrl: string, rel: string, content: Uint8Array): Promise<void>
  delete(baseUrl: string, rel: string): Promise<void>
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

/**
 * Default `watchEvents`: an `EventSource` against the main process's
 * `/__fs/watch` SSE stream (see workbench-coi-server.ts). Degrades to a no-op
 * subscription when `EventSource` is not global (e.g. a non-browser test
 * runner) rather than throwing out of the sync engine's `start()`.
 */
function defaultWatchEvents(
  fsBaseUrl: string,
): (onBatch: (paths: string[]) => void, onDead: () => void) => () => void {
  return (onBatch, onDead) => {
    if (typeof EventSource === 'undefined') return () => {}
    const es = new EventSource(`${fsBaseUrl}__fs/watch`)
    // Throttle for the reconnect reconcile below: a flapping stream (server
    // restart loop, EventSource auto-retry storm) must not queue a full-tree
    // reconcile per attempt — '.' expands to an O(project) walk + ledger
    // union, so one pass per window is plenty (the pass itself reconciles
    // everything that happened in between).
    const FULL_RECONCILE_MIN_INTERVAL_MS = 5000
    let lastFullReconcileAt = 0
    es.onopen = () => {
      // (Re)connected. Anything the watcher reported while the stream was
      // down is gone for good (SSE here has no replay) — reconcile the whole
      // tree instead: the watch-batch expansion turns '.' into a names-only
      // disk walk unioned with the ledger's paths, so both missed creations
      // and missed deletions land. On the FIRST open this is a harmless
      // no-op reconcile of the just-seeded tree. Observed need: a 200-file
      // external burst dropping the stream right before an rm -rf left the
      // editor holding the whole deleted tree.
      const now = Date.now()
      if (now - lastFullReconcileAt < FULL_RECONCILE_MIN_INTERVAL_MS) return
      lastFullReconcileAt = now
      onBatch(['.'])
    }
    es.onmessage = (ev) => {
      let msg: { paths?: string[]; watcherDead?: boolean }
      try {
        msg = JSON.parse(ev.data) as { paths?: string[]; watcherDead?: boolean }
      } catch {
        return
      }
      if (msg.watcherDead) {
        onDead()
        return
      }
      if (Array.isArray(msg.paths) && msg.paths.length > 0) onBatch(msg.paths)
    }
    es.onerror = () => {
      // A transient drop leaves readyState at CONNECTING and EventSource
      // auto-retries — do NOT kill the channel for that; the onopen
      // reconcile above heals whatever the gap swallowed. Only a
      // permanently CLOSED stream (non-2xx / non-event-stream response,
      // e.g. 409 ENOACTIVE, per the EventSource spec) is dead.
      if (es.readyState === EventSource.CLOSED) onDead()
    }
    return () => es.close()
  }
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

const defaultBridge: WalAuditBridge = {
  readdir: bridgeReaddir,
  read: bridgeRead,
  write: bridgeWrite,
  delete: bridgeDelete,
}

/** Walk the live project tree (or the subtree at `startRel`) over the `/__fs`
 * bridge and hand every file to `onFile` — the concrete implementation behind
 * devtools' `TruthPort.walk` and the watch-batch directory expansion. */
async function walkDisk(
  bridge: WalAuditBridge,
  fsBaseUrl: string,
  onFile: (rel: string, content: Uint8Array) => Promise<void>,
  startRel = '',
): Promise<void> {
  async function walk(rel: string): Promise<void> {
    const entries = await bridge.readdir(fsBaseUrl, rel || '.')
    for (const [name, type] of entries) {
      const childRel = rel ? `${rel}/${name}` : name
      if (type === 2) await walk(childRel)
      else await onFile(childRel, await bridge.read(fsBaseUrl, childRel))
    }
  }
  await walk(startRel)
}

/** Union of every path a turn's diff touched — `from`/`to` both count (a move affects both sides). */
function diffPaths(changes: Array<{ path?: string; from?: string; to?: string }>): string[] {
  const paths = new Set<string>()
  for (const c of changes) {
    if (c.path) paths.add(c.path)
    if (c.from) paths.add(c.from)
    if (c.to) paths.add(c.to)
  }
  return [...paths]
}

export function walAuditSource(base: WorkspaceSource, opts: WalAuditOptions): WorkspaceSource & { audit: WalAuditSurface } {
  const projectId = opts.projectId ?? DEFAULT_PROJECT_ID
  const bridge = opts.bridge ?? defaultBridge
  const createClient = opts.createClient ?? defaultCreateClient
  const encoder = new TextEncoder()

  let client: WalAuditClientLike | undefined
  let engine: SyncEngine | undefined

  /** FSEvents-style recursive watchers COALESCE a write burst into ancestor-
   * DIRECTORY events (and an overflow surfaces as a null filename, which the
   * SSE server reports as '.') — so a watched path is not necessarily a file.
   * Observed: a 200-file external burst delivered only 132 per-file events;
   * the rest arrived as their parent directory. Expand every directory-ish
   * path into "everything that may have changed under it": the union of the
   * files actually on disk under it (creations/modifications, via walk) and
   * the ledger paths recorded under it (deletions — a coalesced `rm -rf`
   * never names the files it removed). The engine content-compares every
   * reported path, so over-reporting is a no-op; UNDER-reporting is what
   * loses data. EVERY path gets the readdir probe — even ledger-known files,
   * which may have been replaced by a same-named directory (see
   * expandWatchPath); burst-coalescing keeps that probe per merged pass. */
  /** List file paths (names only — NO content reads) under `startRel` via
   * bridge readdir recursion. `walkDisk` is unusable for listing: its
   * `onFile` contract fetches every file's bytes, which under a 200-file
   * burst turned each expansion pass into 200 content downloads. */
  async function listDiskNames(startRel: string, out: Set<string>): Promise<void> {
    async function walk(rel: string): Promise<void> {
      const entries = await bridge.readdir(opts.fsBaseUrl, rel || '.')
      for (const [name, type] of entries) {
        const childRel = rel ? `${rel}/${name}` : name
        if (type === 2) await walk(childRel)
        else out.add(childRel)
      }
    }
    await walk(startRel)
  }

  /** Expand ONE watch path into `out`. Every path gets the readdir probe —
   * including ones the ledger knows as files: a file can have been REPLACED
   * by a same-named directory, and skipping the probe for "known files"
   * would silently drop that directory's whole subtree (the watcher only
   * names the parent). A probe on a plain file is one failing local readdir
   * — cheap, and burst-coalescing means it is paid per merged pass, not per
   * event. The path ITSELF is reported in both cases: unlistable → the
   * engine's read decides (new file / deletion); listable (a directory) →
   * the ledger may still hold a same-named FILE record from before the
   * replacement, retired via the bridge's EISDIR→404. Ledger paths under the
   * prefix cover coalesced deletions (a directory event for an `rm -rf`'d
   * tree); for a plain file the prefix matches nothing, and '.' (overflow
   * rescan) unions the whole ledger. */
  async function expandWatchPath(p: string, ledgerPaths: string[], out: Set<string>): Promise<void> {
    const rel = p === '.' ? '' : p
    try {
      await listDiskNames(rel, out)
    } catch {
      // Not a directory (plain new file), or a deleted path — either way the
      // path itself is reported below and the engine's read decides. A tree
      // mutating mid-walk also lands here: paths collected so far still count.
    }
    if (p !== '.') out.add(p)
    const prefix = rel ? `${rel}/` : ''
    for (const q of ledgerPaths) {
      if (prefix === '' || q.startsWith(prefix)) out.add(q)
    }
  }

  async function expandWatchBatch(paths: string[]): Promise<string[]> {
    const ledgerPaths = await (client
      ? client.ls().then((r) => r.paths).catch(() => [] as string[]) // unavailable — disk-side expansion still applies
      : Promise.resolve([] as string[]))
    const out = new Set<string>()
    for (const p of paths) await expandWatchPath(p, ledgerPaths, out)
    return [...out]
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
      const c = await createClient({ projectId })
      const eng = createSyncEngine(c, makeTruthPort(), { applyToEditor: opts.applyToEditor })
      await eng.populateLedger()
      client = c
      engine = eng
      eng.start()
    } catch (e) {
      client = undefined
      engine = undefined
      console.warn('[workbench] wal audit unavailable — falling back to disk-only', e)
    }
  }

  async function replayPath(rel: string): Promise<void> {
    // client is checked non-null by every caller of this helper before the loop starts.
    try {
      const { content } = await client!.read(rel)
      await bridge.write(opts.fsBaseUrl, rel, encoder.encode(content))
    } catch (e) {
      // ONLY fs-core's 'not-found' rejection (fs-core.worker.js opRead → rpcErr
      // code 'not-found', surfaced on the client Error as `.code`) means "this
      // path was deleted by the rollback" → mirror the deletion to disk. Any
      // other failure (worker crash, timeout) is transient and must abort the
      // rollback instead — disk is the source of truth, and deleting a real
      // file on a transient read error would destroy it.
      if ((e as { code?: string } | null)?.code !== 'not-found') throw e
      await bridge.delete(opts.fsBaseUrl, rel)
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
      try {
        await bridge.write(opts.fsBaseUrl, rel, encoder.encode(content))
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
