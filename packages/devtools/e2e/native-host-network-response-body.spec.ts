/**
 * E2E (native-host): the right-panel Chrome DevTools "Network" panel can load a
 * response body for a mini-app `wx.request` call.
 *
 * Topology: `wx.request` issued by the service host is forwarded (via the
 * shared request-core / bridge-router — see request-statuscode.spec.ts) to a
 * real fetch executed in the SIMULATOR WebContents (the top-level DeviceShell
 * WebContentsView). The main process attaches a CDP debugger session to that
 * simulator wc, observes its `Network.*` events, rewrites each `requestId` to
 * a `dimina:sim:`-prefixed virtual id (so it can never collide with an id the
 * front-end's own natively-attached target — the service host — produces),
 * and re-injects the rewritten event into the right-panel DevTools front-end
 * via `window.DevToolsAPI.dispatchMessage`.
 *
 * That first leg (events arriving with a `dimina:sim:` id) already works and
 * is pinned by the first test below. The CONTRACT this spec exists to guard
 * is the second leg: when the user opens the Response tab for such a request,
 * the front-end sends `Network.getResponseBody({requestId: "dimina:sim:…"})`
 * back to whatever target `InspectorFrontendHost.sendMessageToBackend`
 * natively talks to (the service host's own CDP session). That target has
 * never heard of a `dimina:sim:` id — it belongs to a DIFFERENT wc's CDP
 * session — so the naive round-trip resolves with an error ("No resource
 * with given identifier found"), which is the regression this spec fails
 * red on. The fix intercepts `getResponseBody` calls for `dimina:sim:` ids in
 * the wrapped `sendMessageToBackend`, answers from a main-process prefetch
 * cache keyed by the virtual id, and replies through the same
 * `DevToolsAPI.dispatchMessage` channel the real backend would use.
 *
 * We can't read the closed-shadow Network panel UI, so — mirroring
 * native-host-devtools-elements.spec.ts / native-host-devtools-console.spec.ts
 * — we drive and observe the front-end's own CDP wire protocol directly:
 * wrap `DevToolsAPI.dispatchMessage` to capture every `Network.*` event and
 * every id-bearing reply, then issue the same `getResponseBody` command a
 * real Response-tab click would send.
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import http from 'http'
import type { AddressInfo } from 'net'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import {
  openProjectInUI,
  waitForSimulatorWebview,
  closeProject,
  pollUntil,
  evalInSimulator,
  evalInWebContentsByUrl,
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
  result?: { body?: string; base64Encoded?: boolean }
  error?: { message?: string }
}

let server: http.Server
let baseUrl: string

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
      res.writeHead(204, cors)
      res.end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/echo') {
      const marker = url.searchParams.get('marker') ?? ''
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ marker }))
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

  const win = await app.firstWindow()
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

  await openProjectInUI(win, FIXTURE_DIR, { waitMs: 20000 })
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
  await closeProject(handle.win).catch(() => {})
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

function findRequestWillBeSent(events: CapturedCdpMessage[], urlSubstring: string): CapturedCdpMessage | undefined {
  return events.find((m) =>
    m.method === 'Network.requestWillBeSent'
    && typeof m.params?.requestId === 'string'
    && m.params.requestId.startsWith('dimina:sim:')
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

  test('a wx.request fired in the service host is forwarded to the front-end with a dimina:sim: request id', async () => {
    const { app } = handle!
    requestToken = `net-body-${Date.now()}`
    const url = `${baseUrl}/echo?marker=${requestToken}`

    const outcomePromise = evalInWebContentsByUrl<RequestOutcome>(app, 'service.html', requestExpression(url))

    const requestEvent = await pollUntil(
      async () => {
        const events = await readCaptured(app)
        return findRequestWillBeSent(events, requestToken)
      },
      (evt) => !!evt,
      20000,
      300,
    )
    expect(
      requestEvent,
      'Network.requestWillBeSent for the request should reach the front-end with a dimina:sim: requestId',
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
    expect(outcome.data).toEqual({ marker: requestToken })
  })

  test('Network.getResponseBody for that dimina:sim: id resolves with the real response body, not an error', async () => {
    const { app } = handle!
    expect(capturedRequestId, 'the previous test must have captured a dimina:sim: requestId').toBeTruthy()

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
      `Network.getResponseBody for a dimina:sim: id must not error; got: ${JSON.stringify(reply?.error)}`,
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

  test('a render-guest image load is forwarded with a dimina:sim: id and its body is retrievable', async () => {
    const { app } = handle!
    const imgToken = `img-body-${Date.now()}`
    const imgUrl = `${baseUrl}/img?marker=${imgToken}`

    // Load the image from inside the render-host guest realm (pageFrame.html —
    // the mini-app page frame), NOT the simulator or service host: this is the
    // leg the render-guest capture wiring covers.
    const loadPromise = evalInWebContentsByUrl<boolean>(
      app,
      'pageFrame.html',
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
