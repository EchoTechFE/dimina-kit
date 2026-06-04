import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createSizeAdvertiser } from './size-advertiser.js'
import type { AdvertisedSize } from './types.js'

// ── Extras: clipped/degenerate RO shapes, multi-instance isolation, and
//    the new update() re-advertise behaviour ──────────────────────────────
//
// Same stub style as `size-advertiser.test.ts`. The one addition is
// `fireRaw(entry)`: the base `fire(block, inline)` always fills BOTH
// borderBoxSize and contentBoxSize with one box each, so it cannot model a
// degenerate entry (border-box absent, empty arrays). `fireRaw` posts an
// arbitrary entry verbatim, letting us exercise the
// `borderBoxSize?.[0] ?? contentBoxSize?.[0] ?? latest` fallback chain.

interface RoSize {
  blockSize: number
  inlineSize: number
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
  /** Fire one standards-shaped entry (both boxes filled) for the target. */
  fire(blockSize: number, inlineSize: number): void {
    const target = this.observed[0] ?? document.createElement('div')
    this.cb(
      [
        {
          borderBoxSize: [{ blockSize, inlineSize }],
          contentBoxSize: [{ blockSize, inlineSize }],
          target,
        },
      ] as unknown as ResizeObserverEntry[],
      this as unknown as ResizeObserver,
    )
  }
  /** Post an arbitrary, possibly-degenerate entry verbatim (no box defaults).
   *  `target` defaults to the observed element when the caller omits it. */
  fireRaw(entry: {
    borderBoxSize?: RoSize[]
    contentBoxSize?: RoSize[]
    target?: Element
  }): void {
    const target = entry.target ?? this.observed[0] ?? document.createElement('div')
    this.cb(
      [{ ...entry, target } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    )
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

function obs(i = 0): FakeResizeObserver {
  expect(FakeResizeObserver.instances.length).toBeGreaterThan(i)
  return FakeResizeObserver.instances[i]!
}

function el(): HTMLElement {
  return document.createElement('div')
}

// ── update() re-advertises the current value to the new sink ──────────────
// Bug it catches: an update() that only swaps the sink (without
// `emitNow(produce())`) leaves the new channel sizeless until the next RO
// tick — the documented mirror of the forward anchor's re-publish on update.

describe('createSizeAdvertiser — update() re-advertises current value', () => {
  it('emits the current size to the new sink immediately, without a fresh RO tick', () => {
    const first = vi.fn<(s: AdvertisedSize) => void>()
    const second = vi.fn<(s: AdvertisedSize) => void>()
    const handle = createSizeAdvertiser(el(), { axis: 'block', publish: first })

    obs().fire(120, 0)
    flushRafs()
    expect(first).toHaveBeenCalledWith({ axis: 'block', extent: 120 })

    // No fire() between swap and assertion — the value must arrive on update().
    handle.update(second)
    expect(second).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledWith({ axis: 'block', extent: 120 })
  })
})

// ── update() with no size yet does not emit ───────────────────────────────
// Bug it catches: an update() that emits unconditionally (e.g. `emitNow` with a
// stale/zero default) sends a bogus frame before any real measurement exists.

describe('createSizeAdvertiser — update() before any size', () => {
  it('does not call the new sink when no RO frame has produced a size yet', () => {
    const first = vi.fn<(s: AdvertisedSize) => void>()
    const second = vi.fn<(s: AdvertisedSize) => void>()
    const handle = createSizeAdvertiser(el(), { axis: 'block', publish: first })

    // latest is still null — produce() returns null.
    handle.update(second)
    expect(second).not.toHaveBeenCalled()
  })
})

// ── border-box absent → fall back to content-box ──────────────────────────
// Bug it catches: a reader that hard-requires borderBoxSize drops every frame
// from a UA/path that only delivers contentBoxSize, so such targets never
// advertise.

describe('createSizeAdvertiser — content-box fallback', () => {
  it('uses contentBoxSize when borderBoxSize is absent', () => {
    const publish = vi.fn<(s: AdvertisedSize) => void>()
    createSizeAdvertiser(el(), { axis: 'block', publish })

    obs().fireRaw({ contentBoxSize: [{ blockSize: 88, inlineSize: 0 }] })
    flushRafs()

    expect(publish).toHaveBeenCalledWith({ axis: 'block', extent: 88 })
  })
})

// ── empty box arrays don't lock the advertiser ────────────────────────────
// Bug it catches: an empty-array frame that writes `undefined`/0 into `latest`
// (instead of leaving it untouched) would either crash on `.blockSize` or
// poison the dedupe baseline, so a subsequent real size never publishes.

describe('createSizeAdvertiser — empty box arrays', () => {
  it('an empty-array entry publishes nothing yet does not break a later real frame', () => {
    const publish = vi.fn<(s: AdvertisedSize) => void>()
    createSizeAdvertiser(el(), { axis: 'block', publish })

    obs().fireRaw({ borderBoxSize: [], contentBoxSize: [] })
    flushRafs()
    expect(publish).not.toHaveBeenCalled()

    obs().fire(90, 0)
    flushRafs()
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ axis: 'block', extent: 90 })
  })
})

// ── extent 0 is a real frame (collapse), distinct from NaN (drop) ─────────
// Bug it catches: a producer that treats a falsy 0 like a missing value would
// silently swallow a genuine content-collapse, leaving the host oversized.

describe('createSizeAdvertiser — zero extent', () => {
  it('publishes extent 0 (content collapsed) rather than dropping the frame', () => {
    const publish = vi.fn<(s: AdvertisedSize) => void>()
    createSizeAdvertiser(el(), { axis: 'block', publish })

    obs().fire(0, 0)
    flushRafs()

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ axis: 'block', extent: 0 })
  })
})

