/**
 * Behavior tests for the connection-layer primitive (`Connection` /
 * `ConnectionRegistry`) described in packages/electron-deck/docs/foundation.md's
 * two-teardown-paths section.
 *
 * Connection-layer contract tests (the implementation in `./connection.js` is
 * in place; these pin its behavior):
 *
 *  - A `ConnectionRegistry.acquire(wc)` mints one `Connection` per trusted
 *    webContents (keyed by `wc.id`), idempotently.
 *  - A connection owns a single "lifetime segment" of disposables; the segment
 *    tears down deterministically (LIFO) on hard-destroy (`wc.once('destroyed')`)
 *    or soft-reuse (`reset(id)`), with the right lifecycle events firing the
 *    right number of times.
 *  - Late / racing `own()` after close does not throw or leak.
 *
 * These tests deliberately model the real Electron runtime semantics noted in
 * §4.3: the terminal hook is `'destroyed'` (NOT `'render-process-gone'`), and
 * the underlying `DisposableRegistry.disposeAll` is async (LIFO) — so close is
 * async and tests await a microtask flush.
 *
 * We never import electron; a hand-rolled emitter-backed fake webContents
 * stands in (same `makeEmitter` style as projects-add-dialog.test.ts).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

import type { WebContents } from 'electron'
import {
  createConnectionRegistry,
  type Connection,
  type ConnectionRegistry,
} from './connection.js'

// ── fake webContents ───────────────────────────────────────────────────────
type AnyFn = (...args: unknown[]) => unknown
type EventBag = Record<string, Set<AnyFn>>

interface FakeWebContents {
  id: number
  isDestroyed(): boolean
  /** Force isDestroyed()===true WITHOUT emitting (models a wc destroyed before
   * we ever wired its terminal hook). */
  markDestroyed(): void
  on(event: string, fn: AnyFn): unknown
  once(event: string, fn: AnyFn): unknown
  emit(event: string, ...args: unknown[]): void
}

let nextWcId = 1

/**
 * Minimal webContents-shaped object. `emit` drives the synchronous fan-out so
 * a test can simulate `'destroyed'` / `'render-process-gone'` precisely.
 * `once` auto-removes after the first fire so a repeated `emit('destroyed')`
 * does not re-invoke the same terminal hook.
 */
function makeFakeWebContents(): FakeWebContents {
  const listeners: EventBag = {}
  let destroyed = false
  return {
    id: nextWcId++,
    isDestroyed: () => destroyed,
    markDestroyed() {
      destroyed = true
    },
    on(event, fn) {
      ;(listeners[event] ??= new Set()).add(fn)
      return this
    },
    once(event, fn) {
      const wrap: AnyFn = (...args: unknown[]) => {
        listeners[event]?.delete(wrap)
        return fn(...args)
      }
      ;(listeners[event] ??= new Set()).add(wrap)
      return this
    },
    emit(event, ...args) {
      // The terminal `'destroyed'` event flips the destroyed flag so the
      // connection's view of `wc.isDestroyed()` is consistent with reality.
      if (event === 'destroyed') destroyed = true
      for (const fn of [...(listeners[event] ?? [])]) fn(...args)
    },
  }
}

/**
 * Variant whose `once` does NOT auto-remove — the registered listener stays
 * subscribed so a second `emit('destroyed')` invokes the SAME callback again.
 * This lets a test genuinely re-enter the connection's close() path, so the
 * implementation's `if (!alive) return` idempotency guard is actually
 * exercised (instead of being masked by the fake auto-removing the listener).
 */
function makeRetriggerableFakeWebContents(): FakeWebContents {
  const listeners: EventBag = {}
  let destroyed = false
  return {
    id: nextWcId++,
    isDestroyed: () => destroyed,
    markDestroyed() {
      destroyed = true
    },
    on(event, fn) {
      ;(listeners[event] ??= new Set()).add(fn)
      return this
    },
    // Intentionally re-triggerable: `once` behaves like `on` here.
    once(event, fn) {
      ;(listeners[event] ??= new Set()).add(fn)
      return this
    },
    emit(event, ...args) {
      if (event === 'destroyed') destroyed = true
      for (const fn of [...(listeners[event] ?? [])]) fn(...args)
    },
  }
}

/** Cast helper — the fake satisfies the structural slice Connection uses. */
function asWc(fake: FakeWebContents): WebContents {
  return fake as unknown as WebContents
}

