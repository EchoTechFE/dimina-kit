import { afterEach, describe, expect, it } from 'vitest'
import { once } from 'node:events'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  connectAndWait,
  EventProbe,
  headerValue,
  startBlackholeServer,
  startEchoPeer,
  waitUntil,
} from './contract-harness.js'
import {
  createNativeWebSocketService,
  type NativeWebSocketService,
  type NativeWebSocketServiceOptions,
  type NativeWebSocketTrace,
} from './index.js'

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Contract for the NativeWebSocketTrace observation stream (trace.ts): one
 * ordered fact per lifecycle moment, `created` strictly first, exactly one
 * terminal `closed` per created socket no matter which teardown path runs
 * (normal close / connect timeout / client-mechanism background interrupt /
 * rejected handshake). Pure observation: registering a tracer never changes
 * the API behaviour the business channel sees.
 *
 * The services here come straight from the real factory (not the harness
 * wrapper) so the `setTracer` surface stays statically typed; the harness
 * still owns the echo/blackhole peers and their cleanup.
 */
describe('Native WebSocket trace stream contract', () => {
  const tracedServices: NativeWebSocketService[] = []
  const httpServers: HttpServer[] = []

  function newTracedService(options?: NativeWebSocketServiceOptions): {
    service: NativeWebSocketService
    traces: Array<{ ownerId: string, event: NativeWebSocketTrace }>
  } {
    const service = createNativeWebSocketService(options)
    tracedServices.push(service)
    const traces: Array<{ ownerId: string, event: NativeWebSocketTrace }> = []
    service.setTracer((ownerId, event) => {
      traces.push({ ownerId, event })
    })
    return { service, traces }
  }

  function tracesOf(
    traces: Array<{ ownerId: string, event: NativeWebSocketTrace }>,
    socketId: string,
  ): NativeWebSocketTrace[] {
    return traces.filter(trace => trace.event.socketId === socketId).map(trace => trace.event)
  }

  function traceTypesOf(
    traces: Array<{ ownerId: string, event: NativeWebSocketTrace }>,
    socketId: string,
  ): Array<NativeWebSocketTrace['type']> {
    return tracesOf(traces, socketId).map(event => event.type)
  }

  afterEach(() => {
    for (const service of tracedServices.splice(0)) service.dispose()
    for (const server of httpServers.splice(0)) {
      server.closeAllConnections()
      server.close()
    }
  })

  it('emits created → handshake-request → handshake-response(101) → frame-sent → frame-received → closed for a full echo lifecycle', async () => {
    const peer = await startEchoPeer()
    const { service, traces } = newTracedService()
    const probe = new EventProbe()
    service.listen('owner-trace', probe.listener)
    await connectAndWait(service, 'owner-trace', probe, {
      socketId: 'traced',
      url: peer.url,
    })

    const echoed = probe.waitFor(
      event => event.socketId === 'traced' && event.event === 'message' && event.data === 'trace-echo',
    )
    expect((await service.send('owner-trace', {
      socketId: 'traced',
      data: 'trace-echo',
    })).errMsg).toBe('sendSocketMessage:ok')
    await echoed

    const closed = probe.waitFor(
      event => event.socketId === 'traced' && event.event === 'close',
    )
    expect((await service.close('owner-trace', {
      socketId: 'traced',
      code: 4001,
      reason: 'trace-done',
    })).errMsg).toBe('closeSocket:ok')
    await closed

    // The business close event is emitted after the trace stream's terminal
    // `closed`, so the full stream is already complete at this point.
    expect(traceTypesOf(traces, 'traced')).toEqual([
      'created',
      'handshake-request',
      'handshake-response',
      'frame-sent',
      'frame-received',
      'closed',
    ])
    expect(traces.every(trace => trace.ownerId === 'owner-trace')).toBe(true)

    const [created, handshakeRequest, handshakeResponse, frameSent, frameReceived] = tracesOf(traces, 'traced')
    expect(created).toMatchObject({ type: 'created', socketId: 'traced', url: peer.url })
    expect(created?.time).toBeTypeOf('number')

    expect(handshakeRequest?.type).toBe('handshake-request')
    if (handshakeRequest?.type !== 'handshake-request') throw new Error('unreachable')
    expect(headerValue(handshakeRequest.headers, 'sec-websocket-key')).toBeTruthy()
    expect(headerValue(handshakeRequest.headers, 'sec-websocket-version')).toBe('13')

    expect(handshakeResponse?.type).toBe('handshake-response')
    if (handshakeResponse?.type !== 'handshake-response') throw new Error('unreachable')
    expect(handshakeResponse.status).toBe(101)
    expect(handshakeResponse.statusText).toBe('Switching Protocols')

    if (frameSent?.type !== 'frame-sent') throw new Error('frame-sent missing from the trace stream')
    expect(frameSent.opcode).toBe(1)
    expect(frameSent.payloadData).toBe('trace-echo')
    expect(frameSent.base64Encoded).toBeUndefined()
    if (frameReceived?.type !== 'frame-received') throw new Error('frame-received missing from the trace stream')
    expect(frameReceived.opcode).toBe(1)
    expect(frameReceived.payloadData).toBe('trace-echo')
    expect(frameReceived.base64Encoded).toBeUndefined()
    probe.dispose()
  })

  it('encodes binary frames base64 in both directions so the payload survives as data', async () => {
    const peer = await startEchoPeer()
    const { service, traces } = newTracedService()
    const probe = new EventProbe()
    service.listen('owner-binary', probe.listener)
    await connectAndWait(service, 'owner-binary', probe, {
      socketId: 'binary',
      url: peer.url,
    })

    const echoed = probe.waitFor(
      event => event.socketId === 'binary' && event.event === 'message' && event.data instanceof ArrayBuffer,
    )
    expect((await service.send('owner-binary', {
      socketId: 'binary',
      data: Uint8Array.from([1, 2, 3, 4]).buffer,
    })).errMsg).toBe('sendSocketMessage:ok')
    await echoed

    const frames = tracesOf(traces, 'binary').filter(
      event => event.type === 'frame-sent' || event.type === 'frame-received',
    )
    expect(frames.map(event => event.type)).toEqual(['frame-sent', 'frame-received'])
    for (const frame of frames) {
      if (frame.type !== 'frame-sent' && frame.type !== 'frame-received') throw new Error('unreachable')
      expect(frame.opcode).toBe(2)
      expect(frame.base64Encoded).toBe(true)
      expect(Array.from(Buffer.from(frame.payloadData, 'base64'))).toEqual([1, 2, 3, 4])
    }
    probe.dispose()
  })

  it('emits exactly one closed for a normal close', async () => {
    const peer = await startEchoPeer()
    const { service, traces } = newTracedService()
    const probe = new EventProbe()
    service.listen('owner-close', probe.listener)
    await connectAndWait(service, 'owner-close', probe, {
      socketId: 'normal-close',
      url: peer.url,
    })

    const closed = probe.waitFor(
      event => event.socketId === 'normal-close' && event.event === 'close',
    )
    expect((await service.close('owner-close', {
      socketId: 'normal-close',
      code: 4000,
      reason: 'bye',
    })).errMsg).toBe('closeSocket:ok')
    await closed

    await waitUntil(
      () => traceTypesOf(traces, 'normal-close').filter(type => type === 'closed').length === 1,
      'normal close did not emit its terminal closed',
    )
    // A second teardown (owner disposal at suite cleanup) must not re-emit:
    // the terminal event is idempotent per created socket.
    service.disposeOwner('owner-close')
    await delay(100)
    expect(traceTypesOf(traces, 'normal-close').filter(type => type === 'closed')).toHaveLength(1)
    probe.dispose()
  })

  it('emits frame-error then exactly one closed when the connect times out against a stalled peer', async () => {
    const blackhole = await startBlackholeServer()
    const { service, traces } = newTracedService()
    const probe = new EventProbe()
    service.listen('owner-timeout', probe.listener)
    const timedOut = probe.waitFor(
      event => event.socketId === 'stalled' && event.event === 'error',
    )

    expect((await service.connect('owner-timeout', {
      socketId: 'stalled',
      url: blackhole.url,
      timeout: 300,
    })).errMsg).toBe('connectSocket:ok')
    const error = await timedOut
    expect(error.errMsg).toMatch(/timed?\s*out/i)

    await waitUntil(
      () => traceTypesOf(traces, 'stalled').includes('closed'),
      'connect timeout did not terminate the trace stream',
    )
    const types = traceTypesOf(traces, 'stalled')
    expect(types[0]).toBe('created')
    expect(types.indexOf('frame-error')).toBeGreaterThan(types.indexOf('handshake-request'))
    expect(types.indexOf('closed')).toBe(types.length - 1)
    const frameError = tracesOf(traces, 'stalled').find(event => event.type === 'frame-error')
    if (frameError?.type !== 'frame-error') throw new Error('frame-error missing from the trace stream')
    expect(frameError.errorMessage).toMatch(/timed?\s*out/i)
    await delay(100)
    expect(traceTypesOf(traces, 'stalled').filter(type => type === 'closed')).toHaveLength(1)
    probe.dispose()
  })

  it('emits exactly one closed and no frame-error when the background grace interrupts an open connection', async () => {
    const peer = await startEchoPeer()
    const { service, traces } = newTracedService({ backgroundGraceMs: 50 })
    const probe = new EventProbe()
    service.listen('owner-background', probe.listener)
    await connectAndWait(service, 'owner-background', probe, {
      socketId: 'backgrounded',
      url: peer.url,
    })

    service.setBackgrounded(true)
    await waitUntil(
      () => probe.events.some(event => event.socketId === 'backgrounded' && event.event === 'close'),
      'backgrounded connection was not closed after the grace period',
    )
    await waitUntil(
      () => traceTypesOf(traces, 'backgrounded').includes('closed'),
      'background teardown did not terminate the trace stream',
    )
    await delay(100)
    // A client-mechanism teardown of an OPEN socket reports onClose only —
    // the trace mirrors that: no frame-error, a single terminal closed.
    expect(traceTypesOf(traces, 'backgrounded').filter(type => type === 'frame-error')).toHaveLength(0)
    expect(traceTypesOf(traces, 'backgrounded').filter(type => type === 'closed')).toHaveLength(1)
    probe.dispose()
  })

  it('emits handshake-response(401) → frame-error → closed against a rejecting server while the business channel still sees the default abort', async () => {
    const server = createServer((request, response) => {
      response.writeHead(401, { 'content-type': 'text/plain' })
      response.end('unauthorized')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    httpServers.push(server)
    const { port } = server.address() as AddressInfo

    const { service, traces } = newTracedService()
    const probe = new EventProbe()
    service.listen('owner-rejected', probe.listener)
    const failed = probe.waitFor(
      event => event.socketId === 'rejected' && event.event === 'error',
    )

    expect((await service.connect('owner-rejected', {
      socketId: 'rejected',
      url: `ws://127.0.0.1:${port}/upgrade`,
    })).errMsg).toBe('connectSocket:ok')
    const error = await failed
    // The rejected upgrade keeps ws's default abort behaviour: the business
    // channel observes exactly one error and never an open/close.
    expect(error.errMsg).toMatch(/^connectSocket:fail /)
    await waitUntil(
      () => traceTypesOf(traces, 'rejected').includes('closed'),
      'rejected handshake did not terminate the trace stream',
    )

    const types = traceTypesOf(traces, 'rejected')
    expect(types).toEqual([
      'created',
      'handshake-request',
      'handshake-response',
      'frame-error',
      'closed',
    ])
    const handshakeResponse = tracesOf(traces, 'rejected').find(event => event.type === 'handshake-response')
    if (handshakeResponse?.type !== 'handshake-response') throw new Error('handshake-response missing from the trace stream')
    expect(handshakeResponse.status).toBe(401)

    await delay(100)
    expect(probe.events.some(event => event.event === 'open')).toBe(false)
    expect(probe.events.some(event => event.event === 'close')).toBe(false)
    expect(traceTypesOf(traces, 'rejected').filter(type => type === 'closed')).toHaveLength(1)
    probe.dispose()
  })

  it('keeps the full API flow intact when no tracer is registered', async () => {
    const peer = await startEchoPeer()
    const service = createNativeWebSocketService()
    tracedServices.push(service)
    const probe = new EventProbe()
    service.listen('owner-untraced', probe.listener)
    await connectAndWait(service, 'owner-untraced', probe, {
      socketId: 'untraced',
      url: peer.url,
    })

    const echoed = probe.waitFor(
      event => event.socketId === 'untraced' && event.event === 'message' && event.data === 'no-tracer',
    )
    expect((await service.send('owner-untraced', {
      socketId: 'untraced',
      data: 'no-tracer',
    })).errMsg).toBe('sendSocketMessage:ok')
    await echoed

    const closed = probe.waitFor(
      event => event.socketId === 'untraced' && event.event === 'close',
    )
    expect((await service.close('owner-untraced', {
      socketId: 'untraced',
      code: 4000,
      reason: 'done',
    })).errMsg).toBe('closeSocket:ok')
    await closed
    probe.dispose()
  })
})
