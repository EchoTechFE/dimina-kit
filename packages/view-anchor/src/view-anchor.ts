import type {
  Bounds,
  Placement,
  ViewAnchorOptions,
  ViewAnchorHandle,
} from './types.js'

const ZERO: Bounds = { x: 0, y: 0, width: 0, height: 0 }

// Round to integers (setBounds rejects fractionals). Width/height are clamped
// to ≥0 (negative area is meaningless and `0` is the canonical "hidden"
// signal). x/y are NOT clamped: a position is a position — an anchored overlay
// scrolled past the top/left edge has a legitimately NEGATIVE origin, and
// flooring it to 0 would pin the native view at the edge instead of letting it
// track its element off-screen. (Each consumer's IPC schema enforces its own
// origin policy — the simulator's allows negative; the DevTools placeholder
// never goes negative, so its NonNegInt schema is unaffected.)
const clampRect = (r: {
  x: number
  y: number
  width: number
  height: number
}): Bounds => ({
  x: Math.round(r.x),
  y: Math.round(r.y),
  width: Math.max(0, Math.round(r.width)),
  height: Math.max(0, Math.round(r.height)),
})

/**
 * Create an anchor binding ONE native view's bounds to `target`'s geometry.
 *
 * Imperative core — no React, no Electron. Behaviour:
 *   - `present === true`: publish `target.getBoundingClientRect()` (x/y rounded,
 *     width/height `Math.max(0, Math.round(...))`) immediately, then re-publish
 *     SYNCHRONOUSLY on every `ResizeObserver` tick and window `resize`.
 *   - `present === false`: publish `{0,0,0,0}` immediately; do not observe.
 *   - `update(opts)`: re-apply synchronously.
 *   - `dispose()`: stop observing, never publish again.
 *
 * Synchronous, NOT RAF-deferred: the native overlay is a cross-process
 * `WebContentsView` whose `setBounds` already lands ~1 compositor frame behind
 * the renderer's DOM paint (the two processes composite on different frames).
 * Deferring the measure+publish to a RAF stacked a SECOND frame on top — during
 * a height/splitter drag that read as the overlay visibly trailing the region
 * edge (worst when GROWING, where the not-yet-followed edge exposes background).
 * Publishing in the observer tick itself removes that self-inflicted frame and
 * leaves only the unavoidable cross-process frame (masked by matching the
 * placeholder/desk background colour). The anti-flood role the RAF used to play
 * — collapsing a burst of RO+resize ticks in one frame into one publish — is now
 * served by `lastPublished` dedup: a tick whose measured rect is byte-identical
 * to the last published one is dropped, so a continuous drag still emits at most
 * one publish per distinct rect.
 *
 * Teardown safety: there is no queued frame to outrun a state change — every
 * emit reads `disposed`/`present` synchronously, so a tick after
 * `update`/`dispose` can never write a stale rect over the live one.
 */
export function createViewAnchor(
  target: HTMLElement,
  opts: ViewAnchorOptions,
): ViewAnchorHandle {
  let present = opts.present
  let publish = opts.publish
  let observer: ResizeObserver | null = null
  // The last rect handed to `publish`, for dedup-coalescing (see header). Reset
  // to `null` on every `apply()` so a state change (e.g. zoom, which rides in
  // the `publish` closure, not in `Bounds`) always forces one fresh publish
  // even when the geometry is unchanged.
  let lastPublished: Bounds | null = null
  let disposed = false

  const measure = (): Bounds => {
    const r = target.getBoundingClientRect()
    return clampRect({ x: r.left, y: r.top, width: r.width, height: r.height })
  }

  const sameRect = (a: Bounds, b: Bounds): boolean =>
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

  // Measure + publish SYNCHRONOUSLY on the triggering tick — no RAF defer (see
  // header for why). Bail if torn down or detached, and dedup a rect
  // byte-identical to the last published one (collapses a same-frame RO+resize
  // burst, and a steady drag that re-fires the same final rect, into one).
  const emit = (): void => {
    if (disposed || !present) return
    const m = measure()
    if (lastPublished && sameRect(lastPublished, m)) return
    lastPublished = m
    publish(m)
  }

  const startObserving = (): void => {
    if (observer) return
    observer = new ResizeObserver(emit)
    observer.observe(target)
    window.addEventListener('resize', emit)
  }

  const stopObserving = (): void => {
    if (observer) {
      observer.disconnect()
      observer = null
    }
    window.removeEventListener('resize', emit)
  }

  // Apply the current (present, publish) synchronously. Reset `lastPublished`
  // first so the publish below is never dedup-skipped — a state change (zoom,
  // present flip, new publish target) must always re-emit even if the geometry
  // is byte-identical to the previous emit.
  const apply = (): void => {
    lastPublished = null
    if (present) {
      startObserving()
      lastPublished = measure()
      publish(lastPublished)
    } else {
      stopObserving()
      publish(ZERO)
    }
  }

  apply()

  return {
    update(next: ViewAnchorOptions): void {
      if (disposed) return
      publish = next.publish
      present = next.present
      apply()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      stopObserving()
    },
  }
}

