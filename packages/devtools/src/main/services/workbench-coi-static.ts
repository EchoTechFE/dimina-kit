/**
 * Static-file serving and the cross-origin-isolation headers shared by the
 * workbench COI host and every window's bridge.
 *
 * Split out of `workbench-coi-server.ts` so the host module can serve the
 * bundle without importing the per-window bridge (which imports the host).
 */
import http from 'node:http'
import nodeFs from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

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

/**
 * The workbench needs `SharedArrayBuffer` for the TS web ext-host's
 * project-wide IntelliSense, and Chromium only serves that to a
 * cross-origin-isolated document. Every response carries the three headers so
 * same-origin sub-resources and workers satisfy COEP `require-corp`.
 */
export function setIsolationHeaders(res: http.ServerResponse): void {
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
export function serveStaticFile(res: http.ServerResponse, root: string, pathname: string): void {
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
        const stream = nodeFs.createReadStream(realFile)
        // The file can vanish or lose permissions between the stat and the
        // open. The stream reports that asynchronously, once the 200 and the
        // Content-Length are already on the wire, so no status can be changed
        // — and an unhandled 'error' on a stream is an uncaught exception in
        // the main process. Take the socket instead, which is what a client
        // sees for a truncated body anyway.
        stream.on('error', () => { res.destroy() })
        stream.pipe(res)
      })
    })
    .catch(() => { if (!res.headersSent) { res.writeHead(404); res.end('Not Found') } })
}
