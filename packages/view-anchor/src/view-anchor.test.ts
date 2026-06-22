import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createViewAnchor, createPlacementAnchor } from './view-anchor.js'
import type { Bounds, Placement, ViewAnchorOptions } from './types.js'

// ── ResizeObserver / RAF stubs ───────────────────────────────────────
//
//   - `FakeResizeObserver` records observed elements + disconnect, and
//     exposes `fire()` to synchronously invoke its callback.
//   - The anchor publishes SYNCHRONOUSLY (no RAF defer) — see the module
//     header. We install `requestAnimationFrame`/`cancelAnimationFrame`
//     spies NOT to drive a fake queue but as a regression guard: the anchor
//     must NEVER call either (asserted in the "never schedules a RAF" test
//     and implicitly available everywhere via `rafSpy`/`cancelSpy`).

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

// RAF regression guards: if the anchor ever re-introduces a RAF defer these
// spies will record a call, and the dedicated "never schedules a RAF" test
// fails. They do NOT queue anything — publishes are synchronous.
const rafSpy = vi.fn(() => 0)
const cancelSpy = vi.fn()
const resizeAddSpy = vi.fn()
const resizeRemoveSpy = vi.fn()
// Handlers added to the real window via the addEventListener spy, tracked so
// afterEach can remove leaked 'resize' listeners — tests create anchors
// directly and don't dispose them, so their listeners would otherwise
// accumulate across tests and fire in later tests.
let leakedResize: unknown[] = []

beforeEach(() => {
  FakeResizeObserver.instances = []
  rafSpy.mockClear()
  cancelSpy.mockClear()
  resizeAddSpy.mockClear()
  resizeRemoveSpy.mockClear()
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.stubGlobal(
    'requestAnimationFrame',
    rafSpy as unknown as typeof window.requestAnimationFrame,
  )
  vi.stubGlobal(
    'cancelAnimationFrame',
    cancelSpy as unknown as typeof window.cancelAnimationFrame,
  )

  // Spy on window resize listener add/remove so we can assert the anchor
  // installs exactly one resize listener when present, and removes it on
  // dispose / present=false. We forward to the real implementation so
  // dispatching a real 'resize' event still works.
  const realAdd = window.addEventListener.bind(window)
  const realRemove = window.removeEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation(
    (type: string, ...rest: unknown[]) => {
      if (type === 'resize') {
        resizeAddSpy(...rest)
        leakedResize.push(rest[0])
      }
      return (realAdd as unknown as (...a: unknown[]) => void)(type, ...rest)
    },
  )
  vi.spyOn(window, 'removeEventListener').mockImplementation(
    (type: string, ...rest: unknown[]) => {
      if (type === 'resize') {
        resizeRemoveSpy(...rest)
        leakedResize = leakedResize.filter((h) => h !== rest[0])
      }
      return (realRemove as unknown as (...a: unknown[]) => void)(type, ...rest)
    },
  )
})

afterEach(() => {
  // Remove resize listeners leaked by undisposed anchors before restoring
  // the spies, so they can't fire in (and pollute) a later test.
  leakedResize.forEach((h) =>
    window.removeEventListener('resize', h as EventListener),
  )
  leakedResize = []
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Assert an observer was installed, then return it. Used so a missing
 *  observer (skeleton no-op) surfaces as a clear "expected 1, got 0"
 *  behavioural assertion instead of a TypeError on a later `.fire()`. */
function firstObserver(): FakeResizeObserver {
  expect(FakeResizeObserver.instances.length).toBeGreaterThanOrEqual(1)
  return FakeResizeObserver.instances[0]!
}

/** Same, for the most-recently created observer (post-update). */
function lastObserver(): FakeResizeObserver {
  expect(FakeResizeObserver.instances.length).toBeGreaterThanOrEqual(1)
  return FakeResizeObserver.instances.at(-1)!
}

// ── Element fixture ──────────────────────────────────────────────────
//
// jsdom's `getBoundingClientRect` always returns zeros, so we stub it.
// `setRect` lets a test move the element after the anchor was created (to
// prove a tick reads the *current* rect, not a captured one).

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

const opts = (o: ViewAnchorOptions): ViewAnchorOptions => o

// ── Contract 1: present=true with geometry → immediate sync publish ──
// Bug it catches: a missing initial emit means the main process never
// learns where the view is — the native view never attaches.

describe('createViewAnchor — present=true initial sync', () => {
  it('publishes the rounded/clamped rect once, synchronously, on create', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: 10, y: 20, w: 300, h: 400 })
    createViewAnchor(el, opts({ present: true, publish }))

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({
      x: 10,
      y: 20,
      width: 300,
      height: 400,
    })
  })

  it('rounds x/y (negatives allowed) and clamps width/height to ≥0', () => {
    const publish = vi.fn()
    // Fractional + negative left/top: x/y are ROUNDED (not clamped) — an
    // element scrolled off the top/left edge has a legitimately negative
    // origin and the native view must track it there. width/height are
    // clamped to ≥0 (0 = the canonical hidden signal).
    const { el } = buildElement({ x: -3.4, y: 12.6, w: 100.49, h: 0.5 })
    createViewAnchor(el, opts({ present: true, publish }))

    expect(publish).toHaveBeenCalledWith({
      x: -3, // Math.round(-3.4) — NOT clamped to 0
      y: 13, // Math.round(12.6)
      width: 100, // Math.max(0, Math.round(100.49))
      height: 1, // Math.max(0, Math.round(0.5))
    })
  })
})

