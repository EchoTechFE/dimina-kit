// @vitest-environment jsdom
/**
 * TDD contract tests (FAILING-FIRST) for `createDeckLayoutClient` — the
 * RENDERER half of the A5-2 slot-token handshake (view-handle build-plan §2(e)
 * "renderer client"). This client is what makes a main-process native view
 * actually FOLLOW a DOM slot:
 *
 *   1. subscribe to main's `slot-grant` pushes (BEFORE asking main to replay),
 *   2. on each grant, resolve the DOM slot element and anchor it via a
 *      view-anchor `createPlacementAnchor` (with the session's hardening opts),
 *   3. thread each measured `Placement` back to main as a `place` carrying the
 *      grant's `slotToken`.
 *
 * Source-of-truth referenced (and only these):
 *   - the `createDeckLayoutClient(deps)` contract handed to this test author,
 *   - `docs/contracts/capability-and-lifecycle.md` §A5-2.1 (renderer handshake:
 *     subscribe FIRST, anchor ON grant, publish WITH slotToken),
 *   - `packages/view-anchor/src/view-anchor.ts` `createPlacementAnchor` opts
 *     + `Placement` shape (mirrored locally below — view-anchor is not yet a
 *     dependency of electron-deck, so its types cannot be imported here).
 *
 * No real anchor machinery (ResizeObserver / IntersectionObserver / RAF) is
 * exercised: a FAKE `createAnchor` captures `(target, opts)` so the test can
 * drive `opts.publish(...)` directly, and a FAKE `bridge` captures the
 * grant callback / replay-drain / place sends.
 *
 * Expected initial state: RED — `./layout-client.js` does not exist yet.
 */

import { describe, expect, it, vi } from 'vitest'
// RED: module does not exist yet — implementation is intentionally absent.
import { createDeckLayoutClient } from './layout-client.js'

// ── Local mirror of view-anchor's `Placement` (cannot import: view-anchor is
//    not a dependency of electron-deck yet). Keep in sync with
//    packages/view-anchor/src/types.ts.
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

// ── Fake bridge ──────────────────────────────────────────────────────────
// Records subscribe/onSlotGrant/sendPlace calls and the ORDER in which the
// two subscribe-side primitives ran (handshake-order pin). `emitGrant` drives
// a main→renderer push; `unsubscribe` is the spy returned from onSlotGrant.

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

