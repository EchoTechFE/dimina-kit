import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createViewAnchor } from './view-anchor'
import type { Bounds, ViewAnchorOptions } from './types'

// ── clipToTarget contract (RED phase) ───────────────────────────────────
//
// These tests cover a NEW optional `clipToTarget?: boolean` on
// `createViewAnchor`'s options. The motivation: the native simulator WCV is a
// main-process overlay that DOM `overflow` cannot clip. When the device is
// taller than the scroll container, the (centered, fixed-size) inner-screen
// rect overflows the viewport and the WCV bleeds over the top toolbar / bottom
// page-path bar. The fix: when `clipToTarget === true`, the anchor INTERSECTS
// the measured rect with the target's own client rect before clamping/rounding
// — so the published bounds can never extend past the visible scroll viewport.
//
// Mirrors the sibling `view-anchor.test.ts` harness:
//   - FakeResizeObserver stub,
//   - `buildElement` stubs `getBoundingClientRect` (jsdom returns zeros),
//   - the anchor publishes SYNCHRONOUSLY (no RAF defer) — assertions are on the
//     synchronous create-time / tick publish,
//   - the measured rect is supplied via the `measure()` override.

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
  fire(): void {
    this.cb([], this)
  }
}

let leakedResize: unknown[] = []

beforeEach(() => {
  FakeResizeObserver.instances = []
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)

  // Track leaked window 'resize' listeners so afterEach can remove them —
  // tests create anchors directly and don't dispose them.
  const realAdd = window.addEventListener.bind(window)
  const realRemove = window.removeEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation(
    (type: string, ...rest: unknown[]) => {
      if (type === 'resize') leakedResize.push(rest[0])
      return (realAdd as unknown as (...a: unknown[]) => void)(type, ...rest)
    },
  )
  vi.spyOn(window, 'removeEventListener').mockImplementation(
    (type: string, ...rest: unknown[]) => {
      if (type === 'resize')
        leakedResize = leakedResize.filter((h) => h !== rest[0])
      return (realRemove as unknown as (...a: unknown[]) => void)(type, ...rest)
    },
  )
})

