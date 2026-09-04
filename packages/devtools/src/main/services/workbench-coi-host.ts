/**
 * The single http listener behind every project window's workbench bridge.
 *
 * Browser storage is keyed by ORIGIN: IndexedDB, OPFS, Cache Storage, service
 * worker registrations, Web Locks and BroadcastChannel all live in a bucket
 * named after scheme + host + PORT. A listener bound to port 0 gets a different
 * port every time, so one http server per project window put every window on
 * its own origin — the VS Code workspace- and global-scope mementos a window
 * wrote (open editors, view state, explorer expansion) died with it, reopening
 * the same project minted a fresh empty bucket, and each new port accumulated
 * another service-worker registration and cache entry that nothing reclaimed.
 *
 * So the listener is shared by every window in the process and a window's
 * bridge is addressed by an opaque path prefix (`/w/<token>/`) rather than by
 * port: one origin for all workbenches, distinct `/__fs` + `/__project`
 * routing per window. The prefix is routing, not a security boundary — pages
 * on one origin can already reach each other's paths, which is the situation
 * the app-wide server had before per-project windows existed.
 *
 * The listener also outlives the last window that used it, because closing
 * every project and opening another one is an ordinary switch and must not
 * move the origin. Only {@link closeAllCoiHosts} takes a listener down.
 */
import http from 'node:http'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { serveStaticFile, setIsolationHeaders } from './workbench-coi-static.js'
import { createCoiServerShutdown, type CoiServerShutdown } from './workbench-coi-shutdown.js'

