/**
 * `directRequest` must align with wx.request's HTTP-status-agnostic success
 * contract: any received HTTP response — including 401/500 — resolves via the
 * wired `success` callback with a full `{ data, statusCode, header, errMsg }`
 * object, never the wired `fail` callback. `fail` is reserved for
 * network-layer failures (fetch rejection), and its `errMsg` must never be
 * empty.
 *
 * Today `directRequest` treats any non-2xx response as a failure and calls
 * `fail` with `{ errMsg: '' }` — statusCode and body are dropped entirely,
 * making auth-status branching (401 handling) impossible from userland.
 *
 * Header-merge/dedup for this same handler is pinned separately in
 * direct-request-headers.test.ts (left untouched).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { directRequest } from './direct-request'
import type { RequestFailResult, RequestSuccessResult } from '../shared/request-core.js'

// Mirrors the seam used by direct-request-headers.test.ts and
// run-api-async-request-routing.test.ts: `this.createCallbackFunction` hands
// back the already-concrete function it was given.
const ctx = { appId: 'test-app', createCallbackFunction: (fn: unknown) => (typeof fn === 'function' ? fn as (...a: unknown[]) => void : undefined) }

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Fire `directRequest` and drain the fetch/.then chain before assertions run. */
async function request(args: Parameters<typeof directRequest>[0]): Promise<void> {
  directRequest.call(ctx, args)
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('directRequest — HTTP status never decides success vs fail', () => {
  it('a 401 response invokes success (not fail) with statusCode 401', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })))
    const success = vi.fn<(res: RequestSuccessResult) => void>()
    const fail = vi.fn<(err: RequestFailResult) => void>()

    await request({ url: 'https://example.com/api', success, fail })

    expect(fail).not.toHaveBeenCalled()
    expect(success).toHaveBeenCalledTimes(1)
    expect(success.mock.calls[0][0].statusCode).toBe(401)
  })

  it('a 500 response invokes success (not fail) with statusCode 500', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response('Internal Server Error', { status: 500 })))
    const success = vi.fn<(res: RequestSuccessResult) => void>()
    const fail = vi.fn<(err: RequestFailResult) => void>()

    await request({ url: 'https://example.com/api', success, fail })

    expect(fail).not.toHaveBeenCalled()
    expect(success).toHaveBeenCalledTimes(1)
    expect(success.mock.calls[0][0].statusCode).toBe(500)
  })

  it('a network-layer rejection invokes fail (not success) with a non-empty request:fail-prefixed errMsg', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')))
    const success = vi.fn<(res: RequestSuccessResult) => void>()
    const fail = vi.fn<(err: RequestFailResult) => void>()

    await request({ url: 'https://example.com/api', success, fail })

    expect(success).not.toHaveBeenCalled()
    expect(fail).toHaveBeenCalledTimes(1)
    const err = fail.mock.calls[0][0]
    expect(typeof err.errMsg).toBe('string')
    expect(err.errMsg.length).toBeGreaterThan(0)
    expect(err.errMsg.startsWith('request:fail')).toBe(true)
  })

  it('complete fires once after a 401, receiving the identical object success received', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response('{}', { status: 401 })))
    const success = vi.fn<(res: RequestSuccessResult) => void>()
    const complete = vi.fn<(res: RequestSuccessResult | RequestFailResult) => void>()

    await request({ url: 'https://example.com/api', success, complete })

    expect(complete).toHaveBeenCalledTimes(1)
    expect(complete).toHaveBeenCalledWith(success.mock.calls[0][0])
  })

  it('complete fires once after a network-layer rejection, receiving the identical object fail received', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')))
    const fail = vi.fn<(err: RequestFailResult) => void>()
    const complete = vi.fn<(res: RequestSuccessResult | RequestFailResult) => void>()

    await request({ url: 'https://example.com/api', fail, complete })

    expect(complete).toHaveBeenCalledTimes(1)
    expect(complete).toHaveBeenCalledWith(fail.mock.calls[0][0])
  })
})
