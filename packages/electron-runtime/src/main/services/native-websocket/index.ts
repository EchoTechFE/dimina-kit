import type { ClientRequest, IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { WebSocket } from 'ws'

export const DEFAULT_SOCKET_TIMEOUT_MS = 60_000
export const MAX_SOCKET_TASKS = 5
export const MAX_CLOSE_REASON_BYTES = 123

export interface NativeSocketProfile {
  connectEnd: number
  connectStart: number
  cost: number
  domainLookUpEnd: number
  domainLookUpStart: number
  fetchStart: number
  handshakeCost: number
  rtt: number
}

export type NativeWebSocketEvent =
  | {
      socketId: string
      event: 'open'
      header: Record<string, string>
      profile: NativeSocketProfile
    }
  | {
      socketId: string
      event: 'message'
      data: string | ArrayBuffer
    }
  | {
      socketId: string
      event: 'error'
      errMsg: string
    }
  | {
      socketId: string
      event: 'close'
      code: number
      reason: string
    }

export interface NativeConnectSocketOptions {
  socketId: string
  url: string
  header?: Record<string, unknown>
  protocols?: string[]
  timeout?: number
  perMessageDeflate?: boolean
  tcpNoDelay?: boolean
  /**
   * Kept for wx.connectSocket contract compatibility. A desktop developer tool
   * cannot select a cellular interface, so true is an explicit no-op.
   */
  forceCellularNetwork?: boolean
}

export interface NativeSendSocketMessageOptions {
  socketId: string
  data: unknown
}

export interface NativeCloseSocketOptions {
  socketId: string
  code?: number
  reason?: string
}

export interface NativeWebSocketResult {
  errMsg: string
}

export interface NativeWebSocketService {
  listen(ownerId: string, listener: (event: NativeWebSocketEvent) => void): void
  connect(ownerId: string, options: NativeConnectSocketOptions): NativeWebSocketResult
  send(ownerId: string, options: NativeSendSocketMessageOptions): Promise<NativeWebSocketResult>
  close(ownerId: string, options: NativeCloseSocketOptions): NativeWebSocketResult
  disposeOwner(ownerId: string): void
  dispose(): void
}

interface ProfileRecorder {
  fetchStart: number
  domainLookUpStart: number
  domainLookUpEnd: number
  connectStart: number
  connectEnd: number
}

interface SocketEntry {
  socket: WebSocket
  errorEmitted: boolean
  timer: NodeJS.Timeout
  profile: ProfileRecorder
  responseHeader: Record<string, string>
  tcpNoDelay: boolean
}

interface OwnerSockets {
  sockets: Map<string, SocketEntry>
  listener?: (event: NativeWebSocketEvent) => void
}

const FORBIDDEN_REQUEST_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'referer',
  'sec-websocket-accept',
  'sec-websocket-extensions',
  'sec-websocket-key',
  'sec-websocket-protocol',
  'sec-websocket-version',
  'upgrade',
])

function now(): number {
  return Date.now()
}

function apiError(name: string, message: string): Error {
  return new Error(`${name}:fail ${message}`)
}

function apiFailureResult(name: string, error: unknown): NativeWebSocketResult {
  const message = error instanceof Error ? error.message : String(error)
  return {
    errMsg: message.startsWith(`${name}:fail`) ? message : `${name}:fail ${message}`,
  }
}

function normalizeSocketUrl(raw: unknown): string {
  let url: URL
  try {
    url = new URL(String(raw))
  } catch {
    throw apiError('connectSocket', 'invalid url')
  }
  if ((url.protocol !== 'ws:' && url.protocol !== 'wss:') || url.hash) {
    throw apiError('connectSocket', 'invalid url')
  }
  return url.toString()
}

