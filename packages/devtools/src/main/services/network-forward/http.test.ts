/**
 * Unit tests for RequestTraceSynthesizer — the pure mapper that re-shapes one
 * main-process HTTP request trace event into the exact `Network.request*`/
 * `Network.loading*` CDP message the embedded DevTools front-end renders
 * natively.
 *
 * Contracts guarded here:
 *  - `sent` mints a `dimina:http:<epoch>:<seq>` virtual requestId and carries
 *    the business url/method/headers verbatim (this row is what makes a
 *    request visible in the Network panel);
 *  - `response` passes status/statusText/headers through, deriving mimeType
 *    from the Content-Type header (case-insensitively);
 *  - `finished` carries the body ready to prime the forwarder's body-cache
 *    and releases the id mapping so a re-sent requestId gets a fresh one;
 *  - `failed` carries the errorText and also releases the id mapping;
 *  - any non-`sent` event for a requestId this synthesizer never saw is
 *    dropped (the front-end would drop it too);
 *  - the user-facing verdict is decided once at `sent` (the only event
 *    carrying a url) and reused by every later event of the same request;
 *  - timestamps convert from wall-clock ms to CDP seconds.
 */
import { describe, expect, it } from 'vitest'
import { RequestTraceSynthesizer } from './http.js'
import type { NativeRequestTrace } from '../../ipc/bridge-router.js'

const SESSION = 'owner-session-1'
const EPOCH = 'epoch-test'
const BASE_TIME = 1_700_000_000_000

interface RequestWillBeSentParams {
  requestId: string
  loaderId: string
  documentURL: string
  request: {
    url: string
    method: string
    headers: Record<string, string>
    hasPostData: boolean
    postData?: string
  }
  timestamp: number
  wallTime: number
  type: string
}

interface ResponseReceivedParams {
  requestId: string
  timestamp: number
  response: {
    status: number
    statusText: string
    headers: Record<string, string>
    mimeType: string
  }
}

interface LoadingFinishedParams {
  requestId: string
  timestamp: number
  encodedDataLength: number
}

interface LoadingFailedParams {
  requestId: string
  timestamp: number
  errorText: string
}

function makeSynthesizer(internalOrigins?: () => ReadonlyArray<string | null | undefined>): RequestTraceSynthesizer {
  return new RequestTraceSynthesizer({ epoch: EPOCH, internalOrigins })
}

function sentEvent(requestId: string, url: string, method = 'GET', postData?: string): NativeRequestTrace {
  return postData === undefined
    ? { type: 'sent', requestId, url, method, headers: { 'x-test': '1' }, time: BASE_TIME }
    : { type: 'sent', requestId, url, method, headers: { 'x-test': '1' }, postData, time: BASE_TIME }
}

function createRequest(
  synthesizer: RequestTraceSynthesizer,
  requestId: string,
  url = 'https://business.example.com/api',
  sessionId = SESSION,
): RequestWillBeSentParams {
  const message = synthesizer.synthesize(sessionId, sentEvent(requestId, url))
  expect(message).not.toBeNull()
  expect(message!.method).toBe('Network.requestWillBeSent')
  return message!.params as RequestWillBeSentParams
}

