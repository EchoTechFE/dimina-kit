import { describe, expect, it } from 'vitest'
import {
  connectAndWait,
  EventProbe,
  newService,
  newTracedService,
  startBlackholeServer,
  startEchoPeer,
  traceTypesOf,
  waitUntil,
} from './contract-harness.js'

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Close policy contract: calling closeSocket on a socket whose handshake is
 * still in flight is a client-initiated teardown. Client-mechanism teardowns
 * surface onClose only — never onError — and the event carries the code and
 * reason the app asked for.
 */
describe('Native WebSocket close policy', () => {
  it('treats close on a connecting socket as a client-initiated teardown that emits only the requested close event', async () => {
    const blackhole = await startBlackholeServer()
    const service = newService()
    const probe = new EventProbe()
    service.listen('owner-close-connecting', probe.listener)

    expect((await service.connect('owner-close-connecting', {
      socketId: 'connecting',
      url: blackhole.url,
      timeout: 5_000,
    })).errMsg).toBe('connectSocket:ok')
    await expect(Promise.race([
      blackhole.acceptedConnection,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Blackhole server did not accept the connection')), 1_000)),
    ])).resolves.toBeUndefined()

    expect((await service.close('owner-close-connecting', {
      socketId: 'connecting',
      code: 4001,
      reason: 'app-initiated',
    })).errMsg).toBe('closeSocket:ok')

    await waitUntil(
      () => probe.events.some(event => event.socketId === 'connecting' && event.event === 'close'),
      'close on a connecting socket did not surface its close event',
    )
    await delay(100)
    expect(probe.events).toEqual([
      expect.objectContaining({
        socketId: 'connecting',
        event: 'close',
        code: 4001,
        reason: 'app-initiated',
      }),
    ])
    expect((await service.send('owner-close-connecting', {
      socketId: 'connecting',
      data: 'gone',
    })).errMsg).toBe('sendSocketMessage:fail WebSocket is not connected')
    probe.dispose()
  })

  it('defaults the code to 1000 and the reason to empty when close tears down a connecting socket', async () => {
    const blackhole = await startBlackholeServer()
    const service = newService()
    const probe = new EventProbe()
    service.listen('owner-close-default', probe.listener)

    expect((await service.connect('owner-close-default', {
      socketId: 'connecting-default',
      url: blackhole.url,
      timeout: 5_000,
    })).errMsg).toBe('connectSocket:ok')
    await expect(Promise.race([
      blackhole.acceptedConnection,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Blackhole server did not accept the connection')), 1_000)),
    ])).resolves.toBeUndefined()

    expect((await service.close('owner-close-default', {
      socketId: 'connecting-default',
    })).errMsg).toBe('closeSocket:ok')

    await waitUntil(
      () => probe.events.some(event => event.socketId === 'connecting-default' && event.event === 'close'),
      'close on a connecting socket did not surface its close event',
    )
    await delay(100)
    expect(probe.events).toEqual([
      expect.objectContaining({
        socketId: 'connecting-default',
        event: 'close',
        code: 1000,
        reason: '',
      }),
    ])
    probe.dispose()
  })

  it('emits exactly one closed trace and no frame-error when close tears down a connecting socket', async () => {
    const blackhole = await startBlackholeServer()
    const { service, traces } = newTracedService()
    const probe = new EventProbe()
    service.listen('owner-trace-connecting', probe.listener)

    expect((await service.connect('owner-trace-connecting', {
      socketId: 'trace-connecting',
      url: blackhole.url,
      timeout: 5_000,
    })).errMsg).toBe('connectSocket:ok')
    await expect(Promise.race([
      blackhole.acceptedConnection,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Blackhole server did not accept the connection')), 1_000)),
    ])).resolves.toBeUndefined()

    expect((await service.close('owner-trace-connecting', {
      socketId: 'trace-connecting',
      code: 4001,
      reason: 'app-initiated',
    })).errMsg).toBe('closeSocket:ok')

    await waitUntil(
      () => traceTypesOf(traces, 'trace-connecting').includes('closed'),
      'close on a connecting socket did not terminate the trace stream',
    )
    await delay(100)
    const types = traceTypesOf(traces, 'trace-connecting')
    expect(types.filter(type => type === 'frame-error')).toHaveLength(0)
    expect(types.filter(type => type === 'closed')).toHaveLength(1)
    probe.dispose()
  })

  it('still performs a real handshake close for open connections', async () => {
    const peer = await startEchoPeer()
    const service = newService()
    const probe = new EventProbe()
    service.listen('owner-open-close', probe.listener)
    await connectAndWait(service, 'owner-open-close', probe, {
      socketId: 'open-close',
      url: peer.url,
    })

    const closed = probe.waitFor(
      event => event.socketId === 'open-close' && event.event === 'close',
    )
    expect((await service.close('owner-open-close', {
      socketId: 'open-close',
      code: 4001,
      reason: 'app-initiated',
    })).errMsg).toBe('closeSocket:ok')
    const closeEvent = await closed
    expect(closeEvent).toMatchObject({ code: 4001, reason: 'app-initiated' })
    await waitUntil(
      () => peer.closeFrames.some(frame => frame.code === 4001 && frame.reason === 'app-initiated'),
      'peer did not receive the requested close frame',
    )
    probe.dispose()
  })
})
