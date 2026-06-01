import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createViewAnchor } from './view-anchor'
import type { Bounds, ViewAnchorOptions } from './types'

// ── ResizeObserver / RAF stubs ───────────────────────────────────────
//
// Mirrors the mock setup in
// `modules/main/features/project-runtime/layout/use-cell-bounds.test.ts`:
//   - `FakeResizeObserver` records observed elements + disconnect, and
//     exposes `fire()` to synchronously invoke its callback.
//   - `fakeRaf` queues callbacks so the test can decide *when* (and
//     whether) they run via `flushRafs()`. `cancelAnimationFrame` is a
//     real spy that also removes the queued entry so a cancelled RAF can
//     never fire — this is what lets us assert the stale-RAF guard.

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

interface RafEntry {
  id: number
  cb: () => void
}
let rafQueue: RafEntry[] = []
let rafIdCounter = 0
function fakeRaf(cb: () => void): number {
  rafIdCounter++
  rafQueue.push({ id: rafIdCounter, cb })
  return rafIdCounter
}
const cancelSpy = vi.fn()
const resizeAddSpy = vi.fn()
const resizeRemoveSpy = vi.fn()
// Handlers added to the real window via the addEventListener spy, tracked so
// afterEach can remove leaked 'resize' listeners — tests create anchors
// directly and don't dispose them, so their listeners would otherwise
// accumulate across tests and inflate RAF counts.
let leakedResize: unknown[] = []

beforeEach(() => {
  FakeResizeObserver.instances = []
  rafQueue = []
  rafIdCounter = 0
  cancelSpy.mockClear()
  resizeAddSpy.mockClear()
  resizeRemoveSpy.mockClear()
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.stubGlobal(
    'requestAnimationFrame',
    fakeRaf as unknown as typeof window.requestAnimationFrame,
  )
  vi.stubGlobal(
    'cancelAnimationFrame',
    ((id: number) => {
      cancelSpy(id)
      // A cancelled RAF must never fire — actually evict it so
      // `flushRafs()` cannot run a callback the anchor cancelled.
      rafQueue = rafQueue.filter((e) => e.id !== id)
    }) as unknown as typeof window.cancelAnimationFrame,
  )

  // Spy on window resize listener add/remove so we can assert the anchor
  // installs exactly one resize listener when present, and removes it on
  // dispose / present=false. We forward to the real implementation so
  // dispatching a real 'resize' event still works if a test needs it.
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

function flushRafs(): void {
  const q = rafQueue
  rafQueue = []
  q.forEach((e) => e.cb())
}

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
// jsdom's `getBoundingClientRect` always returns zeros, so we stub it —
// exactly as `use-cell-bounds.test.ts/buildElement` does. `setRect` lets a
// test move the element after the anchor was created (to prove a RAF reads
// the *current* rect, not a captured one).

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

  it('rounds and clamps each field with Math.max(0, Math.round(...))', () => {
    const publish = vi.fn()
    // Fractional + negative left/top: rounding then clamp-to-zero.
    const { el } = buildElement({ x: -3.4, y: 12.6, w: 100.49, h: 0.5 })
    createViewAnchor(el, opts({ present: true, publish }))

    expect(publish).toHaveBeenCalledWith({
      x: 0, // Math.max(0, Math.round(-3.4)) = 0
      y: 13, // Math.round(12.6)
      width: 100, // Math.round(100.49)
      height: 1, // Math.round(0.5)
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

// ── Contract 3: present=true installs observers; updates are RAF-throttled
// Bug it catches: a synchronous re-publish on every ResizeObserver tick
// floods IPC; the contract is to coalesce through one RAF.

describe('createViewAnchor — present=true observation', () => {
  it('observes the target and adds a window resize listener', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    createViewAnchor(el, opts({ present: true, publish }))

    expect(FakeResizeObserver.instances).toHaveLength(1)
    expect(FakeResizeObserver.instances[0]!.observed).toContain(el)
    expect(resizeAddSpy).toHaveBeenCalledTimes(1)
  })

  it('a ResizeObserver tick re-publishes via RAF, not synchronously', () => {
    const publish = vi.fn()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    createViewAnchor(el, opts({ present: true, publish }))
    publish.mockClear()

    // Move the element, then fire the observer.
    setRect({ x: 5, y: 6, w: 120, h: 130 })
    firstObserver().fire()

    // Throttled: nothing published yet, but a RAF is queued.
    expect(publish).not.toHaveBeenCalled()
    expect(rafQueue).toHaveLength(1)

    // Flushing the RAF publishes the *current* rect.
    flushRafs()
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ x: 5, y: 6, width: 120, height: 130 })
  })

  it('a window resize event also schedules a RAF re-publish', () => {
    const publish = vi.fn()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    createViewAnchor(el, opts({ present: true, publish }))
    publish.mockClear()

    setRect({ x: 1, y: 2, w: 50, h: 60 })
    window.dispatchEvent(new Event('resize'))

    expect(publish).not.toHaveBeenCalled()
    expect(rafQueue).toHaveLength(1)
    flushRafs()
    expect(publish).toHaveBeenCalledWith({ x: 1, y: 2, width: 50, height: 60 })
  })
})

// ── Contract 4: RAF coalescing ───────────────────────────────────────
// Bug it catches: without coalescing, N resize/RO events in one frame
// produce N publishes (and N native-view setBounds calls) → jitter.

describe('createViewAnchor — RAF coalescing', () => {
  it('multiple triggers in one frame collapse into a single RAF publish', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    createViewAnchor(el, opts({ present: true, publish }))
    publish.mockClear()

    const ro = firstObserver()
    ro.fire()
    ro.fire()
    window.dispatchEvent(new Event('resize'))
    ro.fire()

    // Only one RAF queued for the whole burst.
    expect(rafQueue).toHaveLength(1)
    flushRafs()
    expect(publish).toHaveBeenCalledTimes(1)
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
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const handle = createViewAnchor(el, opts({ present: true, publish: first }))
    first.mockClear()

    handle.update({ present: true, publish: second })
    // Immediate re-publish goes to the new callback.
    expect(second).toHaveBeenCalledWith({ x: 0, y: 0, width: 100, height: 100 })

    second.mockClear()
    lastObserver().fire()
    flushRafs()
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })
})

// ── Contract 6: dispose() tears everything down ─────────────────────
// Bug it catches: a dispose that forgets to disconnect the RO / remove the
// resize listener / cancel the in-flight RAF leaks observers and can
// publish after teardown (the IPC target may already be gone → throw).

describe('createViewAnchor — dispose()', () => {
  it('disconnects the observer, removes the resize listener, cancels pending RAF', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const handle = createViewAnchor(el, opts({ present: true, publish }))

    // Queue a RAF so dispose has something to cancel.
    firstObserver().fire()
    expect(rafQueue).toHaveLength(1)

    handle.dispose()

    expect(firstObserver().disconnected).toBe(true)
    expect(resizeRemoveSpy).toHaveBeenCalledTimes(1)
    expect(cancelSpy).toHaveBeenCalledTimes(1)
  })

  it('never publishes again after dispose (later RO/resize events are ignored)', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const handle = createViewAnchor(el, opts({ present: true, publish }))
    const ro = firstObserver()
    handle.dispose()
    publish.mockClear()

    // Any event arriving after dispose must be inert.
    ro.fire()
    window.dispatchEvent(new Event('resize'))
    flushRafs()
    expect(publish).not.toHaveBeenCalled()
  })
})