describe('RequestTraceSynthesizer', () => {
  describe('sent', () => {
    it('maps sent to Network.requestWillBeSent with a namespaced requestId and the request verbatim', () => {
      const synthesizer = makeSynthesizer()
      const message = synthesizer.synthesize(SESSION, sentEvent('r1', 'https://business.example.com/api?x=1', 'POST'))
      expect(message).not.toBeNull()
      expect(message!.method).toBe('Network.requestWillBeSent')
      const params = message!.params as RequestWillBeSentParams
      expect(params.requestId).toBe(`dimina:http:${EPOCH}:0`)
      expect(params.request.url).toBe('https://business.example.com/api?x=1')
      expect(params.request.method).toBe('POST')
      expect(params.request.headers).toEqual({ 'x-test': '1' })
      expect(params.request.hasPostData).toBe(false)
      expect(params.type).toBe('XHR')
    })

    it('mints a monotonically increasing requestId per sent request', () => {
      const synthesizer = makeSynthesizer()
      const first = createRequest(synthesizer, 'r1')
      const second = createRequest(synthesizer, 'r2')
      const third = createRequest(synthesizer, 'r3', 'https://other.example.com/', 'owner-session-2')
      expect(first.requestId).toBe(`dimina:http:${EPOCH}:0`)
      expect(second.requestId).toBe(`dimina:http:${EPOCH}:1`)
      expect(third.requestId).toBe(`dimina:http:${EPOCH}:2`)
      expect(new Set([first.requestId, second.requestId, third.requestId]).size).toBe(3)
    })

    it('carries postData and hasPostData:true when the trace event has a body, exposed for cache priming', () => {
      const synthesizer = makeSynthesizer()
      const message = synthesizer.synthesize(SESSION, sentEvent('r1', 'https://business.example.com/api', 'POST', '{"a":1}'))
      expect(message).not.toBeNull()
      const params = message!.params as RequestWillBeSentParams
      expect(params.request.hasPostData).toBe(true)
      expect(params.request.postData).toBe('{"a":1}')
      expect(message!.postData).toBe('{"a":1}')
    })

    it('omits postData entirely for a bodyless GET', () => {
      const synthesizer = makeSynthesizer()
      const message = synthesizer.synthesize(SESSION, sentEvent('r1', 'https://business.example.com/api'))
      const params = message!.params as RequestWillBeSentParams
      expect(params.request.hasPostData).toBe(false)
      expect('postData' in params.request).toBe(false)
      expect(message!.postData).toBeUndefined()
    })
  })

  describe('response', () => {
    it('maps response to Network.responseReceived with status/statusText/headers passed through and mimeType derived', () => {
      const synthesizer = makeSynthesizer()
      const { requestId } = createRequest(synthesizer, 'r1')
      const headers = { 'content-type': 'application/json; charset=utf-8', 'x-custom': 'v' }
      const message = synthesizer.synthesize(SESSION, {
        type: 'response',
        requestId: 'r1',
        status: 200,
        statusText: 'OK',
        headers,
        time: BASE_TIME + 500,
      })
      expect(message).not.toBeNull()
      expect(message!.method).toBe('Network.responseReceived')
      const params = message!.params as ResponseReceivedParams
      expect(params.requestId).toBe(requestId)
      expect(params.response.status).toBe(200)
      expect(params.response.statusText).toBe('OK')
      expect(params.response.headers).toEqual(headers)
      expect(params.response.mimeType).toBe('application/json')
      expect(params.timestamp).toBe((BASE_TIME + 500) / 1000)
    })

    it('derives mimeType case-insensitively and defaults to empty string when Content-Type is absent', () => {
      const synthesizer = makeSynthesizer()
      createRequest(synthesizer, 'r1')
      const message = synthesizer.synthesize(SESSION, {
        type: 'response',
        requestId: 'r1',
        status: 200,
        statusText: 'OK',
        headers: { 'Content-Type': 'text/plain' },
        time: BASE_TIME,
      })
      const params = message!.params as ResponseReceivedParams
      expect(params.response.mimeType).toBe('text/plain')

      const noContentType = synthesizer.synthesize(SESSION, {
        type: 'response',
        requestId: 'r1',
        status: 204,
        statusText: 'No Content',
        headers: {},
        time: BASE_TIME,
      })
      expect((noContentType!.params as ResponseReceivedParams).response.mimeType).toBe('')
    })

    it('an HTTP error status (401/500) still maps to responseReceived, never loadingFailed', () => {
      const synthesizer = makeSynthesizer()
      createRequest(synthesizer, 'r1')
      const message = synthesizer.synthesize(SESSION, {
        type: 'response',
        requestId: 'r1',
        status: 401,
        statusText: 'Unauthorized',
        headers: {},
        time: BASE_TIME,
      })
      expect(message!.method).toBe('Network.responseReceived')
      expect((message!.params as ResponseReceivedParams).response.status).toBe(401)
    })
  })

  describe('finished and failed', () => {
    it('maps finished to Network.loadingFinished, carrying the body for cache priming', () => {
      const synthesizer = makeSynthesizer()
      const { requestId } = createRequest(synthesizer, 'r1')
      const message = synthesizer.synthesize(SESSION, {
        type: 'finished',
        requestId: 'r1',
        body: Buffer.from('{"a":1}').toString('base64'),
        bodyBase64Encoded: true,
        encodedDataLength: 7,
        time: BASE_TIME + 1000,
      })
      expect(message).not.toBeNull()
      expect(message!.method).toBe('Network.loadingFinished')
      const params = message!.params as LoadingFinishedParams
      expect(params.requestId).toBe(requestId)
      expect(params.encodedDataLength).toBe(7)
      expect(params.timestamp).toBe((BASE_TIME + 1000) / 1000)
      expect(message!.body).toEqual({ base64Encoded: true, body: Buffer.from('{"a":1}').toString('base64') })
    })

    it('maps failed to Network.loadingFailed carrying the errorText', () => {
      const synthesizer = makeSynthesizer()
      const { requestId } = createRequest(synthesizer, 'r1')
      const message = synthesizer.synthesize(SESSION, {
        type: 'failed',
        requestId: 'r1',
        errorText: 'request:fail timeout',
        time: BASE_TIME + 2000,
      })
      expect(message).not.toBeNull()
      expect(message!.method).toBe('Network.loadingFailed')
      const params = message!.params as LoadingFailedParams
      expect(params.requestId).toBe(requestId)
      expect(params.errorText).toBe('request:fail timeout')
    })

    it('releases the id mapping at finished so a re-sent requestId mints a fresh virtual id', () => {
      const synthesizer = makeSynthesizer()
      const first = createRequest(synthesizer, 'r1')
      synthesizer.synthesize(SESSION, { type: 'finished', requestId: 'r1', body: '', bodyBase64Encoded: true, encodedDataLength: 0, time: BASE_TIME + 1 })

      const straggler = synthesizer.synthesize(SESSION, { type: 'response', requestId: 'r1', status: 200, statusText: 'OK', headers: {}, time: BASE_TIME + 2 })
      expect(straggler).toBeNull()

      const second = createRequest(synthesizer, 'r1')
      expect(second.requestId).not.toBe(first.requestId)
      expect(second.requestId).toBe(`dimina:http:${EPOCH}:1`)
    })

    it('releases the id mapping at failed too', () => {
      const synthesizer = makeSynthesizer()
      createRequest(synthesizer, 'r1')
      synthesizer.synthesize(SESSION, { type: 'failed', requestId: 'r1', errorText: 'boom', time: BASE_TIME + 1 })
      const straggler = synthesizer.synthesize(SESSION, { type: 'response', requestId: 'r1', status: 200, statusText: 'OK', headers: {}, time: BASE_TIME + 2 })
      expect(straggler).toBeNull()
    })
  })

  describe('unknown-requestId discipline', () => {
    it('drops response, finished and failed events for a requestId that was never sent', () => {
      const synthesizer = makeSynthesizer()
      const response = synthesizer.synthesize(SESSION, { type: 'response', requestId: 'ghost', status: 200, statusText: 'OK', headers: {}, time: BASE_TIME })
      const finished = synthesizer.synthesize(SESSION, { type: 'finished', requestId: 'ghost', body: '', bodyBase64Encoded: true, encodedDataLength: 0, time: BASE_TIME })
      const failed = synthesizer.synthesize(SESSION, { type: 'failed', requestId: 'ghost', errorText: 'boom', time: BASE_TIME })
      expect(response).toBeNull()
      expect(finished).toBeNull()
      expect(failed).toBeNull()
    })

    it('drops events arriving on a session whose requestId was never sent there', () => {
      const synthesizer = makeSynthesizer()
      createRequest(synthesizer, 'r1', 'https://business.example.com/', 'owner-session-1')
      const leaked = synthesizer.synthesize('owner-session-2', {
        type: 'response',
        requestId: 'r1',
        status: 200,
        statusText: 'OK',
        headers: {},
        time: BASE_TIME,
      })
      expect(leaked).toBeNull()
    })
  })

  describe('user-facing verdict', () => {
    it('flags a business https url as user-facing on every event of the request', () => {
      const synthesizer = makeSynthesizer(() => ['http://127.0.0.1:54321/'])
      const sent = synthesizer.synthesize(SESSION, sentEvent('r1', 'https://business.example.com/api'))
      expect(sent!.userFacing).toBe(true)
      const finished = synthesizer.synthesize(SESSION, { type: 'finished', requestId: 'r1', body: '', bodyBase64Encoded: true, encodedDataLength: 0, time: BASE_TIME + 1 })
      expect(finished!.userFacing).toBe(true)
    })

    it('flags a request whose url origin matches internalOrigins as not user-facing, decided once at sent', () => {
      const synthesizer = makeSynthesizer(() => ['http://127.0.0.1:54321/', null, undefined])
      const sent = synthesizer.synthesize(SESSION, sentEvent('r1', 'http://127.0.0.1:54321/internal'))
      expect(sent!.userFacing).toBe(false)
      // Later events carry no url of their own; they must reuse the
      // sent-time verdict rather than re-deriving (or failing open).
      const response = synthesizer.synthesize(SESSION, { type: 'response', requestId: 'r1', status: 200, statusText: 'OK', headers: {}, time: BASE_TIME + 1 })
      expect(response!.userFacing).toBe(false)
      const finished = synthesizer.synthesize(SESSION, { type: 'finished', requestId: 'r1', body: '', bodyBase64Encoded: true, encodedDataLength: 0, time: BASE_TIME + 2 })
      expect(finished!.userFacing).toBe(false)
    })

    it('re-reads internalOrigins at each sent instead of caching across requests', () => {
      let internal: ReadonlyArray<string | null | undefined> = []
      const synthesizer = makeSynthesizer(() => internal)
      const before = synthesizer.synthesize(SESSION, sentEvent('r1', 'http://127.0.0.1:54321/api'))
      expect(before!.userFacing).toBe(true)
      internal = ['http://127.0.0.1:54321/']
      const after = synthesizer.synthesize(SESSION, sentEvent('r2', 'http://127.0.0.1:54321/api'))
      expect(after!.userFacing).toBe(false)
    })
  })
})
