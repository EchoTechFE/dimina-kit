/**
 * Behavior tests for createCdpSessionBroker — the shared `wc.debugger` (CDP)
 * session broker described in index.ts's design doc. It replaces the four
 * near-identical attach/detach bookkeepers that network-forward, safe-area,
 * render-inspect and elements-forward each hand-roll today, and fixes two
 * live bugs those four independent bookkeepers cause:
 *
 *  1. network-forward's `attachRenderGuest` is only ever called ONCE per
 *     guest (at webview creation). If another module later detaches the
 *     shared debugger session it happened to attach, network-forward's
 *     capture dies permanently — nothing re-attaches it. A broker that
 *     re-attaches on the NEXT `acquire()` call closes this gap structurally.
 *  2. On the simulator wc, two independent modules each do "detach if
 *     attached" with no notion of the other — whichever runs last steals the
 *     other's session. A single owner (the broker) that tracks "did I attach
 *     this" and only detaches its own sessions removes the possibility.
 *
 * Fakes mirror the wc.debugger mocking conventions already used by
 * network-forward/index.test.ts and safe-area/index.test.ts: a plain object
 * exposing `attach`/`detach`/`isAttached`/`sendCommand`/`on`/`removeListener`
 * on `wc.debugger`, and `once`/`removeListener` for the wc's own `destroyed`
 * event. Crucially, our fake `debugger.detach()` SYNCHRONOUSLY fires its own
 * `'detach'` listeners exactly like real Electron does — so a test that
 * simulates "some other code detached this session" by calling
 * `wc.debugger.detach()` directly exercises the exact same code path the
 * broker's own internal detach (in `dispose()`) runs through. That is what
 * forces the broker to actually distinguish "I did this" from "someone else
 * did this" instead of passing the self-vs-external test by accident.
 */
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { createCdpSessionBroker } from './index.js'

type AnyFn = (...args: unknown[]) => unknown

let nextId = 1000

/**
 * Minimal fake WebContents + `wc.debugger` exposing exactly the surface the
 * broker touches. `dbg.on`/`dbg.removeListener` are `vi.fn` wrappers (not
 * just plain closures) so tests can assert HOW MANY real listeners got
 * registered per event — the crux of the fan-out assertions below.
 */
function makeFakeWc(opts: { initiallyAttached?: boolean } = {}) {
  const id = nextId++
  let attached = opts.initiallyAttached ?? false
  let destroyed = false
  const dbgListeners = new Map<string, Set<AnyFn>>()
  const wcListeners = new Map<string, Set<AnyFn>>()

  const add = (map: Map<string, Set<AnyFn>>, ev: string, fn: AnyFn): void => {
    (map.get(ev) ?? map.set(ev, new Set()).get(ev)!).add(fn)
  }
  const remove = (map: Map<string, Set<AnyFn>>, ev: string, fn: AnyFn): void => {
    map.get(ev)?.delete(fn)
  }
  const fire = (map: Map<string, Set<AnyFn>>, ev: string, ...args: unknown[]): void => {
    for (const fn of [...(map.get(ev) ?? [])]) fn(...args)
  }

  const sendCommand = vi.fn((_method: string, _params?: object) => Promise.resolve({}) as Promise<unknown>)

  const dbg = {
    isAttached: () => attached,
    attach: vi.fn(() => { attached = true }),
    // Mirrors real Electron: detach() itself fires 'detach', whether the
    // CALLER is the broker's own dispose() or something else entirely.
    detach: vi.fn(() => {
      if (!attached) return
      attached = false
      fire(dbgListeners, 'detach')
    }),
    sendCommand,
    on: vi.fn((ev: string, fn: AnyFn) => add(dbgListeners, ev, fn)),
    removeListener: vi.fn((ev: string, fn: AnyFn) => remove(dbgListeners, ev, fn)),
  }

  const wc = {
    id,
    isDestroyed: () => destroyed,
    debugger: dbg,
    once: (ev: string, fn: AnyFn) => add(wcListeners, ev, fn),
    removeListener: (ev: string, fn: AnyFn) => remove(wcListeners, ev, fn),
  } as unknown as WebContents

  return {
    wc,
    dbg,
    sendCommand,
    emitMessage: (method: string, params: unknown) => fire(dbgListeners, 'message', {}, method, params),
    /** Hard-destroy: mirrors Electron firing the wc's own 'destroyed' event. */
    destroy: () => { destroyed = true; fire(wcListeners, 'destroyed') },
  }
}

/** Count how many times `dbg.on`/`removeListener` registered/removed a given event. */
function eventCallCount(spy: ReturnType<typeof vi.fn>, ev: string): number {
  return spy.mock.calls.filter((c) => c[0] === ev).length
}

