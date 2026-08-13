import type { ClientRequest } from 'node:http'
import type { Socket } from 'node:net'
import { WebSocket } from 'ws'
import { NativeWebSocketEventRegistry } from './event-registry.js'
import {
  apiError,
  apiFailureResult,
  MAX_SOCKET_TASKS,
  normalizeHeaders,
  normalizeProtocols,
  normalizeSendData,
  normalizeSocketUrl,
  normalizeTimeout,
  validateClose,
} from './normalize.js'
import type { ProfileRecorder } from './transport.js'
import {
  attachSocketProfile,
  binaryMessage,
  completeProfile,
  errorMessage,
  now,
  responseHeaders,
} from './transport.js'
import { createSocketTracer, type NativeWebSocketTracer, type SocketTracer } from './trace.js'
import type {
  NativeWebSocketEvent,
  NativeWebSocketEventName,
  NativeWebSocketResult,
  NativeWebSocketService,
  NativeWebSocketServiceOptions,
} from './types.js'

export { DEFAULT_SOCKET_TIMEOUT_MS, MAX_CLOSE_REASON_BYTES, MAX_SOCKET_TASKS } from './normalize.js'
export type { NativeSocketProfile } from './transport.js'
export type { NativeWebSocketTrace, NativeWebSocketTracer } from './trace.js'
export type {
  NativeCloseSocketOptions,
  NativeConnectSocketOptions,
  NativeSendSocketMessageOptions,
  NativeWebSocketCallbackEmitter,
  NativeWebSocketEvent,
  NativeWebSocketEventName,
  NativeWebSocketEventSubscription,
  NativeWebSocketResult,
  NativeWebSocketService,
  NativeWebSocketServiceOptions,
} from './types.js'

/**
 * Mini-program background network policy (official "网络使用说明"): after the
 * app stays in the background for this grace period, live socket connections
 * are interrupted. Client-initiated teardown surfaces as onClose only — never
 * onError ("由客户端机制断开的长连，不会触发 socketError 事件").
 */
export const DEFAULT_BACKGROUND_GRACE_MS = 5_000
export const BACKGROUND_CLOSE_REASON = 'interrupted'
export const IDLE_CLOSE_REASON = 'idle timeout'
export const INTERRUPTED_ERRMSG_SUFFIX = 'interrupted'
const CLIENT_TEARDOWN_CODE = 1006

interface SocketEntry {
  socket: WebSocket
  opened: boolean
  errorEmitted: boolean
  /** Per-socket trace emitter; its `closed()` is the idempotent terminal event. */
  tracer: SocketTracer
  timer: NodeJS.Timeout
  idleTimer?: NodeJS.Timeout
  profile: ProfileRecorder
  responseHeader: Record<string, string>
  tcpNoDelay: boolean
  transportHandles: {
    request?: ClientRequest
    socket?: Socket
  }
}

interface OwnerSockets {
  sockets: Map<string, SocketEntry>
  listener?: (event: NativeWebSocketEvent) => void
}

function interruptedResult(name: string): NativeWebSocketResult {
  return { errMsg: `${name}:fail ${INTERRUPTED_ERRMSG_SUFFIX}` }
}

function positiveMs(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return 0
  return Math.floor(raw)
}

