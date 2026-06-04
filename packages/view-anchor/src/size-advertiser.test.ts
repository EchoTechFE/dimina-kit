import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createSizeAdvertiser } from './size-advertiser.js'
import type { AdvertisedSize } from './types.js'

// ── Reverse-direction stubs ──────────────────────────────────────────
//
// Mirrors the stub style of `view-anchor.test.ts`, with two deliberate
// differences the reverse primitive forces:
//
//   - The advertiser reads `entry.borderBoxSize`, NOT
//     `getBoundingClientRect()`. So `fire(blockSize, inlineSize)` builds a
//     standards-shaped RO entry: an array of entries, each with
//     `borderBoxSize: [{ blockSize, inlineSize }]` (and a matching
//     contentBoxSize, present in real entries).
//   - There is no `present` flag and no ZERO/terminal value, so we never
//     model a detach path.
//
// `fakeRaf`/`flushRafs` queue RAF callbacks so a test decides *when* they
// run; `cancelAnimationFrame` is a spy that also evicts the queued entry so
// a cancelled RAF can never fire (lets us assert the dispose stale-RAF guard).

interface RoSize {
  blockSize: number
  inlineSize: number
}
interface RoEntry {
  borderBoxSize: RoSize[]
  contentBoxSize: RoSize[]
  target: Element
}

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
  /** Fire the RO callback with one standards-shaped entry for the observed
   *  target, carrying the given border-box block/inline extents. */
  fire(blockSize: number, inlineSize: number): void {
    const target = this.observed[0] ?? document.createElement('div')
    const entry: RoEntry = {
      borderBoxSize: [{ blockSize, inlineSize }],
      contentBoxSize: [{ blockSize, inlineSize }],
      target,
    }
    this.cb([entry] as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver)
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

beforeEach(() => {
  FakeResizeObserver.instances = []
  rafQueue = []
  rafIdCounter = 0
  cancelSpy.mockClear()
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.stubGlobal(
    'requestAnimationFrame',
    fakeRaf as unknown as typeof window.requestAnimationFrame,
  )
  vi.stubGlobal(
    'cancelAnimationFrame',
    ((id: number) => {
      cancelSpy(id)
      // A cancelled RAF must never fire — evict it so flushRafs() can't run a
      // callback the advertiser cancelled.
      rafQueue = rafQueue.filter((e) => e.id !== id)
    }) as unknown as typeof window.cancelAnimationFrame,
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function flushRafs(): void {
  const q = rafQueue
  rafQueue = []
  q.forEach((e) => e.cb())
}

/** Assert an observer was installed, then return it — a missing observer
 *  (stub no-op) surfaces as a clear "expected >= 1, got 0" instead of a
 *  TypeError on a later `.fire()`. */
function firstObserver(): FakeResizeObserver {
  expect(FakeResizeObserver.instances.length).toBeGreaterThanOrEqual(1)
  return FakeResizeObserver.instances[0]!
}

/** A bare element. If the advertiser were (wrongly) reading geometry from
 *  getBoundingClientRect instead of the RO entry, this spy would catch it. */
function buildElement(): { el: HTMLElement; rectSpy: ReturnType<typeof vi.fn> } {
  const el = document.createElement('div')
  const rectSpy = vi.fn(() => {
    throw new Error('getBoundingClientRect must not be called by the advertiser')
  })
  vi.spyOn(el, 'getBoundingClientRect').mockImplementation(
    rectSpy as unknown as () => DOMRect,
  )
  return { el, rectSpy }
}

// ── Contract 1: source = RO border-box, never getBoundingClientRect ──
// Bug it catches: an advertiser that measures via getBoundingClientRect
// (content/layout box, affected by transforms/zoom) instead of the RO
// entry's border-box advertises the wrong number — and re-introduces the
// forced-reflow the RO path exists to avoid.

describe('createSizeAdvertiser — source is the RO border-box', () => {
  it('reads borderBoxSize from the entry and never calls getBoundingClientRect', () => {
    const publish = vi.fn<(s: AdvertisedSize) => void>()
    const { el, rectSpy } = buildElement()
    createSizeAdvertiser(el, { axis: 'block', publish })
    publish.mockClear()

    // block axis must come from blockSize (200), not inlineSize (999).
    firstObserver().fire(200, 999)
    flushRafs()

    expect(publish).toHaveBeenCalledWith({ axis: 'block', extent: 200 })
    expect(rectSpy).not.toHaveBeenCalled()
  })

  it('axis:inline reads inlineSize from the border-box entry', () => {
    const publish = vi.fn<(s: AdvertisedSize) => void>()
    const { el } = buildElement()
    createSizeAdvertiser(el, { axis: 'inline', publish })
    publish.mockClear()

    // inline axis must come from inlineSize (321), not blockSize (10).
    firstObserver().fire(10, 321)
    flushRafs()

    expect(publish).toHaveBeenCalledWith({ axis: 'inline', extent: 321 })
  })
})

// ── Contract 2: payload is a single-axis scalar ──────────────────────
// Bug it catches: a payload that leaks the second axis (or whose `axis`
// drifts from the owned axis) breaks the host's single-axis DAG invariant —
// the cross-process loop could feed both axes and oscillate.

describe('createSizeAdvertiser — single-axis scalar payload', () => {
  it('publishes only { axis, extent } with axis equal to the owned axis', () => {
    const publish = vi.fn<(s: AdvertisedSize) => void>()
    const { el } = buildElement()
    createSizeAdvertiser(el, { axis: 'block', publish })
    publish.mockClear()

    firstObserver().fire(150, 280)
    flushRafs()

    expect(publish).toHaveBeenCalledTimes(1)
    const payload = publish.mock.calls[0]![0]
    expect(payload.axis).toBe('block')
    expect(payload.extent).toBe(150)
    // No second-axis field smuggled in.
    expect(Object.keys(payload).sort()).toEqual(['axis', 'extent'])
  })
})

// ── Contract 3: quantize + clamp-to-zero ─────────────────────────────
// Bug it catches: an advertiser that forwards raw subpixel floats causes
// per-frame jitter in the host's sizing; one that *drops* a negative frame
// (instead of clamping to 0) leaves the host stuck at a stale extent.

describe('createSizeAdvertiser — quantize and clamp', () => {
  it('rounds the raw extent (Math.round)', () => {
    const publish = vi.fn<(s: AdvertisedSize) => void>()
    const { el } = buildElement()
    createSizeAdvertiser(el, { axis: 'block', publish })
    publish.mockClear()

    firstObserver().fire(100.49, 0)
    flushRafs()

    expect(publish).toHaveBeenCalledWith({ axis: 'block', extent: 100 })
  })

  it('clamps a negative extent to 0 and STILL publishes that frame (not dropped)', () => {
    const publish = vi.fn<(s: AdvertisedSize) => void>()
    const { el } = buildElement()
    createSizeAdvertiser(el, { axis: 'block', publish })
    publish.mockClear()

    firstObserver().fire(-7.2, 0)
    flushRafs()

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ axis: 'block', extent: 0 })
  })
})

// ── Contract 4: hygiene filter drops the whole frame ─────────────────
// Bug it catches: a NaN/Infinity extent (degenerate layout, detached node)
// published as-is corrupts the host's size; the contract is to drop the
// frame entirely, not clamp/coerce it to some number.

describe('createSizeAdvertiser — non-finite values drop the frame', () => {
  it('does not publish when the raw extent is NaN', () => {
    const publish = vi.fn<(s: AdvertisedSize) => void>()
    const { el } = buildElement()
    createSizeAdvertiser(el, { axis: 'block', publish })
    publish.mockClear()

    firstObserver().fire(NaN, 100)
    flushRafs()

    expect(publish).not.toHaveBeenCalled()
  })

  it('does not publish when the raw extent is Infinity', () => {
    const publish = vi.fn<(s: AdvertisedSize) => void>()
    const { el } = buildElement()
    createSizeAdvertiser(el, { axis: 'block', publish })
    publish.mockClear()

    firstObserver().fire(Infinity, 100)
    flushRafs()

    expect(publish).not.toHaveBeenCalled()
  })
})

// ── Contract 5: RAF coalescing ───────────────────────────────────────
// Bug it catches: a synchronous publish per RO tick floods IPC; the
// contract is to coalesce N triggers in one frame into a single RAF and a
// single publish.

describe('createSizeAdvertiser — RAF coalescing', () => {
  it('multiple RO ticks in one frame schedule one RAF and publish once', () => {
    const publish = vi.fn<(s: AdvertisedSize) => void>()
    const { el } = buildElement()
    createSizeAdvertiser(el, { axis: 'block', publish })
    publish.mockClear()

    const ro = firstObserver()
    // Distinct extents per tick — only the last, coalesced value should emit.
    ro.fire(100, 0)
    ro.fire(150, 0)
    ro.fire(200, 0)

    // Nothing synchronous; exactly one RAF queued for the whole burst.
    expect(publish).not.toHaveBeenCalled()
    expect(rafQueue).toHaveLength(1)

    flushRafs()
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ axis: 'block', extent: 200 })
  })
})