describe('createCdpSessionBroker — acquire/send basics', () => {
  it('attaches when nobody has, and lease.send() forwards to debugger.sendCommand', async () => {
    const g = makeFakeWc()
    const broker = createCdpSessionBroker()
    const lease = broker.acquire(g.wc)

    expect(lease).not.toBeNull()
    expect(g.dbg.attach).toHaveBeenCalledWith('1.3')

    g.sendCommand.mockResolvedValueOnce({ ok: true })
    await expect(lease!.send('Runtime.evaluate', { expression: '1' })).resolves.toEqual({ ok: true })
    expect(g.sendCommand).toHaveBeenCalledWith('Runtime.evaluate', { expression: '1' })
  })

  it('reuses an already-attached session (never re-attaches an owned debugger)', () => {
    const g = makeFakeWc({ initiallyAttached: true })
    const broker = createCdpSessionBroker()

    const lease = broker.acquire(g.wc)

    expect(lease).not.toBeNull()
    expect(g.dbg.attach).not.toHaveBeenCalled()
  })

  it('returns null when attach() throws (session exclusively held elsewhere), without affecting other wcs', () => {
    const bad = makeFakeWc()
    bad.dbg.attach.mockImplementation(() => { throw new Error('exclusively owned by a real Chrome DevTools window') })
    const good = makeFakeWc()
    const broker = createCdpSessionBroker()

    expect(broker.acquire(bad.wc)).toBeNull()

    const goodLease = broker.acquire(good.wc)
    expect(goodLease).not.toBeNull()
    expect(good.dbg.attach).toHaveBeenCalledWith('1.3')
  })
})

describe('createCdpSessionBroker — shared session fan-out', () => {
  it('fans out ONE real message listener to every lease acquired for the same wc', () => {
    const g = makeFakeWc()
    const broker = createCdpSessionBroker()
    const lease1 = broker.acquire(g.wc)!
    const lease2 = broker.acquire(g.wc)!
    const seen1: Array<[string, unknown]> = []
    const seen2: Array<[string, unknown]> = []
    lease1.onMessage((m, p) => seen1.push([m, p]))
    lease2.onMessage((m, p) => seen2.push([m, p]))

    g.emitMessage('Network.requestWillBeSent', { requestId: '1' })

    expect(seen1).toEqual([['Network.requestWillBeSent', { requestId: '1' }]])
    expect(seen2).toEqual([['Network.requestWillBeSent', { requestId: '1' }]])
    // The crux: only ONE real 'message' listener was ever registered on the
    // underlying debugger, no matter how many leases subscribed.
    expect(eventCallCount(g.dbg.on, 'message')).toBe(1)
  })

  it("lease.dispose() cancels only that lease's own subscriptions and never detaches the shared session", () => {
    const g = makeFakeWc()
    const broker = createCdpSessionBroker()
    const lease1 = broker.acquire(g.wc)!
    const lease2 = broker.acquire(g.wc)!
    const seen1: string[] = []
    const seen2: string[] = []
    lease1.onMessage((m) => seen1.push(m))
    lease2.onMessage((m) => seen2.push(m))

    g.emitMessage('A', {})
    lease1.dispose()
    g.emitMessage('B', {})

    expect(seen1).toEqual(['A'])
    expect(seen2).toEqual(['A', 'B'])
    expect(g.dbg.detach).not.toHaveBeenCalled()
  })
})

describe('createCdpSessionBroker — dispose() ownership (fixes the simulator dual-detach bug)', () => {
  it('detaches only the sessions it attached itself; leaves externally-owned sessions untouched', () => {
    const selfAttached = makeFakeWc() // not attached yet -> broker attaches it
    const externallyOwned = makeFakeWc({ initiallyAttached: true }) // some other owner already attached it
    const broker = createCdpSessionBroker()

    broker.acquire(selfAttached.wc)
    broker.acquire(externallyOwned.wc)

    broker.dispose()

    expect(selfAttached.dbg.detach).toHaveBeenCalledTimes(1)
    expect(externallyOwned.dbg.detach).not.toHaveBeenCalled()
  })
})