function makeBridge() {
  const order: string[] = []
  let grantCb: ((g: SlotGrant) => void) | null = null
  const unsubscribe = vi.fn()
  const sendPlace = vi.fn<(msg: { slotToken: string; placement: Placement }) => void>()

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

// ── Fake createAnchor ────────────────────────────────────────────────────
// Captures every (target, opts) so the test can drive opts.publish and assert
// dispose. NO real RO/IO/RAF.

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

describe('createDeckLayoutClient — renderer slot-token handshake (§2(e))', () => {
  // ── #1 subscribe-on-init (HANDSHAKE-ORDER PIN) ──────────────────────────
  it('subscribes to slot-grant BEFORE (or at) calling subscribe() so a replayed grant cannot be missed', () => {
    const b = makeBridge()
    const a = makeAnchorFactory()

    createDeckLayoutClient({ bridge: b.bridge, createAnchor: a.createAnchor })

    // Both handshake primitives ran.
    expect(b.bridge.onSlotGrant).toHaveBeenCalledTimes(1)
    expect(b.bridge.subscribe).toHaveBeenCalledTimes(1)

    // PIN: the grant subscription must be registered BEFORE the replay drain is
    // requested — otherwise a buffered grant replayed synchronously by
    // subscribe() would have no listener. onSlotGrant must come first (or, at
    // minimum, no later than) subscribe().
    const grantIdx = b.order.indexOf('onSlotGrant')
    const subIdx = b.order.indexOf('subscribe')
    expect(grantIdx).toBeGreaterThanOrEqual(0)
    expect(subIdx).toBeGreaterThanOrEqual(0)
    expect(grantIdx).toBeLessThan(subIdx)
  })

  it('a grant replayed synchronously during subscribe() is still delivered (listener already attached)', () => {
    // Make subscribe() replay a buffered grant synchronously, mimicking the
    // main-side per-wc replay-on-connect drain. The listener must already be
    // installed when this fires.
    const a = makeAnchorFactory()
    const order: string[] = []
    let grantCb: ((g: SlotGrant) => void) | null = null
    const el = document.createElement('div')
    el.id = 'sim'
    document.body.appendChild(el)

    const bridge = {
      onSlotGrant: vi.fn((cb: (g: SlotGrant) => void) => {
        order.push('onSlotGrant')
        grantCb = cb
        return vi.fn()
      }),
      sendPlace: vi.fn(),
      subscribe: vi.fn(() => {
        order.push('subscribe')
        // replay drain fires the buffered grant right now:
        grantCb?.({ viewId: 'v1', slotId: '#sim', slotToken: 'tok-1' })
      }),
    }

    createDeckLayoutClient({ bridge, createAnchor: a.createAnchor })

    // The replayed grant landed → an anchor was created (proof the listener was
    // attached before subscribe() drained).
    expect(a.anchors).toHaveLength(1)
    expect(a.anchors[0]?.target).toBe(el)
    document.body.removeChild(el)
  })

  // ── #2 grant → anchor the DOM slot (with hardening opts) ────────────────
  it('on a grant, resolves the DOM slot and creates an anchor with followScroll/followGeometry/guardDisplayNone/visible all true', () => {
    const b = makeBridge()
    const a = makeAnchorFactory()
    const el = document.createElement('div')
    el.id = 'sim'
    document.body.appendChild(el)

    createDeckLayoutClient({ bridge: b.bridge, createAnchor: a.createAnchor })
    b.emitGrant({ viewId: 'v1', slotId: '#sim', slotToken: 'tok-1' })

    expect(a.createAnchor).toHaveBeenCalledTimes(1)
    const created = a.anchors[0]
    expect(created?.target).toBe(el) // default resolveSlot = querySelector('#sim')
    expect(created?.opts.visible).toBe(true)
    expect(created?.opts.followScroll).toBe(true)
    expect(created?.opts.followGeometry).toBe(true)
    expect(created?.opts.guardDisplayNone).toBe(true)

    document.body.removeChild(el)
  })

  // ── #3 publish → sendPlace WITH the grant's token (TOKEN-THREADING PIN) ──
  it("threads the grant's slotToken: driving the anchor's publish sends sendPlace({ slotToken, placement }) with the SAME token", () => {
    const b = makeBridge()
    const a = makeAnchorFactory()

    // Inject resolveSlot so this test needs no real DOM.
    const el = document.createElement('div')
    createDeckLayoutClient({
      bridge: b.bridge,
      createAnchor: a.createAnchor,
      resolveSlot: () => el,
    })
    b.emitGrant({ viewId: 'v1', slotId: '#sim', slotToken: 'tok-XYZ' })

    const p = placement(5)
    // Drive the captured publish closure — the anchor "measured" a rect.
    a.anchors[0]?.opts.publish(p)

    // PIN: the publish closure must have captured the grant's slotToken and
    // forwarded it verbatim alongside the placement.
    expect(b.sendPlace).toHaveBeenCalledTimes(1)
    expect(b.sendPlace).toHaveBeenCalledWith({ slotToken: 'tok-XYZ', placement: p })
  })

  it('forwards a visible:false placement with the token too (no geometry, still tokened)', () => {
    const b = makeBridge()
    const a = makeAnchorFactory()
    const el = document.createElement('div')
    createDeckLayoutClient({
      bridge: b.bridge,
      createAnchor: a.createAnchor,
      resolveSlot: () => el,
    })
    b.emitGrant({ viewId: 'v1', slotId: '#sim', slotToken: 'tok-hidden' })

    const hidden: Placement = { visible: false }
    a.anchors[0]?.opts.publish(hidden)

    expect(b.sendPlace).toHaveBeenCalledWith({
      slotToken: 'tok-hidden',
      placement: hidden,
    })
  })

  // ── #4 missing slot el → graceful (no anchor, no throw) ─────────────────
  it('a grant whose slotId resolves to NO element creates no anchor and does not throw', () => {
    const b = makeBridge()
    const a = makeAnchorFactory()

    // Default resolveSlot = querySelector('#nope') → null (nothing in jsdom).
    createDeckLayoutClient({ bridge: b.bridge, createAnchor: a.createAnchor })

    expect(() =>
      b.emitGrant({ viewId: 'v1', slotId: '#nope', slotToken: 'tok-1' }),
    ).not.toThrow()
    expect(a.createAnchor).not.toHaveBeenCalled()
    expect(b.sendPlace).not.toHaveBeenCalled()
  })

  it('a later grant that DOES resolve still works after an earlier missing one (no poisoned state)', () => {
    const b = makeBridge()
    const a = makeAnchorFactory()
    const el = document.createElement('div')
    el.id = 'sim'
    document.body.appendChild(el)

    createDeckLayoutClient({ bridge: b.bridge, createAnchor: a.createAnchor })

    b.emitGrant({ viewId: 'v0', slotId: '#missing', slotToken: 'tok-0' })
    b.emitGrant({ viewId: 'v1', slotId: '#sim', slotToken: 'tok-1' })

    expect(a.createAnchor).toHaveBeenCalledTimes(1)
    expect(a.anchors[0]?.target).toBe(el)
    document.body.removeChild(el)
  })

  // ── #5 dispose: unsubscribe + dispose every anchor; post-dispose grant inert
  it('dispose() unsubscribes from the bridge and disposes every created anchor', () => {
    const b = makeBridge()
    const a = makeAnchorFactory()
    const el1 = document.createElement('div')
    const el2 = document.createElement('div')
    let i = 0
    const client = createDeckLayoutClient({
      bridge: b.bridge,
      createAnchor: a.createAnchor,
      resolveSlot: () => (i++ === 0 ? el1 : el2),
    })

    b.emitGrant({ viewId: 'v1', slotId: '#a', slotToken: 'tok-a' })
    b.emitGrant({ viewId: 'v2', slotId: '#b', slotToken: 'tok-b' })
    expect(a.anchors).toHaveLength(2)

    client.dispose()

    expect(b.unsubscribe).toHaveBeenCalledTimes(1)
    expect(a.anchors[0]?.dispose).toHaveBeenCalledTimes(1)
    expect(a.anchors[1]?.dispose).toHaveBeenCalledTimes(1)
  })

  it('a grant arriving after dispose() creates no anchor', () => {
    const b = makeBridge()
    const a = makeAnchorFactory()
    const el = document.createElement('div')
    const client = createDeckLayoutClient({
      bridge: b.bridge,
      createAnchor: a.createAnchor,
      resolveSlot: () => el,
    })

    client.dispose()

    // The bridge could still hold a (now-stale) reference and push; the client
    // must ignore it. We deliver via the captured callback if it survived
    // unsubscribe; either way no anchor must be created.
    if (b.hasSubscriber()) {
      b.emitGrant({ viewId: 'v1', slotId: '#a', slotToken: 'tok-a' })
    }
    expect(a.createAnchor).not.toHaveBeenCalled()
  })

  // ── #6 per-grant anchor, no cross-talk between slots ────────────────────
  it('two grants → two anchors, each publishing to ITS OWN token (no cross-talk)', () => {
    const b = makeBridge()
    const a = makeAnchorFactory()
    const sim = document.createElement('div')
    const dev = document.createElement('div')
    const client = createDeckLayoutClient({
      bridge: b.bridge,
      createAnchor: a.createAnchor,
      resolveSlot: (slotId: string) => (slotId === '#sim' ? sim : dev),
    })
    void client

    b.emitGrant({ viewId: 'v-sim', slotId: '#sim', slotToken: 'tok-sim' })
    b.emitGrant({ viewId: 'v-dev', slotId: '#devtools', slotToken: 'tok-dev' })

    expect(a.anchors).toHaveLength(2)
    expect(a.anchors[0]?.target).toBe(sim)
    expect(a.anchors[1]?.target).toBe(dev)

    const pSim = placement(1)
    const pDev = placement(2)
    // Drive #sim's publish → only #sim's token; #devtools untouched.
    a.anchors[0]?.opts.publish(pSim)
    expect(b.sendPlace).toHaveBeenCalledWith({
      slotToken: 'tok-sim',
      placement: pSim,
    })
    expect(b.sendPlace).not.toHaveBeenCalledWith(
      expect.objectContaining({ slotToken: 'tok-dev' }),
    )

    // Drive #devtools's publish → only #devtools's token.
    a.anchors[1]?.opts.publish(pDev)
    expect(b.sendPlace).toHaveBeenCalledWith({
      slotToken: 'tok-dev',
      placement: pDev,
    })
    expect(b.sendPlace).toHaveBeenCalledTimes(2)
  })
})
