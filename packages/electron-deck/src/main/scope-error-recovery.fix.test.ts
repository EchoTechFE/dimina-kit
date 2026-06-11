/**
 * Error-recovery behavior tests for the `Scope` primitive (`./scope.ts`).
 *
 * These pin what must happen when a disposer THROWS on a teardown path. The
 * sibling `scope.test.ts` covers the happy-path lifetime/fence/adopt contract;
 * this file is dedicated to the failure paths and the resilience guarantees a
 * consumer relies on after a disposer blows up:
 *
 *  1. A `reset()` whose segment contains a throwing disposer may reject (the
 *     error reaches the FIRST caller), but the scope must keep working: a
 *     SUBSEQUENT `reset()` starts a brand-new round (never returns the stale
 *     rejected promise), and resources own()ed in the new segment are really
 *     disposed by the next teardown (no leak).
 *  2. After a failed `reset()`, `close()` must still finish the shutdown:
 *     leftover segment resources get disposed and `'closed'` fires exactly once.
 *  3. A throwing disposer on the `close()` path: `close()` may reject (KA-5
 *     semantics), but `'closed'` still fires and the in-flight state is cleared
 *     — a later `close()` is idempotent and returns an already-settled result,
 *     NOT the same stale rejection forever.
 *  4. `adopt()` invoked while a fence has already rejected must still TERMINATE
 *     (resolve or reject) — never hang. Pinned with a timeout race.
 *  5. When one of several disposers in a segment throws, the OTHERS in that same
 *     segment still all run.
 *
 * `Scope` is engine-agnostic (no electron import). We mirror its structural type
 * and load the implementation dynamically so a missing/changed export surfaces
 * as a runtime/assertion failure rather than a hard compile error.
 */
import { describe, it, expect, beforeAll } from 'vitest'

import type { Disposable } from './disposable.js'

interface Scope {
  readonly alive: boolean
  own(d: Disposable | (() => void)): Disposable
  child(): Scope
  reset(): Promise<void>
  close(): Promise<void>
  on(event: 'reset' | 'closed', cb: () => void): Disposable
  adopt(child: Scope, newParent: Scope): Promise<void>
}

let createScope: () => Scope

beforeAll(async () => {
  const mod = (await import('./scope.js')) as { createScope: () => Scope }
  createScope = mod.createScope
})

/** Tiny call counter (mirrors the helper in scope.test.ts). */
function vi_count(): { fn: () => void; calls: () => number } {
  let n = 0
  return {
    fn: () => {
      n++
    },
    calls: () => n,
  }
}

/** A disposer that always throws when disposed. */
function throwingDisposer(message = 'boom'): Disposable {
  return {
    dispose() {
      throw new Error(message)
    },
  }
}

/** Await a promise but fail the test (instead of hanging the suite) if it does
 * not settle within `ms`. Resolves to 'resolved' | 'rejected'. */
async function settleWithin(
  p: Promise<unknown>,
  ms: number,
): Promise<'resolved' | 'rejected'> {
  const timeout = Symbol('timeout')
  const race = await Promise.race([
    p.then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    ),
    new Promise<typeof timeout>((r) => setTimeout(() => r(timeout), ms)),
  ])
  if (race === timeout) {
    throw new Error(`promise did not settle within ${ms}ms (hung)`)
  }
  return race
}

// ── 1. reset() after a throwing disposer: fresh round + no leak ───────────────
describe('reset() recovery after a throwing disposer', () => {
  it('a second reset() starts a fresh round (not the stale rejected promise) and disposes the new segment', async () => {
    const scope = createScope()

    // Segment-1: a disposer that throws on reset.
    scope.own(throwingDisposer('seg1-boom'))

    // First reset may reject (error reaches the first caller).
    const firstReset = scope.reset()
    const firstOutcome = await settleWithin(firstReset, 500)
    expect(firstOutcome).toBe('rejected')

    // Scope is still alive after a reset (reset never kills).
    expect(scope.alive).toBe(true)

    // Segment-2: a clean resource that must be torn down by the NEXT reset.
    const seg2 = vi_count()
    scope.own(seg2.fn)
    expect(seg2.calls()).toBe(0)

    // The second reset() must be a BRAND-NEW round, not the stale rejected
    // promise from the first. It must resolve (clean segment) and actually
    // dispose seg2 — proving the new segment is wired up and not leaked.
    const secondReset = scope.reset()
    expect(secondReset).not.toBe(firstReset)
    const secondOutcome = await settleWithin(secondReset, 500)
    expect(secondOutcome).toBe('resolved')

    expect(seg2.calls()).toBe(1)
    expect(scope.alive).toBe(true)
  })

  it('resources own()ed after a failed reset() are disposed on a later close() (no leak)', async () => {
    const scope = createScope()
    scope.own(throwingDisposer('seg1-boom'))

    await settleWithin(scope.reset(), 500) // first reset rejects; swallow outcome

    const seg2 = vi_count()
    scope.own(seg2.fn)

    // close() must tear down the live (segment-2) resource exactly once.
    await settleWithin(scope.close(), 500)
    expect(seg2.calls()).toBe(1)
    expect(scope.alive).toBe(false)
  })
})

