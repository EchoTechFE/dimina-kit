/**
 * Persistent (subscription) simulator APIs — a call that, once made, keeps
 * delivering a response on every underlying event instead of settling once.
 *
 * The dimina service runtime strips `keep` / `evtId` / `success` before the
 * call leaves the service host (it stores them service-local in
 * `callback.store`), so by the time `audioListen` reaches the container its
 * `keep: true` intent is gone and it would degrade to a one-shot call —
 * dropping every audio DOM event after the first. The container and router
 * therefore recognise these APIs by NAME and treat them as persistent
 * regardless of the (stripped) params.
 *
 * Currently only `audioListen` — the InnerAudioContext DOM-event bridge
 * (canplay / play / pause / ended / error / timeupdate / waiting / seeking /
 * seeked). Add any new subscription API here: this is the single source of
 * truth, consumed by `bridge-router` (skip the one-shot timeout, keep-alive
 * responses) and `run-api-async` (no premature settle, re-fire on every event).
 */
import { MAX_TIMEOUT_MS, resolveTimeoutBudgetMs } from './request-core.js'

export const PERSISTENT_SIMULATOR_APIS: ReadonlySet<string> = new Set(['audioListen'])

export function isPersistentSimulatorApi(name: string): boolean {
  return PERSISTENT_SIMULATOR_APIS.has(name)
}

/**
 * APIs whose one-shot call legitimately runs as long as the caller's wx
 * network timeout budget (`params.timeout`, default 60000ms) — the simulator
 * handler answers when the network answers, not within a fixed router window.
 */
export const NETWORK_BUDGET_SIMULATOR_APIS: ReadonlySet<string> = new Set([
  'request',
  'downloadFile',
  'uploadFile',
])

/**
 * Flat watchdog window for forwarded one-shot calls whose handler is expected
 * to answer promptly; it guards against a missing handler / dead seam.
 */
export const API_CALL_WATCHDOG_MS = 5_000

/**
 * How long bridge-router's one-shot "no handler" watchdog waits before
 * tearing a forwarded simulator-API call down.
 *
 * Network-budget APIs get their wx timeout budget plus the flat window as
 * forwarding grace: the handler owns the real deadline (performRequest emits
 * `request:fail timeout` at the budget), so the watchdog only has to catch
 * the case where no verdict ever comes back. A flat 5s window here would
 * kill any HTTP call slower than 5s and drop its late — perfectly valid —
 * response. Every other API keeps the flat window.
 */
export function apiCallWatchdogMs(
  name: string,
  params: Record<string, unknown> | undefined,
): number {
  if (!NETWORK_BUDGET_SIMULATOR_APIS.has(name)) return API_CALL_WATCHDOG_MS
  // resolveTimeoutBudgetMs rejects non-finite/oversized caller timeouts, and
  // the final clamp keeps budget+grace inside setTimeout's range — an
  // overflowing delay would wrap to ~1ms and fire the watchdog immediately.
  const budget = resolveTimeoutBudgetMs(params?.timeout)
  return Math.min(budget + API_CALL_WATCHDOG_MS, MAX_TIMEOUT_MS)
}
