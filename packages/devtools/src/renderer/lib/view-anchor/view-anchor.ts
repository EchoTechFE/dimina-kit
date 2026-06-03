import type { Bounds, ViewAnchorOptions, ViewAnchorHandle } from './types'

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
 *   - `present === true`: publish the measured rect (x/y rounded, width/height
 *     `Math.max(0, Math.round(...))`) immediately, then re-publish
 *     SYNCHRONOUSLY on every `ResizeObserver` tick, `target` `scroll`, and
 *     window `resize`. The measured rect is `target.getBoundingClientRect()`,
 *     OR `opts.measure()` when provided (which may return `null` to skip a
 *     publish — see `measure` in types).
 *   - `present === false`: publish `{0,0,0,0}` immediately (never routed
 *     through `measure`); do not observe.
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
 * — collapsing a burst of RO+scroll+resize ticks in one frame into one publish —
 * is now served by `lastPublished` dedup: a tick whose measured rect is
 * byte-identical to the last published one is dropped, so a continuous drag
 * still emits at most one publish per distinct rect.
 *
 * `measure` only redirects WHAT is published; the observers (ResizeObserver +
 * scroll on `target`) still watch `target`. This lets the publish track a
 * descendant (e.g. a centered, fixed-size inner element) while the moves are
 * signalled by the `target` that actually resizes/scrolls.
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
  let measureOverride = opts.measure
  let clipToTarget = opts.clipToTarget
  let observer: ResizeObserver | null = null
  // The last rect handed to `publish`, for dedup-coalescing (see header). Reset
  // to `null` on every `apply()` so a state change (e.g. zoom, which rides in
  // the `publish` closure, not in `Bounds`) always forces one fresh publish
  // even when the geometry is unchanged.
  let lastPublished: Bounds | null = null
  let disposed = false

  // The live rect to publish: `measure()` override when given (may be `null`
  // to skip), else `target.getBoundingClientRect()`. Clamped/rounded either way.
  // When `clipToTarget` is on, the raw rect is INTERSECTED with the CURRENT
  // target rect (read live each frame) before clamping — so the published bounds
  // never extend past the visible scroll viewport. An empty intersection yields
  // a <=0 width/height, which `clampRect` turns into the {…,0,0} hidden signal.
  const measure = (): Bounds | null => {
    let raw: { x: number; y: number; width: number; height: number }
    if (measureOverride) {
      const m = measureOverride()
      if (!m) return null
      raw = m
    } else {
      const r = target.getBoundingClientRect()
      raw = { x: r.left, y: r.top, width: r.width, height: r.height }
    }
    if (clipToTarget) {
      const t = target.getBoundingClientRect()
      const left = Math.max(raw.x, t.left)
      const top = Math.max(raw.y, t.top)
      const right = Math.min(raw.x + raw.width, t.right)
      const bottom = Math.min(raw.y + raw.height, t.bottom)
      raw = { x: left, y: top, width: right - left, height: bottom - top }
    }
    return clampRect(raw)
  }

  const sameRect = (a: Bounds, b: Bounds): boolean =>
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

  // Measure + publish SYNCHRONOUSLY on the triggering tick — no RAF defer (see
  // header for why). Bail if torn down or detached, skip when `measure()`
  // reports "not measurable yet" (`null`), and dedup a rect byte-identical to
  // the last published one (collapses a same-frame RO+scroll+resize burst, and
  // a steady drag that re-fires the same final rect, into one publish).
  const emit = (): void => {
    if (disposed || !present) return
    const m = measure()
    if (!m) return
    if (lastPublished && sameRect(lastPublished, m)) return
    lastPublished = m
    publish(m)
  }

  const startObserving = (): void => {
    if (observer) return
    observer = new ResizeObserver(emit)
    observer.observe(target)
    // A `target` that is itself a scroll container moves its measured
    // descendant when scrolled — neither a ResizeObserver (the box doesn't
    // change) nor window `resize` sees that. (No-op for non-scrolling targets:
    // `scroll` doesn't bubble, so it only fires when `target` itself scrolls.)
    target.addEventListener('scroll', emit, { passive: true })
    window.addEventListener('resize', emit)
  }

  const stopObserving = (): void => {
    if (observer) {
      observer.disconnect()
      observer = null
    }
    target.removeEventListener('scroll', emit)
    window.removeEventListener('resize', emit)
  }

  // Apply the current (present, publish, measure) synchronously. Reset
  // `lastPublished` first so the publish below is never dedup-skipped — a state
  // change (zoom, present flip, new publish target) must always re-emit even if
  // the geometry is byte-identical to the previous emit.
  const apply = (): void => {
    lastPublished = null
    if (present) {
      startObserving()
      const m = measure()
      if (m) {
        lastPublished = m
        publish(m)
      }
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
      measureOverride = next.measure
      clipToTarget = next.clipToTarget
      apply()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      stopObserving()
    },
  }
}
