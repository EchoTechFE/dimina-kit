/**
 * `GET /__fs/watch`: SSE stream of the active project root's disk changes, for
 * the editor's memfs↔disk sync engine (devtools-fs-core-feasibility.md §7).
 * Read-only — it adds no write surface, which is why workbench-coi-server.ts
 * dispatches it before (and outside) the mutating-action guard of the generic
 * `/__fs/*` handler. Split into its own module purely to keep each file within
 * the repo size gate; the COI server is its only consumer.
 *
 * One `fs.watch(root, {recursive:true})` per connection (darwin supports
 * `recursive`), changes batched over an 80ms window and pushed as
 * `data: {"paths":["rel", ...]}` with POSIX-separated root-relative paths.
 * `getProjectRoot` (not a resolved string) is threaded through so a project
 * close/switch mid-stream is detected by re-polling the SAME source
 * `handleFsRequest` uses — no separate close event is invented. Watcher errors
 * (e.g. EMFILE) push `data: {"watcherDead":true}` then end the stream; no
 * active project at connect time is a 409, matching the ENOACTIVE semantics of
 * every other `/__fs` action.
 */
import type http from 'node:http'
import nodeFs from 'node:fs'
import path from 'node:path'
import { SKIP_DIRS } from '../ipc/project-fs.js'
import { jsonRes } from './http-json.js'

/** Debounce window for batching change notifications (ms). */
const WATCH_DEBOUNCE_MS = 80

/** `false` for build/vcs/dependency churn, the empty string, and any path that
 * (defensively — `fs.watch`'s filename is always root-relative) escapes the root.
 * Matches SKIP_DIRS as a path SEGMENT at any depth — the same set `/__fs/readdir`
 * omits, so the watcher never reports paths the editor mirror cannot see (a
 * prefix match would let `packages/x/node_modules/...` through). The one
 * accepted edge: a plain FILE named exactly like a skip dir (e.g. `dist`)
 * is also unreported, though readdir would list it. */
function shouldReportWatchPath(rel: string): boolean {
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false
  return !rel.split('/').some((segment) => SKIP_DIRS.has(segment))
}

export const __testing = { shouldReportWatchPath }

export function handleFsWatchRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  getProjectRoot: () => string,
): void {
  const watchedRoot = getProjectRoot()
  if (!watchedRoot) {
    jsonRes(res, 409, { error: 'No active project', code: 'ENOACTIVE' })
    return
  }

  let watcher: nodeFs.FSWatcher
  try {
    watcher = nodeFs.watch(watchedRoot, { recursive: true }, onChange)
  } catch (e) {
    jsonRes(res, 500, { error: String(e) })
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  })

  let pending = new Set<string>()
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let liveCheck: ReturnType<typeof setInterval> | null = null
  let closed = false

  function cleanup(): void {
    if (closed) return
    closed = true
    if (debounceTimer) clearTimeout(debounceTimer)
    if (liveCheck) clearInterval(liveCheck)
    watcher.close()
  }

  function flush(): void {
    if (closed || pending.size === 0) return
    const paths = [...pending]
    pending = new Set<string>()
    res.write(`data: ${JSON.stringify({ paths })}\n\n`)
  }

  function onChange(_event: string, filename: string | Buffer | null): void {
    if (!filename) return
    const rel = filename.toString().split(path.sep).join('/')
    if (!shouldReportWatchPath(rel)) return
    pending.add(rel)
    if (!debounceTimer) {
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        flush()
      }, WATCH_DEBOUNCE_MS)
    }
  }

  watcher.on('error', () => {
    if (closed) return
    res.write(`data: ${JSON.stringify({ watcherDead: true })}\n\n`)
    cleanup()
    res.end()
  })

  // The active project root has no dedicated close/switch event to subscribe
  // to; poll the same getter `handleFsRequest` uses, on the debounce cadence,
  // so a closed or switched project tears this stream down promptly.
  liveCheck = setInterval(() => {
    if (closed) return
    if (getProjectRoot() !== watchedRoot) {
      cleanup()
      res.end()
    }
  }, WATCH_DEBOUNCE_MS)

  req.on('close', cleanup)
}
