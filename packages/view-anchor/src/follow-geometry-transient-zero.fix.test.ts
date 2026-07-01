import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createPlacementAnchor } from './view-anchor.js'
import type { Placement } from './types.js'

// Locks the correct behaviour of the followGeometry sentinel when a
// guardDisplayNone anchor's slot momentarily measures 0×0 during a
// relayout (e.g. device/orientation switch).
//
// On a slot transition the dock reflows; for one or more animation frames
// the slot rect collapses to 0×0 before being restored to its real non-zero
// size. ResizeObserver coalesces the net B→0→B change away and never fires,
// so the ONLY observer of the transient zero is the RAF sentinel.
//
// Correct behaviour: the sentinel MUST NOT publish {visible:false} from a
// transient zero poll. Detaching is owned by ResizeObserver / IntersectionObserver,
// not the sentinel. After a transient-zero-then-restore sequence driven
// purely through the sentinel (no RO fire), the final placement must be
// {visible:true, bounds:<restored rect>}.

// ── Controllable fake requestAnimationFrame ──────────────────────────────
class FakeRaf {
  private cbs = new Map<number, FrameRequestCallback>()
  private nextId = 1
  request = vi.fn((cb: FrameRequestCallback): number => {
    const id = this.nextId++
    this.cbs.set(id, cb)
    return id
  })
  cancel = vi.fn((id: number): void => {
    this.cbs.delete(id)
  })
  /** Drain exactly the callbacks pending at call-time; a re-request lands in
   *  the next flush, so flushFrame() advances exactly one logical frame. */
  flushFrame(ts = 0): void {
    const pending = [...this.cbs.entries()]
    this.cbs.clear()
    for (const [, cb] of pending) cb(ts)
  }
  get pending(): number {
    return this.cbs.size
  }
}

// ── Minimal ResizeObserver stub ──────────────────────────────────────────
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  observed: Element[] = []
  disconnected = false
  constructor(public cb: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this)
  }
  observe(el: Element): void {
    this.observed.push(el)
  }
  unobserve(): void {
    /* unused */
  }
  disconnect(): void {
    this.disconnected = true
  }
}

let raf: FakeRaf

