/**
 * The `window.wx.request` shim `setupApiCompatHook()` installs must align
 * with wx.request's HTTP-status-agnostic contract: any received response —
 * including 401 — resolves via `success` with a full `{ statusCode, … }`
 * object, never `fail`.
 *
 * It must also carry the same case-insensitive content-type dedup contract
 * `directRequest` has (direct-request-headers.test.ts): the current
 * implementation merges headers with a plain-object spread
 * (`{ 'Content-Type': …, ...header }`), which produces two distinct keys
 * when the caller supplies a differently-cased `content-type` — `new
 * Headers()` then joins them into `application/json, application/json`.
 *
 * Environment: jsdom (this package's default vitest environment), so
 * `window`/`Response`/`Headers` are the real browser-ish globals the shim
 * runs against.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setupApiCompatHook } from './api-compat'
import type { RequestFailResult, RequestSuccessResult } from '../../shared/request-core.js'

type WxWindow = Window & { wx?: Record<string, unknown> }

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  ;(window as WxWindow).wx = {}
  fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(new Response('{}', { status: 200 })))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  delete (window as WxWindow).wx
  vi.unstubAllGlobals()
})

/** Call the installed wx.request shim and drain its internal fetch chain. */
async function callWxRequest(opts: Record<string, unknown>): Promise<void> {
  setupApiCompatHook()
  const wx = (window as WxWindow).wx as { request: (o: Record<string, unknown>) => unknown }
  wx.request(opts)
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('wx.request shim (api-compat) — HTTP status never decides success vs fail', () => {
  it('a 401 response invokes success (not fail) with statusCode 401', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response('{}', { status: 401 })))
    const success = vi.fn<(res: RequestSuccessResult) => void>()
    const fail = vi.fn<(err: RequestFailResult) => void>()

    await callWxRequest({ url: 'https://example.com/api', success, fail })

    expect(fail).not.toHaveBeenCalled()
    expect(success).toHaveBeenCalledTimes(1)
    expect(success.mock.calls[0][0].statusCode).toBe(401)
  })
})

describe('wx.request shim (api-compat) — content-type header dedup', () => {
  it('a caller-supplied lowercase content-type is sent exactly once, not comma-joined with the runtime default', async () => {
    await callWxRequest({
      url: 'https://example.com/api',
      method: 'POST',
      header: { 'content-type': 'application/json' },
    })

    const init = fetchMock.mock.calls[0][1]
    const headers = new Headers(init?.headers as HeadersInit)
    const ct = headers.get('content-type')
    expect(ct).not.toContain(',')
    expect(ct).toBe('application/json')
  })

  it('omitting content-type applies the runtime default exactly once (no duplicate key)', async () => {
    await callWxRequest({
      url: 'https://example.com/api',
      method: 'POST',
      header: {},
    })

    const init = fetchMock.mock.calls[0][1]
    const headers = new Headers(init?.headers as HeadersInit)
    const ct = headers.get('content-type')
    expect(ct).not.toContain(',')
    expect(ct).toBe('application/json')
  })
})

describe('wx.request shim (api-compat) — return value', () => {
  it('returns a request task exposing abort() as a function', async () => {
    setupApiCompatHook()
    const wx = (window as WxWindow).wx as { request: (o: Record<string, unknown>) => { abort?: unknown } }
    const task = wx.request({ url: 'https://example.com/api' })

    expect(typeof task.abort).toBe('function')
  })
})
