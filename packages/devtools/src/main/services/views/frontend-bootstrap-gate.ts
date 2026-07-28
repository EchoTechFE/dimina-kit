import type { WebContents } from 'electron'

/**
 * The single "front-end bootstrap finished" gate every DevTools front-end
 * injector must pass BEFORE running any `.instance()`-style script in the
 * front-end realm.
 *
 * Why this must exist: the bundled front-end's own `MainImpl.#createAppUI`
 * constructs its singletons in a fixed order, and several of them assert
 * first-creation (`IssuesManager.instance({ensureFirst: true})`). An injected
 * script that constructs a panel singleton early — e.g. a bare
 * `Console.ConsoleView.instance()`, whose field initializers transitively
 * create IssuesManager — makes that assertion throw, and the front-end's
 * bootstrap dies as an unhandled rejection it NEVER recovers from:
 * ActionRegistry/ShortcutRegistry are then never created and the panel
 * renders no tabs at all (the "Missing actionRegistry for shortcutRegistry"
 * permanent-failure mode, confirmed against the real bundled front-end with
 * first-creator stack captures and the matching Chromium 146 source).
 *
 * Iron rule for injectors: BEFORE this gate reports ready, an injected
 * script may only touch registries and InspectorFrontendHost preferences —
 * never any `.instance()` call. (`customizeDevtoolsTabs` is the one
 * documented pre-gate exception: it must run before ViewManager snapshots
 * the view registry, and it only edits the registry.)
 */

/**
 * Side-effect-free in-realm readiness probe, safe to feed directly to
 * `wc.executeJavaScript`. `ShortcutRegistry.instance()` (no args) throws
 * BEFORE constructing anything when the registry does not exist yet, so a
 * false answer costs nothing — and a true answer proves `MainImpl` already
 * passed the point where every bootstrap singleton (IssuesManager included)
 * exists, making singleton-touching injections safe. `EUI` is the bundle's
 * real exposure of the ui/legacy namespace (`globalThis.UI` does not exist
 * on this front-end build). An expression, not a statement list: the value
 * `executeJavaScript` resolves is the IIFE's completion value.
 */
export const FRONTEND_BOOTSTRAP_PROBE_SCRIPT = `(() => {
  try {
    const eui = globalThis.EUI
    if (!eui || !eui.ShortcutRegistry || !eui.ShortcutRegistry.ShortcutRegistry) return false
    eui.ShortcutRegistry.ShortcutRegistry.instance()
    return true
  } catch (_) {
    return false
  }
})()`

export interface WhenFrontendBootstrappedOptions {
  /** Wall-clock give-up bound. Past it the promise resolves false with a
   * single warn — callers degrade silently, matching the surrounding
   * modules' convention. */
  timeoutMs?: number
  /** Probe cadence while the front-end is still booting. */
  intervalMs?: number
}

// Matches the e2e suite's own bootstrap-wait window (console-filter-live's
// 45s probe poll) so a slow-but-alive bootstrap never lands in a band where
// production has given up while the spec still expects the injections.
const DEFAULT_TIMEOUT_MS = 45_000
const DEFAULT_INTERVAL_MS = 150

/**
 * Poll the probe against `wc` until the front-end bootstrap is provably
 * complete. Resolves true on readiness; false on timeout (one warn) or a
 * destroyed wc — never rejects, and never leaves a live timer behind after
 * settling. A rejected probe call (execution context torn down mid-load,
 * navigation in flight) counts as "not ready yet", not as an error.
 *
 * The timeout is an INDEPENDENT hard deadline racing the poll — not a check
 * inside the poll chain. A probe `executeJavaScript` promise that never
 * settles (frame destroyed mid-call / a wc permanently stuck loading) would
 * stall a chain-embedded check forever; the deadline settles this promise
 * regardless.
 */
export function whenFrontendBootstrapped(
  wc: WebContents,
  opts?: WhenFrontendBootstrappedOptions,
): Promise<boolean> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let settled = false

    const finish = (ready: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      resolve(ready)
    }

    const deadline = setTimeout(() => {
      // Within one call "ready" was never observed — a dead bootstrap and a
      // merely-slow one are indistinguishable from out here; say so.
      console.warn(`[frontend-bootstrap-gate] front-end bootstrap probe never reported ready within ${timeoutMs}ms — bootstrap-gated injections stay skipped for this host`)
      finish(false)
    }, timeoutMs)
    deadline.unref?.()

    const attempt = (): void => {
      if (wc.isDestroyed()) {
        finish(false)
        return
      }
      Promise.resolve()
        .then(() => wc.executeJavaScript(FRONTEND_BOOTSTRAP_PROBE_SCRIPT))
        .then((ready) => ready === true, () => false)
        .then((ready) => {
          if (settled) return
          // Destroyed-check BEFORE honoring a ready answer: a probe that was
          // in flight when the wc got destroyed can still resolve true, and
          // reporting "bootstrapped" for a dead target contradicts this
          // function's contract (destroyed ⇒ false).
          if (wc.isDestroyed()) {
            finish(false)
            return
          }
          if (ready) {
            finish(true)
            return
          }
          timer = setTimeout(attempt, intervalMs)
          timer.unref?.()
        })
    }

    attempt()
  })
}