// ── Contract 2: present=false → immediate zero, no observer ──────────
// Bug it catches: if present=false does NOT publish zero, the native view
// never detaches and its old frame stays painted over the content.
// Bug it also catches: installing a ResizeObserver while detached wastes
// work and can re-publish a non-zero rect, re-attaching the view.

describe('createViewAnchor — present=false', () => {
  it('publishes {0,0,0,0} immediately and does NOT observe', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: 10, y: 20, w: 300, h: 400 })
    createViewAnchor(el, opts({ present: false, publish }))

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 })
    // No ResizeObserver and no resize listener while detached.
    expect(FakeResizeObserver.instances).toHaveLength(0)
    expect(resizeAddSpy).not.toHaveBeenCalled()
  })
})

// ── Contract 3: present=true installs observers; ticks publish SYNC ──
// Bug it catches: a tick that defers to a RAF stacks a second compositor
// frame on top of the unavoidable cross-process frame — the overlay
// visibly trails the region edge during a drag. The new contract is to
// publish in the triggering tick itself, no RAF.

describe('createViewAnchor — present=true observation', () => {
  it('observes the target and adds a window resize listener', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    createViewAnchor(el, opts({ present: true, publish }))

    expect(FakeResizeObserver.instances).toHaveLength(1)
    expect(FakeResizeObserver.instances[0]!.observed).toContain(el)
    expect(resizeAddSpy).toHaveBeenCalledTimes(1)
  })

  it('a ResizeObserver tick re-publishes SYNCHRONOUSLY (no RAF) with the current rect', () => {
    const publish = vi.fn()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    createViewAnchor(el, opts({ present: true, publish }))
    publish.mockClear()

    // Move the element, then fire the observer — the publish lands in the
    // same synchronous tick, reading the *current* rect.
    setRect({ x: 5, y: 6, w: 120, h: 130 })
    firstObserver().fire()

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ x: 5, y: 6, width: 120, height: 130 })
  })

  it('a window resize tick re-publishes synchronously', () => {
    const publish = vi.fn()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    createViewAnchor(el, opts({ present: true, publish }))
    publish.mockClear()

    setRect({ x: 1, y: 2, w: 50, h: 60 })
    window.dispatchEvent(new Event('resize'))

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ x: 1, y: 2, width: 50, height: 60 })
  })

  it('never schedules a requestAnimationFrame (RAF defer must not creep back)', () => {
    const publish = vi.fn()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const handle = createViewAnchor(el, opts({ present: true, publish }))

    // Exercise every code path that used to schedule a RAF.
    setRect({ x: 5, y: 6, w: 120, h: 130 })
    firstObserver().fire()
    window.dispatchEvent(new Event('resize'))
    handle.update({ present: false, publish })

    expect(rafSpy).not.toHaveBeenCalled()
    expect(cancelSpy).not.toHaveBeenCalled()
  })
})

// ── Contract 4: dedup-coalescing ─────────────────────────────────────
// Bug it catches: without dedup, a burst of RO+resize ticks in one frame —
// or a continuous drag that keeps re-firing the same final rect — produces N
// publishes (and N native-view setBounds calls) → IPC flood / jitter. The
// contract: a tick whose measured rect is byte-identical to the last published
// one is dropped; a distinct rect always publishes.

describe('createViewAnchor — dedup coalescing', () => {
  it('N ticks measuring the SAME rect → exactly ONE publish', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    createViewAnchor(el, opts({ present: true, publish }))
    publish.mockClear()

    // A same-frame burst of RO + resize, all measuring the same (unchanged)
    // rect: only the first emits, the rest dedup away.
    const ro = firstObserver()
    ro.fire()
    ro.fire()
    window.dispatchEvent(new Event('resize'))
    ro.fire()

    expect(publish).not.toHaveBeenCalled() // rect unchanged since create
  })

  it('a tick whose rect differs from the create-time rect publishes once', () => {
    const publish = vi.fn()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    createViewAnchor(el, opts({ present: true, publish }))
    publish.mockClear()

    setRect({ x: 7, y: 8, w: 110, h: 120 })
    firstObserver().fire()
    firstObserver().fire() // same rect again → deduped

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ x: 7, y: 8, width: 110, height: 120 })
  })

  it('ticks measuring DIFFERENT rects each publish; identical rects dedup', () => {
    const publish = vi.fn()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    createViewAnchor(el, opts({ present: true, publish }))
    publish.mockClear()
    const ro = firstObserver()

    // Move → publish.
    setRect({ x: 5, y: 5, w: 100, h: 100 })
    ro.fire()
    // Same rect twice more → deduped.
    ro.fire()
    ro.fire()
    // Move again → publish.
    setRect({ x: 5, y: 5, w: 200, h: 100 })
    ro.fire()
    // Move back to the first moved rect → distinct from last published → publish.
    setRect({ x: 5, y: 5, w: 100, h: 100 })
    ro.fire()

    expect(publish).toHaveBeenCalledTimes(3)
    expect(publish.mock.calls.map((c) => c[0])).toEqual([
      { x: 5, y: 5, width: 100, height: 100 },
      { x: 5, y: 5, width: 200, height: 100 },
      { x: 5, y: 5, width: 100, height: 100 },
    ])
  })
})

