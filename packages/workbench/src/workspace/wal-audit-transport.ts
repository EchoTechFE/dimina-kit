/**
 * Transport layer for wal-audit.ts: the `/__fs` bridge surface, the SSE
 * `watchEvents` channel, the bridge tree walk, and the diff-path union —
 * every free function here is closure-free (no walAuditSource state), split
 * out so the orchestration module stays within the repo file-length gate.
 */
import { bridgeReaddir, bridgeRead, bridgeWrite, bridgeDelete } from '../fs-bridge'
import type { FsEntry } from '../fs-bridge'
export type { FsEntry } from '../fs-bridge'

/** The `/__fs` bridge calls this module needs — defaults to the real bridge
 * (file-workspace.ts); injectable for tests. Also the raw material the
 * devtools `TruthPort` below is assembled from. `readdir`'s `FsEntry` carries
 * `size`/`mtimeMs` for FILE entries (see fs-bridge.ts) — the stat-diffing of
 * `@dimina-kit/fs-core/sync/watch-expander` is the reason this bridge
 * exposes stat at all. */
export interface WalAuditBridge {
  readdir(baseUrl: string, rel: string): Promise<FsEntry[]>
  read(baseUrl: string, rel: string): Promise<Uint8Array>
  write(baseUrl: string, rel: string, content: Uint8Array): Promise<void>
  delete(baseUrl: string, rel: string): Promise<void>
}

/**
 * Default `watchEvents`: an `EventSource` against the main process's
 * `/__fs/watch` SSE stream (see workbench-coi-server.ts). Degrades to a no-op
 * subscription when `EventSource` is not global (e.g. a non-browser test
 * runner) rather than throwing out of the sync engine's `start()`.
 */
export function defaultWatchEvents(
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

export const defaultBridge: WalAuditBridge = {
  readdir: bridgeReaddir,
  read: bridgeRead,
  write: bridgeWrite,
  delete: bridgeDelete,
}

/** Walk the live project tree (or the subtree at `startRel`) over the `/__fs`
 * bridge and hand every file to `onFile` — the concrete implementation behind
 * devtools' `TruthPort.walk` and the watch-batch directory expansion. */
export async function walkDisk(
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
export function diffPaths(changes: Array<{ path?: string; from?: string; to?: string }>): string[] {
  const paths = new Set<string>()
  for (const c of changes) {
    if (c.path) paths.add(c.path)
    if (c.from) paths.add(c.from)
    if (c.to) paths.add(c.to)
  }
  return [...paths]
}
