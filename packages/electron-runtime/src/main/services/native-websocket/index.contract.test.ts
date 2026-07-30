import { createServer, type Server as NetServer, type Socket as NetSocket } from 'node:net'
import { Socket } from 'node:net'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WebSocketServer,
  type RawData,
  type WebSocket,
} from 'ws'
import { createNativeWebSocketService } from './index.js'

/**
 * Black-box contract for the developer-tool Native WebSocket service.
 *
 * This suite intentionally knows nothing about the service implementation. It
 * exercises only the per-owner API used by the Main-process bridge and a real
 * loopback WebSocket peer. In particular, poisoning globalThis.WebSocket
 * guards against accidentally moving the old Chromium/renderer transport into
 * Main under a different name.
 */

interface ConnectOptions {
  socketId: string
  url: string
  header?: Record<string, unknown>
  protocols?: string[]
  timeout?: number
  perMessageDeflate?: boolean
  tcpNoDelay?: boolean
  forceCellularNetwork?: boolean
}

interface SendOptions {
  socketId: string
  data: string | ArrayBuffer | ArrayBufferView
}

interface CloseOptions {
  socketId: string
  code?: number
  reason?: string
}

interface SocketProfile {
  connectEnd: number
  connectStart: number
  cost: number
  domainLookUpEnd: number
  domainLookUpStart: number
  fetchStart: number
  handshakeCost: number
  rtt: number
}

interface NativeSocketEvent {
  socketId: string
  event: 'open' | 'message' | 'error' | 'close'
  header?: Record<string, unknown>
  profile?: SocketProfile
  data?: string | ArrayBuffer
  code?: number
  reason?: string
  errMsg?: string
}

interface ApiResult {
  errMsg: string
}

interface NativeWebSocketService {
  listen(ownerId: string, listener: (event: NativeSocketEvent) => void): unknown
  connect(ownerId: string, options: ConnectOptions): ApiResult | Promise<ApiResult>
  send(ownerId: string, options: SendOptions): ApiResult | Promise<ApiResult>
  close(ownerId: string, options: CloseOptions): ApiResult | Promise<ApiResult>
  disposeOwner(ownerId: string): unknown
  dispose(): unknown
}

interface EchoPeer {
  url: string
  requests: Array<{
    headers: Record<string, string | string[] | undefined>
    protocol: string
    extensions: string
  }>
  closeFrames: Array<{ code: number, reason: string }>
  close(): Promise<void>
}

class EventProbe {
  readonly events: NativeSocketEvent[] = []
  private readonly waiters = new Set<{
    predicate: (event: NativeSocketEvent) => boolean
    resolve: (event: NativeSocketEvent) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()

  readonly listener = (event: NativeSocketEvent): void => {
    this.events.push(event)
    for (const waiter of this.waiters) {
      if (!waiter.predicate(event)) continue
      clearTimeout(waiter.timer)
      this.waiters.delete(waiter)
      waiter.resolve(event)
    }
  }

  waitFor(
    predicate: (event: NativeSocketEvent) => boolean,
    timeoutMs = 3_000,
  ): Promise<NativeSocketEvent> {
    const existing = this.events.find(predicate)
    if (existing) return Promise.resolve(existing)

    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter)
          reject(new Error(`Timed out waiting for Native WebSocket event; received ${JSON.stringify(this.events)}`))
        }, timeoutMs),
      }
      this.waiters.add(waiter)
    })
  }

  clear(): void {
    this.events.length = 0
  }

  dispose(): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('Event probe disposed'))
    }
    this.waiters.clear()
  }
}

const services: NativeWebSocketService[] = []
const peers: EchoPeer[] = []
const netServers: Array<{
  server: NetServer
  sockets: Set<NetSocket>
}> = []

function newService(): NativeWebSocketService {
  const service = createNativeWebSocketService() as unknown as NativeWebSocketService
  services.push(service)
  return service
}

function headerValue(
  headers: Record<string, unknown> | undefined,
  name: string,
): unknown {
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())
  return entry?.[1]
}

