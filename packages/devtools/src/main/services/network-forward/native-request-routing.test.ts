// @vitest-environment node
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { buildElementsHookScript, routeOutboundCommand } from '../elements-forward/index.js'
import { buildNetworkOnlyHookScript } from './global-body-gate.js'

describe('native request body command routing', () => {
  it.each(['Network.getResponseBody', 'Network.getRequestPostData'])('routes %s for native HTTP without intercepting backend-owned requests', (method) => {
    expect(routeOutboundCommand(method, { requestId: 'dimina:http:epoch:0' })).toBe('network')
    expect(routeOutboundCommand(method, { requestId: 'dimina:sim:epoch:0:raw' })).toBe('network')
    expect(routeOutboundCommand(method, { requestId: 'raw' })).toBe('service')
    expect(routeOutboundCommand(method, { requestId: 'dimina:ws:epoch:0' })).toBe('service')
  })

  it.each([
    ['embedded', buildElementsHookScript, '__diminaElementsOutbound'],
    ['global', buildNetworkOnlyHookScript, '__diminaGlobalNetworkOutbound'],
  ] as const)('%s frontend intercepts native HTTP body commands for the cache', async (_name, script, queueKey) => {
    const forwarded: string[] = []
    const realm = {
      InspectorFrontendHost: { sendMessageToBackend: (message: string) => forwarded.push(message) },
    }
    expect(runInNewContext(script(), realm)).toBe('installed')
    const { RequestTraceSynthesizer } = await import('./http.js')
    const synth = new RequestTraceSynthesizer({ epoch: 'test' })
    const msg = synth.synthesize('owner', {
      type: 'sent', requestId: 'r', url: 'https://example.com/api', method: 'POST', headers: {}, time: 0,
    })!
    const requestId = (msg.params as { requestId: string }).requestId
    for (const [id, method] of [[1, 'Network.getResponseBody'], [2, 'Network.getRequestPostData']] as const) {
      realm.InspectorFrontendHost.sendMessageToBackend(JSON.stringify({ id, method, params: { requestId } }))
    }
    const queue = (realm as unknown as Record<string, Array<{ id: number; method: string; params: { requestId: string } }>>)[queueKey]
    expect(queue).toMatchObject([
      { id: 1, method: 'Network.getResponseBody', params: { requestId } },
      { id: 2, method: 'Network.getRequestPostData', params: { requestId } },
    ])
    expect(forwarded).toEqual([])
    const raw = JSON.stringify({ id: 3, method: 'Network.getResponseBody', params: { requestId: 'chromium-id' } })
    realm.InspectorFrontendHost.sendMessageToBackend(raw)
    expect(forwarded).toEqual([raw])
  })
})
