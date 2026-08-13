/**
 * E2E (native-host): close-race semantics of wx.connectSocket / SocketTask.close
 * driven from the service realm against a recording echo server.
 *
 * A close issued before open settles through the native bridge with exactly
 * one onClose carrying the caller's code/reason and no onOpen/onError. A
 * delaying TCP relay makes the in-flight-handshake case deterministic.
 *
 * wx.closeSocket with an already-dead bound connection reports
 * 'closeSocket:fail WebSocket is not connected' and leaves other SocketTask
 * connections untouched.
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import fs from 'fs'
import net, { type AddressInfo } from 'net'
import path from 'path'
import { fileURLToPath } from 'url'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  closeSecureWebSocketTestServer,
  createSecureWebSocketTestServer,
  secureWebSocketTestUrl,
  WEBSOCKET_TEST_CA_PATH,
} from './fixtures/websocket-tls'
import {
  closeProject,
  evalInWebContentsByUrl,
  openProject,
  pollUntil,
  waitForSimulatorWebview,
} from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')

interface AppHandle {
  app: ElectronApplication
  win: PwPage
}

interface ServerConn {
  messages: string[]
  closed: boolean
  socket: WebSocket
}

interface CloseResult {
  ok: boolean
  errMsg: string | null
}

interface CapState {
  success: boolean
  fail: string | null
  openCount: number
  messages: string[]
  errors: string[]
  closes: Array<{ code: number; reason: string }>
  events: number
  closeResult: CloseResult | null
}

let wss: WebSocketServer
let socketUrl: string
const serverConns: ServerConn[] = []

test.beforeAll(async () => {
  wss = createSecureWebSocketTestServer()
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', resolve)
    wss.once('error', reject)
  })
  const { port } = wss.address() as AddressInfo
  socketUrl = secureWebSocketTestUrl(port)
  wss.on('connection', (socket) => {
    const conn: ServerConn = { messages: [], closed: false, socket }
    serverConns.push(conn)
    socket.on('message', (data, isBinary) => {
      const text = isBinary ? `[binary:${data.byteLength}]` : data.toString()
      conn.messages.push(text)
      if (socket.readyState === 1) socket.send(`echo:${text}`)
    })
    socket.on('close', () => {
      conn.closed = true
    })
  })
})

test.afterAll(async () => {
  for (const conn of serverConns) {
    if (!conn.closed) conn.socket.terminate()
  }
  await closeSecureWebSocketTestServer(wss)
})

async function bootApp(): Promise<AppHandle> {
  const appPath = path.resolve(__dirname, 'electron-entry.js')
  const userDataDir = path.resolve(
    process.env.DIMINA_DEVTOOLS_DATA_DIR
      ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'electron-runtime-e2e'),
    'userdata',
    `nh-ws-close-race-${process.pid}`,
  )
  fs.mkdirSync(userDataDir, { recursive: true })

  const app = await _electron.launch({
    args: [appPath, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      NODE_EXTRA_CA_CERTS: WEBSOCKET_TEST_CA_PATH,
      DIMINA_E2E_USER_DATA_DIR: userDataDir,
    },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (window && !window.isVisible()) {
      await new Promise<void>((resolve) => {
        window.once('show', resolve)
        setTimeout(resolve, 5000)
      })
    }
    if (window) {
      window.setPosition(-2000, -2000)
      window.blur()
    }
  })

  await openProject(app, FIXTURE_DIR)
  await waitForSimulatorWebview(app)
  await pollUntil(
    () => evalInWebContentsByUrl<boolean>(
      app,
      'service.html',
      `typeof wx !== 'undefined' && typeof wx.connectSocket === 'function'`,
    ).catch(() => false),
    (ready) => ready === true,
    20_000,
    500,
  )
  return { app, win }
}

async function shutdownApp(handle: AppHandle | undefined): Promise<void> {
  if (!handle) return
  await closeProject(handle.app).catch(() => {})
  await handle.app.close().catch(() => {})
}

const waitMs = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms))

interface RelayHandle {
  port: number
  close: () => Promise<void>
}

// Holds the client's initial writes (the HTTP upgrade request) for delayMs so
// a close issued right after connect deterministically lands mid-handshake.
// Server bytes flow back immediately; a client teardown only tears the relay's
// server leg down after the held handshake was flushed, so the echo server
// still observes the connection arrive and then go away.
async function startHandshakeDelayRelay(targetPort: number, delayMs: number): Promise<RelayHandle> {
  const relay = net.createServer((client) => {
    const target = net.connect(targetPort, '127.0.0.1')
    const held: Buffer[] = []
    let released = false
    let clientGone = false
    const release = () => {
      if (released) return
      released = true
      for (const chunk of held) {
        if (!target.destroyed) target.write(chunk)
      }
      held.length = 0
      if (clientGone) setTimeout(() => target.destroy(), 50)
    }
    setTimeout(release, delayMs)
    client.on('data', (chunk) => {
      if (released) {
        if (!target.destroyed) target.write(chunk)
        return
      }
      held.push(chunk)
    })
    target.on('data', (chunk) => {
      if (!client.destroyed) client.write(chunk)
    })
    target.on('close', () => client.destroy())
    target.on('error', () => client.destroy())
    client.on('close', () => {
      clientGone = true
      if (released) target.destroy()
    })
    client.on('error', () => {})
  })
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve))
  const { port } = relay.address() as AddressInfo
  return { port, close: () => new Promise<void>((resolve) => relay.close(() => resolve())) }
}

async function evalService<T>(app: ElectronApplication, expression: string): Promise<T> {
  return evalInWebContentsByUrl<T>(app, 'service.html', expression)
}

async function readCap(app: ElectronApplication, name: string): Promise<CapState> {
  return evalService<CapState>(app, `globalThis.__wsPolicy.conns[${JSON.stringify(name)}].cap`)
}

const JS_CLEANUP = `(() => {
  var g = globalThis;
  if (!g.__wsPolicy) return true;
  for (var i = 0; i < g.__wsPolicy.reg.length; i++) {
    try { g.__wsPolicy.reg[i].close({ fail: function () {} }); } catch (e) {}
  }
  g.__wsPolicy.reg = [];
  g.__wsPolicy.conns = {};
  return true;
})()`

const JS_CAP_INIT = `var cap = { success: false, fail: null, openCount: 0, messages: [], errors: [], closes: [], events: 0, closeResult: null };`

const JS_CAP_WIRE = `
    task.onOpen(function () { cap.openCount += 1; cap.events += 1; });
    task.onMessage(function (e) { cap.messages.push(typeof e.data === 'string' ? e.data : '[binary]'); cap.events += 1; });
    task.onError(function (e) { cap.errors.push((e && e.errMsg) || String(e)); cap.events += 1; });
    task.onClose(function (e) { cap.closes.push({ code: e.code, reason: e.reason }); cap.events += 1; });`

function jsConnect(url: string, name: string): string {
  return `(() => {
    var g = globalThis;
    g.__wsPolicy = g.__wsPolicy || { conns: {}, reg: [] };
    ${JS_CAP_INIT}
    var task = wx.connectSocket({
      url: ${JSON.stringify(url)},
      success: function () { cap.success = true; },
      fail: function (e) { cap.fail = (e && e.errMsg) || String(e); },
    });${JS_CAP_WIRE}
    g.__wsPolicy.conns[${JSON.stringify(name)}] = { task: task, cap: cap };
    g.__wsPolicy.reg.push(task);
    return true;
  })()`
}

function jsConnectThenCloseSync(url: string, name: string, code: number, reason: string): string {
  return `(() => {
    var g = globalThis;
    g.__wsPolicy = g.__wsPolicy || { conns: {}, reg: [] };
    ${JS_CAP_INIT}
    var task = wx.connectSocket({
      url: ${JSON.stringify(url)},
      success: function () { cap.success = true; },
      fail: function (e) { cap.fail = (e && e.errMsg) || String(e); },
    });${JS_CAP_WIRE}
    task.close({
      code: ${code},
      reason: ${JSON.stringify(reason)},
      success: function (r) { cap.closeResult = { ok: true, errMsg: (r && r.errMsg) || null }; },
      fail: function (e) { cap.closeResult = { ok: false, errMsg: (e && e.errMsg) || String(e) }; },
    });
    g.__wsPolicy.conns[${JSON.stringify(name)}] = { task: task, cap: cap };
    g.__wsPolicy.reg.push(task);
    return true;
  })()`
}

function jsTaskClose(name: string, code?: number, reason?: string): string {
  const opts: Record<string, unknown> = {}
  if (code !== undefined) opts.code = code
  if (reason !== undefined) opts.reason = reason
  return `new Promise((resolve) => {
    var entry = globalThis.__wsPolicy.conns[${JSON.stringify(name)}];
    var opts = ${JSON.stringify(opts)};
    opts.success = function (r) { resolve({ ok: true, errMsg: (r && r.errMsg) || null }); };
    opts.fail = function (e) { resolve({ ok: false, errMsg: (e && e.errMsg) || String(e) }); };
    entry.task.close(opts);
  })`
}

function jsDoubleTaskClose(name: string): string {
  return `new Promise((resolve) => {
    var task = globalThis.__wsPolicy.conns[${JSON.stringify(name)}].task;
    var results = [];
    var settle = function (label, ok, response) {
      results.push({ label: label, ok: ok, errMsg: (response && response.errMsg) || String(response) });
      if (results.length === 2) resolve(results);
    };
    task.close({
      code: 4001,
      reason: 'first',
      success: function (r) { settle('first', true, r); },
      fail: function (e) { settle('first', false, e); },
    });
    task.close({
      code: 4002,
      reason: 'second',
      success: function (r) { settle('second', true, r); },
      fail: function (e) { settle('second', false, e); },
    });
  })`
}

function jsGlobalClose(): string {
  return `new Promise((resolve) => {
    wx.closeSocket({
      success: function (r) { resolve({ ok: true, errMsg: (r && r.errMsg) || null }); },
      fail: function (e) { resolve({ ok: false, errMsg: (e && e.errMsg) || String(e) }); },
    });
  })`
}

async function expectOpen(app: ElectronApplication, name: string, connIndex: number): Promise<void> {
  expect(
    await pollUntil(async () => (await readCap(app, name)).openCount > 0, (v) => v, 15_000, 250),
    `connection ${name} must open`,
  ).toBe(true)
  expect(
    await pollUntil(() => Promise.resolve(serverConns.length > connIndex), (v) => v, 5_000, 100),
    'server must accept the connection',
  ).toBe(true)
}

async function expectServerClosed(connIndex: number, label: string): Promise<void> {
  expect(
    await pollUntil(() => Promise.resolve(serverConns[connIndex]?.closed ?? false), (v) => v, 5_000, 100),
    `server must observe ${label} closing`,
  ).toBe(true)
}

test.describe('native-host wx.connectSocket close-race policy', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  let handle: AppHandle | undefined

  test.beforeAll(async () => {
    test.setTimeout(180_000)
    handle = await bootApp()
  })

  test.afterAll(async () => {
    await shutdownApp(handle)
  })

  test.afterEach(async () => {
    if (!handle) return
    await evalService(handle.app, JS_CLEANUP).catch(() => {})
    await handle.win.waitForTimeout(300)
  })

  test('settles a same-tick connect-then-close without ever hitting the network', async () => {
    const app = handle!.app
    const connBase = serverConns.length
    await evalService(app, jsConnectThenCloseSync(socketUrl, 'sync', 4001, 'bye'))

    const settled = await pollUntil(() => readCap(app, 'sync'), (c) => c.closeResult !== null, 5_000, 100)
    expect(settled.closeResult, `close result: ${JSON.stringify(settled)}`)
      .toEqual({ ok: true, errMsg: 'closeSocket:ok' })

    const cap = await pollUntil(() => readCap(app, 'sync'), (c) => c.closes.length > 0, 5_000, 100)
    expect(cap.closes, `capture: ${JSON.stringify(cap)}`).toEqual([{ code: 4001, reason: 'bye' }])
    expect(cap.openCount, 'onOpen must not fire').toBe(0)
    expect(cap.errors, `onError must not fire: ${JSON.stringify(cap.errors)}`).toEqual([])

    await waitMs(500)
    expect(
      serverConns.length,
      `no connection may reach the echo server (zombie): ${JSON.stringify(serverConns.map((c) => c.messages))}`,
    ).toBe(connBase)
  })

  test('settles a close issued during the handshake with exactly one onClose and no onError', async () => {
    const app = handle!.app
    const wsPort = new URL(socketUrl).port
    const relay = await startHandshakeDelayRelay(Number(wsPort), 300)
    const relayUrl = secureWebSocketTestUrl(relay.port)
    const connBase = serverConns.length
    try {
      await evalService(app, jsConnect(relayUrl, 'hs'))
      const close = await evalService<CloseResult>(app, jsTaskClose('hs', 4001, 'race-bye'))
      expect(close.ok, `close during handshake: ${JSON.stringify(close)}`).toBe(true)
      expect(close.errMsg).toBe('closeSocket:ok')

      const cap = await pollUntil(() => readCap(app, 'hs'), (c) => c.closes.length > 0, 8_000, 100)
      expect(cap.closes, `capture: ${JSON.stringify(cap)}`).toHaveLength(1)
      expect([1000, 4001], `close code: ${JSON.stringify(cap.closes)}`).toContain(cap.closes[0]!.code)
      expect(cap.errors, `onError must not fire: ${JSON.stringify(cap.errors)}`).toEqual([])

      await waitMs(500)
      expect(serverConns.length, 'a cancelled handshake must not reach the WebSocket server').toBe(connBase)

      const quiescent = await readCap(app, 'hs')
      await waitMs(300)
      const after = await readCap(app, 'hs')
      expect(
        after.events,
        `no further events after the close: before=${JSON.stringify(quiescent)} after=${JSON.stringify(after)}`,
      ).toBe(quiescent.events)
      expect(after.closes).toHaveLength(1)
    } finally {
      await relay.close()
    }
  })

  test('a second SocketTask.close during the close handshake fails without a second close event', async () => {
    const app = handle!.app
    const conn = serverConns.length
    await evalService(app, jsConnect(socketUrl, 'double'))
    await expectOpen(app, 'double', conn)

    const results = await evalService<Array<CloseResult & { label: string }>>(app, jsDoubleTaskClose('double'))
    expect(results.sort((left, right) => left.label.localeCompare(right.label))).toEqual([
      { label: 'first', ok: true, errMsg: 'closeSocket:ok' },
      { label: 'second', ok: false, errMsg: 'closeSocket:fail WebSocket is not connected' },
    ])
    await expectServerClosed(conn, 'the first close handshake')
    const cap = await readCap(app, 'double')
    expect(cap.closes).toEqual([{ code: 4001, reason: 'first' }])
  })

  test('wx.closeSocket with a dead bound connection reports failure and leaves other tasks open', async () => {
    const app = handle!.app
    const connA = serverConns.length
    await evalService(app, jsConnect(socketUrl, 'A'))
    await expectOpen(app, 'A', connA)
    const connB = serverConns.length
    await evalService(app, jsConnect(socketUrl, 'B'))
    await expectOpen(app, 'B', connB)

    const closeA = await evalService<CloseResult>(app, jsTaskClose('A'))
    expect(closeA.ok, `close A: ${JSON.stringify(closeA)}`).toBe(true)
    await pollUntil(() => readCap(app, 'A'), (c) => c.closes.length > 0, 5_000, 100)
    await expectServerClosed(connA, 'A')

    const result = await evalService<CloseResult>(app, jsGlobalClose())
    expect(result.ok, `wx.closeSocket with a dead bound connection: ${JSON.stringify(result)}`).toBe(false)
    expect(result.errMsg).toBe('closeSocket:fail WebSocket is not connected')
    await waitMs(300)
    expect(serverConns[connB]?.closed, 'B remains owned by its SocketTask').toBe(false)
    await evalService(app, jsTaskClose('B'))
    await expectServerClosed(connB, 'B')
  })
})
