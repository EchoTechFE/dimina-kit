/**
 * Behavior tests for the `Scope` primitive (nested lifetime) — the
 * implementation in `./scope.js` does NOT exist yet (TDD: these tests are
 * written first and are expected to be RED until `createScope()` ships).
 *
 * `Scope` generalizes the Connection/Disposable semantics already in this
 * package:
 *
 *  - `own(d)` binds a disposable to the CURRENT lifetime segment; both `reset()`
 *    and `close()` release it, in LIFO order (same as `DisposableRegistry`).
 *  - `child()` nests a sub-scope whose lifetime is bounded by the parent's
 *    current segment — a parent `reset()` or `close()` cascades into it.
 *  - `reset()` / `close()` return a Promise that is a COMPLETION FENCE: it
 *    resolves only AFTER the underlying async LIFO disposeAll has fully
 *    completed (not when teardown is merely *initiated*). The `'reset'` /
 *    `'closed'` listeners fire only after that same completion.
 *  - After `close()` the scope is dead: `alive===false`, idempotent, and a late
 *    `own()` disposes immediately (leak protection) rather than entering the
 *    dead scope.
 *
 * The contract being pinned (target file `./scope.ts`):
 *
 *   interface Scope {
 *     readonly alive: boolean
 *     own(d: Disposable | (() => void)): Disposable
 *     child(): Scope
 *     reset(): Promise<void>
 *     close(): Promise<void>
 *     on(event: 'reset' | 'closed', cb: () => void): Disposable
 *   }
 *   export function createScope(): Scope
 *
 * No electron import; `Scope` is engine-agnostic.
 */
import { describe, it, expect, beforeAll } from 'vitest'

import type { Disposable } from './disposable.js'

// ── TDD red: the implementation (`./scope.js`) does NOT exist yet ────────────
//
// We load it dynamically so the FAILURE is a runtime/assertion failure (the
// module fails to resolve at test time, turning every spec red) rather than a
// hard compile error that would prevent the suite from running at all. Once
// `createScope` / `Scope` ship, `beforeAll` resolves the real exports and the
// already-written specs exercise the contract.
//
// `Scope` is the structural contract these tests pin (the import target's
// public type). We keep a local mirror so the specs read against a real type;
// the implementation's exported `Scope` must be assignable to it.
interface Scope {
  readonly alive: boolean
  own(d: Disposable | (() => void)): Disposable
  child(): Scope
  reset(): Promise<void>
  close(): Promise<void>
  on(event: 'reset' | 'closed', cb: () => void): Disposable
  // ── pinned contract for the not-yet-implemented re-parenting op ────────────
  // `adopt(child, newParent)` detaches `child` from THIS scope's current segment
  // and re-attaches it to `newParent`'s current segment WITHOUT resetting or
  // closing the child (its own()ed resources stay live). It only changes "who
  // cascades reset()/close() into it from now on". Returns a completion fence.
  adopt(child: Scope, newParent: Scope): Promise<void>
}

let createScope: () => Scope

beforeAll(async () => {
  // `./scope.js` now exists; the dynamic import resolves the real `createScope`.
  const mod = (await import('./scope.js')) as { createScope: () => Scope }
  createScope = mod.createScope
})

/** Let pending microtasks settle (defensive — the contract is that reset/close
 * already fence on completion, so awaiting them should suffice). */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

/** A disposer whose dispose() returns a promise that resolves only when the
 * test manually releases it — lets us prove the completion fence: the scope's
 * reset()/close() promise must NOT resolve until this one has. */
function deferredDisposer(): {
  disposable: Disposable
  started: () => boolean
  finished: () => boolean
  release: () => void
} {
  let begun = false
  let done = false
  let releaseInner!: () => void
  const gate = new Promise<void>((r) => {
    releaseInner = r
  })
  return {
    disposable: {
      async dispose() {
        begun = true
        await gate
        done = true
      },
    },
    started: () => begun,
    finished: () => done,
    release: () => releaseInner(),
  }
}