// ── Explicit Placement API ────────────────────────────────────────────
//
// The modern surface that replaces the magic-`{0,0,0,0}` "hidden" value.
// Visibility is an explicit discriminant, NEVER inferred from geometry — a
// real 0×0-but-on-screen view is `{ visible:true, bounds:{...,width:0} }`
// and a hidden one is `{ visible:false }` (no `bounds`). See `Placement`.

export interface PlacementAnchorOptions {
  /**
   * Caller's INTENT: should the native view be on-screen? `true` →
   * publish the measured rect as `{ visible:true, bounds }`; `false` →
   * publish `{ visible:false }`. Crucially, hiddenness comes from this
   * flag, not from a measured zero size — so a legitimately 0-sized but
   * visible target still publishes `visible:true`.
   */
  visible: boolean
  /** Receives each explicit Placement. Owns IPC → host. */
  publish: (placement: Placement) => void
  /**
   * Opt-in geometry detach. When true, a measured zero-area target (no
   * geometry box — display:none / unmounted / unstable first layout) publishes
   * `{ visible:false }` (detach-but-keep) instead of `{ visible:true,
   * bounds:0×0 }`, and an IntersectionObserver is attached so a display:none
   * transition (which ResizeObserver does not report) re-publishes. Default
   * false keeps the legitimate 0×0-visible semantics.
   */
  guardDisplayNone?: boolean
  /**
   * Opt-in capture-phase ancestor-scroll follow (§2.C). When true, the anchor
   * listens for `scroll` on `window` in the CAPTURE phase (scroll events don't
   * bubble, but reach `window` while capturing), so an ancestor scroll
   * container scrolling the target re-measures and re-publishes. With
   * `followGeometry` off, the scroll callback does a single synchronous
   * `emit()`; with it on, the scroll OPENS the RAF sentinel window so the
   * follow tracks every frame of a scroll burst. Default false.
   */
  followScroll?: boolean
  /**
   * Opt-in windowed RAF geometry sentinel (§2.D/§6). Catches ancestor
   * transform / reflow moves that no DOM event reports. The sentinel is
   * NON-resident: it is OPENED on demand (a scroll burst, a `[role="separator"]`
   * splitter pointerdown, or an explicit `pulse()`), polls geometry once per
   * animation frame publishing IN-FRAME, and AUTO-CLOSES once the rect goes
   * steady (a few unchanged frames). While closed it schedules no frame, so the
   * static cost when idle is exactly zero. Default false.
   */
  followGeometry?: boolean
}

export interface PlacementAnchorHandle {
  /** Apply new options; re-publishes immediately (mirrors `createViewAnchor`). */
  update(opts: PlacementAnchorOptions): void
  /** Stop observing; never publish again. */
  dispose(): void
  /**
   * Open the RAF sentinel window (animation follow); auto-closes after going
   * steady or after `durationMs`. No-op when `followGeometry` is false.
   */
  pulse(durationMs?: number): void
}

/**
 * Pure measure: read `target`'s rect and wrap it as an explicit visible
 * Placement. Always `{ visible:true }` — hiddenness is a caller decision
 * (see `createPlacementAnchor`), so this never returns `{ visible:false }`
 * and never infers visibility from a 0 size. A collapsed (0×0) but present
 * element therefore yields `{ visible:true, bounds:{...,width:0,height:0} }`,
 * distinct from any hidden Placement.
 */
