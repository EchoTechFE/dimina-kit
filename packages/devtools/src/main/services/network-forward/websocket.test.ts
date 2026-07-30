/**
 * Unit tests for WebSocketTraceSynthesizer — the pure mapper that re-shapes
 * one main-process WebSocket trace event into the exact `Network.webSocket*`
 * CDP message the embedded DevTools front-end renders natively.
 *
 * Contracts guarded here:
 *  - `created` mints a `dimina:ws:<epoch>:<seq>` virtual requestId and carries
 *    the business url verbatim (this row is what makes a real socket visible
 *    in the Network panel);
 *  - handshake events pass headers/status/statusText through untouched, with
 *    `timestamp`/`wallTime` converted from wall-clock ms to CDP seconds;
 *  - client-sent frames are masked, received frames are not, and binary
 *    payloads stay base64 round-trippable;
 *  - any non-`created` event for a socketId this synthesizer never saw is
 *    dropped (the front-end would drop it too), and `closed` releases the id
 *    mapping so a re-created socketId gets a fresh requestId;
 *  - the user-facing verdict is decided once at `created` (the only event
 *    carrying a url) and reused by every later event of the same socket.
 */
import { describe, expect, it } from 'vitest'
import { WebSocketTraceSynthesizer } from './websocket.js'
import type { NativeWebSocketTrace } from '../../ipc/bridge-router.js'

const SESSION = 'owner-session-1'
const EPOCH = 'epoch-test'
const BASE_TIME = 1_700_000_000_000

interface CreatedParams {
  requestId: string
  url: string
}

interface HandshakeRequestParams {
  requestId: string
  timestamp: number
  wallTime: number
  request: { headers: Record<string, string> }
}

interface HandshakeResponseParams {
  requestId: string
  timestamp: number
  wallTime: number
  response: { status: number; statusText: string; headers: Record<string, string> }
}

interface FrameParams {
  requestId: string
  timestamp: number
  response: { opcode: number; mask: boolean; payloadData: string; base64Encoded?: boolean }
}

interface FrameErrorParams {
  requestId: string
  timestamp: number
  errorMessage: string
}

interface ClosedParams {
  requestId: string
  timestamp: number
}

function makeSynthesizer(internalOrigins?: () => ReadonlyArray<string | null | undefined>): WebSocketTraceSynthesizer {
  return new WebSocketTraceSynthesizer({ epoch: EPOCH, internalOrigins })
}

function createdEvent(socketId: string, url: string): NativeWebSocketTrace {
  return { type: 'created', socketId, url, protocols: [], time: BASE_TIME }
}

function createSocket(
  synthesizer: WebSocketTraceSynthesizer,
  socketId: string,
  url = 'wss://business.example.com/socket',
  sessionId = SESSION,
): CreatedParams {
  const message = synthesizer.synthesize(sessionId, createdEvent(socketId, url))
  expect(message).not.toBeNull()
  expect(message!.method).toBe('Network.webSocketCreated')
  return message!.params as CreatedParams
}