// ── Contract 7: stale-RAF guard ──────────────────────────────────────
// Bug it catches: a RAF queued before update()/dispose() that still runs
// would write an OLD rect over the live one → DevTools native view lands
// at the wrong place / flickers.

describe('createViewAnchor — stale-RAF guard', () => {
  it('a RAF queued before dispose() does not publish even if flushed', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const handle = createViewAnchor(el, opts({ present: true, publish }))

    firstObserver().fire()
    expect(rafQueue).toHaveLength(1)
    publish.mockClear()

    handle.dispose()
    flushRafs() // the queue is empty after cancel, OR the cb bails on guard

    expect(publish).not.toHaveBeenCalled()
  })

  it('a RAF queued before update(present=false) does not republish a stale rect', () => {
    const publish = vi.fn()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const handle = createViewAnchor(el, opts({ present: true, publish }))

    // Queue a stale RAF (captures the intent to read the old rect).
    setRect({ x: 999, y: 999, w: 999, h: 999 })
    firstObserver().fire()
    expect(rafQueue).toHaveLength(1)

    // Flip to present=false BEFORE the RAF runs → synchronous zero.
    handle.update({ present: false, publish })
    expect(publish).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 0, height: 0 })
    publish.mockClear()

    // The stale RAF must NOT fire and overwrite the zero with {999,...}.
    flushRafs()
    expect(publish).not.toHaveBeenCalled()
  })

  it('a RAF queued before update(present=true, same el) is superseded by the immediate re-measure', () => {
    const publish = vi.fn()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const handle = createViewAnchor(el, opts({ present: true, publish }))

    firstObserver().fire() // stale RAF queued
    expect(rafQueue.length).toBeGreaterThanOrEqual(1)

    // update() re-measures synchronously at the current rect.
    setRect({ x: 5, y: 5, w: 200, h: 200 })
    handle.update({ present: true, publish })
    expect(publish).toHaveBeenLastCalledWith({ x: 5, y: 5, width: 200, height: 200 })

    const callsAfterUpdate = publish.mock.calls.length
    // The pre-update RAF must not fire a second, stale publish.
    flushRafs()
    expect(publish.mock.calls.length).toBe(callsAfterUpdate)
  })
})

// Local type assertion so the file fails loudly if the Bounds shape drifts
// from what these tests assert against.
const _boundsShape: Bounds = { x: 0, y: 0, width: 0, height: 0 }
void _boundsShape
