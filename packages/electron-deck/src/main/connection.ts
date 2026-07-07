/**
 * Connection-layer primitive (`Connection` / `ConnectionRegistry`) described in
 * packages/electron-deck/docs/foundation.md's two-teardown-paths section.
 *
 * A `Connection` is one trusted webContents (keyed by the unforgeable `wc.id`).
 * It holds a single `DisposableRegistry` as its "lifetime segment" container.
 * The segment tears down deterministically (LIFO) on hard-destroy
 * (`wc.once('destroyed')`) or soft-reuse (`reset(id)`):
 *   - hard destroy → dispose segment, fire 'closed' once, de-register.
 *   - soft reset   → dispose segment, swap in a fresh registry, fire 'reset',
 *                    connection stays alive & registered.
 *
 * The terminal hook is `'destroyed'` (NOT `'render-process-gone'`), and
 * `DisposableRegistry.disposeAll` is async (LIFO) — so close/reset are async.
 */
import type { WebContents } from 'electron'

import { DisposableRegistry, type Disposable } from './disposable.js'
import { createLogger } from './logger.js'

const log = createLogger('connection')

export interface Connection {
  readonly id: number
  readonly webContents: WebContents
  readonly alive: boolean
  /** Register a resource cleaned up with the current lifetime segment; the
   * returned Disposable releases it early. */
  own(d: Disposable | (() => void)): Disposable
  /** Connection-level lifecycle events; returns an unsubscribe Disposable. */
  on(ev: 'reset' | 'closed', cb: () => void): Disposable
}

export interface ConnectionRegistry {
  /** Build/fetch the connection for a (trusted) webContents; idempotent. */
  acquire(wc: WebContents): Connection
  get(id: number): Connection | undefined
  all(): readonly Connection[]
  /** Soft reuse: dispose the current segment, then swap in a fresh registry. */
  reset(id: number): void
}

type LifecycleEvent = 'reset' | 'closed'

const NOOP_DISPOSABLE: Disposable = { dispose() {} }

function toDispose(d: Disposable | (() => void)): () => void | Promise<void> {
  return typeof d === 'function' ? d : () => d.dispose()
}

/** Internal handle so the registry can drive a connection's lifecycle. */
interface ConnectionHandle {
  connection: Connection
  /** Dispose the current segment and swap in a fresh one; fire 'reset'. */
  reset(): void
  /** Terminal close: dispose segment, fire 'closed' once, de-register. */
  close(): void
}

export function createConnectionRegistry(): ConnectionRegistry {
  const byId = new Map<number, ConnectionHandle>()

  /**
   * Dispose a resource handed to a dead connection's `own()` — immediately,
   * exactly once, never delegating to a disposed segment (that would throw).
   * Both sync throws and async rejections are caught/logged so a late teardown
   * can never escape as an unhandledRejection in the Electron main process.
   */
  function disposeLate(d: Disposable | (() => void)): void {
    try {
      const r = toDispose(d)()
      if (r && typeof (r as Promise<void>).then === 'function') {
        ;(r as Promise<void>).catch((e) => log.error('late own() async disposer rejected', e))
      }
    } catch (e) {
      log.error('late own() resource disposer threw', e)
    }
  }

  /**
   * A connection for an already-destroyed webContents. Not registered, never
   * alive, never arms a `'destroyed'` hook (it would never fire on a dead wc —
   * that path would otherwise mint a permanently-alive leaking zombie). `own()`
   * disposes immediately so callers racing teardown still don't leak.
   */
  function makeDeadConnection(wc: WebContents): Connection {
    return {
      id: wc.id,
      webContents: wc,
      get alive() {
        return false
      },
      own(d) {
        disposeLate(d)
        return NOOP_DISPOSABLE
      },
      on() {
        return NOOP_DISPOSABLE
      },
    }
  }

  function build(wc: WebContents): ConnectionHandle {
    const id = wc.id
    // Current lifetime segment. Replaced wholesale on reset (never re-used
    // after disposeAll, which permanently poisons the instance).
    let segment = new DisposableRegistry()
    let alive = true

    const resetListeners = new Set<() => void>()
    const closedListeners = new Set<() => void>()

    function emit(ev: LifecycleEvent): void {
      const set = ev === 'reset' ? resetListeners : closedListeners
      // Isolate faults so one throwing listener can't block the rest.
      for (const cb of [...set]) {
        try {
          cb()
        } catch (e) {
          log.error(`listener for "${ev}" threw`, e)
        }
      }
    }

    const connection: Connection = {
      id,
      webContents: wc,
      get alive() {
        return alive
      },
      own(d) {
        // Race safety: after close, do not delegate to the disposed
        // segment (that throws). Dispose the late resource immediately and
        // hand back a harmless no-op handle.
        if (!alive) {
          disposeLate(d)
          return NOOP_DISPOSABLE
        }
        return segment.add(d)
      },
      on(ev, cb) {
        const set = ev === 'reset' ? resetListeners : closedListeners
        set.add(cb)
        let removed = false
        return {
          dispose() {
            if (removed) return
            removed = true
            set.delete(cb)
          },
        }
      },
    }

    function reset(): void {
      if (!alive) return
      // Dispose the old segment, then swap in a fresh registry BEFORE firing
      // 'reset' so any listener (or subsequent own()) sees an open segment.
      // disposeAll is async; old `own` handles become no-ops because they
      // reference the now-replaced/released segment.
      const old = segment
      segment = new DisposableRegistry()
      void old.disposeAll().catch((e) => log.error('reset disposeAll threw', e))
      emit('reset')
    }

    function close(): void {
      if (!alive) return
      alive = false
      byId.delete(id)
      void segment.disposeAll().catch((e) => log.error('close disposeAll threw', e))
      emit('closed')
    }

    // Hard destroy — the real terminal hook. `once` auto-removes and the
    // `alive` guard inside close() makes repeated triggers idempotent.
    wc.once('destroyed', () => {
      close()
    })

    return { connection, reset, close }
  }

  function acquire(wc: WebContents): Connection {
    const existing = byId.get(wc.id)
    if (existing) return existing.connection
    // Re-acquiring an already-destroyed wc must not mint a live connection: its
    // `'destroyed'` event already fired and won't fire again, so the connection
    // would stay alive & registered forever (zombie + leak). Hand back a dead,
    // unregistered connection instead.
    if (wc.isDestroyed?.()) return makeDeadConnection(wc)
    const handle = build(wc)
    byId.set(wc.id, handle)
    return handle.connection
  }

  function reset(id: number): void {
    byId.get(id)?.reset()
  }

  return {
    acquire,
    get: (id) => byId.get(id)?.connection,
    all: () => [...byId.values()].map((h) => h.connection),
    reset,
  }
}