// ── 1. own(): reset & close both dispose, LIFO ───────────────────────────────
describe('own — released by both reset() and close(), LIFO order', () => {
  it('close() disposes owned resources in LIFO (reverse-of-own) order', async () => {
    const scope = createScope()
    const order: string[] = []
    scope.own(() => order.push('first'))
    scope.own(() => order.push('second'))
    scope.own(() => order.push('third'))

    await scope.close()
    expect(order).toEqual(['third', 'second', 'first'])
  })

  it('reset() disposes owned resources in LIFO order (and returns a Disposable from own)', async () => {
    const scope = createScope()
    const order: string[] = []
    const handle = scope.own(() => order.push('a'))
    scope.own(() => order.push('b'))

    // own() returns a Disposable handle (early release).
    expect(typeof handle.dispose).toBe('function')

    await scope.reset()
    expect(order).toEqual(['b', 'a'])
  })

  it('accepts a Disposable object (not just a function)', async () => {
    const scope = createScope()
    let disposed = 0
    scope.own({ dispose: () => void disposed++ })

    await scope.close()
    expect(disposed).toBe(1)
  })

  it('early-disposing the own() handle removes it from the segment and runs it once', async () => {
    const scope = createScope()
    let count = 0
    const handle = scope.own(() => void count++)

    handle.dispose()
    expect(count).toBe(1)

    // Must not run again when the scope later closes.
    await scope.close()
    expect(count).toBe(1)
  })
})

// ── 2. completion fence — reset()/close() resolve only AFTER disposeAll ───────
describe('completion fence — reset()/close() await disposeAll fully', () => {
  it('await scope.close() only resolves after an async owned disposer has FINISHED', async () => {
    const scope = createScope()
    const d = deferredDisposer()
    scope.own(d.disposable)

    const closing = scope.close()

    // disposeAll has been initiated (disposer started) but not finished, because
    // we have not released the gate. The close() promise must still be pending.
    await flush()
    expect(d.started()).toBe(true)
    expect(d.finished()).toBe(false)

    let resolvedEarly = false
    void closing.then(() => {
      resolvedEarly = true
    })
    await flush()
    // Fence: close() must NOT have resolved while the disposer is mid-flight.
    expect(resolvedEarly).toBe(false)

    // Release the gate → disposer finishes → THEN close() resolves.
    d.release()
    await closing
    expect(d.finished()).toBe(true)
  })

  it('await scope.reset() only resolves after an async owned disposer has FINISHED', async () => {
    const scope = createScope()
    const d = deferredDisposer()
    scope.own(d.disposable)

    const resetting = scope.reset()
    await flush()
    expect(d.started()).toBe(true)
    expect(d.finished()).toBe(false)

    let resolvedEarly = false
    void resetting.then(() => {
      resolvedEarly = true
    })
    await flush()
    expect(resolvedEarly).toBe(false)

    d.release()
    await resetting
    expect(d.finished()).toBe(true)
  })

  it("'closed' listener fires only AFTER disposeAll completes (ordering pinned)", async () => {
    const scope = createScope()
    const events: string[] = []
    const d = deferredDisposer()

    // Wrap the deferred disposer so we can record exactly when it finishes,
    // relative to when the 'closed' listener fires.
    scope.own(async () => {
      await d.disposable.dispose()
      events.push('disposer-finished')
    })
    scope.on('closed', () => events.push('closed-fired'))

    const closing = scope.close()
    await flush()
    expect(events).toEqual([]) // nothing fired while gate is shut

    d.release()
    await closing

    // The disposer MUST have finished before the 'closed' event fired.
    expect(events).toEqual(['disposer-finished', 'closed-fired'])
  })

  it("'reset' listener fires only AFTER disposeAll completes (ordering pinned)", async () => {
    const scope = createScope()
    const events: string[] = []
    const d = deferredDisposer()

    scope.own(async () => {
      await d.disposable.dispose()
      events.push('disposer-finished')
    })
    scope.on('reset', () => events.push('reset-fired'))

    const resetting = scope.reset()
    await flush()
    expect(events).toEqual([])

    d.release()
    await resetting

    expect(events).toEqual(['disposer-finished', 'reset-fired'])
  })
})

