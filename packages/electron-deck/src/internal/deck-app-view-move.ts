import type { MinimalBrowserWindow, MinimalWebContentsView } from './electron-types.js'
import type { ViewSubstrate } from './deck-app.js'

/**
 * `DeckViewHandle.moveTo` failure cleanup. `inner.moveTo` does the atomic
 * native Compositor migration + Scope adopt/rollback; when it rejects, the
 * Compositor's own rollback only reverts state it TRACKED (`order`) — a
 * native `addChildView` that throws MID-APPLY can leave the WCV attached to
 * the dest window's `contentView` with no tracked record to remove it. This
 * balances that leak with an explicit dest detach, then undoes the dest
 * substrate registration made before the move attempt.
 *
 * Each step is independently guarded (its own try/catch) so a cleanup
 * failure in one step never masks the other step or the ORIGINAL move
 * error — `originalErr` is always rethrown, never shadowed.
 */
export function cleanupDestOnMoveToFailure(
	destWin: MinimalBrowserWindow,
	destSub: ViewSubstrate,
	wcv: MinimalWebContentsView,
	viewId: string,
	originalErr: unknown,
): never {
	try {
		// Only remove when the WCV is a KNOWN child, or membership is UNKNOWN
		// (`children` absent → can't verify, but a leaked mid-apply add must
		// still be detached; removeChildView of a non-child is a no-op in real
		// Electron). Check isDestroyed() first: reading `.contentView` on an
		// already-destroyed dest window throws, and a dead dest window's native
		// child is gone anyway — nothing to detach.
		if (!destWin.isDestroyed()) {
			const destChildren = destWin.contentView.children
			const maybeAttached = destChildren == null || destChildren.includes(wcv)
			if (maybeAttached) {
				destWin.contentView.removeChildView(wcv)
			}
		}
	}
	catch (cleanupErr) {
		console.error('[electron-deck] moveTo dest detach failed (original error rethrown):', cleanupErr)
	}
	try {
		// ALWAYS undo the dest registration so the dest substrate never tracks a
		// view it doesn't host — independent of the detach above.
		destSub.unregisterView(viewId)
	}
	catch (cleanupErr) {
		console.error('[electron-deck] moveTo dest unregister failed (original error rethrown):', cleanupErr)
	}
	throw originalErr
}