beforeEach(() => {
  FakeResizeObserver.instances = []
  raf = new FakeRaf()
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.stubGlobal(
    'requestAnimationFrame',
    raf.request as unknown as typeof window.requestAnimationFrame,
  )
  vi.stubGlobal(
    'cancelAnimationFrame',
    raf.cancel as unknown as typeof window.cancelAnimationFrame,
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function buildElement(rect: { x: number; y: number; w: number; h: number }): {
  el: HTMLElement
  setRect: (next: { x: number; y: number; w: number; h: number }) => void
} {
  const el = document.createElement('div')
  let current = rect
  vi.spyOn(el, 'getBoundingClientRect').mockImplementation(
    () =>
      ({
        x: current.x,
        y: current.y,
        left: current.x,
        top: current.y,
        right: current.x + current.w,
        bottom: current.y + current.h,
        width: current.w,
        height: current.h,
        toJSON: () => ({}),
      }) as DOMRect,
  )
  return {
    el,
    setRect(next) {
      current = next
    },
  }
}

// Options cast: followGeometry / guardDisplayNone not on the exported TS
// types yet — cast through so tests compile without touching the types file.
type PlacementOpts = Parameters<typeof createPlacementAnchor>[1] & {
  followGeometry?: boolean
  guardDisplayNone?: boolean
}
const mk = (
  el: HTMLElement,
  o: {
    visible: boolean
    publish: (p: Placement) => void
    followGeometry?: boolean
    guardDisplayNone?: boolean
  },
): ReturnType<typeof createPlacementAnchor> =>
  createPlacementAnchor(el, o as PlacementOpts)

describe('createPlacementAnchor — followGeometry sentinel must not detach on a transient zero-area poll', () => {
  // Core bug: slot goes 0×0 transiently during a dock relayout; RO never
  // fires (net change is zero); the sentinel is the only observer. The sentinel
  // must NOT publish {visible:false} and must not close on the zero frames so
  // it can follow the restored rect.
  it('transient 0×0 poll → restore: final placement is visible:true (not a detach)', () => {
    const publishes: Placement[] = []
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 400, h: 800 })

    mk(el, {
      visible: true,
      guardDisplayNone: true,
      followGeometry: true,
      publish: (p) => publishes.push(p),
    })

    // Synchronous initial publish on creation.
    expect(publishes).toHaveLength(1)
    expect(publishes[0]).toEqual({
      visible: true,
      bounds: { x: 0, y: 0, width: 400, height: 800 },
    })

    // Open the sentinel (imperative pulse, no duration → steady-close only,
    // no time-stubbing needed).
    const anchor = mk(el, {
      visible: true,
      guardDisplayNone: true,
      followGeometry: true,
      publish: (p) => publishes.push(p),
    })
    // Reset to track only the sentinel's publishes from here on.
    publishes.length = 0
    anchor.pulse()

    // Simulate the slot collapsing to 0×0 (transient relayout).
    // Do NOT fire ResizeObserver (it coalesces the net B→0→B away).
    setRect({ x: 0, y: 0, w: 0, h: 0 })

    // Flush enough frames to exceed the steady-close threshold (STEADY_CLOSE_FRAMES=2)
    // so the buggy sentinel closes on the zero.
    raf.flushFrame() // frame 1 at zero
    raf.flushFrame() // frame 2 at zero
    raf.flushFrame() // frame 3 at zero — buggy path closes here

    // Now restore the slot to its real (moved) non-zero rect.
    setRect({ x: 120, y: 0, w: 400, h: 800 })

    // Drive additional frames; with the fix the sentinel is still open and
    // picks up the restored rect. With the bug the sentinel already closed —
    // these flushes are no-ops but that's fine: the assertion is on the LAST
    // published placement regardless.
    raf.flushFrame()
    raf.flushFrame()

    // The sentinel must NEVER have emitted {visible:false}.
    const detaches = publishes.filter((p) => p.visible === false)
    expect(detaches).toHaveLength(0)

    // And the view must not be left detached: the last placement is visible:true.
    expect(publishes.length).toBeGreaterThan(0)
    const last = publishes[publishes.length - 1]
    expect(last).toMatchObject({ visible: true })
  })

  // No-regression: the sentinel must still follow a normal visible move
  // (pulse → setRect to moved non-zero rect → flushFrame → published).
  // Guards against a "fix" that simply disables sentinel publishing.
  it('sentinel follows a normal visible-rect move after pulse()', () => {
    const publishes: Placement[] = []
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 400, h: 800 })

    const anchor = mk(el, {
      visible: true,
      guardDisplayNone: true,
      followGeometry: true,
      publish: (p) => publishes.push(p),
    })
    publishes.length = 0 // clear the initial synchronous publish

    anchor.pulse()

    // Move the slot to a new non-zero position (e.g. after a panel resize).
    setRect({ x: 200, y: 50, w: 400, h: 800 })
    raf.flushFrame()

    expect(publishes).toContainEqual({
      visible: true,
      bounds: { x: 200, y: 50, width: 400, height: 800 },
    })
  })

  // Defensive bound: while the sentinel keeps FOLLOWING a hidden poll (a
  // relayout transient where last-published is still visible and RO/IO never
  // fire), it must not spin forever. After a finite run of consecutive hidden
  // polls it stops scheduling new frames (window closes) — and it must STILL
  // never publish a {visible:false} detach during that bounded run.
  it('sentinel stops polling after a bounded run of hidden frames — no infinite rAF, no detach', () => {
    const publishes: Placement[] = []
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 400, h: 800 })

    const anchor = mk(el, {
      visible: true,
      guardDisplayNone: true,
      followGeometry: true,
      publish: (p) => publishes.push(p),
    })
    publishes.length = 0 // clear the initial synchronous publish

    anchor.pulse()

    // Slot collapses to 0×0 and stays hidden. RO/IO never fire.
    setRect({ x: 0, y: 0, w: 0, h: 0 })

    // Drive frames until the sentinel closes on its own (raf.pending === 0),
    // with a hard safety break so a genuinely unbounded spin still terminates
    // the test instead of hanging.
    let n = 0
    while (raf.pending) {
      raf.flushFrame()
      if (++n > 200) break
    }

    // The loop terminated because the sentinel CLOSED (pending → 0), not
    // because the safety break fired, and it converged quickly.
    expect(raf.pending).toBe(0)
    expect(n).toBeLessThan(100)

    // The bounded close must still never emit a detach.
    const detaches = publishes.filter((p) => p.visible === false)
    expect(detaches).toHaveLength(0)
  })
})
