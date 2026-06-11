/**
 * Behavior tests for the `Compositor` primitive — the implementation in
 * `./compositor.js` does NOT exist yet (TDD: these tests are written first and
 * are expected to be RED until `createCompositor()` ships).
 *
 * `Compositor` is the engine-agnostic z-order planner for a window's native
 * child views (an Electron `contentView` and its `addChildView`/
 * `removeChildView` in production; a fully-faked `ContentViewHost` here). It
 * separates INTENT (mount / unmount / reorder a view into a zone, at a relative
 * position) from APPLICATION (`commit()` computes the minimal sequence of host
 * add/remove calls that transforms the host's current child order into the
 * target order).
 *
 * The spikes in `.repro/electron-deck-spikes/` established the host's observable
 * z-semantics that this planner is built on:
 *   - `addChildView` of an ALREADY-mounted child raises it to the top WITHOUT a
 *     remove first and WITHOUT reloading it (gate1: "bare add(MIDDLE)" → MIDDLE
 *     to top, no reload).
 *   - `addChildView` of a NEW child appends it to the end (= topmost).
 *   - A batch of remove/add in ONE synchronous tick re-lands at the target order
 *     with zero renderer reloads (gate1 batch block).
 *   - `addChildView` into a destroyed window/contentView throws synchronously
 *     (gate2 "add-to-destroyed-window").
 *
 * Contract being pinned (target file `./compositor.ts`):
 *
 *   type NativeViewRef = { readonly id: string }
 *   interface ContentViewHost {
 *     addChildView(v: NativeViewRef): void   // already mounted = raise to top;
 *                                            // new = append to end (top)
 *     removeChildView(v: NativeViewRef): void
 *     readonly isDestroyed: boolean
 *     children(): readonly NativeViewRef[]   // current order; LAST = topmost
 *   }
 *   interface Compositor {
 *     mount(view: NativeViewRef, opts?: { zone?: number }): void
 *     unmount(viewId: string): void
 *     reorder(viewId: string, opts: { zone?: number; before?: string | null }): void
 *     commit(): void
 *   }
 *   export function createCompositor(host: ContentViewHost): Compositor
 *
 * No electron import; `Compositor` is engine-agnostic.
 */
import { describe, it, expect, beforeAll } from 'vitest'

// ── TDD red: the implementation (`./compositor.js`) does NOT exist yet ────────
//
// We load it dynamically so the FAILURE is a runtime/assertion failure (the
// module fails to resolve at test time, turning every spec red) rather than a
// hard compile error that would prevent the suite from running at all. Once
// `createCompositor` / the `Compositor` contract ship, `beforeAll` resolves the
// real export and the already-written specs exercise the contract.
//
// We mirror the public contract types locally so the specs read against real
// types; the implementation's exported shapes must be assignable to these.
type NativeViewRef = { readonly id: string }

interface ContentViewHost {
  addChildView(v: NativeViewRef): void
  removeChildView(v: NativeViewRef): void
  readonly isDestroyed: boolean
  children(): readonly NativeViewRef[]
}

interface Compositor {
  mount(view: NativeViewRef, opts?: { zone?: number }): void
  unmount(viewId: string): void
  reorder(viewId: string, opts: { zone?: number; before?: string | null }): void
  commit(): void
  // ── TDD red: `detachAll` is not implemented on the compositor yet (Part 1).
  // Folds the intent to EMPTY and commits, removing all of this window's native
  // views from the host. Reuses the teardown-friendly removals-only-on-destroyed
  // path (A1.2.1), so on an already-destroyed host it is SILENT (no throw).
  detachAll(): void
}

let createCompositor: (host: ContentViewHost) => Compositor

beforeAll(async () => {
  // `./compositor.js` now exists; the dynamic import resolves the real
  // `createCompositor`. Cast via `unknown`: the real `Compositor` does not yet
  // carry `detachAll` (TDD red, Part 1), so a direct cast is rejected — the
  // missing method surfaces at RUNTIME (`detachAll is not a function`) in the
  // Part-1 specs, not as a hard compile error that would break module load.
  const mod = (await import('./compositor.js')) as unknown as {
    createCompositor: (host: ContentViewHost) => Compositor
  }
  createCompositor = mod.createCompositor
})