afterEach(() => {
  leakedResize.forEach((h) =>
    window.removeEventListener('resize', h as EventListener),
  )
  leakedResize = []
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// Stub `getBoundingClientRect` for the target element (= the scroll container
// the anchor observes AND, with clip, intersects against). Full DOMRect with
// left/top/right/bottom so the intersection math has real edges to read.
function buildElement(rect: {
  x: number
  y: number
  w: number
  h: number
}): { el: HTMLElement; setRect: (next: typeof rect) => void } {
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

// Local superset of ViewAnchorOptions adding the not-yet-implemented flag, so
// the file compiles before `clipToTarget` lands on the real option type.
type ClipOptions = ViewAnchorOptions & { clipToTarget?: boolean }
const opts = (o: ClipOptions): ViewAnchorOptions =>
  o as unknown as ViewAnchorOptions

// ── clipToTarget === true: intersect measured ∩ target ──────────────────

describe('createViewAnchor — clipToTarget', () => {
  it('overflow-bottom: clamps published height to the target bottom edge', () => {
    // target (scroll viewport) is 0,0 → 300×500. The measured inner-screen rect
    // starts inside it but is TALLER, overflowing the bottom by 200px. Without
    // clip the WCV would extend to y=700 (over the bottom page-path bar). With
    // clip the published bottom is min(700, 500) = 500 → height = 500 - 50 = 450.
    const publish = vi.fn()
    const { el } = buildElement({ x: 0, y: 0, w: 300, h: 500 })
    createViewAnchor(
      el,
      opts({
        present: true,
        publish,
        clipToTarget: true,
        // measured inner-screen rect: x=20,y=50,w=260,h=650 → bottom=700
        measure: () => ({ x: 20, y: 50, width: 260, height: 650 }),
      }),
    )

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({
      x: 20, // max(20, 0)
      y: 50, // max(50, 0)
      width: 260, // min(280, 300) - 20 = 260
      height: 450, // min(700, 500) - 50 = 450
    })
  })

  it('scrolled-above-top: published.y === target.top and height shrinks', () => {
    // target viewport is 0,100 → 300×400 (top=100, bottom=500). The device was
    // scrolled UP so the inner-screen rect's top is ABOVE the viewport top
    // (y=-60). Without clip the WCV would paint up over the top toolbar. With
    // clip the published top is max(-60, 100) = 100 and height shrinks to the
    // visible slice: min(540, 500) - 100 = 400.
    const publish = vi.fn()
    const { el } = buildElement({ x: 0, y: 100, w: 300, h: 400 })
    createViewAnchor(
      el,
      opts({
        present: true,
        publish,
        clipToTarget: true,
        // measured: x=0,y=-60,w=300,h=600 → bottom=540
        measure: () => ({ x: 0, y: -60, width: 300, height: 600 }),
      }),
    )

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({
      x: 0, // max(0, 0)
      y: 100, // max(-60, 100) === target.top
      width: 300, // min(300, 300) - 0
      height: 400, // min(540, 500) - 100 = 400
    })
  })

  it('disjoint: measured entirely outside the target → published is hidden (0 area)', () => {
    // The measured rect sits entirely BELOW the target viewport (top=2000,
    // bottom=2300; target bottom=500). The intersection is empty, so the
    // published width and/or height must be 0 (the canonical "hide" signal).
    const publish = vi.fn()
    const { el } = buildElement({ x: 0, y: 0, w: 300, h: 500 })
    createViewAnchor(
      el,
      opts({
        present: true,
        publish,
        clipToTarget: true,
        measure: () => ({ x: 0, y: 2000, width: 300, height: 300 }),
      }),
    )

    expect(publish).toHaveBeenCalledTimes(1)
    const arg = publish.mock.calls[0]![0] as Bounds
    // Empty intersection → at least one dimension collapses to 0 (clamped ≥0).
    expect(arg.width === 0 || arg.height === 0).toBe(true)
  })

  it('fully-inside: clip is a no-op → published === measured (rounded)', () => {
    // The measured rect fits entirely within the target viewport, so the
    // intersection equals the measured rect: clip must NOT alter it. Fractional
    // measured values prove the SAME rounding still applies through the clip
    // path (x/y rounded; width/height Math.max(0, round)).
    const publish = vi.fn()
    const { el } = buildElement({ x: 0, y: 0, w: 400, h: 800 })
    createViewAnchor(
      el,
      opts({
        present: true,
        publish,
        clipToTarget: true,
        measure: () => ({ x: 10.4, y: 20.6, width: 100.5, height: 200.4 }),
      }),
    )

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({
      x: 10, // Math.round(10.4)
      y: 21, // Math.round(20.6)
      width: 101, // Math.max(0, Math.round(100.5))
      height: 200, // Math.max(0, Math.round(200.4))
    })
  })

  it('no measure() override: intersects target.getBoundingClientRect() with itself (identity)', () => {
    // When there is no `measure` override the measured rect IS the target rect,
    // so clipping it against the target is a no-op identity — proving the clip
    // path defaults its measured source to the target rect just like the
    // unclipped path does.
    const publish = vi.fn()
    const { el } = buildElement({ x: 12, y: 34, w: 200, h: 300 })
    createViewAnchor(el, opts({ present: true, publish, clipToTarget: true }))

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({
      x: 12,
      y: 34,
      width: 200,
      height: 300,
    })
  })

  it('a ResizeObserver tick re-clips against the CURRENT target rect', () => {
    // Bug it catches: clipping against a target rect captured at create time
    // (instead of read live each frame) would drift as the viewport resizes.
    // Here the target SHRINKS after create; the next tick must re-clip against
    // the new (smaller) target bottom.
    const publish = vi.fn()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 300, h: 800 })
    createViewAnchor(
      el,
      opts({
        present: true,
        publish,
        clipToTarget: true,
        measure: () => ({ x: 0, y: 0, width: 300, height: 600 }),
      }),
    )
    // Create-time: target h=800 fully contains the 600-tall measured rect.
    expect(publish).toHaveBeenLastCalledWith({
      x: 0,
      y: 0,
      width: 300,
      height: 600,
    })
    publish.mockClear()

    // Shrink the target viewport to 300×400, then tick — re-clips synchronously.
    setRect({ x: 0, y: 0, w: 300, h: 400 })
    FakeResizeObserver.instances[0]!.fire()

    expect(publish).toHaveBeenCalledTimes(1)
    // Now clipped to the smaller viewport: height = min(600, 400) - 0 = 400.
    expect(publish).toHaveBeenCalledWith({
      x: 0,
      y: 0,
      width: 300,
      height: 400,
    })
  })
})

// ── clipToTarget falsy/absent: behavior unchanged ────────────────────────

describe('createViewAnchor — clipToTarget falsy/absent leaves behavior unchanged', () => {
  it('absent: publishes the UNCLIPPED measured rect even when it overflows the target', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: 0, y: 0, w: 300, h: 500 })
    createViewAnchor(
      el,
      opts({
        present: true,
        publish,
        // No clipToTarget → measured rect published as-is (overflows target).
        measure: () => ({ x: 20, y: 50, width: 260, height: 650 }),
      }),
    )

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({
      x: 20,
      y: 50,
      width: 260,
      height: 650, // NOT clamped to the target bottom
    })
  })

  it('clipToTarget:false: identical to absent (publishes the unclipped overflowing rect)', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: 0, y: 0, w: 300, h: 500 })
    createViewAnchor(
      el,
      opts({
        present: true,
        publish,
        clipToTarget: false,
        measure: () => ({ x: 20, y: 50, width: 260, height: 650 }),
      }),
    )

    expect(publish).toHaveBeenCalledWith({
      x: 20,
      y: 50,
      width: 260,
      height: 650,
    })
  })
})

// ── present:false still publishes ZERO directly (not via measure/clip) ───

describe('createViewAnchor — clipToTarget does not affect the detach ZERO', () => {
  it('present:false with clipToTarget:true publishes {0,0,0,0} directly', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: 0, y: 0, w: 300, h: 500 })
    createViewAnchor(
      el,
      opts({
        present: false,
        publish,
        clipToTarget: true,
        measure: () => ({ x: 20, y: 50, width: 260, height: 650 }),
      }),
    )

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 })
  })
})

// Local type assertion so the file fails loudly if the Bounds shape drifts.
const _boundsShape: Bounds = { x: 0, y: 0, width: 0, height: 0 }
void _boundsShape
