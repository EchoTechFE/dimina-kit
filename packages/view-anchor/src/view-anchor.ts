import type { Bounds, ViewAnchorOptions, ViewAnchorHandle } from './types.js'

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
