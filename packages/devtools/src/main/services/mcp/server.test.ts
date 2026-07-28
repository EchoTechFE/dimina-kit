/**
 * `startMcpServer` must give each incoming SSE connection its own `McpServer`.
 *
 * Today `startMcpServer` calls `buildServer()` ONCE and reuses that single
 * `McpServer` for every `/sse` connection via `await server.connect(transport)`.
 * The `@modelcontextprotocol/sdk`'s `Protocol.connect()` throws "Already
 * connected to a transport..." synchronously the second time it is called
 * while a transport is still attached (`this._transport` stays set until
 * `close()`), because it throws BEFORE calling `transport.start()`, a second
 * concurrent `/sse` client's response never gets `writeHead`/`write` called at
 * all — the request just hangs — and the thrown error escapes the request
 * handler (`createServer(async (req, res) => { ... await server.connect(...) })`
 * has no `.catch`) as a process-level `unhandledRejection`.
 *
 * These tests drive the REAL http server `startMcpServer` stands up (loopback,
 * ephemeral port) with real concurrent `GET /sse` + `POST /message` traffic —
 * no mocking of the HTTP/SSE transport layer itself — so they fail for the
 * actual production symptom (second connection hangs; the fix's contract is a
 * fresh `McpServer` per connection) rather than a mocked stand-in for it.
 *
 * `connectTarget`/`setCdpPort` from `./target-manager.js` are stubbed: the
 * real implementations perform actual CDP network calls (`chrome-remote-
 * interface`) against `resolvedCdpPort`, which nothing is listening on in this
 * test and which is irrelevant to the SSE-transport bug under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Disposable } from '@dimina-kit/electron-deck/main'

vi.mock('./target-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./target-manager.js')>()
  return {
    ...actual,
    connectTarget: vi.fn(async () => {}),
    setCdpPort: vi.fn(),
  }
})

import { startMcpServer } from './server.js'

// ── HTTP test helpers ────────────────────────────────────────────────────

/** Binds to an ephemeral port, closes immediately, and hands back the number
 * so `startMcpServer` can be started on a genuinely free loopback port. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo
      srv.close(() => resolve(port))
    })
  })
}

/** `startMcpServer` calls `httpServer.listen()` but does not expose a "ready"
 * promise, so poll a raw TCP connect until the port accepts connections. */
async function waitForListening(port: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port }, () => {
        sock.end()
        resolve(true)
      })
      sock.on('error', () => resolve(false))
    })
    if (ok) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`server on port ${port} never started listening within ${timeoutMs}ms`)
}

interface SseConnection {
  req: http.ClientRequest
  res: http.IncomingMessage
  sessionId: string
}

/**
 * Opens `GET /sse` and resolves once the transport's initial `event: endpoint`
 * SSE frame arrives (proof the connection is actually wired up, not merely
 * that headers were sent). Deliberately does NOT close the connection —
 * callers own `conn.req` and must destroy it during cleanup — so the stream
 * stays open exactly like a real long-lived MCP client.
 *
 * Under the "Already connected to a transport" bug, a second concurrent
 * connection's `server.connect()` throws BEFORE `transport.start()` writes
 * any header or SSE frame, so the request never receives a response at all;
 * this shows up here as a timeout, not an HTTP error status.
 */
function openSse(port: number, timeoutMs = 3000): Promise<SseConnection> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy()
      reject(
        new Error(
          `GET /sse timed out after ${timeoutMs}ms with no response — consistent with the server hanging on "Already connected to a transport"`,
        ),
      )
    }, timeoutMs)

    const req = http.get({ host: '127.0.0.1', port, path: '/sse' }, (res) => {
      if (res.statusCode !== 200) {
        clearTimeout(timer)
        reject(new Error(`GET /sse returned status ${res.statusCode}`))
        return
      }
      let buf = ''
      const onData = (chunk: Buffer) => {
        buf += chunk.toString('utf8')
        const m = buf.match(/event: endpoint\ndata: (\/message\?sessionId=[^\n]+)\n\n/)
        if (m) {
          clearTimeout(timer)
          res.off('data', onData)
          const sessionId = new URL(m[1], 'http://localhost').searchParams.get('sessionId')
          if (!sessionId) {
            reject(new Error('endpoint SSE frame carried no sessionId'))
            return
          }
          resolve({ req, res, sessionId })
        }
      }
      res.on('data', onData)
      res.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
    req.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/** Minimal MCP `initialize` JSON-RPC POST against an established session. */
function postInitialize(port: number, sessionId: string, id: number): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'server.test', version: '0.0.0' },
    },
  })
  const data = Buffer.from(payload, 'utf8')
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/message?sessionId=${encodeURIComponent(sessionId)}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

