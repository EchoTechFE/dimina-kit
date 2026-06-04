import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createViewAnchor } from './view-anchor'
import type { Bounds, ViewAnchorOptions } from './types'

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
    el.dispatchEvent(new Event('scroll'))
    handle.update({ present: false, publish })

    expect(rafSpy).not.toHaveBeenCalled()
    expect(cancelSpy).not.toHaveBeenCalled()
  })
})

// ── Contract 4: dedup-coalescing ─────────────────────────────────────
// Bug it catches: without dedup, a burst of RO+scroll+resize ticks in one
// frame — or a continuous drag that keeps re-firing the same final rect —
// produces N publishes (and N native-view setBounds calls) → IPC flood /
// jitter. The contract: a tick whose measured rect is byte-identical to the
// last published one is dropped; a distinct rect always publishes.

describe('createViewAnchor — dedup coalescing', () => {
  it('N ticks measuring the SAME rect → exactly ONE publish', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    createViewAnchor(el, opts({ present: true, publish }))
    publish.mockClear()

    // A same-frame burst of RO + scroll + resize, all measuring the same
    // (unchanged) rect: only the first emits, the rest dedup away.
    const ro = firstObserver()
    ro.fire()
    ro.fire()
    window.dispatchEvent(new Event('resize'))
    el.dispatchEvent(new Event('scroll'))
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

  it('never publishes again after dispose (later RO/scroll/resize events are ignored)', () => {
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
    el.dispatchEvent(new Event('scroll'))
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

// ── Contract 8: measure() override — publish source redirection ──────
// Bug it catches: the anchor publishing `target.getBoundingClientRect()`
// instead of `measure()` means a caller that owns a transformed/derived
// rect (e.g. a zoomed simulator viewport) can never override WHAT bounds
// are published. These tests prove the published rect comes from `measure`,
// that the same round/clamp applies, that observation is still on the
// target, that ticks re-read `measure` live, and that `null` skips.

describe('createViewAnchor — measure() override', () => {
  it('publishes measure()’s rect (not the target rect), with the same rounding', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: 1, y: 2, w: 3, h: 4 }) // deliberately different
    createViewAnchor(
      el,
      opts({
        present: true,
        publish,
        measure: () => ({ x: -3.4, y: 10.6, width: 100.5, height: 200.4 }),
      }),
    )

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({
      x: -3, // Math.round(-3.4) — NOT clamped to 0
      y: 11, // Math.round(10.6)
      width: 101, // Math.max(0, Math.round(100.5))
      height: 200, // Math.max(0, Math.round(200.4))
    })
  })

  it('still observes the target element (measure redirects publish, not observation)', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: 1, y: 2, w: 3, h: 4 })
    createViewAnchor(
      el,
      opts({
        present: true,
        publish,
        measure: () => ({ x: 0, y: 0, width: 10, height: 10 }),
      }),
    )

    expect(firstObserver().observed).toContain(el)
  })

  it('a ResizeObserver tick re-reads measure() and publishes its CURRENT value synchronously', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    let measured: Bounds = { x: 0, y: 0, width: 10, height: 10 }
    createViewAnchor(
      el,
      opts({ present: true, publish, measure: () => measured }),
    )
    publish.mockClear()

    // Change what measure() returns AFTER create, then tick — the publish
    // lands synchronously with measure()'s live value.
    measured = { x: 5, y: 6, width: 120, height: 130 }
    firstObserver().fire()

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ x: 5, y: 6, width: 120, height: 130 })
  })

  it('measure() === null at create skips the initial publish (no zero, no stale)', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: 1, y: 2, w: 3, h: 4 })
    createViewAnchor(el, opts({ present: true, publish, measure: () => null }))

    expect(publish).not.toHaveBeenCalled()
  })

  it('a later tick where measure() returns a real rect DOES publish it', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    let measured: Bounds | null = null
    createViewAnchor(
      el,
      opts({ present: true, publish, measure: () => measured }),
    )
    expect(publish).not.toHaveBeenCalled()

    // Element becomes measurable; a tick should now publish synchronously.
    measured = { x: 7, y: 8, width: 90, height: 110 }
    firstObserver().fire()

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ x: 7, y: 8, width: 90, height: 110 })
  })

  it('present=false publishes ZERO regardless of measure() (detach does not route through measure)', () => {
    const publish = vi.fn()
    const measure = vi.fn(() => ({ x: 50, y: 50, width: 60, height: 70 }))
    const { el } = buildElement({ x: 1, y: 2, w: 3, h: 4 })
    createViewAnchor(el, opts({ present: false, publish, measure }))

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 })
  })

  it('update({present:false}) from a measure anchor publishes ZERO, not measure()', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: 1, y: 2, w: 3, h: 4 })
    const handle = createViewAnchor(
      el,
      opts({
        present: true,
        publish,
        measure: () => ({ x: 50, y: 50, width: 60, height: 70 }),
      }),
    )
    publish.mockClear()

    handle.update({
      present: false,
      publish,
      measure: () => ({ x: 50, y: 50, width: 60, height: 70 }),
    })

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 })
  })
})

