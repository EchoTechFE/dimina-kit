/**
 * trust-set.test.ts — P2 SEALED trust writer.
 *
 * REWRITTEN for the sealed contract (P2). The previous (would-be) coverage
 * exercised the PUBLIC `add(wc)` writer and the `InternalTrustSet.deleteEntry`
 * escape hatch. Those are GONE: a caller may no longer mint an un-owned trust
 * lease (`add`) nor imperatively wipe an entry (`deleteEntry`). The single write
 * gate is now `admit(wc, owner)`, which binds the refcount-- to the `owner`
 * Scope so trust lifetime FOLLOWS the owner — and returns a one-shot host-facing
 * Disposable that releases just that lease early.
 *
 * Coverage parity vs. the old surface:
 *  - old `add(wc)` refcount++/one-shot dispose      → now `admit(...)` + handle.dispose()
 *  - old refcount-2 / dispose-one-still-trusted     → preserved via two admits
 *  - old isTrusted-by-`.id`                         → preserved (test 7)
 *  - old snapshot live-keys fanout                  → preserved (test 8)
 *  - old `deleteEntry` imperative wipe              → REPLACED by owner-scope close
 *  - NEW: trust lifetime follows the owner Scope    → tests 2, 5, 6
 *  - NEW: `add`/`deleteEntry` are sealed off type   → test 9 (@ts-expect-error)
 */
import { describe, it, expect } from 'vitest'
import { createTrustSet } from './trust-set.js'
import { createScope } from '../main/scope.js'
import type { MinimalWebContents } from './wire-transport.js'

/** Minimal fake wc matching the existing deck-app fixture shape. */
function makeWc(id: number): MinimalWebContents {
	return {
		id,
		isDestroyed: () => false,
		send: () => {},
	}
}

