/**
 * Main-side resource accounting for `createHostSlotPortChannel`: which
 * webContents listeners and MessagePort pairs a slot channel creates, and
 * what releases them.
 *
 * `attach()` installs listeners on one webContents and returns the handle that
 * takes them back off it; `dispose()` closes the live port and sweeps the
 * handler registry. The two together are what keeps the accounting closed: no
 * listener outlives the webContents it sits on, and no main-held port outlives
 * the document it belongs to. These tests pin that as counted state (listeners
 * resting on a LIVE wc, and main-held ports still open, both back at the
 * pre-create baseline) together with the per-document guarantees that rest on
 * it: releasing one wc's attachment does not disturb its successor, a
 * superseded wc cannot take the channel back, only cross-document main-frame
 * navigation invalidates, and a replacement document handshakes onto a port of
 * its own.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { WebContents } from 'electron'

/** Main-side view of one `MessagePortMain` end, as the channel uses it. */
interface FakePort {
  role: 'port1' | 'port2'
  closed: boolean
  started: boolean
  /** Set when the fake wc accepts this end in a `postMessage` transfer list. */
  transferred: boolean
  posted: unknown[]
  emit(event: string, ...args: unknown[]): void
}

vi.mock('electron', () => {
  const ports: FakePort[] = []
  class MessagePortMain {
    closed = false
    started = false
    transferred = false
    posted: unknown[] = []
    private readonly handlers = new Map<string, Array<(...args: never[]) => void>>()
    constructor(readonly role: 'port1' | 'port2') {
      ports.push(this as unknown as FakePort)
    }
    on(event: string, handler: (...args: never[]) => void): this {
      const list = this.handlers.get(event) ?? []
      list.push(handler)
      this.handlers.set(event, list)
      return this
    }
    start(): void {
      this.started = true
    }
    // Closing the local end does not deliver a local 'close' event; that
    // event means "the REMOTE end went away".
    close(): void {
      this.closed = true
    }
    postMessage(data: unknown): void {
      this.posted.push(data)
    }
    emit(event: string, ...args: unknown[]): void {
      for (const handler of [...(this.handlers.get(event) ?? [])]) {
        ;(handler as unknown as (...a: unknown[]) => void)(...args)
      }
    }
  }
  class MessageChannelMain {
    port1 = new MessagePortMain('port1')
    port2 = new MessagePortMain('port2')
  }
  return { MessageChannelMain, __ports: ports }
})

import { createHostSlotPortChannel } from './host-slot-port-channel.js'
import type { HostSlotAttachment } from './host-slot-port-channel.js'
import * as electronMock from 'electron'

const ports = (electronMock as unknown as { __ports: FakePort[] }).__ports

/** Ends the main process keeps (port1); port2 is transferred to the page. */
function mainHeldPorts(): FakePort[] {
  return ports.filter((port) => port.role === 'port1')
}

function openMainHeldPorts(): FakePort[] {
  return mainHeldPorts().filter((port) => !port.closed)
}

/** Every end must be either closed here or handed to a renderer. */
function unaccountedPorts(): FakePort[] {
  return ports.filter((port) => !port.closed && !port.transferred)
}

interface FakeWebContents {
  id: number
  destroyed: boolean
  /** One entry per accepted `postMessage(channel, message, transfer)`. */
  transfers: Array<{ channel: string; ports: FakePort[] }>
  listenerCount(): number
  on(event: string, handler: (...args: never[]) => void): FakeWebContents
  off(event: string, handler: (...args: never[]) => void): FakeWebContents
  postMessage(channel: string, message: unknown, transfer?: unknown[]): void
  emit(event: string, ...args: unknown[]): void
  /** What the owning view does on rebuild/teardown. */
  destroy(): void
}

let nextWcId = 1

function fakeWebContents(): FakeWebContents {
  const handlers = new Map<string, Array<(...args: never[]) => void>>()
  const wc: FakeWebContents = {
    id: nextWcId++,
    destroyed: false,
    transfers: [],
    listenerCount(): number {
      let total = 0
      for (const list of handlers.values()) total += list.length
      return total
    },
    on(event, handler): FakeWebContents {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return wc
    },
    off(event, handler): FakeWebContents {
      const list = handlers.get(event) ?? []
      const i = list.indexOf(handler)
      if (i >= 0) list.splice(i, 1)
      handlers.set(event, list)
      return wc
    },
    postMessage(channel, _message, transfer): void {
      const transferred = (transfer ?? []) as FakePort[]
      for (const port of transferred) port.transferred = true
      wc.transfers.push({ channel, ports: transferred })
    },
    emit(event, ...args): void {
      for (const handler of [...(handlers.get(event) ?? [])]) {
        ;(handler as unknown as (...a: unknown[]) => void)(...args)
      }
    },
    destroy(): void {
      wc.emit('destroyed')
      wc.destroyed = true
    },
  }
  return wc
}