function normalizeTimeout(raw: unknown): number {
  if (raw === undefined) return DEFAULT_SOCKET_TIMEOUT_MS
  const timeout = Number(raw)
  if (!Number.isFinite(timeout) || timeout > 0x7fff_ffff) {
    throw apiError('connectSocket', 'invalid timeout')
  }
  if (timeout <= 0) return DEFAULT_SOCKET_TIMEOUT_MS
  return Math.floor(timeout)
}

function normalizeProtocols(raw: unknown): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw apiError('connectSocket', 'protocols must be an array')
  return raw.map((protocol) => {
    if (typeof protocol !== 'string' || !protocol) {
      throw apiError('connectSocket', 'invalid protocol')
    }
    return protocol
  })
}

function normalizeHeaders(raw: unknown): Record<string, string> {
  if (raw === undefined) return {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw apiError('connectSocket', 'header must be an object')
  }
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw)) {
    const normalizedName = name.trim()
    const lowerName = normalizedName.toLowerCase()
    if (!normalizedName || FORBIDDEN_REQUEST_HEADERS.has(lowerName)) continue
    if (/[\r\n]/.test(normalizedName)) {
      throw apiError('connectSocket', 'invalid header')
    }
    if (value === undefined || value === null) continue
    const normalizedValue = String(value)
    if (/[\r\n]/.test(normalizedValue)) {
      throw apiError('connectSocket', 'invalid header')
    }
    result[normalizedName] = normalizedValue
  }
  return result
}

function ensureSocketOrigin(headers: Record<string, string>, socketUrl: string): void {
  if (Object.keys(headers).some(name => name.toLowerCase() === 'origin')) return
  const origin = new URL(socketUrl)
  origin.protocol = origin.protocol === 'wss:' ? 'https:' : 'http:'
  origin.pathname = '/'
  origin.search = ''
  origin.hash = ''
  headers.Origin = origin.origin
}

function responseHeaders(response: IncomingMessage): Record<string, string> {
  const result: Record<string, string> = {}
  const raw = response.rawHeaders
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = raw[index]
    const value = raw[index + 1]
    if (!name || value === undefined) continue
    result[name] = result[name] ? `${result[name]}, ${value}` : value
  }
  return result
}

function arrayBufferFromBuffer(buffer: Buffer): ArrayBuffer {
  // Copy through this realm's Uint8Array. Buffer's backing ArrayBuffer can
  // originate in Node's realm while the service-host callback is observed from
  // another V8 realm; returning it directly breaks `instanceof ArrayBuffer`.
  const bytes = new Uint8Array(buffer.byteLength)
  bytes.set(buffer)
  return bytes.buffer
}

function binaryMessage(data: WebSocket.RawData): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data
  if (Array.isArray(data)) return arrayBufferFromBuffer(Buffer.concat(data))
  return arrayBufferFromBuffer(data)
}

function normalizeSendData(data: unknown): string | Buffer {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  }
  throw apiError('sendSocketMessage', 'data must be string or ArrayBuffer')
}

function validateClose(code: unknown, reason: unknown): { code: number; reason: string } {
  const normalizedCode = code === undefined ? 1000 : Number(code)
  if (
    !Number.isInteger(normalizedCode)
    || (normalizedCode !== 1000 && (normalizedCode < 3000 || normalizedCode > 4999))
  ) {
    throw apiError('closeSocket', 'invalid code')
  }
  if (reason !== undefined && typeof reason !== 'string') {
    throw apiError('closeSocket', 'reason must be a string')
  }
  const normalizedReason = reason ?? ''
  if (Buffer.byteLength(normalizedReason, 'utf8') > MAX_CLOSE_REASON_BYTES) {
    throw apiError('closeSocket', `reason must not exceed ${MAX_CLOSE_REASON_BYTES} UTF-8 bytes`)
  }
  return { code: normalizedCode, reason: normalizedReason }
}