export interface CoiHostSession {
  /**
   * Answers one request for this window. `url` has already had the window's
   * `/w/<token>` prefix stripped, so the handler sees the same pathnames it
   * would on a server of its own.
   */
  handle: (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void
}

export interface CoiHostRegistration {
  /** Scheme + host + port of the shared listener, with no trailing slash. */
  origin: string
  port: number
  /** The path segment that routes to this session. */
  token: string
  /** Drops the route, closing the shared listener when the last one goes. */
  release: () => Promise<void>
}

interface Host {
  server: http.Server
  origin: string
  port: number
  rootDir: string
  sessions: Map<string, CoiHostSession>
  shutdown: CoiServerShutdown
  closed: boolean
}

/**
 * Tear down every listener. For process shutdown and for test isolation — a
 * window's own teardown never gets here, because the origin has to survive it.
 */
export async function closeAllCoiHosts(): Promise<void> {
  if (closingAll) return closingAll
  const pending = [...hosts.values()]
  hosts.clear()
  const run = (async () => {
    await Promise.all(
      pending.map(async (p) => {
        const host = await p.catch(() => null)
        if (!host || host.closed) return
        host.closed = true
        await host.shutdown.close(host.server)
      }),
    )
  })()
  closingAll = run
  try {
    await run
  } finally {
    if (closingAll === run) closingAll = null
  }
}

/**
 * One host per bundle + extensions pair. Two hosts serving different bundles
 * are genuinely different servers; every window of one app shares one entry.
 */
const hosts = new Map<string, Promise<Host>>()

/**
 * In-flight {@link closeAllCoiHosts}. A registration that was already waiting
 * on `createHost` when a global close began must not hand its window an origin
 * that close is about to take away, so it waits here and starts a fresh host.
 */
let closingAll: Promise<void> | null = null

const WINDOW_PREFIX = /^\/w\/([A-Za-z0-9-]+)(\/.*)?$/

function notFound(res: http.ServerResponse): void {
  res.writeHead(404)
  res.end('Not Found')
}

function badRequest(res: http.ServerResponse): void {
  res.writeHead(400)
  res.end('Bad Request')
}

function serverError(res: http.ServerResponse): void {
  res.writeHead(500)
  res.end('Internal Server Error')
}

async function createHost(rootDir: string): Promise<Host> {
  const sessions = new Map<string, CoiHostSession>()
  const shutdown = createCoiServerShutdown()
  const server = http.createServer((req, res) => {
    setIsolationHeaders(res)
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      // A malformed request line must not become an uncaught exception in the
      // main process.
      badRequest(res)
      return
    }
    const routed = WINDOW_PREFIX.exec(url.pathname)
    if (routed) {
      const session = sessions.get(routed[1]!)
      // A request for a window that has already been torn down. 404 rather
      // than fall through to the bundle: the caller asked for one specific
      // window's bridge, and answering with another window's data would be
      // worse than not answering.
      if (!session) { notFound(res); return }
      // Strip the prefix by rewriting `pathname` on a copy. Re-parsing the
      // remainder as a URL reference would read a leading `//` as an authority,
      // so `/w/<token>//__project` would arrive as `/` on host `__project`.
      const forwarded = new URL(url)
      forwarded.pathname = routed[2] || '/'
      try {
        session.handle(req, res, forwarded)
      } catch (err) {
        // One window's handler must not take the shared listener's process
        // with it — an uncaught exception here would end every other project
        // window too. A handler answers its own client errors (a malformed
        // percent escape, say), so anything reaching this point is a defect in
        // it: 500 rather than 400, and logged, because a silent 400 would read
        // as the caller's fault and hide the bug for good.
        console.error('[workbench-coi] session handler threw', err)
        if (res.headersSent) res.destroy()
        else serverError(res)
      }
      return
    }
    // No window prefix. Every bridge endpoint has to know WHICH window asked,
    // so answering one here would mean guessing a project — the ambiguity the
    // prefix exists to remove. The bundle itself is project-independent and is
    // still served, so an absolute asset URL inside it keeps working.
    if (url.pathname.startsWith('/__')) { notFound(res); return }
    let decoded: string
    try {
      decoded = decodeURIComponent(url.pathname)
    } catch {
      // A stray `%` in the path. Answering 400 keeps the listener alive; the
      // throw would otherwise escape the request handler.
      badRequest(res)
      return
    }
    shutdown.trackRequest(res)
    serveStaticFile(res, rootDir, decoded)
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
    server,
    origin: `http://127.0.0.1:${port}`,
    port,
    rootDir,
    sessions,
    shutdown,
    closed: false,
  }
}

export async function registerCoiHostSession(opts: {
  rootDir: string
  extensionsDir: string | null
  session: CoiHostSession
}): Promise<CoiHostRegistration> {
  const rootDir = path.resolve(opts.rootDir)
  // JSON, not a separator character: `('/a', '/b|/c')` and `('/a|/b', '/c')`
  // are both legal path pairs and would otherwise collide onto one host, so two
  // different bundles would serve each other's files.
  const key = JSON.stringify([rootDir, opts.extensionsDir ?? null])
  // Loop rather than a single lookup: a release running concurrently can have
  // marked the cached host closed without having removed it yet, and joining a
  // closing server would hand back a dead origin.
  for (;;) {
    if (closingAll) {
      await closingAll
      continue
    }
    let pending = hosts.get(key)
    if (!pending) {
      pending = createHost(rootDir)
      hosts.set(key, pending)
    }
    let host: Host
    try {
      host = await pending
    } catch (err) {
      if (hosts.get(key) === pending) hosts.delete(key)
      throw err
    }
    // `closingAll` is re-checked because it can have started while this
    // registration was awaiting `pending`: the host may still read as open and
    // yet be one `await` away from losing its port.
    if (host.closed || closingAll || hosts.get(key) !== pending) {
      if (hosts.get(key) === pending) hosts.delete(key)
      continue
    }
    const token = randomUUID()
    host.sessions.set(token, opts.session)
    let released = false
    return {
      origin: host.origin,
      port: host.port,
      token,
      release: async () => {
        if (released) return
        released = true
        host.sessions.delete(token)
        // The listener deliberately stays up with no windows on it. Closing it
        // would release the port, and the next window would bind a different
        // one — a different origin, so the storage the closed window wrote
        // would be unreachable. Closing the last project and opening another
        // is the ordinary way to switch projects, so the origin has to hold
        // for the life of the process, not just while a window is open.
      },
    }
  }
}