// ── Contract 5: update() re-publishes immediately per new state ──────
// Bug it catches: update() that defers (or no-ops) leaves the native view
// at its old bounds after a present flip — e.g. a panel that hid stays
// painted, or a panel that showed never re-measures.

describe('createViewAnchor — update()', () => {
  it('true → false: publishes zero immediately and stops observing', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const handle = createViewAnchor(el, opts({ present: true, publish }))
    expect(firstObserver().disconnected).toBe(false)
    publish.mockClear()

    handle.update({ present: false, publish })

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 })
    // Observer disconnected and resize listener removed.
    expect(firstObserver().disconnected).toBe(true)
    expect(resizeRemoveSpy).toHaveBeenCalledTimes(1)
  })

  it('false → true: measures the current rect and starts observing', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: 7, y: 8, w: 90, h: 110 })
    const handle = createViewAnchor(el, opts({ present: false, publish }))
    // present=false start: zero, no observer.
    expect(FakeResizeObserver.instances).toHaveLength(0)
    publish.mockClear()

    handle.update({ present: true, publish })

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ x: 7, y: 8, width: 90, height: 110 })
    expect(FakeResizeObserver.instances).toHaveLength(1)
    expect(FakeResizeObserver.instances[0]!.observed).toContain(el)
  })

  it('swapping publish while present routes new emits to the new callback', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const handle = createViewAnchor(el, opts({ present: true, publish: first }))
    first.mockClear()

    handle.update({ present: true, publish: second })
    // Immediate re-publish goes to the new callback (apply() resets
    // lastPublished, so an unchanged rect still emits — see next test).
    expect(second).toHaveBeenCalledWith({ x: 0, y: 0, width: 100, height: 100 })

    second.mockClear()
    setRect({ x: 5, y: 5, w: 100, h: 100 })
    lastObserver().fire()
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })

  it('update() with an unchanged rect still forces one publish (lastPublished reset)', () => {
    // Why this matters: zoom rides in the `publish` closure, not in `Bounds`.
    // A zoom change re-calls update() with the SAME geometry but a NEW publish
    // closure — the anchor must re-emit so the new closure runs, even though
    // the dedup would otherwise drop a byte-identical rect. `apply()` resets
    // `lastPublished = null` to guarantee that one fresh publish.
    const first = vi.fn()
    const { el } = buildElement({ x: 12, y: 34, w: 56, h: 78 })
    const handle = createViewAnchor(el, opts({ present: true, publish: first }))
    expect(first).toHaveBeenCalledTimes(1)

    // Same present/measure, unchanged geometry, but a brand-new publish spy.
    const second = vi.fn()
    handle.update({ present: true, publish: second })

    expect(second).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledWith({ x: 12, y: 34, width: 56, height: 78 })
  })
})

// ── Contract 6: dispose() tears everything down ─────────────────────
// Bug it catches: a dispose that forgets to disconnect the RO / remove the
// resize listener leaks observers and can publish after teardown (the IPC
// target may already be gone → throw).

describe('createViewAnchor — dispose()', () => {
  it('disconnects the observer and removes the resize listener', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const handle = createViewAnchor(el, opts({ present: true, publish }))

    handle.dispose()

    expect(firstObserver().disconnected).toBe(true)
    expect(resizeRemoveSpy).toHaveBeenCalledTimes(1)
    // Teardown is synchronous and uses no RAF — nothing to cancel.
    expect(cancelSpy).not.toHaveBeenCalled()
  })

  it('never publishes again after dispose (later RO/resize events are ignored)', () => {
    const publish = vi.fn()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const handle = createViewAnchor(el, opts({ present: true, publish }))
    const ro = firstObserver()
    handle.dispose()
    publish.mockClear()

    // Move the element so a non-deduped rect WOULD publish if `disposed`
    // weren't read synchronously in every emit. Any event after dispose
    // must be inert — there is no queued frame to outrun the flag.
    setRect({ x: 999, y: 999, w: 999, h: 999 })
    ro.fire()
    window.dispatchEvent(new Event('resize'))
    expect(publish).not.toHaveBeenCalled()
  })
})

// ── Contract 7: teardown safety (no stale tick can overwrite live) ───
// There is no queued frame anymore, so the old "stale-RAF guard" is now a
// pure synchronous-read guard: every emit reads `disposed`/`present` live,
// so a tick after dispose()/update(present=false) can never write a stale
// rect over the live one.

describe('createViewAnchor — teardown safety', () => {
  it('a tick after dispose() does not publish (disposed read synchronously)', () => {
    const publish = vi.fn()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const handle = createViewAnchor(el, opts({ present: true, publish }))
    const ro = firstObserver()
    publish.mockClear()

    handle.dispose()
    setRect({ x: 999, y: 999, w: 999, h: 999 })
    ro.fire()

    expect(publish).not.toHaveBeenCalled()
  })

  it('after update(present=false), a later tick does not publish a non-zero rect', () => {
    const publish = vi.fn()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const handle = createViewAnchor(el, opts({ present: true, publish }))
    const ro = firstObserver()

    // Flip to present=false → synchronous zero, observers stopped.
    handle.update({ present: false, publish })
    expect(publish).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 0, height: 0 })
    publish.mockClear()

    // A late tick (e.g. a detached-but-not-yet-GC'd observer reference) must
    // not republish a non-zero rect over the zero — `present` is read live.
    setRect({ x: 999, y: 999, w: 999, h: 999 })
    ro.fire()
    window.dispatchEvent(new Event('resize'))
    expect(publish).not.toHaveBeenCalled()
  })
})

