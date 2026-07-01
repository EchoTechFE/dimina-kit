// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createDeckLayoutClient } from './layout-client.js'
import type { PlacementSnapshot } from '../layout/placement-reconcile.js'

// ── Local mirrors ─────────────────────────────────────────────────────────────

interface Bounds { x: number; y: number; width: number; height: number }
type Placement = { visible: true; bounds: Bounds } | { visible: false }
type Extra = { slotToken: string }
type LayoutSnapshot = PlacementSnapshot<Extra>

// SlotGrant now carries generation for renderer-lifetime tracking.
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
}

// ── Fake bridge ───────────────────────────────────────────────────────────────

function makeBridge() {
  let grantCb: ((g: SlotGrant) => void) | null = null
  const unsubscribe = vi.fn()
  const snapshots: LayoutSnapshot[] = []
  const sendSnapshot = vi.fn((snap: LayoutSnapshot): void => { snapshots.push(snap) })

  const bridge = {
    onSlotGrant: vi.fn((cb: (g: SlotGrant) => void) => {
      grantCb = cb
      return unsubscribe
    }),
    sendSnapshot,
    subscribe: vi.fn((): void => {}),
  }

  return {
    bridge,
    sendSnapshot,
    unsubscribe,
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

// ── Dedup tests ───────────────────────────────────────────────────────────────

describe('createDeckLayoutClient — dedup renderer grants by viewId', () => {
  // ── same-token replay = no-op ─────────────────────────────────────────────

  it('a re-delivered grant with the same viewId+token does NOT create a second anchor and does NOT dispose the first', () => {
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
    const grant: SlotGrant = { viewId: 'v1', slotId: '#a', slotToken: 'tok1', generation: 1 }
    b.emitGrant(grant)
    // Replay the identical grant (per-wc replay from main).
    b.emitGrant({ ...grant })

    expect(a.createAnchor).toHaveBeenCalledTimes(1)
    expect(a.anchors).toHaveLength(1)
    expect(a.anchors[0]?.dispose).not.toHaveBeenCalled()
  })

  it('after a same-token replay, the surviving anchor still appears in the snapshot with the original token', () => {
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
    b.emitGrant({ viewId: 'v1', slotId: '#a', slotToken: 'tok1', generation: 1 })
    a.anchors[0]?.opts.publish(placement(7))
    raf.flushFrame()

    expect(b.snapshots).toHaveLength(1)
    const snap = b.snapshots[0]!
    expect(snap.views).toHaveLength(1)
    expect(snap.views[0]!.viewId).toBe('v1')
    expect(snap.views[0]!.extra?.slotToken).toBe('tok1')
  })

  // ── new-token replacement ─────────────────────────────────────────────────

  it('a grant with a NEW token for an existing viewId disposes the old anchor and creates a replacement', () => {
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
    b.emitGrant({ viewId: 'v1', slotId: '#a', slotToken: 'tok2', generation: 1 })

    expect(a.createAnchor).toHaveBeenCalledTimes(2)
    expect(a.anchors).toHaveLength(2)
    expect(a.anchors[0]?.dispose).toHaveBeenCalledTimes(1)
    expect(a.anchors[1]?.dispose).not.toHaveBeenCalled()
  })

  it('after a new-token replacement, the snapshot carries the new token in extra.slotToken (stale token never appears)', () => {
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
    b.emitGrant({ viewId: 'v1', slotId: '#a', slotToken: 'tok2', generation: 1 })
    a.anchors[1]?.opts.publish(placement(3))
    raf.flushFrame()

    expect(b.snapshots[0]!.views[0]!.extra?.slotToken).toBe('tok2')
    // The stale token must never appear on the wire.
    for (const snap of b.snapshots) {
      for (const v of snap.views) {
        expect(v.extra?.slotToken).not.toBe('tok1')
      }
    }
  })

  // ── distinct viewIds are independent ─────────────────────────────────────

  it('grants for different viewIds create independent anchors with no dedup between them', () => {
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

    expect(a.createAnchor).toHaveBeenCalledTimes(2)
    expect(a.anchors[0]?.dispose).not.toHaveBeenCalled()
    expect(a.anchors[1]?.dispose).not.toHaveBeenCalled()

    a.anchors[0]?.opts.publish(placement(1))
    a.anchors[1]?.opts.publish(placement(2))
    raf.flushFrame()

    const snap = b.snapshots[0]!
    const simView = snap.views.find((v) => v.viewId === 'v-sim')
    const devView = snap.views.find((v) => v.viewId === 'v-dev')
    expect(simView?.extra?.slotToken).toBe('tok-sim')
    expect(devView?.extra?.slotToken).toBe('tok-dev')
  })

  // ── dispose() cleans all live anchors exactly once ────────────────────────

  it('dispose() disposes every live anchor once and does NOT double-dispose a replaced anchor', () => {
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
    // v1 gets replaced (tok1→tok2); v2 stays live.
    b.emitGrant({ viewId: 'v1', slotId: '#a', slotToken: 'tok1', generation: 1 })
    b.emitGrant({ viewId: 'v1', slotId: '#a', slotToken: 'tok2', generation: 1 })
    b.emitGrant({ viewId: 'v2', slotId: '#b', slotToken: 'tok-b', generation: 1 })

    expect(a.createAnchor).toHaveBeenCalledTimes(3)
    // Replaced anchor already disposed exactly once at replacement time.
    expect(a.anchors[0]?.dispose).toHaveBeenCalledTimes(1)

    client.dispose()

    expect(b.unsubscribe).toHaveBeenCalledTimes(1)
    // The two live anchors disposed exactly once each.
    expect(a.anchors[1]?.dispose).toHaveBeenCalledTimes(1)
    expect(a.anchors[2]?.dispose).toHaveBeenCalledTimes(1)
    // The already-replaced anchor is NOT disposed a second time.
    expect(a.anchors[0]?.dispose).toHaveBeenCalledTimes(1)
  })

  // ── unresolved slot does not poison per-viewId tracking ───────────────────

  it('a grant whose slot does not resolve creates no anchor and does not poison the viewId; a later resolving grant for the same viewId anchors normally', () => {
    const raf = new FakeRaf()
    const b = makeBridge()
    const a = makeAnchorFactory()
    const el = document.createElement('div')
    let mounted = false
    createDeckLayoutClient({
      bridge: b.bridge,
      createAnchor: a.createAnchor,
      resolveSlot: () => (mounted ? el : null),
      requestFrame: raf.request,
      cancelFrame: raf.cancel,
    })
    // First grant: slot not mounted → no anchor.
    expect(() =>
      b.emitGrant({ viewId: 'v1', slotId: '#a', slotToken: 'tok1', generation: 1 }),
    ).not.toThrow()
    expect(a.createAnchor).not.toHaveBeenCalled()

    // Slot mounts; a later grant must create the anchor normally.
    mounted = true
    b.emitGrant({ viewId: 'v1', slotId: '#a', slotToken: 'tok2', generation: 1 })
    expect(a.createAnchor).toHaveBeenCalledTimes(1)
    expect(a.anchors[0]?.target).toBe(el)

    a.anchors[0]?.opts.publish(placement(4))
    raf.flushFrame()
    expect(b.snapshots[0]!.views[0]!.extra?.slotToken).toBe('tok2')
  })

  // ── new-token + unresolved slot disposes old anchor + removes viewId ──────

  it('a new-token grant with unresolved slot disposes the old anchor and removes the viewId from subsequent snapshots', () => {
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
    b.emitGrant({ viewId: 'v1', slotId: '#a', slotToken: 'tok1', generation: 1 })
    expect(a.createAnchor).toHaveBeenCalledTimes(1)
    const oldAnchor = a.anchors[0]!

    // The anchor measures once (a real view-anchor measures on creation), so v1
    // enters the published table — main learns about it.
    oldAnchor.opts.publish(placement(1))
    raf.flushFrame()
    expect(b.snapshots.at(-1)!.views.map((v) => v.viewId)).toContain('v1')

    // New token arrives but the (new) slot doesn't resolve.
    resolves = false
    b.emitGrant({ viewId: 'v1', slotId: '#a', slotToken: 'tok2', generation: 1 })
    // Old anchor is revoked immediately, no replacement created.
    expect(oldAnchor.dispose).toHaveBeenCalledTimes(1)
    expect(a.createAnchor).toHaveBeenCalledTimes(1)

    // The revoke called publisher.remove(v1); the next flush publishes a snapshot
    // that no longer contains v1 (main is told to detach it).
    raf.flushFrame()
    const lastSnap = b.snapshots.at(-1)!
    expect(lastSnap.views.map((v) => v.viewId)).not.toContain('v1')

    // Once the slot resolves again, a subsequent grant anchors with the new token.
    resolves = true
    b.emitGrant({ viewId: 'v1', slotId: '#a', slotToken: 'tok3', generation: 1 })
    expect(a.createAnchor).toHaveBeenCalledTimes(2)
    a.anchors[1]?.opts.publish(placement(7))
    raf.flushFrame()
    expect(b.snapshots.at(-1)!.views[0]!.extra?.slotToken).toBe('tok3')
  })
})
