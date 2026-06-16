/**
 * Observable layout model — single-writer, synchronous, call-ordered.
 *
 * INV-3: mutations assume an already-validated (acyclic, integrity-checked) tree
 * — callers feeding hand-built trees should parseLayout/validateTree first.
 *
 * Conventions (pinned by model.test.ts):
 *  - revision starts at 0 for the initial tree.
 *  - subscribe() does NOT replay; first emission is on the first successful
 *    apply, carrying revision 1.
 *  - +1 per successful apply; a throwing mutation does NOT advance revision and
 *    does NOT notify (the throw propagates to the caller).
 */
import type { LayoutModel, LayoutSnapshot, LayoutTree } from './types.js'

export function createLayoutModel(initial: LayoutTree): LayoutModel {
	// Own the initial tree: take a structural snapshot so a later external mutation
	// of the caller's `initial` object can't leak into model state. The tree is
	// readonly-typed / treated as immutable, so a deep clone is the cheapest
	// correct ownership stance. (The `next` from each apply is already a fresh tree
	// produced by the pure mutations, so it needs no further clone.)
	let current: LayoutTree = structuredClone(initial)
	let revision = 0
	const subscribers = new Set<(snap: LayoutSnapshot) => void>()

	// Re-entrancy guard: a subscriber may call apply() during notification. We
	// must not re-enter and bump `revision` mid-delivery (subscribers would then
	// observe a non-monotonic sequence). Instead, enqueue and drain FIFO so each
	// apply fully commits + notifies before the next begins.
	let applying = false
	const queue: ((t: LayoutTree) => LayoutTree)[] = []

	const commitAndNotify = (mut: (t: LayoutTree) => LayoutTree): void => {
		// Compute first; if it throws, nothing below runs — revision stays put
		// and no subscriber is notified.
		const next = mut(current)
		current = next
		revision += 1
		const snap: LayoutSnapshot = { tree: current, revision }
		// Snapshot the subscriber set so unsubscribe during delivery is safe.
		// Isolate subscriber errors: a throw from one must not abort delivery to
		// the rest, nor make apply() throw after a committed state. The model's
		// job is delivery, not subscriber correctness — swallow and continue.
		for (const fn of [...subscribers]) {
			try {
				fn(snap)
			}
			catch {
				// intentionally swallowed — see above.
			}
		}
	}

	return {
		get(): LayoutTree {
			return current
		},
		/**
		 * `mut` MUST be pure (clone-on-write); the built-in mutations satisfy this.
		 */
		apply(mut: (t: LayoutTree) => LayoutTree): void {
			if (applying) {
				// Re-entrant call (a subscriber applied during notification): queue it
				// and let the in-flight drain pass process it after the current pass.
				queue.push(mut)
				return
			}
			applying = true
			try {
				// Top-level (non-re-entrant) apply: a throw here propagates to the
				// caller and does NOT advance revision / notify. (`finally` below
				// still resets `applying`, so a throw can't wedge the model.)
				commitAndNotify(mut)
				// Drain re-entrant mutations enqueued during notification. Each queued
				// apply was deferred and is therefore fire-and-forget: its original
				// caller already returned, so it cannot deliver a synchronous throw
				// back. Run each as an INDEPENDENT transaction — a throw skips that
				// item (no revision bump, no notify) and we continue draining the rest
				// in FIFO order. This keeps a thrown queued mut from bubbling into the
				// already-committed outer apply() and from disrupting the order /
				// processing of later queued items.
				while (queue.length > 0) {
					const queuedMut = queue.shift()!
					try {
						commitAndNotify(queuedMut)
					}
					catch {
						// Deferred apply: swallow + continue — see above.
					}
				}
			}
			finally {
				applying = false
			}
		},
		subscribe(fn: (snap: LayoutSnapshot) => void): () => void {
			subscribers.add(fn)
			return (): void => {
				subscribers.delete(fn)
			}
		},
	}
}
