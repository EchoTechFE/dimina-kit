/**
 * E2E (native-host): the service realm exposes SocketTask while the actual
 * network connection is owned by the Electron Main-process Native service.
 *
 * This guards both halves of the implementation:
 *  - mini-app API semantics: SocketTask open/message/send/close, custom
 *    handshake headers, complete response headers/profile, subprotocol
 *    negotiation, and binary ArrayBuffer data;
 *  - isolation: simulator CDP must not observe Network.webSocketCreated for the
 *    connection, proving the transport did not fall back to Chromium.
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import fs from 'fs'
import type { AddressInfo } from 'net'
import path from 'path'
import { fileURLToPath } from 'url'
import { WebSocketServer } from 'ws'
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

interface CapturedCdpMessage {
  method?: string
  params?: {
    requestId?: string
    url?: string
    request?: { url?: string; headers?: Record<string, string> }
    response?: {
      status?: number
      headers?: Record<string, string>
      payloadData?: string
      opcode?: number
      mask?: boolean
    }
    responseStatusCode?: number
    responseStatusText?: string
    responseHeaders?: Record<string, string>
    responseHeadersText?: string
    responseTime?: number
    type?: string
  }
}

interface SocketOutcome {
  path: 'close' | 'error' | 'timeout'
  connectSuccess: boolean
  sendSuccess: boolean
  open: {
    header: Record<string, unknown>
    profile: {
      connectEnd: number
      connectStart: number
      cost: number
      domainLookUpEnd: number
      domainLookUpStart: number
      fetchStart: number
      handshakeCost: number
      rtt: number
    }
  } | null
  text: string | null
  binary: number[] | null
  close: { code: number; reason: string } | null
  errMsg?: string
}

interface ServerObservation {
  authorization: string
  trace: string
  origin: string
  protocol: string
  clientMessage: string
  closeCode: number
  closeReason: string
}

let wss: WebSocketServer
let socketUrl: string
let resolveServerObservation!: (value: ServerObservation) => void
let serverObservation: Promise<ServerObservation>

test.beforeAll(async () => {
  serverObservation = new Promise<ServerObservation>((resolve) => {
    resolveServerObservation = resolve
  })
  wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    handleProtocols(protocols) {
      return protocols.has('chat') ? 'chat' : false
    },
  })
  wss.on('headers', (headers) => {
    headers.push('X-E2E-Native-Response: main-process')
    headers.push('X-E2E-Response-Trace: complete-handshake')
  })
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', resolve)
    wss.once('error', reject)
  })
  const { port } = wss.address() as AddressInfo
  socketUrl = `ws://127.0.0.1:${port}/socket`

  wss.on('connection', (socket, request) => {
    let clientMessage = ''
    socket.on('message', (data, isBinary) => {
      if (!isBinary) clientMessage = data.toString()
      socket.send('server:hello')
      socket.send(Buffer.from([1, 2, 3, 4]))
    })
    socket.on('close', (code, reason) => {
      resolveServerObservation({
        authorization: request.headers.authorization ?? '',
        trace: String(request.headers['x-e2e-trace'] ?? ''),
        origin: request.headers.origin ?? '',
        protocol: socket.protocol,
        clientMessage,
        closeCode: code,
        closeReason: reason.toString(),
      })
    })
  })
})

test.afterAll(async () => {
  for (const socket of wss.clients) socket.terminate()
  await new Promise<void>((resolve) => wss.close(() => resolve()))
})

async function bootApp(): Promise<AppHandle> {
  const appPath = path.resolve(__dirname, 'electron-entry.js')
  const userDataDir = path.resolve(
    process.env.DIMINA_DEVTOOLS_DATA_DIR
      ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'electron-runtime-e2e'),
    'userdata',
    `nh-websocket-${process.pid}`,
  )
  fs.mkdirSync(userDataDir, { recursive: true })

  const app = await _electron.launch({
    args: [appPath, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      NODE_ENV: 'test',
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

async function installCdpCapture(app: ElectronApplication): Promise<void> {
  const result = await app.evaluate(async ({ webContents }) => {
    const target = webContents.getAllWebContents().find((wc) =>
      !wc.isDestroyed() && wc.getURL().includes('simulator.html'))
    if (!target) return { ok: false, error: 'simulator target not found' }

    type CaptureGlobal = typeof globalThis & {
      __e2eNativeWebSocketCdp?: Array<{ method: string; params?: unknown }>
    }
    const captureGlobal = globalThis as CaptureGlobal
    captureGlobal.__e2eNativeWebSocketCdp = []
    const cdp = target.debugger
    try {
      if (!cdp.isAttached()) cdp.attach('1.3')
      cdp.on('message', (_event, method, params) => {
        if (method.startsWith('Network.webSocket')) {
          captureGlobal.__e2eNativeWebSocketCdp?.push({ method, params })
        }
      })
      await cdp.sendCommand('Network.enable')
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  expect(result, `simulator CDP capture failed: ${JSON.stringify(result)}`).toEqual({ ok: true })
}

async function readCdpMessages(app: ElectronApplication): Promise<CapturedCdpMessage[]> {
  return app.evaluate(() => {
    type CaptureGlobal = typeof globalThis & {
      __e2eNativeWebSocketCdp?: CapturedCdpMessage[]
    }
    return (globalThis as CaptureGlobal).__e2eNativeWebSocketCdp?.slice() ?? []
  })
}

function socketExpression(url: string, trace: string): string {
  return `new Promise((resolve) => {
    var settled = false;
    var outcome = {
      path: 'timeout',
      connectSuccess: false,
      sendSuccess: false,
      open: null,
      text: null,
      binary: null,
      close: null,
    };
    var finish = function(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Object.assign(outcome, result));
    };
    var task = wx.connectSocket({
      url: ${JSON.stringify(url)},
      header: {
        Authorization: 'Bearer websocket-e2e',
        'X-E2E-Trace': ${JSON.stringify(trace)},
      },
      protocols: ['chat', 'fallback'],
      timeout: 10000,
      success: function() { outcome.connectSuccess = true; },
      fail: function(error) { finish({ path: 'error', errMsg: error && error.errMsg }); },
    });
    var maybeClose = function() {
      if (outcome.text !== null && outcome.binary !== null) {
        task.close({ code: 4001, reason: 'e2e-done' });
      }
    };
    task.onOpen(function(event) {
      outcome.open = event || {};
      task.send({
        data: 'client:hello',
        success: function() { outcome.sendSuccess = true; },
        fail: function(error) { finish({ path: 'error', errMsg: error && error.errMsg }); },
      });
    });
    task.onMessage(function(event) {
      if (typeof event.data === 'string') {
        outcome.text = event.data;
      } else {
        outcome.binary = Array.from(new Uint8Array(event.data));
      }
      maybeClose();
    });
    task.onError(function(error) {
      finish({ path: 'error', errMsg: error && error.errMsg });
    });
    task.onClose(function(event) {
      finish({ path: 'close', close: { code: event.code, reason: event.reason } });
    });
    var timer = setTimeout(function() {
      try { task.close({ code: 4000, reason: 'e2e-timeout' }); } catch (e) {}
      finish({ path: 'timeout', errMsg: 'client timeout' });
    }, 15000);
  })`
}

function responseHeader(
  headers: Record<string, unknown>,
  name: string,
): unknown {
  return Object.entries(headers)
    .find(([key]) => key.toLowerCase() === name.toLowerCase())
    ?.[1]
}

test.describe('native-host wx.connectSocket through Main/Native transport', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  let handle: AppHandle | undefined

  test.beforeAll(async () => {
    test.setTimeout(180_000)
    handle = await bootApp()
    await installCdpCapture(handle.app)
  })

  test.afterAll(async () => {
    await shutdownApp(handle)
  })

  test('connects through SocketTask with full handshake metadata, frames, and close metadata', async () => {
    const trace = `ws-e2e-${Date.now()}`
    const clientPromise = evalInWebContentsByUrl<SocketOutcome>(
      handle!.app,
      'service.html',
      socketExpression(`${socketUrl}?trace=${trace}`, trace),
    )

    const client = await clientPromise

    expect(client.path, `client outcome: ${JSON.stringify(client)}`).toBe('close')
    expect(client.connectSuccess).toBe(true)
    expect(client.sendSuccess).toBe(true)
    expect(client.open).not.toBeNull()
    expect(responseHeader(client.open!.header, 'upgrade')).toBe('websocket')
    expect(String(responseHeader(client.open!.header, 'connection')).toLowerCase()).toContain('upgrade')
    expect(responseHeader(client.open!.header, 'sec-websocket-accept')).toMatch(/^[A-Za-z0-9+/]{27}=$/)
    expect(responseHeader(client.open!.header, 'sec-websocket-protocol')).toBe('chat')
    expect(responseHeader(client.open!.header, 'x-e2e-native-response')).toBe('main-process')
    expect(responseHeader(client.open!.header, 'x-e2e-response-trace')).toBe('complete-handshake')

    const profile = client.open!.profile
    for (const field of [
      'connectEnd',
      'connectStart',
      'cost',
      'domainLookUpEnd',
      'domainLookUpStart',
      'fetchStart',
      'handshakeCost',
      'rtt',
    ] as const) {
      expect(typeof profile[field], `open.profile.${field}`).toBe('number')
      expect(Number.isFinite(profile[field]), `open.profile.${field}`).toBe(true)
      expect(profile[field], `open.profile.${field}`).toBeGreaterThanOrEqual(0)
    }
    expect(profile.fetchStart).toBeLessThanOrEqual(profile.domainLookUpStart)
    expect(profile.domainLookUpStart).toBeLessThanOrEqual(profile.domainLookUpEnd)
    expect(profile.domainLookUpEnd).toBeLessThanOrEqual(profile.connectStart)
    expect(profile.connectStart).toBeLessThanOrEqual(profile.connectEnd)
    expect(profile.cost).toBeGreaterThanOrEqual(profile.handshakeCost)
    expect(client.text).toBe('server:hello')
    expect(client.binary).toEqual([1, 2, 3, 4])
    expect(client.close).toEqual({ code: 4001, reason: 'e2e-done' })

    const server = await Promise.race([
      serverObservation,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('WebSocket server did not observe a closed connection')), 10_000)
      }),
    ])
    expect(server.authorization).toBe('Bearer websocket-e2e')
    expect(server.trace).toBe(trace)
    expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(server.protocol).toBe('chat')
    expect(server.clientMessage).toBe('client:hello')
    expect(server.closeCode).toBe(4001)
    expect(server.closeReason).toBe('e2e-done')
  })

  test('does not create the mini-app socket in the simulator Chromium network stack', async () => {
    // The first test awaits the Native close event and the peer's close frame,
    // so any Chromium webSocketCreated notification for that completed
    // connection would already have reached the attached debugger. A short
    // extra turn also drains Electron debugger message delivery.
    await handle!.win.waitForTimeout(250)
    const messages = await readCdpMessages(handle!.app)
    const chromiumConnections = messages.filter((message) =>
      message.method === 'Network.webSocketCreated'
      && message.params?.url?.startsWith(socketUrl),
    )
    expect(
      chromiumConnections,
      `simulator Chromium unexpectedly created the mini-app WebSocket: ${JSON.stringify(chromiumConnections)}`,
    ).toEqual([])
  })
})