// Local type assertion so the file fails loudly if the Bounds shape drifts
// from what these tests assert against.
const _boundsShape: Bounds = { x: 0, y: 0, width: 0, height: 0 }
void _boundsShape

// ── display:none / first-frame guard (opt-in) ───────────────────────
//
// An ADDITIVE, OPT-IN hardening of `createPlacementAnchor`, gated behind the
// `guardDisplayNone?: boolean` option (default false = the unguarded
// behaviour).
//
// Two behaviours, ONLY when `guardDisplayNone: true`:
//   First-frame guard — `visible:true` but the measured rect has
//      `width === 0 || height === 0` (no geometry box: unmounted /
//      display:none / unstable first layout) → publish `{ visible:false }`
//      (a detach, NO bounds) instead of `{ visible:true, bounds:{...,0,0} }`.
//      A 0-area target has no geometry to anchor; emitting a detach avoids
//      the native view flashing at (0,0). NOTE: only ZERO WIDTH OR HEIGHT
//      triggers this — a NON-zero box at position (0,0) is still a normal
//      `{ visible:true }`.
//   display:none guard — the anchor attaches an `IntersectionObserver` on the
//      target. When the target goes display:none (IO reports
//      `isIntersecting:false` with a zero-area `boundingClientRect`) → publish
//      `{ visible:false }`. When it comes back with a non-zero box (IO
//      intersecting again / a subsequent measure yields non-zero
//      width&height) → re-measure → publish `{ visible:true, bounds }`.
//
// Caller intent still wins: a caller-`visible:false` anchor is detached
// regardless — the guard NEVER flips a caller's `visible:false` to true, and
// NEVER detaches purely because a NON-zero box scrolled off-screen (a non-zero
// box at a negative/off-screen origin stays `visible:true` with its real,
// possibly negative-origin, bounds).
//
// This guard adds an IntersectionObserver, NOT a RAF — so the existing
// "never schedules a requestAnimationFrame" guard stays valid. We assert it
// here too (`rafSpy`/`cancelSpy` from the shared harness).

// A controllable fake IntersectionObserver (jsdom has none). Mirrors the
// FakeResizeObserver style: records observed elements + disconnect, captures
// every instance, and exposes `trigger(entries)` to synchronously invoke its
// callback with a partial IntersectionObserverEntry list (only the fields the
// guard reads: `isIntersecting` + `boundingClientRect`).
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = []
  observed: Element[] = []
  disconnected = false
  constructor(public cb: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this)
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
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
  // Drive the callback synchronously. Tests pass the minimal entry shape the
  // guard inspects; we widen to the full entry type so `cb` typechecks.
  trigger(
    entries: Array<{
      isIntersecting: boolean
      boundingClientRect: { width: number; height: number }
    }>,
  ): void {
    this.cb(
      entries as unknown as IntersectionObserverEntry[],
      this as unknown as IntersectionObserver,
    )
  }
}