export function createNativeWebSocketService(
  options: NativeWebSocketServiceOptions = {},
): NativeWebSocketService {
  const owners = new Map<string, OwnerSockets>()
  const eventRegistry = new NativeWebSocketEventRegistry()
  const idleTimeoutMs = positiveMs(options.idleTimeoutMs)
  const backgroundGraceMs = positiveMs(options.backgroundGraceMs) || DEFAULT_BACKGROUND_GRACE_MS
  let backgrounded = false
  let backgroundTimer: NodeJS.Timeout | undefined
  let tracer: NativeWebSocketTracer | undefined

  const owner = (ownerId: string): OwnerSockets => {
    let sockets = owners.get(ownerId)
    if (!sockets) {
      sockets = { sockets: new Map() }
      owners.set(ownerId, sockets)
    }
    return sockets
  }

  const emit = (
    ownerId: string,
    event: NativeWebSocketEvent,
    options: { detach?: boolean; replayTerminal?: boolean } = {},
  ): void => {
    owners.get(ownerId)?.listener?.(event)
    const { socketId, event: eventName, ...payload } = event
    eventRegistry.dispatch(ownerId, socketId, eventName as NativeWebSocketEventName, payload, options)
  }

  const releaseOwnerIfIdle = (ownerId: string, current: OwnerSockets): void => {
    // The re-lookup guards against a late ws event captured by a disposed
    // owner deleting a re-registered owner's entry under the same ownerId.
    if (current.sockets.size === 0 && !current.listener && owners.get(ownerId) === current) {
      owners.delete(ownerId)
    }
  }

  const clearEntryTimers = (entry: SocketEntry): void => {
    clearTimeout(entry.timer)
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
  }

  /**
   * Client-side teardown shared by background interruption and idle shutdown:
   * sever the transport without a handshake close, then surface exactly one
   * close event (1006) — onError never fires for client-mechanism teardowns.
   */
  const teardownSocket = (
    ownerId: string,
    socketId: string,
    current: OwnerSockets,
    entry: SocketEntry,
    event: NativeWebSocketEvent | undefined,
  ): void => {
    current.sockets.delete(socketId)
    entry.tracer.closed()
    clearEntryTimers(entry)
    entry.socket.removeAllListeners()
    // ws aborts a CONNECTING socket asynchronously (nextTick emitErrorAndClose);
    // without a listener that error would escape as an uncaught exception.
    entry.socket.on('error', () => {})
    entry.transportHandles.request?.destroy()
    entry.transportHandles.socket?.destroy()
    try {
      entry.socket.terminate()
    } catch {
      // Best-effort teardown; the entry is already detached from the registry.
    }
    if (event) emit(ownerId, event, { detach: true, replayTerminal: true })
    else eventRegistry.detachSocket(ownerId, socketId)
    releaseOwnerIfIdle(ownerId, current)
  }

  const teardownAllForBackground = (): void => {
    backgroundTimer = undefined
    for (const [ownerId, current] of Array.from(owners.entries())) {
      for (const [socketId, entry] of Array.from(current.sockets.entries())) {
        if (entry.opened) {
          teardownSocket(ownerId, socketId, current, entry, {
            socketId,
            event: 'close',
            code: CLIENT_TEARDOWN_CODE,
            reason: BACKGROUND_CLOSE_REASON,
          })
        } else if (!entry.errorEmitted) {
          // A socket still handshaking fails the connect instead of reporting
          // a close: onClose only exists for connections that once opened.
          entry.errorEmitted = true
          entry.tracer.frameError(interruptedResult('connectSocket').errMsg)
          teardownSocket(ownerId, socketId, current, entry, {
            socketId,
            event: 'error',
            errMsg: interruptedResult('connectSocket').errMsg,
          })
        } else {
          // Already errored mid-handshake: the failure was reported, so the
          // background teardown only reclaims the entry.
          teardownSocket(ownerId, socketId, current, entry, undefined)
        }
      }
    }
  }

  const armIdleTimer = (ownerId: string, socketId: string): void => {
    if (!idleTimeoutMs) return
    const current = owners.get(ownerId)
    const entry = current?.sockets.get(socketId)
    if (!current || !entry) return
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => {
      if (!entry.opened) return
      teardownSocket(ownerId, socketId, current, entry, {
        socketId,
        event: 'close',
        code: CLIENT_TEARDOWN_CODE,
        reason: IDLE_CLOSE_REASON,
      })
    }, idleTimeoutMs)
  }

  const disposeOwner = (ownerId: string): void => {
    eventRegistry.disposeOwner(ownerId)
    const current = owners.get(ownerId)
    if (!current) return
    owners.delete(ownerId)
    current.listener = undefined
    for (const entry of current.sockets.values()) {
      entry.tracer.closed()
      clearEntryTimers(entry)
      entry.socket.removeAllListeners()
      // Same async-abort swallow as teardownSocket: terminating a CONNECTING
      // socket emits its error on the next tick.
      entry.socket.on('error', () => {})
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

    onSocketEvent(ownerId, event, subscription, emitter) {
      eventRegistry.on(ownerId, event, subscription, emitter)
    },

    offSocketEvent(ownerId, event, subscription) {
      eventRegistry.off(ownerId, event, subscription)
    },

    connect(ownerId, options) {
      try {
        if (backgrounded) throw apiError('connectSocket', INTERRUPTED_ERRMSG_SUFFIX)
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
        if (options.containerReferer) header.Referer = options.containerReferer
        const tcpNoDelay = options.tcpNoDelay === true
        const profile: ProfileRecorder = {
          fetchStart: now(),
          domainLookUpStart: 0,
          domainLookUpEnd: 0,
          connectStart: 0,
          connectEnd: 0,
        }

        // finishRequest fires synchronously inside the WebSocket constructor,
        // so transport handles are pinned through a mutable holder the entry
        // shares with the setup callbacks.
        const transportHandles: SocketEntry['transportHandles'] = {}

        const socketTracer = createSocketTracer(() => tracer, ownerId, options.socketId)
        const socket = socketTracer.traceConstruction(url, protocols, () => new WebSocket(url, protocols, {
          headers: header,
          perMessageDeflate: options.perMessageDeflate === true,
          finishRequest(request) {
            transportHandles.request = request
            socketTracer.handshakeRequest(request)
            attachSocketProfile(request, profile, tcpNoDelay, (transport) => {
              transportHandles.socket = transport
            })
            request.end()
          },
        }))

        const entry: SocketEntry = {
          socket,
          opened: false,
          errorEmitted: false,
          tracer: socketTracer,
          timer: setTimeout(() => {
            if (socket.readyState !== WebSocket.CONNECTING) return
            entry.errorEmitted = true
            socketTracer.frameError('connectSocket:fail timeout')
            emit(ownerId, {
              socketId: options.socketId,
              event: 'error',
              errMsg: 'connectSocket:fail timeout',
            }, { detach: true, replayTerminal: true })
            entry.transportHandles.request?.destroy()
            entry.transportHandles.socket?.destroy()
            socket.terminate()
          }, timeout),
          profile,
          responseHeader: {},
          tcpNoDelay,
          transportHandles,
        }
        current.sockets.set(options.socketId, entry)
        eventRegistry.beginSocket(ownerId, options.socketId)

        socket.once('upgrade', (response) => {
          entry.responseHeader = responseHeaders(response)
          socketTracer.handshakeResponse(response)
        })
        socket.once('open', () => {
          clearTimeout(entry.timer)
          entry.opened = true
          const openedAt = now()
          const transport = (socket as WebSocket & { _socket?: Socket })._socket
          transport?.setNoDelay(entry.tcpNoDelay)
          emit(ownerId, {
            socketId: options.socketId,
            event: 'open',
            header: entry.responseHeader,
            profile: completeProfile(profile, openedAt),
          })
          armIdleTimer(ownerId, options.socketId)
        })
        socket.on('message', (data, isBinary) => {
          socketTracer.frameReceived(data, isBinary)
          emit(ownerId, isBinary
            ? {
                socketId: options.socketId,
                event: 'message',
                data: binaryMessage(data),
                isBuffer: true,
              }
            : {
                socketId: options.socketId,
                event: 'message',
                data: data.toString(),
              })
          armIdleTimer(ownerId, options.socketId)
        })
        socket.on('ping', () => {
          socketTracer.pingFrame()
          armIdleTimer(ownerId, options.socketId)
        })
        socket.on('pong', () => {
          socketTracer.pongFrame()
          armIdleTimer(ownerId, options.socketId)
        })
        socket.on('error', (error) => {
          if (entry.errorEmitted) return
          entry.errorEmitted = true
          socketTracer.frameError(errorMessage(error))
          const connecting = socket.readyState === WebSocket.CONNECTING
          emit(ownerId, {
            socketId: options.socketId,
            event: 'error',
            errMsg: errorMessage(error),
          }, { detach: connecting, replayTerminal: true })
          if (connecting) {
            entry.transportHandles.socket?.destroy()
            socket.terminate()
          }
        })
        socket.once('close', (code, reason) => {
          clearEntryTimers(entry)
          current.sockets.delete(options.socketId)
          socketTracer.closed()
          // onClose only exists for connections that once opened; a failed
          // connect reports error alone (real-device contract).
          if (entry.opened) {
            emit(ownerId, {
              socketId: options.socketId,
              event: 'close',
              code,
              reason: reason.toString(),
            }, { detach: true, replayTerminal: true })
          } else {
            eventRegistry.detachSocket(ownerId, options.socketId)
          }
          releaseOwnerIfIdle(ownerId, current)
        })

        return { errMsg: 'connectSocket:ok' }
      } catch (error) {
        return apiFailureResult('connectSocket', error)
      }
    },

    send(ownerId, options) {
      if (backgrounded) {
        return Promise.resolve(interruptedResult('sendSocketMessage'))
      }
      const entry = owners.get(ownerId)?.sockets.get(options.socketId)
      if (!entry || entry.socket.readyState !== WebSocket.OPEN) {
        return Promise.resolve(apiFailureResult(
          'sendSocketMessage',
          apiError('sendSocketMessage', 'WebSocket is not connected'),
        ))
      }
      let data: string | Buffer
      try {
        data = normalizeSendData(options.data, options.isBuffer === true)
      } catch (error) {
        return Promise.resolve(apiFailureResult('sendSocketMessage', error))
      }
      // Traced at call time (not in the ack callback) so the panel's frame
      // order matches the order wx.sendSocketMessage was invoked.
      entry.tracer.frameSent(data)
      return new Promise((resolve) => {
        entry.socket.send(data, (error) => {
          if (error) {
            const failure = apiFailureResult('sendSocketMessage', error)
            entry.tracer.frameError(failure.errMsg)
            resolve(failure)
            return
          }
          armIdleTimer(ownerId, options.socketId)
          resolve({ errMsg: 'sendSocketMessage:ok' })
        })
      })
    },

    close(ownerId, options) {
      try {
        if (backgrounded) throw apiError('closeSocket', INTERRUPTED_ERRMSG_SUFFIX)
        const current = owners.get(ownerId)
        const entry = current?.sockets.get(options.socketId)
        if (
          !current
          || !entry
          || entry.socket.readyState === WebSocket.CLOSING
          || entry.socket.readyState === WebSocket.CLOSED
        ) {
          throw apiError('closeSocket', 'WebSocket is not connected')
        }
        const { code, reason } = validateClose(options.code, options.reason)
        if (entry.socket.readyState === WebSocket.CONNECTING) {
          // Closing mid-handshake is a client-initiated teardown: ws would
          // otherwise surface its abort error, while the client-mechanism
          // policy reports exactly one close carrying the caller's code.
          teardownSocket(ownerId, options.socketId, current, entry, {
            socketId: options.socketId,
            event: 'close',
            code,
            reason,
          })
          return { errMsg: 'closeSocket:ok' }
        }
        entry.socket.close(code, reason)
        return { errMsg: 'closeSocket:ok' }
      } catch (error) {
        return apiFailureResult('closeSocket', error)
      }
    },

    setBackgrounded(flag) {
      if (flag === backgrounded) return
      backgrounded = flag
      if (backgroundTimer) {
        clearTimeout(backgroundTimer)
        backgroundTimer = undefined
      }
      if (backgrounded) {
        backgroundTimer = setTimeout(teardownAllForBackground, backgroundGraceMs)
      }
    },

    setTracer(next) {
      tracer = next
    },

    disposeOwner,

    dispose() {
      if (backgroundTimer) {
        clearTimeout(backgroundTimer)
        backgroundTimer = undefined
      }
      for (const ownerId of Array.from(owners.keys())) disposeOwner(ownerId)
      eventRegistry.dispose()
    },
  }
}
