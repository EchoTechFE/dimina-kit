/**
 * E2E (native-host): WeChat-aligned legacy global socket interface semantics,
 * driven from the service realm against a recording echo server.
 *
 * The legacy wx.sendSocketMessage / wx.closeSocket / wx.onSocketMessage pair
 * binds the FIRST still-live connection and never drifts to other existing
 * connections when the bound one closes; a connection created after the slot
 * emptied takes the slot. wx.onSocketMessage holds a single slot, so a second
 * registration replaces the first.
 *
 * Failure sequence: a refused connect reports onError without onClose while
 * the wx.connectSocket call itself still succeeds; a normal open-then-close
 * round trip always delivers onClose.
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

interface CapState {
  success: boolean
  fail: string | null
  open: boolean
  messages: string[]
  errors: string[]
  closes: Array<{ code: number; reason: string }>
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
    `nh-ws-policy-legacy-${process.pid}`,
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

async function evalService<T>(app: ElectronApplication, expression: string): Promise<T> {
  return evalInWebContentsByUrl<T>(app, 'service.html', expression)
}

async function readCap(app: ElectronApplication, name: string): Promise<CapState> {
  return evalService<CapState>(app, `globalThis.__wsPolicy.conns[${JSON.stringify(name)}].cap`)
}

async function readGlobalMsgs(app: ElectronApplication, slot: string): Promise<string[]> {
  return evalService<string[]>(app, `globalThis.__wsPolicy.globalMsgs[${JSON.stringify(slot)}]`)
}

async function pickRefusedPort(): Promise<number> {
  const probe = net.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

const JS_CLEANUP = `(() => {
  var g = globalThis;
  if (!g.__wsPolicy) return true;
  for (var j = 0; j < g.__wsPolicy.reg.length; j++) {
    try { g.__wsPolicy.reg[j].close({ fail: function () {} }); } catch (e) {}
  }
  g.__wsPolicy.reg = [];
  g.__wsPolicy.conns = {};
  return true;
})()`

function jsConnect(url: string, name: string): string {
  return `(() => {
    var g = globalThis;
    g.__wsPolicy = g.__wsPolicy || { conns: {}, reg: [], globalMsgs: {} };
    var cap = { success: false, fail: null, open: false, messages: [], errors: [], closes: [] };
    var task = wx.connectSocket({
      url: ${JSON.stringify(url)},
      success: function () { cap.success = true; },
      fail: function (e) { cap.fail = (e && e.errMsg) || String(e); },
    });
    task.onOpen(function () { cap.open = true; });
    task.onMessage(function (e) { cap.messages.push(typeof e.data === 'string' ? e.data : '[binary]'); });
    task.onError(function (e) { cap.errors.push((e && e.errMsg) || String(e)); });
    task.onClose(function (e) { cap.closes.push({ code: e.code, reason: e.reason }); });
    g.__wsPolicy.conns[${JSON.stringify(name)}] = { task: task, cap: cap };
    g.__wsPolicy.reg.push(task);
    return true;
  })()`
}

function jsTaskClose(name: string): string {
  return `new Promise((resolve) => {
    var entry = globalThis.__wsPolicy.conns[${JSON.stringify(name)}];
    entry.task.close({
      success: function () { resolve({ ok: true, errMsg: null }); },
      fail: function (e) { resolve({ ok: false, errMsg: (e && e.errMsg) || String(e) }); },
    });
  })`
}

function jsGlobalSend(data: string): string {
  return `new Promise((resolve) => {
    wx.sendSocketMessage({
      data: ${JSON.stringify(data)},
      success: function () { resolve({ ok: true, errMsg: null }); },
      fail: function (e) { resolve({ ok: false, errMsg: (e && e.errMsg) || String(e) }); },
    });
  })`
}

function jsGlobalClose(): string {
  return `new Promise((resolve) => {
    wx.closeSocket({
      success: function () { resolve({ ok: true, errMsg: null }); },
      fail: function (e) { resolve({ ok: false, errMsg: (e && e.errMsg) || String(e) }); },
    });
  })`
}

function jsOnSocketMessage(slot: string): string {
  return `(() => {
    var g = globalThis;
    g.__wsPolicy = g.__wsPolicy || { conns: {}, reg: [], globalMsgs: {} };
    g.__wsPolicy.globalMsgs[${JSON.stringify(slot)}] = [];
    var fn = function (e) {
      g.__wsPolicy.globalMsgs[${JSON.stringify(slot)}].push(typeof e.data === 'string' ? e.data : '[binary]');
    };
    wx.onSocketMessage(fn);
    return true;
  })()`
}

async function expectOpen(app: ElectronApplication, name: string, connIndex: number): Promise<void> {
  expect(
    await pollUntil(async () => (await readCap(app, name)).open, (v) => v, 15_000, 250),
    `connection ${name} must open`,
  ).toBe(true)
  expect(
    await pollUntil(() => Promise.resolve(serverConns.length > connIndex), (v) => v, 5_000, 100),
    'server must accept the connection',
  ).toBe(true)
}

async function expectServerClosed(connIndex: number): Promise<void> {
  expect(
    await pollUntil(() => Promise.resolve(serverConns[connIndex]?.closed ?? false), (v) => v, 5_000, 100),
    `server must observe connection ${connIndex} closing`,
  ).toBe(true)
}

test.describe('native-host wx socket legacy global-interface policy', () => {
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

  test('routes wx.sendSocketMessage and wx.onSocketMessage to the first live connection only', async () => {
    const app = handle!.app
    const connA = serverConns.length
    await evalService(app, jsConnect(socketUrl, 'A'))
    await expectOpen(app, 'A', connA)
    const connB = serverConns.length
    await evalService(app, jsConnect(socketUrl, 'B'))
    await expectOpen(app, 'B', connB)
    await evalService(app, jsOnSocketMessage('g'))

    const send = await evalService<{ ok: boolean; errMsg: string | null }>(app, jsGlobalSend('to-bound'))
    expect(send.ok, `legacy send: ${JSON.stringify(send)}`).toBe(true)
    expect(
      await pollUntil(() => Promise.resolve(serverConns[connA]!.messages.includes('to-bound')), (v) => v, 5_000, 100),
      `the first connection must receive the legacy send: ${JSON.stringify(serverConns.map((c) => c.messages))}`,
    ).toBe(true)
    expect(serverConns[connB]!.messages, 'the second connection must not receive the legacy send').toEqual([])

    expect(
      await pollUntil(async () => (await readGlobalMsgs(app, 'g')).includes('echo:to-bound'), (v) => v, 5_000, 100),
      'the global listener must observe messages arriving on the bound connection',
    ).toBe(true)
    expect((await readCap(app, 'B')).messages).toEqual([])

    serverConns[connB]!.socket.send('for-B')
    expect(
      await pollUntil(async () => (await readCap(app, 'B')).messages.includes('for-B'), (v) => v, 5_000, 100),
      'SocketTask.onMessage must fire for the second connection',
    ).toBe(true)
    const globalMsgs = await readGlobalMsgs(app, 'g')
    expect(globalMsgs, `global listener must not observe the unbound connection: ${JSON.stringify(globalMsgs)}`)
      .not.toContain('for-B')
  })

  test('fails the legacy send after the bound connection closes instead of drifting, and binds a new connection', async () => {
    const app = handle!.app
    const connA = serverConns.length
    await evalService(app, jsConnect(socketUrl, 'A'))
    await expectOpen(app, 'A', connA)
    const connB = serverConns.length
    await evalService(app, jsConnect(socketUrl, 'B'))
    await expectOpen(app, 'B', connB)

    const close = await evalService<{ ok: boolean; errMsg: string | null }>(app, jsTaskClose('A'))
    expect(close.ok, `close A: ${JSON.stringify(close)}`).toBe(true)
    await pollUntil(() => readCap(app, 'A'), (c) => c.closes.length > 0, 5_000, 100)

    const sendAfterClose = await evalService<{ ok: boolean; errMsg: string | null }>(app, jsGlobalSend('after-close'))
    expect(sendAfterClose.ok, `legacy send after the bound close: ${JSON.stringify(sendAfterClose)}`).toBe(false)
    expect(sendAfterClose.errMsg).toBe('sendSocketMessage:fail WebSocket is not connected')
    expect(serverConns[connB]!.messages, 'the legacy send must not drift to the second connection').toEqual([])

    const connC = serverConns.length
    await evalService(app, jsConnect(socketUrl, 'C'))
    await expectOpen(app, 'C', connC)
    const sendC = await evalService<{ ok: boolean; errMsg: string | null }>(app, jsGlobalSend('to-c'))
    expect(sendC.ok, `legacy send after a new connection: ${JSON.stringify(sendC)}`).toBe(true)
    expect(
      await pollUntil(() => Promise.resolve(serverConns[connC]!.messages.includes('to-c')), (v) => v, 5_000, 100),
      'a connection created after the slot emptied must take the legacy binding',
    ).toBe(true)
  })

  test('wx.closeSocket closes only the open global binding', async () => {
    const app = handle!.app
    const connA = serverConns.length
    await evalService(app, jsConnect(socketUrl, 'A'))
    await expectOpen(app, 'A', connA)
    const connB = serverConns.length
    await evalService(app, jsConnect(socketUrl, 'B'))
    await expectOpen(app, 'B', connB)

    await evalService(app, jsGlobalClose())
    await expectServerClosed(connA)
    await waitMs(300)
    expect(serverConns[connB]?.closed, 'the non-bound SocketTask must remain open').toBe(false)
    await evalService(app, jsTaskClose('B'))
    await expectServerClosed(connB)
  })

  test('wx.onSocketMessage replaces the previous registration with a single slot', async () => {
    const app = handle!.app
    const connA = serverConns.length
    await evalService(app, jsConnect(socketUrl, 'slot'))
    await expectOpen(app, 'slot', connA)
    await evalService(app, jsOnSocketMessage('first'))
    await evalService(app, jsOnSocketMessage('second'))

    serverConns[connA]!.socket.send('slot-check')
    expect(
      await pollUntil(async () => (await readGlobalMsgs(app, 'second')).includes('slot-check'), (v) => v, 5_000, 100),
      'the second registration must receive the message',
    ).toBe(true)
    const first = await readGlobalMsgs(app, 'first')
    expect(first, `the first registration must have been replaced: ${JSON.stringify(first)}`).toEqual([])
  })

  test('reports onError without onClose for a refused connection while the connectSocket call succeeds', async () => {
    const app = handle!.app
    const port = await pickRefusedPort()
    await evalService(app, jsConnect(secureWebSocketTestUrl(port), 'refused'))

    const cap = await pollUntil(() => readCap(app, 'refused'), (c) => c.errors.length > 0, 15_000, 250)
    expect(cap.errors.length, `capture: ${JSON.stringify(cap)}`).toBeGreaterThan(0)
    await waitMs(500)
    const after = await readCap(app, 'refused')
    expect(after.closes, `onClose must not follow a failed connect: ${JSON.stringify(after)}`).toEqual([])
    expect(after.success, 'the wx.connectSocket call itself succeeds').toBe(true)
  })

  test('delivers onClose for a normal open-then-close round trip', async () => {
    const app = handle!.app
    const connIndex = serverConns.length
    await evalService(app, jsConnect(socketUrl, 'roundtrip'))
    await expectOpen(app, 'roundtrip', connIndex)

    const close = await evalService<{ ok: boolean; errMsg: string | null }>(app, jsTaskClose('roundtrip'))
    expect(close.ok, `close: ${JSON.stringify(close)}`).toBe(true)
    const cap = await pollUntil(() => readCap(app, 'roundtrip'), (c) => c.closes.length > 0, 5_000, 100)
    expect(cap.closes, `capture: ${JSON.stringify(cap)}`).toHaveLength(1)
    expect(
      await pollUntil(() => Promise.resolve(serverConns[connIndex]?.closed ?? false), (v) => v, 5_000, 100),
      'server must observe the close',
    ).toBe(true)
  })
})
