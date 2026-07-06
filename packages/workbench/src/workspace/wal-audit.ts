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
    // A non-2xx / non-event-stream response (e.g. 409 ENOACTIVE) fails the
    // connection permanently per the EventSource spec (no auto-retry); a
    // dropped live stream fires the same event, so both funnel into onDead.
    es.onerror = () => onDead()
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

/** Walk the live project tree over the `/__fs` bridge and hand every file to
 * `onFile` — the concrete implementation behind devtools' `TruthPort.walk`. */
async function walkDisk(
  bridge: WalAuditBridge,
  fsBaseUrl: string,
  onFile: (rel: string, content: Uint8Array) => Promise<void>,
): Promise<void> {
  async function walk(rel: string): Promise<void> {
    const entries = await bridge.readdir(fsBaseUrl, rel || '.')
    for (const [name, type] of entries) {
      const childRel = rel ? `${rel}/${name}` : name
      if (type === 2) await walk(childRel)
      else await onFile(childRel, await bridge.read(fsBaseUrl, childRel))
    }
  }
  await walk('')
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

  /** Devtools' `TruthPort`: reads/writes/deletes/walks over the `/__fs`
   * bridge, change notifications over `watchEvents` (default: the `/__fs/watch`
   * SSE stream) — a 'push' port. */
  function makeTruthPort(): TruthPort {
    return {
      capabilities: { watch: 'push' },
      read: (rel) => bridge.read(opts.fsBaseUrl, rel),
      write: (rel, bytes) => bridge.write(opts.fsBaseUrl, rel, bytes),
      delete: (rel) => bridge.delete(opts.fsBaseUrl, rel),
      walk: (onFile) => walkDisk(bridge, opts.fsBaseUrl, onFile),
      changes: (onBatch, onDead) => (opts.watchEvents ?? defaultWatchEvents(opts.fsBaseUrl))(onBatch, onDead),
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
      // WAL first: fs-core's turn enforcement decides before anything touches disk.
      // A rejection here (e.g. turn-closed) must propagate — the bridge write below
      // must never run for a write the ledger refused.
      await client.write(rel, content, { actor: 'agent', turnId })
      await bridge.write(opts.fsBaseUrl, rel, encoder.encode(content))
    },
    async agentRm(rel, turnId) {
      if (!client) return UNAVAILABLE()
      await client.rm(rel, { actor: 'agent', turnId })
      await bridge.delete(opts.fsBaseUrl, rel)
    },
    diff: (turnId) => (client ? client.diff(turnId) : UNAVAILABLE()),
    async rollback(turnId) {
      if (!client) return UNAVAILABLE()
      const { cpId, changes } = await client.diff(turnId)
      if (!cpId) throw new Error(`no checkpoint anchor recorded for turn ${turnId}`)
      await client.restore(cpId)
      for (const rel of diffPaths(changes)) await replayPath(rel)
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
