/**
 * The shared-listener invariants of workbench-coi-host.ts: every project
 * window backed by the same `rootDir`/`extensionsDir` lands on one origin
 * (storage buckets by origin, not by window), each window's `/w/<token>/`
 * prefix routes only to its own project, a torn-down window's prefix cannot
 * be reused to reach another window's data, and the listener survives every
 * window closing — closing a project and opening another must not move the
 * origin. Only `closeAllCoiHosts` takes a listener down.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

// startWorkbenchCoiServer pulls in `electron` transitively (project-fs →
// ipc-registry's top-level `import { ipcMain } from 'electron'`). CI has no
// Electron binary, so the unmocked import throws at module-eval; a no-op stub
// is enough to let the module load without touching ipcMain.
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn(), off: vi.fn() } }))

import { startWorkbenchCoiServer, type WorkbenchCoiServer } from './workbench-coi-server.js'
import { closeAllCoiHosts, registerCoiHostSession, type CoiHostSession } from './workbench-coi-host.js'

/** A minimal session whose `handle` always answers 200, for tests that only care about routing. */
function okSession(): CoiHostSession {
  return { handle: (_req, res) => { res.writeHead(200); res.end('ok') } }
}

/**
 * Sends the exact wire path given, bypassing the URL normalization a `fetch`
 * or `http.request({ path })` string might otherwise apply — needed to put a
 * literal `//` or a stray `%` on the request line the way a crafted client
 * would.
 *
 * A dropped connection resolves with `completed: false` rather than rejecting,
 * because a destroyed response is an expected answer here — the only one left
 * once a handler has already begun writing. `status` is then 0: no response
 * was ever readable.
 */
function rawGet(port: number, rawPath: string): Promise<{ status: number; body: string; completed: boolean }> {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
      const chunks: Buffer[] = []
      const settle = (completed: boolean) =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(), completed })
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => settle(true))
      res.on('aborted', () => settle(false))
      res.on('error', () => settle(false))
    })
    req.on('error', () => resolve({ status: 0, body: '', completed: false }))
    req.end()
  })
}

let tmpParent = ''
let rootDir = ''
let servers: WorkbenchCoiServer[] = []

/** Starts a session on the shared host, tracked for automatic teardown. */
async function open(opts: {
  getProjectRoot: () => string
  getProjectIdentity?: () => { appId: string | null; projectPath: string }
}): Promise<WorkbenchCoiServer> {
  const server = await startWorkbenchCoiServer({ rootDir, ...opts })
  servers.push(server)
  return server
}

/** Closes and un-tracks one session, so a later afterEach does not double-close it. */
async function close(server: WorkbenchCoiServer): Promise<void> {
  await server.close()
  servers = servers.filter((s) => s !== server)
}

beforeEach(async () => {
  tmpParent = await fs.mkdtemp(path.join(os.tmpdir(), 'coi-host-test-'))
  rootDir = path.join(tmpParent, 'bundle')
  await fs.mkdir(rootDir, { recursive: true })
  await fs.writeFile(path.join(rootDir, 'index.html'), '<!doctype html>bundle')
  servers = []
})

afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()))
  servers = []
  // A window's own close() deliberately leaves the listener up (see the
  // module doc), so it takes a separate call to bring the port down between
  // tests — otherwise every test after the first would find it already bound.
  await closeAllCoiHosts()
  await fs.rm(tmpParent, { recursive: true, force: true })
})

describe('shared origin across windows of the same bundle', () => {
  it('gives two windows the same origin and port but distinct base URLs', async () => {
    const a = await open({ getProjectRoot: () => '' })
    const b = await open({ getProjectRoot: () => '' })

    // Browser storage (IndexedDB, OPFS, Cache Storage, service worker
    // registrations, Web Locks, BroadcastChannel) is keyed by origin —
    // scheme + host + PORT. Two windows on different ports are two windows
    // that can never see each other's storage, so a window that closes and
    // reopens the same project would find its VS Code workspace memento gone
    // even though nothing was ever deleted.
    expect(new URL(a.baseUrl).origin).toBe(new URL(b.baseUrl).origin)
    expect(a.port).toBe(b.port)
    expect(a.baseUrl).not.toBe(b.baseUrl)
  })
})