// ── 3. reset keeps alive; close kills ────────────────────────────────────────
describe('alive lifecycle — reset stays alive, close dies', () => {
  it('scope is alive on creation', () => {
    const scope = createScope()
    expect(scope.alive).toBe(true)
  })

  it('after reset() the scope is still alive and a new segment accepts own()', async () => {
    const scope = createScope()
    const first = vi_count()
    scope.own(first.fn)

    await scope.reset()
    expect(first.calls()).toBe(1)
    expect(scope.alive).toBe(true)

    // New segment: own() works and the new resource disposes on a later close.
    const second = vi_count()
    expect(() => scope.own(second.fn)).not.toThrow()
    expect(second.calls()).toBe(0)

    await scope.close()
    expect(second.calls()).toBe(1)
    // First-segment resource must NOT re-run.
    expect(first.calls()).toBe(1)
  })

  it('after close() the scope is no longer alive', async () => {
    const scope = createScope()
    await scope.close()
    expect(scope.alive).toBe(false)
  })
})

// ── 4. close() idempotency ───────────────────────────────────────────────────
describe('close() idempotency', () => {
  it('disposes owned resources exactly once across repeated close() calls', async () => {
    const scope = createScope()
    const c = vi_count()
    scope.own(c.fn)

    await scope.close()
    await scope.close()
    await scope.close()

    expect(c.calls()).toBe(1)
    expect(scope.alive).toBe(false)
  })

  it("'closed' listener fires exactly once across repeated close() calls", async () => {
    const scope = createScope()
    const closed = vi_count()
    scope.on('closed', closed.fn)

    await scope.close()
    await scope.close()

    expect(closed.calls()).toBe(1)
  })

  it('repeated close() never throws', async () => {
    const scope = createScope()
    await expect(scope.close()).resolves.toBeUndefined()
    await expect(scope.close()).resolves.toBeUndefined()
  })
})

// ── 5. child() — cascade on parent reset / close ─────────────────────────────
describe('child() — cascade close/reset from parent', () => {
  it('parent.reset() disposes resources owned by a child created in that segment', async () => {
    const parent = createScope()
    const child = parent.child()

    const childRes = vi_count()
    child.own(childRes.fn)

    await parent.reset()
    // The child built in the now-reset segment is torn down; its resource ran.
    expect(childRes.calls()).toBe(1)
    expect(child.alive).toBe(false)

    // Parent itself stays alive (reset, not close).
    expect(parent.alive).toBe(true)
  })

  it('parent.close() disposes resources owned by a child', async () => {
    const parent = createScope()
    const child = parent.child()

    const childRes = vi_count()
    child.own(childRes.fn)

    await parent.close()
    expect(childRes.calls()).toBe(1)
    expect(child.alive).toBe(false)
    expect(parent.alive).toBe(false)
  })

  it('child.close() does NOT affect the parent', async () => {
    const parent = createScope()
    const child = parent.child()

    const parentRes = vi_count()
    parent.own(parentRes.fn)
    const childRes = vi_count()
    child.own(childRes.fn)

    await child.close()
    expect(child.alive).toBe(false)
    expect(childRes.calls()).toBe(1)

    // Parent untouched: still alive, its resource not yet disposed.
    expect(parent.alive).toBe(true)
    expect(parentRes.calls()).toBe(0)

    await parent.close()
    expect(parentRes.calls()).toBe(1)
    // Child resource must not double-dispose.
    expect(childRes.calls()).toBe(1)
  })

  it('a child created AFTER parent.reset() (new segment) is cascaded by the NEXT parent teardown, not the previous one', async () => {
    const parent = createScope()

    const childA = parent.child()
    const aRes = vi_count()
    childA.own(aRes.fn)

    await parent.reset()
    expect(aRes.calls()).toBe(1)
    expect(childA.alive).toBe(false)

    // New segment → new child.
    const childB = parent.child()
    const bRes = vi_count()
    childB.own(bRes.fn)
    expect(bRes.calls()).toBe(0)
    expect(childB.alive).toBe(true)

    await parent.close()
    expect(bRes.calls()).toBe(1)
    expect(childB.alive).toBe(false)
    // childA's resource must not re-run on the parent close.
    expect(aRes.calls()).toBe(1)
  })
})

