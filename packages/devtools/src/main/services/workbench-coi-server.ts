/**
 * Cross-Origin-Isolation static server for the embedded VS Code workbench.
 *
 * The workbench needs `SharedArrayBuffer` for the TS web ext-host's
 * project-wide IntelliSense. Chromium only serves that to a document fetched
 * over http(s) carrying COOP `same-origin` + COEP `require-corp` (a custom
 * `protocol.handle` response does NOT unlock it), so the workbench bundle is
 * served from this in-process http server bound to 127.0.0.1 on a random port.
 * Every response carries the three isolation headers so same-origin
 * sub-resources and workers satisfy COEP `require-corp`.
 *
 * Kept separate from `dimina-resource-server` on purpose: that server sends
 * CORP `cross-origin` for the simulator bundles, which is incompatible with the
 * workbench's `same-origin` isolation requirement.
 *
 * `/__fs/*` bridges a `diminafs:`-style FileSystemProvider in the workbench to
 * the live active project on disk, reusing the renderer `project:fs:*`
 * sandbox's realpath-based guards (`resolveWithinProjectRoot`,
 * `assertWritableAncestor`, and the `O_NOFOLLOW` + post-open re-check inside
 * `readFileBuffer`/`writeFile`) so there is a SINGLE sandbox implementation: a
 * symlink inside the root pointing outside it cannot be followed to read or
 * write past the sandbox. The active project root is read per-request (via the
 * injected getter) so project switches take effect immediately.
 *
 * Mutating actions (write/mkdir/delete/rename) additionally require a non-GET
 * method and a same-origin (or origin-less) request, so an arbitrary localhost
 * page cannot drive a destructive `/__fs` call. GET serves only the read-only
 * stat/readdir/read actions.
 *
 * `/__fs/watch` is a read-only SSE stream of the active project's disk changes
 * (devtools-fs-core-feasibility.md §7), decoupled from the compile session so
 * the editor's memfs↔disk sync engine has a source that stays live regardless
 * of compile state; see {@link handleFsWatchRequest}.
 */
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  readFileBufferWithin,
  writeFileWithin,
  statWithin,
  readdirWithin,
  mkdirWithin,
  deleteWithin,
  renameWithin,
  SKIP_DIRS,
} from '../ipc/project-fs.js'
import { handleFsWatchRequest } from './fs-watch-sse.js'
import { createCoiServerShutdown } from './workbench-coi-shutdown.js'
import { serveStaticFile } from './workbench-coi-static.js'
import { registerCoiHostSession } from './workbench-coi-host.js'
import { FS_TYPE_DIR, FS_TYPE_FILE, toFsBridgeEntry } from './fs-bridge-protocol.js'
import type { FsBridgeStat } from './fs-bridge-protocol.js'
import { jsonRes } from './http-json.js'
import { miniappPartitionKey } from './views/miniapp-partition.js'

/** Max `/__fs/write` body; enough to save large source files without OOM. */
const MAX_FS_WRITE_BYTES = 32 * 1024 * 1024

/** Thrown by {@link readBody} when the accumulated body exceeds the cap. */
class BodyTooLargeError extends Error {
  constructor() {
    super('request body exceeds limit')
    this.name = 'BodyTooLargeError'
  }
}

/**
 * Read a request body, aborting once it exceeds `limit` bytes so a malicious or
 * runaway client cannot grow `chunks` without bound and exhaust memory.
 */
function readBody(req: http.IncomingMessage, limit = MAX_FS_WRITE_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let overflowed = false
    req.on('data', (c: Buffer) => {
      if (overflowed) return
      total += c.length
      if (total > limit) {
        overflowed = true
        chunks.length = 0
        // Drain the rest of the body instead of holding it, so the caller can
        // still write a 413 response on the same connection.
        req.resume()
        reject(new BodyTooLargeError())
        return
      }
      chunks.push(c)
    })
    req.on('end', () => { if (!overflowed) resolve(Buffer.concat(chunks)) })
    req.on('error', reject)
  })
}

const MUTATING_FS_ACTIONS: ReadonlySet<string> = new Set(['write', 'mkdir', 'delete', 'rename'])

/**
 * Guard a mutating `/__fs` action: require a non-GET/HEAD method (so a plain
 * navigation/image load cannot trigger a destructive call) and a same-origin
 * request. A cross-origin page sees `Origin`/`Sec-Fetch-Site` set by the
 * browser; we accept only same-origin or an origin-less same-origin request
 * (the workbench's own `fetch` to its serving origin). Returns an HTTP status
 * to reject with, or `null` when the request is allowed.
 */