/** Let any pending microtasks (async disposeAll) settle. */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

let registry: ConnectionRegistry

beforeEach(() => {
  registry = createConnectionRegistry()
})

// ── 1. acquire identity ──────────────────────────────────────────────────────
describe('acquire — identity & registry membership', () => {
  it('returns a live Connection mirroring the webContents, discoverable via get()/all()', () => {
    const wc = makeFakeWebContents()
    const conn = registry.acquire(asWc(wc))

    expect(conn.id).toBe(wc.id)
    expect(conn.webContents).toBe(asWc(wc))
    expect(conn.alive).toBe(true)

    expect(registry.get(wc.id)).toBe(conn)
    expect(registry.all()).toContain(conn)
  })
})

// ── 2. acquire idempotency ───────────────────────────────────────────────────
describe('acquire — idempotency', () => {
  it('returns the SAME Connection object for the same webContents', () => {
    const wc = makeFakeWebContents()
    const a = registry.acquire(asWc(wc))
    const b = registry.acquire(asWc(wc))

    expect(b).toBe(a)
    // Re-acquiring must not create a duplicate registry entry.
    expect(registry.all().filter((c) => c.id === wc.id)).toHaveLength(1)
  })
})

// ── 3. own() — close-time disposal, LIFO, early release ──────────────────────
describe('own — disposal on close, LIFO order, early release', () => {
  it('runs owned disposers in LIFO order when the connection closes', async () => {
    const wc = makeFakeWebContents()
    const conn = registry.acquire(asWc(wc))

    const order: string[] = []
    conn.own(() => order.push('first'))
    conn.own(() => order.push('second'))
    conn.own(() => order.push('third'))

    wc.emit('destroyed')
    await flush()

    // LIFO: last-owned disposes first.
    expect(order).toEqual(['third', 'second', 'first'])
  })

  it('accepts a Disposable object (not just a function) and disposes it on close', async () => {
    const wc = makeFakeWebContents()
    const conn = registry.acquire(asWc(wc))

    const dispose = vi.fn()
    conn.own({ dispose })

    expect(dispose).not.toHaveBeenCalled()
    wc.emit('destroyed')
    await flush()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('early-disposing the returned handle removes it from the cleanup table AND invokes the disposer immediately', async () => {
    const wc = makeFakeWebContents()
    const conn = registry.acquire(asWc(wc))

    const fn = vi.fn()
    const handle = conn.own(fn)

    // Early release fires the disposer exactly once, right now.
    handle.dispose()
    expect(fn).toHaveBeenCalledTimes(1)

    // It must NOT fire again when the connection later closes.
    wc.emit('destroyed')
    await flush()
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

// ── 4. hard destroy ──────────────────────────────────────────────────────────
describe('hard destroy via wc.once("destroyed")', () => {
  it('flips alive→false, runs owned disposers LIFO, fires "closed" exactly once, and de-registers', async () => {
    const wc = makeFakeWebContents()
    const conn = registry.acquire(asWc(wc))

    const order: string[] = []
    conn.own(() => order.push('a'))
    conn.own(() => order.push('b'))

    const closed = vi.fn()
    conn.on('closed', closed)

    wc.emit('destroyed')
    await flush()

    expect(conn.alive).toBe(false)
    expect(order).toEqual(['b', 'a'])
    expect(closed).toHaveBeenCalledTimes(1)

    // Gone from the registry.
    expect(registry.get(wc.id)).toBeUndefined()
    expect(registry.all()).not.toContain(conn)
  })
})

// ── 5. terminal hook is "destroyed" only ─────────────────────────────────────
describe('terminal hook discrimination', () => {
  it('does NOT close on "render-process-gone" — connection stays alive', async () => {
    const wc = makeFakeWebContents()
    const conn = registry.acquire(asWc(wc))

    const closed = vi.fn()
    const disposer = vi.fn()
    conn.on('closed', closed)
    conn.own(disposer)

    wc.emit('render-process-gone')
    await flush()

    expect(conn.alive).toBe(true)
    expect(closed).not.toHaveBeenCalled()
    expect(disposer).not.toHaveBeenCalled()
    expect(registry.get(wc.id)).toBe(conn)
  })
})

// ── 6. reset — swap lifetime segment ─────────────────────────────────────────
describe('reset(id) — soft segment swap', () => {
  it('disposes the current segment LIFO, fires "reset", keeps the connection alive & registered', async () => {
    const wc = makeFakeWebContents()
    const conn = registry.acquire(asWc(wc))

    const order: string[] = []
    conn.own(() => order.push('seg1-a'))
    conn.own(() => order.push('seg1-b'))

    const onReset = vi.fn()
    conn.on('reset', onReset)

    registry.reset(wc.id)
    await flush()

    expect(order).toEqual(['seg1-b', 'seg1-a'])
    expect(onReset).toHaveBeenCalledTimes(1)
    expect(conn.alive).toBe(true)
    expect(registry.get(wc.id)).toBe(conn)
  })

  it('own() works again after reset (new segment); the new segment disposes on a later close, the old one does not re-run', async () => {
    const wc = makeFakeWebContents()
    const conn = registry.acquire(asWc(wc))

    const oldDisposer = vi.fn()
    conn.own(oldDisposer)

    registry.reset(wc.id)
    await flush()
    expect(oldDisposer).toHaveBeenCalledTimes(1) // disposed by reset

    // New segment registration must succeed (registry replaced, not poisoned).
    const newDisposer = vi.fn()
    expect(() => conn.own(newDisposer)).not.toThrow()

    wc.emit('destroyed')
    await flush()

    // New-segment disposer ran once on close; old-segment disposer did NOT
    // run a second time.
    expect(newDisposer).toHaveBeenCalledTimes(1)
    expect(oldDisposer).toHaveBeenCalledTimes(1)
  })
})

// ── 7. reset isolation — stale handle is a no-op ─────────────────────────────
describe('reset isolation', () => {
  it('a handle obtained BEFORE reset is a no-op AFTER reset — it must not dispose/remove the new segment resource', async () => {
    const wc = makeFakeWebContents()
    const conn = registry.acquire(asWc(wc))

    const oldFn = vi.fn()
    const staleHandle = conn.own(oldFn)

    registry.reset(wc.id)
    await flush()
    expect(oldFn).toHaveBeenCalledTimes(1) // reset disposed it

    // New segment resource.
    const newFn = vi.fn()
    conn.own(newFn)

    // Using the stale handle now must do nothing: not re-fire oldFn, and
    // crucially not evict or fire the new-segment resource.
    staleHandle.dispose()
    expect(oldFn).toHaveBeenCalledTimes(1)
    expect(newFn).not.toHaveBeenCalled()

    // The new resource is still owned: it disposes on close.
    wc.emit('destroyed')
    await flush()
    expect(newFn).toHaveBeenCalledTimes(1)
  })
})

// ── 8. race safety — own() after close ───────────────────────────────────────
describe('own() after close — race safety', () => {
  it('does not throw, immediately disposes the passed-in resource, and returns a no-op Disposable', async () => {
    const wc = makeFakeWebContents()
    const conn = registry.acquire(asWc(wc))

    wc.emit('destroyed')
    await flush()
    expect(conn.alive).toBe(false)

    const lateFn = vi.fn()
    let handle!: ReturnType<Connection['own']>
    expect(() => {
      handle = conn.own(lateFn)
    }).not.toThrow()

    // Leak protection: the late resource is disposed right away, exactly once.
    expect(lateFn).toHaveBeenCalledTimes(1)

    // The returned Disposable is a harmless no-op — disposing it does not
    // re-run the resource or throw.
    expect(() => handle.dispose()).not.toThrow()
    expect(lateFn).toHaveBeenCalledTimes(1)
  })
})

// ── 9. on(ev,cb) — listener registration / unsubscribe / fault isolation ─────
describe('on(ev,cb) — listeners', () => {
  it('returns a Disposable; after dispose the callback is no longer invoked', async () => {
    const wc = makeFakeWebContents()
    const conn = registry.acquire(asWc(wc))

    const cb = vi.fn()
    const sub = conn.on('closed', cb)
    sub.dispose()

    wc.emit('destroyed')
    await flush()
    expect(cb).not.toHaveBeenCalled()
  })

  it('supports multiple listeners for the same event; all fire', async () => {
    const wc = makeFakeWebContents()
    const conn = registry.acquire(asWc(wc))

    const a = vi.fn()
    const b = vi.fn()
    conn.on('closed', a)
    conn.on('closed', b)

    wc.emit('destroyed')
    await flush()
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('a throwing listener does not prevent the other listeners from running', async () => {
    const wc = makeFakeWebContents()
    const conn = registry.acquire(asWc(wc))

    const before = vi.fn()
    const after = vi.fn()
    conn.on('reset', before)
    conn.on('reset', () => {
      throw new Error('boom')
    })
    conn.on('reset', after)

    expect(() => {
      registry.reset(wc.id)
    }).not.toThrow()
    await flush()

    expect(before).toHaveBeenCalledTimes(1)
    expect(after).toHaveBeenCalledTimes(1)
  })
})

// ── 10. reset on unknown id ──────────────────────────────────────────────────
describe('reset(unknown id)', () => {
  it('is a no-op and does not throw', () => {
    expect(() => registry.reset(999_999)).not.toThrow()
  })
})

// ── 11. idempotent close (REWRITTEN) ─────────────────────────────────────────
//
// The original #11 emitted 'destroyed' twice on the auto-removing `once` fake,
// so the connection's terminal hook only ran ONCE — the implementation's
// `if (!alive) return` guard inside close() was never actually exercised (the
// fake, not the guard, suppressed the second close). To truly drive close()
// twice we use a fake whose `once` is re-triggerable (does NOT auto-remove), so
// a second `emit('destroyed')` genuinely re-enters close(). With the alive
// guard removed from the implementation, the second entry would re-emit
// 'closed' (and re-walk the disposed segment) and this test would fail.
describe('idempotent close — guard is genuinely exercised', () => {
  it('re-entering close() (second "destroyed") does not re-fire "closed" nor re-run disposers', async () => {
    const wc = makeRetriggerableFakeWebContents()
    const conn = registry.acquire(asWc(wc))

    const disposer = vi.fn()
    const closed = vi.fn()
    conn.own(disposer)
    conn.on('closed', closed)

    // Both emits invoke the SAME still-registered terminal callback, so the
    // implementation's close() is entered twice for real.
    wc.emit('destroyed')
    wc.emit('destroyed')
    await flush()

    expect(disposer).toHaveBeenCalledTimes(1)
    expect(closed).toHaveBeenCalledTimes(1)
    expect(conn.alive).toBe(false)
  })

  it('a third destroyed after the registry already de-registered is still a no-op', async () => {
    const wc = makeRetriggerableFakeWebContents()
    const conn = registry.acquire(asWc(wc))
    const closed = vi.fn()
    conn.on('closed', closed)

    wc.emit('destroyed')
    await flush()
    expect(registry.get(wc.id)).toBeUndefined()

    wc.emit('destroyed')
    wc.emit('destroyed')
    await flush()
    expect(closed).toHaveBeenCalledTimes(1)
  })
})

// ── B1. acquire on a destroyed webContents must not mint a zombie ────────────
//
// REAL BUG: acquire() builds & registers unconditionally and wires
// `wc.once('destroyed')`. If the wc is already destroyed, that hook will never
// fire again, leaving a connection stuck `alive===true` forever — a zombie that
// also leaks any resource handed to own(). The contract: a destroyed wc yields
// a dead, unregistered connection whose own() disposes immediately.
describe('B1 — acquire() on a destroyed webContents', () => {
  it('(a) re-acquiring the SAME wc object after it emitted "destroyed" yields a dead, unregistered connection', async () => {
    const wc = makeFakeWebContents()
    const first = registry.acquire(asWc(wc))

    wc.emit('destroyed') // flips isDestroyed()===true and closes `first`
    await flush()
    expect(first.alive).toBe(false)
    expect(registry.get(wc.id)).toBeUndefined()

    // Re-acquiring the now-destroyed wc must NOT mint a live zombie.
    const zombie = registry.acquire(asWc(wc))
    expect(zombie.alive).toBe(false)

    // Not registered: get()/all() must not surface it.
    expect(registry.get(wc.id)).toBeUndefined()
    expect(registry.all()).not.toContain(zombie)

    // own() on the dead connection disposes immediately and returns a no-op.
    const lateFn = vi.fn()
    let handle!: ReturnType<Connection['own']>
    expect(() => {
      handle = zombie.own(lateFn)
    }).not.toThrow()
    expect(lateFn).toHaveBeenCalledTimes(1)
    expect(() => handle.dispose()).not.toThrow()
    expect(lateFn).toHaveBeenCalledTimes(1)
  })

  it('(b) acquiring a wc that is already isDestroyed()===true from the start yields a dead, unregistered connection', async () => {
    const wc = makeFakeWebContents()
    wc.markDestroyed() // born destroyed — its "destroyed" hook will never fire

    const conn = registry.acquire(asWc(wc))

    // Must be dead on arrival — not a zombie waiting on an event that can't come.
    expect(conn.alive).toBe(false)
    expect(registry.get(wc.id)).toBeUndefined()
    expect(registry.all()).not.toContain(conn)

    // own() disposes immediately (no leak), returns a harmless no-op.
    const fn = vi.fn()
    const handle = conn.own(fn)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(() => handle.dispose()).not.toThrow()
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

// ── M1. late own() with an ASYNC rejecting disposer must not escape ──────────
//
// REAL BUG: own()-after-close does `try { void toDispose(d)() } catch`. The
// try/catch only traps a SYNCHRONOUS throw; if the disposer returns a rejected
// promise, the rejection escapes as an unhandledRejection (the sync #8 test
// passes but this async sibling fails). Contract: the implementation must
// catch+log the async rejection too.
describe('M1 — late own() with an async-rejecting disposer', () => {
  it('does not surface an unhandledRejection', async () => {
    const wc = makeFakeWebContents()
    const conn = registry.acquire(asWc(wc))

    wc.emit('destroyed')
    await flush()
    expect(conn.alive).toBe(false)

    const sentinel = new Error('late-async-disposer-boom')
    const seen: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      seen.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const asyncRejecting = () => Promise.reject(sentinel)
      // After close this takes the late-own() path; its rejected promise must
      // be caught internally, not left dangling.
      expect(() => conn.own(asyncRejecting)).not.toThrow()

      // Give the microtask queue and the unhandledRejection detection a few
      // turns to surface anything that leaked.
      await flush()
      await flush()
      await new Promise((r) => setTimeout(r, 0))
    } finally {
      process.removeListener('unhandledRejection', onUnhandled)
    }

    expect(seen).not.toContain(sentinel)
  })
})

// ── Blind-spot 1. reset() on a closed / de-registered connection ─────────────
describe('reset() on a closed connection — no-op', () => {
  it('reset(id) after the connection has closed does not throw and does not fire "reset"', async () => {
    const wc = makeFakeWebContents()
    const conn = registry.acquire(asWc(wc))
    const onReset = vi.fn()
    conn.on('reset', onReset)

    wc.emit('destroyed')
    await flush()
    expect(conn.alive).toBe(false)

    expect(() => registry.reset(wc.id)).not.toThrow()
    await flush()
    expect(onReset).not.toHaveBeenCalled()
  })
})

// ── Blind-spot 2. reset→destroyed and destroyed-after-reset sequencing ───────
describe('reset then destroy — segment boundaries each fire once', () => {
  it('reset disposes seg1 once and fires "reset" once; a later destroy disposes seg2 once and fires "closed" once — no cross-contamination', async () => {
    const wc = makeFakeWebContents()
    const conn = registry.acquire(asWc(wc))

    const seg1 = vi.fn()
    conn.own(seg1)

    const onReset = vi.fn()
    const onClosed = vi.fn()
    conn.on('reset', onReset)
    conn.on('closed', onClosed)

    registry.reset(wc.id)
    await flush()
    expect(seg1).toHaveBeenCalledTimes(1)
    expect(onReset).toHaveBeenCalledTimes(1)
    expect(onClosed).not.toHaveBeenCalled()
    expect(conn.alive).toBe(true)

    const seg2 = vi.fn()
    conn.own(seg2)

    wc.emit('destroyed')
    await flush()

    // seg2 disposed exactly once; seg1 NOT disposed a second time.
    expect(seg2).toHaveBeenCalledTimes(1)
    expect(seg1).toHaveBeenCalledTimes(1)
    // Each lifecycle event fired exactly once for its segment boundary.
    expect(onReset).toHaveBeenCalledTimes(1)
    expect(onClosed).toHaveBeenCalledTimes(1)
    expect(conn.alive).toBe(false)
  })
})

// ── Blind-spot 3. a throwing owned disposer must not abort close / reset ─────
describe('throwing owned disposer — close/reset still complete', () => {
  it('close completes (alive→false, de-registered, "closed" fires once) even when an owned disposer throws', async () => {
    const wc = makeFakeWebContents()
    const conn = registry.acquire(asWc(wc))

    const after = vi.fn() // owned BEFORE the thrower → disposes AFTER it (LIFO)
    conn.own(after)
    conn.own(() => {
      throw new Error('disposer boom')
    })

    const closed = vi.fn()
    conn.on('closed', closed)

    wc.emit('destroyed')
    await flush()

    expect(conn.alive).toBe(false)
    expect(registry.get(wc.id)).toBeUndefined()
    expect(closed).toHaveBeenCalledTimes(1)
    // The non-throwing sibling still ran despite the earlier throw.
    expect(after).toHaveBeenCalledTimes(1)
  })

  it('reset completes ("reset" fires once, connection stays alive & registered) even when an owned disposer throws', async () => {
    const wc = makeFakeWebContents()
    const conn = registry.acquire(asWc(wc))

    const after = vi.fn()
    conn.own(after)
    conn.own(() => {
      throw new Error('disposer boom')
    })

    const onReset = vi.fn()
    conn.on('reset', onReset)

    expect(() => registry.reset(wc.id)).not.toThrow()
    await flush()

    expect(onReset).toHaveBeenCalledTimes(1)
    expect(after).toHaveBeenCalledTimes(1)
    expect(conn.alive).toBe(true)
    expect(registry.get(wc.id)).toBe(conn)

    // The connection is healthy after the throwing reset: a fresh segment works.
    const seg2 = vi.fn()
    expect(() => conn.own(seg2)).not.toThrow()
    wc.emit('destroyed')
    await flush()
    expect(seg2).toHaveBeenCalledTimes(1)
  })
})

// ── Blind-spot 4. genuinely async owned disposers still run LIFO ─────────────
describe('async owned disposers — awaited, LIFO', () => {
  it('disposeAll awaits each async disposer, preserving LIFO order across awaits', async () => {
    const wc = makeFakeWebContents()
    const conn = registry.acquire(asWc(wc))

    const order: string[] = []
    // Each disposer awaits a real microtask hop before recording, so a
    // non-awaiting (fire-and-forget) implementation would scramble the order.
    conn.own(async () => {
      await Promise.resolve()
      order.push('first')
    })
    conn.own(async () => {
      await Promise.resolve()
      order.push('second')
    })
    conn.own(async () => {
      await Promise.resolve()
      order.push('third')
    })

    wc.emit('destroyed')
    // disposeAll awaits each disposer in turn; give it enough hops.
    for (let i = 0; i < 8; i++) await Promise.resolve()

    expect(order).toEqual(['third', 'second', 'first'])
  })
})

// literal "registry.size === 0" probe: the registry
// is the live ledger of trusted webContents; closing all of them must leave it
// empty, while reset (soft pool reuse) must NOT remove the connection.
describe('registry size — empties on close, persists across reset', () => {
  it('registry.all() returns to length 0 after every connection closes', () => {
    const a = makeFakeWebContents()
    const b = makeFakeWebContents()
    registry.acquire(a as unknown as WebContents)
    registry.acquire(b as unknown as WebContents)
    expect(registry.all()).toHaveLength(2)

    a.emit('destroyed')
    expect(registry.all()).toHaveLength(1)
    expect(registry.get(a.id)).toBeUndefined()

    b.emit('destroyed')
    // The ledger is fully drained — the literal DoD#4 registry.size === 0.
    expect(registry.all()).toHaveLength(0)
    expect(registry.get(b.id)).toBeUndefined()
  })

  it('reset(id) keeps the connection registered (soft reuse ≠ removal)', () => {
    const wc = makeFakeWebContents()
    const conn = registry.acquire(wc as unknown as WebContents)
    expect(registry.all()).toHaveLength(1)

    registry.reset(wc.id)
    // Reset swaps the lifetime segment but the connection stays alive + in the
    // ledger so the next session reusing this wc.id resolves the SAME object.
    expect(registry.all()).toHaveLength(1)
    expect(registry.get(wc.id)).toBe(conn)
    expect(conn.alive).toBe(true)

    // A subsequent destroy still drains it to 0.
    wc.emit('destroyed')
    expect(registry.all()).toHaveLength(0)
  })
})