// ── 6. own() after close — leak protection ───────────────────────────────────
describe('own() after close — immediate dispose, no entry into dead scope', () => {
  it('disposes the late resource immediately and returns a no-op Disposable', async () => {
    const scope = createScope()
    await scope.close()
    expect(scope.alive).toBe(false)

    const late = vi_count()
    let handle!: Disposable
    expect(() => {
      handle = scope.own(late.fn)
    }).not.toThrow()

    // Leak protection: disposed right away, exactly once.
    expect(late.calls()).toBe(1)

    // Returned handle is a harmless no-op.
    expect(() => handle.dispose()).not.toThrow()
    expect(late.calls()).toBe(1)
  })

  it('a Disposable object handed to own() after close is disposed immediately too', async () => {
    const scope = createScope()
    await scope.close()

    let disposed = 0
    scope.own({ dispose: () => void disposed++ })
    expect(disposed).toBe(1)
  })
})

// ── 7. deep nesting — root → child → grandchild, cross-layer LIFO ─────────────
describe('deep nesting — cascade & cross-layer LIFO', () => {
  it('root.close() cascades through child and grandchild; each owned resource disposes once', async () => {
    const root = createScope()
    const child = root.child()
    const grand = child.child()

    const rootRes = vi_count()
    const childRes = vi_count()
    const grandRes = vi_count()
    root.own(rootRes.fn)
    child.own(childRes.fn)
    grand.own(grandRes.fn)

    await root.close()

    expect(rootRes.calls()).toBe(1)
    expect(childRes.calls()).toBe(1)
    expect(grandRes.calls()).toBe(1)

    expect(root.alive).toBe(false)
    expect(child.alive).toBe(false)
    expect(grand.alive).toBe(false)
  })

  it('on root.close(), a descendant scope is torn down BEFORE its ancestor (child before parent)', async () => {
    const root = createScope()
    const child = root.child()
    const grand = child.child()

    const order: string[] = []
    root.own(() => order.push('root-res'))
    child.own(() => order.push('child-res'))
    grand.own(() => order.push('grand-res'))

    await root.close()

    // LIFO across layers: the deepest scope (owned last, as a nested segment of
    // its parent) tears down before its ancestor. The grandchild must precede
    // the child, which must precede the root.
    expect(order.indexOf('grand-res')).toBeLessThan(order.indexOf('child-res'))
    expect(order.indexOf('child-res')).toBeLessThan(order.indexOf('root-res'))
  })

  it('intermediate child.reset() tears down the grandchild but leaves root intact', async () => {
    const root = createScope()
    const child = root.child()
    const grand = child.child()

    const rootRes = vi_count()
    const grandRes = vi_count()
    root.own(rootRes.fn)
    grand.own(grandRes.fn)

    await child.reset()
    // The grandchild (built in child's segment) is gone; root untouched.
    expect(grandRes.calls()).toBe(1)
    expect(grand.alive).toBe(false)
    expect(child.alive).toBe(true)
    expect(root.alive).toBe(true)
    expect(rootRes.calls()).toBe(0)
  })
})

// ── on() — listener subscription returns an unsubscribe Disposable ───────────
describe('on() — unsubscribe', () => {
  it("returns a Disposable; after dispose the 'closed' callback is not invoked", async () => {
    const scope = createScope()
    const cb = vi_count()
    const sub = scope.on('closed', cb.fn)
    sub.dispose()

    await scope.close()
    expect(cb.calls()).toBe(0)
  })

  it("an unsubscribed 'reset' callback is not invoked on reset()", async () => {
    const scope = createScope()
    const cb = vi_count()
    const sub = scope.on('reset', cb.fn)
    sub.dispose()

    await scope.reset()
    expect(cb.calls()).toBe(0)
  })
})

