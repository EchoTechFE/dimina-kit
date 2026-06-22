import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// ─────────────────────────────────────────────────────────────────────
// Tests for the explicit `Placement` API, the alternative to encoding
// "hidden" as the magic geometric value `{x:0,y:0,width:0,height:0}` (the
// `present:false → ZERO bounds` convention in types.ts/view-anchor.ts). That
// ZERO convention leaks a compositor/host concept ("detach the view") into the
// geometry layer, and is ambiguous: a view that is genuinely 0-wide is
// indistinguishable from a hidden one.
//
// The replacement contract:
//
//   type Placement =
//     | { visible: true; bounds: Bounds }
//     | { visible: false }
//
// measure produces a `Placement`; the sink consumes a `Placement`.
// Visibility is EXPLICIT (a discriminant), never inferred from a 0. The
// explicit API NEVER reintroduces a ZERO-bounds path for "hidden".
//
// The symbols (`measurePlacement`, `createPlacementAnchor`, `Placement`) are
// imported dynamically so a missing export surfaces as a runtime/assertion
// failure (an `undefined` that throws when called) rather than a whole-file
// compile error that vitest would skip.
// ─────────────────────────────────────────────────────────────────────

import type { Bounds } from './types.js'

// The explicit API is imported through this indirection so that a missing
// export is observable as `undefined` at runtime (→ a failing assertion /
// TypeError), not a static "module has no exported member" compile error that
// would prevent the whole suite from running.
import * as viewAnchorModule from './view-anchor.js'

// The shape the explicit API must produce/consume. Mirrored locally (not
// imported) so these tests describe the *target* contract independently of
// whether the `Placement` type already exists in types.ts.
type ExpectedPlacement =
  | { visible: true; bounds: Bounds }
  | { visible: false }

// ── ResizeObserver stub (same style as view-anchor.test.ts) ──────────

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

// ── Element fixture (jsdom getBoundingClientRect returns zeros) ───────

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

// ── Resolve the explicit API at call time ─────────
//
// Each helper asserts the export is a function before calling it, so an absent
// export surfaces as a clear assertion failure rather than a TypeError.

interface MaybeModule {
  // measurePlacement(target): Placement — pure measure, no IPC.
  measurePlacement?: (target: HTMLElement) => ExpectedPlacement
  // createPlacementAnchor(target, { visible, publish }): handle whose
  // `publish` sink receives an explicit Placement (not bare Bounds).
  createPlacementAnchor?: (
    target: HTMLElement,
    opts: {
      visible: boolean
      publish: (placement: ExpectedPlacement) => void
    },
  ) => { update(opts: unknown): void; dispose(): void }
}

const mod = viewAnchorModule as MaybeModule

function measurePlacement(target: HTMLElement): ExpectedPlacement {
  const fn = mod.measurePlacement
  expect(
    typeof fn,
    'explicit API `measurePlacement` must be a function export from view-anchor',
  ).toBe('function')
  return fn!(target)
}

function createPlacementAnchor(
  target: HTMLElement,
  opts: {
    visible: boolean
    publish: (placement: ExpectedPlacement) => void
  },
): { update(opts: unknown): void; dispose(): void } {
  const fn = mod.createPlacementAnchor
  expect(
    typeof fn,
    'explicit API `createPlacementAnchor` must be a function export from view-anchor',
  ).toBe('function')
  return fn!(target, opts)
}

// A bare ZERO bounds — the magic value the OLD API uses for "hidden". The
// whole point of the explicit Placement is that "hidden" is NEVER this.
const ZERO_BOUNDS: Bounds = { x: 0, y: 0, width: 0, height: 0 }

// ─────────────────────────────────────────────────────────────────────
// Behaviour 1 — a present/visible anchor measures to a visible Placement
// carrying the ACTUAL rect.
// ─────────────────────────────────────────────────────────────────────

describe('Placement — visible anchor measures to { visible:true, bounds }', () => {
  it('measurePlacement returns visible:true with the real (rounded/clamped) rect', () => {
    const { el } = buildElement({ x: 10, y: 20, w: 300, h: 400 })

    const p = measurePlacement(el)

    expect(p.visible).toBe(true)
    // Discriminated union: bounds only exists on the visible branch.
    expect((p as { bounds: Bounds }).bounds).toEqual({
      x: 10,
      y: 20,
      width: 300,
      height: 400,
    })
  })
})

// ─────────────────────────────────────────────────────────────────────
// Behaviour 2 — a hidden/absent anchor measures to { visible:false } and
// carries NO bounds at all. It must NOT be `{visible:true, bounds:ZERO}`
// and must NOT be a bare ZERO bounds.
// ─────────────────────────────────────────────────────────────────────