describe('per-window routing on the shared listener', () => {
  it('routes each window to its own project root and its own /__project identity', async () => {
    const projectA = path.join(tmpParent, 'project-a')
    const projectB = path.join(tmpParent, 'project-b')
    await fs.mkdir(projectA, { recursive: true })
    await fs.mkdir(projectB, { recursive: true })
    await fs.writeFile(path.join(projectA, 'shared-name.txt'), 'from A')
    await fs.writeFile(path.join(projectB, 'shared-name.txt'), 'from B')

    const a = await open({
      getProjectRoot: () => projectA,
      getProjectIdentity: () => ({ appId: 'wx-a', projectPath: projectA }),
    })
    const b = await open({
      getProjectRoot: () => projectB,
      getProjectIdentity: () => ({ appId: 'wx-b', projectPath: projectB }),
    })

    const fileA = await fetch(`${a.baseUrl}__fs/read?p=shared-name.txt`)
    const fileB = await fetch(`${b.baseUrl}__fs/read?p=shared-name.txt`)
    expect(await fileA.text()).toBe('from A')
    expect(await fileB.text()).toBe('from B')

    const projectIdA = (await (await fetch(`${a.baseUrl}__project`)).json()) as { workspaceId: string | null }
    const projectIdB = (await (await fetch(`${b.baseUrl}__project`)).json()) as { workspaceId: string | null }
    expect(projectIdA.workspaceId).toBeTruthy()
    expect(projectIdB.workspaceId).toBeTruthy()
    expect(projectIdA.workspaceId).not.toBe(projectIdB.workspaceId)
  })
})

describe('a released window prefix is not reused for another window', () => {
  it('answers 404 — never window B\'s data — once window A has closed', async () => {
    const projectA = path.join(tmpParent, 'project-a')
    const projectB = path.join(tmpParent, 'project-b')
    await fs.mkdir(projectA, { recursive: true })
    await fs.mkdir(projectB, { recursive: true })
    await fs.writeFile(path.join(projectB, 'note.txt'), 'B secret')

    const a = await open({ getProjectRoot: () => projectA })
    // Kept alive (unused beyond registering) so the host has another live
    // session — the case this guards against is a stale token being handed
    // ANOTHER window's data, not merely "no windows left".
    const _b = await open({
      getProjectRoot: () => projectB,
      getProjectIdentity: () => ({ appId: 'wx-b', projectPath: projectB }),
    })
    const staleBaseUrl = a.baseUrl
    await close(a)

    const fsRes = await fetch(`${staleBaseUrl}__fs/read?p=note.txt`)
    expect(fsRes.status).toBe(404)
    expect(await fsRes.text()).not.toContain('B secret')

    const projectRes = await fetch(`${staleBaseUrl}__project`)
    expect(projectRes.status).toBe(404)

    // A stale prefix has no live session for ANY path under it, not just the
    // bridge endpoints — it must not quietly fall back to serving the shared
    // bundle either, or a closed window's URL would keep looking "alive".
    const assetRes = await fetch(`${staleBaseUrl}index.html`)
    expect(assetRes.status).toBe(404)
  })
})