export function measurePlacement(target: HTMLElement): Placement {
  const r = target.getBoundingClientRect()
  return {
    visible: true,
    bounds: clampRect({ x: r.left, y: r.top, width: r.width, height: r.height }),
  }
}

const samePlacement = (a: Placement, b: Placement): boolean => {
  // Discriminant-aware dedup: a visibility flip is always a change, even when
  // the geometry would otherwise look identical.
  if (a.visible !== b.visible) return false
  if (a.visible && b.visible) {
    return (
      a.bounds.x === b.bounds.x &&
      a.bounds.y === b.bounds.y &&
      a.bounds.width === b.bounds.width &&
      a.bounds.height === b.bounds.height
    )
  }
  return true
}

/**
 * The explicit-Placement mirror of `createViewAnchor`. Same observer/dedup/
 * teardown machinery, but the sink receives a `Placement`:
 *   - `visible === true`  → publish `measurePlacement(target)` and re-publish
 *     SYNCHRONOUSLY on every `ResizeObserver`/`resize` tick.
 *   - `visible === false` → publish `{ visible:false }` (NOT a ZERO bounds);
 *     do not observe.
 *
 * Dedup carries the discriminant (`samePlacement`), so a visibility flip is
 * never coalesced away.
 *
 * Opt-in `guardDisplayNone` (default false): when on, a measured zero-area
 * target (display:none / unmounted / unstable first layout) publishes
 * `{ visible:false }` instead of `{ visible:true, bounds:0×0 }`, and an
 * IntersectionObserver is attached so a display:none transition (which
 * ResizeObserver does not report) re-publishes.
 */
