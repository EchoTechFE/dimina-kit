import type { ClientRequest, IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { WebSocket } from 'ws'
import {
  apiError,
  apiFailureResult,
  ensureSocketOrigin,
  MAX_SOCKET_TASKS,
  normalizeHeaders,
  normalizeProtocols,
  normalizeSendData,
  normalizeSocketUrl,
  normalizeTimeout,
  validateClose,
} from './normalize.js'

export { DEFAULT_SOCKET_TIMEOUT_MS, MAX_CLOSE_REASON_BYTES, MAX_SOCKET_TASKS } from './normalize.js'

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

function now(): number {
  return Date.now()
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
