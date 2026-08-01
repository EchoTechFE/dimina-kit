import fs from 'node:fs'
import path from 'node:path'
import { DMB_PAGEFRAME_DOC_NAME, DMB_SDK_PREFIX } from '../../../shared/dmb-resource-url.js'

const RENDER_HOST_DOCUMENT_SDK_PATH = `${DMB_SDK_PREFIX}render-host/pageFrame.html`

export interface DmbResourceSession {
  resourceBaseUrl: string
  /** Owning app, so a proxied request can be confined to this app's own package tree. */
  appId: string
  /** Owning page's resource root inside the mini-app package (e.g. `'main'`). */
  root: string
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
 * `/__sdk__/*` serves from the runtime dist. A request whose last path
 * segment is the reserved `DMB_PAGEFRAME_DOC_NAME` — the render-host
 * document, which `buildRenderHostDocumentUrl` places directly under the
 * page's own package path (`/<appId>/<root>/<page directory>/__frame__.html`,
 * no separate virtual prefix) — also serves from the runtime dist instead of
 * being proxied. Everything else proxies to the session's resourceBaseUrl,
 * unchanged from before this document-path scheme existed. All of it
 * requires a resolved session first: by the time the `<webview>` navigates
 * to the frame document, `handleSpawn` has already registered the session
 * and handed the URL to the renderer, so there's no bootstrap ordering that
 * would make this circular — and requiring it here means a disposed/unknown
 * bridge can't still load a live document (keeps stale-guest detection
 * meaningful).
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
  // twice (`%252e` must stay a literal segment, not become `..`). This
  // decoded copy is ONLY for string matching/comparison below — it must
  // never be fed back into another `new URL()` call. A literal '#'/'?'/'\'
  // (or a doubly-encoded '%252e%252e' that survived this single decode as
  // the literal text '%2e%2e') would regain URL syntax meaning on a second
  // parse: truncating the path into a query/fragment, or re-triggering
  // dot-segment removal into a real '..' that escapes further than the
  // first parse ever allowed.
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return new Response('Bad path encoding', { status: 400 })
  }

  if (pathname === DMB_SDK_PREFIX.slice(0, -1) || pathname.startsWith(DMB_SDK_PREFIX)) {
    return serveSdkPath(pathname, input)
  }

  if (isFrameDocumentPath(pathname)) {
    return serveSdkPath(RENDER_HOST_DOCUMENT_SDK_PATH, input)
  }

  // session.resourceBaseUrl is a SHARED origin that serves every open
  // project's compiled output side by side (see default-adapter.ts's single
  // `dimina-fe-output` dir), not one scoped to this session's own app. A
  // package-relative reference written by the mini-app (`../../../otherApp/…`)
  // resolves, via the browser's own relative-URL algorithm, to a path outside
  // this session's own `<appId>/<root>` tree just as validly as one that
  // stays inside it — so that boundary has to be enforced here, not assumed
  // from the request path alone.
  if (!isWithinAppRoot(pathname, session.appId, session.root)) {
    return new Response('Forbidden', { status: 403 })
  }

  const fetchPackage = input.fetchPackage ?? ((target) => fetch(target))
  // Forward the ORIGINAL (still percent-encoded) pathname, not the decoded
  // `pathname` above — see its comment for why re-parsing a decoded string
  // through this second `new URL()` is unsafe.
  const target = new URL(url.pathname.replace(/^\/+/, '') + url.search, session.resourceBaseUrl)
  return fetchPackage(target.toString())
}

/** Last path segment is the reserved frame-document name, e.g. `/wx1/main/pages/home/__frame__.html`. */
function isFrameDocumentPath(pathname: string): boolean {
  return pathname === `/${DMB_PAGEFRAME_DOC_NAME}` || pathname.endsWith(`/${DMB_PAGEFRAME_DOC_NAME}`)
}

/** `pathname` (decoded) must sit at or under `/<appId>/<root>/…` — this session's own package tree. */
function isWithinAppRoot(pathname: string, appId: string, root: string): boolean {
  const prefix = `/${appId}/${root}/`
  return pathname === prefix.slice(0, -1) || pathname.startsWith(prefix)
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
