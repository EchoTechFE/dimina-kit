/**
 * Session-scoped listener bookkeeping. An app session hangs lifecycle hooks on
 * emitters it does NOT own — the shared simulator WebContentsView, a pooled
 * service-host window — and those emitters outlive the session (one simulator
 * wc soft-reloads through many sessions). Every such hook is registered
 * through this bag so the session's single teardown chokepoint can detach them
 * all with one `dispose()`; a hook left behind survives as a dead listener on
 * the shared emitter, growing by one per soft reload until Node's MaxListeners
 * warning fires.
 */

type Listener = (...args: unknown[]) => void

/**
 * Structural surface of the Node/Electron emitters the bag manages.
 * `removeListener(event, fn)` also detaches a `once(event, fn)` registration:
 * Node's once wrapper keeps a `.listener` back-reference to `fn` and
 * removeListener matches through it. `isDestroyed` covers Electron objects
 * (WebContents / BrowserWindow) whose methods throw once destroyed.
 */
export interface BagEmitter {
  on(event: string, listener: Listener): unknown
  once(event: string, listener: Listener): unknown
  removeListener(event: string, listener: Listener): unknown
  isDestroyed?(): boolean
}

export interface SessionListenerBag {
  /** Attach `fn` via `emitter.on` and track it for dispose. No-op after dispose. */
  on(emitter: BagEmitter, event: string, fn: Listener): void
  /** Attach `fn` via `emitter.once` and track it for dispose. No-op after dispose. */
  once(emitter: BagEmitter, event: string, fn: Listener): void
  /**
   * Detach every tracked listener that may still be attached. Emitters that
   * report `isDestroyed()` are skipped — their listeners died with them, and
   * touching a destroyed Electron object throws. Removing a `once` that
   * already fired is a no-op, so dispose is safe to call FROM one of the
   * bag's own hooks (teardown triggered by the hook itself). Idempotent.
   */
  dispose(): void
}

interface BagRecord {
  emitter: BagEmitter
  event: string
  fn: Listener
}

export function createSessionListenerBag(): SessionListenerBag {
  const records: BagRecord[] = []
  let disposed = false

  return {
    on(emitter, event, fn) {
      if (disposed) return
      emitter.on(event, fn)
      records.push({ emitter, event, fn })
    },
    once(emitter, event, fn) {
      if (disposed) return
      emitter.once(event, fn)
      records.push({ emitter, event, fn })
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const { emitter, event, fn } of records) {
        if (emitter.isDestroyed?.()) continue
        emitter.removeListener(event, fn)
      }
      records.length = 0
    },
  }
}