function asWebContents(wc: FakeWebContents): WebContents {
  return wc as unknown as WebContents
}

/** Listeners still resting on a webContents that is alive — the leak surface. */
function liveListenerCount(wcs: FakeWebContents[]): number {
  return wcs
    .filter((wc) => !wc.destroyed)
    .reduce((total, wc) => total + wc.listenerCount(), 0)
}

function makeHarness() {
  const wcs: FakeWebContents[] = []
  const attachments: HostSlotAttachment[] = []
  let current: FakeWebContents | null = null
  const channel = createHostSlotPortChannel({
    isCurrent: (wc) => current !== null && (wc as unknown as FakeWebContents) === current,
    channel: 'test-host-slot-port',
    logPrefix: '[test-host-slot]',
  })
  /** Mirrors the owner: create the wc, make it current, attach immediately. */
  function createWc(): FakeWebContents {
    const wc = fakeWebContents()
    wcs.push(wc)
    current = wc
    attachments.push(channel.attach(asWebContents(wc)))
    return wc
  }
  return { channel, wcs, createWc, attachments }
}

/** Electron >= 12 details object; the positional args carry the same verdict. */
function emitNavigation(
  wc: FakeWebContents,
  nav: { isSameDocument: boolean; isMainFrame: boolean },
): void {
  wc.emit(
    'did-start-navigation',
    { isSameDocument: nav.isSameDocument, isMainFrame: nav.isMainFrame },
    'https://slot.example/next',
    nav.isSameDocument,
    nav.isMainFrame,
  )
}

beforeEach(() => {
  ports.length = 0
})

describe('host-slot port channel: main-side resources return to baseline', () => {
  it('create → reload → rebuild → dispose leaves no listener on a live webContents and no main-held port open', () => {
    const h = makeHarness()
    const baselineLiveListeners = liveListenerCount(h.wcs)
    const baselineOpenPorts = openMainHeldPorts().length
    expect(baselineLiveListeners).toBe(0)
    expect(baselineOpenPorts).toBe(0)

    const first = h.createWc()
    first.emit('did-finish-load')
    // Reload: same wc, next load generation.
    first.emit('did-finish-load')
    expect(first.listenerCount()).toBeGreaterThan(0)
    expect(openMainHeldPorts()).toHaveLength(1)

    // Rebuild: the owner swaps in a fresh wc and destroys the old one.
    const second = h.createWc()
    first.destroy()
    second.emit('did-finish-load')
    expect(second.listenerCount()).toBeGreaterThan(0)
    expect(liveListenerCount(h.wcs)).toBe(second.listenerCount())

    // Teardown: dispose the channel, then destroy the wc the owner attached.
    h.channel.dispose()
    second.destroy()

    expect(mainHeldPorts()).toHaveLength(3)
    expect(openMainHeldPorts()).toHaveLength(baselineOpenPorts)
    expect(unaccountedPorts()).toHaveLength(0)
    expect(liveListenerCount(h.wcs)).toBe(baselineLiveListeners)
  })

  it('every port pair is either closed on the main side or transferred to the document it was minted for', () => {
    const h = makeHarness()
    const wc = h.createWc()
    wc.emit('did-finish-load')
    wc.emit('did-finish-load')
    h.channel.dispose()
    wc.destroy()

    expect(ports).toHaveLength(4)
    expect(mainHeldPorts().every((port) => port.closed && port.started)).toBe(true)
    expect(wc.transfers.map((t) => t.ports.length)).toEqual([1, 1])
    expect(unaccountedPorts()).toHaveLength(0)
  })
})

describe('host-slot port channel: an attachment releases the webContents it was made for', () => {
  it('releasing takes the listeners off a LIVE wc, closes its port, and ignores its later loads', () => {
    const h = makeHarness()
    const wc = h.createWc()
    wc.emit('did-finish-load')
    expect(openMainHeldPorts()).toHaveLength(1)
    expect(wc.listenerCount()).toBeGreaterThan(0)

    h.attachments[0]!.dispose()

    // The wc is still alive: this is the case shared ownership cannot cover.
    // Nothing destroys it here, so only an explicit release can get the
    // listeners off it — which is what lets an owner hand a wc back without
    // also being the thing that closes it.
    expect(wc.destroyed).toBe(false)
    expect(liveListenerCount([wc])).toBe(0)
    expect(openMainHeldPorts()).toHaveLength(0)
    expect(h.channel.send('c', 1)).toBe(false)

    const portsBefore = ports.length
    wc.emit('did-finish-load')
    expect(ports).toHaveLength(portsBefore)
  })

  it('releasing a superseded attachment leaves the current document delivering, and repeats are no-ops', () => {
    const h = makeHarness()
    const first = h.createWc()
    first.emit('did-finish-load')
    const second = h.createWc()
    second.emit('did-finish-load')
    expect(h.channel.send('c', 1)).toBe(true)

    h.attachments[0]!.dispose()
    h.attachments[0]!.dispose()

    expect(liveListenerCount([first])).toBe(0)
    expect(second.listenerCount()).toBeGreaterThan(0)
    expect(openMainHeldPorts()).toHaveLength(1)
    expect(h.channel.send('c', 2)).toBe(true)
  })
})

