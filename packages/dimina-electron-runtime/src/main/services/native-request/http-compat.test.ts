import http from 'node:http'
import { brotliCompressSync, deflateRawSync, deflateSync, gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { createNativeRequestService } from './index.js'
import type { NativeRequestTrace } from './trace.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  }))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

function tracedService() {
  const service = createNativeRequestService()
  cleanup.push(() => service.dispose())
  const events: NativeRequestTrace[] = []
  service.setTracer((_owner, event) => events.push(event))
  return { service, events }
}

describe('native HTTP migration compatibility', () => {
  it.each(['./echo', '/echo'])('resolves %s using the explicit caller document base', async (relativeUrl) => {
    const url = await serve((req, res) => res.end(JSON.stringify({ path: req.url })))
    const { service } = tracedService()
    expect(await service.request('owner', 'r', { url: relativeUrl, baseUrl: `${url}/page/index.html`, data: { x: 1 } })).toMatchObject({
      statusCode: 200, data: { path: relativeUrl.startsWith('./') ? '/page/echo?x=1' : '/echo?x=1' },
    })
  })

  it('fails a relative URL when no document base is available', async () => {
    const { service } = tracedService()
    expect(await service.request('owner', 'r', { url: '/echo' })).toMatchObject({ errMsg: expect.stringContaining('request:fail') })
  })

  it.each(['json', 'text', 'arraybuffer'])('decodes a UTF-8 BOM response as %s without changing captured bytes', async (responseKind) => {
    const wireBody = Buffer.from('\uFEFF{"ok":true}')
    const url = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(wireBody)
    })
    const { service, events } = tracedService()
    const result = await service.request('owner', 'r', {
      url,
      ...(responseKind === 'arraybuffer' ? { responseType: 'arraybuffer' } : { dataType: responseKind }),
    })
    expect(result).toMatchObject({ statusCode: 200, errMsg: 'request:ok' })
    if (!('data' in result)) throw new Error('missing response')
    if (responseKind === 'arraybuffer') {
      expect(result.data).toBeInstanceOf(ArrayBuffer)
      expect(Buffer.from(result.data as ArrayBuffer)).toEqual(wireBody)
    } else {
      expect(result.data).toEqual(responseKind === 'json' ? { ok: true } : '{"ok":true}')
    }
    const terminal = events.at(-1)
    expect(terminal).toMatchObject({ type: 'finished', encodedDataLength: wireBody.length })
    if (terminal?.type !== 'finished') throw new Error('missing completion')
    expect(Buffer.from(terminal.body!, 'base64')).toEqual(wireBody)
  })

  it.each([['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync]] as const)(
    'decodes %s before JSON parsing and Network body capture', async (encoding, compress) => {
      const encoded = compress('{"ok":true}')
      const url = await serve((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': encoding })
        res.end(encoded)
      })
      const { service, events } = tracedService()
      expect(await service.request('owner', 'r', { url })).toMatchObject({ data: { ok: true }, statusCode: 200 })
      const terminal = events.at(-1)
      expect(terminal).toMatchObject({ type: 'finished', encodedDataLength: encoded.length })
      if (terminal?.type !== 'finished') throw new Error('missing completion')
      expect(Buffer.from(terminal.body!, 'base64').toString()).toBe('{"ok":true}')
    },
  )

  it('fails exactly once when a compressed body is corrupt', async () => {
    const url = await serve((_req, res) => { res.writeHead(200, { 'content-encoding': 'gzip' }); res.end('invalid') })
    const { service, events } = tracedService()
    expect(await service.request('owner', 'r', { url })).toMatchObject({ errMsg: expect.stringContaining('request:fail') })
    expect(events.map((event) => event.type)).toEqual(['sent', 'response', 'failed'])
  })

  it('accepts a raw DEFLATE response while preserving its wire size in Network', async () => {
    const encoded = deflateRawSync('{"ok":true}')
    const url = await serve((_req, res) => {
      res.writeHead(200, { 'content-encoding': 'deflate' })
      res.end(encoded)
    })
    const { service, events } = tracedService()
    expect(await service.request('owner', 'r', { url })).toMatchObject({ statusCode: 200, data: { ok: true } })
    const terminal = events.at(-1)
    expect(terminal).toMatchObject({ type: 'finished', encodedDataLength: encoded.length })
    if (terminal?.type !== 'finished') throw new Error('missing completion')
    expect(Buffer.from(terminal.body!, 'base64').toString()).toBe('{"ok":true}')
  })

  it.each(['checksum', 'truncated'])('rejects a standard DEFLATE response with a %s error', async (corruption) => {
    let encoded = deflateSync('{"ok":true}')
    if (corruption === 'checksum') encoded[encoded.length - 1]! ^= 1
    else encoded = encoded.subarray(0, encoded.length - 1)
    const url = await serve((_req, res) => {
      res.writeHead(200, { 'content-encoding': 'deflate' })
      res.end(encoded)
    })
    const { service, events } = tracedService()
    expect(await service.request('owner', 'r', { url })).toMatchObject({ errMsg: expect.stringContaining('request:fail') })
    expect(events.map(event => event.type)).toEqual(['sent', 'response', 'failed'])
  })

  it.each([301, 302, 303, 307, 308])('follows HTTP %s with the appropriate method and body', async (status) => {
    const url = await serve((req, res) => {
      if (req.url === '/start') { res.writeHead(status, { location: './end' }); res.end(); return }
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => res.end(JSON.stringify({ method: req.method, body: Buffer.concat(chunks).toString(), contentType: req.headers['content-type'] ?? null })))
    })
    const { service, events } = tracedService()
    const preserve = status === 307 || status === 308
    expect(await service.request('owner', 'r', { url: `${url}/start`, method: 'POST', data: { ok: true } })).toMatchObject({
      statusCode: 200, data: { method: preserve ? 'POST' : 'GET', body: preserve ? '{"ok":true}' : '', contentType: preserve ? 'application/json' : null },
    })
    expect(events.map((event) => event.type)).toEqual(['sent', 'redirect', 'response', 'finished'])
  })

  it('drops credentials and a caller Host header when a redirect changes origin', async () => {
    const destination = await serve((req, res) => res.end(JSON.stringify({ auth: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null, host: req.headers.host })))
    const url = await serve((_req, res) => { res.writeHead(302, { location: destination }); res.end() })
    const { service } = tracedService()
    expect(await service.request('owner', 'r', { url, header: { authorization: 'secret', cookie: 'session=secret', host: 'original.invalid' } })).toMatchObject({
      statusCode: 200, data: { auth: null, cookie: null, host: new URL(destination).host },
    })
  })

  it('bounds redirect loops and emits one failure', async () => {
    let calls = 0
    const url = await serve((_req, res) => { calls++; res.writeHead(302, { location: '/loop' }); res.end() })
    const { service, events } = tracedService()
    expect(await service.request('owner', 'r', { url })).toMatchObject({ errMsg: expect.stringContaining('redirect') })
    expect(calls).toBe(21)
    expect(events.filter((event) => event.type === 'failed')).toHaveLength(1)
  })

  it('keeps abort ownership after following a redirect', async () => {
    let secondHop!: () => void
    const reached = new Promise<void>((resolve) => { secondHop = resolve })
    const url = await serve((req, res) => {
      if (req.url === '/start') { res.writeHead(302, { location: '/wait' }); res.end() }
      else secondHop()
    })
    const { service, events } = tracedService()
    const pending = service.request('owner', 'r', { url: `${url}/start`, timeout: 1000 })
    await reached
    service.abort('owner', 'r')
    expect(await pending).toEqual({ errMsg: 'request:fail abort' })
    expect(events.filter((event) => event.type === 'failed')).toHaveLength(1)
  })
})
