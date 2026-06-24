/**
 * Cross-Origin-Isolation static server for the embedded A2 VS Code workbench.
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
 * the live active project on disk, reusing the same `enforceWithinProjectRoot`
 * containment guard as the renderer's `project:fs:*` sandbox so there is a
 * single sandbox implementation. The active project root is read per-request
 * (via the injected getter) so project switches take effect immediately.
 */
import http from 'node:http'
import nodeFs from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { enforceWithinProjectRoot } from '../ipc/project-fs.js'

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

/** Resolve a request pathname inside `root`, rejecting traversal escapes. */
function containedStaticPath(root: string, pathname: string): string | null {
  const rel = pathname.replace(/^\/+/, '') || 'index.html'
  const resolved = path.resolve(root, rel)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null
  return resolved
}

function jsonRes(res: http.ServerResponse, code: number, obj: unknown): void {
  const body = Buffer.from(JSON.stringify(obj))
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length })
  res.end(body)
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * `/__fs/<action>?p=<rel>` bridge onto the live active project root.
 * `p`/`to` are POSIX paths relative to the project root; the same lexical
 * containment guard as the renderer sandbox rejects escapes (EACCES) and a
 * missing project (ENOACTIVE → surfaced as 404/409 so the provider can react).
 */
async function handleFsRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  projectRoot: string,
  url: URL,
): Promise<void> {
  const rel = (url.searchParams.get('p') ?? '').replace(/^\/+/, '')
  let target: string
  try {
    target = enforceWithinProjectRoot(path.resolve(projectRoot, rel || '.'), projectRoot)
  } catch (e) {
    const code = (e as { code?: string }).code
    // ENOACTIVE (no project) → 409 so the provider can stay empty rather than error.
    return jsonRes(res, code === 'ENOACTIVE' ? 409 : 403, { error: String((e as Error).message), code })
  }
  const action = url.pathname.slice('/__fs/'.length)
  try {
    if (action === 'stat') {
      const st = await fs.stat(target)
      return jsonRes(res, 200, { type: st.isDirectory() ? 2 : 1, size: st.size, ctime: st.ctimeMs, mtime: st.mtimeMs })
    }
    if (action === 'readdir') {
      const entries = await fs.readdir(target, { withFileTypes: true })
      return jsonRes(res, 200, entries.map((e) => [e.name, e.isDirectory() ? 2 : 1]))
    }
    if (action === 'read') {
      const buf = await fs.readFile(target)
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length })
      return void res.end(buf)
    }
    if (action === 'write') {
      const buf = await readBody(req)
      const dir = enforceWithinProjectRoot(path.dirname(target), projectRoot)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(target, buf)
      res.writeHead(204)
      return void res.end()
    }
    if (action === 'mkdir') {
      await fs.mkdir(target, { recursive: true })
      res.writeHead(204)
      return void res.end()
    }
    if (action === 'delete') {
      await fs.rm(target, { recursive: true, force: true })
      res.writeHead(204)
      return void res.end()
    }
    if (action === 'rename') {
      const toRel = (url.searchParams.get('to') ?? '').replace(/^\/+/, '')
      const toTarget = enforceWithinProjectRoot(path.resolve(projectRoot, toRel), projectRoot)
      await fs.mkdir(path.dirname(toTarget), { recursive: true })
      await fs.rename(target, toTarget)
      res.writeHead(204)
      return void res.end()
    }
    return jsonRes(res, 404, { error: 'unknown fs action: ' + action })
  } catch (e) {
    const code = (e as { code?: string }).code === 'ENOENT' ? 404 : 500
    return jsonRes(res, code, { error: String((e as Error).message), code: (e as { code?: string }).code })
  }
}

export interface WorkbenchCoiServer {
  baseUrl: string
  port: number
  close: () => Promise<void>
}

export interface WorkbenchCoiServerOptions {
  /** Directory of the built workbench bundle (dist/workbench-a2). */
  rootDir: string
  /** Reads the live active project root ('' when none is open). */
  getProjectRoot: () => string
  /**
   * Directory of host-contributed VS Code web extensions (each a subfolder with
   * a `package.json`). Served under `/__contrib/` with a `/__contrib/index.json`
   * manifest the workbench reads at boot. Omit for none.
   */
  extensionsDir?: string
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

    if (url.pathname.startsWith('/__fs/')) {
      handleFsRequest(req, res, options.getProjectRoot(), url).catch((e) => {
        if (!res.headersSent) jsonRes(res, 500, { error: String(e) })
      })
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
      const contribPath = containedStaticPath(contribRoot, rel)
      if (!contribPath) { res.writeHead(403); res.end('Forbidden'); return }
      nodeFs.stat(contribPath, (err, stat) => {
        if (err || !stat.isFile()) { res.writeHead(404); res.end('Not Found'); return }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(contribPath)] ?? 'application/octet-stream',
          'Content-Length': stat.size,
          'Cache-Control': 'no-store',
        })
        nodeFs.createReadStream(contribPath).pipe(res)
      })
      return
    }

    const filePath = containedStaticPath(root, decodeURIComponent(url.pathname))
    if (!filePath) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }
    nodeFs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404)
        res.end('Not Found')
        return
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
      })
      nodeFs.createReadStream(filePath).pipe(res)
    })
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