describe('Placement — hidden anchor measures to { visible:false } (no bounds)', () => {
  it('a hidden measure is { visible:false } and never a zero-bounds rect', () => {
    // A "hidden" target. The explicit API decides hiddenness from the
    // `visible:false` request, NOT from a measured 0 — so we pass the
    // request through the anchor and capture what the sink receives.
    const { el } = buildElement({ x: 0, y: 0, w: 0, h: 0 })
    const publish = vi.fn<(p: ExpectedPlacement) => void>()

    createPlacementAnchor(el, { visible: false, publish })

    expect(publish).toHaveBeenCalledTimes(1)
    const p = publish.mock.calls[0]![0]

    expect(p.visible).toBe(false)
    // The hidden Placement must NOT carry a bounds field at all…
    expect('bounds' in p).toBe(false)
    // …and must NOT be (structurally) the magic ZERO bounds the old API used.
    expect(p).not.toEqual({ visible: true, bounds: ZERO_BOUNDS })
    expect(p).not.toEqual(ZERO_BOUNDS)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Behaviour 3 — the SINK receives an explicit Placement: a consumer must
// be able to decide "hidden" purely from `placement.visible`, WITHOUT
// ever inspecting `width === 0`.
// ─────────────────────────────────────────────────────────────────────

describe('Placement — sink consumes explicit visibility, not width===0', () => {
  it('the hidden Placement is recognisable via .visible with no geometry inspection', () => {
    const { el } = buildElement({ x: 5, y: 6, w: 100, h: 100 })
    const received: ExpectedPlacement[] = []
    const handle = createPlacementAnchor(el, {
      visible: true,
      publish: (p) => received.push(p),
    })

    // Flip to hidden via the documented update path.
    handle.update({ visible: false, publish: (p: ExpectedPlacement) => received.push(p) })

    const last = received.at(-1)!
    // A consumer's hidden-check: discriminant only. This is the contract —
    // no `width === 0` anywhere.
    const isHidden = (p: ExpectedPlacement): boolean => p.visible === false
    expect(isHidden(last)).toBe(true)
    // Prove the consumer did NOT need geometry: the hidden Placement has no
    // `bounds`, so any width-based check would throw / be undefined.
    expect((last as { bounds?: Bounds }).bounds).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────
// Behaviour 4 — THE CORE BUG. A genuinely zero-SIZED but VISIBLE anchor
// (width===0, height===0, yet on-screen) must be DISTINGUISHABLE from a
// hidden one. Under the old ZERO-bounds convention both collapse to
// {0,0,0,0} and are indistinguishable. The explicit Placement resolves
// the ambiguity: real-but-zero → { visible:true, bounds:{...,width:0} };
// hidden → { visible:false }.
// ─────────────────────────────────────────────────────────────────────

describe('Placement — real 0-size is distinguishable from hidden (kills the magic 0)', () => {
  it('a visible 0×0 rect is { visible:true, bounds: zeros } — NOT { visible:false }', () => {
    // A legitimately collapsed-but-present element (e.g. a panel mid-drag
    // that measured to 0 width this frame). It is VISIBLE, just zero-sized.
    const { el } = buildElement({ x: 42, y: 99, w: 0, h: 0 })

    const p = measurePlacement(el)

    // It is VISIBLE — the geometry happens to be zero, but presence is not
    // inferred from the geometry.
    expect(p.visible).toBe(true)
    expect((p as { bounds: Bounds }).bounds).toEqual({
      x: 42,
      y: 99,
      width: 0,
      height: 0,
    })
  })

  it('visible-0x0 and hidden are NOT structurally equal (the disambiguation)', () => {
    const { el: visibleZeroEl } = buildElement({ x: 42, y: 99, w: 0, h: 0 })
    const { el: hiddenEl } = buildElement({ x: 0, y: 0, w: 0, h: 0 })

    const visibleZero = measurePlacement(visibleZeroEl)

    const hiddenReceived = vi.fn<(p: ExpectedPlacement) => void>()
    createPlacementAnchor(hiddenEl, { visible: false, publish: hiddenReceived })
    const hidden = hiddenReceived.mock.calls[0]![0]

    // The whole reason this refactor exists: these two states were the SAME
    // value ({0,0,0,0}) under the old API. Now they must differ.
    expect(visibleZero).not.toEqual(hidden)
    expect(visibleZero.visible).toBe(true)
    expect(hidden.visible).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Behaviour 5 — REGRESSION FENCE: under the explicit API, "hidden" is
// NEVER expressed as a ZERO bounds. No code path that publishes a hidden
// Placement may ever hand the sink a `{x:0,y:0,width:0,height:0}` (the
// old magic value). This is the guard that the migration didn't leave a
// ZERO-based shortcut behind.
// ─────────────────────────────────────────────────────────────────────

describe('Placement — hidden is NEVER a ZERO bounds (regression fence)', () => {
  it('every hidden publish is { visible:false }, never a ZERO rect, across update flips', () => {
    const { el, setRect } = buildElement({ x: 1, y: 2, w: 50, h: 60 })
    const received: ExpectedPlacement[] = []
    const publish = (p: ExpectedPlacement): void => {
      received.push(p)
    }

    const handle = createPlacementAnchor(el, { visible: true, publish })
    // visible → hidden → visible → hidden, exercising both directions.
    handle.update({ visible: false, publish })
    setRect({ x: 9, y: 9, w: 70, h: 80 })
    handle.update({ visible: true, publish })
    handle.update({ visible: false, publish })

    const hiddenPublishes = received.filter((p) => p.visible === false)
    expect(hiddenPublishes.length).toBeGreaterThanOrEqual(2)
    for (const p of hiddenPublishes) {
      // No hidden Placement may be (or contain) the magic ZERO bounds.
      expect(p).not.toEqual(ZERO_BOUNDS)
      expect(p).not.toEqual({ visible: true, bounds: ZERO_BOUNDS })
      expect('bounds' in p).toBe(false)
    }
  })
})
