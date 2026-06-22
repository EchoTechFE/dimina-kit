import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createPlacementAnchor } from './view-anchor.js'
import type { Placement } from './types.js'

// ── press-pause-drag: the windowed RAF geometry sentinel must NOT close
//    while the pointer is still held down ───────────────────────────────
//
// Locks the press-pause-drag behaviour of the `followGeometry` sentinel.
//
// The windowed sentinel only closes on *steady* frames AFTER release
// (pointerup), NOT after N consecutive identical frames unconditionally — a
// press that pauses before the drag actually starts (very common: user clicks
// the splitter, hesitates a frame or two, THEN drags) must not close the
// window mid-press and drop the entire subsequent drag (freezing the native
// view at its pre-drag position).
//
// This file pins:
//   1. press-pause-drag: pointerdown → ≥2 static frames (current close
//      threshold) → rect starts moving → the movement is STILL followed.
//      The pointerHeld gate keeps the sentinel open through the static pause
//      so the later drag frames still find a scheduled rAF.
//   2. no-regression: pointerup → static frames → the sentinel still
//      eventually closes (we must not "fix" #1 by keeping the window open
//      forever / spinning a rAF while idle).

// ── Controllable fake requestAnimationFrame (mirrors view-anchor.test.ts'
//    FakeRaf: a queue we flush one frame at a time). ───────────────────
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
   *  the next flush, so flushFrame() advances exactly one frame. */
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

// ── Minimal ResizeObserver stub (the anchor installs one on a visible
//    target; jsdom has none). We never need to fire it here. ───────────
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

// jsdom's getBoundingClientRect returns zeros; stub it and let `setRect`
// move the element after creation (to drive the sentinel's poll).
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

/** A `[role="separator"]` splitter (the drag handle): a capture-phase
 *  pointerdown matching it opens the sentinel window. */
function buildSplitter(): HTMLElement {
  const sep = document.createElement('div')
  sep.setAttribute('role', 'separator')
  document.body.appendChild(sep)
  return sep
}

function dispatchPointerdown(target: HTMLElement): void {
  target.dispatchEvent(new Event('pointerdown', { bubbles: true }))
}

/** Pointer release — dispatched bubbling from the splitter so a window
 *  capture/bubble listener sees it. Also dispatched on window directly as a
 *  belt-and-braces in case the close is gated on a window-level pointerup. */
function dispatchPointerup(target: HTMLElement): void {
  target.dispatchEvent(new Event('pointerup', { bubbles: true }))
  window.dispatchEvent(new Event('pointerup'))
}

// new options aren't on the public types yet — cast through.
type FollowOpts = Parameters<typeof createPlacementAnchor>[1] & {
  followGeometry?: boolean
}
const mk = (
  el: HTMLElement,
  o: { visible: boolean; publish: (p: Placement) => void; followGeometry?: boolean },
): ReturnType<typeof createPlacementAnchor> =>
  createPlacementAnchor(el, o as FollowOpts)

describe('createPlacementAnchor — press-pause-drag (followGeometry sentinel must survive a held pause)', () => {
  // 1. THE BUG. pointerdown opens the window; the user then hesitates for a
  //    couple of frames (rect identical) BEFORE starting to drag. While the
  //    pointer is still DOWN, those static frames must NOT permanently close
  //    the sentinel — when the drag finally moves the rect, the move must
  //    still be followed.
  it('pointerdown → static pause (≥2 identical frames) → drag moves: the drag is STILL followed', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    mk(el, { visible: true, followGeometry: true, publish })
    const splitter = buildSplitter()

    // Press the splitter — window opens, a frame is scheduled.
    dispatchPointerdown(splitter)
    expect(raf.request).toHaveBeenCalled()
    publish.mockClear()

    // Held pause: TWO consecutive identical frames (== the close threshold the
    // B-close test pins). Under the buggy impl these close the window even
    // though the pointer is still down.
    raf.flushFrame() // static frame 1 (rect unchanged since open)
    raf.flushFrame() // static frame 2

    // Now the drag actually begins: rect moves on subsequent frames. Because
    // the pointer was never released, the sentinel must still be polling.
    setRect({ x: 25, y: 0, w: 100, h: 100 })
    raf.flushFrame()

    // The bug: the static pause closed the window, so this drag frame either
    // ran nothing (no rAF pending) → publish never called, OR (if the window
    // was already cancelled) `raf.pending` is 0 and the move is lost.
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenLastCalledWith({
      visible: true,
      bounds: { x: 25, y: 0, width: 100, height: 100 },
    })

    // And it keeps following further drag frames within the same press.
    setRect({ x: 50, y: 0, w: 100, h: 100 })
    raf.flushFrame()
    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenLastCalledWith({
      visible: true,
      bounds: { x: 50, y: 0, width: 100, height: 100 },
    })
  })

  // 1b. A stricter restatement: the window stays OPEN (a frame remains
  //     scheduled) across a held static pause. This isolates the mechanism —
  //     even before any further move, the sentinel must not have stopped
  //     re-arming while the pointer is held.
  it('the sentinel window stays open (a frame stays scheduled) across a held static pause', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    mk(el, { visible: true, followGeometry: true, publish })
    const splitter = buildSplitter()

    dispatchPointerdown(splitter)
    expect(raf.pending).toBeGreaterThanOrEqual(1)

    // Several static held frames — pointer still down, must keep re-arming.
    raf.flushFrame()
    raf.flushFrame()
    raf.flushFrame()

    expect(raf.pending).toBeGreaterThanOrEqual(1)
  })

  // 2. NO REGRESSION. After the pointer is RELEASED (pointerup), a steady
  //    geometry must still close the window — we must not "fix" #1 by leaving
  //    the sentinel spinning forever once a press has started.
  it('pointerup then steady frames → the sentinel still closes (does not spin forever)', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    mk(el, { visible: true, followGeometry: true, publish })
    const splitter = buildSplitter()

    dispatchPointerdown(splitter)
    // A real drag frame to prove it's live.
    setRect({ x: 30, y: 0, w: 100, h: 100 })
    raf.flushFrame()
    expect(raf.pending).toBeGreaterThanOrEqual(1)

    // Release, then go steady (rect identical from here on).
    dispatchPointerup(splitter)
    // Give the close logic its consecutive-identical frames to converge.
    raf.flushFrame()
    raf.flushFrame()
    raf.flushFrame()
    raf.flushFrame()

    // Window must have closed: no frame pending and a further flush schedules
    // nothing new (no idle spin).
    const requestsBefore = raf.request.mock.calls.length
    raf.flushFrame()
    expect(raf.pending).toBe(0)
    expect(raf.request.mock.calls.length).toBe(requestsBefore)
  })
})
