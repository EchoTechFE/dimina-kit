// @vitest-environment jsdom
/**
 * Contract tests for DEDUP of renderer grants in `createDeckLayoutClient`.
 *
 * BACKGROUND: the client must not append a NEW anchor on EVERY
 * `slot-grant`, with NO dedup by `viewId`. But the main process INTENTIONALLY
 * re-delivers a slot-grant on `layout-subscribe` replay (per-wc replay). So when
 * a grant for an already-anchored `viewId` is re-delivered, the client today
 * creates a SECOND anchor for the SAME view — both anchors keep publishing, and
 * the older one may carry a stale/revoked `slotToken`.
 *
 * FIX (the behavior these tests pin): the client tracks ONE live anchor per
 * `viewId`:
 *   - a re-delivered grant with the SAME token is a NO-OP (keep the existing
 *     anchor — do NOT create a second, do NOT dispose the first);
 *   - a grant with a NEW token for an existing `viewId` REPLACES it (dispose the
 *     old anchor, create a new one bound to the new token);
 *   - distinct `viewId`s remain independent (no dedup between them);
 *   - `dispose()` cleans every CURRENTLY-LIVE anchor exactly once (replaced/old
 *     anchors were already disposed at replacement time → not double-disposed);
 *   - a grant whose slot does not resolve creates no anchor AND does not poison
 *     the per-viewId tracking.
 *
 * Harness is intentionally identical to `layout-client.test.ts` (fake bridge +
 * fake createAnchor capturing (target, opts) + dispose spies) — REUSED verbatim
 * so these pins compose with the existing handshake/token-threading pins.
 *
 * These pin the client's per-viewId tracking: the same-token replay (#1) must
 * NOT create a 2nd anchor, and the new-token replacement (#2) must dispose the
 * old anchor and replace it.
 */

import { describe, expect, it, vi } from 'vitest'
import { createDeckLayoutClient } from './layout-client.js'

// ── Local mirror of view-anchor's `Placement` (cannot import: view-anchor is
//    not a dependency of electron-deck yet).
interface Bounds {
  x: number
  y: number
  width: number
  height: number
}
type Placement = { visible: true; bounds: Bounds } | { visible: false }

