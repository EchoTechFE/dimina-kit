import { createServer } from 'node:net'
import { Socket } from 'node:net'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import {
  connectAndWait,
  EventProbe,
  newService,
  startEchoPeer,
  waitUntil,
} from './contract-harness.js'

describe('Native WebSocket lifecycle and ownership', () => {
  it('rejects unsupported URLs and reports connection errors using the connectSocket error namespace', async () => {
    const service = newService()
    const probe = new EventProbe()
    service.listen('owner-errors', probe.listener)

    const invalid = await service.connect('owner-errors', {
      socketId: 'invalid-url',
      url: 'https://example.invalid/not-websocket',
    })
    expect(invalid.errMsg).toMatch(/^connectSocket:fail /)

    const temporary = createServer()
    temporary.listen(0, '127.0.0.1')
    await once(temporary, 'listening')
    const port = (temporary.address() as AddressInfo).port
    await new Promise<void>(resolve => temporary.close(() => resolve()))

    const refused = probe.waitFor(
      event => event.socketId === 'refused' && event.event === 'error',
    )
    expect((await service.connect('owner-errors', {
      socketId: 'refused',
      url: `ws://127.0.0.1:${port}/refused`,
      timeout: 500,
    })).errMsg).toBe('connectSocket:ok')
    expect((await refused).errMsg).toMatch(/^connectSocket:fail /)
    probe.dispose()
  })

  it('limits each owner to five live connections without imposing a global five-socket cap', async () => {
    const peer = await startEchoPeer()
    const service = newService()
    const ownerA = new EventProbe()
    const ownerB = new EventProbe()
    service.listen('owner-a', ownerA.listener)
    service.listen('owner-b', ownerB.listener)

    for (let index = 0; index < 5; index += 1) {
      await connectAndWait(service, 'owner-a', ownerA, {
        socketId: `a-${index}`,
        url: peer.url,
      })
    }
    const sixth = await service.connect('owner-a', {
      socketId: 'a-5',
      url: peer.url,
    })
    expect(sixth.errMsg).toMatch(/^connectSocket:fail .*5/)

    await connectAndWait(service, 'owner-b', ownerB, {
      socketId: 'b-0',
      url: peer.url,
    })
    expect(peer.requests).toHaveLength(6)
    ownerA.dispose()
    ownerB.dispose()
  })

  it('disposeOwner closes only that owner and dispose is idempotent', async () => {
    const peer = await startEchoPeer()
    const service = newService()
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

    await Promise.resolve(service.disposeOwner('owner-a'))
    await waitUntil(
      () => peer.closeFrames.length === 1,
      'disposeOwner did not close its native network connection',
    )

    const ownerBEcho = ownerB.waitFor(
      event => event.socketId === 'b' && event.event === 'message' && event.data === 'owner-b-alive',
    )
    expect((await service.send('owner-b', {
      socketId: 'b',
      data: 'owner-b-alive',
    })).errMsg).toBe('sendSocketMessage:ok')
    await ownerBEcho

    await Promise.resolve(service.dispose())
    await Promise.resolve(service.dispose())
    await waitUntil(
      () => peer.closeFrames.length === 2,
      'dispose did not close the remaining native network connection',
    )
    ownerA.dispose()
    ownerB.dispose()
  })
})

describe('Native WebSocket advanced connect options', () => {
  it('uses perMessageDeflate to control extension negotiation', async () => {
    const peer = await startEchoPeer({ perMessageDeflate: true })
    const service = newService()
    const probe = new EventProbe()
    service.listen('owner-deflate', probe.listener)

    await connectAndWait(service, 'owner-deflate', probe, {
      socketId: 'deflate-off',
      url: peer.url,
      perMessageDeflate: false,
    })
    expect(peer.requests[0]?.headers['sec-websocket-extensions']).toBeUndefined()
    expect(peer.requests[0]?.extensions).toBe('')

    await connectAndWait(service, 'owner-deflate', probe, {
      socketId: 'deflate-on',
      url: peer.url,
      perMessageDeflate: true,
    })
    expect(peer.requests[1]?.headers['sec-websocket-extensions']).toContain('permessage-deflate')
    expect(peer.requests[1]?.extensions).toContain('permessage-deflate')
    probe.dispose()
  })

  it('applies tcpNoDelay to the native Node socket', async () => {
    const peer = await startEchoPeer()
    const setNoDelay = vi.spyOn(Socket.prototype, 'setNoDelay')
    const service = newService()
    const probe = new EventProbe()
    service.listen('owner-nodelay', probe.listener)

    await connectAndWait(service, 'owner-nodelay', probe, {
      socketId: 'nodelay-false',
      url: peer.url,
      tcpNoDelay: false,
    })
    expect(setNoDelay).toHaveBeenCalledWith(false)

    setNoDelay.mockClear()
    await connectAndWait(service, 'owner-nodelay', probe, {
      socketId: 'nodelay-true',
      url: peer.url,
      tcpNoDelay: true,
    })
    expect(setNoDelay).toHaveBeenCalledWith(true)
    probe.dispose()
  })

  it('defaults tcpNoDelay to false when the caller omits the option', async () => {
    const peer = await startEchoPeer()
    const setNoDelay = vi.spyOn(Socket.prototype, 'setNoDelay')
    const service = newService()
    const probe = new EventProbe()
    service.listen('owner-nodelay-default', probe.listener)

    await connectAndWait(service, 'owner-nodelay-default', probe, {
      socketId: 'nodelay-default',
      url: peer.url,
    })

    expect(setNoDelay).toHaveBeenCalledWith(false)
    probe.dispose()
  })

  it('treats forceCellularNetwork as a compatible desktop no-op instead of an unsupported error', async () => {
    const peer = await startEchoPeer()
    const service = newService()
    const probe = new EventProbe()
    service.listen('owner-cellular', probe.listener)

    const open = await connectAndWait(service, 'owner-cellular', probe, {
      socketId: 'cellular',
      url: peer.url,
      header: { 'X-Cellular-Noop': 'preserved' },
      protocols: ['chat.v2'],
      forceCellularNetwork: true,
    })
    expect(peer.requests[0]?.headers['x-cellular-noop']).toBe('preserved')
    expect(peer.requests[0]?.protocol).toBe('chat.v2')
    expect(open.event).toBe('open')
    expect(probe.events.some(event => /unsupported/i.test(event.errMsg ?? ''))).toBe(false)
    probe.dispose()
  })
})
