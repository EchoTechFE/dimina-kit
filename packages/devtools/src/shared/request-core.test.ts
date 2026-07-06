/**
 * `performRequest` is the single authoritative implementation of wx.request
 * network semantics: it must decide success vs fail purely from whether a
 * server response was received, never from the HTTP status code.
 *
 * Contract pinned here (mirrors the official wx.request semantics):
 *  - Any HTTP response — including 401/404/500 — resolves via `success` with
 *    `{ data, statusCode, header, errMsg: 'request:ok' }`. `fail` must never
 *    fire for a non-2xx status: this is the exact defect callers hit today
 *    (statusCode dropped, empty errMsg, no way to branch on 401).
 *  - `fail` fires ONLY for network-layer failures (timeout, abort, DNS/
 *    connection errors) and always carries a non-empty `errMsg` prefixed with
 *    'request:fail'.
 *  - `timeout`: a positive caller value is honoured; omitted or non-positive
 *    falls back to the wx default of 60000ms — never an indefinite hang.
 *  - The returned `RequestHandle.abort()` cancels an in-flight request with
 *    `request:fail abort`, and a response that arrives after abort must not
 *    resurrect success.
 *  - `complete` fires exactly once, after success or fail, with that same
 *    object.
 *  - Outgoing headers merge case-insensitively: the caller's `content-type`
 *    (any casing) wins outright and must never be duplicated with the
 *    runtime's `application/json` default.
 *
 * Request body/method/dataType/responseType serialization is covered
 * separately in request-core-body.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { performRequest, type RequestFailResult, type RequestSuccessResult } from './request-core'

/** A fetch stub whose promise never settles on its own — the request only
 * resolves through `performRequest`'s own timeout/abort race, never because
 * the network call itself answered. */
function hangingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(() => new Promise(() => {}))
}

/** Flush the microtask queue enough times for a chained .then/.catch/.finally
 * pipeline to settle without relying on fake timers. */
async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('performRequest — HTTP status never decides success vs fail', () => {
  it('a 401 response invokes success (not fail) carrying statusCode 401', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(
      new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } }),
    )))
    const success = vi.fn<(res: RequestSuccessResult) => void>()
    const fail = vi.fn<(err: RequestFailResult) => void>()

    performRequest({ url: 'https://example.com/x' }, { success, fail })
    await flushMicrotasks()

    expect(fail).not.toHaveBeenCalled()
    expect(success).toHaveBeenCalledTimes(1)
    const res = success.mock.calls[0][0]
    expect(res.statusCode).toBe(401)
    expect(res.errMsg).toBe('request:ok')
  })

  it('a 500 response invokes success (not fail) carrying statusCode 500', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(
      new Response('Internal Server Error', { status: 500 }),
    )))
    const success = vi.fn<(res: RequestSuccessResult) => void>()
    const fail = vi.fn<(err: RequestFailResult) => void>()

    performRequest({ url: 'https://example.com/x' }, { success, fail })
    await flushMicrotasks()

    expect(fail).not.toHaveBeenCalled()
    expect(success).toHaveBeenCalledTimes(1)
    expect(success.mock.calls[0][0].statusCode).toBe(500)
  })

  it('a network-layer rejection fails with a non-empty request:fail-prefixed errMsg carrying the reason', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))))
    const success = vi.fn<(res: RequestSuccessResult) => void>()
    const fail = vi.fn<(err: RequestFailResult) => void>()

    performRequest({ url: 'https://example.com/x' }, { success, fail })
    await flushMicrotasks()

    expect(success).not.toHaveBeenCalled()
    expect(fail).toHaveBeenCalledTimes(1)
    const err = fail.mock.calls[0][0]
    expect(err.errMsg.startsWith('request:fail')).toBe(true)
    expect(err.errMsg).not.toBe('request:fail')
    expect(err.errMsg).toContain('ECONNREFUSED')
  })
})

