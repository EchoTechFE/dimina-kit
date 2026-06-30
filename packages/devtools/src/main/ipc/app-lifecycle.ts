/**
 * Per-app-session registry for the app-level lifecycle listeners registered
 * from the mini-program service layer: `wx.onAppShow` / `onAppHide` / `onError`
 * (and their `off*` removers).
 *
 * These arrive as keep subscriptions — `wx.onAppShow(cb)` encodes `cb` as a
 * persistent callback id in `params.success` (service `callback.store(fn,
 * keep=true)`), so the router stores the id here and re-fires it via
 * `sendCallback` on every app foreground / background / error.
 *
 * `wx.offAppShow(cb)` re-encodes the SAME `cb`: with `keep=true`,
 * `callback.store` dedups by function and returns the original evtId, so `off*`
 * carries that id and removes exactly that listener. `wx.offAppShow()` with no
 * argument carries no id and clears every listener of the event (WeChat
 * contract).
 */

export type AppLifecycleEvent = 'onAppShow' | 'onAppHide' | 'onError'

export interface AppLifecycleController {
  /** Store a keep callback id for an event. Null/undefined ids are ignored. */
  register(appSessionId: string, event: AppLifecycleEvent, callbackId: unknown): void
  /**
   * Remove a listener. With `callbackId`, removes only that id; without one,
   * clears every listener of the event for the session.
   */
  unregister(appSessionId: string, event: AppLifecycleEvent, callbackId?: unknown): void
  /** Snapshot of the registered callback ids (empty for unknown session/event). */
  listeners(appSessionId: string, event: AppLifecycleEvent): unknown[]
  /** Drop all listeners for a torn-down session. */
  dispose(appSessionId: string): void
}

type SessionListeners = Map<AppLifecycleEvent, Set<unknown>>

export function createAppLifecycleController(): AppLifecycleController {
  const sessions = new Map<string, SessionListeners>()

  return {
    register(appSessionId, event, callbackId) {
      if (callbackId === undefined || callbackId === null) return
      let events = sessions.get(appSessionId)
      if (!events) {
        events = new Map()
        sessions.set(appSessionId, events)
      }
      let ids = events.get(event)
      if (!ids) {
        ids = new Set()
        events.set(event, ids)
      }
      ids.add(callbackId)
    },

    unregister(appSessionId, event, callbackId) {
      const events = sessions.get(appSessionId)
      if (!events) return
      if (callbackId === undefined || callbackId === null) {
        events.delete(event)
        return
      }
      events.get(event)?.delete(callbackId)
    },

    listeners(appSessionId, event) {
      const ids = sessions.get(appSessionId)?.get(event)
      return ids ? Array.from(ids) : []
    },

    dispose(appSessionId) {
      sessions.delete(appSessionId)
    },
  }
}