describe('createPlacementAnchor — display:none / first-frame guard (opt-in)', () => {
  beforeEach(() => {
    FakeIntersectionObserver.instances = []
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  })
  // (The shared afterEach calls vi.unstubAllGlobals(), which removes the
  //  IntersectionObserver stub too — no extra teardown needed here.)

  /** Assert an IntersectionObserver was installed, then return it (a missing
   *  one surfaces as a clear "expected ≥1, got 0" instead of a later
   *  TypeError on `.trigger()`). */
  function firstIO(): FakeIntersectionObserver {
    expect(FakeIntersectionObserver.instances.length).toBeGreaterThanOrEqual(1)
    return FakeIntersectionObserver.instances[0]!
  }

  const HIDDEN: Placement = { visible: false }

  // a) first measure 0×0 with the guard ON → detach, not visible+0×0.
  it('a) guardDisplayNone:true + first measure 0×0 → publishes { visible:false } (not visible:true+0×0)', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el } = buildElement({ x: 42, y: 99, w: 0, h: 0 })

    createPlacementAnchor(el, {
      visible: true,
      guardDisplayNone: true,
      publish,
    } as Parameters<typeof createPlacementAnchor>[1])

    expect(publish).toHaveBeenCalledTimes(1)
    const p = publish.mock.calls[0]![0]
    expect(p).toEqual(HIDDEN)
    expect(p.visible).toBe(false)
    expect('bounds' in p).toBe(false)
    // Must NOT be the legitimate-0×0-visible value the default path emits.
    expect(p).not.toEqual({ visible: true, bounds: { x: 42, y: 99, width: 0, height: 0 } })
    // No RAF introduced by the guard.
    expect(rafSpy).not.toHaveBeenCalled()
  })

  // b) first measure non-zero box with the guard ON → normal visible publish.
  it('b) guardDisplayNone:true + first measure non-zero box → publishes { visible:true, bounds }', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el } = buildElement({ x: 10, y: 20, w: 300, h: 400 })

    createPlacementAnchor(el, {
      visible: true,
      guardDisplayNone: true,
      publish,
    } as Parameters<typeof createPlacementAnchor>[1])

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: 10, y: 20, width: 300, height: 400 },
    })
    // Guard installs an IntersectionObserver on the target.
    expect(firstIO().observed).toContain(el)
  })

  // c) display:none round-trip: visible → IO display:none → detach → restore → visible.
  it('c) IO display:none transition publishes { visible:false }; a restored non-zero box re-publishes { visible:true, bounds }', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el, setRect } = buildElement({ x: 5, y: 6, w: 100, h: 120 })

    createPlacementAnchor(el, {
      visible: true,
      guardDisplayNone: true,
      publish,
    } as Parameters<typeof createPlacementAnchor>[1])
    // Initial: normal visible publish.
    expect(publish).toHaveBeenLastCalledWith({
      visible: true,
      bounds: { x: 5, y: 6, width: 100, height: 120 },
    })
    publish.mockClear()

    // Target goes display:none: IO reports not-intersecting + a zero-area box.
    setRect({ x: 0, y: 0, w: 0, h: 0 })
    firstIO().trigger([
      { isIntersecting: false, boundingClientRect: { width: 0, height: 0 } },
    ])

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenLastCalledWith(HIDDEN)
    publish.mockClear()

    // Target comes back with a real box. A subsequent tick (ResizeObserver or
    // IO intersecting) re-measures a non-zero box → visible again.
    setRect({ x: 5, y: 6, w: 100, h: 120 })
    firstIO().trigger([
      { isIntersecting: true, boundingClientRect: { width: 100, height: 120 } },
    ])

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenLastCalledWith({
      visible: true,
      bounds: { x: 5, y: 6, width: 100, height: 120 },
    })
  })

  // d) caller visible:false wins — IO intersecting must NOT flip it to visible.
  it('d) caller visible:false → detached; an IO "intersecting" tick does NOT flip to visible:true', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el } = buildElement({ x: 5, y: 6, w: 100, h: 120 })

    createPlacementAnchor(el, {
      visible: false,
      guardDisplayNone: true,
      publish,
    } as Parameters<typeof createPlacementAnchor>[1])

    // Detached on create.
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenLastCalledWith(HIDDEN)
    publish.mockClear()

    // Even if the guard's IO fires "intersecting" with a real box, caller
    // intent (visible:false) wins — no visible:true is published.
    if (FakeIntersectionObserver.instances.length > 0) {
      FakeIntersectionObserver.instances[0]!.trigger([
        { isIntersecting: true, boundingClientRect: { width: 100, height: 120 } },
      ])
    }

    expect(publish).not.toHaveBeenCalled()
  })

  // e) non-zero box at a negative/off-screen origin → visible:true, negative origin preserved.
  it('e) non-zero box at negative origin → { visible:true, bounds } (off-screen ≠ detach; negative origin kept)', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el } = buildElement({ x: -50, y: -20, w: 300, h: 200 })

    createPlacementAnchor(el, {
      visible: true,
      guardDisplayNone: true,
      publish,
    } as Parameters<typeof createPlacementAnchor>[1])

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: -50, y: -20, width: 300, height: 200 },
    })
  })

  // f) default-off regression: WITHOUT the option, 0×0 stays visible:true+0×0.
  it('f) default (no guardDisplayNone): 0×0 measure → { visible:true, bounds:0×0 } unchanged', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el } = buildElement({ x: 42, y: 99, w: 0, h: 0 })

    createPlacementAnchor(el, { visible: true, publish })

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: 42, y: 99, width: 0, height: 0 },
    })
    // Default off must NOT install an IntersectionObserver.
    expect(FakeIntersectionObserver.instances).toHaveLength(0)
  })

  // g) dispose disconnects the IO and no late IO callback publishes.
  it('g) dispose() disconnects the IntersectionObserver and a late IO trigger publishes nothing', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el, setRect } = buildElement({ x: 5, y: 6, w: 100, h: 120 })

    const handle = createPlacementAnchor(el, {
      visible: true,
      guardDisplayNone: true,
      publish,
    } as Parameters<typeof createPlacementAnchor>[1])
    const io = firstIO()
    expect(io.disconnected).toBe(false)

    handle.dispose()
    expect(io.disconnected).toBe(true)
    publish.mockClear()

    // A late IO callback after dispose must be inert (disposed read live).
    setRect({ x: 0, y: 0, w: 0, h: 0 })
    io.trigger([
      { isIntersecting: false, boundingClientRect: { width: 0, height: 0 } },
    ])

    expect(publish).not.toHaveBeenCalled()
  })
})