async function startEchoPeer(options: {
  perMessageDeflate?: boolean
  responseHeaders?: Record<string, string>
} = {}): Promise<EchoPeer> {
  const requests: EchoPeer['requests'] = []
  const closeFrames: EchoPeer['closeFrames'] = []
  const clients = new Set<WebSocket>()
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    perMessageDeflate: options.perMessageDeflate ?? false,
    handleProtocols(protocols) {
      if (protocols.has('chat.v2')) return 'chat.v2'
      return protocols.values().next().value || false
    },
  })

  wss.on('headers', (headers) => {
    for (const [name, value] of Object.entries(options.responseHeaders ?? {})) {
      headers.push(`${name}: ${value}`)
    }
  })
  wss.on('connection', (socket, request) => {
    clients.add(socket)
    requests.push({
      headers: request.headers,
      protocol: socket.protocol,
      extensions: socket.extensions,
    })
    socket.on('message', (data: RawData, isBinary: boolean) => {
      socket.send(data, { binary: isBinary })
    })
    socket.on('close', (code, reason) => {
      clients.delete(socket)
      closeFrames.push({ code, reason: reason.toString('utf8') })
    })
  })

  await once(wss, 'listening')
  const address = wss.address() as AddressInfo
  const peer: EchoPeer = {
    url: `ws://127.0.0.1:${address.port}/native-contract`,
    requests,
    closeFrames,
    async close() {
      for (const client of clients) client.terminate()
      await new Promise<void>((resolve, reject) => {
        wss.close((error) => error ? reject(error) : resolve())
      })
    },
  }
  peers.push(peer)
  return peer
}

