import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createNativeRequestService } from './index.js'
import type { NativeRequestTrace } from './trace.js'
import { createRequestTracer } from './trace.js'
import { captureRequestHeaders } from './request-headers.js'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function rawServer(reply: (headers: string) => string) {
  const received: string[] = []
  const sockets = new Set<net.Socket>()
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let data = ''
    let handled = false
    socket.on('data', chunk => {
      if (handled) return
      data += chunk.toString('latin1')
      const end = data.indexOf('\r\n\r\n')
      if (end < 0) return
      handled = true
      const headers = data.slice(0, end + 4)
      received.push(headers)
      socket.end(reply(headers))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  const address = server.address() as net.AddressInfo
  return { url: `http://127.0.0.1:${address.port}`, received }
}

function tracedService() {
  const service = createNativeRequestService()
  cleanups.push(() => service.dispose())
  const events: NativeRequestTrace[] = []
  service.setTracer((_owner, event) => events.push(event))
  return { service, events }
}

const ok = 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'

describe('native request final wire headers', () => {
  it.each(['GET', 'POST'])('captures the exact %s header block received by the server, including Node defaults', async method => {
    const server = await rawServer(() => ok)
    const { service, events } = tracedService()
    const result = await service.request('owner', 'request', {
      url: `${server.url}/path?query=1`, method, header: { 'X-Trace-Test': 'custom' },
      ...(method === 'POST' ? { data: { text: '你好' } } : {}),
    })
    expect(result).toMatchObject({ errMsg: 'request:ok', statusCode: 200, data: 'ok' })
    expect(events.map(event => event.type)).toEqual(['sent', 'response', 'finished'])
    const response = events.find(event => event.type === 'response')!
    expect(response).toMatchObject({
      requestHeadersText: server.received[0],
      requestHeaders: { Host: new URL(server.url).host, Connection: 'keep-alive', 'x-trace-test': 'custom' },
    })
    if (method === 'POST') expect(response).toMatchObject({ requestHeaders: { 'Transfer-Encoding': 'chunked' } })
  })

  it.each([302, 307])('keeps each %s redirect hop headers separate and preserves method/body rules', async status => {
    const server = await rawServer(headers => headers.includes('/start ')
      ? `HTTP/1.1 ${status} Redirect\r\nLocation: /end\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`
      : ok)
    const { service, events } = tracedService()
    expect(await service.request('owner', 'request', { url: `${server.url}/start`, method: 'POST', data: { a: 1 } }))
      .toMatchObject({ errMsg: 'request:ok' })
    expect(events.map(event => event.type)).toEqual(['sent', 'redirect', 'response', 'finished'])
    expect(events.find(event => event.type === 'redirect')).toMatchObject({
      redirectResponse: { requestHeadersText: server.received[0], requestHeaders: { 'Transfer-Encoding': 'chunked' } },
    })
    expect(events.find(event => event.type === 'response')).toMatchObject({ requestHeadersText: server.received[1] })
    expect(server.received[1]).toMatch(status === 302 ? /^GET \/end / : /^POST \/end /)
    expect(server.received[1]!.includes('Transfer-Encoding: chunked')).toBe(status === 307)
  })

  it('captures the destination Host and excludes credentials stripped on a cross-origin redirect', async () => {
    const target = await rawServer(() => ok)
    const source = await rawServer(() => `HTTP/1.1 302 Found\r\nLocation: ${target.url}/end\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`)
    const { service, events } = tracedService()
    await service.request('owner', 'request', {
      url: source.url, header: { Authorization: 'test-only', Cookie: 'test=value', Host: 'custom.example' },
    })
    expect(events.find(event => event.type === 'redirect')).toMatchObject({ redirectResponse: { requestHeadersText: source.received[0] } })
    const response = events.find(event => event.type === 'response')!
    expect(response).toMatchObject({ requestHeadersText: target.received[0], requestHeaders: { Host: new URL(target.url).host } })
    expect(target.received[0]).not.toMatch(/authorization:|cookie:|custom\.example/i)
  })

  it('leaves failures without a response provisional and emits only one terminal', async () => {
    const { service, events } = tracedService()
    const result = await service.request('owner', 'request', { url: 'http://127.0.0.1:1' })
    expect(result.errMsg).toContain('request:fail')
    expect(events.map(event => event.type)).toEqual(['sent', 'failed'])
    for (const event of events) {
      expect(event).not.toHaveProperty('requestHeaders')
      expect(event).not.toHaveProperty('requestHeadersText')
    }
  })

  it('preserves casing, whitespace and duplicate header lines in source while exposing every field to CDP', () => {
    const text = 'POST /path?q=1 HTTP/1.1\r\nX-Repeated: one\r\nx-repeated:\ttwo \r\nEmpty: \r\n__proto__: literal\r\nContent-Length: 0\r\n\r\n'
    const captured = captureRequestHeaders({ _header: text })!
    expect(captured.requestHeadersText).toBe(text)
    expect(captured.requestHeaders).toEqual({ 'X-Repeated': 'one\ntwo', Empty: '', ['__proto__']: 'literal', 'Content-Length': '0' })
  })

  it.each([undefined, {}, { _header: null }, { _header: 42 }, { _header: 'GET / HTTP/1.1\r\nHost: partial' },
    { _header: 'invalid\r\n\r\n' }, { _header: 'GET / HTTP/1.1\r\ninvalid\r\n\r\n' },
    { get _header() { throw new Error('unavailable') } },
  ])('ignores unavailable or invalid snapshots without throwing (%#)', request => {
    expect(captureRequestHeaders(request)).toBeUndefined()
  })

  it('isolates observer mutation of request headers for both responses and redirects', () => {
    const actual = { requestHeaders: { Host: 'original.example' }, requestHeadersText: 'GET / HTTP/1.1\r\nHost: original.example\r\n\r\n' }
    const tracer = createRequestTracer(() => (_owner, event) => {
      if (event.type === 'response') event.requestHeaders!.Host = 'changed'
      if (event.type === 'redirect') event.redirectResponse.requestHeaders!.Host = 'changed'
    }, 'owner', 'request')
    tracer.response(200, 'OK', {}, actual)
    expect(actual.requestHeaders.Host).toBe('original.example')
    tracer.redirect('http://next.example', 'GET', {}, undefined, { url: 'http://original.example', status: 302, statusText: 'Found', headers: {}, ...actual })
    expect(actual.requestHeaders.Host).toBe('original.example')
  })
})
