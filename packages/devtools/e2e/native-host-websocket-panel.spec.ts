/**
 * E2E (native-host): the DevTools Network panel surfaces REAL wx.connectSocket
 * connections.
 *
 * wx.connectSocket sockets live on the Node `ws` transport in the MAIN
 * process, invisible to any webContents.debugger — so the embedded Network
 * tab would never show them. The main-process trace stream (electron-runtime
 * native-websocket/trace.ts) is synthesized into `Network.webSocket*` CDP
 * events (network-forward/websocket.ts) and injected into the right-panel
 * DevTools front-end via `window.DevToolsAPI.dispatchMessage`.
 *
 * We cannot read the closed-shadow Network panel UI, so — mirroring
 * native-host-network-response-body.spec.ts — we observe the front-end's own
 * CDP wire protocol directly: wrap `DevToolsAPI.dispatchMessage` in the
 * devtools:// realm to record every `Network.webSocket*` event, then drive a
 * real socket from the service realm against a loopback echo server and
 * assert the recorded lifecycle, grouped by the synthesized `dimina:ws:`
 * requestId.
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import fs from 'fs'
import type { AddressInfo } from 'net'
import path from 'path'
import { fileURLToPath } from 'url'
import { WebSocketServer } from 'ws'
import {
  closeSecureWebSocketTestServer,
  createSecureWebSocketTestServer,
  secureWebSocketTestUrl,
  WEBSOCKET_TEST_CA_PATH,
} from '../../dimina-electron-runtime/e2e/fixtures/websocket-tls'
import {
  closeProject,
  evalInWebContentsByUrl,
  openProjectInUI,
  pollUntil,
  waitForSimulatorWebview,
  findMainWindow,
} from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')

interface AppHandle {
  app: ElectronApplication
  workbench: PwPage
}

/** One recorded `Network.webSocket*` CDP event from the front-end realm. */
interface WsPanelMessage {
  method: string
  params?: {
    requestId?: string
    url?: string
    timestamp?: number
    wallTime?: number
    request?: { headers?: Record<string, string> }
    response?: {
      status?: number
      statusText?: string
      headers?: Record<string, string>
      opcode?: number
      mask?: boolean
      payloadData?: string
      base64Encoded?: boolean
    }
    errorMessage?: string
  }
}

interface SocketOutcome {
  open: boolean
  texts: string[]
  binary: number[] | null
  close: { code: number; reason: string } | null
  error: string | null
  timedOut: boolean
}

let wss: WebSocketServer
let socketUrl: string

test.beforeAll(async () => {
  wss = createSecureWebSocketTestServer()
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', resolve)
    wss.once('error', reject)
  })
  const { port } = wss.address() as AddressInfo
  socketUrl = secureWebSocketTestUrl(port)
  wss.on('connection', (socket) => {
    socket.on('message', (data, isBinary) => {
      socket.send(data, { binary: isBinary })
    })
  })
})

test.afterAll(async () => {
  for (const socket of wss.clients) socket.terminate()
  await closeSecureWebSocketTestServer(wss)
})

