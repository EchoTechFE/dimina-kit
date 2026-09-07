/**
 * Real Electron Network round-trip: native wx.request emits dimina:http: events;
 * renderer image loads retain dimina:sim: ids. The actual DevTools frontend
 * sends body commands through its installed outbound hook and receives cached
 * bytes through DevToolsAPI, exactly as its Response and Payload tabs do.
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import http from 'http'
import type { AddressInfo } from 'net'
import path from 'path'
import fs from 'fs'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'url'
import {
  openProjectInUI,
  waitForSimulatorWebview,
  closeProject,
  pollUntil,
  evalInSimulator,
  evalInWebContentsByUrl,
  RENDER_GUEST_URL_MARKER,
  findMainWindow,
} from './helpers'

// NOTE: scope DIMINA_NATIVE_HOST to THIS spec's electron launch, never
// `process.env` — a module-top mutation poisons the shared --workers=1
// runner, flipping every other spec into native-host mode.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')

interface AppHandle { app: ElectronApplication; win: PwPage }

interface CapturedCdpMessage {
  id?: number
  method?: string
  params?: { requestId?: string; request?: { url?: string } }
  result?: { body?: string; base64Encoded?: boolean; postData?: string }
  error?: { message?: string }
}

let server: http.Server
let baseUrl: string
let preflightCount = 0

// A minimal valid 1x1 transparent PNG, hardcoded so the /img route needs no
// on-disk fixture. Its first bytes carry the PNG magic number (0x89 'P' 'N' 'G')
// the image-body assertion below decodes and checks for.
const PNG_1PX_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const PNG_1PX_BYTES = Buffer.from(PNG_1PX_BASE64, 'base64')

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': '*',
      'Access-Control-Allow-Headers': '*',
    }
    if (req.method === 'OPTIONS') {
      preflightCount++
      res.writeHead(405)
      res.end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: `/compressed${url.search}` }); res.end(); return
    }
    if (url.pathname === '/compressed') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
      res.end(gzipSync(JSON.stringify({ marker: url.searchParams.get('marker') }))); return
    }
    if (url.pathname === '/wait') return
    if (url.pathname === '/echo') {
      const marker = url.searchParams.get('marker') ?? ''
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ marker, body: Buffer.concat(chunks).toString(), method: req.method, origin: req.headers.origin ?? null, referer: req.headers.referer ?? null }))
      })
      return
    }
    if (url.pathname === '/img') {
      res.writeHead(200, { ...cors, 'Content-Type': 'image/png' })
      res.end(PNG_1PX_BYTES)
      return
    }
    res.writeHead(404, cors)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${port}`
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function bootApp(): Promise<AppHandle> {
  const appPath = path.resolve(__dirname, 'electron-entry.js')
  const userDataDir = path.resolve(
    process.env.DIMINA_DEVTOOLS_DATA_DIR
      ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e'),
    'userdata',
    `nh-network-body-${process.pid}`,
  )
  fs.mkdirSync(userDataDir, { recursive: true })

  const app = await _electron.launch({
    args: [appPath, 'auto', '--auto-port', '0', `--user-data-dir=${userDataDir}`],
    env: { ...process.env, NODE_ENV: 'test', DIMINA_NATIVE_HOST: '1', DIMINA_E2E_USER_DATA_DIR: userDataDir },
  })

  const win = await findMainWindow(app)
  await win.waitForLoadState('domcontentloaded')

  await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    if (w && !w.isVisible()) {
      await new Promise<void>((resolve) => {
        w.once('show', resolve)
        setTimeout(resolve, 5000)
      })
    }
    if (w) {
      w.setPosition(-2000, -2000)
      w.blur()
    }
  })

  await openProjectInUI(app, FIXTURE_DIR, { waitMs: 20000 })
  await waitForSimulatorWebview(app)

  // The simulator's CDP Network tracking hangs off the DeviceShell target; gate
  // on it being mounted before any request-firing/capture step below.
  await pollUntil(
    () => evalInSimulator<boolean>(
      app,
      `(() => !!document.querySelector('.device-shell-root'))()`,
    ).catch(() => false),
    (ok) => ok === true,
    25000,
    300,
  )

  // The service host boots logic.js asynchronously after project open — poll
  // until its realm exposes wx.request before driving any call through it.
  await pollUntil(
    () => evalInWebContentsByUrl<boolean>(
      app,
      'service.html',
      `typeof wx !== 'undefined' && typeof wx.request === 'function'`,
    ).catch(() => false),
    (ready) => ready === true,
    20000,
    500,
  )

  return { app, win }
}

async function shutdownApp(handle: AppHandle | undefined): Promise<void> {
  if (!handle) return
  await closeProject(handle.app).catch(() => {})
  await handle.app.close().catch(() => {})
}

/** Execute JS in the DevTools front-end realm (devtools:// page). Null on any error. */
function evalInDevtools<T>(app: ElectronApplication, expression: string): Promise<T | null> {
  return evalInWebContentsByUrl<T>(app, 'devtools://', expression).catch(() => null)
}

