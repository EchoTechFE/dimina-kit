/**
 * Cross-Origin-Isolation (COI) static server for the VS Code workbench.
 *
 * Chromium only grants `crossOriginIsolated === true` (the gate for
 * SharedArrayBuffer) to a document fetched over **http(s)** that carries
 * COOP `same-origin` + COEP `require-corp`. A custom `protocol.handle`
 * response with the same headers does NOT get isolation — hence this
 * in-process http server bound to 127.0.0.1 on a random port.
 *
 * Every response carries the three isolation headers so sub-resources and
 * workers spawned same-origin satisfy COEP `require-corp`.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const MIME = {
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

function setIsolationHeaders(res) {
  // The three headers that unlock crossOriginIsolated for an http document.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
}

function containedPath(root, pathname) {
  const rel = pathname.replace(/^\/+/, '') || 'index.html'
  const resolved = path.resolve(root, rel)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null
  return resolved
}

/**
 * Bridge a `diminafs:` FileSystemProvider to real Node fs under `fsRoot`.
 *
 * The browser-side provider (src/dimina-fs.ts) calls these endpoints; keeping
 * the bridge in the COI server (rather than a preload IPC) means the workbench
 * stays a plain http document and the isolation headers cover every request.
 *
 *   GET  /__fs/stat?p=<rel>     → { type, size, ctime, mtime }
 *   GET  /__fs/readdir?p=<rel>  → [ [name, type], … ]   (type: 1 file, 2 dir)
 *   GET  /__fs/read?p=<rel>     → raw bytes
 *   POST /__fs/write?p=<rel>    → 204   (body = bytes to write)
 *   POST /__fs/mkdir?p=<rel>    → 204
 *   POST /__fs/delete?p=<rel>   → 204
 *   POST /__fs/rename?p=<rel>&to=<rel> → 204
 *
 * `p`/`to` are POSIX-style paths relative to `fsRoot`; traversal outside the
 * root is rejected (containedPath).
 */
function jsonRes(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj))
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function handleFsRequest(req, res, fsRoot, url) {
  const fsp = fs.promises
  const rel = (url.searchParams.get('p') ?? '').replace(/^\/+/, '')
  const target = containedPath(fsRoot, rel || '.')
  if (!target) return jsonRes(res, 403, { error: 'forbidden' })
  const action = url.pathname.slice('/__fs/'.length)
  try {
    if (action === 'stat') {
      const st = await fsp.stat(target)
      return jsonRes(res, 200, {
        type: st.isDirectory() ? 2 : 1,
        size: st.size,
        ctime: st.ctimeMs,
        mtime: st.mtimeMs,
      })
    }
    if (action === 'readdir') {
      const entries = await fsp.readdir(target, { withFileTypes: true })
      return jsonRes(res, 200, entries.map((e) => [e.name, e.isDirectory() ? 2 : 1]))
    }
    if (action === 'read') {
      const buf = await fsp.readFile(target)
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length })
      return res.end(buf)
    }
    if (action === 'write') {
      const buf = await readBody(req)
      await fsp.mkdir(path.dirname(target), { recursive: true })
      await fsp.writeFile(target, buf)
      res.writeHead(204)
      return res.end()
    }
    if (action === 'mkdir') {
      await fsp.mkdir(target, { recursive: true })
      res.writeHead(204)
      return res.end()
    }
    if (action === 'delete') {
      await fsp.rm(target, { recursive: true, force: true })
      res.writeHead(204)
      return res.end()
    }
    if (action === 'rename') {
      const toRel = (url.searchParams.get('to') ?? '').replace(/^\/+/, '')
      const toTarget = containedPath(fsRoot, toRel)
      if (!toTarget) return jsonRes(res, 403, { error: 'forbidden' })
      await fsp.mkdir(path.dirname(toTarget), { recursive: true })
      await fsp.rename(target, toTarget)
      res.writeHead(204)
      return res.end()
    }
    return jsonRes(res, 404, { error: 'unknown fs action: ' + action })
  } catch (e) {
    // Map ENOENT to 404 so the provider can throw FileNotFound.
    const code = e && e.code === 'ENOENT' ? 404 : 500
    return jsonRes(res, code, { error: String(e && e.message ? e.message : e), code: e && e.code })
  }
}

export async function startCoiServer(rootDir, options = {}) {
  const root = path.resolve(rootDir)
  const fsRoot = options.fsRoot ? path.resolve(options.fsRoot) : null
  const server = http.createServer((req, res) => {
    setIsolationHeaders(res)
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    if (fsRoot && url.pathname.startsWith('/__fs/')) {
      // CORP same-origin already set above; the fs bridge serves the project tree.
      handleFsRequest(req, res, fsRoot, url).catch((e) => {
        if (!res.headersSent) jsonRes(res, 500, { error: String(e) })
      })
      return
    }

    const filePath = containedPath(root, decodeURIComponent(url.pathname))
    if (!filePath) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }
    fs.stat(filePath, (err, stat) => {
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
      fs.createReadStream(filePath).pipe(res)
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}/`,
    port,
    close: () => new Promise((r) => server.close(() => r())),
  }
}
