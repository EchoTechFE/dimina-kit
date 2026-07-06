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
 * The OPFS ledger is reseeded from disk on every `populate()` (a devtools
 * project open is a one-shot mirror with no disk watcher, so the ledger
 * mirrors that same one-shot semantics — mid-session external edits, e.g. a
 * `git checkout`, are not tracked in v1). The ledger persists across sessions
 * under a fixed projectId, so reseeding also reconciles: ledger paths absent
 * from the current disk tree (residue from a previously opened project) are
 * removed, leaving the ledger's current state exactly equal to the disk tree.
 * OPFS/worker init failures degrade to plain base behavior: `populate`/`onSave`
 * keep working, and every `audit` method rejects with 'wal audit unavailable'.
 *
 * Known limitation: `agentWrite`/`agentRm`/`rollback` write disk through the
 * `/__fs` bridge but do not push the new content back into the editor's memfs
 * mirror (devtools has no disk watcher), so an already-open editor buffer can
 * keep showing pre-agent content until the project is reopened.
 */
import { ProjectFsClient } from '@dimina-kit/fs-core/client'
import { bridgeReaddir, bridgeRead, bridgeWrite, bridgeDelete, relFromWorkspaceUri } from '../fs-bridge'
import type { WorkspaceSource } from './types'
import type { IFileService } from '@codingame/monaco-vscode-api'
// Type-only import — erased at build time, so it does not pull the real
// monaco-vscode-api runtime (and its CSS assets) into this module, unlike a
// value import from file-workspace.ts would.
import type { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'

/** The slice of `ProjectFsClient`'s surface the audit decorator calls. Kept
 * narrow (vs. importing the whole class as a type) so a test double only has
 * to implement what this module actually uses. */
export interface WalAuditClientLike {
  write(path: string, content: string, opts?: Record<string, unknown>): Promise<unknown>
  rm(path: string, opts?: Record<string, unknown>): Promise<unknown>
  restore(cpId: string, opts?: Record<string, unknown>): Promise<unknown>
  turnBegin(turnId: string, opts?: Record<string, unknown>): Promise<unknown>
  turnEnd(turnId: string): Promise<unknown>
  diff(turnId?: string): Promise<{ changes: Array<{ path?: string; from?: string; to?: string; op?: string }>; cpId?: string }>
  read(path: string): Promise<{ content: string; rev?: number }>
  ls(): Promise<{ paths: string[] }>
  // Typed from the worker's ACTUAL opStatus payload (fs-core.worker.js), which
  // has per-stage gens (walGen/memGen/appendedGen/…) and NO plain `gen` —
  // client.d.ts's `gen` field is a doc bug in the frozen TCB port, tracked for
  // an upstream (dimina-web-client) fix. Only the subset this module relies on
  // is declared; the real client returns a richer object.
  status(): Promise<{ mode: string; walGen: number; epoch: number }>
  destroy(): void
}

/** The `/__fs` bridge calls this module needs — defaults to the real bridge
 * (file-workspace.ts); injectable for tests. */
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

/** Walk the live project tree over the `/__fs` bridge and hand every file to `onFile`. */
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
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()

  let client: WalAuditClientLike | undefined

  async function seedFromDisk(c: WalAuditClientLike): Promise<void> {
    const seen = new Set<string>()
    await walkDisk(bridge, opts.fsBaseUrl, async (rel, bytes) => {
      seen.add(rel)
      await c.write(rel, decoder.decode(bytes), { actor: 'human' })
    })
    // Reconcile: the OPFS ledger outlives the session under a fixed projectId,
    // so a previously opened project's files may still be in it. Anything the
    // current disk walk did not produce is residue — remove it so the ledger's
    // current state matches the disk tree exactly.
    const { paths } = await c.ls()
    for (const p of paths) {
      if (!seen.has(p)) await c.rm(p, { actor: 'human' })
    }
  }

  async function initLedger(): Promise<void> {
    try {
      client?.destroy()
      client = undefined
      const c = await createClient({ projectId })
      await seedFromDisk(c)
      client = c
    } catch (e) {
      client = undefined
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
          if (!client) return
          try {
            const rel = relFromWorkspaceUri(uri)
            if (rel !== null) await client.write(rel, decoder.decode(content), { actor: 'human' })
          } catch (e) {
            console.warn('[workbench] wal ledger write failed (save already landed on disk)', e)
          }
        }
      : undefined,
    audit,
  }
}
