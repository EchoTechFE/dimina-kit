// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createDeckLayoutClient } from './layout-client.js'
import type { PlacementSnapshot } from '../layout/placement-reconcile.js'

// ── Local mirrors ─────────────────────────────────────────────────────────────
// Placement mirrors view-anchor's type (view-anchor is not a dep of electron-deck).

interface Bounds { x: number; y: number; width: number; height: number }
type Placement = { visible: true; bounds: Bounds } | { visible: false }
type Extra = { slotToken: string }
type LayoutSnapshot = PlacementSnapshot<Extra>

// SlotGrant now carries a `generation` field used to track renderer lifetimes.
interface SlotGrant {
  viewId: string
  slotId: string
  slotToken: string
  generation: number
}

interface AnchorOpts {
  visible: boolean
  publish: (p: Placement) => void
  followScroll?: boolean
  followGeometry?: boolean
  guardDisplayNone?: boolean
}

interface CapturedAnchor {
  target: HTMLElement
  opts: AnchorOpts
  dispose: ReturnType<typeof vi.fn>
}

// ── FakeRaf ───────────────────────────────────────────────────────────────────
// Deterministic rAF substitute — drives frame delivery without real timers.

class FakeRaf {
  private cbs = new Map<number, () => void>()
  private nextId = 1
  request = vi.fn((cb: () => void): number => {
    const id = this.nextId++
    this.cbs.set(id, cb)
    return id
  })
  cancel = vi.fn((id: number): void => { this.cbs.delete(id) })
  flushFrame(): void {
    const pending = [...this.cbs.entries()]
    this.cbs.clear()
    for (const [, cb] of pending) cb()
  }
  get pending(): number { return this.cbs.size }
}

// ── Fake bridge ───────────────────────────────────────────────────────────────

function makeBridge() {
  const order: string[] = []
  let grantCb: ((g: SlotGrant) => void) | null = null
  const unsubscribe = vi.fn()
  const snapshots: LayoutSnapshot[] = []
  const sendSnapshot = vi.fn((snap: LayoutSnapshot): void => { snapshots.push(snap) })

  const bridge = {
    onSlotGrant: vi.fn((cb: (g: SlotGrant) => void) => {
      order.push('onSlotGrant')
      grantCb = cb
      return unsubscribe
    }),
    sendSnapshot,
    subscribe: vi.fn((): void => { order.push('subscribe') }),
  }

  return {
    bridge,
    sendSnapshot,
    unsubscribe,
    order,
    snapshots,
    emitGrant(g: SlotGrant): void {
      if (!grantCb) throw new Error('no slot-grant subscriber registered')
      grantCb(g)
    },
    hasSubscriber(): boolean { return grantCb !== null },
  }
}

// ── Fake createAnchor ─────────────────────────────────────────────────────────

function makeAnchorFactory() {
  const anchors: CapturedAnchor[] = []
  const createAnchor = vi.fn(
    (target: HTMLElement, opts: AnchorOpts): { dispose(): void } => {
      const dispose = vi.fn()
      anchors.push({ target, opts, dispose })
      return { dispose }
    },
  )
  return { createAnchor, anchors }
}

