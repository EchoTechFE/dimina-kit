import { afterEach, describe, expect, it, vi } from 'vitest'
import { RequestTraceSynthesizer } from './http.js'
import { createNetworkForwarder } from './index.js'

afterEach(() => vi.useRealTimers())

const sent = { type: 'sent' as const, requestId: 'r', url: 'https://example.com/start', method: 'POST', headers: {}, postData: 'payload', time: 0 }
const redirected = { type: 'redirect' as const, requestId: 'r', url: 'https://example.com/end', method: 'GET', headers: {},
  redirectResponse: { url: sent.url, status: 302, statusText: 'Found', headers: { location: '/end' } }, time: 1 }

describe('native HTTP redirect observation', () => {
  it('reports an omitted POST body without embedding an oversized payload', () => {
    const synth = new RequestTraceSynthesizer({ epoch: 'test' })
    const message = synth.synthesize('owner', { ...sent, postData: undefined, hasPostData: true })!
    expect(message).toMatchObject({ params: { request: { hasPostData: true } } })
    expect((message.params as { request: { postData?: string } }).request.postData).toBeUndefined()
    expect(message.postData).toBeUndefined()
  })

  it('links redirect hops with one CDP id and updates the final response URL', () => {
    const synth = new RequestTraceSynthesizer({ epoch: 'test' })
    const first = synth.synthesize('owner', sent)!
    const next = synth.synthesize('owner', redirected)
    expect(next).toMatchObject({ method: 'Network.requestWillBeSent', params: {
      requestId: (first.params as { requestId: string }).requestId,
      request: { url: redirected.url, method: 'GET', hasPostData: false },
      redirectResponse: { url: sent.url, status: 302 },
    } })
    expect(synth.synthesize('owner', { type: 'response', requestId: 'r', status: 200, statusText: 'OK', headers: {}, time: 2 })).toMatchObject({
      params: { response: { url: redirected.url } },
    })
  })

  it('does not serve the previous POST payload after a redirect changes the request to GET', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0)
    const forwarder = createNetworkForwarder({ getServiceWc: () => null })
    try {
      forwarder.reportNativeRequestTrace('owner', sent)
      expect(await forwarder.bodies.getRequestPostData('dimina:http:0:0')).toEqual({ postData: 'payload' })
      forwarder.reportNativeRequestTrace('owner', redirected)
      await expect(forwarder.bodies.getRequestPostData('dimina:http:0:0')).rejects.toThrow()
    } finally { forwarder.dispose() }
  })
})