async function bootApp(): Promise<AppHandle> {
  const appPath = path.resolve(__dirname, 'electron-entry.js')
  const userDataDir = path.resolve(
    process.env.DIMINA_DEVTOOLS_DATA_DIR
      ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e'),
    'userdata',
    `nh-websocket-panel-${process.pid}`,
  )
  fs.mkdirSync(userDataDir, { recursive: true })

  const app = await _electron.launch({
    args: [appPath, 'auto', '--auto-port', '0', `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      NODE_EXTRA_CA_CERTS: WEBSOCKET_TEST_CA_PATH,
      DIMINA_NATIVE_HOST: '1',
      DIMINA_E2E_USER_DATA_DIR: userDataDir,
    },
  })
  const mainWin = await findMainWindow(app)
  await mainWin.waitForLoadState('domcontentloaded')

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

  const workbench = await openProjectInUI(app, FIXTURE_DIR, { waitMs: 20_000 })
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
  return { app, workbench }
}

async function shutdownApp(handle: AppHandle | undefined): Promise<void> {
  if (!handle) return
  await closeProject(handle.app).catch(() => {})
  await handle.app.close().catch(() => {})
}

/**
 * Idempotently wrap `window.DevToolsAPI.dispatchMessage` in the front-end
 * realm and record every `Network.webSocket*` message into
 * `globalThis.__wsCdpLog`. Tolerant by contract: the forwarder dispatches
 * each message as a JSON string, but a realm passing a pre-parsed object is
 * accepted too, and an unparseable chunk must never break the real dispatch.
 */
const INSTALL_RECORDER_SCRIPT = `(function() {
  try {
    if (globalThis.__wsCdpLog) return true;
    var DTAPI = window.DevToolsAPI;
    if (!DTAPI || typeof DTAPI.dispatchMessage !== 'function') return false;
    globalThis.__wsCdpLog = [];
    var orig = DTAPI.dispatchMessage.bind(DTAPI);
    DTAPI.dispatchMessage = function(message) {
      try {
        var parsed = message;
        if (typeof message === 'string') {
          try { parsed = JSON.parse(message); } catch (e) { parsed = null; }
        }
        if (parsed && typeof parsed.method === 'string' && parsed.method.indexOf('Network.webSocket') === 0) {
          globalThis.__wsCdpLog.push(parsed);
        }
      } catch (e) {}
      return orig(message);
    };
    return true;
  } catch (e) { return false; }
})()`

interface RecorderProbe {
  ok: boolean
  urls: string[]
}

/** Run `script` in the right-panel DevTools front-end realm, with the wc URL
 *  list reported back for diagnostics when no devtools host exists yet. */
async function evalInDevtoolsFrontend(
  app: ElectronApplication,
  script: string,
): Promise<{ result: unknown; urls: string[] }> {
  return app.evaluate(async ({ webContents }, expression) => {
    const all = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed())
    const urls = all.map((wc) => wc.getURL())
    const target = all.find((wc) => wc.getURL().includes('devtools_app'))
      ?? all.find((wc) => wc.getURL().startsWith('devtools://'))
    if (!target) return { result: null, urls }
    if (target.isLoading()) return { result: null, urls }
    try {
      const result: unknown = await target.executeJavaScript(expression)
      return { result, urls }
    } catch {
      return { result: null, urls }
    }
  }, script)
}

async function installRecorder(app: ElectronApplication): Promise<RecorderProbe> {
  let last: RecorderProbe = { ok: false, urls: [] }
  await pollUntil(
    async () => {
      const { result, urls } = await evalInDevtoolsFrontend(app, INSTALL_RECORDER_SCRIPT)
      last = { ok: result === true, urls }
      return last.ok
    },
    (ok) => ok,
    30_000,
    300,
  ).catch(() => {})
  return last
}

async function readRecorder(app: ElectronApplication): Promise<WsPanelMessage[]> {
  const { result } = await evalInDevtoolsFrontend(
    app,
    `globalThis.__wsCdpLog ? globalThis.__wsCdpLog.slice() : []`,
  )
  return Array.isArray(result) ? result as WsPanelMessage[] : []
}

async function evalService<T>(app: ElectronApplication, expression: string): Promise<T> {
  return evalInWebContentsByUrl<T>(app, 'service.html', expression)
}

/**
 * Drive one full socket lifecycle from the service realm: open → send text →
 * receive the text echo → send ArrayBuffer [1,2,3,4] → receive the binary
 * echo → close(4001). Resolves with the business-channel outcome so the test
 * fails on the client flow itself before any panel assertion runs.
 */
function socketExpression(url: string): string {
  return `new Promise((resolve) => {
    var settled = false;
    var outcome = { open: false, texts: [], binary: null, close: null, error: null, timedOut: false };
    var finish = function(patch) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Object.assign(outcome, patch));
    };
    var task = wx.connectSocket({
      url: ${JSON.stringify(url)},
      timeout: 10000,
      fail: function(error) { finish({ error: (error && error.errMsg) || String(error) }); },
    });
    var binarySent = false;
    task.onOpen(function() {
      outcome.open = true;
      task.send({
        data: 'client:hello',
        fail: function(error) { finish({ error: (error && error.errMsg) || String(error) }); },
      });
    });
    task.onMessage(function(event) {
      if (typeof event.data === 'string') {
        outcome.texts.push(event.data);
        if (!binarySent) {
          binarySent = true;
          task.send({
            data: new Uint8Array([1, 2, 3, 4]).buffer,
            fail: function(error) { finish({ error: (error && error.errMsg) || String(error) }); },
          });
        }
      } else {
        outcome.binary = Array.from(new Uint8Array(event.data));
        task.close({ code: 4001, reason: 'panel-e2e' });
      }
    });
    task.onError(function(error) { finish({ error: (error && error.errMsg) || String(error) }); });
    task.onClose(function(event) {
      finish({ close: { code: event.code, reason: event.reason } });
    });
    var timer = setTimeout(function() {
      try { task.close({ fail: function() {} }); } catch (e) {}
      finish({ timedOut: true });
    }, 15000);
  })`
}

/** The `dimina:ws:` webSocketCreated event for one exact business url. */
function findCreated(log: WsPanelMessage[], url: string): WsPanelMessage | undefined {
  return log.find((message) =>
    message.method === 'Network.webSocketCreated'
    && message.params?.url === url
    && typeof message.params.requestId === 'string'
    && message.params.requestId.startsWith('dimina:ws:'),
  )
}

function eventsFor(log: WsPanelMessage[], requestId: string): WsPanelMessage[] {
  return log.filter((message) => message.params?.requestId === requestId)
}

function methodsOf(events: WsPanelMessage[]): string[] {
  return events.map((message) => message.method)
}

/** Expected full lifecycle for one socket driven by socketExpression. */
const EXPECTED_METHOD_SEQUENCE = [
  'Network.webSocketCreated',
  'Network.webSocketWillSendHandshakeRequest',
  'Network.webSocketHandshakeResponseReceived',
  'Network.webSocketFrameSent',
  'Network.webSocketFrameReceived',
  'Network.webSocketFrameSent',
  'Network.webSocketFrameReceived',
  'Network.webSocketClosed',
]

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())
  return entry?.[1]
}

/** Poll the recorder until the socket for `url` has its terminal closed event. */
async function waitForSocketLifecycle(app: ElectronApplication, url: string): Promise<WsPanelMessage[]> {
  return pollUntil(
    () => readRecorder(app),
    (log) => {
      const created = findCreated(log, url)
      if (!created?.params?.requestId) return false
      return eventsFor(log, created.params.requestId)
        .some((message) => message.method === 'Network.webSocketClosed')
    },
    15_000,
    250,
  )
}

function assertFullLifecycle(log: WsPanelMessage[], url: string): string {
  const created = findCreated(log, url)
  expect(
    created,
    `panel must show Network.webSocketCreated for the real business socket ${url}; recorded: ${JSON.stringify(log)}`,
  ).toBeDefined()
  const requestId = created!.params!.requestId!
  const events = eventsFor(log, requestId)
  expect(methodsOf(events)).toEqual(EXPECTED_METHOD_SEQUENCE)

  const handshakeRequest = events[1]!
  expect(headerValue(handshakeRequest.params?.request?.headers, 'sec-websocket-key')).toBeTruthy()

  const handshakeResponse = events[2]!
  expect(handshakeResponse.params?.response?.status).toBe(101)

  // Client-sent frames are masked on the wire; the first one is the text send.
  const frameSent = events[3]!.params?.response
  expect(frameSent?.mask).toBe(true)
  expect(frameSent?.opcode).toBe(1)
  expect(frameSent?.payloadData).toBe('client:hello')

  // The binary echo round-trips base64 so the payload survives as data.
  const frameSentBinary = events[5]!.params?.response
  expect(frameSentBinary?.mask).toBe(true)
  expect(frameSentBinary?.opcode).toBe(2)
  expect(frameSentBinary?.base64Encoded).toBe(true)
  expect(Array.from(Buffer.from(frameSentBinary!.payloadData!, 'base64'))).toEqual([1, 2, 3, 4])
  const frameReceivedBinary = events[6]!.params?.response
  expect(frameReceivedBinary?.mask).toBe(false)
  expect(frameReceivedBinary?.opcode).toBe(2)
  expect(frameReceivedBinary?.base64Encoded).toBe(true)
  expect(Array.from(Buffer.from(frameReceivedBinary!.payloadData!, 'base64'))).toEqual([1, 2, 3, 4])

  // The terminal event settles the row: nothing for this requestId may follow.
  expect(events[events.length - 1]!.method).toBe('Network.webSocketClosed')
  return requestId
}

function assertClientFlow(outcome: SocketOutcome, url: string): void {
  expect(outcome.error, `client flow for ${url}: ${JSON.stringify(outcome)}`).toBeNull()
  expect(outcome.timedOut, `client flow for ${url} timed out: ${JSON.stringify(outcome)}`).toBe(false)
  expect(outcome.open).toBe(true)
  expect(outcome.texts).toEqual(['client:hello'])
  expect(outcome.binary).toEqual([1, 2, 3, 4])
  expect(outcome.close).toEqual({ code: 4001, reason: 'panel-e2e' })
}

test.describe('native-host DevTools Network panel shows real wx.connectSocket connections', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  let handle: AppHandle | undefined
  let firstRequestId: string | undefined
  let firstLogLength = 0

  test.beforeAll(async () => {
    test.setTimeout(180_000)
    handle = await bootApp()
    const probe = await installRecorder(handle.app)
    expect(
      probe.ok,
      `DevTools front-end recorder must install (devtools wc present + DevToolsAPI.dispatchMessage available); seen webContents URLs: ${JSON.stringify(probe.urls)}`,
    ).toBe(true)
  })

  test.afterAll(async () => {
    await shutdownApp(handle)
  })

  test('records the full Network.webSocket* lifecycle for a real socket connection', async () => {
    const app = handle!.app
    const url = `${socketUrl}?conn=first`
    const outcome = await evalService<SocketOutcome>(app, socketExpression(url))
    assertClientFlow(outcome, url)

    const log = await waitForSocketLifecycle(app, url)
    firstRequestId = assertFullLifecycle(log, url)

    // After the terminal closed, a settle window produces no further events
    // for this requestId (the id mapping is released at closed).
    await handle!.workbench.waitForTimeout(300)
    const settled = await readRecorder(app)
    firstLogLength = eventsFor(settled, firstRequestId).length
    expect(firstLogLength).toBe(EXPECTED_METHOD_SEQUENCE.length)
  })

  test('a second connection after close mints a fresh requestId with its own complete sequence', async () => {
    const app = handle!.app
    expect(firstRequestId, 'the first connection lifecycle must complete before the re-connect check').toBeTruthy()
    const url = `${socketUrl}?conn=second`
    const outcome = await evalService<SocketOutcome>(app, socketExpression(url))
    assertClientFlow(outcome, url)

    const log = await waitForSocketLifecycle(app, url)
    const secondRequestId = assertFullLifecycle(log, url)
    expect(secondRequestId).not.toBe(firstRequestId)

    // The first connection stays settled: re-connecting never resurrects its
    // requestId with new events.
    const firstEvents = eventsFor(log, firstRequestId!)
    expect(firstEvents).toHaveLength(firstLogLength)
    expect(firstEvents[firstEvents.length - 1]!.method).toBe('Network.webSocketClosed')
  })
})
