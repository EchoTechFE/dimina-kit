import type { ClientRequest, IncomingMessage, OutgoingHttpHeaders } from 'node:http'
import type { WebSocket } from 'ws'
import { responseHeaders } from './transport.js'

/**
 * Pure observation stream of the native (main-process) WebSocket transport,
 * parallel to the business `NativeWebSocketEvent` channel. One event per
 * lifecycle fact, in the order the facts happen; every `created` socketId is
 * guaranteed exactly one terminal `closed` (SocketTracer.closed is idempotent
 * and every registry-removal path in index.ts funnels through it), so a
 * downstream CDP synthesizer can rely on created→…→closed without tracking
 * transport state itself.
 *
 * `time` is wall-clock milliseconds (`Date.now()`); CDP consumers divide by
 * 1000 for both `timestamp` and `wallTime`.
 */
export type NativeWebSocketTrace =
  | { type: 'created'; socketId: string; url: string; protocols: string[]; time: number }
  | { type: 'handshake-request'; socketId: string; headers: Record<string, string>; time: number }
  | { type: 'handshake-response'; socketId: string; status: number; statusText: string; headers: Record<string, string>; time: number }
  | { type: 'frame-sent'; socketId: string; opcode: number; payloadData: string; base64Encoded?: boolean; time: number }
  | { type: 'frame-received'; socketId: string; opcode: number; payloadData: string; base64Encoded?: boolean; time: number }
  | { type: 'frame-error'; socketId: string; errorMessage: string; time: number }
  | { type: 'closed'; socketId: string; time: number }

/**
 * Single observer of the trace stream (set via `setTracer`). Independent from
 * the per-owner business `listen` channel: registering or clearing the tracer
 * never alters API behaviour, and the tracer's own exceptions are swallowed at
 * the emission site so observation can never break a live socket.
 */
export type NativeWebSocketTracer = (ownerId: string, event: NativeWebSocketTrace) => void

/**
 * Per-socket trace emitter. Every method no-ops (before building any payload)
 * when no tracer is registered, so the unobserved transport stays
 * allocation-free; a throwing tracer is swallowed with a warning. `closed()`
 * is idempotent — the single source for the terminal event, shared by the
 * normal ws close, client-mechanism teardowns, and owner disposal.
 *
 * The implementation stays module-private: declaration files strip types from
 * private class fields, which would surface as untyped identifiers downstream.
 */
export interface SocketTracer {
  /** Fired before socket construction so it strictly precedes the handshake. */
  created(url: string, protocols: string[]): void
  /**
   * Emit `created`, run socket construction, and close the stream if the
   * constructor throws — created precedes the handshake (finishRequest fires
   * synchronously inside the constructor), and a throw is terminal because no
   * registry entry ever exists.
   */
  traceConstruction<T>(url: string, protocols: string[], construct: () => T): T
  /** The full outgoing handshake, including ws-generated Sec-WebSocket-*. */
  handshakeRequest(request: ClientRequest): void
  /** The successful (101) upgrade response. */
  handshakeResponse(response: IncomingMessage): void
  /** Text frames carry their utf8 payload; binary frames are base64'd. */
  frameReceived(data: WebSocket.RawData, isBinary: boolean): void
  /** Control frames surface with an empty payload so the log matches the wire. */
  pingFrame(): void
  pongFrame(): void
  /** Recorded at send-call time so frame order matches the API call order. */
  frameSent(data: string | Buffer): void
  frameError(errorMessage: string): void
  /** Terminal event, emitted at most once no matter how many teardown paths run. */
  closed(): void
}

export function createSocketTracer(
  getTracer: () => NativeWebSocketTracer | undefined,
  ownerId: string,
  socketId: string,
): SocketTracer {
  return new SocketTracerImpl(getTracer, ownerId, socketId)
}

class SocketTracerImpl implements SocketTracer {
  private closedEmitted = false

  constructor(
    private readonly getTracer: () => NativeWebSocketTracer | undefined,
    private readonly ownerId: string,
    private readonly socketId: string,
  ) {}

  private emit(event: NativeWebSocketTrace): void {
    const tracer = this.getTracer()
    if (!tracer) return
    try {
      tracer(this.ownerId, event)
    } catch (error) {
      console.warn('[native-websocket] tracer threw:', error)
    }
  }

