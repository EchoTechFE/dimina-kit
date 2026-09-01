/**
 * The `/__fs` bridge's wire shapes, declared once for the producing side.
 *
 * Every shape here is consumed by browser code in `packages/workbench`
 * (`fs-bridge.ts`'s `FsEntry`, `wal-audit-transport.ts`'s SSE message parse,
 * and through them `@dimina-kit/fs-core/sync/watch-expander`'s stat-diffing).
 * That side cannot import from here — devtools is the application, the
 * workbench is a library it embeds, and the dependency runs one way only. So
 * this module does not give the two ends a shared declaration; it gives the
 * PRODUCING end exactly one, instead of hand-building untyped payloads at each
 * call site. The two ends stay pinned to each other by the round-trip
 * assertions in workbench-coi-server.test.ts and by disk-sync.spec.ts.
 */

/**
 * The `type` field of every readdir/stat payload. These are wire values, not
 * an internal enum: the browser side compares the raw numbers (watch-expander
 * treats `2` as "recurse into it"), so renumbering them breaks the editor's
 * disk mirror.
 */
export const FS_TYPE_FILE = 1
export const FS_TYPE_DIR = 2

/**
 * One `/__fs/readdir` entry: `[name, type]` for a directory, `[name, type,
 * size, mtimeMs]` for a file. The trailing stats let the sync engine tell a
 * stat-unchanged survivor from an actually-modified file without re-reading
 * its content. A file entry that raced a concurrent delete between readdir and
 * stat has no stats to send and is TRUNCATED to `[name, 1]` rather than padded
 * with the two values: a JSON array cannot hold a hole, so passing them
 * through as `undefined` would put `null` on the wire, which neither the
 * client's `size?: number` type nor any of the comments describing this format
 * admit. Either way the client's `?? NaN` fallback treats the entry as
 * "always changed"; truncating is what keeps the wire and the types honest.
 */
export type FsBridgeEntry = [name: string, type: number, size?: number, mtimeMs?: number]

/** The `/__fs/stat` payload. Its `mtime` carries the same value readdir sends
 * as `mtimeMs` — the two endpoints named it differently and no client reads
 * this one, so the names are left as shipped rather than changed blind. */
export interface FsBridgeStat {
  type: number
  size: number
  ctime: number
  mtime: number
}

/** One `/__fs/watch` SSE message: a batch of changed project-relative paths,
 * or the terminal notice that the watcher is gone and the client must fall
 * back to a full rescan. */
export type FsWatchMessage = { paths: string[] } | { watcherDead: true }

/** Serialize one SSE message into an `event-stream` frame. */
export function fsWatchFrame(message: FsWatchMessage): string {
  return `data: ${JSON.stringify(message)}\n\n`
}

/** Project one `readdirWithin` entry onto the readdir wire shape. */
export function toFsBridgeEntry(entry: {
  name: string
  isDirectory: boolean
  size?: number
  mtimeMs?: number
}): FsBridgeEntry {
  if (entry.isDirectory) return [entry.name, FS_TYPE_DIR]
  if (entry.size === undefined || entry.mtimeMs === undefined) return [entry.name, FS_TYPE_FILE]
  return [entry.name, FS_TYPE_FILE, entry.size, entry.mtimeMs]
}