// ── Fake ContentViewHost ─────────────────────────────────────────────────────
//
// Faithful to the spike-established semantics so the planner's minimality
// claims are observable:
//   - addChildView(known)  → move that ref to the END of `children` (raise).
//   - addChildView(new)    → append to the END of `children`.
//   - removeChildView(v)   → drop it from `children` (no-op if absent).
//   - isDestroyed          → when true, addChildView throws synchronously
//                            (mirrors "add into a destroyed window").
//
// It records every add/remove call in `calls` (in order) so a test can assert
// the EXACT host-call sequence and its length (minimal-step proof). Identity is
// by `id` (refs are compared structurally — a re-mount may hand a fresh object
// with the same id, but the host tracks the currently-mounted ref).
interface CallRecord {
  op: 'add' | 'remove'
  id: string
}

function makeHost(opts: { destroyed?: boolean } = {}): ContentViewHost & {
  calls: CallRecord[]
  ids: () => string[]
  setDestroyed: (v: boolean) => void
} {
  const order: NativeViewRef[] = []
  let destroyed = opts.destroyed ?? false
  const calls: CallRecord[] = []

  return {
    get isDestroyed() {
      return destroyed
    },
    setDestroyed(v: boolean) {
      destroyed = v
    },
    addChildView(v: NativeViewRef) {
      if (destroyed) {
        throw new Error('addChildView: contentView is destroyed')
      }
      calls.push({ op: 'add', id: v.id })
      // Already mounted (by id) → raise to top (drop the old slot, append).
      const i = order.findIndex((x) => x.id === v.id)
      if (i >= 0) order.splice(i, 1)
      order.push(v)
    },
    removeChildView(v: NativeViewRef) {
      calls.push({ op: 'remove', id: v.id })
      const i = order.findIndex((x) => x.id === v.id)
      if (i >= 0) order.splice(i, 1)
    },
    children() {
      return order.slice()
    },
    calls,
    ids: () => order.map((v) => v.id),
  }
}