// ── Contract 6: last-extent dedupe on the RO→RAF stream ──────────────
// Bug it catches: a path that re-advertises a byte-for-byte identical extent
// every frame floods the host with redundant resizes; or a dedupe that
// compares the wrong baseline so a real change is dropped.

describe('createSizeAdvertiser — last-extent dedupe', () => {
  it('an unchanged extent on a follow-up RO tick does not re-publish', () => {
    const publish = vi.fn<(s: AdvertisedSize) => void>()
    const { el } = buildElement()
    createSizeAdvertiser(el, { axis: 'block', publish })
    publish.mockClear()

    firstObserver().fire(120, 0)
    flushRafs()
    expect(publish).toHaveBeenCalledTimes(1)

    // Same extent again → silent.
    firstObserver().fire(120, 0)
    flushRafs()
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('publishes again once the extent changes', () => {
    const publish = vi.fn<(s: AdvertisedSize) => void>()
    const { el } = buildElement()
    createSizeAdvertiser(el, { axis: 'block', publish })
    publish.mockClear()

    firstObserver().fire(120, 0)
    flushRafs()
    firstObserver().fire(140, 0)
    flushRafs()

    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenLastCalledWith({ axis: 'block', extent: 140 })
  })

  it('dedupe is post-quantization: 120.4 then 120 (both round to 120) emits once', () => {
    const publish = vi.fn<(s: AdvertisedSize) => void>()
    const { el } = buildElement()
    createSizeAdvertiser(el, { axis: 'block', publish })
    publish.mockClear()

    firstObserver().fire(120.4, 0)
    flushRafs()
    firstObserver().fire(120, 0)
    flushRafs()

    expect(publish).toHaveBeenCalledTimes(1)
  })
})

// ── Contract 7: handle shape has no `present` ────────────────────────
// Bug it catches: a handle that exposes a `present`/attach toggle would
// imply a detach path the reverse primitive deliberately does not have.

describe('createSizeAdvertiser — handle shape', () => {
  it('exposes only update and dispose (no present)', () => {
    const publish = vi.fn<(s: AdvertisedSize) => void>()
    const { el } = buildElement()
    const handle = createSizeAdvertiser(el, { axis: 'block', publish })

    expect(typeof handle.update).toBe('function')
    expect(typeof handle.dispose).toBe('function')
    expect('present' in (handle as unknown as Record<string, unknown>)).toBe(
      false,
    )
  })
})

// ── Contract 8: update() swaps the publish sink ──────────────────────
// Bug it catches: an update() that ignores the new sink keeps emitting to a
// dead channel.
//
// NOTE: `update` now takes ONLY the new publish — axis is immutable by
// construction and is no longer expressible in `update` (you cannot attempt to
// change it), so the previous "ignores a changed axis" test is gone: the
// mistake is now a compile error, not a runtime no-op.

describe('createSizeAdvertiser — update() swaps publish', () => {
  it('routes subsequent emits to the new publish', () => {
    const first = vi.fn<(s: AdvertisedSize) => void>()
    const second = vi.fn<(s: AdvertisedSize) => void>()
    const { el } = buildElement()
    const handle = createSizeAdvertiser(el, { axis: 'block', publish: first })
    first.mockClear()

    handle.update(second)

    firstObserver().fire(170, 0)
    flushRafs()
    expect(second).toHaveBeenCalledWith({ axis: 'block', extent: 170 })
    expect(first).not.toHaveBeenCalled()
  })
})

// ── Contract 9: dispose() tears down and silences ────────────────────
// Bug it catches: a dispose that forgets to disconnect the RO / cancel the
// in-flight RAF leaks observers and can advertise after teardown (the IPC
// target may already be gone → throw).

describe('createSizeAdvertiser — dispose()', () => {
  it('disconnects the observer and cancels a pending RAF', () => {
    const publish = vi.fn<(s: AdvertisedSize) => void>()
    const { el } = buildElement()
    const handle = createSizeAdvertiser(el, { axis: 'block', publish })

    // Queue a RAF so dispose has something to cancel.
    firstObserver().fire(160, 0)
    expect(rafQueue).toHaveLength(1)

    handle.dispose()

    expect(firstObserver().disconnected).toBe(true)
    expect(cancelSpy).toHaveBeenCalledTimes(1)
  })

  it('never advertises again after dispose (later RO ticks are inert)', () => {
    const publish = vi.fn<(s: AdvertisedSize) => void>()
    const { el } = buildElement()
    const handle = createSizeAdvertiser(el, { axis: 'block', publish })
    const ro = firstObserver()
    handle.dispose()
    publish.mockClear()

    ro.fire(220, 0)
    flushRafs()
    expect(publish).not.toHaveBeenCalled()
  })

  it('a RAF queued before dispose() does not advertise even if flushed', () => {
    const publish = vi.fn<(s: AdvertisedSize) => void>()
    const { el } = buildElement()
    const handle = createSizeAdvertiser(el, { axis: 'block', publish })

    firstObserver().fire(240, 0)
    expect(rafQueue).toHaveLength(1)
    publish.mockClear()

    handle.dispose()
    flushRafs() // queue empty after cancel, OR the cb bails on the guard

    expect(publish).not.toHaveBeenCalled()
  })
})

// ── Contract 10: initial sync emit when a size is available ──────────
// Bug it catches: an advertiser that only emits on *change* never advertises
// its first measurable size, so the host starts with no extent and the
// placeholder is mis-sized until the content next happens to resize.
//
// Per the harness note we express "can obtain an initial value" as the
// observe→first-RO-frame→flush path rather than assuming the constructor
// emits synchronously.

describe('createSizeAdvertiser — initial value', () => {
  it('advertises the first measurable size once on the first RO frame', () => {
    const publish = vi.fn<(s: AdvertisedSize) => void>()
    const { el } = buildElement()
    createSizeAdvertiser(el, { axis: 'block', publish })

    // The first frame the observer delivers carries the initial size.
    firstObserver().fire(300, 0)
    flushRafs()

    expect(publish).toHaveBeenCalledWith({ axis: 'block', extent: 300 })
  })
})
