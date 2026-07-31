import { createServer, type Server as NetServer, type Socket as NetSocket } from 'node:net'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, vi } from 'vitest'
import {
  WebSocketServer,
  type RawData,
  type WebSocket,
} from 'ws'
import { createNativeWebSocketService, type NativeWebSocketTrace } from './index.js'

export interface ConnectOptions {
  socketId: string
  url: string
  header?: Record<string, unknown>
  protocols?: string[]
  timeout?: number
  perMessageDeflate?: boolean
  tcpNoDelay?: boolean
  forceCellularNetwork?: boolean
}

export interface SendOptions {
  socketId: string
  data: string | ArrayBuffer | ArrayBufferView
}

export interface CloseOptions {
  socketId: string
  code?: number
  reason?: string
}

export interface NativeWebSocketServiceOptions {
  idleTimeoutMs?: number
  backgroundGraceMs?: number
}

export interface SocketProfile {
  connectEnd: number
  connectStart: number
  cost: number
  domainLookUpEnd: number
  domainLookUpStart: number
  fetchStart: number
  handshakeCost: number
  rtt: number
}

export interface NativeSocketEvent {
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

export interface NativeWebSocketService {
  listen(ownerId: string, listener: (event: NativeSocketEvent) => void): unknown
  connect(ownerId: string, options: ConnectOptions): ApiResult | Promise<ApiResult>
  send(ownerId: string, options: SendOptions): ApiResult | Promise<ApiResult>
  close(ownerId: string, options: CloseOptions): ApiResult | Promise<ApiResult>
  setBackgrounded(backgrounded: boolean): unknown
  setTracer(tracer: ((ownerId: string, event: NativeWebSocketTrace) => void) | undefined): unknown
  disposeOwner(ownerId: string): unknown
  dispose(): unknown
}

export interface EchoPeer {
  url: string
  requests: Array<{
    headers: Record<string, string | string[] | undefined>
    protocol: string
    extensions: string
  }>
  closeFrames: Array<{ code: number, reason: string }>
  pingClients(): void
  terminateClients(): void
  close(): Promise<void>
}

export class EventProbe {
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

export function newService(options?: NativeWebSocketServiceOptions): NativeWebSocketService {
  const service = createNativeWebSocketService(options) as unknown as NativeWebSocketService
  services.push(service)
  return service
}

export interface TraceRecord {
  ownerId: string
  event: NativeWebSocketTrace
}

export function newTracedService(options?: NativeWebSocketServiceOptions): {
  service: NativeWebSocketService
  traces: TraceRecord[]
} {
  const service = newService(options)
  const traces: TraceRecord[] = []
  service.setTracer((ownerId, event) => {
    traces.push({ ownerId, event })
  })
  return { service, traces }
}

export function traceTypesOf(
  traces: TraceRecord[],
  socketId: string,
): Array<NativeWebSocketTrace['type']> {
  return traces
    .filter(trace => trace.event.socketId === socketId)
    .map(trace => trace.event.type)
}

export function headerValue(
  headers: Record<string, unknown> | undefined,
  name: string,
): unknown {
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())
  return entry?.[1]
}

export async function startEchoPeer(options: {
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
    pingClients() {
      for (const client of clients) client.ping()
    },
    terminateClients() {
      for (const client of clients) client.terminate()
    },
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

export async function startBlackholeServer(): Promise<{
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

export async function refusedLoopbackUrl(): Promise<string> {
  const temporary = createServer()
  temporary.listen(0, '127.0.0.1')
  await once(temporary, 'listening')
  const port = (temporary.address() as AddressInfo).port
  await new Promise<void>(resolve => temporary.close(() => resolve()))
  return `ws://127.0.0.1:${port}/refused`
}

export async function connectAndWait(
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

export async function waitUntil(
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

// Each contract suite imports this module in its own isolated vitest module
// graph, so the registries above are per-suite; registering cleanup here keeps
// every suite's peers/services/servers torn down without sharing state.
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
