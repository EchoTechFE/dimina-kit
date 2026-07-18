export interface Disposable {
  dispose(): void | Promise<void>
}

export type DisposeFn = () => void | Promise<void>

export function toDisposable(fn: DisposeFn): Disposable {
  let done = false
  return {
    dispose() {
      if (done) return
      done = true
      return fn()
    },
  }
}

interface Entry {
  fn: DisposeFn
  released: boolean
}

/**
 * Shared LIFO entry bookkeeping for {@link DisposableRegistry} and
 * {@link SyncDisposableRegistry} — registering/releasing entries is IDENTICAL
 * between the two; only `disposeAll()`'s iteration (awaited vs fully
 * synchronous) differs, so each subclass implements just that.
 */
abstract class EntryList {
  protected entries: Entry[] = []
  protected _disposed = false

  /**
   * Number of live entries. A wrapper's `dispose` splices its entry out and
   * `disposeAll` clears the array, so `entries.length` is the live count.
   */
  get size(): number {
    return this.entries.length
  }

  add(d: Disposable | DisposeFn): Disposable {
    if (this._disposed) {
      throw new Error('cannot add to disposed registry')
    }

    const fn: DisposeFn = typeof d === 'function' ? d : () => d.dispose()
    const entry: Entry = { fn, released: false }
    this.entries.push(entry)
    return {
      dispose: () => {
        if (entry.released) return
        entry.released = true
        const i = this.entries.indexOf(entry)
        if (i >= 0) this.entries.splice(i, 1)
        return fn()
      },
    }
  }

  /**
   * Marks the list disposed and returns its still-live entries in LIFO
   * (registration-reverse) order, clearing the live list. Returns `null` on a
   * repeat call (idempotent no-op) — callers use that to short-circuit.
   */
  protected beginDisposeAll(): Entry[] | null {
    if (this._disposed) return null
    this._disposed = true
    const items = this.entries.slice().reverse()
    this.entries = []
    return items
  }
}

export class DisposableRegistry extends EntryList implements Disposable {
  /**
   * Disposes every live entry in LIFO order. Only the FIRST entry run (the
   * last one registered) is guaranteed to complete before this call's first
   * suspension point — `await entry.fn()` yields to the microtask queue on
   * every iteration regardless of whether `fn()` returned a promise, so a
   * caller that does not `await disposeAll()` (the common fire-and-forget
   * pattern in this codebase) only sees that one entry's side effects
   * settled by the time control returns; every subsequent entry runs a
   * microtask tick later. Teardown that must be fully visible in the same
   * tick — e.g. removing an event listener before a dispose-then-recreate
   * sequence — needs {@link SyncDisposableRegistry} instead.
   */
  async disposeAll(): Promise<void> {
    const items = this.beginDisposeAll()
    if (!items) return

    const errors: unknown[] = []
    for (const entry of items) {
      if (entry.released) continue
      entry.released = true
      try {
        await entry.fn()
      } catch (e) {
        errors.push(e)
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, 'DisposableRegistry encountered errors during disposeAll')
    }
  }

  dispose(): Promise<void> {
    return this.disposeAll()
  }
}

/**
 * A synchronous LIFO cleanup collection: `disposeAll()` runs every live entry
 * to completion, in registration-reverse order, before returning control to
 * its caller — no `await`, no microtask gap between entries. Use this instead
 * of {@link DisposableRegistry} wherever a caller depends on every entry's
 * side effect already being visible on the very next line (e.g. a debugger
 * `message` listener that must be gone before a destroy-then-immediately-
 * recreate sequence in the same tick).
 *
 * A registered function's return value is never awaited: if it returns a
 * thenable, that is treated as a contract violation on the caller's part (not
 * something this registry accommodates), and the entry is still considered
 * fully run.
 */
export class SyncDisposableRegistry extends EntryList {
  /** Idempotent: a second call is a no-op. */
  disposeAll(): void {
    const items = this.beginDisposeAll()
    if (!items) return

    const errors: unknown[] = []
    for (const entry of items) {
      if (entry.released) continue
      entry.released = true
      try {
        entry.fn()
      } catch (e) {
        errors.push(e)
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, 'SyncDisposableRegistry encountered errors during disposeAll')
    }
  }
}