function placement(x: number): Placement {
  return { visible: true, bounds: { x, y: x, width: 10, height: 10 } }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createDeckLayoutClient — handshake, anchor opts, snapshot sink, generation', () => {
  it('registers the slot-grant listener BEFORE calling subscribe() so a replayed grant cannot be missed', () => {
    const raf = new FakeRaf()
    const b = makeBridge()
    const a = makeAnchorFactory()
    createDeckLayoutClient({
      bridge: b.bridge,
      createAnchor: a.createAnchor,
      requestFrame: raf.request,
      cancelFrame: raf.cancel,
    })
    expect(b.bridge.onSlotGrant).toHaveBeenCalledTimes(1)
    expect(b.bridge.subscribe).toHaveBeenCalledTimes(1)
    const grantIdx = b.order.indexOf('onSlotGrant')
    const subIdx = b.order.indexOf('subscribe')
    expect(grantIdx).toBeGreaterThanOrEqual(0)
    expect(subIdx).toBeGreaterThanOrEqual(0)
    expect(grantIdx).toBeLessThan(subIdx)
  })

  it('a grant replayed synchronously inside subscribe() is still delivered (listener already attached)', () => {
    const raf = new FakeRaf()
    const a = makeAnchorFactory()
    const el = document.createElement('div')
    el.id = 'sim'
    document.body.appendChild(el)
    let grantCb: ((g: SlotGrant) => void) | null = null
    const bridge = {
      onSlotGrant: vi.fn((cb: (g: SlotGrant) => void) => { grantCb = cb; return vi.fn() }),
      sendSnapshot: vi.fn(),
      subscribe: vi.fn((): void => {
        grantCb?.({ viewId: 'v1', slotId: '#sim', slotToken: 'tok-1', generation: 1 })
      }),
    }
    createDeckLayoutClient({
      bridge,
      createAnchor: a.createAnchor,
      requestFrame: raf.request,
      cancelFrame: raf.cancel,
    })
    expect(a.anchors).toHaveLength(1)
    expect(a.anchors[0]?.target).toBe(el)
    document.body.removeChild(el)
  })

  it('on a grant, creates an anchor with followScroll/followGeometry/guardDisplayNone/visible all true', () => {
    const raf = new FakeRaf()
    const b = makeBridge()
    const a = makeAnchorFactory()
    const el = document.createElement('div')
    createDeckLayoutClient({
      bridge: b.bridge,
      createAnchor: a.createAnchor,
      resolveSlot: () => el,
      requestFrame: raf.request,
      cancelFrame: raf.cancel,
    })
    b.emitGrant({ viewId: 'v1', slotId: '#sim', slotToken: 'tok-1', generation: 1 })
    const created = a.anchors[0]
    expect(created?.opts.visible).toBe(true)
    expect(created?.opts.followScroll).toBe(true)
    expect(created?.opts.followGeometry).toBe(true)
    expect(created?.opts.guardDisplayNone).toBe(true)
  })

  it('a grant whose slotId resolves to no element creates no anchor and does not throw', () => {
    const raf = new FakeRaf()
    const b = makeBridge()
    const a = makeAnchorFactory()
    createDeckLayoutClient({
      bridge: b.bridge,
      createAnchor: a.createAnchor,
      requestFrame: raf.request,
      cancelFrame: raf.cancel,
    })
    expect(() =>
      b.emitGrant({ viewId: 'v1', slotId: '#nope', slotToken: 'tok-1', generation: 1 }),
    ).not.toThrow()
    expect(a.createAnchor).not.toHaveBeenCalled()
  })

  it('driving the anchor publish does NOT call sendSnapshot synchronously — flush is required', () => {
    const raf = new FakeRaf()
    const b = makeBridge()
    const a = makeAnchorFactory()
    const el = document.createElement('div')
    createDeckLayoutClient({
      bridge: b.bridge,
      createAnchor: a.createAnchor,
      resolveSlot: () => el,
      requestFrame: raf.request,
      cancelFrame: raf.cancel,
    })
    b.emitGrant({ viewId: 'v1', slotId: '#a', slotToken: 'tok-1', generation: 1 })
    a.anchors[0]?.opts.publish(placement(5))
    expect(b.sendSnapshot).not.toHaveBeenCalled()
  })

  it('after a frame flush, sendSnapshot is called once with the view carrying slotToken in extra', () => {
    const raf = new FakeRaf()
    const b = makeBridge()
    const a = makeAnchorFactory()
    const el = document.createElement('div')
    createDeckLayoutClient({
      bridge: b.bridge,
      createAnchor: a.createAnchor,
      resolveSlot: () => el,
      requestFrame: raf.request,
      cancelFrame: raf.cancel,
    })
    b.emitGrant({ viewId: 'v1', slotId: '#a', slotToken: 'tok-XYZ', generation: 1 })
    const p = placement(5)
    a.anchors[0]?.opts.publish(p)
    raf.flushFrame()

    expect(b.sendSnapshot).toHaveBeenCalledOnce()
    const snap = b.snapshots[0]!
    expect(snap.views).toHaveLength(1)
    expect(snap.views[0]!.viewId).toBe('v1')
    expect(snap.views[0]!.placement).toEqual(p)
    expect(snap.views[0]!.extra?.slotToken).toBe('tok-XYZ')
  })

  it('multiple anchors publishing in the same frame produce a single merged snapshot', () => {
    const raf = new FakeRaf()
    const b = makeBridge()
    const a = makeAnchorFactory()
    const sim = document.createElement('div')
    const dev = document.createElement('div')
    createDeckLayoutClient({
      bridge: b.bridge,
      createAnchor: a.createAnchor,
      resolveSlot: (id) => (id === '#sim' ? sim : dev),
      requestFrame: raf.request,
      cancelFrame: raf.cancel,
    })
    b.emitGrant({ viewId: 'v-sim', slotId: '#sim', slotToken: 'tok-sim', generation: 1 })
    b.emitGrant({ viewId: 'v-dev', slotId: '#devtools', slotToken: 'tok-dev', generation: 1 })
    a.anchors[0]?.opts.publish(placement(1))
    a.anchors[1]?.opts.publish(placement(2))
    raf.flushFrame()

    expect(b.sendSnapshot).toHaveBeenCalledOnce()
    const ids = b.snapshots[0]!.views.map((v) => v.viewId).sort()
    expect(ids).toEqual(['v-dev', 'v-sim'])
  })

  it('snapshot.generation equals the generation carried by the grant', () => {
    const raf = new FakeRaf()
    const b = makeBridge()
    const a = makeAnchorFactory()
    const el = document.createElement('div')
    createDeckLayoutClient({
      bridge: b.bridge,
      createAnchor: a.createAnchor,
      resolveSlot: () => el,
      requestFrame: raf.request,
      cancelFrame: raf.cancel,
    })
    b.emitGrant({ viewId: 'v1', slotId: '#a', slotToken: 'tok1', generation: 5 })
    a.anchors[0]?.opts.publish(placement(1))
    raf.flushFrame()

    expect(b.snapshots[0]!.generation).toBe(5)
  })

  it('a second grant with a higher generation causes the next snapshot to use the higher generation', () => {
    const raf = new FakeRaf()
    const b = makeBridge()
    const a = makeAnchorFactory()
    const el = document.createElement('div')
    createDeckLayoutClient({
      bridge: b.bridge,
      createAnchor: a.createAnchor,
      resolveSlot: () => el,
      requestFrame: raf.request,
      cancelFrame: raf.cancel,
    })
    b.emitGrant({ viewId: 'v1', slotId: '#a', slotToken: 'tok1', generation: 5 })
    a.anchors[0]?.opts.publish(placement(1))
    raf.flushFrame()
    expect(b.snapshots[0]!.generation).toBe(5)

    b.emitGrant({ viewId: 'v2', slotId: '#a', slotToken: 'tok2', generation: 7 })
    a.anchors[1]?.opts.publish(placement(2))
    raf.flushFrame()
    expect(b.snapshots[1]!.generation).toBe(7)
  })

  it('snapshot epoch is strictly monotonic across frames', () => {
    const raf = new FakeRaf()
    const b = makeBridge()
    const a = makeAnchorFactory()
    const el = document.createElement('div')
    createDeckLayoutClient({
      bridge: b.bridge,
      createAnchor: a.createAnchor,
      resolveSlot: () => el,
      requestFrame: raf.request,
      cancelFrame: raf.cancel,
    })
    b.emitGrant({ viewId: 'v1', slotId: '#a', slotToken: 'tok1', generation: 1 })
    a.anchors[0]?.opts.publish(placement(1))
    raf.flushFrame()
    a.anchors[0]?.opts.publish(placement(2))
    raf.flushFrame()

    expect(b.snapshots[1]!.epoch).toBeGreaterThan(b.snapshots[0]!.epoch)
  })

  it('revoking an anchor without replacement removes the viewId from subsequent snapshots', () => {
    const raf = new FakeRaf()
    const b = makeBridge()
    const a = makeAnchorFactory()
    const el = document.createElement('div')
    let resolves = true
    createDeckLayoutClient({
      bridge: b.bridge,
      createAnchor: a.createAnchor,
      resolveSlot: () => (resolves ? el : null),
      requestFrame: raf.request,
      cancelFrame: raf.cancel,
    })
    b.emitGrant({ viewId: 'v1', slotId: '#a', slotToken: 'tok-a', generation: 1 })
    b.emitGrant({ viewId: 'v2', slotId: '#b', slotToken: 'tok-b', generation: 1 })
    a.anchors[0]?.opts.publish(placement(1))
    a.anchors[1]?.opts.publish(placement(2))
    raf.flushFrame()
    expect(b.snapshots[0]!.views.map((v) => v.viewId).sort()).toEqual(['v1', 'v2'])

    // New token for v1 but slot doesn't resolve → revoke without replacement.
    resolves = false
    b.emitGrant({ viewId: 'v1', slotId: '#a', slotToken: 'tok-a-new', generation: 1 })
    a.anchors[1]?.opts.publish(placement(3))
    raf.flushFrame()

    const ids = b.snapshots[1]!.views.map((v) => v.viewId)
    expect(ids).not.toContain('v1')
    expect(ids).toContain('v2')
  })

  it('dispose() unsubscribes from the bridge and disposes every live anchor', () => {
    const raf = new FakeRaf()
    const b = makeBridge()
    const a = makeAnchorFactory()
    const elements = [document.createElement('div'), document.createElement('div')]
    let i = 0
    const client = createDeckLayoutClient({
      bridge: b.bridge,
      createAnchor: a.createAnchor,
      resolveSlot: () => elements[i++] ?? elements[0]!,
      requestFrame: raf.request,
      cancelFrame: raf.cancel,
    })
    b.emitGrant({ viewId: 'v1', slotId: '#a', slotToken: 'tok-a', generation: 1 })
    b.emitGrant({ viewId: 'v2', slotId: '#b', slotToken: 'tok-b', generation: 1 })
    expect(a.anchors).toHaveLength(2)

    client.dispose()
    expect(b.unsubscribe).toHaveBeenCalledTimes(1)
    expect(a.anchors[0]?.dispose).toHaveBeenCalledTimes(1)
    expect(a.anchors[1]?.dispose).toHaveBeenCalledTimes(1)
  })

  it('a grant arriving after dispose() creates no anchor and does not schedule a snapshot', () => {
    const raf = new FakeRaf()
    const b = makeBridge()
    const a = makeAnchorFactory()
    const el = document.createElement('div')
    const client = createDeckLayoutClient({
      bridge: b.bridge,
      createAnchor: a.createAnchor,
      resolveSlot: () => el,
      requestFrame: raf.request,
      cancelFrame: raf.cancel,
    })
    client.dispose()
    if (b.hasSubscriber()) {
      b.emitGrant({ viewId: 'v1', slotId: '#a', slotToken: 'tok-a', generation: 1 })
    }
    raf.flushFrame()
    expect(a.createAnchor).not.toHaveBeenCalled()
    expect(b.sendSnapshot).not.toHaveBeenCalled()
  })
})
