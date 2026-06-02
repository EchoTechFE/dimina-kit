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
export const PERSISTENT_SIMULATOR_APIS: ReadonlySet<string> = new Set(['audioListen'])

export function isPersistentSimulatorApi(name: string): boolean {
  return PERSISTENT_SIMULATOR_APIS.has(name)
}