// ── 8. concurrent close/reset single-flight (codex-found fence bug) ───────────
//
// REGRESSION for the codex-found bug: reset()/close() had no serialization and
// close() early-returned on `alive===false`. So if a child was MID-ASYNC-CLOSE,
// the parent's disposeSegment did `await child.close()` and got an immediate
// resolve (child already !alive), letting the parent's completion fence pass
// BEFORE the child's disposer actually finished. The fix is single-flight:
// concurrent close()/reset() join the in-flight Promise (true-wait) instead of
// launching a second teardown or early-returning.
describe('concurrent close/reset single-flight — codex-found fence bug', () => {
  it('two concurrent close() calls both resolve only after disposeAll truly finishes; disposer runs once', async () => {
    const scope = createScope()
    const d = deferredDisposer()
    const owned = vi_count()
    scope.own(d.disposable)
    scope.own(owned.fn)

    // Fire two close() calls WITHOUT awaiting the first (true concurrency).
    const first = scope.close()
    const second = scope.close()

    let firstResolved = false
    let secondResolved = false
    void first.then(() => {
      firstResolved = true
    })
    void second.then(() => {
      secondResolved = true
    })

    await flush()
    // Disposer started but gated → NEITHER promise may have resolved yet.
    expect(d.started()).toBe(true)
    expect(d.finished()).toBe(false)
    expect(firstResolved).toBe(false)
    expect(secondResolved).toBe(false)

    d.release()
    await Promise.all([first, second])

    expect(d.finished()).toBe(true)
    expect(firstResolved).toBe(true)
    expect(secondResolved).toBe(true)
    // Single-flight: the segment teardown (and each owned disposer) ran exactly
    // once despite two close() calls.
    expect(owned.calls()).toBe(1)
  })

  it("parent.close() does not resolve until a child that is MID-ASYNC-CLOSE finishes its disposer (parent fence not punched through by child early-return)", async () => {
    const parent = createScope()
    const child = parent.child()

    // Child owns a deferred (slow) disposer.
    const slow = deferredDisposer()
    child.own(slow.disposable)

    const order: string[] = []
    // Record when the child's disposer actually finishes vs. when the parent's
    // close promise resolves — the parent MUST come strictly after.
    child.own(async () => {
      await slow.disposable.dispose()
      order.push('child-disposer-finished')
    })

    // Begin closing the child first (mid-async-close), then close the parent
    // WITHOUT awaiting the child — this is the exact race that punched the fence.
    const childClosing = child.close()
    const parentClosing = parent.close()

    let parentResolved = false
    void parentClosing.then(() => {
      parentResolved = true
      order.push('parent-close-resolved')
    })

    await flush()
    // Child disposer is in-flight (gate shut) → parent fence must still be open.
    expect(slow.started()).toBe(true)
    expect(slow.finished()).toBe(false)
    expect(parentResolved).toBe(false)

    // Release the child's slow disposer → it finishes → THEN the parent's fence
    // may pass.
    slow.release()
    await Promise.all([childClosing, parentClosing])

    expect(slow.finished()).toBe(true)
    expect(parentResolved).toBe(true)
    // Hard ordering: child disposer truly finished BEFORE the parent close
    // resolved — proves the parent awaited the child's in-flight close.
    expect(order).toEqual(['child-disposer-finished', 'parent-close-resolved'])
    expect(child.alive).toBe(false)
    expect(parent.alive).toBe(false)
  })

  it('close() during an in-flight reset() upgrades to a terminal close: scope dies, both segments tear down, no double-dispose', async () => {
    const scope = createScope()

    // Segment-1 resource with a deferred disposer so the reset stays in-flight.
    const segOne = deferredDisposer()
    const segOneCount = vi_count()
    scope.own(async () => {
      await segOne.disposable.dispose()
      segOneCount.fn()
    })

    const resetting = scope.reset()
    await flush()
    expect(segOne.started()).toBe(true)
    expect(segOne.finished()).toBe(false)
    // reset() swapped in a fresh segment synchronously; own() lands there.
    const segTwo = vi_count()
    scope.own(segTwo.fn)

    // Upgrade to close while reset is still mid-flight.
    const closed = vi_count()
    scope.on('closed', closed.fn)
    const closing = scope.close()

    // Terminal semantics take effect synchronously: scope is already dead.
    expect(scope.alive).toBe(false)
    // A second close() while closing joins the same in-flight promise.
    expect(scope.close()).toBe(closing)

    let closeResolved = false
    void closing.then(() => {
      closeResolved = true
    })
    await flush()
    // Still gated on segment-1's disposer → close must not have resolved.
    expect(closeResolved).toBe(false)

    segOne.release()
    await Promise.all([resetting, closing])

    // Both segments torn down exactly once; scope dead; 'closed' fired once.
    expect(segOneCount.calls()).toBe(1)
    expect(segTwo.calls()).toBe(1)
    expect(closed.calls()).toBe(1)
    expect(closeResolved).toBe(true)
    expect(scope.alive).toBe(false)
  })

  it('reset() during an in-flight close() joins the close (terminal wins) and does not revive the scope', async () => {
    const scope = createScope()
    const d = deferredDisposer()
    scope.own(d.disposable)

    const closing = scope.close()
    await flush()
    expect(d.started()).toBe(true)

    // reset() while a close is in-flight must NOT start a second teardown nor
    // keep the scope alive — it joins the terminal close.
    const resetting = scope.reset()
    expect(scope.alive).toBe(false)

    d.release()
    await Promise.all([closing, resetting])
    expect(d.finished()).toBe(true)
    expect(scope.alive).toBe(false)
  })
})