// ── two advertisers are fully independent ─────────────────────────────────
// Bug it catches: shared module-level `latest`/dedupe state (a singleton) would
// cross-publish between advertisers, or one's baseline would suppress the
// other's first emit.

describe('createSizeAdvertiser — independent instances', () => {
  it('each advertiser owns its own sink and dedupe baseline', () => {
    const publishA = vi.fn<(s: AdvertisedSize) => void>()
    const publishB = vi.fn<(s: AdvertisedSize) => void>()
    createSizeAdvertiser(el(), { axis: 'block', publish: publishA })
    createSizeAdvertiser(el(), { axis: 'block', publish: publishB })

    // instances[0] drives A only.
    obs(0).fire(120, 0)
    flushRafs()
    expect(publishA).toHaveBeenCalledTimes(1)
    expect(publishA).toHaveBeenCalledWith({ axis: 'block', extent: 120 })
    expect(publishB).not.toHaveBeenCalled()

    // instances[1] drives B only — same extent A already used must still emit
    // (independent baselines, not a shared dedupe).
    obs(1).fire(120, 0)
    flushRafs()
    expect(publishB).toHaveBeenCalledTimes(1)
    expect(publishB).toHaveBeenCalledWith({ axis: 'block', extent: 120 })
    expect(publishA).toHaveBeenCalledTimes(1)
  })
})

// ── a fresh advertiser starts with a clean baseline ───────────────────────
// Bug it catches: a leaked/static dedupe baseline would let a disposed
// advertiser's last extent swallow a new advertiser's identical first frame.

describe('createSizeAdvertiser — baseline resets per instance', () => {
  it('a new advertiser publishes its first frame even if it equals a disposed one', () => {
    const publishA = vi.fn<(s: AdvertisedSize) => void>()
    const handleA = createSizeAdvertiser(el(), { axis: 'block', publish: publishA })
    obs(0).fire(120, 0)
    flushRafs()
    handleA.dispose()

    const publishB = vi.fn<(s: AdvertisedSize) => void>()
    createSizeAdvertiser(el(), { axis: 'block', publish: publishB })
    obs(1).fire(120, 0)
    flushRafs()

    expect(publishB).toHaveBeenCalledTimes(1)
    expect(publishB).toHaveBeenCalledWith({ axis: 'block', extent: 120 })
  })
})

// ── construction-time body/html footgun guard ─────────────────────────────
// Bug it catches: a missing (or always-on) <body>/<html> warning means the
// classic "measuring the host-driven view size → loop never converges" mistake
// ships silently, or every ordinary element spams a false warning.

describe('createSizeAdvertiser — body/html guard', () => {
  it('warns once when target is document.body and not for a normal element', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const publish = vi.fn<(s: AdvertisedSize) => void>()

    createSizeAdvertiser(document.body, { axis: 'block', publish })
    expect(warn).toHaveBeenCalledTimes(1)

    warn.mockClear()
    createSizeAdvertiser(el(), { axis: 'block', publish })
    expect(warn).not.toHaveBeenCalled()
  })
})

// ── dispose() is idempotent ───────────────────────────────────────────────
// Bug it catches: a dispose missing its `disposed` re-entry guard would
// double-disconnect / double-cancel on a second call (or throw).

describe('createSizeAdvertiser — idempotent dispose', () => {
  it('a second dispose() is a no-op (no throw, no extra disconnect)', () => {
    const publish = vi.fn<(s: AdvertisedSize) => void>()
    const handle = createSizeAdvertiser(el(), { axis: 'block', publish })

    handle.dispose()
    expect(() => handle.dispose()).not.toThrow()
    // disconnect ran exactly once: the observer is nulled after the first.
    expect(obs().disconnected).toBe(true)
  })
})