// ── scroll + windowed RAF geometry sentinel (opt-in) ────
//
// ADDITIVE, OPT-IN follow options on `createPlacementAnchor`. Both default
// OFF (= the unfollowed behaviour).
//
//   followScroll?: boolean   — ancestor-scroll capture listener.
//   followGeometry?: boolean — windowed RAF geometry sentinel.
//   pulse(durationMs?)       — imperative "open the sentinel window".
//
// ────────────────────────────────────────────────────────────────────
// The package-wide "never RAF" invariant is INTENTIONALLY NARROWED by
// `followGeometry` (opt-in) to "EVENT-driven publishes (ResizeObserver /
// window resize / scroll) are never RAF-deferred". The sentinel rAF is a
// POLLING mechanism that publishes SYNCHRONOUSLY within its own frame — it is
// NOT a deferral of an event-driven publish. The `createViewAnchor` "never
// schedules a requestAnimationFrame" test (above) stays valid, because
// `followGeometry` defaults off and the forward `createViewAnchor` core never
// opts in. The tests below re-pin that the DEFAULT / event-driven paths still
// schedule NO rAF, so the guarantee holds wherever the sentinel is off.
// ────────────────────────────────────────────────────────────────────

// A CONTROLLABLE fake requestAnimationFrame. The shared `rafSpy` only
// returns 0 and stores nothing (it's a regression guard, not a driver), so
// the sentinel — which actually schedules frames — needs a queue we can
// flush one frame at a time. This block installs its own rAF/cancel stubs
// over the shared ones (the outer afterEach's vi.unstubAllGlobals() clears
// them, mirroring how the display:none block stubs IntersectionObserver).
class FakeRaf {
  // Pending callbacks keyed by handle. A frame is "scheduled" while non-empty.
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
  /** Drain exactly the callbacks pending at call-time and run each once.
   *  A callback that re-requests another frame (the sentinel re-arming for
   *  the next poll) is NOT run again this flush — it lands in the next one,
   *  so `flushFrame()` advances exactly one frame. */
  flushFrame(ts = 0): void {
    const pending = [...this.cbs.entries()]
    this.cbs.clear()
    for (const [, cb] of pending) cb(ts)
  }
  /** Is a frame currently scheduled (sentinel window still open)? */
  get pending(): number {
    return this.cbs.size
  }
}

