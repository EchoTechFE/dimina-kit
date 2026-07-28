/**
 * Shared `wc.debugger` (CDP) session broker for render-host guest WebContents.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `webContents.debugger` is exclusive per wc (only one `attach()` owner at a
 * time). Four independent modules — safe-area, elements-forward, render-inspect
 * and network-forward — each hand-roll the same "reuse if already attached,
 * self-attach only if nobody has, track what I self-attached so I only detach
 * my own" bookkeeping, and each installs its OWN `wc.debugger.on('message', …)`
 * listener. That duplication caused two real bugs:
 *
 *  1. network-forward's `attachRenderGuest` runs ONCE per guest (at webview
 *     creation). If some OTHER module later detaches the shared session it
 *     happened to self-attach, network-forward's capture dies permanently —
 *     nothing re-attaches it (unlike safe-area/elements-forward/render-inspect,
 *     which lazily re-`ensure` the debugger on every use and so self-heal).
 *  2. On the simulator wc, two modules each do "detach if attached" with no
 *     notion of the other — whichever runs last steals the other's session.
 *
 * This broker is the single owner of "who attached, who may detach": callers
 * `acquire(wc)` a lease instead of touching `wc.debugger` directly. A session's
 * lifetime tracks the wc, not any one lease — the last lease releasing does
 * NOT detach (another consumer may `acquire` again at any time); only the
 * broker's own top-level `dispose()` detaches sessions IT self-attached. An
 * external detach (another owner, or a real Chrome DevTools window stealing the
 * session) notifies every lease's `onDetach` and drops the session's
 * bookkeeping so the NEXT `acquire()` attaches from scratch — closing bug #1
 * structurally instead of requiring every consumer to remember to re-ensure.
 */
import type { WebContents } from 'electron'
import type { ConnectionRegistry, Disposable } from '@dimina-kit/electron-deck/main'

export interface CdpSessionLease {
  /** Send one CDP command on this wc's session. Rejects if the session/wc is gone. */
  send(method: string, params?: object): Promise<unknown>
  /**
   * Subscribe to every CDP `message` event this session receives. Multiple
   * leases (from the same or different `acquire()` calls) share ONE real
   * `wc.debugger.on('message', …)` listener, fanned out to every subscriber.
   */
  onMessage(cb: (method: string, params: unknown) => void): Disposable
  /**
   * Subscribe to this session becoming unusable for any reason OTHER than the
   * broker's own top-level `dispose()`: an external detach (another owner
   * releasing it, or a real Chrome DevTools window stealing it) OR the wc
   * itself being destroyed. Either way the broker has already dropped its
   * bookkeeping for this session by the time this fires — a consumer that
   * caches its lease should drop the cache entry here so its NEXT `acquire()`
   * gets a fresh one instead of operating on a dead lease. The broker's own
   * `dispose()` detaching a session it self-attached does NOT fire this: that
   * is an intentional, expected teardown, not a surprise the caller needs to
   * react to.
   */
  onDetach(cb: () => void): Disposable
  /**
   * Enable DOM + CSS + Overlay (the render-inspection domains) once per
   * session, in dependency order (`Overlay.enable` must follow `DOM.enable`'s
   * resolution — Chromium rejects it otherwise; `CSS.enable` has no such
   * dependency). Memoized PER SESSION (not per lease): concurrent callers on
   * the same wc share one in-flight/completed handshake. Invalidated on any
   * detach (self or external) so a later session re-runs it fresh.
   */
  ensureRenderDomains(): Promise<void>
  /**
   * Release every subscription THIS lease registered via `onMessage`/
   * `onDetach`. Idempotent. Never detaches the underlying session — that
   * follows the wc's lifetime, not any one lease's.
   */
  dispose(): void
}

export interface CdpSessionBroker {
  /**
   * Get-or-create a lease for `wc`'s debugger session. Returns `null` when the
   * wc is already destroyed, or when the debugger is exclusively held
   * elsewhere and unavailable to attach (e.g. a real Chrome DevTools window).
   */
  acquire(wc: WebContents): CdpSessionLease | null
  /**
   * Project-level teardown: detach every session this broker itself
   * self-attached (never one it merely reused). Sessions owned by someone
   * else are left untouched.
   */
  dispose(): void
}

interface Session {
  wc: WebContents
  selfAttached: boolean
  /** True only while THIS broker's own detach() call is in flight (dispose()). */
  selfDetaching: boolean
  messageSubs: Set<(method: string, params: unknown) => void>
  detachSubs: Set<() => void>
  enablePromise: Promise<void> | null
  onDbgMessage: (...args: unknown[]) => void
  onDbgDetach: () => void
  onWcDestroyed: () => void
  destroyedSub?: { dispose(): void }
}

