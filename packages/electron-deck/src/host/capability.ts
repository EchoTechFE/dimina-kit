/**
 * Capability grant registry — P4 Phase B.
 *
 * Default-DENY authorization for privileged control commands. A command is
 * allowed for a sender ONLY while a LIVE grant naming that command (exact,
 * whitelisted) is bound to that exact senderId. A grant dies the instant its
 * `senderScope` generation ends: navigation soft-reuse (`reset`), window
 * destroy (`closed`), or early `dispose()`.
 *
 * Each grant is a DISTINCT object stored in a Set, so two grants for the same
 * senderId union their commands, and revoking one (its `senderScope` died)
 * never touches another grant for that same senderId. The per-grant `revoked`
 * guard makes a closed scope's revoke a no-op against a newly-issued grant —
 * the wc.id-reuse safety property.
 *
 * @internal exported via `/host`.
 */

import type { Disposable } from '../types.js'
import type { Scope } from '../main/scope.js'

export interface Grant {
	readonly senderId: number
	/** grant lifetime — revoked on this scope's reset/closed. */
	readonly senderScope: Scope
	/**
	 * OPTIONAL — stored as the authorization boundary for FUTURE per-target
	 * view-command checks; the current grant gate authorizes by (senderId,
	 * command-name) only — no command resolves a target view yet, so targetScope is
	 * not consulted at dispatch. Reserved.
	 */
	readonly targetScope?: Scope
	readonly commands: ReadonlySet<string>
}

export interface CapabilityPolicy {
	/** true iff a LIVE grant exists with grant.senderId === senderId AND name ∈ grant.commands. default-DENY. */
	allows(senderId: number, name: string): boolean
}

export function createCapabilityRegistry(): {
	policy: CapabilityPolicy
	issue(grant: Grant): Disposable
	/**
	 * Synchronously revoke EVERY live grant whose `grant.senderId === senderId`.
	 * Mirrors the trust path's synchronous window-'closed' revocation so a grant
	 * is gone the instant a wc is destroyed — before the async wcScope cascade
	 * fires `'closed'`. This closes the wc.id-reuse privilege-escalation window
	 * (a reused wc.id can never inherit the old, not-yet-revoked grant). Each
	 * per-grant `revoke` is idempotent, so the later async `'closed'` is a no-op.
	 */
	revokeBySenderId(senderId: number): void
} {
	// Track each grant WITH its revoke fn so the registry can revoke by senderId
	// synchronously (bulk), independent of the per-grant scope listeners.
	const entries = new Set<{ grant: Grant, revoke: () => void }>()
	return {
		policy: {
			allows(senderId, name) {
				for (const e of entries) {
					if (e.grant.senderId === senderId && e.grant.commands.has(name)) return true
				}
				return false
			},
		},
		issue(grant) {
			let revoked = false
			const off1 = grant.senderScope.on('reset', () => revoke())
			const off2 = grant.senderScope.on('closed', () => revoke())
			function revoke() {
				if (revoked) return
				revoked = true
				entries.delete(entry)
				off1.dispose()
				off2.dispose()
			}
			const entry = { grant, revoke }
			entries.add(entry)
			return { dispose: revoke }
		},
		revokeBySenderId(senderId) {
			// Snapshot the matching entries first to avoid mutate-during-iterate
			// (each revoke deletes its own entry); each revoke is idempotent.
			const matching: Array<{ grant: Grant, revoke: () => void }> = []
			for (const e of entries) {
				if (e.grant.senderId === senderId) matching.push(e)
			}
			for (const e of matching) e.revoke()
		},
	}
}
