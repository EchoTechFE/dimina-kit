import { describe, expect, it, vi } from 'vitest'
import {
  connectAndWait,
  EventProbe,
  newService,
  refusedLoopbackUrl,
  startEchoPeer,
} from './contract-harness.js'

function callbackRecorder() {
  const calls: Array<{ callbackId: unknown; payload: Record<string, unknown> }> = []
  return {
    calls,
    emit(callbackId: unknown, payload: Record<string, unknown>) {
      calls.push({ callbackId, payload })
    },
  }
}

describe('Native WebSocket per-task bridge event registration', () => {
  it('delivers open to a callback registered immediately after connect is accepted', async () => {
    const peer = await startEchoPeer()
    const service = newService()
    const recorder = callbackRecorder()

    expect((await service.connect('owner', { socketId: 'socket', url: peer.url })).errMsg)
      .toBe('connectSocket:ok')
    service.onSocketEvent('owner', 'open', { socketId: 'socket', callback: 'open-id' }, recorder.emit)

    await vi.waitFor(() => expect(recorder.calls).toHaveLength(1))
    expect(recorder.calls[0]).toMatchObject({ callbackId: 'open-id' })
    expect(recorder.calls[0].payload).toHaveProperty('header')
    expect(recorder.calls[0].payload).not.toHaveProperty('socketId')
    expect(recorder.calls[0].payload).not.toHaveProperty('event')
  })

  it('replays an already-observed open exactly once to a late callback', async () => {
    const peer = await startEchoPeer()
    const service = newService()
    const probe = new EventProbe()
    const recorder = callbackRecorder()
    service.listen('owner', probe.listener)
    await connectAndWait(service, 'owner', probe, { socketId: 'socket', url: peer.url })

    service.onSocketEvent('owner', 'open', { socketId: 'socket', callback: 'late-open' }, recorder.emit)
    service.onSocketEvent('owner', 'open', { socketId: 'socket', callback: 'late-open' }, recorder.emit)

    expect(recorder.calls).toHaveLength(1)
    expect(recorder.calls[0].callbackId).toBe('late-open')
  })

  it('replays a handshake error to a callback registered after the transport failed', async () => {
    const service = newService()
    const probe = new EventProbe()
    const recorder = callbackRecorder()
    service.listen('owner', probe.listener)
    const failed = probe.waitFor(event => event.socketId === 'socket' && event.event === 'error')
    expect((await service.connect('owner', {
      socketId: 'socket',
      url: await refusedLoopbackUrl(),
    })).errMsg).toBe('connectSocket:ok')
    await failed

    service.onSocketEvent('owner', 'error', { socketId: 'socket', callback: 'late-error' }, recorder.emit)

    expect(recorder.calls).toEqual([{
      callbackId: 'late-error',
      payload: expect.objectContaining({ errMsg: expect.stringMatching(/^connectSocket:fail/) }),
    }])
  })

  it('retains open replay when the socket reaches terminal state before bridge registration', async () => {
    const peer = await startEchoPeer()
    const service = newService()
    const probe = new EventProbe()
    const recorder = callbackRecorder()
    service.listen('owner', probe.listener)
    await connectAndWait(service, 'owner', probe, { socketId: 'socket', url: peer.url })
    const closed = probe.waitFor(event => event.socketId === 'socket' && event.event === 'close')
    expect((await service.close('owner', { socketId: 'socket', code: 4001, reason: 'done' })).errMsg)
      .toBe('closeSocket:ok')
    await closed

    service.onSocketEvent('owner', 'open', { socketId: 'socket', callback: 'late-open' }, recorder.emit)
    service.onSocketEvent('owner', 'open', { socketId: 'socket', callback: 'late-open' }, recorder.emit)

    expect(recorder.calls).toHaveLength(1)
    expect(recorder.calls[0]).toMatchObject({
      callbackId: 'late-open',
      payload: { header: expect.any(Object), profile: expect.any(Object) },
    })
  })

  it('replays close metadata to a callback registered after close', async () => {
    const peer = await startEchoPeer()
    const service = newService()
    const probe = new EventProbe()
    const recorder = callbackRecorder()
    service.listen('owner', probe.listener)
    await connectAndWait(service, 'owner', probe, { socketId: 'socket', url: peer.url })
    const closed = probe.waitFor(event => event.socketId === 'socket' && event.event === 'close')
    expect((await service.close('owner', { socketId: 'socket', code: 4001, reason: 'done' })).errMsg)
      .toBe('closeSocket:ok')
    await closed

    service.onSocketEvent('owner', 'close', { socketId: 'socket', callback: 'late-close' }, recorder.emit)

    expect(recorder.calls).toEqual([{
      callbackId: 'late-close',
      payload: { code: 4001, reason: 'done' },
    }])
  })

  it('does not replay messages that arrived before registration', async () => {
    const peer = await startEchoPeer()
    const service = newService()
    const probe = new EventProbe()
    const recorder = callbackRecorder()
    service.listen('owner', probe.listener)
    await connectAndWait(service, 'owner', probe, { socketId: 'socket', url: peer.url })
    const message = probe.waitFor(event => event.socketId === 'socket' && event.event === 'message')
    await service.send('owner', { socketId: 'socket', data: 'before-listener' })
    await message

    service.onSocketEvent('owner', 'message', { socketId: 'socket', callback: 'message-id' }, recorder.emit)

    expect(recorder.calls).toEqual([])
  })

  it('offSocketEvent removes the exact callback before open', async () => {
    const peer = await startEchoPeer()
    const service = newService()
    const recorder = callbackRecorder()
    expect((await service.connect('owner', { socketId: 'socket', url: peer.url })).errMsg)
      .toBe('connectSocket:ok')
    const subscription = { socketId: 'socket', callback: 'open-id' }
    service.onSocketEvent('owner', 'open', subscription, recorder.emit)
    service.offSocketEvent('owner', 'open', subscription)

    await new Promise(resolve => setTimeout(resolve, 30))
    expect(recorder.calls).toEqual([])
  })

  it('deduplicates the same callback id while preserving distinct callbacks', async () => {
    const peer = await startEchoPeer()
    const service = newService()
    const recorder = callbackRecorder()
    expect((await service.connect('owner', { socketId: 'socket', url: peer.url })).errMsg)
      .toBe('connectSocket:ok')
    service.onSocketEvent('owner', 'open', { socketId: 'socket', callback: 'a' }, recorder.emit)
    service.onSocketEvent('owner', 'open', { socketId: 'socket', callback: 'a' }, recorder.emit)
    service.onSocketEvent('owner', 'open', { socketId: 'socket', callback: 'b' }, recorder.emit)

    await vi.waitFor(() => expect(recorder.calls).toHaveLength(2))
    expect(recorder.calls.map(call => call.callbackId)).toEqual(['a', 'b'])
  })

  it('keeps callback registries isolated by owner', async () => {
    const peer = await startEchoPeer()
    const service = newService()
    const recorderA = callbackRecorder()
    const recorderB = callbackRecorder()
    expect((await service.connect('owner-a', { socketId: 'same-id', url: peer.url })).errMsg)
      .toBe('connectSocket:ok')
    service.onSocketEvent('owner-a', 'open', { socketId: 'same-id', callback: 'a' }, recorderA.emit)
    service.onSocketEvent('owner-b', 'open', { socketId: 'same-id', callback: 'b' }, recorderB.emit)

    await vi.waitFor(() => expect(recorderA.calls).toHaveLength(1))
    expect(recorderB.calls).toEqual([])
  })

  it('delivers binary callback payloads as base64 plus the internal marker', async () => {
    const peer = await startEchoPeer()
    const service = newService()
    const probe = new EventProbe()
    const recorder = callbackRecorder()
    service.listen('owner', probe.listener)
    await connectAndWait(service, 'owner', probe, { socketId: 'socket', url: peer.url })
    service.onSocketEvent('owner', 'message', { socketId: 'socket', callback: 'binary-id' }, recorder.emit)
    const data = Buffer.from([1, 2, 3, 4]).toString('base64')

    expect((await service.send('owner', { socketId: 'socket', data, isBuffer: true })).errMsg)
      .toBe('sendSocketMessage:ok')
    await vi.waitFor(() => expect(recorder.calls).toHaveLength(1))
    expect(recorder.calls[0]).toEqual({
      callbackId: 'binary-id',
      payload: { data, isBuffer: true },
    })
  })
})
