/**
 * Service-layer wx.request HTTP-status semantics, end to end over the real
 * forwarding chain: service host → bridge-router → simulator directRequest
 * (shared request-core) → fetch → API_RESPONSE → service callbacks.
 *
 * Contract guarded (official wx.request semantics):
 *  - A received HTTP response — 401 included — resolves via `success` with
 *    `statusCode`; `fail` never fires for an HTTP status. This is what lets
 *    a mini-app branch to its login flow on 401.
 *  - A response slower than the router's flat 5s no-handler watchdog window
 *    still arrives: network-budget APIs get the wx timeout budget instead,
 *    so the router must not tear the pending call down and drop the late
 *    verdict.
 *
 * The spec runs its own loopback HTTP server. The fetch executes in the
 * simulator WCV (a different origin), so every response — the 401 included —
 * carries permissive CORS headers and OPTIONS preflights are answered;
 * without them the browser network layer rejects and the test would measure
 * CORS, not status routing.
 */
import http from 'http'
import type { AddressInfo } from 'net'
import { test, expect } from './fixtures'
import {
  DEMO_APP_DIR,
  openProjectInUI,
  waitSimulatorReady,
  evalInWebContentsByUrl,
  pollUntil,
} from './helpers'

const SLOW_RESPONSE_DELAY_MS = 7_000

let server: http.Server
let baseUrl: string

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
    if (req.url?.startsWith('/auth')) {
      res.writeHead(401, { ...cors, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    if (req.url?.startsWith('/slow')) {
      setTimeout(() => {
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      }, SLOW_RESPONSE_DELAY_MS)
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

/** Run wx.request inside the service host and resolve with whichever callback fired. */
function requestExpression(url: string): string {
  return `new Promise((resolve) => {
    wx.request({
      url: ${JSON.stringify(url)},
      success: (r) => resolve({ path: 'success', statusCode: r.statusCode, data: r.data }),
      fail: (e) => resolve({ path: 'fail', errMsg: e.errMsg, errno: e.errno }),
    })
  })`
}

interface RequestOutcome {
  path: 'success' | 'fail'
  statusCode?: number
  data?: unknown
  errMsg?: string
  errno?: number
}

async function serviceRequest(
  electronApp: Parameters<typeof evalInWebContentsByUrl>[0],
  url: string,
): Promise<RequestOutcome> {
  // The service host boots logic.js asynchronously after project open — poll
  // until its realm exposes wx.request before driving the call.
  await pollUntil(
    () => evalInWebContentsByUrl<boolean>(
      electronApp,
      'service.html',
      `typeof wx !== 'undefined' && typeof wx.request === 'function'`,
    ).catch(() => false),
    (ready) => ready === true,
    20_000,
    500,
  )
  return evalInWebContentsByUrl<RequestOutcome>(electronApp, 'service.html', requestExpression(url))
}

test.describe('service-layer wx.request HTTP status routing', () => {
  test('a 401 response reaches success with statusCode 401 (never fail)', async ({ electronApp, mainWindow }) => {
    await openProjectInUI(mainWindow, DEMO_APP_DIR)
    await waitSimulatorReady(electronApp)

    const outcome = await serviceRequest(electronApp, `${baseUrl}/auth`)

    expect(outcome.path, `fail fired instead of success: ${JSON.stringify(outcome)}`).toBe('success')
    expect(outcome.statusCode).toBe(401)
    expect(outcome.data).toEqual({ error: 'unauthorized' })
  })

  test('a response slower than the legacy 5s router watchdog still arrives via success', async ({ electronApp, mainWindow }) => {
    test.setTimeout(90_000)
    await openProjectInUI(mainWindow, DEMO_APP_DIR)
    await waitSimulatorReady(electronApp)

    const outcome = await serviceRequest(electronApp, `${baseUrl}/slow`)

    expect(outcome.path, `slow response was dropped: ${JSON.stringify(outcome)}`).toBe('success')
    expect(outcome.statusCode).toBe(200)
    expect(outcome.data).toEqual({ ok: true })
  })
})