function rejectUnsafeMutation(req: http.IncomingMessage): number | null {
  const method = (req.method ?? 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') return 405

  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== '' && site !== 'same-origin' && site !== 'none') {
    return 403
  }

  const origin = req.headers['origin']
  if (typeof origin === 'string' && origin !== '') {
    const host = req.headers['host']
    // Same-origin requires the Origin's host:port to match the request Host.
    let originHost: string
    try {
      originHost = new URL(origin).host
    } catch {
      return 403
    }
    if (!host || originHost !== host) return 403
  }
  return null
}

/** Map a node fs error to the HTTP status the provider expects. */
/**
 * Percent-decode a request path, answering the client on a malformed escape.
 * A stray `%` is the client's error and belongs here, not at the shared
 * listener's exception boundary, which cannot tell a bad request from a bug in
 * this handler. Returns `null` once the 400 has been sent.
 */
function decodePath(res: http.ServerResponse, pathname: string): string | null {
  try {
    return decodeURIComponent(pathname)
  } catch {
    res.writeHead(400)
    res.end('Bad Request')
    return null
  }
}

function fsErrorStatus(e: unknown): number {
  const code = (e as { code?: string }).code
  if (code === 'ENOACTIVE') return 409
  if (code === 'EACCES' || code === 'EINVAL') return 403
  if (code === 'ENOENT') return 404
  // Reading a path that is (now) a DIRECTORY: as a *file* it does not exist.
  // 404 lets the sync engine's not-found discipline retire the stale ledger
  // FILE record when an external change replaces a file with a same-named
  // directory — a 500 would make it skip forever ("transient failure").
  if (code === 'EISDIR') return 404
  return 500
}

/** Per-request state passed to an individual `/__fs/<action>` handler. */
interface FsActionContext {
  req: http.IncomingMessage
  res: http.ServerResponse
  projectRoot: string
  rel: string
  url: URL
}

async function fsStat(ctx: FsActionContext): Promise<void> {
  const st = await statWithin(ctx.projectRoot, ctx.rel)
  const payload: FsBridgeStat = {
    type: st.isDirectory() ? FS_TYPE_DIR : FS_TYPE_FILE,
    size: st.size,
    ctime: st.ctimeMs,
    mtime: st.mtimeMs,
  }
  jsonRes(ctx.res, 200, payload)
}

async function fsReaddir(ctx: FsActionContext): Promise<void> {
  const entries = await readdirWithin(ctx.projectRoot, ctx.rel)
  // Directories in SKIP_DIRS (node_modules, .git, dist, ...) are omitted at
  // every level: the workbench mirror and the WAL ledger seed walk whatever
  // this returns, so listing them would pull entire dependency trees into the
  // editor memfs and the OPFS ledger. Same-named FILES stay visible.
  const visible = entries.filter((e) => !(e.isDirectory && SKIP_DIRS.has(e.name)))
  // Wire shape and why it carries stats: see fs-bridge-protocol.ts.
  jsonRes(ctx.res, 200, visible.map(toFsBridgeEntry))
}

async function fsRead(ctx: FsActionContext): Promise<void> {
  const buf = await readFileBufferWithin(ctx.projectRoot, ctx.rel)
  ctx.res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length })
  ctx.res.end(buf)
}

async function fsWrite(ctx: FsActionContext): Promise<void> {
  let buf: Buffer
  try {
    buf = await readBody(ctx.req)
  } catch (e) {
    if (e instanceof BodyTooLargeError) return jsonRes(ctx.res, 413, { error: e.message })
    throw e
  }
  await writeFileWithin(ctx.projectRoot, ctx.rel, buf)
  ctx.res.writeHead(204)
  ctx.res.end()
}

async function fsMkdir(ctx: FsActionContext): Promise<void> {
  await mkdirWithin(ctx.projectRoot, ctx.rel)
  ctx.res.writeHead(204)
  ctx.res.end()
}

async function fsDelete(ctx: FsActionContext): Promise<void> {
  await deleteWithin(ctx.projectRoot, ctx.rel)
  ctx.res.writeHead(204)
  ctx.res.end()
}

async function fsRename(ctx: FsActionContext): Promise<void> {
  const toRel = (ctx.url.searchParams.get('to') ?? '').replace(/^\/+/, '')
  await renameWithin(ctx.projectRoot, ctx.rel, toRel)
  ctx.res.writeHead(204)
  ctx.res.end()
}