describe('WebSocketTraceSynthesizer', () => {
  describe('created', () => {
    it('maps created to Network.webSocketCreated with a namespaced requestId and the url verbatim', () => {
      const synthesizer = makeSynthesizer()
      const message = synthesizer.synthesize(SESSION, createdEvent('socket-1', 'wss://business.example.com/ws?token=abc'))
      expect(message).not.toBeNull()
      expect(message!.method).toBe('Network.webSocketCreated')
      const params = message!.params as CreatedParams
      expect(params.requestId).toBe(`dimina:ws:${EPOCH}:0`)
      expect(params.url).toBe('wss://business.example.com/ws?token=abc')
    })

    it('mints a monotonically increasing requestId per created socket', () => {
      const synthesizer = makeSynthesizer()
      const first = createSocket(synthesizer, 'socket-1')
      const second = createSocket(synthesizer, 'socket-2')
      const third = createSocket(synthesizer, 'socket-3', 'wss://other.example.com/', 'owner-session-2')
      expect(first.requestId).toBe(`dimina:ws:${EPOCH}:0`)
      expect(second.requestId).toBe(`dimina:ws:${EPOCH}:1`)
      expect(third.requestId).toBe(`dimina:ws:${EPOCH}:2`)
      expect(new Set([first.requestId, second.requestId, third.requestId]).size).toBe(3)
    })
  })

  describe('handshake', () => {
    it('maps handshake-request with verbatim headers and second-based timestamp/wallTime', () => {
      const synthesizer = makeSynthesizer()
      const { requestId } = createSocket(synthesizer, 'socket-1')
      const headers = {
        host: 'business.example.com',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
      }
      const message = synthesizer.synthesize(SESSION, {
        type: 'handshake-request',
        socketId: 'socket-1',
        headers,
        time: BASE_TIME + 1234,
      })
      expect(message).not.toBeNull()
      expect(message!.method).toBe('Network.webSocketWillSendHandshakeRequest')
      const params = message!.params as HandshakeRequestParams
      expect(params.requestId).toBe(requestId)
      expect(params.request.headers).toEqual(headers)
      expect(params.timestamp).toBe((BASE_TIME + 1234) / 1000)
      expect(params.wallTime).toBe((BASE_TIME + 1234) / 1000)
    })

    it('maps handshake-response with status, statusText and headers passed through', () => {
      const synthesizer = makeSynthesizer()
      const { requestId } = createSocket(synthesizer, 'socket-1')
      const headers = { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-accept': 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=' }
      const message = synthesizer.synthesize(SESSION, {
        type: 'handshake-response',
        socketId: 'socket-1',
        status: 101,
        statusText: 'Switching Protocols',
        headers,
        time: BASE_TIME + 1500,
      })
      expect(message).not.toBeNull()
      expect(message!.method).toBe('Network.webSocketHandshakeResponseReceived')
      const params = message!.params as HandshakeResponseParams
      expect(params.requestId).toBe(requestId)
      expect(params.response.status).toBe(101)
      expect(params.response.statusText).toBe('Switching Protocols')
      expect(params.response.headers).toEqual(headers)
      expect(params.timestamp).toBe((BASE_TIME + 1500) / 1000)
      expect(params.wallTime).toBe((BASE_TIME + 1500) / 1000)
    })
  })

  describe('frames', () => {
    it('maps a sent text frame as masked opcode 1 with the raw payload', () => {
      const synthesizer = makeSynthesizer()
      const { requestId } = createSocket(synthesizer, 'socket-1')
      const message = synthesizer.synthesize(SESSION, {
        type: 'frame-sent',
        socketId: 'socket-1',
        opcode: 1,
        payloadData: 'client:hello',
        time: BASE_TIME + 2000,
      })
      expect(message).not.toBeNull()
      expect(message!.method).toBe('Network.webSocketFrameSent')
      const params = message!.params as FrameParams
      expect(params.requestId).toBe(requestId)
      expect(params.response.mask).toBe(true)
      expect(params.response.opcode).toBe(1)
      expect(params.response.payloadData).toBe('client:hello')
      expect('base64Encoded' in params.response).toBe(false)
      expect(params.timestamp).toBe((BASE_TIME + 2000) / 1000)
    })

    it('maps a sent binary frame base64-encoded so it decodes back to the original bytes', () => {
      const synthesizer = makeSynthesizer()
      createSocket(synthesizer, 'socket-1')
      const bytes = [1, 2, 3, 4, 254, 255]
      const message = synthesizer.synthesize(SESSION, {
        type: 'frame-sent',
        socketId: 'socket-1',
        opcode: 2,
        payloadData: Buffer.from(bytes).toString('base64'),
        base64Encoded: true,
        time: BASE_TIME + 2000,
      })
      expect(message).not.toBeNull()
      expect(message!.method).toBe('Network.webSocketFrameSent')
      const params = message!.params as FrameParams
      expect(params.response.mask).toBe(true)
      expect(params.response.opcode).toBe(2)
      expect(params.response.base64Encoded).toBe(true)
      expect(Array.from(Buffer.from(params.response.payloadData, 'base64'))).toEqual(bytes)
    })

    it('maps a received text frame as unmasked opcode 1 with the raw payload', () => {
      const synthesizer = makeSynthesizer()
      createSocket(synthesizer, 'socket-1')
      const message = synthesizer.synthesize(SESSION, {
        type: 'frame-received',
        socketId: 'socket-1',
        opcode: 1,
        payloadData: 'server:hello',
        time: BASE_TIME + 2100,
      })
      expect(message).not.toBeNull()
      expect(message!.method).toBe('Network.webSocketFrameReceived')
      const params = message!.params as FrameParams
      expect(params.response.mask).toBe(false)
      expect(params.response.opcode).toBe(1)
      expect(params.response.payloadData).toBe('server:hello')
      expect('base64Encoded' in params.response).toBe(false)
    })

    it('maps a received binary frame base64-encoded so it decodes back to the original bytes', () => {
      const synthesizer = makeSynthesizer()
      createSocket(synthesizer, 'socket-1')
      const bytes = [1, 2, 3, 4]
      const message = synthesizer.synthesize(SESSION, {
        type: 'frame-received',
        socketId: 'socket-1',
        opcode: 2,
        payloadData: Buffer.from(bytes).toString('base64'),
        base64Encoded: true,
        time: BASE_TIME + 2100,
      })
      expect(message).not.toBeNull()
      expect(message!.method).toBe('Network.webSocketFrameReceived')
      const params = message!.params as FrameParams
      expect(params.response.mask).toBe(false)
      expect(params.response.opcode).toBe(2)
      expect(params.response.base64Encoded).toBe(true)
      expect(Array.from(Buffer.from(params.response.payloadData, 'base64'))).toEqual(bytes)
    })
  })

  describe('frame-error and closed', () => {
    it('maps frame-error to Network.webSocketFrameError carrying the message', () => {
      const synthesizer = makeSynthesizer()
      const { requestId } = createSocket(synthesizer, 'socket-1')
      const message = synthesizer.synthesize(SESSION, {
        type: 'frame-error',
        socketId: 'socket-1',
        errorMessage: 'connectSocket:fail timed out',
        time: BASE_TIME + 3000,
      })
      expect(message).not.toBeNull()
      expect(message!.method).toBe('Network.webSocketFrameError')
      const params = message!.params as FrameErrorParams
      expect(params.requestId).toBe(requestId)
      expect(params.errorMessage).toBe('connectSocket:fail timed out')
      expect(params.timestamp).toBe((BASE_TIME + 3000) / 1000)
    })

    it('maps closed to Network.webSocketClosed', () => {
      const synthesizer = makeSynthesizer()
      const { requestId } = createSocket(synthesizer, 'socket-1')
      const message = synthesizer.synthesize(SESSION, {
        type: 'closed',
        socketId: 'socket-1',
        time: BASE_TIME + 4000,
      })
      expect(message).not.toBeNull()
      expect(message!.method).toBe('Network.webSocketClosed')
      const params = message!.params as ClosedParams
      expect(params.requestId).toBe(requestId)
      expect(params.timestamp).toBe((BASE_TIME + 4000) / 1000)
    })
  })

  describe('unknown-socketId discipline', () => {
    it('drops frame, frame-error and closed events for a socketId that was never created', () => {
      const synthesizer = makeSynthesizer()
      const frame = synthesizer.synthesize(SESSION, {
        type: 'frame-received',
        socketId: 'ghost',
        opcode: 1,
        payloadData: 'late',
        time: BASE_TIME,
      })
      const frameError = synthesizer.synthesize(SESSION, {
        type: 'frame-error',
        socketId: 'ghost',
        errorMessage: 'boom',
        time: BASE_TIME,
      })
      const closed = synthesizer.synthesize(SESSION, { type: 'closed', socketId: 'ghost', time: BASE_TIME })
      expect(frame).toBeNull()
      expect(frameError).toBeNull()
      expect(closed).toBeNull()
    })

    it('drops events arriving on a session whose socketId was never created there', () => {
      const synthesizer = makeSynthesizer()
      createSocket(synthesizer, 'socket-1', 'wss://business.example.com/', 'owner-session-1')
      const leaked = synthesizer.synthesize('owner-session-2', {
        type: 'frame-received',
        socketId: 'socket-1',
        opcode: 1,
        payloadData: 'cross-session',
        time: BASE_TIME,
      })
      expect(leaked).toBeNull()
    })

    it('releases the id mapping at closed so a re-created socketId mints a fresh requestId', () => {
      const synthesizer = makeSynthesizer()
      const first = createSocket(synthesizer, 'socket-1')
      synthesizer.synthesize(SESSION, { type: 'closed', socketId: 'socket-1', time: BASE_TIME + 1 })

      // After the terminal event the mapping is gone: stragglers are dropped
      // exactly like events for a socketId that never existed.
      const straggler = synthesizer.synthesize(SESSION, {
        type: 'frame-received',
        socketId: 'socket-1',
        opcode: 1,
        payloadData: 'after-close',
        time: BASE_TIME + 2,
      })
      expect(straggler).toBeNull()

      const second = createSocket(synthesizer, 'socket-1')
      expect(second.requestId).not.toBe(first.requestId)
      expect(second.requestId).toBe(`dimina:ws:${EPOCH}:1`)
    })
  })

  describe('user-facing verdict', () => {
    it('flags a business wss url as user-facing on every event of the socket', () => {
      const synthesizer = makeSynthesizer(() => ['ws://127.0.0.1:54321/'])
      const created = synthesizer.synthesize(SESSION, createdEvent('socket-1', 'wss://business.example.com/socket'))
      expect(created!.userFacing).toBe(true)
      const closed = synthesizer.synthesize(SESSION, { type: 'closed', socketId: 'socket-1', time: BASE_TIME + 1 })
      expect(closed!.userFacing).toBe(true)
    })

    it('flags a socket whose url origin matches internalOrigins as not user-facing, decided once at created', () => {
      const synthesizer = makeSynthesizer(() => ['ws://127.0.0.1:54321/', null, undefined])
      const created = synthesizer.synthesize(SESSION, createdEvent('socket-1', 'ws://127.0.0.1:54321/internal-ws'))
      expect(created!.userFacing).toBe(false)
      // Later events carry no url of their own; they must reuse the
      // created-time verdict rather than re-deriving (or failing open).
      const frame = synthesizer.synthesize(SESSION, {
        type: 'frame-sent',
        socketId: 'socket-1',
        opcode: 1,
        payloadData: 'internal',
        time: BASE_TIME + 1,
      })
      expect(frame!.userFacing).toBe(false)
      const closed = synthesizer.synthesize(SESSION, { type: 'closed', socketId: 'socket-1', time: BASE_TIME + 2 })
      expect(closed!.userFacing).toBe(false)
    })

    it('re-reads internalOrigins at each created instead of caching across sockets', () => {
      let internal: ReadonlyArray<string | null | undefined> = []
      const synthesizer = makeSynthesizer(() => internal)
      const before = synthesizer.synthesize(SESSION, createdEvent('socket-1', 'ws://127.0.0.1:54321/ws'))
      expect(before!.userFacing).toBe(true)
      internal = ['ws://127.0.0.1:54321/']
      const after = synthesizer.synthesize(SESSION, createdEvent('socket-2', 'ws://127.0.0.1:54321/ws'))
      expect(after!.userFacing).toBe(false)
    })
  })
})