describe('createPlacementAnchor — scroll + windowed RAF geometry sentinel (opt-in, increment 2)', () => {
  let raf: FakeRaf

  beforeEach(() => {
    raf = new FakeRaf()
    // Install a controllable rAF over the shared regression-guard `rafSpy`.
    // The outer afterEach's vi.unstubAllGlobals() restores everything.
    vi.stubGlobal(
      'requestAnimationFrame',
      raf.request as unknown as typeof window.requestAnimationFrame,
    )
    vi.stubGlobal(
      'cancelAnimationFrame',
      raf.cancel as unknown as typeof window.cancelAnimationFrame,
    )
  })

  /** Build a `[role="separator"]` splitter element (the drag handle). A
   *  capture-phase pointerdown whose target matches `[role="separator"]`
   *  opens the sentinel window. */
  function buildSplitter(): HTMLElement {
    const sep = document.createElement('div')
    sep.setAttribute('role', 'separator')
    document.body.appendChild(sep)
    return sep
  }

  /** Dispatch a capture-phase scroll on window (an ancestor scroll container
   *  scrolling — scroll doesn't bubble, but reaches window in capture). */
  function dispatchCaptureScroll(): void {
    window.dispatchEvent(new Event('scroll'))
  }

  /** Dispatch a real bubbling+capturable pointerdown originating at `target`
   *  (so a window capture-phase listener filtering on `[role="separator"]`
   *  sees it). */
  function dispatchPointerdown(target: HTMLElement): void {
    target.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  }

  /** Pointer release — ends a splitter drag so the sentinel may steady-close
   *  (close only happens after release). Dispatched bubbling from the target
   *  and on window directly so a capture/bubble window listener sees it. */
  function dispatchPointerup(target: HTMLElement): void {
    target.dispatchEvent(new Event('pointerup', { bubbles: true }))
    window.dispatchEvent(new Event('pointerup'))
  }

  // Cast helpers: the new options/method aren't on the public types yet.
  type FollowOpts = Parameters<typeof createPlacementAnchor>[1] & {
    followScroll?: boolean
    followGeometry?: boolean
  }
  type PulseHandle = ReturnType<typeof createPlacementAnchor> & {
    pulse: (durationMs?: number) => void
  }
  const mk = (
    el: HTMLElement,
    o: { visible: boolean; publish: (p: Placement) => void } & {
      followScroll?: boolean
      followGeometry?: boolean
    },
  ): PulseHandle =>
    createPlacementAnchor(el, o as FollowOpts) as PulseHandle

  // ── A. followScroll — capture-phase ancestor scroll ──────────

  // A1: capture scroll re-publishes the freshly-measured rect (basic scroll
  //     follow works WITHOUT the geometry sentinel — with followGeometry off,
  //     the scroll callback still does a single synchronous emit()).
  it('A1) followScroll (followGeometry off): a capture-phase scroll re-publishes the new measured rect synchronously', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    mk(el, { visible: true, followScroll: true, publish })
    publish.mockClear()

    // Ancestor scrolled → element's screen rect moved (y changed).
    setRect({ x: 0, y: -40, w: 100, h: 100 })
    dispatchCaptureScroll()

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenLastCalledWith({
      visible: true,
      bounds: { x: 0, y: -40, width: 100, height: 100 },
    })
    // With followGeometry OFF, scroll-follow is purely synchronous: no rAF.
    expect(raf.request).not.toHaveBeenCalled()
  })

  // A2: the scroll listener is registered with { capture:true } and removed
  //     on dispose. We assert via window.addEventListener / removeEventListener
  //     spies (the shared beforeEach already spies addEventListener; we read
  //     its recorded calls).
  it('A2) followScroll registers a capture-phase window scroll listener and removes it on dispose', () => {
    const addCalls: Array<[string, unknown, unknown]> = []
    const removeCalls: Array<[string, unknown, unknown]> = []
    const addSpy = vi
      .spyOn(window, 'addEventListener')
      .mockImplementation((type: string, cb: unknown, optsArg?: unknown) => {
        addCalls.push([type, cb, optsArg])
      })
    const removeSpy = vi
      .spyOn(window, 'removeEventListener')
      .mockImplementation((type: string, cb: unknown, optsArg?: unknown) => {
        removeCalls.push([type, cb, optsArg])
      })

    const publish = vi.fn<(p: Placement) => void>()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const handle = mk(el, { visible: true, followScroll: true, publish })

    const scrollAdd = addCalls.find(([t]) => t === 'scroll')
    expect(scrollAdd, 'a window scroll listener must be registered').toBeDefined()
    // Capture phase — either `true` or `{ capture: true }`.
    const optArg = scrollAdd![2]
    const isCapture =
      optArg === true ||
      (typeof optArg === 'object' &&
        optArg !== null &&
        (optArg as { capture?: boolean }).capture === true)
    expect(isCapture, 'scroll listener must be capture-phase').toBe(true)

    const scrollCb = scrollAdd![1]
    handle.dispose()
    const scrollRemove = removeCalls.find(
      ([t, cb]) => t === 'scroll' && cb === scrollCb,
    )
    expect(
      scrollRemove,
      'the same scroll listener must be removed on dispose',
    ).toBeDefined()

    addSpy.mockRestore()
    removeSpy.mockRestore()
  })

  // A3: a followScroll capture-scroll OPENS the RAF sentinel window when
  //     followGeometry is ALSO on (so it follows every frame of a scroll
  //     burst, not just the one synchronous emit).
  it('A3) followScroll + followGeometry: a capture scroll opens the RAF sentinel (a frame becomes scheduled)', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    mk(el, {
      visible: true,
      followScroll: true,
      followGeometry: true,
      publish,
    })
    // Idle: no sentinel frame yet.
    expect(raf.request).not.toHaveBeenCalled()

    dispatchCaptureScroll()

    // The scroll opened the windowed sentinel → a frame is scheduled.
    expect(raf.request).toHaveBeenCalled()
    expect(raf.pending).toBeGreaterThanOrEqual(1)
  })

  // ── B. followGeometry — windowed RAF geometry sentinel ─────

  // B-idle: IDLE (no scroll / pointerdown / pulse) schedules NO rAF.
  //   The sentinel is windowed: static cost is exactly zero.
  it('B-idle) followGeometry on but idle: NO rAF is ever scheduled (windowed = zero static cost)', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    mk(el, { visible: true, followGeometry: true, publish })

    // Even an ordinary ResizeObserver tick (event-driven) must not open the
    // sentinel — it publishes synchronously instead (see B-sync below).
    setRect({ x: 1, y: 1, w: 100, h: 100 })
    firstObserver().fire()

    expect(raf.request).not.toHaveBeenCalled()
  })

  // B-open: a splitter pointerdown (capture, matching [role="separator"])
  //   opens the sentinel when followGeometry:true.
  it('B-open) a capture-phase pointerdown on a [role="separator"] opens the RAF sentinel', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    mk(el, { visible: true, followGeometry: true, publish })
    const splitter = buildSplitter()
    expect(raf.request).not.toHaveBeenCalled()

    dispatchPointerdown(splitter)

    expect(raf.request).toHaveBeenCalled()
    expect(raf.pending).toBeGreaterThanOrEqual(1)
  })

  // B-open-nonseparator: a pointerdown NOT on a separator must NOT open it.
  it('B-open-nonseparator) a pointerdown on a non-separator element does NOT open the sentinel', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    mk(el, { visible: true, followGeometry: true, publish })
    const plain = document.createElement('div')
    document.body.appendChild(plain)

    dispatchPointerdown(plain)

    expect(raf.request).not.toHaveBeenCalled()
  })

  // B-follow: once open, each frame whose measured rect CHANGED publishes the
  //   new rect SYNCHRONOUSLY IN THAT rAF callback (not deferred to a nested
  //   rAF). We assert via rect values + that publish happened during flushFrame
  //   (i.e. exactly one publish per changed frame, not coalesced/deferred).
  it('B-follow) open sentinel + rect changes each frame → publishes the new rect in-frame, one per changed frame', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    mk(el, { visible: true, followGeometry: true, publish })
    const splitter = buildSplitter()

    dispatchPointerdown(splitter) // open the window
    publish.mockClear()

    // Frame 1: rect moved → publish in-frame.
    setRect({ x: 10, y: 0, w: 100, h: 100 })
    raf.flushFrame()
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenLastCalledWith({
      visible: true,
      bounds: { x: 10, y: 0, width: 100, height: 100 },
    })
    // The publish happened DURING the rAF callback, not queued for another
    // frame: after the flush returned, the call count is already 1 (no nested
    // defer). The sentinel re-arms for the next frame (window still open).
    expect(raf.request.mock.calls.length).toBeGreaterThanOrEqual(2)

    // Frame 2: moved again → another in-frame publish.
    setRect({ x: 20, y: 0, w: 100, h: 100 })
    raf.flushFrame()
    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenLastCalledWith({
      visible: true,
      bounds: { x: 20, y: 0, width: 100, height: 100 },
    })
  })

  // B-close: after the pointer is RELEASED, N=2 consecutive UNCHANGED frames
  //   cancel the rAF (steady = stop) — no further frame scheduled. A steady run
  //   while the pointer is still HELD is a mid-drag pause and must NOT close
  //   (see follow-geometry-press-drag.fix.test.ts); close is gated on pointerup,
  //   so this test releases before going steady.
  it('B-close) pointerup then N=2 consecutive unchanged frames → sentinel stops (cancelAnimationFrame / no further frame scheduled)', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    mk(el, { visible: true, followGeometry: true, publish })
    const splitter = buildSplitter()

    dispatchPointerdown(splitter) // open
    // One changing frame to prove it's live, then release and go steady.
    setRect({ x: 30, y: 0, w: 100, h: 100 })
    raf.flushFrame()
    expect(raf.pending).toBeGreaterThanOrEqual(1) // still polling
    dispatchPointerup(splitter) // drag over → steady-close now permitted

    // Steady frame 1 (rect identical to last published) — not yet closed
    // (N=2 needs TWO consecutive identical frames).
    raf.flushFrame()
    // Steady frame 2 — now N=2 consecutive identical → close window.
    raf.flushFrame()

    // The sentinel cancelled / stopped re-arming: no frame is pending and a
    // further flush runs nothing (no new publishes, no re-scheduled frame).
    const requestsBefore = raf.request.mock.calls.length
    raf.flushFrame()
    expect(raf.pending).toBe(0)
    expect(raf.request.mock.calls.length).toBe(requestsBefore)
  })

  // ── F. pulse() — explicit window open ────────────────────────

  // F-open: pulse() opens the sentinel and it follows subsequent rect changes.
  it('F-open) pulse() opens the sentinel; it follows rect changes on subsequent frames', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const handle = mk(el, { visible: true, followGeometry: true, publish })
    expect(raf.request).not.toHaveBeenCalled()

    handle.pulse()
    expect(raf.request).toHaveBeenCalled()
    publish.mockClear()

    // A transform/animation moved the rect (no DOM event) → sentinel catches it.
    setRect({ x: 7, y: 9, w: 100, h: 100 })
    raf.flushFrame()
    expect(publish).toHaveBeenLastCalledWith({
      visible: true,
      bounds: { x: 7, y: 9, width: 100, height: 100 },
    })
  })

  // F-close: pulse()'d window auto-closes ("durationMs 后或判静止后自动关")
  //   — by steady frames (N=2 identical) here. After close, no frame pending.
  it('F-close) pulse() window auto-closes after it goes steady (N=2 identical frames)', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const handle = mk(el, { visible: true, followGeometry: true, publish })

    handle.pulse()
    // One change, then steady.
    setRect({ x: 4, y: 4, w: 100, h: 100 })
    raf.flushFrame()
    raf.flushFrame() // steady 1
    raf.flushFrame() // steady 2 → close

    const requestsBefore = raf.request.mock.calls.length
    raf.flushFrame()
    expect(raf.pending).toBe(0)
    expect(raf.request.mock.calls.length).toBe(requestsBefore)
  })

  // ── Event-driven publishes stay SYNCHRONOUS even with the sentinel enabled;
  //    the sentinel rAF publishes in-frame, not deferred. ──

  // B-sync: a ResizeObserver tick still publishes SYNCHRONOUSLY (in the event
  //   stack) WITHOUT scheduling a rAF, even with followGeometry enabled. This
  //   is the narrowing made concrete: event-driven ≠ RAF-deferred.
  it('with followGeometry ENABLED, a ResizeObserver tick publishes synchronously and schedules NO rAF', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    mk(el, { visible: true, followGeometry: true, publish })
    publish.mockClear()

    setRect({ x: 3, y: 4, w: 100, h: 100 })
    firstObserver().fire()

    // Published in the synchronous RO tick…
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenLastCalledWith({
      visible: true,
      bounds: { x: 3, y: 4, width: 100, height: 100 },
    })
    // …and the event-driven path did NOT route through a rAF (the invariant
    // survives, narrowed: event-driven publishes are never RAF-deferred).
    expect(raf.request).not.toHaveBeenCalled()
  })

  // Default-path "still no rAF": with followGeometry OFF / unset, NOTHING in
  //   the increment-2 surface schedules a rAF — the original package-wide
  //   "never RAF" guarantee holds for the default + event-driven paths.
  it('followGeometry OFF (default): RO + resize + scroll-less lifecycle schedules NO rAF', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const handle = mk(el, { visible: true, publish }) // followGeometry unset

    setRect({ x: 5, y: 6, w: 120, h: 130 })
    firstObserver().fire()
    window.dispatchEvent(new Event('resize'))
    handle.update({ visible: false, publish } as Parameters<
      typeof createPlacementAnchor
    >[1])

    expect(raf.request).not.toHaveBeenCalled()
    expect(raf.cancel).not.toHaveBeenCalled()
  })
})