// ── Contract 9: scroll-on-target listener ────────────────────────────
// Bug it catches: the anchor only following ResizeObserver + window-resize
// means a scroll of the target's own scroll container (which moves the
// element without resizing it or the window) is never reflected — the
// native view drifts out of alignment as the user scrolls. The fix is a
// passive 'scroll' listener on the target that re-publishes synchronously.
// We spy on the TARGET element directly because the shared harness only
// spies window.addEventListener.

describe('createViewAnchor — scroll-on-target listener', () => {
  it('present=true adds a passive scroll listener on the target', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const addSpy = vi.spyOn(el, 'addEventListener')
    createViewAnchor(el, opts({ present: true, publish }))

    const scrollCalls = addSpy.mock.calls.filter((c) => c[0] === 'scroll')
    expect(scrollCalls).toHaveLength(1)
    // The listener must be passive (scroll-perf contract).
    const optsArg = scrollCalls[0]![2] as
      | boolean
      | AddEventListenerOptions
      | undefined
    const passive =
      typeof optsArg === 'object' && optsArg !== null
        ? optsArg.passive === true
        : false
    expect(passive).toBe(true)
  })

  it('present=false does NOT add a scroll listener on the target and publishes ZERO', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const addSpy = vi.spyOn(el, 'addEventListener')
    createViewAnchor(el, opts({ present: false, publish }))

    const scrollCalls = addSpy.mock.calls.filter((c) => c[0] === 'scroll')
    expect(scrollCalls).toHaveLength(0)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 })
  })

  it('a scroll tick on the target re-publishes synchronously (no RAF)', () => {
    const publish = vi.fn()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    createViewAnchor(el, opts({ present: true, publish }))
    publish.mockClear()

    setRect({ x: 9, y: 10, w: 140, h: 150 })
    el.dispatchEvent(new Event('scroll'))

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ x: 9, y: 10, width: 140, height: 150 })
  })

  it('dispose() removes the target scroll listener', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const removeSpy = vi.spyOn(el, 'removeEventListener')
    const handle = createViewAnchor(el, opts({ present: true, publish }))

    handle.dispose()

    const scrollRemovals = removeSpy.mock.calls.filter((c) => c[0] === 'scroll')
    expect(scrollRemovals).toHaveLength(1)
  })

  it('update({present:false}) removes the target scroll listener', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const removeSpy = vi.spyOn(el, 'removeEventListener')
    const handle = createViewAnchor(el, opts({ present: true, publish }))

    handle.update({ present: false, publish })

    const scrollRemovals = removeSpy.mock.calls.filter((c) => c[0] === 'scroll')
    expect(scrollRemovals).toHaveLength(1)
  })
})

// Local type assertion so the file fails loudly if the Bounds shape drifts
// from what these tests assert against.
const _boundsShape: Bounds = { x: 0, y: 0, width: 0, height: 0 }
void _boundsShape
