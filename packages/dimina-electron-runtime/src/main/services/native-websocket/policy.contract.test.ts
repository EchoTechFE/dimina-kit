import { describe, expect, it } from 'vitest'
import {
  connectAndWait,
  EventProbe,
  newService,
  refusedLoopbackUrl,
  startBlackholeServer,
  startEchoPeer,
  waitUntil,
} from './contract-harness.js'

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('Native WebSocket idle timeout policy', () => {
  it('closes an idle open connection with code 1006 and reason idle timeout', async () => {
    const peer = await startEchoPeer()
    const service = newService({ idleTimeoutMs: 150 })
    const probe = new EventProbe()
    service.listen('owner-idle', probe.listener)
    await connectAndWait(service, 'owner-idle', probe, {
      socketId: 'idle',
      url: peer.url,
    })
    probe.clear()

    await waitUntil(
      () => probe.events.some(event => event.event === 'close'),
      'idle connection was not closed',
    )
    await delay(50)
    expect(probe.events).toEqual([
      expect.objectContaining({
        socketId: 'idle',
        event: 'close',
        code: 1006,
        reason: 'idle timeout',
      }),
    ])
    probe.dispose()
  })

  it('resets the idle timer on traffic and closes the connection once traffic stops', async () => {
    const peer = await startEchoPeer()
    const service = newService({ idleTimeoutMs: 150 })
    const probe = new EventProbe()
    service.listen('owner-active', probe.listener)
    await connectAndWait(service, 'owner-active', probe, {
      socketId: 'active',
      url: peer.url,
    })
    probe.clear()

    for (let index = 0; index < 4; index += 1) {
      await delay(50)
      expect((await service.send('owner-active', {
        socketId: 'active',
        data: `keep-alive-${index}`,
      })).errMsg).toBe('sendSocketMessage:ok')
    }
    expect(probe.events.some(event => event.event === 'close')).toBe(false)

    await waitUntil(
      () => probe.events.some(event => event.event === 'close'),
      'connection was not closed after traffic stopped',
    )
    expect(probe.events.some(event => event.event === 'error')).toBe(false)
    expect(probe.events.filter(event => event.event === 'close')).toEqual([
      expect.objectContaining({ socketId: 'active', code: 1006, reason: 'idle timeout' }),
    ])
    probe.dispose()
  })

  it('resets the idle timer on inbound ping control frames and closes after they stop', async () => {
    const peer = await startEchoPeer()
    const service = newService({ idleTimeoutMs: 150 })
    const probe = new EventProbe()
    service.listen('owner-ping', probe.listener)
    await connectAndWait(service, 'owner-ping', probe, {
      socketId: 'pinged',
      url: peer.url,
    })
    probe.clear()

    for (let index = 0; index < 4; index += 1) {
      await delay(50)
      peer.pingClients()
    }
    expect(probe.events.some(event => event.event === 'close')).toBe(false)

    await waitUntil(
      () => probe.events.some(event => event.socketId === 'pinged' && event.event === 'close'),
      'connection was not closed after pings stopped',
    )
    expect(probe.events.some(event => event.event === 'error')).toBe(false)
    expect(probe.events.filter(event => event.event === 'close')).toEqual([
      expect.objectContaining({ socketId: 'pinged', code: 1006, reason: 'idle timeout' }),
    ])
    probe.dispose()
  })

  it('keeps idle connections open when no idle timeout is configured', async () => {
    const peer = await startEchoPeer()
    const service = newService()
    const probe = new EventProbe()
    service.listen('owner-default', probe.listener)
    await connectAndWait(service, 'owner-default', probe, {
      socketId: 'default',
      url: peer.url,
    })
    probe.clear()

    await delay(300)
    expect(probe.events.some(event => event.event === 'close' || event.event === 'error')).toBe(false)

    const echoed = probe.waitFor(
      event => event.socketId === 'default' && event.event === 'message' && event.data === 'still-alive',
    )
    expect((await service.send('owner-default', {
      socketId: 'default',
      data: 'still-alive',
    })).errMsg).toBe('sendSocketMessage:ok')
    await echoed
    probe.dispose()
  })
})

describe('Native WebSocket failure event policy', () => {
  it('reports a refused connection with only an error event and no close', async () => {
    const url = await refusedLoopbackUrl()
    const service = newService()
    const probe = new EventProbe()
    service.listen('owner-refused', probe.listener)

    expect((await service.connect('owner-refused', {
      socketId: 'refused',
      url,
      timeout: 1_000,
    })).errMsg).toBe('connectSocket:ok')

    const error = await probe.waitFor(
      event => event.socketId === 'refused' && event.event === 'error',
    )
    expect(error.errMsg).toMatch(/^connectSocket:fail /)
    await delay(100)
    expect(probe.events.some(event => event.socketId === 'refused' && event.event === 'close')).toBe(false)
    expect(probe.events.filter(
      event => event.socketId === 'refused' && event.event === 'error',
    )).toHaveLength(1)
    probe.dispose()
  })

  it('delivers a 1006 close event when an open connection drops abnormally', async () => {
    const peer = await startEchoPeer()
    const service = newService()
    const probe = new EventProbe()
    service.listen('owner-drop', probe.listener)
    await connectAndWait(service, 'owner-drop', probe, {
      socketId: 'dropped',
      url: peer.url,
    })

    peer.terminateClients()
    // Some platforms surface an error before the close when the peer drops
    // the TCP connection; the contract guarantees only the 1006 close.
    const close = await probe.waitFor(
      event => event.socketId === 'dropped' && event.event === 'close',
    )
    expect(close.code).toBe(1006)
    probe.dispose()
  })

  it('reports a connect timeout with only an error event and no close', async () => {
    const blackhole = await startBlackholeServer()
    const service = newService()
    const probe = new EventProbe()
    service.listen('owner-timed-out', probe.listener)

    expect((await service.connect('owner-timed-out', {
      socketId: 'timed-out',
      url: blackhole.url,
      timeout: 100,
    })).errMsg).toBe('connectSocket:ok')

    const error = await probe.waitFor(
      event => event.socketId === 'timed-out' && event.event === 'error',
    )
    expect(error.errMsg).toBe('connectSocket:fail timed out')
    await delay(100)
    expect(probe.events.some(event => event.socketId === 'timed-out' && event.event === 'close')).toBe(false)
    probe.dispose()
  })
})