/**
 * Idempotently wrap `window.DevToolsAPI.dispatchMessage` in the front-end realm
 * and stash every `Network.*` event / id-bearing reply into
 * `globalThis.__e2eCapturedCdp` (capped filter to avoid unbounded growth from
 * unrelated chatter — Runtime/DOM/Log events are not recorded). Returns
 * whether the wrapper is installed (already-installed counts as success), so
 * callers can poll it without racing front-end boot.
 */
const INSTALL_CAPTURE_SCRIPT = `(function() {
  try {
    if (globalThis.__e2eCapturedCdp) return true;
    var DTAPI = window.DevToolsAPI;
    if (!DTAPI || typeof DTAPI.dispatchMessage !== 'function') return false;
    globalThis.__e2eCapturedCdp = [];
    var orig = DTAPI.dispatchMessage.bind(DTAPI);
    DTAPI.dispatchMessage = function(messageStr) {
      try {
        var msg = (typeof messageStr === 'string') ? JSON.parse(messageStr) : messageStr;
        var isNetworkEvent = msg && typeof msg.method === 'string' && msg.method.indexOf('Network.') === 0;
        var isIdReply = msg && typeof msg.id === 'number';
        if (isNetworkEvent || isIdReply) {
          globalThis.__e2eCapturedCdp.push(msg);
        }
      } catch (e) {}
      return orig(messageStr);
    };
    return true;
  } catch (e) { return false; }
})()`

async function installCapture(app: ElectronApplication): Promise<boolean> {
  return (await pollUntil(
    () => evalInDevtools<boolean>(app, INSTALL_CAPTURE_SCRIPT),
    (ok) => ok === true,
    30000,
    300,
  )) === true
}

async function readCaptured(app: ElectronApplication): Promise<CapturedCdpMessage[]> {
  const out = await evalInDevtools<CapturedCdpMessage[]>(
    app,
    `globalThis.__e2eCapturedCdp ? globalThis.__e2eCapturedCdp.slice() : []`,
  )
  return out ?? []
}

function findRequestWillBeSent(events: CapturedCdpMessage[], urlSubstring: string, prefix = 'dimina:sim:'): CapturedCdpMessage | undefined {
  return events.find((m) =>
    m.method === 'Network.requestWillBeSent'
    && typeof m.params?.requestId === 'string'
    && m.params.requestId.startsWith(prefix)
    && typeof m.params?.request?.url === 'string'
    && m.params.request.url.includes(urlSubstring),
  )
}

function findLoadingFinished(events: CapturedCdpMessage[], requestId: string): CapturedCdpMessage | undefined {
  return events.find((m) => m.method === 'Network.loadingFinished' && m.params?.requestId === requestId)
}

function findReply(events: CapturedCdpMessage[], id: number): CapturedCdpMessage | undefined {
  return events.find((m) => m.id === id)
}