export function createCdpSessionBroker(opts: { connections?: ConnectionRegistry } = {}): CdpSessionBroker {
  const sessions = new Map<WebContents, Session>()

  function removeDebuggerListeners(session: Session): void {
    try { session.wc.debugger.removeListener('message', session.onDbgMessage) } catch { /* wc gone */ }
    try { session.wc.debugger.removeListener('detach', session.onDbgDetach) } catch { /* wc gone */ }
  }

  function notifyDetach(session: Session): void {
    for (const cb of [...session.detachSubs]) {
      try { cb() } catch { /* subscriber error is not our problem */ }
    }
  }

  function ensureSession(wc: WebContents): Session | null {
    const existing = sessions.get(wc)
    if (existing) return existing

    let selfAttached = false
    try {
      if (!wc.debugger.isAttached()) {
        wc.debugger.attach('1.3')
        selfAttached = true
      }
    } catch {
      // Exclusively held elsewhere (e.g. a real Chrome DevTools window) and
      // refused to share — degrade to "unavailable", same as every existing
      // per-module implementation this broker replaces.
      return null
    }

    const session: Session = {
      wc,
      selfAttached,
      selfDetaching: false,
      messageSubs: new Set(),
      detachSubs: new Set(),
      enablePromise: null,
      onDbgMessage: (...args: unknown[]) => {
        const [, method, params] = args as [unknown, string, unknown]
        for (const cb of [...session.messageSubs]) cb(method, params)
      },
      onDbgDetach: () => {
        const wasSelfInitiated = session.selfDetaching
        session.selfDetaching = false
        session.enablePromise = null
        sessions.delete(wc)
        removeDebuggerListeners(session)
        try { session.destroyedSub?.dispose() } catch { /* already gone */ }
        if (!wasSelfInitiated) notifyDetach(session)
      },
      onWcDestroyed: () => {
        sessions.delete(wc)
        removeDebuggerListeners(session)
        // Deliberately does NOT call wc.debugger.detach(), even for a
        // self-attached session: a destroyed wc's debugger is torn down by
        // Electron itself, there is nothing left for us to usefully detach,
        // and attempting it is an unnecessary risk (the underlying native
        // objects may already be gone). Dropping our bookkeeping is enough.
        // Not a broker-initiated detach — same "your lease is dead, re-acquire
        // next time" signal as an external debugger detach, just for a
        // different reason (the wc itself is gone, not merely the session).
        notifyDetach(session)
      },
    }

    wc.debugger.on('message', session.onDbgMessage)
    wc.debugger.on('detach', session.onDbgDetach)

    if (opts.connections) {
      session.destroyedSub = opts.connections.acquire(wc).on('closed', session.onWcDestroyed)
    } else {
      try { wc.once('destroyed', session.onWcDestroyed) } catch { /* fake/minimal wc */ }
    }

    sessions.set(wc, session)
    return session
  }

  function ensureRenderDomains(session: Session): Promise<void> {
    if (session.enablePromise) return session.enablePromise
    session.wc.debugger.sendCommand('CSS.enable').catch(() => { /* no ordering dependency */ })
    const p = session.wc.debugger
      .sendCommand('DOM.enable')
      .then(() => session.wc.debugger.sendCommand('Overlay.enable'))
      .then(() => undefined)
      .catch(() => {
        // Guest mid-teardown or domain unavailable — drop the memo so a later
        // call (e.g. after the session recovers) can retry instead of being
        // stuck on a permanently-failed handshake.
        session.enablePromise = null
      })
    session.enablePromise = p
    return p
  }

  function createLease(session: Session): CdpSessionLease {
    const ownMessageSubs = new Set<(method: string, params: unknown) => void>()
    const ownDetachSubs = new Set<() => void>()
    return {
      // Echo the caller's exact arity through to sendCommand — a caller that
      // omits params (many CDP commands take none, e.g. 'Network.enable')
      // gets the identical call Electron's own API expects, not a synthetic
      // `{}` second argument.
      send: (method, params) => params === undefined
        ? session.wc.debugger.sendCommand(method)
        : session.wc.debugger.sendCommand(method, params),
      onMessage: (cb) => {
        session.messageSubs.add(cb)
        ownMessageSubs.add(cb)
        return { dispose: () => { session.messageSubs.delete(cb); ownMessageSubs.delete(cb) } }
      },
      onDetach: (cb) => {
        session.detachSubs.add(cb)
        ownDetachSubs.add(cb)
        return { dispose: () => { session.detachSubs.delete(cb); ownDetachSubs.delete(cb) } }
      },
      ensureRenderDomains: () => ensureRenderDomains(session),
      dispose: () => {
        for (const cb of ownMessageSubs) session.messageSubs.delete(cb)
        for (const cb of ownDetachSubs) session.detachSubs.delete(cb)
        ownMessageSubs.clear()
        ownDetachSubs.clear()
      },
    }
  }

  return {
    acquire(wc) {
      if (wc.isDestroyed()) return null
      const session = ensureSession(wc)
      if (!session) return null
      return createLease(session)
    },
    dispose() {
      for (const session of [...sessions.values()]) {
        if (session.selfAttached) {
          session.selfDetaching = true
          try {
            if (!session.wc.isDestroyed() && session.wc.debugger.isAttached()) {
              session.wc.debugger.detach()
            }
          } catch { /* already detached / destroyed */ }
        }
        // Whether detach ran above (which already self-cleans via onDbgDetach)
        // or this session was externally-owned (never touched), make sure
        // broker-side bookkeeping is gone either way.
        sessions.delete(session.wc)
        removeDebuggerListeners(session)
        try { session.destroyedSub?.dispose() } catch { /* already gone */ }
      }
    },
  }
}