describe('performRequest — timeout', () => {
  it('no response within the given `timeout` ms fails with request:fail timeout, not success', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', hangingFetch())
    const success = vi.fn<(res: RequestSuccessResult) => void>()
    const fail = vi.fn<(err: RequestFailResult) => void>()

    performRequest({ url: 'https://example.com/x', timeout: 5000 }, { success, fail })
    await vi.advanceTimersByTimeAsync(5000)

    expect(success).not.toHaveBeenCalled()
    expect(fail).toHaveBeenCalledTimes(1)
    expect(fail.mock.calls[0][0]).toMatchObject({ errMsg: 'request:fail timeout' })
  })

  it('omitting `timeout` defaults to 60000ms, not an indefinite hang', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', hangingFetch())
    const fail = vi.fn<(err: RequestFailResult) => void>()

    performRequest({ url: 'https://example.com/x' }, { fail })
    await vi.advanceTimersByTimeAsync(59_999)
    expect(fail).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(fail).toHaveBeenCalledTimes(1)
    expect(fail.mock.calls[0][0].errMsg).toBe('request:fail timeout')
  })

  it('a non-positive `timeout` (0 or negative) falls back to the 60000ms default instead of firing immediately', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', hangingFetch())
    const fail = vi.fn<(err: RequestFailResult) => void>()

    performRequest({ url: 'https://example.com/x', timeout: -100 }, { fail })
    await vi.advanceTimersByTimeAsync(59_999)
    expect(fail).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(fail).toHaveBeenCalledTimes(1)
  })
})

describe('performRequest — abort', () => {
  it('calling the returned handle\'s abort() fails with request:fail abort and suppresses a later response', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    const success = vi.fn<(res: RequestSuccessResult) => void>()
    const fail = vi.fn<(err: RequestFailResult) => void>()

    const handle = performRequest({ url: 'https://example.com/x' }, { success, fail })
    handle.abort()
    await flushMicrotasks()

    expect(success).not.toHaveBeenCalled()
    expect(fail).toHaveBeenCalledTimes(1)
    expect(fail.mock.calls[0][0]).toMatchObject({ errMsg: 'request:fail abort' })
  })

  it('performRequest returns a handle with an abort() function synchronously, before the network call settles', () => {
    vi.stubGlobal('fetch', hangingFetch())
    const handle = performRequest({ url: 'https://example.com/x' }, {})
    expect(typeof handle.abort).toBe('function')
  })
})

describe('performRequest — complete callback', () => {
  it('fires exactly once after success, with the identical object success received', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))))
    const success = vi.fn<(res: RequestSuccessResult) => void>()
    const complete = vi.fn<(res: RequestSuccessResult | RequestFailResult) => void>()

    performRequest({ url: 'https://example.com/x' }, { success, complete })
    await flushMicrotasks()

    expect(complete).toHaveBeenCalledTimes(1)
    expect(complete).toHaveBeenCalledWith(success.mock.calls[0][0])
  })

  it('fires exactly once after fail, with the identical object fail received', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('boom'))))
    const fail = vi.fn<(err: RequestFailResult) => void>()
    const complete = vi.fn<(res: RequestSuccessResult | RequestFailResult) => void>()

    performRequest({ url: 'https://example.com/x' }, { fail, complete })
    await flushMicrotasks()

    expect(complete).toHaveBeenCalledTimes(1)
    expect(complete).toHaveBeenCalledWith(fail.mock.calls[0][0])
  })
})

describe('performRequest — header merge is case-insensitive and never duplicates content-type', () => {
  it('a caller-supplied lowercase content-type is sent exactly once, no comma-joined duplicate', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(new Response('{}', { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)

    performRequest({ url: 'https://example.com/x', method: 'POST', header: { 'content-type': 'application/json' }, data: {} }, {})
    await flushMicrotasks()

    const init = fetchMock.mock.calls[0][1]
    const headers = new Headers(init?.headers as HeadersInit)
    expect(headers.get('content-type')).not.toContain(',')
    expect(headers.get('content-type')).toBe('application/json')
  })

  it('omitting content-type applies the application/json default exactly once', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(new Response('{}', { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)

    performRequest({ url: 'https://example.com/x', method: 'POST', data: {} }, {})
    await flushMicrotasks()

    const init = fetchMock.mock.calls[0][1]
    const headers = new Headers(init?.headers as HeadersInit)
    expect(headers.get('content-type')).not.toContain(',')
    expect(headers.get('content-type')).toBe('application/json')
  })

  it('a title-case Content-Type with a custom value wins outright over the default', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(new Response('{}', { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)

    performRequest({ url: 'https://example.com/x', method: 'POST', header: { 'Content-Type': 'application/x-www-form-urlencoded' }, data: {} }, {})
    await flushMicrotasks()

    const init = fetchMock.mock.calls[0][1]
    const headers = new Headers(init?.headers as HeadersInit)
    expect(headers.get('content-type')).not.toContain(',')
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded')
  })
})
