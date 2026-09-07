/**
 * createDeliveryQueue: the service-host preload's inbound-message queue,
 * split out so the "queued item reads a snapshot mutated later" ordering can
 * be tested without faking electron's ipcRenderer.
 *
 * `deliver(msg)` queues while no handler is set and dispatches immediately
 * once one is. `beforeDispatch` runs on EVERY dispatch — queued or
 * immediate — right before the handler sees the message, so a snapshot it
 * mutates (e.g. the sync hostEnvSnapshot a hostEnvUpdate merges into) is
 * current for the handler call that follows it, not for whatever was last
 * merged at the time the message was originally queued. `setHandler` drains
 * the backlog on a microtask; the handler being cleared mid-drain stops it,
 * leaving the rest queued for the next `setHandler`. A handler throw is
 * reported through `onError` and does not stop delivery of what follows.
 */
import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
type ServiceMessage = { type: string; body?: Record<string, unknown> & { size?: { size?: { windowWidth: number } } } }
type Handler = (msg: ServiceMessage) => void
const { createDeliveryQueue } = require('./service-message-queue.cjs') as {
  createDeliveryQueue: (opts: {
    beforeDispatch?: (msg: ServiceMessage) => void
    onError?: (stage: string, error: unknown) => void
  }) => {
    deliver: (msg: ServiceMessage) => void
    setHandler: (fn: Handler | null) => void
    getHandler: () => Handler | null
  }
}
const { applyHostEnvUpdate } = require('./host-env-update.cjs') as {
  applyHostEnvUpdate: (ctx: { hostEnvSnapshot: Record<string, unknown> | null }, msg: unknown) => boolean
}

function resizeMsg(windowWidth: number) {
  return {
    type: 'pageResize',
    target: 'service',
    body: {
      bridgeId: 'b1',
      size: { size: { windowWidth, windowHeight: 800, screenWidth: windowWidth, screenHeight: 800 }, deviceOrientation: 'portrait' },
    },
  }
}

function updateMsg(windowWidth: number) {
  return { type: 'hostEnvUpdate', target: 'service', body: { systemInfo: { windowWidth } } }
}