function attachSocketProfile(
  request: ClientRequest,
  profile: ProfileRecorder,
  tcpNoDelay: boolean,
  onSocket: (socket: Socket) => void,
): void {
  const attach = (socket: Socket): void => {
    onSocket(socket)
    profile.domainLookUpStart = now()
    socket.setNoDelay(tcpNoDelay)
    socket.once('lookup', () => {
      profile.domainLookUpEnd = now()
      profile.connectStart = profile.domainLookUpEnd
    })
    const connected = (): void => {
      if (profile.domainLookUpEnd === 0) {
        profile.domainLookUpStart = profile.fetchStart
        profile.domainLookUpEnd = profile.fetchStart
      }
      if (profile.connectStart === 0) profile.connectStart = profile.domainLookUpEnd
      profile.connectEnd = now()
    }
    if ('encrypted' in socket) socket.once('secureConnect', connected)
    else socket.once('connect', connected)
  }
  if (request.socket) attach(request.socket)
  else request.once('socket', attach)
}

function completeProfile(profile: ProfileRecorder, openedAt: number): NativeSocketProfile {
  const connectStart = profile.connectStart || profile.fetchStart
  const connectEnd = profile.connectEnd || openedAt
  const domainLookUpStart = profile.domainLookUpStart || profile.fetchStart
  const domainLookUpEnd = profile.domainLookUpEnd || domainLookUpStart
  return {
    fetchStart: profile.fetchStart,
    domainLookUpStart,
    domainLookUpEnd,
    connectStart,
    connectEnd,
    rtt: Math.max(0, connectEnd - connectStart),
    handshakeCost: Math.max(0, openedAt - connectEnd),
    cost: Math.max(0, openedAt - profile.fetchStart),
  }
}

function errorMessage(error: Error): string {
  if (/timed?\s*out|timeout/i.test(error.message)) {
    return 'connectSocket:fail timeout'
  }
  return `connectSocket:fail ${error.message || 'WebSocket connection failed'}`
}