// ── Test lifecycle ───────────────────────────────────────────────────────

let disposable: Disposable | null = null
let port = 0
const openReqs: http.ClientRequest[] = []

beforeEach(async () => {
  port = await getFreePort()
  // resolvedCdpPort is irrelevant: connectTarget/setCdpPort are stubbed above.
  disposable = startMcpServer(19222, port)
  await waitForListening(port)
})

afterEach(async () => {
  for (const req of openReqs.splice(0)) req.destroy()
  if (disposable) {
    await disposable.dispose()
    disposable = null
  }
})

// ── Contract ──────────────────────────────────────────────────────────────

describe('startMcpServer: one McpServer per SSE connection', () => {
  it('two concurrent SSE connections both succeed with distinct usable sessions', async () => {
    const conn1 = await openSse(port)
    openReqs.push(conn1.req)

    // conn1 stays open (never closed) while conn2 connects — this is exactly
    // the condition that trips "Already connected to a transport" on a
    // shared McpServer instance.
    const conn2 = await openSse(port)
    openReqs.push(conn2.req)

    expect(conn1.sessionId).not.toBe(conn2.sessionId)

    const [r1, r2] = await Promise.all([
      postInitialize(port, conn1.sessionId, 1),
      postInitialize(port, conn2.sessionId, 2),
    ])

    // handlePostMessage responds 500 ("SSE connection not established") when
    // the transport's start() never ran (connect() threw first) and 404 when
    // the session id was never registered at all.
    expect(r1.status).toBe(202)
    expect(r2.status).toBe(202)
  }, 10000)

  it('N truly-concurrent SSE opens (fired without awaiting each other) all succeed', async () => {
    const N = 3
    // Fire all opens in the same tick — do NOT await between them — so this
    // actually exercises overlap rather than accidentally serializing.
    const opens = Array.from({ length: N }, () => openSse(port))

    const conns = await Promise.all(opens)
    for (const c of conns) openReqs.push(c.req)

    const sessionIds = conns.map((c) => c.sessionId)
    expect(new Set(sessionIds).size).toBe(N) // all distinct

    const results = await Promise.all(
      conns.map((c, i) => postInitialize(port, c.sessionId, i + 1)),
    )
    for (const r of results) {
      expect(r.status).toBe(202)
    }
  }, 10000)

  it('no unhandledRejection escapes during concurrent SSE connections', async () => {
    const unhandled: unknown[] = []
    const probe = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', probe)

    try {
      const N = 3
      const opens = Array.from({ length: N }, () => openSse(port))
      const settled = await Promise.allSettled(opens)
      for (const s of settled) {
        if (s.status === 'fulfilled') openReqs.push(s.value.req)
      }

      // Let any promise-rejection-with-no-handler surface: Node reports
      // unhandledRejection once the microtask queue drains for that turn.
      await new Promise((r) => setTimeout(r, 100))
      await new Promise((r) => setImmediate(r))

      const escaped = unhandled.filter(
        (e) => e instanceof Error && e.message.includes('Already connected to a transport'),
      )
      expect(
        escaped,
        `"Already connected to a transport" escaped as an unhandledRejection: ${escaped.map((e) => String(e)).join('; ')}`,
      ).toHaveLength(0)

      // Every connection must have actually succeeded too — a caught-but-
      // still-broken failure (e.g. connection silently dropped) is not a fix.
      for (const s of settled) {
        expect(s.status, s.status === 'rejected' ? String((s as PromiseRejectedResult).reason) : '').toBe('fulfilled')
      }
    } finally {
      process.off('unhandledRejection', probe)
    }
  }, 10000)
})