async function startBlackholeServer(): Promise<{
  url: string
  acceptedConnection: Promise<void>
  closedConnections: Promise<void>
}> {
  const sockets = new Set<NetSocket>()
  let resolveAccepted!: () => void
  let resolveClosed!: () => void
  const acceptedConnection = new Promise<void>((resolve) => {
    resolveAccepted = resolve
  })
  const closedConnections = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  const server = createServer((socket) => {
    sockets.add(socket)
    resolveAccepted()
    // Enter flowing mode so the fixture observes the client's FIN/RST. We
    // intentionally consume the HTTP upgrade request without responding, so
    // this remains a stalled-handshake peer rather than a WebSocket server.
    socket.resume()
    socket.on('close', () => {
      sockets.delete(socket)
      if (sockets.size === 0) resolveClosed()
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  netServers.push({ server, sockets })
  const address = server.address() as AddressInfo
  return {
    url: `ws://127.0.0.1:${address.port}/never-upgrades`,
    acceptedConnection,
    closedConnections,
  }
}

async function connectAndWait(
  service: NativeWebSocketService,
  ownerId: string,
  probe: EventProbe,
  options: ConnectOptions,
): Promise<NativeSocketEvent> {
  const openEvent = probe.waitFor(
    event => event.socketId === options.socketId && event.event === 'open',
  )
  const result = await service.connect(ownerId, options)
  expect(result.errMsg).toBe('connectSocket:ok')
  return openEvent
}

async function waitUntil(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

afterEach(async () => {
  for (const service of services.splice(0)) {
    await Promise.resolve(service.dispose())
  }
  for (const peer of peers.splice(0)) {
    await peer.close()
  }
  for (const entry of netServers.splice(0)) {
    for (const socket of entry.sockets) socket.destroy()
    await new Promise<void>(resolve => entry.server.close(() => resolve()))
  }
  vi.restoreAllMocks()
})

describe('Native WebSocket transport contract', () => {
  it('creates the connection in Main without consulting globalThis.WebSocket', async () => {
    const peer = await startEchoPeer()
    const service = newService()
    const probe = new EventProbe()
    service.listen('owner-native', probe.listener)

    const original = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket')
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      get() {
        throw new Error('Chromium WebSocket must not be used by the Native service')
      },
    })

    try {
      await connectAndWait(service, 'owner-native', probe, {
        socketId: 'native-only',
        url: peer.url,
      })
      expect(peer.requests).toHaveLength(1)
    }
    finally {
      if (original) Object.defineProperty(globalThis, 'WebSocket', original)
      else Reflect.deleteProperty(globalThis, 'WebSocket')
      probe.dispose()
    }
  })

  it('forwards request headers and protocols and reports complete response headers/profile on open', async () => {
    const peer = await startEchoPeer({
      responseHeaders: {
        'X-Native-Handshake': 'accepted',
        'X-Request-Trace': 'response-trace',
      },
    })
    const service = newService()
    const probe = new EventProbe()
    service.listen('owner-open', probe.listener)

    const open = await connectAndWait(service, 'owner-open', probe, {
      socketId: 'headers',
      url: peer.url,
      header: {
        Authorization: 'Bearer native-secret',
        'X-Request-Trace': 'request-trace',
        Referer: 'https://must-not-be-forwarded.invalid/',
      },
      protocols: ['chat.v1', 'chat.v2'],
    })

    expect(peer.requests).toHaveLength(1)
    expect(peer.requests[0]?.headers.authorization).toBe('Bearer native-secret')
    expect(peer.requests[0]?.headers['x-request-trace']).toBe('request-trace')
    expect(peer.requests[0]?.headers.referer).toBeUndefined()
    expect(peer.requests[0]?.protocol).toBe('chat.v2')

    expect(headerValue(open.header, 'x-native-handshake')).toBe('accepted')
    expect(headerValue(open.header, 'x-request-trace')).toBe('response-trace')
    expect(headerValue(open.header, 'sec-websocket-protocol')).toBe('chat.v2')

    const profile = open.profile
    expect(profile).toBeDefined()
    for (const field of [
      'connectEnd',
      'connectStart',
      'cost',
      'domainLookUpEnd',
      'domainLookUpStart',
      'fetchStart',
      'handshakeCost',
      'rtt',
    ] as const) {
      expect(profile?.[field], field).toBeTypeOf('number')
      expect(Number.isFinite(profile?.[field]), field).toBe(true)
      expect(profile?.[field], field).toBeGreaterThanOrEqual(0)
    }
    expect(profile!.fetchStart).toBeLessThanOrEqual(profile!.domainLookUpStart)
    expect(profile!.domainLookUpStart).toBeLessThanOrEqual(profile!.domainLookUpEnd)
    expect(profile!.domainLookUpEnd).toBeLessThanOrEqual(profile!.connectStart)
    expect(profile!.connectStart).toBeLessThanOrEqual(profile!.connectEnd)
    expect(profile!.cost).toBeGreaterThanOrEqual(profile!.handshakeCost)
    probe.dispose()
  })

  it('round-trips text and exposes binary messages as ArrayBuffer', async () => {
    const peer = await startEchoPeer()
    const service = newService()
    const probe = new EventProbe()
    service.listen('owner-data', probe.listener)
    await connectAndWait(service, 'owner-data', probe, {
      socketId: 'data',
      url: peer.url,
    })

    const textMessage = probe.waitFor(
      event => event.socketId === 'data' && event.event === 'message' && event.data === 'hello-native',
    )
    expect((await service.send('owner-data', {
      socketId: 'data',
      data: 'hello-native',
    })).errMsg).toBe('sendSocketMessage:ok')
    await textMessage

    const payload = Uint8Array.from([0, 1, 2, 127, 128, 255]).buffer
    const binaryMessage = probe.waitFor(
      event => event.socketId === 'data' && event.event === 'message' && event.data instanceof ArrayBuffer,
    )
    expect((await service.send('owner-data', {
      socketId: 'data',
      data: payload,
    })).errMsg).toBe('sendSocketMessage:ok')
    const binary = await binaryMessage
    expect(binary.data).toBeInstanceOf(ArrayBuffer)
    expect(Array.from(new Uint8Array(binary.data as ArrayBuffer))).toEqual([0, 1, 2, 127, 128, 255])
    probe.dispose()
  })

  it('times out a stalled HTTP upgrade and destroys the underlying connection', async () => {
    const blackhole = await startBlackholeServer()
    const service = newService()
    const probe = new EventProbe()
    service.listen('owner-timeout', probe.listener)
    const timedOut = probe.waitFor(
      event => event.socketId === 'timeout' && event.event === 'error',
    )

    expect((await service.connect('owner-timeout', {
      socketId: 'timeout',
      url: blackhole.url,
      timeout: 500,
    })).errMsg).toBe('connectSocket:ok')

    await expect(Promise.race([
      blackhole.acceptedConnection,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Blackhole server did not accept the connection')), 1_000)),
    ])).resolves.toBeUndefined()
    const error = await timedOut
    expect(error.errMsg).toMatch(/^connectSocket:fail .*tim(?:e|ed)[ -]?out/i)
    await expect(Promise.race([
      blackhole.closedConnections,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Native socket was not destroyed')), 1_000)),
    ])).resolves.toBeUndefined()
    probe.dispose()
  })

  it('accepts a 123-byte UTF-8 close reason and returns the peer close code/reason', async () => {
    const peer = await startEchoPeer()
    const service = newService()
    const probe = new EventProbe()
    service.listen('owner-close', probe.listener)
    await connectAndWait(service, 'owner-close', probe, {
      socketId: 'close-valid',
      url: peer.url,
    })
    const reason = '界'.repeat(41)
    expect(new TextEncoder().encode(reason)).toHaveLength(123)
    const closed = probe.waitFor(
      event => event.socketId === 'close-valid' && event.event === 'close',
    )

    expect((await service.close('owner-close', {
      socketId: 'close-valid',
      code: 4001,
      reason,
    })).errMsg).toBe('closeSocket:ok')
    const closeEvent = await closed
    expect(closeEvent).toMatchObject({ code: 4001, reason })
    await waitUntil(
      () => peer.closeFrames.some(frame => frame.code === 4001 && frame.reason === reason),
      'peer did not receive the requested close code/reason',
    )
    expect(peer.closeFrames).toContainEqual({ code: 4001, reason })
    probe.dispose()
  })

  it('rejects a 124-byte UTF-8 close reason without closing the live socket', async () => {
    const peer = await startEchoPeer()
    const service = newService()
    const probe = new EventProbe()
    service.listen('owner-close-limit', probe.listener)
    await connectAndWait(service, 'owner-close-limit', probe, {
      socketId: 'close-invalid',
      url: peer.url,
    })
    const reason = `${'界'.repeat(41)}a`
    expect(new TextEncoder().encode(reason)).toHaveLength(124)

    const invalid = await service.close('owner-close-limit', {
      socketId: 'close-invalid',
      code: 4001,
      reason,
    })
    expect(invalid.errMsg).toMatch(/^closeSocket:fail .*123.*UTF-?8/i)
    expect(probe.events.some(event => event.socketId === 'close-invalid' && event.event === 'close')).toBe(false)

    const echoed = probe.waitFor(
      event => event.socketId === 'close-invalid' && event.event === 'message' && event.data === 'still-open',
    )
    expect((await service.send('owner-close-limit', {
      socketId: 'close-invalid',
      data: 'still-open',
    })).errMsg).toBe('sendSocketMessage:ok')
    await echoed
    probe.dispose()
  })
})

describe('Native WebSocket lifecycle and ownership', () => {
  it('rejects unsupported URLs and reports connection errors using the connectSocket error namespace', async () => {
    const service = newService()
    const probe = new EventProbe()
    service.listen('owner-errors', probe.listener)

    const invalid = await service.connect('owner-errors', {
      socketId: 'invalid-url',
      url: 'https://example.invalid/not-websocket',
    })
    expect(invalid.errMsg).toMatch(/^connectSocket:fail /)

    const temporary = createServer()
    temporary.listen(0, '127.0.0.1')
    await once(temporary, 'listening')
    const port = (temporary.address() as AddressInfo).port
    await new Promise<void>(resolve => temporary.close(() => resolve()))

    const refused = probe.waitFor(
      event => event.socketId === 'refused' && event.event === 'error',
    )
    expect((await service.connect('owner-errors', {
      socketId: 'refused',
      url: `ws://127.0.0.1:${port}/refused`,
      timeout: 500,
    })).errMsg).toBe('connectSocket:ok')
    expect((await refused).errMsg).toMatch(/^connectSocket:fail /)
    probe.dispose()
  })

  it('limits each owner to five live connections without imposing a global five-socket cap', async () => {
    const peer = await startEchoPeer()
    const service = newService()
    const ownerA = new EventProbe()
    const ownerB = new EventProbe()
    service.listen('owner-a', ownerA.listener)
    service.listen('owner-b', ownerB.listener)

    for (let index = 0; index < 5; index += 1) {
      await connectAndWait(service, 'owner-a', ownerA, {
        socketId: `a-${index}`,
        url: peer.url,
      })
    }
    const sixth = await service.connect('owner-a', {
      socketId: 'a-5',
      url: peer.url,
    })
    expect(sixth.errMsg).toMatch(/^connectSocket:fail .*5/)

    await connectAndWait(service, 'owner-b', ownerB, {
      socketId: 'b-0',
      url: peer.url,
    })
    expect(peer.requests).toHaveLength(6)
    ownerA.dispose()
    ownerB.dispose()
  })

  it('disposeOwner closes only that owner and dispose is idempotent', async () => {
    const peer = await startEchoPeer()
    const service = newService()
    const ownerA = new EventProbe()
    const ownerB = new EventProbe()
    service.listen('owner-a', ownerA.listener)
    service.listen('owner-b', ownerB.listener)
    await connectAndWait(service, 'owner-a', ownerA, {
      socketId: 'a',
      url: peer.url,
    })
    await connectAndWait(service, 'owner-b', ownerB, {
      socketId: 'b',
      url: peer.url,
    })

    await Promise.resolve(service.disposeOwner('owner-a'))
    await waitUntil(
      () => peer.closeFrames.length === 1,
      'disposeOwner did not close its native network connection',
    )

    const ownerBEcho = ownerB.waitFor(
      event => event.socketId === 'b' && event.event === 'message' && event.data === 'owner-b-alive',
    )
    expect((await service.send('owner-b', {
      socketId: 'b',
      data: 'owner-b-alive',
    })).errMsg).toBe('sendSocketMessage:ok')
    await ownerBEcho

    await Promise.resolve(service.dispose())
    await Promise.resolve(service.dispose())
    await waitUntil(
      () => peer.closeFrames.length === 2,
      'dispose did not close the remaining native network connection',
    )
    ownerA.dispose()
    ownerB.dispose()
  })
})

describe('Native WebSocket advanced connect options', () => {
  it('uses perMessageDeflate to control extension negotiation', async () => {
    const peer = await startEchoPeer({ perMessageDeflate: true })
    const service = newService()
    const probe = new EventProbe()
    service.listen('owner-deflate', probe.listener)

    await connectAndWait(service, 'owner-deflate', probe, {
      socketId: 'deflate-off',
      url: peer.url,
      perMessageDeflate: false,
    })
    expect(peer.requests[0]?.headers['sec-websocket-extensions']).toBeUndefined()
    expect(peer.requests[0]?.extensions).toBe('')

    await connectAndWait(service, 'owner-deflate', probe, {
      socketId: 'deflate-on',
      url: peer.url,
      perMessageDeflate: true,
    })
    expect(peer.requests[1]?.headers['sec-websocket-extensions']).toContain('permessage-deflate')
    expect(peer.requests[1]?.extensions).toContain('permessage-deflate')
    probe.dispose()
  })

  it('applies tcpNoDelay to the native Node socket', async () => {
    const peer = await startEchoPeer()
    const setNoDelay = vi.spyOn(Socket.prototype, 'setNoDelay')
    const service = newService()
    const probe = new EventProbe()
    service.listen('owner-nodelay', probe.listener)

    await connectAndWait(service, 'owner-nodelay', probe, {
      socketId: 'nodelay-false',
      url: peer.url,
      tcpNoDelay: false,
    })
    expect(setNoDelay).toHaveBeenCalledWith(false)

    setNoDelay.mockClear()
    await connectAndWait(service, 'owner-nodelay', probe, {
      socketId: 'nodelay-true',
      url: peer.url,
      tcpNoDelay: true,
    })
    expect(setNoDelay).toHaveBeenCalledWith(true)
    probe.dispose()
  })

  it('defaults tcpNoDelay to false when the caller omits the option', async () => {
    const peer = await startEchoPeer()
    const setNoDelay = vi.spyOn(Socket.prototype, 'setNoDelay')
    const service = newService()
    const probe = new EventProbe()
    service.listen('owner-nodelay-default', probe.listener)

    await connectAndWait(service, 'owner-nodelay-default', probe, {
      socketId: 'nodelay-default',
      url: peer.url,
    })

    expect(setNoDelay).toHaveBeenCalledWith(false)
    probe.dispose()
  })

  it('treats forceCellularNetwork as a compatible desktop no-op instead of an unsupported error', async () => {
    const peer = await startEchoPeer()
    const service = newService()
    const probe = new EventProbe()
    service.listen('owner-cellular', probe.listener)

    const open = await connectAndWait(service, 'owner-cellular', probe, {
      socketId: 'cellular',
      url: peer.url,
      header: { 'X-Cellular-Noop': 'preserved' },
      protocols: ['chat.v2'],
      forceCellularNetwork: true,
    })
    expect(peer.requests[0]?.headers['x-cellular-noop']).toBe('preserved')
    expect(peer.requests[0]?.protocol).toBe('chat.v2')
    expect(open.event).toBe('open')
    expect(probe.events.some(event => /unsupported/i.test(event.errMsg ?? ''))).toBe(false)
    probe.dispose()
  })
})