  /** Fired before socket construction so it strictly precedes the handshake. */
  created(url: string, protocols: string[]): void {
    if (!this.getTracer()) return
    this.emit({ type: 'created', socketId: this.socketId, url, protocols, time: Date.now() })
  }

  /**
   * Emit `created`, run socket construction, and close the stream if the
   * constructor throws — created precedes the handshake (finishRequest fires
   * synchronously inside the constructor), and a throw is terminal because no
   * registry entry ever exists.
   */
  traceConstruction<T>(url: string, protocols: string[], construct: () => T): T {
    this.created(url, protocols)
    try {
      return construct()
    } catch (error) {
      this.closed()
      throw error
    }
  }

  /**
   * The full outgoing handshake (including ws-generated Sec-WebSocket-*), plus
   * the non-101 path: a rejected upgrade surfaces on the REQUEST's 'response'
   * event. Listening there — never on the socket's 'unexpected-response' —
   * keeps ws's default abort behaviour untouched (ws only aborts when that
   * emit finds no listener).
   */
  handshakeRequest(request: ClientRequest): void {
    if (!this.getTracer()) return
    this.emit({
      type: 'handshake-request',
      socketId: this.socketId,
      headers: outgoingHeadersRecord(request.getHeaders()),
      time: Date.now(),
    })
    request.once('response', (res) => {
      this.emit({
        type: 'handshake-response',
        socketId: this.socketId,
        status: res.statusCode ?? 0,
        statusText: res.statusMessage ?? '',
        headers: responseHeaders(res),
        time: Date.now(),
      })
    })
  }

  /** The successful (101) upgrade response. */
  handshakeResponse(response: IncomingMessage): void {
    if (!this.getTracer()) return
    this.emit({
      type: 'handshake-response',
      socketId: this.socketId,
      status: response.statusCode ?? 101,
      statusText: response.statusMessage ?? '',
      headers: responseHeaders(response),
      time: Date.now(),
    })
  }

  /** Text frames carry their utf8 payload; binary frames are base64'd. */
  frameReceived(data: WebSocket.RawData, isBinary: boolean): void {
    if (!this.getTracer()) return
    this.emit(isBinary
      ? {
          type: 'frame-received',
          socketId: this.socketId,
          opcode: 2,
          payloadData: rawDataToBuffer(data).toString('base64'),
          base64Encoded: true,
          time: Date.now(),
        }
      : { type: 'frame-received', socketId: this.socketId, opcode: 1, payloadData: data.toString(), time: Date.now() })
  }

  /** Control frames surface with an empty payload so the log matches the wire. */
  pingFrame(): void {
    if (!this.getTracer()) return
    this.emit({ type: 'frame-received', socketId: this.socketId, opcode: 9, payloadData: '', time: Date.now() })
  }

  pongFrame(): void {
    if (!this.getTracer()) return
    this.emit({ type: 'frame-received', socketId: this.socketId, opcode: 10, payloadData: '', time: Date.now() })
  }

  /** Recorded at send-call time so frame order matches the API call order. */
  frameSent(data: string | Buffer): void {
    if (!this.getTracer()) return
    this.emit(typeof data === 'string'
      ? { type: 'frame-sent', socketId: this.socketId, opcode: 1, payloadData: data, time: Date.now() }
      : {
          type: 'frame-sent',
          socketId: this.socketId,
          opcode: 2,
          payloadData: data.toString('base64'),
          base64Encoded: true,
          time: Date.now(),
        })
  }

  frameError(errorMessage: string): void {
    if (!this.getTracer()) return
    this.emit({ type: 'frame-error', socketId: this.socketId, errorMessage, time: Date.now() })
  }

  /** Terminal event, emitted at most once no matter how many teardown paths run. */
  closed(): void {
    if (!this.getTracer() || this.closedEmitted) return
    this.closedEmitted = true
    this.emit({ type: 'closed', socketId: this.socketId, time: Date.now() })
  }
}

/** Flatten `ClientRequest.getHeaders()`: multi-values join ', ', unset skipped. */
function outgoingHeadersRecord(headers: OutgoingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    result[name] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  return result
}

/** Reify ws `RawData` (Buffer | ArrayBuffer | Buffer[]) into one Buffer. */
function rawDataToBuffer(data: WebSocket.RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  return data
}