describe('createCdpSessionBroker — external detach recovery (fixes network-forward permanent-death bug)', () => {
  it('notifies lease.onDetach and clears state so the NEXT acquire() re-attaches from scratch', () => {
    const g = makeFakeWc()
    const broker = createCdpSessionBroker()
    const lease = broker.acquire(g.wc)!
    const onDetachCb = vi.fn()
    lease.onDetach(onDetachCb)

    // Something OTHER than the broker (another feature releasing it, or a
    // real Chrome DevTools window) detaches the shared session.
    g.dbg.detach()

    expect(onDetachCb).toHaveBeenCalledTimes(1)
    expect(g.dbg.isAttached()).toBe(false)

    g.dbg.attach.mockClear()
    const lease2 = broker.acquire(g.wc)
    // Must NOT be permanently blocked by a stale "already handled this wc"
    // guard — this is exactly the bug network-forward's attachRenderGuest has
    // today (guestWired.has(wc.id) never clears on external detach).
    expect(lease2).not.toBeNull()
    expect(g.dbg.attach).toHaveBeenCalledWith('1.3')
  })

  it("broker.dispose()'s OWN detach does not fire onDetach (only an unexpected external detach does)", () => {
    const g = makeFakeWc()
    const broker = createCdpSessionBroker()
    const lease = broker.acquire(g.wc)!
    const onDetachCb = vi.fn()
    lease.onDetach(onDetachCb)

    broker.dispose()

    // Proves the fake's detach() really ran (and would have fired 'detach' to
    // any listener) — so onDetach's silence below is the broker actively
    // suppressing its own detach, not an artifact of the fake never firing.
    expect(g.dbg.detach).toHaveBeenCalledTimes(1)
    expect(onDetachCb).not.toHaveBeenCalled()
  })
})

describe('createCdpSessionBroker — ensureRenderDomains()', () => {
  it('enables DOM before Overlay, and two concurrent leases on the same wc share one in-flight enable', async () => {
    const g = makeFakeWc()
    const order: string[] = []
    let resolveDomEnable!: () => void
    const domEnable = new Promise<void>((res) => { resolveDomEnable = res })
    g.sendCommand.mockImplementation((method: string) => {
      order.push(method)
      if (method === 'DOM.enable') return domEnable.then(() => ({}))
      return Promise.resolve({})
    })
    const broker = createCdpSessionBroker()
    const lease1 = broker.acquire(g.wc)!
    const lease2 = broker.acquire(g.wc)!

    const p1 = lease1.ensureRenderDomains()
    const p2 = lease2.ensureRenderDomains()
    await Promise.resolve()
    await Promise.resolve()

    // Overlay.enable must be gated on DOM.enable's resolution, not fired eagerly.
    expect(order.includes('Overlay.enable')).toBe(false)

    resolveDomEnable()
    await p1
    await p2

    expect(order.filter((m) => m === 'DOM.enable').length).toBe(1)
    expect(order.filter((m) => m === 'Overlay.enable').length).toBe(1)
    expect(order.indexOf('DOM.enable')).toBeLessThan(order.indexOf('Overlay.enable'))
  })

  it('re-runs (does not reuse a stale memo) after the session has been detached', async () => {
    const g = makeFakeWc()
    const broker = createCdpSessionBroker()
    const lease1 = broker.acquire(g.wc)!
    await lease1.ensureRenderDomains()

    expect(g.sendCommand.mock.calls.filter((c) => c[0] === 'DOM.enable').length).toBe(1)
    expect(g.sendCommand.mock.calls.filter((c) => c[0] === 'Overlay.enable').length).toBe(1)

    // External detach invalidates whatever this wc's session had memoized.
    g.dbg.detach()

    const lease2 = broker.acquire(g.wc)!
    await lease2.ensureRenderDomains()

    expect(g.sendCommand.mock.calls.filter((c) => c[0] === 'DOM.enable').length).toBe(2)
    expect(g.sendCommand.mock.calls.filter((c) => c[0] === 'Overlay.enable').length).toBe(2)
  })
})

describe('createCdpSessionBroker — wc destroyed cleanup', () => {
  it('frees broker bookkeeping on destroy: acquire() on the (now-destroyed) wc afterward returns null, never throws', () => {
    const g = makeFakeWc()
    const broker = createCdpSessionBroker()
    const lease = broker.acquire(g.wc)
    expect(lease).not.toBeNull()

    g.destroy()

    expect(() => broker.acquire(g.wc)).not.toThrow()
    expect(broker.acquire(g.wc)).toBeNull()
    expect(() => broker.dispose()).not.toThrow()
  })

  it('does NOT call debugger.detach() on wc destroy, even for a self-attached session (nothing left to usefully detach)', () => {
    const g = makeFakeWc() // not attached yet -> broker self-attaches
    const broker = createCdpSessionBroker()
    broker.acquire(g.wc)
    expect(g.dbg.isAttached()).toBe(true)

    g.destroy()

    expect(g.dbg.detach).not.toHaveBeenCalled()
  })

  it('also notifies lease.onDetach on wc destroy (a consumer only needs ONE signal to drop its cached lease)', () => {
    const g = makeFakeWc()
    const broker = createCdpSessionBroker()
    const lease = broker.acquire(g.wc)!
    const onDetachCb = vi.fn()
    lease.onDetach(onDetachCb)

    g.destroy()

    expect(onDetachCb).toHaveBeenCalledTimes(1)
  })
})
