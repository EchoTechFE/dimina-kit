import { describe, expect, it } from 'vitest'
import {
  connectAndWait,
  EventProbe,
  headerValue,
  newService,
  startBlackholeServer,
  startEchoPeer,
  waitUntil,
} from './contract-harness.js'

/**
 * Black-box contract for the developer-tool Native WebSocket service.
 *
 * This suite intentionally knows nothing about the service implementation. It
 * exercises only the per-owner API used by the Main-process bridge and a real
 * loopback WebSocket peer. In particular, poisoning globalThis.WebSocket
 * guards against accidentally moving the old Chromium/renderer transport into
 * Main under a different name.
 */
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
