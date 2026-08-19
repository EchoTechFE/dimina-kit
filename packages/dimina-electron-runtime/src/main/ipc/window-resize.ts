/**
 * Runtime per-app-session registry for `wx.onWindowResize` listeners.
 *
 * `wx.onWindowResize(listener)` arrives as a keep subscription — the service encodes `listener` as a persistent callback id in `params.success` (service `callback.store(fn, keep=true)`), so the router stores the id here and re-fires it via `sendCallback` on every dispatched PAGE_RESIZE, the same pattern `app-lifecycle.ts` uses for `wx.onAppShow`.
 *
 * `wx.offWindowResize(listener)` carries the id the matching `on` produced — the service keeps its own `listener → evtId` map for this API — so `off` removes exactly that listener. `wx.offWindowResize()` with no argument carries no id and clears every listener of the session (WeChat contract).
 *
 * The ids are opaque here.
 * Whether two ids collide across APIs is the service's business; this registry only ever adds and removes what the service names, and never touches another API's registry.
 */

export interface WindowResizeController {
  /** Store a keep callback id for a session. Null/undefined ids are ignored. */
  register(appSessionId: string, callbackId: unknown): void
  /**
   * Remove a listener.
   * With `callbackId`, removes only that id; without one, clears every listener registered for the session.
   */
  unregister(appSessionId: string, callbackId?: unknown): void
  /** Snapshot of the registered callback ids (empty for an unknown session). */
  listeners(appSessionId: string): unknown[]
  /**
   * Total registered listeners across every session.
   * The ledger's own count, for leak assertions that must return to a baseline exactly after churn — an emptied-but-retained session bucket is itself a leak, so a session with no listeners contributes 0 and leaves no trace.
   */
  count(): number
  /** Drop all listeners for a torn-down session. */
  dispose(appSessionId: string): void
}

export function createWindowResizeController(): WindowResizeController {
  const sessions = new Map<string, Set<unknown>>()

  return {
    register(appSessionId, callbackId) {
      if (callbackId === undefined || callbackId === null) return
      let ids = sessions.get(appSessionId)
      if (!ids) {
        ids = new Set()
        sessions.set(appSessionId, ids)
      }
      ids.add(callbackId)
    },

    unregister(appSessionId, callbackId) {
      if (callbackId === undefined || callbackId === null) {
        sessions.delete(appSessionId)
        return
      }
      const ids = sessions.get(appSessionId)
      if (!ids) return
      ids.delete(callbackId)
      // Drop the bucket with its last listener: an empty Set left behind is an entry that outlives every reason for it to exist.
      if (ids.size === 0) sessions.delete(appSessionId)
    },

    listeners(appSessionId) {
      const ids = sessions.get(appSessionId)
      return ids ? Array.from(ids) : []
    },

    count() {
      let total = 0
      for (const ids of sessions.values()) total += ids.size
      return total
    },

    dispose(appSessionId) {
      sessions.delete(appSessionId)
    },
  }
}