describe('trust-set — sealed admit(wc, owner) writer', () => {
	// 1 — admit makes the wc trusted and present in the snapshot.
	it('admit(wc, scope) → isTrusted(wc.id) true and snapshot contains wc', () => {
		const ts = createTrustSet()
		const scope = createScope()
		const wc = makeWc(11)

		ts.admit(wc, scope)

		expect(ts.isTrusted(11)).toBe(true)
		expect(ts.snapshot()).toContain(wc)
	})

	// 2 — KEY NEW CONTRACT: trust lifetime follows the owner Scope. Closing the
	// owner releases the lease automatically (no host-side dispose call).
	it('closing the owner scope releases the lease → untrusted, snapshot empty', async () => {
		const ts = createTrustSet()
		const scope = createScope()
		const wc = makeWc(12)

		ts.admit(wc, scope)
		expect(ts.isTrusted(12)).toBe(true)

		await scope.close()

		expect(ts.isTrusted(12)).toBe(false)
		expect(ts.snapshot()).toHaveLength(0)
	})

	// 3 — the returned host-facing handle releases JUST this lease early; with a
	// single admit that drops the refcount to 0 and the wc becomes untrusted.
	it('returned disposable.dispose() releases the lease early (single admit → untrusted)', () => {
		const ts = createTrustSet()
		const scope = createScope()
		const wc = makeWc(13)

		const lease = ts.admit(wc, scope)
		expect(ts.isTrusted(13)).toBe(true)

		lease.dispose()

		expect(ts.isTrusted(13)).toBe(false)
		expect(ts.snapshot()).not.toContain(wc)
	})

	// 4 — refcount 2 via two admits of the SAME wc under the SAME scope. Dispose
	// ONE handle → still trusted (one lease remains). Close the scope → BOTH
	// released → untrusted, with NO double-decrement: disposing the already-freed
	// handle a THIRD time after close is a safe no-op (no throw).
	it('two admits (refcount 2): dispose one → still trusted; close → untrusted; third dispose is a safe no-op', async () => {
		const ts = createTrustSet()
		const scope = createScope()
		const wc = makeWc(14)

		const leaseA = ts.admit(wc, scope)
		ts.admit(wc, scope)
		expect(ts.isTrusted(14)).toBe(true)

		// Drop one of the two leases early — the other still holds trust.
		leaseA.dispose()
		expect(ts.isTrusted(14)).toBe(true)

		// Owner close releases everything it owns (the remaining lease, plus the
		// already-disposed first lease's owned decrement — which must be a no-op).
		await scope.close()
		expect(ts.isTrusted(14)).toBe(false)

		// Releasing the stale handle yet again must not throw nor mis-decrement a
		// (now absent) entry — idempotent no-op.
		expect(() => leaseA.dispose()).not.toThrow()
		expect(ts.isTrusted(14)).toBe(false)
	})

	// 5 — two DIFFERENT wcs admitted under the SAME scope: both trusted; closing
	// the one owner releases both.
	it('admit two different wcs under the same scope → both trusted; scope.close → both untrusted', async () => {
		const ts = createTrustSet()
		const scope = createScope()
		const wcA = makeWc(21)
		const wcB = makeWc(22)

		ts.admit(wcA, scope)
		ts.admit(wcB, scope)
		expect(ts.isTrusted(21)).toBe(true)
		expect(ts.isTrusted(22)).toBe(true)

		await scope.close()

		expect(ts.isTrusted(21)).toBe(false)
		expect(ts.isTrusted(22)).toBe(false)
		expect(ts.snapshot()).toHaveLength(0)
	})

	// 6 — same wc admitted under TWO different owner scopes (refcount 2): closing
	// owner A leaves it trusted (owner B's lease holds); closing B releases it.
	it('same wc under two scopes: close A → still trusted; close B → untrusted', async () => {
		const ts = createTrustSet()
		const scopeA = createScope()
		const scopeB = createScope()
		const wc = makeWc(31)

		ts.admit(wc, scopeA)
		ts.admit(wc, scopeB)
		expect(ts.isTrusted(31)).toBe(true)

		await scopeA.close()
		expect(ts.isTrusted(31)).toBe(true)

		await scopeB.close()
		expect(ts.isTrusted(31)).toBe(false)
		expect(ts.snapshot()).not.toContain(wc)
	})

	// 7 — isTrusted matches by `.id`, not object identity: a DIFFERENT wc object
	// carrying the same id reads trusted while a live entry exists (preserves the
	// old test's intent).
	it('isTrusted(id) matches by `.id` — a same-id sibling reads trusted while a live entry exists', () => {
		const ts = createTrustSet()
		const scope = createScope()
		const admitted = makeWc(42)
		const sameIdSibling = makeWc(42)

		ts.admit(admitted, scope)

		// Distinct object, identical id → still reads trusted via the id match.
		expect(admitted).not.toBe(sameIdSibling)
		expect(ts.isTrusted(sameIdSibling.id)).toBe(true)
	})

	// 8 — snapshot returns the live keys (used for event fanout).
	it('snapshot() returns the live keys for fanout', () => {
		const ts = createTrustSet()
		const scope = createScope()
		const wcA = makeWc(51)
		const wcB = makeWc(52)

		ts.admit(wcA, scope)
		ts.admit(wcB, scope)

		const snap = ts.snapshot()
		expect(snap).toContain(wcA)
		expect(snap).toContain(wcB)
		expect(snap).toHaveLength(2)
	})

	// 9 — SEALING GUARD (type-level). The returned trust set is admit-capable but
	// the old imperative writers `add` / `deleteEntry` must NOT be members of the
	// type. The @ts-expect-error directives below fail to compile if either is
	// ever re-exposed, locking the seal in place.
	it('seals off add / deleteEntry (type-level guard)', () => {
		const ts = createTrustSet()
		// @ts-expect-error add is sealed — no public un-owned lease minting.
		expect(ts.add).toBeUndefined()
		// @ts-expect-error deleteEntry is sealed — no imperative entry wipe.
		expect(ts.deleteEntry).toBeUndefined()
	})
})
