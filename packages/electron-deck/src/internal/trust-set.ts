/**
 * TrustSet — SEALED refcount membership of trusted webContents.
 *
 * Refcount membership (Map<wc, refcount>) factored into a standalone primitive
 * so it can back both `DeckApp` and the
 * domain-neutral `ControlBus` facade.
 *
 * SEALED WRITE MODEL: there is exactly ONE writer — `admit(wc, owner)`. It forces
 * every trust lease to be OWNED by a `Scope`, so a lease can never outlive its
 * owner and no un-owned / leaked lease is possible. The old public `add(wc)`
 * (un-owned lease minting) and the `deleteEntry(wc)` imperative wipe are GONE:
 *   - releasing a lease early → use the Disposable `admit` returns;
 *   - releasing ALL of an owner's leases → close/reset that owner Scope (the
 *     refcount-- disposers are owned by it, so its teardown zeroes them).
 *
 * Semantics (unchanged refcount core):
 * - `admit(wc, owner)` increments the wc's refcount and owns the matching
 *   refcount-- on `owner`; the entry is removed when the count reaches zero.
 * - `isTrusted(id)` is true iff any live entry's `.id === id`.
 * - `snapshot()` returns the live keys (used for event fanout).
 *
 * Idempotency note: each refcount-- disposer is one-shot and guarded by a
 * `c === undefined` check — disposing a handle after the entry has already been
 * dropped (e.g. via the owner's teardown) reads `refs.get(wc)`, sees `undefined`,
 * and returns without touching the map, so a residual handle can never resurrect
 * or mis-decrement a re-added entry.
 *
 * @internal
 */

import type { Disposable } from '../types.js'
import type { MinimalWebContents } from './wire-transport.js'
import type { Scope } from '../main/scope.js'

/** Read-only trust index (gate + fanout). No write surface. */
export interface TrustIndex {
	/** true iff some live entry's `.id === id`. */
	isTrusted(id: number): boolean
	/** live keys, for event fanout. */
	snapshot(): readonly MinimalWebContents[]
}

/** Admit-capable trust set. The ONLY writer is `admit`, which forces an owner
 *  Scope so a trust lease can never outlive its owner (no un-owned lease). */
export interface TrustSet extends TrustIndex {
	/**
	 * Admit `wc` to the trust set (refcount++). The refcount-- release is OWNED by
	 * `owner` (so `owner.reset()`/`close()` releases it automatically). Returns a
	 * one-shot Disposable that releases JUST this lease early (idempotent; never
	 * double-decrements, and a later `owner` teardown over an already-released
	 * lease is a safe no-op via the refs-undefined guard).
	 */
	admit(wc: MinimalWebContents, owner: Scope): Disposable
}

export function createTrustSet(): TrustSet {
	const refs = new Map<MinimalWebContents, number>()
	return {
		admit(wc: MinimalWebContents, owner: Scope): Disposable {
			const cur = refs.get(wc) ?? 0
			refs.set(wc, cur + 1)
			let disposed = false
			// Raw refcount-- disposable (the former `add` body). One-shot + the
			// `c === undefined` guard keeps it safe across owner teardown / stale handles.
			const rawDisposable: Disposable = {
				dispose: () => {
					if (disposed) return
					disposed = true
					const c = refs.get(wc)
					if (c === undefined) return
					if (c <= 1) refs.delete(wc)
					else refs.set(wc, c - 1)
				},
			}
			// Owner owns the refcount-- so its reset()/close() releases this lease.
			const lease = owner.own(rawDisposable)
			let released = false
			return {
				dispose: () => {
					if (released) return
					released = true
					lease.dispose()
				},
			}
		},
		isTrusted(id: number): boolean {
			for (const wc of refs.keys()) {
				if (wc.id === id) return true
			}
			return false
		},
		snapshot(): readonly MinimalWebContents[] {
			return Array.from(refs.keys())
		},
	}
}
