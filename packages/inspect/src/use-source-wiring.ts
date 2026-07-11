// The source-lifecycle wiring every connected panel shares, written once:
// subscription + feed-gate lifecycle per (source, enabled), visibility
// forwarding, and the (enabled && active) rising-edge seed (including a
// source swap while on) with late-resolution dropping. Panel-specific parts —
// what a push event does to state and how a snapshot lands — come in as the
// `subscribe`/`seed` handlers, read through a ref so effects depend only on
// (source, enabled, active) and inline handler lambdas never re-fire them.
import { useEffect, useRef } from 'react'

interface ConnectedSource {
  setActive(on: boolean): void
}

export function useSourceWiring<S extends ConnectedSource>(options: {
  source: S
  /** Data availability gate: while false, zero source calls are made. */
  enabled: boolean
  /** Panel visibility (the host's tab-active state). */
  active: boolean
  /** Open the live push subscription; returns the unsubscriber. */
  subscribe: (source: S) => () => void
  /** Fetch + apply one snapshot. `isDisposed()` turns true once this seed's
   * cleanup ran (unmount or a newer seed) — a resolution arriving after that
   * must be dropped by the handler. */
  seed: (source: S, isDisposed: () => boolean) => void
}): void {
  const { source, enabled, active } = options
  // Declared before every consuming effect so it runs first on each commit
  // and the handlers are always current when an effect fires.
  const handlers = useRef({ subscribe: options.subscribe, seed: options.seed })
  useEffect(() => {
    handlers.current = { subscribe: options.subscribe, seed: options.seed }
  })

  // Subscription + feed-gate lifecycle, per (source, enabled). Cleanup disarms
  // the producer's feed so an unmounted/disabled panel costs nothing; a source
  // swap tears the old transport down first.
  useEffect(() => {
    if (!enabled) return
    const unsubscribe = handlers.current.subscribe(source)
    return () => {
      unsubscribe()
      source.setActive(false)
    }
  }, [source, enabled])

  // Forward the visibility gate on every change while enabled.
  useEffect(() => {
    if (!enabled) return
    source.setActive(active)
  }, [source, enabled, active])

  // Seed on the (enabled && active) rising edge — including a source swap
  // while on. A kept-alive tab that turns active again re-fetches, so it never
  // shows data from before its invisible stretch.
  const prevSeed = useRef<{ source: S | null, on: boolean }>({ source: null, on: false })
  useEffect(() => {
    const on = enabled && active
    const prev = prevSeed.current
    const rising = on && (!prev.on || prev.source !== source)
    prevSeed.current = { source, on }
    if (!rising) return undefined
    let disposed = false
    handlers.current.seed(source, () => disposed)
    return () => {
      disposed = true
    }
  }, [source, enabled, active])
}
