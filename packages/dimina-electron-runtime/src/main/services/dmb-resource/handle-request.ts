import fs from 'node:fs'
import path from 'node:path'
import { DMB_SDK_PREFIX } from '../../../shared/dmb-resource-url.js'

export interface DmbResourceSession {
  resourceBaseUrl: string
}

export interface HandleDmbResourceRequestInput {
  requestUrl: string
  /** Absolute filesystem root of the runtime dist (`render-host/`, `native-host/`). */
  sdkRoot: string
  resolveSession: (bridgeId: string) => DmbResourceSession | null
  fetchPackage?: (url: string) => Promise<Response>
  readSdkFile?: (absPath: string) => Promise<Response>
}

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
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

/**
 * Pure router for `protocol.handle('dmb-resource')`.
 * `/__sdk__/*` → runtime dist; everything else → the session's resourceBaseUrl.
 */
export async function handleDmbResourceRequest(
  input: HandleDmbResourceRequestInput,
): Promise<Response> {
  const url = new URL(input.requestUrl)
  const session = input.resolveSession(url.hostname)
  if (!session) {
    return new Response('Bridge session not found', { status: 404 })
  }

  // Decode once so `%2f` traversal is visible to path.resolve; do not decode
  // twice (`%252e` must stay a literal segment, not become `..`).
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return new Response('Bad path encoding', { status: 400 })
  }

  if (pathname === DMB_SDK_PREFIX.slice(0, -1) || pathname.startsWith(DMB_SDK_PREFIX)) {
    return serveSdkPath(pathname, input)
  }

  const fetchPackage = input.fetchPackage ?? ((target) => fetch(target))
  const target = new URL(pathname.replace(/^\/+/, '') + url.search, session.resourceBaseUrl)
  return fetchPackage(target.toString())
}

async function serveSdkPath(
  pathname: string,
  input: HandleDmbResourceRequestInput,
): Promise<Response> {
  const relative = pathname.startsWith(DMB_SDK_PREFIX)
    ? pathname.slice(DMB_SDK_PREFIX.length)
    : ''
  const sdkRoot = path.resolve(input.sdkRoot)
  const resolved = path.resolve(sdkRoot, relative)

  if (!isPathInsideRoot(sdkRoot, resolved)) {
    return new Response('Forbidden', { status: 403 })
  }

  if (input.readSdkFile) {
    return input.readSdkFile(resolved)
  }

  try {
    const realRoot = fs.realpathSync(sdkRoot)
    let realFile: string
    try {
      realFile = fs.realpathSync(resolved)
    } catch {
      return new Response('Not Found', { status: 404 })
    }
    if (!isPathInsideRoot(realRoot, realFile)) {
      return new Response('Forbidden', { status: 403 })
    }
    const stat = fs.statSync(realFile)
    if (!stat.isFile()) {
      return new Response('Not Found', { status: 404 })
    }
    const body = fs.readFileSync(realFile)
    const contentType = MIME_TYPES[path.extname(realFile).toLowerCase()]
      ?? 'application/octet-stream'
    return new Response(body, {
      status: 200,
      headers: { 'content-type': contentType },
    })
  } catch {
    return new Response('Not Found', { status: 404 })
  }
}

function isPathInsideRoot(root: string, candidate: string): boolean {
  const normalizedRoot = path.resolve(root)
  const normalizedCandidate = path.resolve(candidate)
  return normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(normalizedRoot + path.sep)
}
