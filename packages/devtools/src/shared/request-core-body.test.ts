/**
 * `performRequest` body/query serialization and response-decoding contract.
 * HTTP status semantics, timeout/abort, and header merging are covered in
 * request-core.test.ts; this file covers:
 *
 *  - method default ('GET') and GET/HEAD query-param encoding (no body).
 *  - non-GET/HEAD body encoding: string data passes through verbatim; object
 *    data JSON-encodes under the (default) application/json content-type, or
 *    form-encodes under application/x-www-form-urlencoded.
 *  - dataType default 'json' parses a JSON-shaped response body and falls
 *    back to raw text without throwing when the body is not valid JSON; any
 *    other dataType leaves the body as raw text even when it happens to
 *    parse as JSON.
 *  - responseType 'arraybuffer' (and the legacy dataType 'arraybuffer' spelling)
 *    yields an ArrayBuffer instead of decoded text/JSON.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { performRequest, type RequestFailResult, type RequestSuccessResult } from './request-core'

async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

function okResponse(body: BodyInit = '{}'): Response {
  return new Response(body, { status: 200 })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('performRequest — method default and GET/HEAD query encoding', () => {
  it('omitting `method` defaults to GET: an object `data` is appended as URL query params, not a body', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(okResponse()))
    vi.stubGlobal('fetch', fetchMock)

    performRequest({ url: 'https://example.com/api', data: { a: 1, b: 'x' } }, {})
    await flushMicrotasks()

    const [urlArg, init] = fetchMock.mock.calls[0]
    const url = new URL(String(urlArg))
    expect(url.searchParams.get('a')).toBe('1')
    expect(url.searchParams.get('b')).toBe('x')
    expect(init?.body).toBeUndefined()
  })

  it('HEAD with an object `data` also appends query params and sends no body', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(okResponse()))
    vi.stubGlobal('fetch', fetchMock)

    performRequest({ url: 'https://example.com/api', method: 'HEAD', data: { q: 'search term' } }, {})
    await flushMicrotasks()

    const [urlArg, init] = fetchMock.mock.calls[0]
    const url = new URL(String(urlArg))
    expect(url.searchParams.get('q')).toBe('search term')
    expect(init?.body).toBeUndefined()
  })
})

describe('performRequest — non-GET/HEAD body encoding', () => {
  it('a string `data` is sent as the body verbatim, untouched', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(okResponse()))
    vi.stubGlobal('fetch', fetchMock)

    performRequest({ url: 'https://example.com/api', method: 'POST', data: 'raw=body&x=1' }, {})
    await flushMicrotasks()

    const init = fetchMock.mock.calls[0][1]
    expect(init?.body).toBe('raw=body&x=1')
  })

  it('an object `data` under the default (application/json) content-type is JSON-encoded', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(okResponse()))
    vi.stubGlobal('fetch', fetchMock)

    performRequest({ url: 'https://example.com/api', method: 'POST', data: { a: 1, b: 'x' } }, {})
    await flushMicrotasks()

    const init = fetchMock.mock.calls[0][1]
    expect(init?.body).toBe(JSON.stringify({ a: 1, b: 'x' }))
  })

  it('an object `data` under application/x-www-form-urlencoded is form-encoded as key=value pairs, not JSON', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(okResponse()))
    vi.stubGlobal('fetch', fetchMock)

    performRequest({
      url: 'https://example.com/api',
      method: 'POST',
      header: { 'content-type': 'application/x-www-form-urlencoded' },
      data: { a: 1, b: 'x' },
    }, {})
    await flushMicrotasks()

    const init = fetchMock.mock.calls[0][1]
    expect(typeof init?.body).toBe('string')
    expect(init?.body).not.toContain('{')
    const parsed = new URLSearchParams(init?.body as string)
    expect(parsed.get('a')).toBe('1')
    expect(parsed.get('b')).toBe('x')
  })
})

describe('performRequest — dataType (default "json")', () => {
  it('parses a JSON-shaped response body into `data`', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okResponse(JSON.stringify({ ok: true, n: 3 })))))
    const success = vi.fn<(res: RequestSuccessResult) => void>()

    performRequest({ url: 'https://example.com/api' }, { success })
    await flushMicrotasks()

    expect(success).toHaveBeenCalledTimes(1)
    expect(success.mock.calls[0][0].data).toEqual({ ok: true, n: 3 })
  })

  it('falls back to the raw text when the response body is not valid JSON, without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okResponse('not-json{{{'))))
    const success = vi.fn<(res: RequestSuccessResult) => void>()
    const fail = vi.fn<(err: RequestFailResult) => void>()

    performRequest({ url: 'https://example.com/api' }, { success, fail })
    await flushMicrotasks()

    expect(fail).not.toHaveBeenCalled()
    expect(success).toHaveBeenCalledTimes(1)
    expect(success.mock.calls[0][0].data).toBe('not-json{{{')
  })

  it('a non-"json" dataType leaves the response body as raw text, even when it happens to be valid JSON', async () => {
    const jsonText = JSON.stringify({ a: 1 })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okResponse(jsonText))))
    const success = vi.fn<(res: RequestSuccessResult) => void>()

    performRequest({ url: 'https://example.com/api', dataType: 'text' }, { success })
    await flushMicrotasks()

    expect(success.mock.calls[0][0].data).toBe(jsonText)
  })
})

describe('performRequest — responseType "arraybuffer"', () => {
  it('yields an ArrayBuffer in `data`, bypassing text/JSON decoding', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okResponse(bytes))))
    const success = vi.fn<(res: RequestSuccessResult) => void>()

    performRequest({ url: 'https://example.com/api', responseType: 'arraybuffer' }, { success })
    await flushMicrotasks()

    const data = success.mock.calls[0][0].data
    expect(data).toBeInstanceOf(ArrayBuffer)
    expect(new Uint8Array(data as ArrayBuffer)).toEqual(bytes)
  })

  it('the legacy dataType "arraybuffer" spelling is honoured the same as responseType "arraybuffer"', async () => {
    const bytes = new Uint8Array([9, 8, 7])
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okResponse(bytes))))
    const success = vi.fn<(res: RequestSuccessResult) => void>()

    performRequest({ url: 'https://example.com/api', dataType: 'arraybuffer' }, { success })
    await flushMicrotasks()

    const data = success.mock.calls[0][0].data
    expect(data).toBeInstanceOf(ArrayBuffer)
    expect(new Uint8Array(data as ArrayBuffer)).toEqual(bytes)
  })
})
