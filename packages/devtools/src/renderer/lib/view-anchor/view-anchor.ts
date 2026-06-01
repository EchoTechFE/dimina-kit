import type { Bounds, ViewAnchorOptions, ViewAnchorHandle } from './types'

const ZERO: Bounds = { x: 0, y: 0, width: 0, height: 0 }

/**
 * Create an anchor binding ONE native view's bounds to `target`'s geometry.
 *
 * Imperative core — no React, no Electron. Behaviour:
 *   - `present === true`: publish `target.getBoundingClientRect()` (each
 *     field `Math.max(0, Math.round(...))`) immediately, then re-publish
 *     (RAF-throttled, coalesced) on every `ResizeObserver` tick + window
 *     `resize`.
 *   - `present === false`: publish `{0,0,0,0}` immediately; do not observe.
 *   - `update(opts)`: cancel any in-flight RAF, then re-apply synchronously.
 *   - `dispose()`: stop observing, cancel pending RAF, never publish again.
 *
 * Stale-RAF safety: a RAF queued under the old state is cancelled by every
 * `update`/`dispose`, and the RAF body itself bails on `disposed`/`!present`
 * — so a frame scheduled before a state change can never write a stale rect
 * over the live one. (Same guard discipline as the production
 * `use-cell-bounds` effect and dockview's `OverlayRenderContainer`.)
 */
export function createViewAnchor(
  target: HTMLElement,
  opts: ViewAnchorOptions,
): ViewAnchorHandle {
  let present = opts.present
  let publish = opts.publish
  let observer: ResizeObserver | null = null
  let rafId: number | null = null
  let disposed = false

  const measure = (): Bounds => {
    const r = target.getBoundingClientRect()
    return {
      x: Math.max(0, Math.round(r.left)),
      y: Math.max(0, Math.round(r.top)),
      width: Math.max(0, Math.round(r.width)),
      height: Math.max(0, Math.round(r.height)),
    }
  }

  const cancelPending = (): void => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
  }

  // Coalesce a burst of observer/resize ticks in one frame into a single
  // publish; bail if torn down or detached before the frame runs.
  const scheduleEmit = (): void => {
    if (disposed || !present || rafId !== null) return
    rafId = requestAnimationFrame(() => {
      rafId = null
      if (disposed || !present) return
      publish(measure())
    })
  }

  const startObserving = (): void => {
    if (observer) return
    observer = new ResizeObserver(scheduleEmit)
    observer.observe(target)
    window.addEventListener('resize', scheduleEmit)
  }

  const stopObserving = (): void => {
    cancelPending()
    if (observer) {
      observer.disconnect()
      observer = null
    }
    window.removeEventListener('resize', scheduleEmit)
  }

  // Apply the current (present, publish) synchronously.
  const apply = (): void => {
    if (present) {
      startObserving()
      publish(measure())
    } else {
      stopObserving()
      publish(ZERO)
    }
  }

  apply()

  return {
    update(next: ViewAnchorOptions): void {
      if (disposed) return
      // Drop any in-flight RAF queued under the old state before the
      // synchronous re-publish below — otherwise it would land late and
      // overwrite the fresh rect.
      cancelPending()
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