describe('createDeliveryQueue — a queued pageResize reads the snapshot from its own delivery, not the latest merge', () => {
  it('replays each queued resize against the hostEnvUpdate that preceded it, in arrival order', async () => {
    const ctx: { hostEnvSnapshot: Record<string, unknown> } = { hostEnvSnapshot: { windowWidth: 375 } }
    const queue = createDeliveryQueue({ beforeDispatch: (msg) => applyHostEnvUpdate(ctx, msg) })
    const seen: Array<{ type: string; eventWidth: number | undefined; syncWidth: unknown }> = []

    queue.deliver(updateMsg(430))
    queue.deliver(resizeMsg(430))
    queue.deliver(updateMsg(412))
    queue.deliver(resizeMsg(412))

    queue.setHandler((msg) => {
      seen.push({
        type: msg.type,
        eventWidth: msg.body?.size?.size?.windowWidth,
        syncWidth: ctx.hostEnvSnapshot.windowWidth,
      })
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(seen.map((e) => e.type)).toEqual(['hostEnvUpdate', 'pageResize', 'hostEnvUpdate', 'pageResize'])
    const resizes = seen.filter((e) => e.type === 'pageResize')
    expect(resizes[0].eventWidth).toBe(430)
    expect(resizes[0].syncWidth).toBe(resizes[0].eventWidth)
    expect(resizes[1].eventWidth).toBe(412)
    expect(resizes[1].syncWidth).toBe(resizes[1].eventWidth)
  })
})

describe('createDeliveryQueue — dispatch and handler management', () => {
  it('dispatches immediately, via beforeDispatch then handler, when a handler is already set', () => {
    const calls: string[] = []
    const queue = createDeliveryQueue({ beforeDispatch: () => calls.push('before') })
    queue.setHandler(() => calls.push('handler'))

    queue.deliver({ type: 'x' })

    expect(calls).toEqual(['before', 'handler'])
  })

  it('re-queues once the handler is cleared with setHandler(null), until a new handler drains it', async () => {
    const received: unknown[] = []
    const queue = createDeliveryQueue({})
    queue.setHandler((msg) => received.push(msg))
    await Promise.resolve()
    await Promise.resolve()
    queue.setHandler(null)

    queue.deliver({ type: 'a' })
    await Promise.resolve()
    await Promise.resolve()
    expect(received).toEqual([])

    queue.setHandler((msg) => received.push(msg))
    await Promise.resolve()
    await Promise.resolve()
    expect(received).toEqual([{ type: 'a' }])
  })

  it('reports a handler throw via onError and keeps delivering what follows', async () => {
    const onError = vi.fn()
    const received: unknown[] = []
    const queue = createDeliveryQueue({ onError })
    queue.deliver({ type: 'boom' })
    queue.deliver({ type: 'ok' })

    queue.setHandler((msg) => {
      if (msg.type === 'boom') throw new Error('bad')
      received.push(msg)
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toBe('onMessage')
    expect(onError.mock.calls[0][1]).toBeInstanceOf(Error)
    expect(received).toEqual([{ type: 'ok' }])
  })

  it('stops draining the backlog the moment the handler clears itself mid-drain, leaving the rest queued', async () => {
    const received: unknown[] = []
    const queue = createDeliveryQueue({})
    queue.deliver({ type: 'a' })
    queue.deliver({ type: 'b' })
    queue.deliver({ type: 'c' })

    queue.setHandler((msg) => {
      received.push(msg)
      if (msg.type === 'a') queue.setHandler(null)
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(received).toEqual([{ type: 'a' }])
    expect(queue.getHandler()).toBeNull()
  })

  it('getHandler reflects the current handler, coercing a non-function to null', () => {
    const queue = createDeliveryQueue({})
    expect(queue.getHandler()).toBeNull()

    const fn = () => {}
    queue.setHandler(fn)
    expect(queue.getHandler()).toBe(fn)

    queue.setHandler('not a function' as unknown as Handler)
    expect(queue.getHandler()).toBeNull()
  })
})

describe('createDeliveryQueue — arrival order survives reentrant deliver calls', () => {
  it('keeps arrival order when a message is delivered synchronously while the backlog is still queued for its microtask drain', async () => {
    const received: string[] = []
    const queue = createDeliveryQueue({})
    queue.deliver({ type: 'a' })
    queue.deliver({ type: 'b' })
    queue.setHandler((msg) => received.push(msg.type))
    queue.deliver({ type: 'c' })
    await Promise.resolve()
    await Promise.resolve()

    expect(received).toEqual(['a', 'b', 'c'])
  })

  it('keeps arrival order when the handler delivers a new message from within its own dispatch', async () => {
    const received: string[] = []
    const queue = createDeliveryQueue({})
    queue.deliver({ type: 'a' })
    queue.deliver({ type: 'b' })
    queue.setHandler((msg) => {
      received.push(msg.type)
      if (msg.type === 'a') queue.deliver({ type: 'c' })
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(received).toEqual(['a', 'b', 'c'])
  })
})

describe('createDeliveryQueue — a beforeDispatch throw does not drop the message it was about to annotate', () => {
  it('reports the throw via onError and still hands the message to the handler, on the queued path', async () => {
    const received: string[] = []
    const onError = vi.fn()
    const beforeDispatch = vi.fn((msg: ServiceMessage) => {
      if (msg.type === 'bad') throw new Error('boom')
    })
    const queue = createDeliveryQueue({ beforeDispatch, onError })
    queue.deliver({ type: 'bad' })
    queue.deliver({ type: 'ok' })
    queue.setHandler((msg) => received.push(msg.type))
    await Promise.resolve()
    await Promise.resolve()

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toBe('beforeDispatch')
    expect(received).toEqual(['bad', 'ok'])
  })

  it('reports the throw via onError and still hands the message to the handler, when dispatched immediately', () => {
    const received: string[] = []
    const onError = vi.fn()
    const beforeDispatch = vi.fn((msg: ServiceMessage) => {
      if (msg.type === 'bad') throw new Error('boom')
    })
    const queue = createDeliveryQueue({ beforeDispatch, onError })
    queue.setHandler((msg) => received.push(msg.type))
    queue.deliver({ type: 'bad' })
    queue.deliver({ type: 'ok' })

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toBe('beforeDispatch')
    expect(received).toEqual(['bad', 'ok'])
  })
})