// ── 9. adopt() — re-parent a child between scopes without reset/close ─────────
//
// TDD red: `adopt` does NOT exist on the implementation yet. These specs pin the
// codex-reviewed contract for `adopt(child, newParent)`:
//
//   - Cascade ownership transfers: after adopt, the OLD parent no longer cascades
//     reset()/close() into the child; the NEW parent does. (#1)
//   - The child itself is NOT reset/closed by the move — its own()ed resources
//     stay live and 'reset'/'closed' never fire on it. (#2)
//   - Listener leak fix (core): the OLD parent's `on('closed')` subscription on
//     the child (which `child()` currently *discards*, leaking) is UNBOUND and a
//     fresh one re-bound to the NEW parent — so a later child.close() drives only
//     the NEW parent's child-removal, never the stale OLD one. (#3)
//   - Pre-validation throws: dead this/newParent, non-direct-child, and cycle
//     (newParent is a descendant of child). (#4)
//   - Atomicity = WAIT not throw (codex): if this/newParent is mid reset()/close()
//     (in-flight), adopt awaits the fence, THEN re-validates and proceeds; it does
//     NOT throw and shove a retry onto the caller. If the awaited party becomes
//     DEAD, adopt fails explicitly (throws) and the child is NEITHER orphaned NOR
//     double-attached. (#5)
//   - No orphan / no double-attach: on every path the child is attached to EXACTLY
//     one segment — only newParent on success, only the original parent on
//     failure; never both, never neither. (#6)
//
// `adopt` is referenced loosely (the local `Scope` mirror declares it) so a
// missing implementation surfaces as a RUNTIME failure ("adopt is not a
// function") turning these specs red — not a compile error that blocks the suite.
describe('adopt() — re-parent a child without resetting/closing it', () => {
  // ── #1 cascade ownership transfers from old parent to new parent ───────────
  it('after adopt, old-parent reset()/close() no longer cascades the grandchild; new-parent close() does', async () => {
    const root = createScope()
    const pA = root.child()
    const pB = root.child()

    const gc = pA.child()
    const gcRes = vi_count()
    gc.own(gcRes.fn)

    await pA.adopt(gc, pB)

    // OLD parent teardown must NOT cascade the re-parented grandchild anymore.
    await pA.reset()
    expect(gcRes.calls()).toBe(0)
    expect(gc.alive).toBe(true)

    await pA.close()
    expect(gcRes.calls()).toBe(0)
    expect(gc.alive).toBe(true)

    // NEW parent teardown is now the one that cascades it.
    await pB.close()
    expect(gcRes.calls()).toBe(1)
    expect(gc.alive).toBe(false)
  })

  // ── #2 the child is NOT reset/closed by the move itself ────────────────────
  it('the move does not reset/close the child: its resources stay live and reset/closed never fire on it', async () => {
    const root = createScope()
    const pA = root.child()
    const pB = root.child()

    const gc = pA.child()
    const gcRes = vi_count()
    gc.own(gcRes.fn)

    const gcReset = vi_count()
    const gcClosed = vi_count()
    gc.on('reset', gcReset.fn)
    gc.on('closed', gcClosed.fn)

    await pA.adopt(gc, pB)
    await flush()

    // Child untouched by the re-parent: resource not released, fully alive, and
    // neither lifecycle event fired.
    expect(gcRes.calls()).toBe(0)
    expect(gc.alive).toBe(true)
    expect(gcReset.calls()).toBe(0)
    expect(gcClosed.calls()).toBe(0)
  })

  // ── #3 listener leak fix (core): old subscription unbound, new one rebound ─
  it('after adopt, child.close() drives ONLY the new parent removal; the stale old-parent removal never runs', async () => {
    const root = createScope()
    const pA = root.child()
    const pB = root.child()

    const gc = pA.child()

    await pA.adopt(gc, pB)

    // Closing the child itself must remove it from the NEW parent's child set,
    // not the OLD one. We prove the old subscription is unbound by then tearing
    // down the old parent: if the stale on('closed') listener were still live it
    // would try to splice gc out of pA's already-changed segment (double-handle
    // / error). The teardown must be clean.
    await expect(gc.close()).resolves.toBeUndefined()
    expect(gc.alive).toBe(false)

    // Old parent teardown after the child closed: no residual listener fires, no
    // throw, no double-processing of gc.
    await expect(pA.reset()).resolves.toBeUndefined()
    await expect(pA.close()).resolves.toBeUndefined()

    // And the new parent, which now owns gc, closes cleanly too (gc already dead
    // — must not double-dispose or throw on its removed/closed child).
    await expect(pB.close()).resolves.toBeUndefined()
  })

  it('adopting back and forth keeps exactly one live removal subscription (no accumulation / leak)', async () => {
    const root = createScope()
    const pA = root.child()
    const pB = root.child()
    const gc = pA.child()

    // Bounce the child between parents; each adopt must unbind the prior parent's
    // removal hook and bind the destination's — never accumulate stale ones.
    await pA.adopt(gc, pB)
    await pB.adopt(gc, pA)
    await pA.adopt(gc, pB)

    // Final owner is pB. Closing pA (a former owner) must NOT cascade gc.
    await pA.close()
    expect(gc.alive).toBe(true)

    // pB is the sole current owner → it cascades.
    await pB.close()
    expect(gc.alive).toBe(false)
  })

  // ── #4 pre-validation throws ───────────────────────────────────────────────
  it('throws if `this` (the donor) is not alive', async () => {
    const root = createScope()
    const pA = root.child()
    const pB = root.child()
    const gc = pA.child()

    await pA.close()
    await expect(pA.adopt(gc, pB)).rejects.toThrow()
  })

  it('throws if `newParent` is not alive', async () => {
    const root = createScope()
    const pA = root.child()
    const pB = root.child()
    const gc = pA.child()

    await pB.close()
    await expect(pA.adopt(gc, pB)).rejects.toThrow()
  })

  it('throws if `child` is not a direct child of `this` current segment (a grandchild)', async () => {
    const root = createScope()
    const pA = root.child()
    const pB = root.child()
    const gc = pA.child()
    const ggc = gc.child() // great-grandchild: NOT a direct child of pA

    await expect(pA.adopt(ggc, pB)).rejects.toThrow()
  })

  it("throws if `child` is some other scope's child (not parented by `this` at all)", async () => {
    const root = createScope()
    const pA = root.child()
    const pB = root.child()
    const strayParent = root.child()
    const stray = strayParent.child()

    await expect(pA.adopt(stray, pB)).rejects.toThrow()
  })

  it('throws on a cycle: newParent is a descendant of child (would create self-containment)', async () => {
    const root = createScope()
    const pA = root.child()
    const gc = pA.child()
    const deepChild = gc.child() // descendant of gc

    // Adopting gc INTO its own descendant would make gc contain itself.
    await expect(pA.adopt(gc, deepChild)).rejects.toThrow()
  })

  it('throws on the trivial cycle: newParent === child', async () => {
    const root = createScope()
    const pA = root.child()
    const gc = pA.child()

    await expect(pA.adopt(gc, gc)).rejects.toThrow()
  })

  // ── #5 atomicity = WAIT not throw (codex) ──────────────────────────────────
  it('when newParent is mid-reset (in-flight), adopt WAITS for the fence then attaches to the NEW segment (no throw)', async () => {
    const root = createScope()
    const pA = root.child()
    const pB = root.child()
    const gc = pA.child()

    // Make pB's reset in-flight via a deferred disposer in pB's current segment.
    const gate = deferredDisposer()
    pB.own(gate.disposable)

    const pBResetting = pB.reset()
    await flush()
    expect(gate.started()).toBe(true)
    expect(gate.finished()).toBe(false)

    // adopt while pB is mid-reset: must NOT throw — it queues behind pB's fence.
    let adoptResolved = false
    const adopting = pA.adopt(gc, pB)
    void adopting.then(() => {
      adoptResolved = true
    })

    await flush()
    // adopt is parked waiting for pB's reset fence → not yet resolved.
    expect(adoptResolved).toBe(false)

    // Release pB's reset → its fence completes (a FRESH pB segment is now live).
    gate.release()
    await pBResetting
    await adopting
    expect(adoptResolved).toBe(true)

    // gc must have landed in pB's NEW (post-reset) segment, not the stale one.
    // Proof: pB is still alive and a pB.close() now cascades gc.
    expect(pB.alive).toBe(true)
    expect(gc.alive).toBe(true)
    await pB.close()
    expect(gc.alive).toBe(false)
  })

  it('if the awaited newParent becomes DEAD while adopt waits, adopt fails explicitly (throws) and the child is NOT orphaned', async () => {
    const root = createScope()
    const pA = root.child()
    const pB = root.child()
    const gc = pA.child()
    const gcRes = vi_count()
    gc.own(gcRes.fn)

    // pB is mid-CLOSE (terminal) via a deferred disposer.
    const gate = deferredDisposer()
    pB.own(gate.disposable)
    const pBClosing = pB.close()
    await flush()
    expect(gate.started()).toBe(true)

    // adopt waits on pB's fence; pB will be DEAD when it resolves.
    const adopting = pA.adopt(gc, pB)

    gate.release()
    await pBClosing

    // adopt must reject (newParent dead) — not silently drop or double-attach.
    await expect(adopting).rejects.toThrow()

    // No orphan / no double-attach (#6): gc still belongs to its ORIGINAL parent
    // pA and is intact (not closed, resource not released).
    expect(gc.alive).toBe(true)
    expect(gcRes.calls()).toBe(0)

    // The original parent still cascades it (it never left pA on the failed move).
    await pA.close()
    expect(gcRes.calls()).toBe(1)
    expect(gc.alive).toBe(false)
  })

  // ── #6 no orphan / no double-attach — exactly one segment, always ──────────
  it('on a SUCCESSFUL adopt the child lives in EXACTLY one segment (only newParent, never both)', async () => {
    const root = createScope()
    const pA = root.child()
    const pB = root.child()
    const gc = pA.child()
    const gcRes = vi_count()
    gc.own(gcRes.fn)

    await pA.adopt(gc, pB)

    // Tear down BOTH parents. If gc were double-attached, its resource would run
    // twice; if orphaned, zero times. It must run EXACTLY once.
    await pA.close()
    await pB.close()
    expect(gcRes.calls()).toBe(1)
    expect(gc.alive).toBe(false)
  })

  it('on a FAILED adopt (cycle) the child stays in EXACTLY its original segment (pA), not lost', async () => {
    const root = createScope()
    const pA = root.child()
    const gc = pA.child()
    const deepChild = gc.child()
    const gcRes = vi_count()
    gc.own(gcRes.fn)

    // Cycle → rejects, and must leave gc exactly where it was (still under pA).
    await expect(pA.adopt(gc, deepChild)).rejects.toThrow()

    await pA.close()
    // Original parent still cascades it exactly once (deepChild also torn down as
    // gc's own descendant, but gc's resource must fire exactly once — not zero).
    expect(gcRes.calls()).toBe(1)
    expect(gc.alive).toBe(false)
  })
})

// ── tiny local counter helper (avoids leaning on vi.fn typing noise) ─────────
function vi_count(): { fn: () => void; calls: () => number } {
  let n = 0
  return {
    fn: () => {
      n++
    },
    calls: () => n,
  }
}
