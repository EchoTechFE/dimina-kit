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
import nodeFs from 'node:fs'
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
import { jsonRes } from './http-json.js'

/** Max `/__fs/write` body; enough to save large source files without OOM. */
const MAX_FS_WRITE_BYTES = 32 * 1024 * 1024

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
}

function setIsolationHeaders(res: http.ServerResponse): void {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
}

/** Resolve a request pathname inside `root`, rejecting lexical traversal escapes. */
function containedStaticPath(root: string, pathname: string): string | null {
  const rel = pathname.replace(/^\/+/, '') || 'index.html'
  const resolved = path.resolve(root, rel)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null
  return resolved
}

/**
 * Serve a static file under `root`: lexical containment, then `fs.realpath`
 * BOTH the root and the resolved file before stat/stream, so a symlink inside
 * `root` pointing outside it cannot be served (the lexical check alone follows
 * symlinks because `stat`/`createReadStream` do). Sends the response itself.
 */
function serveStaticFile(res: http.ServerResponse, root: string, pathname: string): void {
  const candidate = containedStaticPath(root, pathname)
  if (!candidate) { res.writeHead(403); res.end('Forbidden'); return }
  Promise.all([fs.realpath(root), fs.realpath(candidate)])
    .then(([realRoot, realFile]) => {
      if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) {
        res.writeHead(403); res.end('Forbidden'); return
      }
      nodeFs.stat(realFile, (err, stat) => {
        if (err || !stat.isFile()) { res.writeHead(404); res.end('Not Found'); return }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(realFile)] ?? 'application/octet-stream',
          'Content-Length': stat.size,
          'Cache-Control': 'no-store',
        })
        // Stream the realpath'd file (already resolved to its real on-disk
        // location, so a symlink inside the root cannot redirect it outside).
        nodeFs.createReadStream(realFile).pipe(res)
      })
    })
    .catch(() => { if (!res.headersSent) { res.writeHead(404); res.end('Not Found') } })
}

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
  jsonRes(ctx.res, 200, { type: st.isDirectory() ? 2 : 1, size: st.size, ctime: st.ctimeMs, mtime: st.mtimeMs })
}

async function fsReaddir(ctx: FsActionContext): Promise<void> {
  const entries = await readdirWithin(ctx.projectRoot, ctx.rel)
  // Directories in SKIP_DIRS (node_modules, .git, dist, ...) are omitted at
  // every level: the workbench mirror and the WAL ledger seed walk whatever
  // this returns, so listing them would pull entire dependency trees into the
  // editor memfs and the OPFS ledger. Same-named FILES stay visible.
  const visible = entries.filter((e) => !(e.isDirectory() && SKIP_DIRS.has(e.name)))
  jsonRes(ctx.res, 200, visible.map((e) => [e.name, e.isDirectory() ? 2 : 1]))
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

export async function startWorkbenchCoiServer(options: WorkbenchCoiServerOptions): Promise<WorkbenchCoiServer> {
  const root = path.resolve(options.rootDir)
  const contribRoot = options.extensionsDir ? path.resolve(options.extensionsDir) : null
  const server = http.createServer((req, res) => {
    setIsolationHeaders(res)
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    // Special-cased ahead of the generic `/__fs/*` dispatch: unlike every other
    // action, this is a long-lived SSE stream, not a one-shot JSON response.
    if (url.pathname === '/__fs/watch') {
      handleFsWatchRequest(req, res, options.getProjectRoot)
      return
    }

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
      const rel = decodeURIComponent(url.pathname.slice('/__contrib/'.length))
      serveStaticFile(res, contribRoot, rel)
      return
    }

    serveStaticFile(res, root, decodeURIComponent(url.pathname))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return {
    baseUrl: `http://127.0.0.1:${port}/`,
    port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
