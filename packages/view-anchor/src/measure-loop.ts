/**
 * Internal — the RAF-coalesced measure/dedupe/dispose engine behind the REVERSE
 * primitive `createSizeAdvertiser`.
 *
 * The forward `createViewAnchor` deliberately does NOT use this: it publishes
 * SYNCHRONOUSLY (a native overlay's `setBounds` already lands a cross-process
 * frame late, and a RAF stacked a second frame of visible trailing). The
 * reverse direction is different — it is a cross-process FEEDBACK loop
 * (advertise → host resizes the view → content re-measures → re-advertise), so
 * the RAF's one-publish-per-frame coalescing is a useful damper. The two
 * directions thus have different optimal emit timing; this engine serves only
 * the reverse.
 *
 * NOT exported from the package: it is pure mechanism with no knowledge of
 * direction, the DOM, `ResizeObserver`, or the structure of the value `T` it
 * carries. The wrapping primitive injects `produce` / `same` / `sink` and
 * drives the lifecycle.
 *
 *   - `schedule()`  — coalesce a burst of triggers into ONE RAF; the frame
 *     body re-`produce()`s, dedupes against the last emit (`same`), and `sink`s.
 *     Bails if inactive or disposed (stale-RAF safe).
 *   - `emitNow(v)`  — explicit synchronous emit (create / update path). Always
 *     fires, bypassing the dedupe check, and refreshes the dedupe baseline.
 *   - `setActive`   — gate the observer stream; a queued frame bails on `!active`.
 *   - `cancel`      — drop any in-flight RAF.
 *   - `dispose`     — cancel + go inert; after dispose nothing emits again.
 */
export interface MeasureLoop<T> {
  schedule(): void
  emitNow(value: T): void
  setActive(on: boolean): void
  cancel(): void
  dispose(): void
}

export function createMeasureLoop<T>(cfg: {
  /** Produce the value to emit in the RAF body. Return `null` to decline the
   *  frame entirely (no dedupe, no sink, baseline untouched) — e.g. a
   *  non-finite or unavailable measurement. */
  produce: () => T | null
  same: (a: T, b: T) => boolean
  sink: (value: T) => void
}): MeasureLoop<T> {
  const { produce, same, sink } = cfg
  let rafId: number | null = null
  let active = false
  let disposed = false
  let last: T | null = null

  const cancel = (): void => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
  }

  return {
    schedule(): void {
      if (disposed || !active || rafId !== null) return
      rafId = requestAnimationFrame(() => {
        rafId = null
        if (disposed || !active) return
        const value = produce()
        if (value === null) return // producer declined this frame
        // last-value dedupe: a frame whose produced value equals the last one
        // we emitted costs nothing (no IPC / setBounds).
        if (last !== null && same(value, last)) return
        last = value
        sink(value)
      })
    },
    emitNow(value: T): void {
      if (disposed) return
      last = value
      sink(value)
    },
    setActive(on: boolean): void {
      active = on
    },
    cancel,
    dispose(): void {
      if (disposed) return
      disposed = true
      cancel()
    },
  }
}
