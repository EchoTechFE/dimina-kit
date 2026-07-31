import { describe, expect, it } from 'vitest'
import {
  connectAndWait,
  EventProbe,
  newService,
  startBlackholeServer,
  startEchoPeer,
  waitUntil,
} from './contract-harness.js'

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Background policy contract: once the tool window hides, open connections
 * survive a short grace period and are then interrupted; backgrounding is a
 * global switch that applies to every owner of the service.
 */
describe('Native WebSocket background policy', () => {
  it('closes an open connection with code 1006 and reason interrupted once the background grace elapses', async () => {
    const peer = await startEchoPeer()
    const service = newService({ backgroundGraceMs: 50 })
    const probe = new EventProbe()
    service.listen('owner-background', probe.listener)
    await connectAndWait(service, 'owner-background', probe, {
      socketId: 'backgrounded',
      url: peer.url,
    })
    probe.clear()

    service.setBackgrounded(true)
    await delay(30)
    expect(probe.events).toEqual([])

    await waitUntil(
      () => probe.events.some(event => event.event === 'close'),
      'backgrounded connection was not closed after the grace period',
    )
    await delay(50)
    expect(probe.events).toEqual([
      expect.objectContaining({
        socketId: 'backgrounded',
        event: 'close',
        code: 1006,
        reason: 'interrupted',
      }),
    ])
    probe.dispose()
  })

  it('keeps the connection alive when the tool returns to the foreground within the grace period', async () => {
    const peer = await startEchoPeer()
    const service = newService({ backgroundGraceMs: 50 })
    const probe = new EventProbe()
    service.listen('owner-foreground', probe.listener)
    await connectAndWait(service, 'owner-foreground', probe, {
      socketId: 'foregrounded',
      url: peer.url,
    })
    probe.clear()

    service.setBackgrounded(true)
    await delay(20)
    service.setBackgrounded(false)
    await delay(100)
    expect(probe.events.some(event => event.event === 'close' || event.event === 'error')).toBe(false)

    const echoed = probe.waitFor(
      event => event.socketId === 'foregrounded' && event.event === 'message' && event.data === 'still-alive',
    )
    expect((await service.send('owner-foreground', {
      socketId: 'foregrounded',
      data: 'still-alive',
    })).errMsg).toBe('sendSocketMessage:ok')
    await echoed
    probe.dispose()
  })

  it('rejects connect, send, and close with interrupted while backgrounded without killing live connections', async () => {
    const peer = await startEchoPeer()
    const service = newService({ backgroundGraceMs: 50 })
    const probe = new EventProbe()
    service.listen('owner-reject', probe.listener)
    await connectAndWait(service, 'owner-reject', probe, {
      socketId: 'live',
      url: peer.url,
    })
    probe.clear()

    service.setBackgrounded(true)

    expect(service.connect('owner-reject', {
      socketId: 'blocked',
      url: peer.url,
    })).toEqual({ errMsg: 'connectSocket:fail interrupted' })
    expect((await service.send('owner-reject', {
      socketId: 'live',
      data: 'muted',
    })).errMsg).toBe('sendSocketMessage:fail interrupted')
    expect((await service.close('owner-reject', {
      socketId: 'live',
    })).errMsg).toBe('closeSocket:fail interrupted')
    expect(probe.events).toEqual([])

    service.setBackgrounded(false)
    const echoed = probe.waitFor(
      event => event.socketId === 'live' && event.event === 'message' && event.data === 'alive-again',
    )
    expect((await service.send('owner-reject', {
      socketId: 'live',
      data: 'alive-again',
    })).errMsg).toBe('sendSocketMessage:ok')
    await echoed
    probe.dispose()
  })

  it('interrupts a stalled handshake with only an error event and no close', async () => {
    const blackhole = await startBlackholeServer()
    const service = newService({ backgroundGraceMs: 50 })
    const probe = new EventProbe()
    service.listen('owner-stalled', probe.listener)

    expect((await service.connect('owner-stalled', {
      socketId: 'stalled',
      url: blackhole.url,
      timeout: 5_000,
    })).errMsg).toBe('connectSocket:ok')
    await expect(Promise.race([
      blackhole.acceptedConnection,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Blackhole server did not accept the connection')), 1_000)),
    ])).resolves.toBeUndefined()

    service.setBackgrounded(true)
    await waitUntil(
      () => probe.events.some(event => event.socketId === 'stalled' && event.event === 'error'),
      'stalled handshake was not interrupted after the grace period',
    )
    await delay(100)
    expect(probe.events).toEqual([
      expect.objectContaining({
        socketId: 'stalled',
        event: 'error',
        errMsg: 'connectSocket:fail interrupted',
      }),
    ])
    probe.dispose()
  })

  it('does not resurrect interrupted connections after returning to the foreground', async () => {
    const peer = await startEchoPeer()
    const service = newService({ backgroundGraceMs: 50 })
    const probe = new EventProbe()
    service.listen('owner-resume', probe.listener)
    await connectAndWait(service, 'owner-resume', probe, {
      socketId: 'interrupted',
      url: peer.url,
    })

    service.setBackgrounded(true)
    await waitUntil(
      () => probe.events.some(event => event.socketId === 'interrupted' && event.event === 'close'),
      'backgrounded connection was not closed after the grace period',
    )
    service.setBackgrounded(false)
    await delay(100)

    expect(probe.events.filter(
      event => event.socketId === 'interrupted' && event.event === 'open',
    )).toHaveLength(1)
    expect((await service.send('owner-resume', {
      socketId: 'interrupted',
      data: 'revive',
    })).errMsg).toMatch(/^sendSocketMessage:fail /)

    await connectAndWait(service, 'owner-resume', probe, {
      socketId: 'fresh',
      url: peer.url,
    })
    probe.dispose()
  })

  it('applies the background policy globally to connections of every owner', async () => {
    const peer = await startEchoPeer()
    const service = newService({ backgroundGraceMs: 50 })
    const ownerA = new EventProbe()
    const ownerB = new EventProbe()
    service.listen('owner-a', ownerA.listener)
    service.listen('owner-b', ownerB.listener)
    await connectAndWait(service, 'owner-a', ownerA, {
      socketId: 'a',
      url: peer.url,
    })
    await connectAndWait(service, 'owner-b', ownerB, {
      socketId: 'b',
      url: peer.url,
    })
    ownerA.clear()
    ownerB.clear()

    service.setBackgrounded(true)
    await waitUntil(
      () => ownerA.events.some(event => event.event === 'close')
        && ownerB.events.some(event => event.event === 'close'),
      'background policy did not close both owners connections',
    )
    await delay(50)
    expect(ownerA.events).toEqual([
      expect.objectContaining({ socketId: 'a', event: 'close', code: 1006, reason: 'interrupted' }),
    ])
    expect(ownerB.events).toEqual([
      expect.objectContaining({ socketId: 'b', event: 'close', code: 1006, reason: 'interrupted' }),
    ])
    ownerA.dispose()
    ownerB.dispose()
  })
})