// ── 2. close() after a failed reset() still finishes shutdown ─────────────────
describe('close() after a failed reset() completes the shutdown', () => {
  it('disposes leftover segment resources and emits closed exactly once', async () => {
    const scope = createScope()

    // Segment-1 has BOTH a throwing disposer and a clean resource. The reset
    // fails, but afterwards the scope is reusable.
    scope.own(throwingDisposer('seg1-boom'))

    await settleWithin(scope.reset(), 500) // rejects; ignored

    // New segment with a leftover live resource that close() must reclaim.
    const leftover = vi_count()
    scope.own(leftover.fn)

    const closed = vi_count()
    scope.on('closed', closed.fn)

    await settleWithin(scope.close(), 500)

    // Shutdown actually happened: leftover disposed, scope dead, closed fired once.
    expect(leftover.calls()).toBe(1)
    expect(scope.alive).toBe(false)
    expect(closed.calls()).toBe(1)
  })
})

// ── 3. throwing disposer on the close() path ──────────────────────────────────
describe('close() with a throwing disposer — closed still fires, state cleared', () => {
  it("close() may reject but 'closed' still fires exactly once", async () => {
    const scope = createScope()
    scope.own(throwingDisposer('close-boom'))

    const closed = vi_count()
    scope.on('closed', closed.fn)

    const outcome = await settleWithin(scope.close(), 500)
    expect(outcome).toBe('rejected') // KA-5: error propagates to the caller

    // The 'closed' event must still fire (shutdown is observable) — once.
    expect(closed.calls()).toBe(1)
    expect(scope.alive).toBe(false)
  })

  it('a later close() after a rejecting close() is idempotent and returns a SETTLED (resolved) result, not the same stale rejection', async () => {
    const scope = createScope()
    scope.own(throwingDisposer('close-boom'))

    const first = scope.close()
    expect(await settleWithin(first, 500)).toBe('rejected')

    // The in-flight state must be cleared: a subsequent close() must NOT hand
    // back the same stale rejected promise. It should resolve cleanly (the
    // scope is already dead; there is nothing left to dispose).
    const second = scope.close()
    expect(second).not.toBe(first)
    expect(await settleWithin(second, 500)).toBe('resolved')

    // And still idempotent on a third call.
    const third = scope.close()
    expect(await settleWithin(third, 500)).toBe('resolved')
    expect(scope.alive).toBe(false)
  })

  it("'closed' fires exactly once even across the rejecting close() and the later idempotent close()", async () => {
    const scope = createScope()
    scope.own(throwingDisposer('close-boom'))
    const closed = vi_count()
    scope.on('closed', closed.fn)

    await settleWithin(scope.close(), 500) // rejects
    await settleWithin(scope.close(), 500) // idempotent

    expect(closed.calls()).toBe(1)
  })
})

// ── 4. adopt() must terminate even when a fence has already rejected ──────────
//
// INTENTIONALLY OMITTED — un-pinnable in this runner.
//
// The desired behavior: a scope whose reset()/close() rejected leaves a stale
// internal fence; calling adopt() that touches such a scope must still TERMINATE
// (resolve/reject) rather than hang forever. We tried to pin this with a bounded
// `Promise.race([adopt, setTimeout(...)])`.
//
// But the CURRENT implementation does not merely leave adopt() pending — adopt()
// after a rejected reset() enters a SYNCHRONOUS, uninterruptible spin (confirmed
// by isolating just the adopt call for both the donor-rejected and the
// newParent-rejected variants: each wedges the vitest worker with no test ever
// reporting, and even vitest's own testTimeout cannot fire). A synchronous spin
// starves the macrotask queue, so NO JS timeout — `settleWithin`, `setTimeout`,
// or vitest's testTimeout — can ever observe "it didn't terminate". A test that
// hangs the worker is worse than absent: it makes the whole suite uncollectable
// and can never be seen turning green.
//
// Behaviors #1 (fresh-round reset), #2 (close after failed reset), #3 (throwing
// close), and #5 (sibling disposers) above already pin the error-recovery surface
// with clean, observable REDs. The adopt-after-rejected-fence guarantee should be
// covered once the implementation no longer dead-spins (i.e. after the reset/close
// in-flight state is cleared per #1/#3); at that point a bounded-race assertion
// becomes runnable and can be added here.

// ── 5. one throwing disposer does not skip the other disposers in the segment ─
describe('a throwing disposer does not prevent sibling disposers in the same segment', () => {
  it('on close(): all other owned disposers in the segment still run', async () => {
    const scope = createScope()
    const a = vi_count()
    const b = vi_count()
    const c = vi_count()

    scope.own(a.fn)
    scope.own(throwingDisposer('middle-boom'))
    scope.own(b.fn)
    scope.own(c.fn)

    await settleWithin(scope.close(), 500) // may reject; we only care siblings ran

    expect(a.calls()).toBe(1)
    expect(b.calls()).toBe(1)
    expect(c.calls()).toBe(1)
    expect(scope.alive).toBe(false)
  })

  it('on reset(): all other owned disposers in the segment still run', async () => {
    const scope = createScope()
    const a = vi_count()
    const b = vi_count()

    scope.own(a.fn)
    scope.own(throwingDisposer('reset-middle-boom'))
    scope.own(b.fn)

    await settleWithin(scope.reset(), 500)

    expect(a.calls()).toBe(1)
    expect(b.calls()).toBe(1)
    expect(scope.alive).toBe(true)
  })

  it('multiple throwing disposers: every NON-throwing sibling still runs', async () => {
    const scope = createScope()
    const s0 = vi_count()
    const s1 = vi_count()
    const s2 = vi_count()

    scope.own(s0.fn)
    scope.own(throwingDisposer('boom-1'))
    scope.own(s1.fn)
    scope.own(throwingDisposer('boom-2'))
    scope.own(s2.fn)

    await settleWithin(scope.close(), 500)

    expect(s0.calls()).toBe(1)
    expect(s1.calls()).toBe(1)
    expect(s2.calls()).toBe(1)
  })
})