interface SlotGrant {
  viewId: string
  slotId: string
  slotToken: string
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

// ── Fake bridge (mirror of layout-client.test.ts) ────────────────────────────
function makeBridge() {
  const order: string[] = []
  let grantCb: ((g: SlotGrant) => void) | null = null
  const unsubscribe = vi.fn()
  const sendPlace =
    vi.fn<(msg: { slotToken: string; placement: Placement }) => void>()

  const bridge = {
    onSlotGrant: vi.fn((cb: (g: SlotGrant) => void) => {
      order.push('onSlotGrant')
      grantCb = cb
      return unsubscribe
    }),
    sendPlace,
    subscribe: vi.fn(() => {
      order.push('subscribe')
    }),
  }

  return {
    bridge,
    sendPlace,
    unsubscribe,
    order,
    emitGrant(g: SlotGrant): void {
      if (!grantCb) throw new Error('no slot-grant subscriber registered')
      grantCb(g)
    },
    hasSubscriber(): boolean {
      return grantCb !== null
    },
  }
}

// ── Fake createAnchor (mirror of layout-client.test.ts) ──────────────────────
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

describe('createDeckLayoutClient — dedup renderer grants by viewId', () => {
  // ── #1 (CORE) same-token replay = no-op ────────────────────────────────────
  it('a re-delivered grant with the SAME viewId+token does NOT create a second anchor and does NOT dispose the first', () => {
    const b = makeBridge()
    const a = makeAnchorFactory()
    const el = document.createElement('div')
    const client = createDeckLayoutClient({
      bridge: b.bridge,
      createAnchor: a.createAnchor,
      resolveSlot: () => el,
    })
    void client

    const grant: SlotGrant = { viewId: 'v1', slotId: '#a', slotToken: 'tok1' }
    b.emitGrant(grant)
    // Main re-delivers the SAME grant on per-wc replay (identical token).
    b.emitGrant({ viewId: 'v1', slotId: '#a', slotToken: 'tok1' })

    // PIN: exactly one anchor for v1 — the replay is a pure no-op.
    expect(a.createAnchor).toHaveBeenCalledTimes(1)
    expect(a.anchors).toHaveLength(1)
    // The original anchor must NOT have been torn down by the replay.
    expect(a.anchors[0]?.dispose).not.toHaveBeenCalled()
  })

  it('the surviving anchor after a same-token replay still publishes to the original token', () => {
    const b = makeBridge()
    const a = makeAnchorFactory()
    const el = document.createElement('div')
    createDeckLayoutClient({
      bridge: b.bridge,
      createAnchor: a.createAnchor,
      resolveSlot: () => el,
    })

    b.emitGrant({ viewId: 'v1', slotId: '#a', slotToken: 'tok1' })
    b.emitGrant({ viewId: 'v1', slotId: '#a', slotToken: 'tok1' })

    a.anchors[0]?.opts.publish(placement(7))
    expect(b.sendPlace).toHaveBeenCalledTimes(1)
    expect(b.sendPlace).toHaveBeenCalledWith({
      slotToken: 'tok1',
      placement: placement(7),
    })
  })

  // ── #2 (CORE) new-token replacement ────────────────────────────────────────
  it('a grant with a NEW token for an existing viewId DISPOSES the old anchor and creates a replacement', () => {
    const b = makeBridge()
    const a = makeAnchorFactory()
    const el = document.createElement('div')
    createDeckLayoutClient({
      bridge: b.bridge,
      createAnchor: a.createAnchor,
      resolveSlot: () => el,
    })

    b.emitGrant({ viewId: 'v1', slotId: '#a', slotToken: 'tok1' })
    // Host re-issued the slot (e.g. after a moveTo / re-place): same viewId, NEW token.
    b.emitGrant({ viewId: 'v1', slotId: '#a', slotToken: 'tok2' })

    // PIN: replaced — two anchors created total, the FIRST disposed exactly once.
    expect(a.createAnchor).toHaveBeenCalledTimes(2)
    expect(a.anchors).toHaveLength(2)
    expect(a.anchors[0]?.dispose).toHaveBeenCalledTimes(1)
    expect(a.anchors[1]?.dispose).not.toHaveBeenCalled()
  })

  it('after a new-token replacement the LIVE (new) anchor publishes the new token, not the stale one', () => {
    const b = makeBridge()
    const a = makeAnchorFactory()
    const el = document.createElement('div')
    createDeckLayoutClient({
      bridge: b.bridge,
      createAnchor: a.createAnchor,
      resolveSlot: () => el,
    })

    b.emitGrant({ viewId: 'v1', slotId: '#a', slotToken: 'tok1' })
    b.emitGrant({ viewId: 'v1', slotId: '#a', slotToken: 'tok2' })

    // Drive the NEW (replacement) anchor → must thread tok2.
    a.anchors[1]?.opts.publish(placement(3))
    expect(b.sendPlace).toHaveBeenCalledWith({
      slotToken: 'tok2',
      placement: placement(3),
    })
    // The stale token must never appear on the wire.
    expect(b.sendPlace).not.toHaveBeenCalledWith(
      expect.objectContaining({ slotToken: 'tok1' }),
    )
  })

  // ── #3 distinct viewIds unaffected ─────────────────────────────────────────
  it('grants for DIFFERENT viewIds create independent anchors (no dedup between them)', () => {
    const b = makeBridge()
    const a = makeAnchorFactory()
    const sim = document.createElement('div')
    const dev = document.createElement('div')
    createDeckLayoutClient({
      bridge: b.bridge,
      createAnchor: a.createAnchor,
      resolveSlot: (slotId: string) => (slotId === '#sim' ? sim : dev),
    })

    b.emitGrant({ viewId: 'v-sim', slotId: '#sim', slotToken: 'tok-sim' })
    b.emitGrant({ viewId: 'v-dev', slotId: '#devtools', slotToken: 'tok-dev' })

    expect(a.createAnchor).toHaveBeenCalledTimes(2)
    expect(a.anchors).toHaveLength(2)
    expect(a.anchors[0]?.target).toBe(sim)
    expect(a.anchors[1]?.target).toBe(dev)
    // Neither was disposed by the other's grant.
    expect(a.anchors[0]?.dispose).not.toHaveBeenCalled()
    expect(a.anchors[1]?.dispose).not.toHaveBeenCalled()

    // Each still publishes to its own token (no cross-talk survives dedup).
    a.anchors[0]?.opts.publish(placement(1))
    a.anchors[1]?.opts.publish(placement(2))
    expect(b.sendPlace).toHaveBeenCalledWith({
      slotToken: 'tok-sim',
      placement: placement(1),
    })
    expect(b.sendPlace).toHaveBeenCalledWith({
      slotToken: 'tok-dev',
      placement: placement(2),
    })
  })

  // ── #4 dispose() cleans all CURRENTLY-LIVE anchors exactly once ─────────────
  it('dispose() disposes every live anchor once and does NOT double-dispose a replaced (already-disposed) anchor', () => {
    const b = makeBridge()
    const a = makeAnchorFactory()
    const el = document.createElement('div')
    const client = createDeckLayoutClient({
      bridge: b.bridge,
      createAnchor: a.createAnchor,
      resolveSlot: () => el,
    })

    // v1 gets replaced (tok1 → tok2); v2 stays. After this:
    //   anchors[0] = v1@tok1 (already disposed at replacement)
    //   anchors[1] = v1@tok2 (live)
    //   anchors[2] = v2@tok-b (live)
    b.emitGrant({ viewId: 'v1', slotId: '#a', slotToken: 'tok1' })
    b.emitGrant({ viewId: 'v1', slotId: '#a', slotToken: 'tok2' })
    b.emitGrant({ viewId: 'v2', slotId: '#b', slotToken: 'tok-b' })

    expect(a.createAnchor).toHaveBeenCalledTimes(3)
    // The replaced anchor was already disposed exactly once by the replacement.
    expect(a.anchors[0]?.dispose).toHaveBeenCalledTimes(1)

    client.dispose()

    // Bridge unsubscribed.
    expect(b.unsubscribe).toHaveBeenCalledTimes(1)
    // The two LIVE anchors disposed exactly once each.
    expect(a.anchors[1]?.dispose).toHaveBeenCalledTimes(1)
    expect(a.anchors[2]?.dispose).toHaveBeenCalledTimes(1)
    // The already-replaced anchor is NOT disposed a second time.
    expect(a.anchors[0]?.dispose).toHaveBeenCalledTimes(1)
  })

  // ── #5 unresolved slot does not poison per-viewId tracking ─────────────────
  it('a grant whose slot does NOT resolve creates no anchor and does not poison the viewId; a later resolving grant for the SAME viewId anchors normally', () => {
    const b = makeBridge()
    const a = makeAnchorFactory()
    const el = document.createElement('div')
    let mounted = false
    createDeckLayoutClient({
      bridge: b.bridge,
      createAnchor: a.createAnchor,
      // Slot is initially unmounted → null; later it mounts → el.
      resolveSlot: () => (mounted ? el : null),
    })

    // First grant for v1: slot not mounted → no anchor, no throw.
    expect(() =>
      b.emitGrant({ viewId: 'v1', slotId: '#a', slotToken: 'tok1' }),
    ).not.toThrow()
    expect(a.createAnchor).not.toHaveBeenCalled()

    // Slot mounts; a later grant for the SAME viewId must now anchor — the
    // earlier failed resolve must not have left v1 "tracked" so this is suppressed.
    mounted = true
    b.emitGrant({ viewId: 'v1', slotId: '#a', slotToken: 'tok2' })

    expect(a.createAnchor).toHaveBeenCalledTimes(1)
    expect(a.anchors[0]?.target).toBe(el)
    a.anchors[0]?.opts.publish(placement(4))
    expect(b.sendPlace).toHaveBeenCalledWith({
      slotToken: 'tok2',
      placement: placement(4),
    })
  })

  // a NEW token for an existing viewId must REVOKE the old
  // anchor even when the NEW slot does not resolve — otherwise the stale anchor
  // keeps publishing an already-revoked token. The old anchor is disposed and NO
  // replacement is created; a later grant (slot now mounted) anchors with the
  // latest token.
  it('a new-token grant whose NEW slot is unresolved still disposes the old anchor (no stale anchor keeps publishing the revoked token)', () => {
    const b = makeBridge()
    const a = makeAnchorFactory()
    const el = document.createElement('div')
    let resolves = true
    createDeckLayoutClient({
      bridge: b.bridge,
      createAnchor: a.createAnchor,
      resolveSlot: () => (resolves ? el : null),
    })

    // v1 anchored with tok1.
    b.emitGrant({ viewId: 'v1', slotId: '#a', slotToken: 'tok1' })
    expect(a.createAnchor).toHaveBeenCalledTimes(1)
    const old = a.anchors[0]
    expect(old?.dispose).not.toHaveBeenCalled()

    // New token arrives but the (new) slot doesn't resolve right now.
    resolves = false
    b.emitGrant({ viewId: 'v1', slotId: '#a', slotToken: 'tok2' })
    // The stale anchor (tok1) is disposed/revoked, and NO new anchor was created.
    expect(old?.dispose).toHaveBeenCalledTimes(1)
    expect(a.createAnchor).toHaveBeenCalledTimes(1)

    // Later, the slot resolves and tok2 (or a newer token) lands → anchors fresh.
    resolves = true
    b.emitGrant({ viewId: 'v1', slotId: '#a', slotToken: 'tok3' })
    expect(a.createAnchor).toHaveBeenCalledTimes(2)
    a.anchors[1]?.opts.publish(placement(7))
    expect(b.sendPlace).toHaveBeenCalledWith({ slotToken: 'tok3', placement: placement(7) })
  })
})