describe('closing one window does not disturb another', () => {
  it('keeps window B serving after window A closes', async () => {
    const projectA = path.join(tmpParent, 'project-a')
    const projectB = path.join(tmpParent, 'project-b')
    await fs.mkdir(projectA, { recursive: true })
    await fs.mkdir(projectB, { recursive: true })
    await fs.writeFile(path.join(projectB, 'note.txt'), 'still here')

    const a = await open({ getProjectRoot: () => projectA })
    const b = await open({ getProjectRoot: () => projectB })
    await close(a)

    const res = await fetch(`${b.baseUrl}__fs/read?p=note.txt`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('still here')
  })
})

describe('the shared listener survives the last window closing', () => {
  it('gives the next window the same origin and port a closed window used, reachable through its own prefix', async () => {
    const a = await open({ getProjectRoot: () => '' })
    const originA = new URL(a.baseUrl).origin
    const portA = a.port

    // Closing every window (down to zero) is an ordinary project switch, not
    // process shutdown — the fix this guards is the listener (and therefore
    // the origin) being torn down here and the next window landing on a
    // fresh port, which would strand the previous project's IndexedDB state
    // on an origin nothing will ever visit again.
    await close(a)

    const b = await open({ getProjectRoot: () => '' })
    expect(new URL(b.baseUrl).origin).toBe(originA)
    expect(b.port).toBe(portA)

    const res = await fetch(`${b.baseUrl}index.html`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<!doctype html>bundle')
  })
})

describe('closeAllCoiHosts', () => {
  it('refuses new connections on the port once called, even with a session still registered', async () => {
    const a = await open({ getProjectRoot: () => '' })
    const port = a.port

    await closeAllCoiHosts()

    await new Promise<void>((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => {
        socket.destroy()
        reject(new Error('connected to a port that should have been released'))
      })
      socket.on('error', () => resolve())
    })
  })

  it('lets the next window start a fresh listener that serves normally', async () => {
    // Registered but otherwise unused — closeAllCoiHosts must tear the host
    // down even with a live session on it, not only when the last window has
    // already released.
    const _a = await open({ getProjectRoot: () => '' })
    await closeAllCoiHosts()

    const b = await open({ getProjectRoot: () => '' })
    const res = await fetch(`${b.baseUrl}index.html`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<!doctype html>bundle')
  })
})

describe('bridge endpoints require the window prefix; the bundle does not', () => {
  it('answers 404 to /__fs, /__project and /__filetypes with no /w/<token> prefix', async () => {
    const a = await open({ getProjectRoot: () => '' })
    const origin = new URL(a.baseUrl).origin

    const results = await Promise.all(
      ['/__fs/read?p=x', '/__project', '/__filetypes'].map((p) => fetch(origin + p)),
    )
    for (const res of results) expect(res.status).toBe(404)
  })

  it('still serves the bundle itself with no window prefix (project-independent asset)', async () => {
    const a = await open({ getProjectRoot: () => '' })
    const origin = new URL(a.baseUrl).origin

    const res = await fetch(`${origin}/index.html`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<!doctype html>bundle')
  })
})

describe('cross-origin-isolation headers on the shared listener', () => {
  it('sends COOP same-origin + COEP require-corp + CORP same-origin on both prefixed and bare-origin responses', async () => {
    const a = await open({ getProjectRoot: () => '' })
    const origin = new URL(a.baseUrl).origin

    const prefixed = await fetch(`${a.baseUrl}__filetypes`)
    const bare = await fetch(`${origin}/index.html`)
    for (const res of [prefixed, bare]) {
      expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin')
      expect(res.headers.get('cross-origin-embedder-policy')).toBe('require-corp')
      expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    }
  })

  it('still carries the isolation headers on a 404 response', async () => {
    // setIsolationHeaders runs before any routing decision, so even a path
    // nothing serves must carry it — a 404 that dropped isolation would break
    // the workbench's SharedArrayBuffer gate the moment a request 404s.
    const a = await open({ getProjectRoot: () => '' })
    const res = await fetch(`${a.baseUrl}no-such-file.js`)
    expect(res.status).toBe(404)
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin')
    expect(res.headers.get('cross-origin-embedder-policy')).toBe('require-corp')
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin')
  })
})

describe('prefix stripping copies the URL instead of re-parsing the remainder', () => {
  it('keeps a `//` remainder as a literal pathname rather than reading it as an authority', async () => {
    let captured: URL | null = null
    const session: CoiHostSession = {
      handle: (_req, res, url) => { captured = url; res.writeHead(200); res.end('ok') },
    }
    const reg = await registerCoiHostSession({ rootDir, extensionsDir: null, session })

    // `/w/<token>//__project?x=1`: re-parsing `//__project?x=1` as a URL
    // reference would read the leading `//` as a network-path authority,
    // turning `__project` into the host and collapsing pathname to `/`.
    const res = await rawGet(reg.port, `/w/${reg.token}//__project?x=1`)
    expect(res.status).toBe(200)
    expect(captured).not.toBeNull()
    expect(captured!.pathname).toBe('//__project')
    expect(captured!.search).toBe('?x=1')
    expect(captured!.host).toBe('127.0.0.1')

    await reg.release()
  })

  it('preserves the query string on an ordinary single-slash path', async () => {
    let captured: URL | null = null
    const session: CoiHostSession = {
      handle: (_req, res, url) => { captured = url; res.writeHead(200); res.end('ok') },
    }
    const reg = await registerCoiHostSession({ rootDir, extensionsDir: null, session })

    const res = await rawGet(reg.port, `/w/${reg.token}/__project?x=1`)
    expect(res.status).toBe(200)
    expect(captured!.pathname).toBe('/__project')
    expect(captured!.search).toBe('?x=1')

    await reg.release()
  })
})

describe('malformed percent-encoding with no window prefix', () => {
  it('answers 400 rather than crashing the request handler, and the listener keeps serving', async () => {
    const reg = await registerCoiHostSession({ rootDir, extensionsDir: null, session: okSession() })

    // A bare '%' fails decodeURIComponent; unprefixed paths are the ones
    // workbench-coi-host.ts decodes itself (routed paths are forwarded raw).
    const bad = await rawGet(reg.port, '/%')
    expect(bad.status).toBe(400)

    // The throw must not have taken the shared listener down with it.
    const ok = await rawGet(reg.port, `/w/${reg.token}/still-alive`)
    expect(ok.status).toBe(200)

    await reg.release()
  })
})

describe('a session handler that throws while forwarding a routed request', () => {
  it('answers 500 and logs it, because a handler answers its own client errors', async () => {
    // A window handler decodes and rejects the client's own mistakes itself (a
    // stray '%' is answered 400 inside the session), so a throw that reaches
    // the shared listener is a defect in that handler. A silent 400 here would
    // read as the caller's fault and hide the bug for good.
    const throwing: CoiHostSession = {
      handle: () => { throw new Error('defect in the window handler') },
    }
    const bad = await registerCoiHostSession({ rootDir, extensionsDir: null, session: throwing })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const res = await rawGet(bad.port, `/w/${bad.token}/whatever`)
      expect(res.status).toBe(500)
      expect(res.body).toBe('Internal Server Error')
      expect(logged).toHaveBeenCalled()
    } finally {
      // Restored inside the test rather than from an afterEach, so no later
      // test in this file runs with console.error swallowed.
      logged.mockRestore()
    }

    // A second session on the same shared host — not just another path
    // through the session that threw — proves the listener itself survived,
    // not merely that the throwing session recovered.
    const good = await registerCoiHostSession({ rootDir, extensionsDir: null, session: okSession() })
    const ok = await rawGet(good.port, `/w/${good.token}/ping`)
    expect(ok.status).toBe(200)

    await bad.release()
    await good.release()
  })

  it('destroys the response when the throw lands after the header is already sent', async () => {
    // Nothing can be turned into a 500 once the header has been written —
    // writing a second one throws again, inside the boundary that exists to
    // catch throws, and the response would then be left hanging on a
    // Content-Length it never satisfies. Dropping the connection is the only
    // answer left, and it is what a client sees for any interrupted response.
    const throwing: CoiHostSession = {
      handle: (_req, res) => {
        res.writeHead(200, { 'Content-Length': '32' })
        res.write('partial')
        throw new Error('defect after the header went out')
      },
    }
    const bad = await registerCoiHostSession({ rootDir, extensionsDir: null, session: throwing })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const res = await rawGet(bad.port, `/w/${bad.token}/whatever`)
      expect(res.completed).toBe(false)
      expect(res.body).not.toContain('Internal Server Error')
      expect(logged).toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }

    const good = await registerCoiHostSession({ rootDir, extensionsDir: null, session: okSession() })
    const ok = await rawGet(good.port, `/w/${good.token}/ping`)
    expect(ok.status).toBe(200)

    await bad.release()
    await good.release()
  })
})

describe('host cache key does not collide on a naive pipe-joined key', () => {
  it('gives two (rootDir, extensionsDir) pairs that would collide as `a|b` distinct hosts', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'coi-key-test-'))
    const a = path.join(tmp, 'a')
    const b = path.join(tmp, 'b')
    const c = path.join(tmp, 'c')
    await fs.mkdir(a, { recursive: true })
    await fs.mkdir(b, { recursive: true })
    await fs.mkdir(c, { recursive: true })

    // Naively joined with '|' (`rootDir + '|' + extensionsDir`) these two
    // pairs both serialize to the same string `<a>|<b>|<c>` and would collide
    // onto one host — the second bundle would read the first bundle's files.
    const reg1 = await registerCoiHostSession({ rootDir: a, extensionsDir: `${b}|${c}`, session: okSession() })
    const reg2 = await registerCoiHostSession({ rootDir: `${a}|${b}`, extensionsDir: c, session: okSession() })

    expect(reg1.port).not.toBe(reg2.port)

    await reg1.release()
    await reg2.release()
    await fs.rm(tmp, { recursive: true, force: true })
  })
})

describe('closeAllCoiHosts gate on registration', () => {
  it('waits out a concurrent full close instead of handing back an origin about to die', async () => {
    const first = await registerCoiHostSession({ rootDir, extensionsDir: null, session: okSession() })
    const firstPort = first.port

    // closeAllCoiHosts runs synchronously up to its first await (setting the
    // `closingAll` gate) before this expression yields, so registration
    // deterministically observes the gate already up rather than racing it.
    const [, second] = await Promise.all([
      closeAllCoiHosts(),
      registerCoiHostSession({ rootDir, extensionsDir: null, session: okSession() }),
    ])

    // A fresh host, not a reuse of the one that just went down.
    expect(second.port).not.toBe(firstPort)

    const res = await rawGet(second.port, `/w/${second.token}/ping`)
    expect(res.status).toBe(200)

    await second.release()
  })

  it('does not throw when closeAllCoiHosts is called concurrently more than once', async () => {
    await registerCoiHostSession({ rootDir, extensionsDir: null, session: okSession() })

    await expect(
      Promise.all([closeAllCoiHosts(), closeAllCoiHosts(), closeAllCoiHosts()]),
    ).resolves.toBeDefined()
  })
})
