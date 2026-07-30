/**
 * Synthesize Chrome DevTools Protocol `Network.webSocket*` messages from the
 * main-process WebSocket trace stream (see electron-runtime
 * `native-websocket/trace.ts`).
 *
 * Why this exists: `wx.connectSocket` sockets live on the Node `ws` transport
 * in the MAIN process — no `webContents.debugger` can observe them — so the
 * embedded DevTools Network tab would never show them. The trace stream gives
 * one ordered fact per lifecycle moment; this module re-shapes each fact into
 * the exact CDP event the DevTools front-end already renders natively
 * (`webSocketCreated` creates the row, handshake events fill it, frames land
 * in the Messages view, `webSocketClosed` settles it).
 *
 * Ordering contract this module relies on (guaranteed by the trace layer):
 * `created` strictly precedes every other event for its socketId, and exactly
 * one `closed` terminates each created socket. The front-end silently drops
 * frame/closed events for an unknown requestId, so this module mirrors that
 * discipline defensively: any non-created event for an unknown socketId is
 * dropped rather than synthesized.
 *
 * Pure and self-contained (no Electron imports) so it is unit-testable.
 */
import { isUserFacingRequest } from './user-facing.js'
import type { NativeWebSocketTrace } from '../../ipc/bridge-router.js'

/** One CDP message ready for `DevToolsAPI.dispatchMessage` injection. */
export interface SynthesizedWebSocketMessage {
  method: string
  params: unknown
  /**
   * The verdict `isUserFacingRequest` produced for this socket's url at
   * `created` time, cached for the socket's whole lifetime — every later
   * event reuses it (they carry no url of their own). The user-facing sink
   * gates on this; the global mirror ignores it.
   */
  userFacing: boolean
}

export interface WebSocketSynthesizerOptions {
  /** Per-forwarder instance tag keeping virtual ids collision-free. */
  epoch: string
  /**
   * Origins the app itself serves (resource server / simulator shell), the
   * same inputs `resolveUserFacing` feeds `isUserFacingRequest` for HTTP
   * capture. Re-read at each `created`.
   */
  internalOrigins?: () => ReadonlyArray<string | null | undefined>
}

interface SocketState {
  requestId: string
  userFacing: boolean
}

export class WebSocketTraceSynthesizer {
  private readonly sockets = new Map<string, SocketState>()
  private seq = 0

  constructor(private readonly options: WebSocketSynthesizerOptions) {}

  /**
   * Map one trace event to its CDP message, or null when the event must be
   * dropped (a non-`created` event for a socketId this synthesizer never saw
   * created — defensive against out-of-order delivery).
   */
  synthesize(sessionId: string, event: NativeWebSocketTrace): SynthesizedWebSocketMessage | null {
    const key = `${sessionId} ${event.socketId}`
    if (event.type === 'created') {
      const requestId = `dimina:ws:${this.options.epoch}:${this.seq++}`
      const userFacing = isUserFacingRequest(event.url, this.options.internalOrigins?.())
      this.sockets.set(key, { requestId, userFacing })
      return {
        method: 'Network.webSocketCreated',
        params: { requestId, url: event.url },
        userFacing,
      }
    }

    const state = this.sockets.get(key)
    if (!state) return null
    const { requestId, userFacing } = state
    const timestamp = event.time / 1000

    switch (event.type) {
      case 'handshake-request':
        return {
          method: 'Network.webSocketWillSendHandshakeRequest',
          params: {
            requestId,
            timestamp,
            wallTime: timestamp,
            request: { headers: event.headers },
          },
          userFacing,
        }
      case 'handshake-response':
        return {
          method: 'Network.webSocketHandshakeResponseReceived',
          params: {
            requestId,
            timestamp,
            wallTime: timestamp,
            response: {
              status: event.status,
              statusText: event.statusText,
              headers: event.headers,
            },
          },
          userFacing,
        }
      case 'frame-sent':
        return {
          method: 'Network.webSocketFrameSent',
          params: { requestId, timestamp, response: frame(event, true) },
          userFacing,
        }
      case 'frame-received':
        return {
          method: 'Network.webSocketFrameReceived',
          params: { requestId, timestamp, response: frame(event, false) },
          userFacing,
        }
      case 'frame-error':
        return {
          method: 'Network.webSocketFrameError',
          params: { requestId, timestamp, errorMessage: event.errorMessage },
          userFacing,
        }
      case 'closed':
        // Terminal: release the id mapping so a long session can't grow it.
        this.sockets.delete(key)
        return {
          method: 'Network.webSocketClosed',
          params: { requestId, timestamp },
          userFacing,
        }
    }
  }
}

/** CDP `Network.WebSocketFrame`: client-sent frames are masked, received are not. */
function frame(
  event: { opcode: number; payloadData: string; base64Encoded?: boolean },
  mask: boolean,
): { opcode: number; mask: boolean; payloadData: string; base64Encoded?: boolean } {
  const result: { opcode: number; mask: boolean; payloadData: string; base64Encoded?: boolean } = {
    opcode: event.opcode,
    mask,
    payloadData: event.payloadData,
  }
  if (event.base64Encoded) result.base64Encoded = true
  return result
}
