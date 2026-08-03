/**
 * E2E (native-host): WeChat-aligned socket background/idle policies, driven
 * from the service realm against a recording echo server.
 *
 * Background policy: hiding the main window fires appHide; after the 5s grace
 * live connections are interrupted with onClose(1006) and no onError, and
 * connects/sends while backgrounded fail with 'interrupted'. Foregrounding
 * inside the grace window keeps the connection usable.
 *
 * Idle policy: with DIMINA_SOCKET_IDLE_TIMEOUT_MS set, an open connection
 * without traffic is torn down with onClose(1006, 'idle timeout'); traffic
 * re-arms the teardown.
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import fs from 'fs'
import type { AddressInfo } from 'net'
import path from 'path'
import { fileURLToPath } from 'url'
import { WebSocketServer, type WebSocket } from 'ws'
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
  closeCode: number | null
  closeReason: string
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
let bootSeq = 0

test.beforeAll(async () => {
  wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', resolve)
    wss.once('error', reject)
  })
  const { port } = wss.address() as AddressInfo
  socketUrl = `ws://127.0.0.1:${port}/socket`
  wss.on('connection', (socket) => {
    const conn: ServerConn = { messages: [], closed: false, closeCode: null, closeReason: '', socket }
    serverConns.push(conn)
    socket.on('message', (data, isBinary) => {
      const text = isBinary ? `[binary:${data.byteLength}]` : data.toString()
      conn.messages.push(text)
      if (socket.readyState === 1) socket.send(`echo:${text}`)
    })
    socket.on('close', (code, reason) => {
      conn.closed = true
      conn.closeCode = code
      conn.closeReason = reason.toString()
    })
  })
})

test.afterAll(async () => {
  for (const conn of serverConns) {
    if (!conn.closed) conn.socket.terminate()
  }
  await new Promise<void>((resolve) => wss.close(() => resolve()))
})

async function bootApp(extraEnv: Record<string, string> = {}): Promise<AppHandle> {
  const appPath = path.resolve(__dirname, 'electron-entry.js')
  const userDataDir = path.resolve(
    process.env.DIMINA_DEVTOOLS_DATA_DIR
      ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'electron-runtime-e2e'),
    'userdata',
    `nh-ws-policy-${process.pid}-${bootSeq++}`,
  )
  fs.mkdirSync(userDataDir, { recursive: true })

  const app = await _electron.launch({
    args: [appPath, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DIMINA_E2E_USER_DATA_DIR: userDataDir,
      ...extraEnv,
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
      ;(globalThis as { __e2eMainWindowId?: number }).__e2eMainWindowId = window.id
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

async function readLifecycle(app: ElectronApplication): Promise<{ hide: number; show: number }> {
  return evalService(app, `globalThis.__wsLifecycle`)
}

async function setMainWindowBackgrounded(app: ElectronApplication, backgrounded: boolean): Promise<void> {
  await app.evaluate(({ BrowserWindow }, flag) => {
    const id = (globalThis as { __e2eMainWindowId?: number }).__e2eMainWindowId
    const window = BrowserWindow.getAllWindows().find((w) => w.id === id)
    if (!window) throw new Error('main window not found')
    if (flag) window.minimize()
    else window.restore()
  }, backgrounded)
}

const JS_INSTALL_LIFECYCLE = `(() => {
  var g = globalThis;
  g.__wsLifecycle = { hide: 0, show: 0 };
  if (typeof wx.onAppHide === 'function') wx.onAppHide(function () { g.__wsLifecycle.hide += 1; });
  if (typeof wx.onAppShow === 'function') wx.onAppShow(function () { g.__wsLifecycle.show += 1; });
  return true;
})()`

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

function jsConnect(url: string, name: string): string {
  return `(() => {
    var g = globalThis;
    g.__wsPolicy = g.__wsPolicy || { conns: {}, reg: [] };
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

function jsConnectAttempt(url: string): string {
  return `new Promise((resolve) => {
    var g = globalThis;
    g.__wsPolicy = g.__wsPolicy || { conns: {}, reg: [] };
    var out = { success: false, fail: null };
    var task = wx.connectSocket({
      url: ${JSON.stringify(url)},
      success: function () { out.success = true; resolve(out); },
      fail: function (e) { out.fail = (e && e.errMsg) || String(e); resolve(out); },
    });
    g.__wsPolicy.reg.push(task);
    setTimeout(function () { resolve(out); }, 8000);
  })`
}

function jsTaskSend(name: string, data: string): string {
  return `new Promise((resolve) => {
    var entry = globalThis.__wsPolicy.conns[${JSON.stringify(name)}];
    entry.task.send({
      data: ${JSON.stringify(data)},
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

async function expectAppHidden(app: ElectronApplication, baseHide: number): Promise<void> {
  expect(
    await pollUntil(async () => (await readLifecycle(app)).hide > baseHide, (v) => v, 5_000, 100),
    'minimize must drive appHide (background trigger unavailable in this environment)',
  ).toBe(true)
}

test.describe('native-host wx.connectSocket background interruption policy', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  let handle: AppHandle | undefined

  test.beforeAll(async () => {
    test.setTimeout(180_000)
    handle = await bootApp()
    await evalService(handle.app, JS_INSTALL_LIFECYCLE)
  })

  test.afterAll(async () => {
    await shutdownApp(handle)
  })

  test.afterEach(async () => {
    if (!handle) return
    // Wait for the restore to actually drive appShow before the next test
    // connects — a fixed sleep here races the main-process 'restore' → onShow
    // → setBackgrounded(false) chain under load, leaving the next test's
    // connectSocket seeing a stale "backgrounded" state and failing with
    // 'connectSocket:fail interrupted'.
    const before = await readLifecycle(handle.app).catch(() => ({ hide: 0, show: 0 }))
    await setMainWindowBackgrounded(handle.app, false).catch(() => {})
    await pollUntil(
      async () => (await readLifecycle(handle!.app)).show > before.show,
      (v) => v,
      5_000,
      100,
    ).catch(() => {})
    await evalService(handle.app, JS_CLEANUP).catch(() => {})
    await handle.win.waitForTimeout(300)
  })

  test('interrupts live connections with onClose code 1006 and no onError after the 5s background grace', async () => {
    const app = handle!.app
    const connIndex = serverConns.length
    await evalService(app, jsConnect(socketUrl, 'bg'))
    await expectOpen(app, 'bg', connIndex)
    const lifecycleBase = await readLifecycle(app)

    await setMainWindowBackgrounded(app, true)
    await expectAppHidden(app, lifecycleBase.hide)

    await waitMs(5_500)
    const cap = await pollUntil(() => readCap(app, 'bg'), (c) => c.closes.length > 0, 8_000, 250)
    expect(cap.closes, `capture: ${JSON.stringify(cap)}`).toHaveLength(1)
    expect(cap.closes[0]!.code).toBe(1006)
    expect(cap.errors, `onError must not fire: ${JSON.stringify(cap.errors)}`).toEqual([])
    expect(
      await pollUntil(() => Promise.resolve(serverConns[connIndex]?.closed ?? false), (v) => v, 5_000, 100),
      'server must observe the peer disconnecting',
    ).toBe(true)
  })

  test('fails connectSocket and sendSocketMessage with interrupted while the app is backgrounded', async () => {
    const app = handle!.app
    const connIndex = serverConns.length
    await evalService(app, jsConnect(socketUrl, 'bg-send'))
    await expectOpen(app, 'bg-send', connIndex)
    const lifecycleBase = await readLifecycle(app)
    await setMainWindowBackgrounded(app, true)
    await expectAppHidden(app, lifecycleBase.hide)

    const connectResult = await evalService<{ success: boolean; fail: string | null }>(
      app,
      jsConnectAttempt(socketUrl),
    )
    expect(connectResult.fail, `connect while backgrounded: ${JSON.stringify(connectResult)}`)
      .toBe('connectSocket:fail interrupted')

    const sendResult = await evalService<{ ok: boolean; errMsg: string | null }>(
      app,
      jsGlobalSend('while-background'),
    )
    expect(sendResult.ok, `send while backgrounded: ${JSON.stringify(sendResult)}`).toBe(false)
    expect(sendResult.errMsg).toBe('sendSocketMessage:fail interrupted')
  })

  test('keeps the connection usable when the app returns to the foreground within the grace window', async () => {
    const app = handle!.app
    const connIndex = serverConns.length
    await evalService(app, jsConnect(socketUrl, 'bg-grace'))
    await expectOpen(app, 'bg-grace', connIndex)
    const lifecycleBase = await readLifecycle(app)

    await setMainWindowBackgrounded(app, true)
    await expectAppHidden(app, lifecycleBase.hide)
    await waitMs(1_000)
    await setMainWindowBackgrounded(app, false)
    expect(
      await pollUntil(async () => (await readLifecycle(app)).show > lifecycleBase.show, (v) => v, 5_000, 100),
      'restore must drive appShow',
    ).toBe(true)
    // The main window sits off-screen (-2000,-2000, see bootApp) so it never
    // paints anywhere real; right after restore() the OS can fire one more
    // spurious occlusion hide/show pair before settling, which would flip
    // "backgrounded" true again for an instant and fail the very next send
    // with 'interrupted'. Retry across that transient window instead of
    // asserting on a single attempt — the test's real intent is that the
    // connection is usable once the app is durably foregrounded.
    const send = await pollUntil(
      () => evalService<{ ok: boolean; errMsg: string | null }>(app, jsTaskSend('bg-grace', 'still-alive')),
      (r) => r.ok || r.errMsg !== 'sendSocketMessage:fail interrupted',
      5_000,
      200,
    )
    expect(send.ok, `send after foregrounding: ${JSON.stringify(send)}`).toBe(true)
    const cap = await pollUntil(
      () => readCap(app, 'bg-grace'),
      (c) => c.messages.includes('echo:still-alive'),
      5_000,
      200,
    )
    expect(cap.closes, `no onClose expected inside the grace window: ${JSON.stringify(cap)}`).toEqual([])
    expect(cap.errors).toEqual([])
    expect(serverConns[connIndex]!.messages).toContain('still-alive')
  })
})

test.describe('native-host wx.connectSocket idle teardown policy', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  let handle: AppHandle | undefined

  test.beforeAll(async () => {
    test.setTimeout(180_000)
    handle = await bootApp({ DIMINA_SOCKET_IDLE_TIMEOUT_MS: '1500' })
  })

  test.afterAll(async () => {
    await shutdownApp(handle)
  })

  test.afterEach(async () => {
    if (!handle) return
    await evalService(handle.app, JS_CLEANUP).catch(() => {})
  })

  test('tears down an idle open connection with onClose code 1006 reason idle timeout and no onError', async () => {
    const app = handle!.app
    const connIndex = serverConns.length
    await evalService(app, jsConnect(socketUrl, 'idle'))
    await expectOpen(app, 'idle', connIndex)

    const cap = await pollUntil(() => readCap(app, 'idle'), (c) => c.closes.length > 0, 3_000, 150)
    expect(cap.closes, `capture: ${JSON.stringify(cap)}`).toEqual([{ code: 1006, reason: 'idle timeout' }])
    expect(cap.errors).toEqual([])
    expect(
      await pollUntil(() => Promise.resolve(serverConns[connIndex]?.closed ?? false), (v) => v, 3_000, 100),
      'server must observe the peer disconnecting',
    ).toBe(true)
  })

  test('re-arms the idle teardown while frames flow and closes the connection after traffic stops', async () => {
    const app = handle!.app
    const connIndex = serverConns.length
    await evalService(app, jsConnect(socketUrl, 'idle-flow'))
    await expectOpen(app, 'idle-flow', connIndex)

    for (let i = 0; i < 4; i += 1) {
      await waitMs(500)
      const send = await evalService<{ ok: boolean; errMsg: string | null }>(app, jsTaskSend('idle-flow', `frame-${i}`))
      expect(send.ok, `frame ${i}: ${JSON.stringify(send)}`).toBe(true)
    }
    await waitMs(500)
    const mid = await readCap(app, 'idle-flow')
    expect(mid.closes, `no onClose while traffic flows: ${JSON.stringify(mid)}`).toEqual([])

    const cap = await pollUntil(() => readCap(app, 'idle-flow'), (c) => c.closes.length > 0, 4_000, 200)
    expect(cap.closes, `capture: ${JSON.stringify(cap)}`).toEqual([{ code: 1006, reason: 'idle timeout' }])
    expect(cap.errors).toEqual([])
  })
})