/** Convenience: a view ref with the given id. */
function ref(id: string): NativeViewRef {
  return { id }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. mount idempotency
// Codex pin: mount of an ALREADY-mounted view is a pure no-op — it does NOT
// re-append, does NOT change that view's order key / mount sequence, and the
// committed order is identical before vs. after the redundant mount. (Only a
// genuinely-new mount appends; see §7 for the host-call count proof.)
// ─────────────────────────────────────────────────────────────────────────────
describe('mount — idempotent for an already-mounted view', () => {
  it('re-mounting a mounted view does not change committed order', () => {
    const host = makeHost()
    const c = createCompositor(host)

    c.mount(ref('a'))
    c.mount(ref('b'))
    c.mount(ref('c'))
    c.commit()
    expect(host.ids()).toEqual(['a', 'b', 'c'])

    const before = host.ids()
    // Redundant mount of an already-mounted view (mid-stack): must be a no-op,
    // NOT a raise-to-top.
    c.mount(ref('b'))
    c.commit()
    expect(host.ids()).toEqual(before) // b did NOT jump to the top
  })

  it('a redundant mount emits no host calls on commit (no churn)', () => {
    const host = makeHost()
    const c = createCompositor(host)
    c.mount(ref('a'))
    c.mount(ref('b'))
    c.commit()

    const callsBefore = host.calls.length
    c.mount(ref('a')) // already mounted
    c.mount(ref('b')) // already mounted
    c.commit()
    // A commit that changes nothing must not add/remove anything.
    expect(host.calls.length).toBe(callsBefore)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. mount epoch (mountSeq)
// Codex pin: unmount(id) then mount(a NEW ref with the same id) is a NEW
// instance — it gets a fresh mount sequence and lands at the zone's TOP (end),
// it does NOT inherit the old view's prior order. The idempotent no-op of §1
// applies ONLY to views that are STILL mounted; an unmount→re-mount is never a
// no-op.
// ─────────────────────────────────────────────────────────────────────────────
describe('mount epoch — unmount then re-mount is a new instance', () => {
  it('re-mounting after unmount lands at the top, not the old position', () => {
    const host = makeHost()
    const c = createCompositor(host)
    c.mount(ref('a'))
    c.mount(ref('b'))
    c.mount(ref('c'))
    c.commit()
    expect(host.ids()).toEqual(['a', 'b', 'c'])

    // b was in the MIDDLE; unmount it, then mount it afresh.
    c.unmount('b')
    c.mount(ref('b'))
    c.commit()
    // The new b instance is appended last (topmost) — it did NOT resume its old
    // middle slot.
    expect(host.ids()).toEqual(['a', 'c', 'b'])
  })

  it('unmount→re-mount is NOT treated as the idempotent no-op', () => {
    const host = makeHost()
    const c = createCompositor(host)
    c.mount(ref('x'))
    c.mount(ref('y'))
    c.commit()
    expect(host.ids()).toEqual(['x', 'y'])

    c.unmount('x')
    c.mount(ref('x')) // fresh instance, same id
    c.commit()
    // x moved to the top — proving the re-mount was honored (a no-op would have
    // left it at ['x','y']).
    expect(host.ids()).toEqual(['y', 'x'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. reorder — zero perturbation of unrelated views
// Codex pin: reorder(B, {before: C}) places B immediately before C and leaves
// the relative order of every OTHER view unchanged. before:null means "to the
// end of the zone" (topmost).
// ─────────────────────────────────────────────────────────────────────────────
describe('reorder — minimal perturbation; before-anchor semantics', () => {
  it('reorder(B,{before:C}) puts B before C and preserves all other relative orders', () => {
    const host = makeHost()
    const c = createCompositor(host)
    // current: a b c d e
    for (const id of ['a', 'b', 'c', 'd', 'e']) c.mount(ref(id))
    c.commit()
    expect(host.ids()).toEqual(['a', 'b', 'c', 'd', 'e'])

    // Move e to immediately before c.
    c.reorder('e', { before: 'c' })
    c.commit()
    expect(host.ids()).toEqual(['a', 'b', 'e', 'c', 'd'])

    // Pin "everyone else's pairwise order is unchanged" explicitly: a<b, c<d,
    // and the non-moved set {a,b,c,d} keeps its original relative sequence.
    const others = host.ids().filter((id) => id !== 'e')
    expect(others).toEqual(['a', 'b', 'c', 'd'])
  })

  it('reorder(B,{before:null}) moves B to the end (topmost) of the zone', () => {
    const host = makeHost()
    const c = createCompositor(host)
    for (const id of ['a', 'b', 'c']) c.mount(ref(id))
    c.commit()

    c.reorder('a', { before: null })
    c.commit()
    expect(host.ids()).toEqual(['b', 'c', 'a'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. reorder — change zone
// Codex pin: reorder(B,{zone: higher}) moves B into the higher zone; after
// commit B sits ABOVE every view that remains in a lower zone (zones stack:
// all of zone N renders below all of zone N+1).
// ─────────────────────────────────────────────────────────────────────────────
describe('reorder — moving a view to a higher zone raises it above the lower zone', () => {
  it('a view sent to a higher zone commits above all lower-zone views', () => {
    const host = makeHost()
    const c = createCompositor(host)
    // Three views all in zone 0.
    c.mount(ref('a'), { zone: 0 })
    c.mount(ref('b'), { zone: 0 })
    c.mount(ref('c'), { zone: 0 })
    c.commit()
    expect(host.ids()).toEqual(['a', 'b', 'c'])

    // Send b to a higher zone — it must end up above a AND c (which stay low),
    // regardless of b's prior within-zone position.
    c.reorder('b', { zone: 1 })
    c.commit()
    const order = host.ids()
    expect(order.indexOf('b')).toBeGreaterThan(order.indexOf('a'))
    expect(order.indexOf('b')).toBeGreaterThan(order.indexOf('c'))
    // The two low-zone views keep their relative order beneath b.
    expect(order).toEqual(['a', 'c', 'b'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. illegal `before` → synchronous throw
// Codex pin: a `before` that names a non-existent / unmounted id, OR a `before`
// whose zone conflicts with an explicit `zone` arg, must throw SYNCHRONOUSLY
// from reorder() — never silently no-op or defer the error to commit().
// ─────────────────────────────────────────────────────────────────────────────
describe('reorder — illegal before throws synchronously', () => {
  it('before pointing at a never-mounted id throws synchronously', () => {
    const host = makeHost()
    const c = createCompositor(host)
    c.mount(ref('a'))
    c.mount(ref('b'))
    c.commit()

    expect(() => c.reorder('a', { before: 'ghost' })).toThrow()
  })

  it('before pointing at an unmounted (since removed) id throws synchronously', () => {
    const host = makeHost()
    const c = createCompositor(host)
    c.mount(ref('a'))
    c.mount(ref('b'))
    c.mount(ref('c'))
    c.commit()

    c.unmount('c')
    c.commit()
    // c is no longer mounted — using it as an anchor must throw at call time.
    expect(() => c.reorder('a', { before: 'c' })).toThrow()
  })

  it('before in a DIFFERENT zone than the explicit zone arg throws synchronously', () => {
    const host = makeHost()
    const c = createCompositor(host)
    c.mount(ref('a'), { zone: 0 })
    c.mount(ref('hi'), { zone: 1 })
    c.commit()

    // Asking to land a in zone 0 but anchored before `hi` (which is in zone 1)
    // is contradictory and must throw — not silently pick one.
    expect(() => c.reorder('a', { zone: 0, before: 'hi' })).toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. batch = last-state (intent collapses, not a write-log replay)
// Codex pin: multiple reorders of the SAME view before a single commit reflect
// ONLY the final intent (no intermediate stops); a mixed batch of
// mount/unmount/reorder across several views commits once, directly to the
// target total order (the planner diffs current→target, it does not replay the
// individual ops).
// ─────────────────────────────────────────────────────────────────────────────
describe('batch — commit reflects final intent only (last-state semantics)', () => {
  it('repeated reorders of one view collapse to the final position', () => {
    const host = makeHost()
    const c = createCompositor(host)
    for (const id of ['a', 'b', 'c', 'd']) c.mount(ref(id))
    c.commit()

    // Three competing intents for `a` in one batch; only the LAST wins.
    c.reorder('a', { before: 'c' }) // intermediate
    c.reorder('a', { before: 'b' }) // intermediate
    c.reorder('a', { before: null }) // FINAL: to the end
    c.commit()
    expect(host.ids()).toEqual(['b', 'c', 'd', 'a'])
  })

  it('a mixed mount/unmount/reorder batch commits once to the target total order', () => {
    const host = makeHost()
    const c = createCompositor(host)
    for (const id of ['a', 'b', 'c']) c.mount(ref(id))
    c.commit()
    expect(host.ids()).toEqual(['a', 'b', 'c'])

    // One batch: remove b, add a new d, move c before a. Commit once.
    c.unmount('b')
    c.mount(ref('d'))
    c.reorder('c', { before: 'a' })
    c.commit()
    // Target order: c, a, d  (b gone; c before a; d appended/new is top of its
    // zone but `c before a` constrains the front, so d trails).
    expect(host.ids()).toEqual(['c', 'a', 'd'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. commit — minimal host operations (LIS over the current∩target intersection)
// Codex pin: commit computes the LONGEST INCREASING SUBSEQUENCE of views that
// are ALREADY in their correct relative order and leaves THOSE untouched (no
// remove/add) — only the views that must move are re-added. The LIS is computed
// over the intersection of currently-mounted and target views; a genuinely NEW
// view is added explicitly (it is NOT considered "already in place" just because
// the host happens to append it).
// ─────────────────────────────────────────────────────────────────────────────
describe('commit — minimal steps via LIS; new views are explicitly added', () => {
  it('moving the middle of three to the end re-adds ONLY that one view', () => {
    const host = makeHost()
    const c = createCompositor(host)
    c.mount(ref('a'))
    c.mount(ref('b'))
    c.mount(ref('c'))
    c.commit()
    expect(host.ids()).toEqual(['a', 'b', 'c'])

    // Record host churn from here on.
    const start = host.calls.length

    // Target: a, c, b  (move the middle one, b, to the end).
    c.reorder('b', { before: null })
    c.commit()
    expect(host.ids()).toEqual(['a', 'c', 'b'])

    const churn = host.calls.slice(start)
    // a and c are an increasing subsequence already in correct relative order
    // (the LIS) → they must NOT be touched. Only b is re-added (raise-to-top).
    expect(churn.filter((k) => k.id === 'a')).toEqual([])
    expect(churn.filter((k) => k.id === 'c')).toEqual([])
    // Exactly one host call total, and it is an `add` of b.
    expect(churn).toEqual([{ op: 'add', id: 'b' }])
  })

  it('a brand-new view is added via a single addChildView, distinct from LIS members', () => {
    const host = makeHost()
    const c = createCompositor(host)
    c.mount(ref('a'))
    c.mount(ref('b'))
    c.commit()
    expect(host.ids()).toEqual(['a', 'b'])

    const start = host.calls.length
    // Add a brand-new view d on top; a and b are the LIS and stay put.
    c.mount(ref('d'))
    c.commit()
    expect(host.ids()).toEqual(['a', 'b', 'd'])

    const churn = host.calls.slice(start)
    // The new view goes in via exactly one addChildView; the pre-existing LIS
    // members are never re-added/removed.
    expect(churn).toEqual([{ op: 'add', id: 'd' }])
    expect(churn.filter((k) => k.id === 'a')).toEqual([])
    expect(churn.filter((k) => k.id === 'b')).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 8. commit into a destroyed host → synchronous throw
// Codex pin: when host.isDestroyed === true at commit time, commit() throws
// synchronously (the spike showed addChildView into a destroyed contentView
// throws synchronously — the planner must surface that, not swallow it).
// ─────────────────────────────────────────────────────────────────────────────
describe('commit — destroyed host throws synchronously', () => {
  it('commit() throws when the host is destroyed and there is pending work', () => {
    const host = makeHost()
    const c = createCompositor(host)
    c.mount(ref('a'))
    c.commit()

    host.setDestroyed(true)
    c.mount(ref('b')) // pending mount that would require an addChildView
    expect(() => c.commit()).toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 9. rebalance — fractional order-key exhaustion does not perturb visible order
// Codex pin: repeatedly reordering a view to sit just-before the same neighbor
// (taking the fractional midpoint over and over) eventually exhausts float
// precision; the Compositor must RENUMBER (rebalance) that zone's order keys
// internally, and the visible committed order must be IDENTICAL before and
// after the rebalance — the renumber is invisible (no observable churn beyond
// the moves the user actually asked for).
// ─────────────────────────────────────────────────────────────────────────────
describe('rebalance — precision-exhausting reorders keep visible order intact', () => {
  it('many before-midpoint reorders converge without corrupting the total order', () => {
    const host = makeHost()
    const c = createCompositor(host)
    // A larger fixed set so we can detect any stray reshuffle from a rebalance.
    const ids = ['v0', 'v1', 'v2', 'v3', 'v4', 'v5']
    for (const id of ids) c.mount(ref(id))
    c.commit()
    expect(host.ids()).toEqual(ids)

    // Force midpoint exhaustion between a fixed adjacent pair: repeatedly slot
    // v5 just before v1, then v0 just before v5, ping-ponging into the same gap
    // so the fractional key between v0 and v1 keeps halving. Many iterations
    // (> float mantissa depth) guarantees a rebalance fires.
    for (let i = 0; i < 200; i++) {
      c.reorder('v5', { before: 'v1' })
      c.reorder('v0', { before: 'v5' })
    }
    c.commit()

    const order = host.ids()
    // The set is preserved exactly (nothing dropped/duplicated by a rebalance).
    expect([...order].sort()).toEqual([...ids].sort())
    // The final intent: ... v0, v5, v1 ... — v0 immediately before v5, v5
    // immediately before v1, and the untouched tail keeps its order.
    expect(order.indexOf('v0')).toBe(order.indexOf('v5') - 1)
    expect(order.indexOf('v5')).toBe(order.indexOf('v1') - 1)
    // v2..v4 retain their original relative order beneath/around the moved set.
    const tail = order.filter((id) => id === 'v2' || id === 'v3' || id === 'v4')
    expect(tail).toEqual(['v2', 'v3', 'v4'])
  })

  it('a rebalance does not introduce an observable reshuffle on the next commit', () => {
    const host = makeHost()
    const c = createCompositor(host)
    const ids = ['p', 'q', 'r']
    for (const id of ids) c.mount(ref(id))
    c.commit()

    // Exhaust precision in one gap.
    for (let i = 0; i < 200; i++) {
      c.reorder('r', { before: 'q' })
      c.reorder('p', { before: 'r' })
    }
    c.commit()
    const afterExhaust = host.ids()

    // A subsequent NO-OP commit (no new intent) must not move anything — the
    // internal renumber is already settled and produces no visible churn.
    const start = host.calls.length
    c.commit()
    expect(host.ids()).toEqual(afterExhaust)
    expect(host.calls.slice(start)).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 10. commit — transactional failure semantics (A1.2.1)  [TDD red: CommitError
//     is not exported yet, and the new destroyed/rollback behaviors are not
//     implemented — the old code throws a generic Error.]
//
// Contract: commit() returns void on success (native == target). On failure it
// throws a typed `CommitError extends Error` describing the consistent state the
// native host is left in:
//   class CommitError extends Error {
//     readonly kind: 'host-destroyed' | 'apply-failed'
//     readonly applied: false | 'partial'
//     readonly recovered?: boolean   // only for kind:'apply-failed'
//   }
//
// The new key behaviors vs. the old generic throw:
//   • a no-op commit is silent even on a destroyed host (nothing to do);
//   • a destroyed host with ADDITIONS pending → typed host-destroyed throw, host
//     untouched (applied:false);
//   • a destroyed host with ONLY REMOVALS pending → SILENT no-op (teardown: the
//     views died with the contentView, removing them is vacuous);
//   • a native call that throws MID-APPLY is caught, the host is rolled back to
//     its pre-apply snapshot order, and a typed apply-failed throw reports
//     whether the rollback restored the snapshot (recovered:true/false).
// ─────────────────────────────────────────────────────────────────────────────
describe('commit — transactional failure semantics (A1.2.1, CommitError)', () => {
	// The typed error is imported lazily alongside `createCompositor` so the
	// missing export turns these specs (and only these) red, rather than breaking
	// module load for the whole file. Mirrors the public shape locally.
	interface CommitErrorShape extends Error {
		readonly kind: 'host-destroyed' | 'apply-failed'
		readonly applied: false | 'partial'
		readonly recovered?: boolean
	}
	let CommitError: new (...args: never[]) => CommitErrorShape

	beforeAll(async () => {
		// Cast via `unknown`: `CommitError` is not exported yet (TDD red), so the
		// real module type lacks it. The runtime read of `mod.CommitError` is
		// `undefined` until it ships, turning the specs below red at assertion
		// time rather than breaking module load.
		const mod = (await import('./compositor.js')) as unknown as {
			CommitError: new (...args: never[]) => CommitErrorShape
		}
		CommitError = mod.CommitError
	})

	// ── Local instrumented host ────────────────────────────────────────────────
	//
	// Wraps the shared fake `makeHost()` so a spec can (a) toggle `isDestroyed`
	// mid-test and (b) make the Nth native add/remove call throw — both required
	// to exercise the destroyed-host and mid-apply-failure paths without editing
	// the shared fake. `failForward` throws on the targeted FORWARD apply call but
	// lets rollback calls through (so the snapshot can be restored); `failAll`
	// throws on EVERY native call (so even rollback dies). Counts only the
	// underlying host's real calls.
	function makeFlakyHost(): ContentViewHost & {
		ids: () => string[]
		calls: CallRecord[]
		setDestroyed: (v: boolean) => void
		failForward: (nth: number) => void
		failAll: () => void
	} {
		const inner = makeHost()
		let armed = false
		let failAtForward = -1
		let failEverything = false
		let nativeCallCount = 0

		function tick(): void {
			nativeCallCount++
			if (failEverything) {
				throw new Error('flaky host: native call rejected (host dying)')
			}
			if (armed && nativeCallCount === failAtForward) {
				throw new Error('flaky host: forward apply call rejected mid-commit')
			}
		}

		return {
			get isDestroyed() {
				return inner.isDestroyed
			},
			setDestroyed(v: boolean) {
				inner.setDestroyed(v)
			},
			addChildView(v: NativeViewRef) {
				tick()
				inner.addChildView(v)
			},
			removeChildView(v: NativeViewRef) {
				tick()
				inner.removeChildView(v)
			},
			children() {
				return inner.children()
			},
			calls: inner.calls,
			ids: () => inner.ids(),
			failForward(nth: number) {
				armed = true
				failAtForward = nth
				nativeCallCount = 0
			},
			failAll() {
				failEverything = true
			},
		}
	}

	// 1. no-op silent — even on a destroyed host.
	// Pin: a commit with host children already == target makes ZERO host calls
	// and throws nothing, even when isDestroyed is true (nothing to do = silent).
	it('no-op commit on a destroyed host is silent (zero calls, no throw)', () => {
		const host = makeHost()
		const c = createCompositor(host)
		c.mount(ref('a'))
		c.mount(ref('b'))
		c.commit()
		expect(host.ids()).toEqual(['a', 'b'])

		const start = host.calls.length
		host.setDestroyed(true)
		// No new intent → target == current → no work.
		expect(() => c.commit()).not.toThrow()
		expect(host.calls.slice(start)).toEqual([])
	})

	// 2. host-destroyed preflight with an ADDITION pending → typed throw, untouched.
	// Pin: destroyed host + pending addition → CommitError{host-destroyed,
	// applied:false}; host received zero add/remove calls (native == pre-commit).
	it('destroyed host with a pending addition throws CommitError(host-destroyed, applied:false) and touches nothing', () => {
		const host = makeHost()
		const c = createCompositor(host)
		c.mount(ref('a'))
		c.commit()
		expect(host.ids()).toEqual(['a'])

		const start = host.calls.length
		host.setDestroyed(true)
		c.mount(ref('b')) // a brand-new view → an ADDITION is pending

		let thrown: unknown
		try {
			c.commit()
		} catch (e) {
			thrown = e
		}
		expect(thrown).toBeInstanceOf(CommitError)
		const err = thrown as CommitErrorShape
		expect(err.kind).toBe('host-destroyed')
		expect(err.applied).toBe(false)
		// Native untouched: pre-commit order preserved, zero host calls.
		expect(host.calls.slice(start)).toEqual([])
		expect(host.ids()).toEqual(['a'])
	})

	// 3. THE key new behavior: destroyed host + ONLY removals → SILENT no-op.
	// Pin: work is present but it is exclusively removals (no additions) and the
	// host is destroyed → commit returns void, throws nothing, makes ZERO host
	// calls (teardown-friendly: the views are gone with the contentView).
	it('destroyed host with ONLY removals pending is silent (no CommitError, zero calls)', () => {
		const host = makeHost()
		const c = createCompositor(host)
		// Mount + commit on a LIVE host so native actually has children.
		c.mount(ref('a'))
		c.mount(ref('b'))
		c.commit()
		expect(host.ids()).toEqual(['a', 'b'])

		// Target becomes empty → the only pending work is removals.
		c.unmount('a')
		c.unmount('b')

		const start = host.calls.length
		host.setDestroyed(true) // contentView torn down; its views died with it
		expect(() => c.commit()).not.toThrow()
		// Vacuous: no remove calls issued against the dead host.
		expect(host.calls.slice(start)).toEqual([])
	})

	// 4. apply-failed rollback, recovered:true.
	// Pin: host ALIVE at preflight; a native call throws mid-apply; commit catches
	// it, restores the pre-apply snapshot order, and throws CommitError{
	// apply-failed, applied:'partial', recovered:true}; host.children() after the
	// throw == the pre-commit snapshot order (rollback succeeded).
	it('mid-apply native failure rolls back to the snapshot and throws CommitError(apply-failed, partial, recovered:true)', () => {
		const host = makeFlakyHost()
		const c = createCompositor(host)
		c.mount(ref('a'))
		c.mount(ref('b'))
		c.mount(ref('c'))
		c.commit()
		expect(host.ids()).toEqual(['a', 'b', 'c'])

		const snapshot = host.ids() // ['a','b','c'] — pre-commit native order

		// Force a multi-call commit: move the middle view to the top (a re-add) and
		// add a brand-new view — at least one forward host call to blow up on.
		c.reorder('a', { before: null })
		c.mount(ref('d'))

		// Make the FIRST forward apply call throw; rollback calls succeed.
		host.failForward(1)

		let thrown: unknown
		try {
			c.commit()
		} catch (e) {
			thrown = e
		}
		expect(thrown).toBeInstanceOf(CommitError)
		const err = thrown as CommitErrorShape
		expect(err.kind).toBe('apply-failed')
		expect(err.applied).toBe('partial')
		expect(err.recovered).toBe(true)
		// Rollback restored the exact pre-apply snapshot order.
		expect(host.ids()).toEqual(snapshot)
	})

	// 5. apply-failed rollback, recovered:false.
	// Pin: same mid-apply failure, but the rollback calls ALSO throw (host fully
	// dying) → CommitError{apply-failed, applied:'partial', recovered:false}.
	// Native order is "untrusted" here, so we assert only the error fields.
	it('mid-apply failure whose rollback also fails throws CommitError(apply-failed, partial, recovered:false)', () => {
		const host = makeFlakyHost()
		const c = createCompositor(host)
		c.mount(ref('a'))
		c.mount(ref('b'))
		c.mount(ref('c'))
		c.commit()
		expect(host.ids()).toEqual(['a', 'b', 'c'])

		c.reorder('a', { before: null })
		c.mount(ref('d'))

		// Every native call throws — the forward apply fails AND so does rollback.
		host.failAll()

		let thrown: unknown
		try {
			c.commit()
		} catch (e) {
			thrown = e
		}
		expect(thrown).toBeInstanceOf(CommitError)
		const err = thrown as CommitErrorShape
		expect(err.kind).toBe('apply-failed')
		expect(err.applied).toBe('partial')
		expect(err.recovered).toBe(false)
	})

	// 6. success regression guard: a normal live commit still returns void and
	// produces the exact target order (the transactional wrapper didn't perturb
	// the happy path).
	it('a normal commit on a live host still returns void and produces the target order', () => {
		const host = makeHost()
		const c = createCompositor(host)
		c.mount(ref('a'))
		c.mount(ref('b'))
		c.mount(ref('c'))
		const result = c.commit()
		expect(result).toBeUndefined()
		expect(host.ids()).toEqual(['a', 'b', 'c'])

		// A subsequent reorder commit also lands cleanly.
		c.reorder('a', { before: null })
		expect(c.commit()).toBeUndefined()
		expect(host.ids()).toEqual(['b', 'c', 'a'])
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// 11. detachAll — fold to EMPTY + commit (Part 1; ViewHandle increment 1)
//     [TDD red: `detachAll` is not implemented on the compositor yet.]
//
// Contract: `detachAll()` folds the intent state to EMPTY and commits, so every
// native view this window's compositor mounted is removed from the host. Because
// the resulting commit is REMOVALS-ONLY, it reuses A1.2.1's teardown-friendly
// "destroyed host + only removals → silent" path: on an already-destroyed host
// it makes zero host calls and throws nothing.
// ─────────────────────────────────────────────────────────────────────────────
describe('detachAll — folds to empty + commit (teardown-friendly)', () => {
  // a) mount 3 + commit (host has 3) → detachAll() → host empty.
  it('removes every mounted view from the host', () => {
    const host = makeHost()
    const c = createCompositor(host)
    c.mount(ref('a'))
    c.mount(ref('b'))
    c.mount(ref('c'))
    c.commit()
    expect(host.ids()).toEqual(['a', 'b', 'c'])

    c.detachAll()
    // Intent folded to empty and committed: the host has no children left.
    expect(host.children()).toEqual([])
    expect(host.ids()).toEqual([])
  })

  // b) detachAll() with nothing mounted → no-op, no throw.
  it('is a no-op on a host with nothing mounted', () => {
    const host = makeHost()
    const c = createCompositor(host)

    const start = host.calls.length
    expect(() => c.detachAll()).not.toThrow()
    // Nothing to remove → zero host calls, host stays empty.
    expect(host.calls.slice(start)).toEqual([])
    expect(host.children()).toEqual([])
  })

  // c) detachAll() on a DESTROYED host with views mounted → silent (no throw).
  it('is silent on a destroyed host (teardown-friendly removals-only path)', () => {
    const host = makeHost()
    const c = createCompositor(host)
    // Mount + commit on a LIVE host so native actually has children.
    c.mount(ref('a'))
    c.mount(ref('b'))
    c.commit()
    expect(host.ids()).toEqual(['a', 'b'])

    const start = host.calls.length
    host.setDestroyed(true) // contentView torn down; its views died with it
    // detachAll's commit is removals-only → the destroyed-host removals-only
    // path returns silently (no CommitError, no native call).
    expect(() => c.detachAll()).not.toThrow()
    expect(host.calls.slice(start)).toEqual([])
  })
})
