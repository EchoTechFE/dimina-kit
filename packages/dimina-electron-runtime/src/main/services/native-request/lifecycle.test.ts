import http from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createNativeRequestService, createNativeRequestTransport } from './index.js'
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

function service() {
  const instance = createNativeRequestService()
  cleanup.push(() => instance.dispose())
  const events: NativeRequestTrace[] = []
  instance.setTracer((_owner, event) => events.push(event))
  return { instance, events }
}

describe('native HTTP terminal and ownership boundaries', () => {
  it('does not cancel a new owner generation created by an old abort observer', async () => {
    const url = await serve((_req, res) => res.end('ok'))
    const { instance } = service()
    let replacement: ReturnType<typeof instance.request> | undefined
    instance.setTracer((_owner, event) => {
      if (event.type === 'failed' && event.requestId === 'old') replacement = instance.request('owner', 'new', { url })
    })
    const old = instance.request('owner', 'old', { url })
    instance.disposeOwner('owner')
    expect(await old).toEqual({ errMsg: 'request:fail abort' })
    expect(await replacement).toMatchObject({ errMsg: 'request:ok', data: 'ok' })
  })

  it('fails once when the response closes before its declared length', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Length': '100' })
      res.write('short')
      setImmediate(() => res.destroy())
    })
    const { instance, events } = service()
    const result = await Promise.race([
      instance.request('owner', 'r', { url, timeout: 100 }),
      new Promise((resolve) => { const timer = setTimeout(() => resolve('unsettled'), 300); cleanup.push(() => clearTimeout(timer)) }),
    ])
    expect(result).toMatchObject({ errMsg: expect.stringContaining('request:fail') })
    expect(events.map((e) => e.type)).toEqual(['sent', 'response', 'failed'])
  })

  it('enforces the complete request budget while response chunks keep arriving', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200)
      const interval = setInterval(() => res.write('x'), 5)
      const end = setTimeout(() => res.end('late'), 150)
      res.on('close', () => { clearInterval(interval); clearTimeout(end) })
    })
    const { instance, events } = service()
    expect(await instance.request('owner', 'r', { url, timeout: 35 })).toEqual({ errMsg: 'request:fail timeout' })
    expect(events.filter((e) => e.type === 'failed')).toHaveLength(1)
  })

  it('settles invalid transport options as failures and closes any emitted trace', async () => {
    const { instance, events } = service()
    await expect(instance.request('owner', 'r', { url: 'ftp://example.com' })).resolves.toMatchObject({ errMsg: expect.stringContaining('request:fail') })
    expect(events.filter((e) => e.type === 'sent').length).toBe(events.filter((e) => e.type === 'failed').length)
  })

  it('does not start network I/O for an already aborted signal', async () => {
    let calls = 0
    const url = await serve((_req, res) => { calls++; res.end('ok') })
    const controller = new AbortController()
    controller.abort()
    expect(await createNativeRequestTransport().request('r', { url }, controller.signal)).toEqual({ errMsg: 'request:fail abort' })
    expect(calls).toBe(0)
  })

  it('rejects a duplicate active id without orphaning the original request', async () => {
    const url = await serve(() => {})
    const { instance } = service()
    const first = instance.request('owner', 'same', { url, timeout: 100 })
    const second = instance.request('owner', 'same', { url, timeout: 100 })
    instance.abort('owner', 'same')
    expect(await first).toEqual({ errMsg: 'request:fail abort' })
    expect(await second).toMatchObject({ errMsg: expect.stringContaining('duplicate') })
  })

  it('rejects requests after service disposal without emitting new traffic', async () => {
    const url = await serve((_req, res) => res.end('ok'))
    const { instance, events } = service()
    instance.dispose()
    expect(await instance.request('owner', 'r', { url })).toMatchObject({ errMsg: expect.stringContaining('disposed') })
    expect(events).toEqual([])
  })

  it('keeps trace header edits from changing the request or its business result', async () => {
    const url = await serve((req, res) => { res.setHeader('x-observed', req.headers['x-input'] ?? 'missing'); res.end('ok') })
    const { instance } = service()
    instance.setTracer((_owner, event) => {
      if (event.type === 'sent') event.headers['x-input'] = 'mutated'
      if (event.type === 'response') event.headers['x-observed'] = 'mutated'
    })
    expect(await instance.request('owner', 'r', { url, header: { 'x-input': 'original' } })).toMatchObject({ header: { 'x-observed': 'original' } })
  })

  it('returns a failure for cyclic request data instead of rejecting the invocation', async () => {
    const { instance } = service()
    const data: Record<string, unknown> = {}; data.self = data
    await expect(instance.request('owner', 'r', { url: 'http://127.0.0.1/', method: 'POST', data })).resolves.toMatchObject({ errMsg: expect.stringContaining('request:fail') })
  })
})