/** One handler per supported `/__fs/<action>` — keyed lookup replaces an if-chain. */
const FS_ACTIONS: Readonly<Record<string, (ctx: FsActionContext) => Promise<void>>> = {
  stat: fsStat,
  readdir: fsReaddir,
  read: fsRead,
  write: fsWrite,
  mkdir: fsMkdir,
  delete: fsDelete,
  rename: fsRename,
}

/**
 * `/__fs/<action>?p=<rel>` bridge onto the live active project root.
 * `p`/`to` are POSIX paths relative to the project root, resolved through the
 * shared renderer sandbox guards: a symlink inside the root pointing outside it
 * is rejected (EACCES → 403). A missing project surfaces as ENOACTIVE → 409 so
 * the provider can stay empty rather than error. Mutating actions require a
 * non-GET same-origin request (see {@link rejectUnsafeMutation}).
 */
async function handleFsRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  projectRoot: string,
  url: URL,
): Promise<void> {
  const action = url.pathname.slice('/__fs/'.length)
  const rel = (url.searchParams.get('p') ?? '').replace(/^\/+/, '') || '.'

  if (MUTATING_FS_ACTIONS.has(action)) {
    const rejectStatus = rejectUnsafeMutation(req)
    if (rejectStatus !== null) {
      return jsonRes(res, rejectStatus, { error: 'mutating fs action requires a non-GET same-origin request' })
    }
  }

  const handler = FS_ACTIONS[action]
  if (!handler) return jsonRes(res, 404, { error: 'unknown fs action: ' + action })

  try {
    await handler({ req, res, projectRoot, rel, url })
  } catch (e) {
    jsonRes(res, fsErrorStatus(e), { error: String((e as Error).message), code: (e as { code?: string }).code })
  }
}

export interface WorkbenchCoiServer {
  baseUrl: string
  port: number
  close: () => Promise<void>
}

export interface WorkbenchCoiServerOptions {
  /** Directory of the built workbench bundle (dist/vscode-workbench). */
  rootDir: string
  /** Reads the live active project root ('' when none is open). */
  getProjectRoot: () => string
  /**
   * Directory of host-contributed VS Code web extensions (each a subfolder with
   * a `package.json`). Served under `/__contrib/` with a `/__contrib/index.json`
   * manifest the workbench reads at boot. Omit for none.
   */
  extensionsDir?: string
  /**
   * Reads the host's custom file types (e.g. `.qdml`/`.qdss`/`.qds`), served at
   * `/__filetypes` so the workbench maps them to `files.associations`. Read
   * per-request so a project switch takes effect on the next editor boot. Omit
   * for none (built-in `wx*` associations only).
   */
  getFileTypes?: () => unknown
  /**
   * Reads the active project's identity — `appId` (null until the open commits
   * a session) plus its root path — served at `/__project` as the workspace id
   * the editor names its VS Code workspace after. Read per-request, because the
   * editor page can load BEFORE the project commits (see `/__project` below).
   * Omit when the host has no project identity to offer.
   */
  getProjectIdentity?: () => { appId: string | null; projectPath: string }
}

/**
 * Scan `extensionsDir` for immediate subfolders that contain a `package.json`,
 * returning the manifest list the workbench boots from. Each entry's `dir` is
 * the subfolder name (its files are served at `/__contrib/<dir>/...`).
 */
async function listFilesRecursive(dir: string, base = ''): Promise<string[]> {
  const out: string[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const rel = base ? `${base}/${e.name}` : e.name
    if (e.isDirectory()) {
      out.push(...(await listFilesRecursive(path.join(dir, e.name), rel)))
    } else if (e.isFile()) {
      out.push(rel)
    }
  }
  return out
}

async function readContributedExtensions(
  extensionsDir: string,
): Promise<Array<{ dir: string; packageJson: unknown; files: string[] }>> {
  const out: Array<{ dir: string; packageJson: unknown; files: string[] }> = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(extensionsDir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const extDir = path.join(extensionsDir, e.name)
    try {
      const pkgRaw = await fs.readFile(path.join(extDir, 'package.json'), 'utf8')
      const files = await listFilesRecursive(extDir)
      out.push({ dir: e.name, packageJson: JSON.parse(pkgRaw), files })
    } catch {
      // Not an extension folder (no/invalid package.json) — skip.
    }
  }
  return out
}

/**
 * The `/__project` workspace id: the miniapp partition key of the active
 * project, or null when there is no committed project identity yet.
 *
 * Reuses `miniappPartitionKey` (the same derivation the per-project Electron
 * session partition uses) so the editor's storage bucket and the runtime's
 * storage partition are named off the same project identity: the `appId`,
 * disambiguated by the project path because `appId` comes from the manifest and
 * two checkouts can declare the same one.
 */