/** Fire a real `wx.request` from the service-host realm and resolve with its outcome. */
function requestExpression(url: string): string {
  return `new Promise((resolve) => {
    wx.request({
      url: ${JSON.stringify(url)},
      success: (r) => resolve({ path: 'success', statusCode: r.statusCode, data: r.data }),
      fail: (e) => resolve({ path: 'fail', errMsg: e.errMsg }),
    })
  })`
}

interface RequestOutcome {
  path: 'success' | 'fail'
  statusCode?: number
  data?: unknown
  errMsg?: string
}

/** Decode a CDP `Network.getResponseBody` result the same way a real Response tab would. */
function decodeBody(result: { body?: string; base64Encoded?: boolean }): string {
  if (!result.body) return ''
  return result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body
}

const GET_RESPONSE_BODY_ID = 424242

test.describe('native-host DevTools Network panel loads a wx.request response body', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  let handle: AppHandle | undefined
  let capturedRequestId: string | undefined
  let requestToken: string

  test.beforeAll(async () => {
    test.setTimeout(180_000)
    handle = await bootApp()
    const installed = await installCapture(handle.app)
    expect(installed, 'DevTools front-end DevToolsAPI.dispatchMessage capture must install').toBe(true)
  })

  test.afterAll(async () => {
    await shutdownApp(handle)
  })

  test('a wx.request fired in the service host is forwarded to the front-end with a dimina:http: request id', async () => {
    const { app } = handle!
    requestToken = `net-body-${Date.now()}`
    const url = `${baseUrl}/echo?marker=${requestToken}`

    const outcomePromise = evalInWebContentsByUrl<RequestOutcome>(app, 'service.html', requestExpression(url))

    const requestEvent = await pollUntil(
      async () => {
        const events = await readCaptured(app)
        return findRequestWillBeSent(events, requestToken, 'dimina:http:')
      },
      (evt) => !!evt,
      20000,
      300,
    )
    expect(
      requestEvent,
      'Network.requestWillBeSent for the request should reach the front-end with a dimina:http: requestId',
    ).toBeTruthy()
    capturedRequestId = requestEvent!.params!.requestId!

    const finishedEvent = await pollUntil(
      async () => {
        const events = await readCaptured(app)
        return findLoadingFinished(events, capturedRequestId!)
      },
      (evt) => !!evt,
      20000,
      300,
    )
    expect(
      finishedEvent,
      `Network.loadingFinished should arrive for requestId=${capturedRequestId}`,
    ).toBeTruthy()

    const outcome = await outcomePromise
    expect(outcome.path, `wx.request should resolve via success: ${JSON.stringify(outcome)}`).toBe('success')
    expect(outcome.statusCode).toBe(200)
    const appId = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'project.config.json'), 'utf8')).appid
    expect(outcome.data).toEqual({ marker: requestToken, body: '', method: 'GET', origin: null, referer: `https://servicewechat.com/${appId}/develop/page-frame.html` })
  })

  test('Network.getResponseBody for that dimina:http: id resolves with the real response body, not an error', async () => {
    const { app } = handle!
    expect(capturedRequestId, 'the previous test must have captured a dimina:http: requestId').toBeTruthy()

    await evalInDevtools(
      app,
      `globalThis.InspectorFrontendHost.sendMessageToBackend(${JSON.stringify(JSON.stringify({
        id: GET_RESPONSE_BODY_ID,
        method: 'Network.getResponseBody',
        params: { requestId: capturedRequestId },
      }))})`,
    )

    const reply = await pollUntil(
      async () => {
        const events = await readCaptured(app)
        return findReply(events, GET_RESPONSE_BODY_ID)
      },
      (evt) => !!evt,
      20000,
      300,
    )

    expect(
      reply,
      `Network.getResponseBody(id=${GET_RESPONSE_BODY_ID}) should receive a reply within 20s`,
    ).toBeTruthy()
    expect(
      reply?.error,
      `Network.getResponseBody for a dimina:http: id must not error; got: ${JSON.stringify(reply?.error)}`,
    ).toBeUndefined()
    expect(
      reply?.result,
      `Network.getResponseBody reply should carry a "result"; got: ${JSON.stringify(reply)}`,
    ).toBeTruthy()

    const decoded = decodeBody(reply!.result!)
    expect(
      decoded,
      `decoded response body should contain the request token; got: ${decoded}`,
    ).toContain(requestToken)
  })

  test('a custom-header POST has no preflight and its Payload is readable after completion', async () => {
    const { app } = handle!
    const marker = `post-body-${Date.now()}`
    const url = `${baseUrl}/echo?marker=${marker}`
    const outcome = await evalInWebContentsByUrl<RequestOutcome>(app, 'service.html', `new Promise((resolve) => {
      wx.request({ url: ${JSON.stringify(url)}, method: 'POST', header: { 'x-native-check': 'yes' }, data: { value: 42 },
        success: (r) => resolve({ path: 'success', statusCode: r.statusCode, data: r.data }),
        fail: (e) => resolve({ path: 'fail', errMsg: e.errMsg }) })
    })`)
    expect(outcome).toMatchObject({ path: 'success', statusCode: 200, data: { body: '{"value":42}', origin: null, method: 'POST' } })
    expect(preflightCount).toBe(0)
    const request = await pollUntil(async () => findRequestWillBeSent(await readCaptured(app), marker, 'dimina:http:'), (value) => !!value, 20000, 300)
    expect(request).toBeTruthy()
    const id = 424244
    await evalInDevtools(app, `globalThis.InspectorFrontendHost.sendMessageToBackend(${JSON.stringify(JSON.stringify({ id, method: 'Network.getRequestPostData', params: { requestId: request!.params!.requestId } }))})`)
    const reply = await pollUntil(async () => findReply(await readCaptured(app), id), (value) => !!value, 20000, 300)
    expect(reply?.error).toBeUndefined()
    expect(reply?.result).toEqual({ postData: '{"value":42}' })
  })

  test('redirected compressed data matches the response returned through the actual Network body hook', async () => {
    const { app } = handle!
    const marker = `redirect-${Date.now()}`
    const outcome = await evalInWebContentsByUrl<RequestOutcome>(app, 'service.html', `new Promise((resolve) => {
      wx.request({ url: ${JSON.stringify(`${baseUrl}/redirect?marker=${marker}`)},
        success: (r) => resolve({ path: 'success', statusCode: r.statusCode, data: r.data }),
        fail: (e) => resolve({ path: 'fail', errMsg: e.errMsg }) })
    })`)
    expect(outcome).toMatchObject({ path: 'success', statusCode: 200, data: { marker } })
    const request = await pollUntil(async () => findRequestWillBeSent(await readCaptured(app), marker, 'dimina:http:'), (value) => !!value, 20000, 300)
    expect(request).toBeTruthy()
    const id = 424245
    await evalInDevtools(app, `globalThis.InspectorFrontendHost.sendMessageToBackend(${JSON.stringify(JSON.stringify({ id, method: 'Network.getResponseBody', params: { requestId: request!.params!.requestId } }))})`)
    const reply = await pollUntil(async () => findReply(await readCaptured(app), id), (value) => !!value, 20000, 300)
    expect(reply?.error).toBeUndefined()
    expect(JSON.parse(decodeBody(reply!.result!))).toEqual({ marker })
  })

  test('the preload request task aborts through IPC and invokes fail then complete once', async () => {
    const outcome = await evalInSimulator(handle!.app, `new Promise((resolve, reject) => {
      const events = [];
      const task = wx.request({ url: ${JSON.stringify(`${baseUrl}/wait`)}, timeout: 1000,
        success: () => events.push('success'), fail: (e) => events.push(e.errMsg),
        complete: () => { events.push('complete'); resolve(events); } });
      if (!task || typeof task.abort !== 'function') { reject(new Error('missing preload RequestTask')); return; }
      task.abort();
    })`)
    expect(outcome).toEqual(['request:fail abort', 'complete'])
  })

  test('the preload resolves a document-relative request using its own document base', async () => {
    const outcome = await evalInSimulator(handle!.app, `new Promise((resolve) => {
      wx.request({ url: './index.html', dataType: 'text',
        success: (r) => resolve({ status: r.statusCode, html: typeof r.data === 'string' && /<html/i.test(r.data) }),
        fail: (e) => resolve({ errMsg: e.errMsg }) });
    })`)
    expect(outcome).toEqual({ status: 200, html: true })
  })

  test('a render-guest image load is forwarded with a dimina:sim: id and its body is retrievable', async () => {
    const { app } = handle!
    const imgToken = `img-body-${Date.now()}`
    const imgUrl = `${baseUrl}/img?marker=${imgToken}`

    // Load the image from inside the render-host guest realm (__frame__.html —
    // the mini-app page frame), NOT the simulator or service host: this is the
    // leg the render-guest capture wiring covers.
    const loadPromise = evalInWebContentsByUrl<boolean>(
      app,
      RENDER_GUEST_URL_MARKER,
      `new Promise((resolve) => {
        const img = new Image()
        img.onload = () => resolve(true)
        img.onerror = () => resolve(false)
        img.src = ${JSON.stringify(imgUrl)}
      })`,
    )

    const requestEvent = await pollUntil(
      async () => {
        const events = await readCaptured(app)
        return findRequestWillBeSent(events, imgToken)
      },
      (evt) => !!evt,
      20000,
      300,
    )
    expect(
      requestEvent,
      'Network.requestWillBeSent for the render-guest image load should reach the front-end with a dimina:sim: requestId',
    ).toBeTruthy()
    const imgRequestId = requestEvent!.params!.requestId!

    const finishedEvent = await pollUntil(
      async () => {
        const events = await readCaptured(app)
        return findLoadingFinished(events, imgRequestId)
      },
      (evt) => !!evt,
      20000,
      300,
    )
    expect(
      finishedEvent,
      `Network.loadingFinished should arrive for requestId=${imgRequestId}`,
    ).toBeTruthy()

    const loaded = await loadPromise
    expect(loaded, 'the <img> element in the render-guest realm should successfully load').toBe(true)

    const GET_IMG_RESPONSE_BODY_ID = 424243
    await evalInDevtools(
      app,
      `globalThis.InspectorFrontendHost.sendMessageToBackend(${JSON.stringify(JSON.stringify({
        id: GET_IMG_RESPONSE_BODY_ID,
        method: 'Network.getResponseBody',
        params: { requestId: imgRequestId },
      }))})`,
    )

    const reply = await pollUntil(
      async () => {
        const events = await readCaptured(app)
        return findReply(events, GET_IMG_RESPONSE_BODY_ID)
      },
      (evt) => !!evt,
      20000,
      300,
    )

    expect(
      reply,
      `Network.getResponseBody(id=${GET_IMG_RESPONSE_BODY_ID}) should receive a reply within 20s`,
    ).toBeTruthy()
    expect(
      reply?.error,
      `Network.getResponseBody for the image dimina:sim: id must not error; got: ${JSON.stringify(reply?.error)}`,
    ).toBeUndefined()
    expect(
      reply?.result,
      `Network.getResponseBody reply should carry a "result"; got: ${JSON.stringify(reply)}`,
    ).toBeTruthy()

    expect(reply!.result!.base64Encoded, 'the PNG body should be returned base64-encoded').toBe(true)
    const bytes = Buffer.from(reply!.result!.body ?? '', 'base64')
    expect(bytes[0], 'PNG magic byte 0 (0x89)').toBe(0x89)
    expect(bytes.subarray(1, 4).toString('latin1'), 'PNG magic bytes 1-3 ("PNG")').toBe('PNG')
  })
})
