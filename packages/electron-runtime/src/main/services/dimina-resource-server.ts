import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { pathToFileURL } from 'node:url'

export interface DiminaResourceServer {
  baseUrl: string
  close(): Promise<void>
}

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
}

export async function startDiminaResourceServer(rootDir: string): Promise<DiminaResourceServer> {
  const root = path.resolve(rootDir)
  const server = http.createServer((req, res) => {
    void handleRequest(root, req, res)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => err ? reject(err) : resolve())
      })
    },
  }
}

async function handleRequest(root: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  setCorsHeaders(res)

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405)
    res.end('Method Not Allowed')
    return
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const filePath = resolveContainedPath(root, decodeURIComponent(url.pathname))
  if (!filePath) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }

  try {
    const stat = await fs.promises.stat(filePath)
    if (!stat.isFile()) {
      res.writeHead(404)
      res.end('Not Found')
      return
    }
    res.writeHead(200, {
      'content-type': MIME_TYPES[path.extname(filePath)] ?? 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'no-store',
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    fs.createReadStream(filePath).pipe(res)
  } catch {
    res.writeHead(404)
    res.end('Not Found')
  }
}

function resolveContainedPath(root: string, pathname: string): string | null {
  const relative = pathname.replace(/^\/+/, '') || 'index.html'
  const resolved = path.resolve(root, relative)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null
  return resolved
}

function setCorsHeaders(res: http.ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', '*')
  res.setHeader('access-control-allow-methods', 'GET,HEAD,OPTIONS')
  res.setHeader('cross-origin-resource-policy', 'cross-origin')
}

export function toSourceUrl(filePath: string): string {
  return pathToFileURL(filePath).toString()
}
