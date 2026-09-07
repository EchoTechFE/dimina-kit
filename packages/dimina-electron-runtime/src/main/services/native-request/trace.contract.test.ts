import { afterAll, afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import { createNativeRequestService } from './index.js'
import type { NativeRequestTrace } from './trace.js'

/**
 * Contract for the NativeRequestTrace observation stream (trace.ts): one
 * ordered fact per lifecycle moment — `sent` strictly first, and exactly one
 * terminal event (`finished` XOR `failed`) per request no matter which path
 * settles it (response received, network error, timeout, caller abort).
 * Pure observation: registering a tracer never changes the result the
 * business caller (`service.request`) sees.
 */
describe('Native HTTP request trace stream contract', () => {
  let server: http.Server
  let serverUrl: string

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
  })

  const started = new Promise<void>((resolve) => {
    server = http.createServer((req, res) => {
      if (req.url === '/ok') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"a":1}')
        return
      }
      if (req.url === '/slow') {
        setTimeout(() => res.end('late'), 200)
        return
      }
      res.writeHead(404)
      res.end('not found')
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') serverUrl = `http://127.0.0.1:${addr.port}`
      resolve()
    })
  })

  function newTracedService(): {
    service: ReturnType<typeof createNativeRequestService>
    traces: Array<{ ownerId: string; event: NativeRequestTrace }>
  } {
    const service = createNativeRequestService()
    const traces: Array<{ ownerId: string; event: NativeRequestTrace }> = []
    service.setTracer((ownerId, event) => {
      traces.push({ ownerId, event })
    })
    return { service, traces }
  }

  const disposables: ReturnType<typeof createNativeRequestService>[] = []
  afterEach(() => {
    for (const service of disposables.splice(0)) service.dispose()
  })

  it('emits sent → response → finished for a completed 200 request, with the body/headers the caller saw', async () => {
    await started
    const { service, traces } = newTracedService()
    disposables.push(service)

    const result = await service.request('owner-1', 'r1', { url: `${serverUrl}/ok` })
    expect('statusCode' in result).toBe(true)

    const types = traces.map((t) => t.event.type)
    expect(types).toEqual(['sent', 'response', 'finished'])
    expect(traces.every((t) => t.ownerId === 'owner-1')).toBe(true)

    const sent = traces[0]!.event as NativeRequestTrace & { type: 'sent' }
    expect(sent.url).toContain('/ok')
    expect(sent.method).toBe('GET')

    const response = traces[1]!.event as NativeRequestTrace & { type: 'response' }
    expect(response.status).toBe(200)

    const finished = traces[2]!.event as NativeRequestTrace & { type: 'finished' }
    expect(finished.bodyBase64Encoded).toBe(true)
    expect(Buffer.from(finished.body!, 'base64').toString('utf-8')).toBe('{"a":1}')
    expect(finished.encodedDataLength).toBe(Buffer.byteLength('{"a":1}'))
  })

  it('emits sent → failed (no response) for a network error, without a finished event', async () => {
    const { service, traces } = newTracedService()
    disposables.push(service)

    const result = await service.request('owner-2', 'r2', { url: 'http://127.0.0.1:1/' })
    expect('statusCode' in result).toBe(false)

    const types = traces.map((t) => t.event.type)
    expect(types).toEqual(['sent', 'failed'])
    const failed = traces[1]!.event as NativeRequestTrace & { type: 'failed' }
    expect(failed.errorText).toContain('request:fail')
  })

  it('emits sent → failed(abort) for a caller-cancelled request, still exactly one terminal event', async () => {
    await started
    const { service, traces } = newTracedService()
    disposables.push(service)

    const promise = service.request('owner-3', 'r3', { url: `${serverUrl}/slow`, timeout: 5_000 })
    await new Promise((resolve) => setTimeout(resolve, 10))
    service.abort('owner-3', 'r3')
    const result = await promise

    expect('statusCode' in result).toBe(false)
    const types = traces.map((t) => t.event.type)
    expect(types).toEqual(['sent', 'failed'])
    const failed = traces[1]!.event as NativeRequestTrace & { type: 'failed' }
    expect(failed.errorText).toBe('request:fail abort')
  })

  it('carries postData on sent for a request with a JSON body', async () => {
    await started
    const { service, traces } = newTracedService()
    disposables.push(service)

    await service.request('owner-4', 'r4', {
      url: `${serverUrl}/ok`,
      method: 'POST',
      data: { a: 1 },
    })

    const sent = traces[0]!.event as NativeRequestTrace & { type: 'sent' }
    expect(sent.method).toBe('POST')
    expect(sent.postData).toBe('{"a":1}')
  })

  it('never emits a trace event when no tracer is registered', async () => {
    await started
    const service = createNativeRequestService()
    disposables.push(service)
    // No setTracer call — the transport must run exactly as before.
    const result = await service.request('owner-5', 'r5', { url: `${serverUrl}/ok` })
    expect('statusCode' in result).toBe(true)
  })
})