export function createNativeWebSocketService(): NativeWebSocketService {
  const owners = new Map<string, OwnerSockets>()

  const owner = (ownerId: string): OwnerSockets => {
    let sockets = owners.get(ownerId)
    if (!sockets) {
      sockets = { sockets: new Map() }
      owners.set(ownerId, sockets)
    }
    return sockets
  }

  const emit = (ownerId: string, event: NativeWebSocketEvent): void => {
    owners.get(ownerId)?.listener?.(event)
  }

  const disposeOwner = (ownerId: string): void => {
    const current = owners.get(ownerId)
    if (!current) return
    owners.delete(ownerId)
    current.listener = undefined
    for (const entry of current.sockets.values()) {
      clearTimeout(entry.timer)
      entry.socket.removeAllListeners()
      try {
        entry.socket.terminate()
      } catch {
        // Best-effort teardown during project/session disposal.
      }
    }
    current.sockets.clear()
  }

  return {
    listen(ownerId, listener) {
      owner(ownerId).listener = listener
    },

    connect(ownerId, options) {
      try {
        const current = owner(ownerId)
        if (!options.socketId || current.sockets.has(options.socketId)) {
          throw apiError('connectSocket', 'invalid socketId')
        }
        if (current.sockets.size >= MAX_SOCKET_TASKS) {
          throw apiError('connectSocket', `reach max websocket connect count ${MAX_SOCKET_TASKS}`)
        }

        const url = normalizeSocketUrl(options.url)
        const protocols = normalizeProtocols(options.protocols)
        const timeout = normalizeTimeout(options.timeout)
        const header = normalizeHeaders(options.header)
        ensureSocketOrigin(header, url)
        const tcpNoDelay = options.tcpNoDelay === true
        const profile: ProfileRecorder = {
          fetchStart: now(),
          domainLookUpStart: 0,
          domainLookUpEnd: 0,
          connectStart: 0,
          connectEnd: 0,
        }
        let transportSocket: Socket | undefined
        let transportRequest: ClientRequest | undefined

        const socket = new WebSocket(url, protocols, {
          headers: header,
          perMessageDeflate: options.perMessageDeflate === true,
          finishRequest(request) {
            transportRequest = request
            attachSocketProfile(request, profile, tcpNoDelay, (transport) => {
              transportSocket = transport
            })
            request.end()
          },
        })

        const entry: SocketEntry = {
          socket,
          errorEmitted: false,
          timer: setTimeout(() => {
            if (socket.readyState !== WebSocket.CONNECTING) return
            entry.errorEmitted = true
            emit(ownerId, {
              socketId: options.socketId,
              event: 'error',
              errMsg: 'connectSocket:fail timed out',
            })
            transportRequest?.destroy()
            transportSocket?.destroy()
            socket.terminate()
          }, timeout),
          profile,
          responseHeader: {},
          tcpNoDelay,
        }
        current.sockets.set(options.socketId, entry)

        socket.once('upgrade', (response) => {
          entry.responseHeader = responseHeaders(response)
        })
        socket.once('open', () => {
          clearTimeout(entry.timer)
          const openedAt = now()
          const transport = (socket as WebSocket & { _socket?: Socket })._socket
          transport?.setNoDelay(entry.tcpNoDelay)
          emit(ownerId, {
            socketId: options.socketId,
            event: 'open',
            header: entry.responseHeader,
            profile: completeProfile(profile, openedAt),
          })
        })
        socket.on('message', (data, isBinary) => {
          emit(ownerId, {
            socketId: options.socketId,
            event: 'message',
            data: isBinary ? binaryMessage(data) : data.toString(),
          })
        })
        socket.on('error', (error) => {
          if (entry.errorEmitted) return
          entry.errorEmitted = true
          emit(ownerId, {
            socketId: options.socketId,
            event: 'error',
            errMsg: errorMessage(error),
          })
          if (socket.readyState === WebSocket.CONNECTING) {
            transportSocket?.destroy()
            socket.terminate()
          }
        })
        socket.once('close', (code, reason) => {
          clearTimeout(entry.timer)
          current.sockets.delete(options.socketId)
          emit(ownerId, {
            socketId: options.socketId,
            event: 'close',
            code,
            reason: reason.toString(),
          })
          if (current.sockets.size === 0 && !current.listener) owners.delete(ownerId)
        })

        return { errMsg: 'connectSocket:ok' }
      } catch (error) {
        return apiFailureResult('connectSocket', error)
      }
    },

    send(ownerId, options) {
      const entry = owners.get(ownerId)?.sockets.get(options.socketId)
      if (!entry || entry.socket.readyState !== WebSocket.OPEN) {
        return Promise.resolve(apiFailureResult(
          'sendSocketMessage',
          apiError('sendSocketMessage', 'WebSocket is not connected'),
        ))
      }
      let data: string | Buffer
      try {
        data = normalizeSendData(options.data)
      } catch (error) {
        return Promise.resolve(apiFailureResult('sendSocketMessage', error))
      }
      return new Promise((resolve) => {
        entry.socket.send(data, (error) => {
          if (error) {
            resolve(apiFailureResult('sendSocketMessage', error))
            return
          }
          resolve({ errMsg: 'sendSocketMessage:ok' })
        })
      })
    },

    close(ownerId, options) {
      try {
        const entry = owners.get(ownerId)?.sockets.get(options.socketId)
        if (!entry || entry.socket.readyState === WebSocket.CLOSED) {
          throw apiError('closeSocket', 'WebSocket is not connected')
        }
        const { code, reason } = validateClose(options.code, options.reason)
        entry.socket.close(code, reason)
        return { errMsg: 'closeSocket:ok' }
      } catch (error) {
        return apiFailureResult('closeSocket', error)
      }
    },

    disposeOwner,

    dispose() {
      for (const ownerId of Array.from(owners.keys())) disposeOwner(ownerId)
    },
  }
}
