/**
 * Cross-process readiness primitive (shared abstraction).
 *
 * Replaces the blind `setTimeout(1500/2000)` navigation waits in automation
 * handlers with "wait for the bridge's `activePage` signal, with a timeout
 * floor". The bridge (`BridgeRouterHandle`) already fan-outs an `activePage`
 * render event whenever the DeviceShell reports a new top-of-stack page, so we
 * wait for that real signal instead of guessing how long a navigation takes.
 *
 * Design contract:
 *   - Subscribe to `bridge.onRenderEvent` and resolve on the first matching
 *     `activePage` event. "Matching" = `opts.match(bridgeId, pagePath)` when a
 *     predicate is supplied, otherwise `bridgeId !== opts.since` (i.e. the
 *     active page actually changed away from where navigation started).
 *   - Timeout floor: resolve (NEVER reject, never hang) at `opts.timeoutMs` so a
 *     caller awaiting this can always make progress even if the signal is lost.
 *   - Race close: navigation can land before we subscribe, so read
 *     `getActiveBridgeId()` once right after subscribing; when no `match`
 *     predicate is given and it is already `!== since`, resolve immediately.
 *     (With a `match` predicate we cannot decide from the bridgeId alone — there
 *     is no pagePath in the snapshot — so we wait for an event.)
 *   - Resolve exactly once; later events are inert and the subscription is torn
 *     down on resolve.
 */

/** The render-event shape `waitForActivePage` reads (subset of `RenderEvent`). */
export interface ActivePageEventLike {
  kind: 'domReady' | 'activePage'
  appId: string
  bridgeId: string
  pagePath?: string
}

/** Minimal bridge surface this helper is allowed to touch. */
export interface WaitActivePageBridge {
  onRenderEvent(listener: (event: ActivePageEventLike) => void): () => void
  getActiveBridgeId(): string | null
}

export interface WaitActivePageOptions {
  /** The active bridgeId before navigation started (or null if unknown). */
  since: string | null
  /** Timeout floor in ms — resolve unconditionally once this elapses. */
  timeoutMs: number
  /**
   * Optional predicate deciding which `activePage` event ends the wait. When
   * omitted, any `activePage` whose `bridgeId !== since` ends it.
   */
  match?: (bridgeId: string, pagePath?: string) => boolean
  /**
   * Fired exactly once if the wait resolves via the timeout floor rather than a
   * matching signal — i.e. the expected `activePage` was never observed. Lets
   * the caller surface "signal not seen, proceeding on timeout" instead of
   * silently masking a lost signal. Never fired on a signal/race-close resolve.
   */
  onTimeout?: () => void
}

export function waitForActivePage(
  bridge: WaitActivePageBridge,
  opts: WaitActivePageOptions,
): Promise<void> {
  const { since, timeoutMs, match, onTimeout } = opts

  return new Promise<void>((resolve) => {
    let isSettled = false
    let unsubscribe: (() => void) | null = null
    let timer: ReturnType<typeof setTimeout> | null = null

    const finish = (): void => {
      if (isSettled) return
      isSettled = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      if (unsubscribe) {
        unsubscribe()
        unsubscribe = null
      }
      resolve()
    }

    const matches = (bridgeId: string, pagePath?: string): boolean =>
      match ? match(bridgeId, pagePath) : bridgeId !== since

    unsubscribe = bridge.onRenderEvent((event) => {
      if (isSettled) return
      if (event.kind !== 'activePage') return
      if (matches(event.bridgeId, event.pagePath)) finish()
    })

    // Timeout floor — resolve (never reject) so awaiters never hang. Fire the
    // optional onTimeout hook first so a lost signal is visible, not masked.
    timer = setTimeout(() => {
      if (isSettled) return
      onTimeout?.()
      finish()
    }, timeoutMs)

    // Race close: the page may already have advanced before we subscribed.
    // Only decidable without a pagePath when no `match` predicate is supplied.
    if (!match) {
      const current = bridge.getActiveBridgeId()
      if (current !== null && current !== since) finish()
    }
  })
}
