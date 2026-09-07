import { describe, expect, it } from 'vitest'
import { RequestTraceSynthesizer } from './http.js'

const sent = { type: 'sent' as const, requestId: 'r', url: 'https://example.com/start', method: 'GET', headers: {}, time: 0 }
const actual = {
  requestHeaders: { Host: 'example.com', Connection: 'keep-alive', 'X-Repeated': 'one\ntwo' },
  requestHeadersText: 'GET /start HTTP/1.1\r\nHost: example.com\r\nConnection: keep-alive\r\nX-Repeated: one\r\nX-Repeated: two\r\n\r\n',
}
const response = { type: 'response' as const, requestId: 'r', status: 200, statusText: 'OK', headers: {}, time: 1 }

describe('native HTTP request headers in CDP', () => {
  it('supplies actual fields and verbatim source through the response understood by Chromium', () => {
    const synth = new RequestTraceSynthesizer({ epoch: 'test' })
    synth.synthesize('owner', sent)
    expect(synth.synthesize('owner', { ...response, ...actual })).toMatchObject({
      method: 'Network.responseReceived', params: { response: actual },
    })
  })

  it('attaches the previous hop source to redirectResponse without contaminating the next request', () => {
    const synth = new RequestTraceSynthesizer({ epoch: 'test' })
    synth.synthesize('owner', sent)
    expect(synth.synthesize('owner', {
      ...sent, type: 'redirect', url: 'https://other.example/end', time: 1,
      redirectResponse: { url: sent.url, status: 302, statusText: 'Found', headers: { location: 'https://other.example/end' }, ...actual },
    })).toMatchObject({ params: { request: { headers: {} }, redirectResponse: actual } })
    const message = synth.synthesize('owner', response)!
    expect(message).toMatchObject({ params: { response: { url: 'https://other.example/end' } } })
    expect(message.params).not.toHaveProperty('response.requestHeaders')
    expect(message.params).not.toHaveProperty('response.requestHeadersText')
  })

  it('does not manufacture actual headers when unavailable or replace a failed request with a response', () => {
    const synth = new RequestTraceSynthesizer({ epoch: 'test' })
    synth.synthesize('owner', sent)
    const message = synth.synthesize('owner', response)!
    expect(message.params).not.toHaveProperty('response.requestHeaders')
    expect(message.params).not.toHaveProperty('response.requestHeadersText')
    expect(synth.synthesize('owner', { type: 'failed', requestId: 'r', errorText: 'request:fail abort', time: 2 }))
      .toMatchObject({ method: 'Network.loadingFailed', params: { errorText: 'request:fail abort' } })
  })
})