export function createPlacementAnchor(
  target: HTMLElement,
  opts: PlacementAnchorOptions,
): PlacementAnchorHandle {
  let visible = opts.visible
  let publish = opts.publish
  const guardDisplayNone = opts.guardDisplayNone ?? false
  // Captured at creation; the follow options are never re-set via update().
  const followScroll = opts.followScroll ?? false
  const followGeometry = opts.followGeometry ?? false
  let observer: ResizeObserver | null = null
  let io: IntersectionObserver | null = null
  let lastPublished: Placement | null = null
  let disposed = false

  // ── Windowed RAF geometry sentinel state (§2.D/§6) ──────────────────
  // The sentinel is a windowed poll, opened on demand and auto-closing once
  // the geometry goes steady. It publishes IN-FRAME (no nested defer): each
  // frame measures, and either publishes a changed rect synchronously or
  // counts toward the steady-close threshold. While closed `rafId` is null
  // and no frame is scheduled — zero static cost when idle.
  let rafId: number | null = null
  let steadyFrames = 0
  const STEADY_CLOSE_FRAMES = 2
  // Absolute time (performance.now()) past which a `pulse(durationMs)` window
  // force-closes even if the geometry is still changing — the upper bound that
  // prevents a perpetually-animating target from keeping the sentinel resident.
  // null = no time bound (scroll/splitter opens rely on steady-close instead).
  let sentinelDeadline: number | null = null

  // Measure the target, applying the opt-in first-frame / display:none guard:
  // a zero-area box (no geometry to anchor) becomes a detach instead of a
  // 0×0-visible Placement. Default off → byte-for-byte the plain measure.
  const computePlacement = (): Placement => {
    const p = measurePlacement(target)
    if (
      guardDisplayNone &&
      p.visible &&
      (p.bounds.width === 0 || p.bounds.height === 0)
    ) {
      return { visible: false }
    }
    return p
  }

  const emit = (): void => {
    if (disposed || !visible) return
    const p = computePlacement()
    if (lastPublished && samePlacement(lastPublished, p)) return
    lastPublished = p
    publish(p)
  }

  // One sentinel frame: measure, publish-in-frame if changed, else count toward
  // the steady-close threshold. A changed frame re-arms; a steady frame re-arms
  // until STEADY_CLOSE_FRAMES consecutive unchanged frames, then closes (no
  // re-arm). Reads `disposed`/`visible` live so a frame outliving teardown is
  // inert.
  const sentinelFrame = (): void => {
    rafId = null
    if (disposed || !visible) {
      sentinelDeadline = null
      return
    }
    // §2.F upper bound: a pulse window past its deadline closes regardless of
    // motion, so a target that changes every frame can't keep the sentinel alive.
    if (sentinelDeadline !== null && performance.now() >= sentinelDeadline) {
      sentinelDeadline = null
      return // duration elapsed → close (no re-arm)
    }
    const p = computePlacement()
    if (lastPublished && samePlacement(lastPublished, p)) {
      steadyFrames++
      if (steadyFrames >= STEADY_CLOSE_FRAMES) {
        sentinelDeadline = null
        return // steady → close
      }
    } else {
      lastPublished = p
      publish(p) // publish synchronously in THIS frame
      steadyFrames = 0
    }
    // `publish` may have synchronously disposed (or hidden) the anchor; re-read
    // live state so a re-entrant teardown leaves ZERO scheduled frames (B2).
    if (!disposed && visible) {
      rafId = requestAnimationFrame(sentinelFrame) // keep polling
    } else {
      sentinelDeadline = null
    }
  }

  const openSentinel = (): void => {
    if (!followGeometry || disposed) return
    steadyFrames = 0
    if (rafId === null) rafId = requestAnimationFrame(sentinelFrame)
  }

  const closeSentinel = (): void => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    steadyFrames = 0
    sentinelDeadline = null
  }

  // §2.C — an ancestor scroll moved the target's screen rect. With the sentinel
  // on, open the window so the whole scroll burst is followed frame-by-frame;
  // without it, a single synchronous emit() follows the new rect (A1).
  const onScroll = (): void => {
    if (followGeometry) openSentinel()
    else emit()
  }

  // §2.D — a capture-phase pointerdown on a [role="separator"] splitter handle
  // marks the start of a drag that moves the target via ancestor reflow (no RO
  // tick) → open the sentinel.
  const onPointerDown = (e: Event): void => {
    const t = e.target as Element | null
    if (t && t.closest && t.closest('[role="separator"]')) openSentinel()
  }

  const startObserving = (): void => {
    if (observer) return
    observer = new ResizeObserver(emit)
    observer.observe(target)
    window.addEventListener('resize', emit)
    // A display:none transition is invisible to ResizeObserver; an
    // IntersectionObserver re-fires `emit`, which re-measures via
    // `computePlacement` (now-zero box → detach, restored box → visible).
    if (guardDisplayNone && typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver(emit)
      io.observe(target)
    }
    if (followScroll) {
      window.addEventListener('scroll', onScroll, {
        capture: true,
        passive: true,
      })
    }
    if (followGeometry) {
      window.addEventListener('pointerdown', onPointerDown, { capture: true })
    }
  }

  const stopObserving = (): void => {
    if (observer) {
      observer.disconnect()
      observer = null
    }
    if (io) {
      io.disconnect()
      io = null
    }
    window.removeEventListener('resize', emit)
    window.removeEventListener('scroll', onScroll, {
      capture: true,
    } as EventListenerOptions)
    window.removeEventListener('pointerdown', onPointerDown, {
      capture: true,
    } as EventListenerOptions)
    closeSentinel()
  }

  const apply = (): void => {
    lastPublished = null
    if (visible) {
      startObserving()
      lastPublished = computePlacement()
      publish(lastPublished)
    } else {
      stopObserving()
      const hidden: Placement = { visible: false }
      lastPublished = hidden
      publish(hidden)
    }
  }

  apply()

  return {
    update(next: PlacementAnchorOptions): void {
      if (disposed) return
      publish = next.publish
      visible = next.visible
      apply()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      stopObserving()
    },
    pulse(durationMs?: number): void {
      // Imperative window open (§2.F): start the animation-follow window. It
      // closes on steady (N=2 unchanged frames) OR, when `durationMs` is given,
      // at that deadline — whichever comes first. The deadline is the upper bound
      // that guarantees a still-animating target cannot keep the sentinel
      // resident; without it, only steady-close applies.
      if (disposed || !followGeometry) return
      if (durationMs !== undefined && durationMs > 0) {
        const next = performance.now() + durationMs
        // Extend (never shorten) an existing window's deadline.
        sentinelDeadline = sentinelDeadline === null ? next : Math.max(sentinelDeadline, next)
      }
      openSentinel()
    },
  }
}