describe('host-slot port channel: a superseded webContents cannot take the channel back', () => {
  it('a stale wc late did-finish-load mints no port and leaves the current document delivering', () => {
    const h = makeHarness()
    const ready = vi.fn()
    h.channel.onReady(ready)
    const first = h.createWc()
    first.emit('did-finish-load')
    const second = h.createWc()
    second.emit('did-finish-load')
    const livePort = mainHeldPorts()[1]!
    const portCountBefore = ports.length

    first.emit('did-finish-load')

    expect(ports).toHaveLength(portCountBefore)
    expect(first.transfers).toHaveLength(1)
    expect(ready).toHaveBeenCalledTimes(2)
    expect(livePort.closed).toBe(false)
    expect(h.channel.send('after-stale-load', 7)).toBe(true)
    expect(livePort.posted).toEqual([{ channel: 'after-stale-load', payload: 7 }])
  })
})

describe('host-slot port channel: navigation invalidates only when the document is replaced', () => {
  it('a main-frame cross-document navigation closes the port and send reports false', () => {
    const h = makeHarness()
    const wc = h.createWc()
    wc.emit('did-finish-load')
    const port = mainHeldPorts()[0]!

    emitNavigation(wc, { isSameDocument: false, isMainFrame: true })

    expect(port.closed).toBe(true)
    expect(h.channel.send('gone', 1)).toBe(false)
    expect(port.posted).toHaveLength(0)
  })

  it('a same-document navigation keeps the port: the document the port belongs to survives', () => {
    const h = makeHarness()
    const wc = h.createWc()
    wc.emit('did-finish-load')
    const port = mainHeldPorts()[0]!

    emitNavigation(wc, { isSameDocument: true, isMainFrame: true })

    expect(port.closed).toBe(false)
    expect(h.channel.send('still-here', 2)).toBe(true)
    expect(port.posted).toEqual([{ channel: 'still-here', payload: 2 }])
  })

  it('a subframe navigation keeps the port: only the main frame carries the document', () => {
    const h = makeHarness()
    const wc = h.createWc()
    wc.emit('did-finish-load')
    const port = mainHeldPorts()[0]!

    emitNavigation(wc, { isSameDocument: false, isMainFrame: false })

    expect(port.closed).toBe(false)
    expect(h.channel.send('still-here', 3)).toBe(true)
    expect(port.posted).toEqual([{ channel: 'still-here', payload: 3 }])
  })
})

describe('host-slot port channel: a replacement document gets its own readiness and port', () => {
  it('destroying the slot wc mutes send, and the next document re-fires onReady and receives alone', () => {
    const h = makeHarness()
    const ready = vi.fn()
    h.channel.onReady(ready)

    const first = h.createWc()
    first.emit('did-finish-load')
    const firstPort = mainHeldPorts()[0]!
    expect(h.channel.send('to-first', 1)).toBe(true)

    first.destroy()
    expect(firstPort.closed).toBe(true)
    expect(h.channel.send('into-the-void', 2)).toBe(false)

    const second = h.createWc()
    second.emit('did-finish-load')
    const secondPort = mainHeldPorts()[1]!

    expect(ready).toHaveBeenCalledTimes(2)
    expect(h.channel.send('to-second', 3)).toBe(true)
    expect(firstPort.posted).toEqual([{ channel: 'to-first', payload: 1 }])
    expect(secondPort.posted).toEqual([{ channel: 'to-second', payload: 3 }])
  })
})

describe('host-slot port channel: initial state is pushed once per load generation', () => {
  it('an onReady subscriber sending on every fire reaches each generation own port exactly once', () => {
    const h = makeHarness()
    let pushes = 0
    h.channel.onReady(() => {
      pushes += 1
      h.channel.send('initial-state', { generation: pushes })
    })

    const wc = h.createWc()
    wc.emit('did-finish-load')
    wc.emit('did-finish-load')

    const [firstPort, secondPort] = mainHeldPorts()
    expect(pushes).toBe(2)
    expect(firstPort?.posted).toEqual([{ channel: 'initial-state', payload: { generation: 1 } }])
    expect(secondPort?.posted).toEqual([{ channel: 'initial-state', payload: { generation: 2 } }])
  })
})