function workspaceIdOf(identity: { appId: string | null; projectPath: string } | undefined): string | null {
  if (!identity?.appId) return null
  return miniappPartitionKey(identity.appId, identity.projectPath || null)
}

export async function startWorkbenchCoiServer(options: WorkbenchCoiServerOptions): Promise<WorkbenchCoiServer> {
  const root = path.resolve(options.rootDir)
  const contribRoot = options.extensionsDir ? path.resolve(options.extensionsDir) : null
  const shutdown = createCoiServerShutdown()
  const handle = (req: http.IncomingMessage, res: http.ServerResponse, url: URL): void => {
    // This window is tearing down. Anything accepted from here on would act on
    // a project the user has already closed, and a new SSE stream would outlive
    // the drain that was supposed to end them all.
    if (shutdown.closing) {
      res.writeHead(503)
      res.end('Closing')
      return
    }
    // Special-cased ahead of the generic `/__fs/*` dispatch: unlike every other
    // action, this is a long-lived SSE stream, not a one-shot JSON response.
    if (url.pathname === '/__fs/watch') {
      const endStream = handleFsWatchRequest(req, res, options.getProjectRoot)
      if (endStream) shutdown.trackWatchStream(res, endStream)
      return
    }

    // Everything below answers once. Shutdown lets these land rather than
    // dropping the socket under them — a `/__fs/write` mid-body is the file the
    // user just saved.
    shutdown.trackRequest(res)

    if (url.pathname.startsWith('/__fs/')) {
      handleFsRequest(req, res, options.getProjectRoot(), url).catch((e) => {
        if (!res.headersSent) jsonRes(res, 500, { error: String(e) })
      })
      return
    }

    // Host custom file types for the editor's `files.associations`. Read-only;
    // empty object when the host configured none.
    if (url.pathname === '/__filetypes') {
      jsonRes(res, 200, options.getFileTypes?.() ?? {})
      return
    }

    // Identity of the active project, as the id the editor names its VS Code
    // workspace after. Every project is mirrored at the same constant
    // `file:///workspace` root, and VS Code keys WORKSPACE-scope storage (open
    // editors, view state, explorer expansion) off the workspace identity — so
    // without a distinct id per project, one project's tabs are restored into
    // the next, stranded behind "the file was not found".
    //
    // Served here rather than baked into the editor's load URL because the
    // editor view can attach BEFORE the open commits its session (its attach
    // gate self-releases on a slow compile), when there is no identity to hand
    // it; `null` then tells the page to keep polling, the same way its disk
    // mirror already polls `/__fs` for the project root to appear.
    if (url.pathname === '/__project') {
      jsonRes(res, 200, { workspaceId: workspaceIdOf(options.getProjectIdentity?.()) })
      return
    }

    // Host-contributed web extensions: manifest + static files (same-origin so
    // they satisfy the workbench's COEP require-corp).
    if (url.pathname.startsWith('/__contrib/')) {
      if (!contribRoot) { res.writeHead(404); res.end('Not Found'); return }
      if (url.pathname === '/__contrib/index.json') {
        readContributedExtensions(contribRoot)
          .then((list) => jsonRes(res, 200, list))
          .catch((e) => { if (!res.headersSent) jsonRes(res, 500, { error: String(e) }) })
        return
      }
      const rel = decodePath(res, url.pathname.slice('/__contrib/'.length))
      if (rel === null) return
      serveStaticFile(res, contribRoot, rel)
      return
    }

    const filePath = decodePath(res, url.pathname)
    if (filePath === null) return
    serveStaticFile(res, root, filePath)
  }

  // The listener is shared with every other project window so they land on one
  // origin; this window is reached through its own path prefix. See
  // workbench-coi-host.ts for why the port cannot be per-window.
  const registration = await registerCoiHostSession({ rootDir: root, extensionsDir: contribRoot, session: { handle } })
  return {
    baseUrl: `${registration.origin}/w/${registration.token}/`,
    port: registration.port,
    // Why this is not a bare `server.close()`: see workbench-coi-shutdown.ts.
    // Drain first so this window's SSE streams end and its in-flight writes
    // land, THEN drop the route — the listener itself only goes away with the
    // last window.
    close: async () => {
      // `finally`: a drain that throws must still drop this window's route.
      // Leaving it registered would keep a torn-down window's bridge reachable
      // on the shared listener for the rest of the process.
      try {
        await shutdown.drain()
      } finally {
        await registration.release()
      }
    },
  }
}
