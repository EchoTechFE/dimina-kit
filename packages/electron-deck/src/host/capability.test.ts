import { describe, expect, it } from 'vitest'
import { createScope, type Scope } from '../main/scope.js'
import {
	createCapabilityRegistry,
	type Grant,
} from './capability.js'

/**
 * Capability grant gate (policy + grant lifetime).
 *
 * Source of truth: the CONTRACT. These tests pin the `createCapabilityRegistry`
 * / `Grant` contract exported from `./capability.js`. They use the REAL
 * `createScope()` for senderScope and
 * targetScope so the lifetime-binding semantics (reset/close → revoke) are
 * exercised against the production Scope primitive, not a fake.
 *
 * Default-DENY is the spine of the contract: a command is allowed for a sender
 * ONLY while a live grant naming that command (exact, whitelisted) is bound to
 * that exact senderId, and the grant dies the instant its senderScope generation
 * ends (navigation soft-reuse = reset, window destroy = close, or early dispose).
 */
describe('capability — CapabilityPolicy + grant set', () => {
	function grant(
		senderId: number,
		commands: string[],
		senderScope: Scope,
		targetScope: Scope,
	): Grant {
		return {
			senderId,
			senderScope,
			targetScope,
			commands: new Set(commands),
		}
	}

	// a) whitelist + exact-match + senderId-match
	it('a live grant allows exactly its commands for exactly its senderId (whitelist, exact match)', () => {
		const senderScope = createScope()
		const targetScope = createScope()
		const { policy, issue } = createCapabilityRegistry()
		issue(grant(1, ['layout.resize'], senderScope, targetScope))

		expect(policy.allows(1, 'layout.resize')).toBe(true)
		// non-listed command on the right sender → DENY (whitelist, exact match)
		expect(policy.allows(1, 'other')).toBe(false)
		// listed command on a DIFFERENT sender → DENY (senderId match required)
		expect(policy.allows(2, 'layout.resize')).toBe(false)
	})

	// b) default-DENY
	it('with no grants issued, allows() is false for anything (default-DENY)', () => {
		const { policy } = createCapabilityRegistry()
		expect(policy.allows(1, 'layout.resize')).toBe(false)
		expect(policy.allows(0, '')).toBe(false)
		expect(policy.allows(999, 'anything.at.all')).toBe(false)
	})

	// c) senderScope.reset() revokes (navigation soft-reuse drops authorization)
	it('senderScope.reset() revokes the grant (navigation soft-reuse drops authorization)', async () => {
		const senderScope = createScope()
		const targetScope = createScope()
		const { policy, issue } = createCapabilityRegistry()
		issue(grant(1, ['layout.resize'], senderScope, targetScope))
		expect(policy.allows(1, 'layout.resize')).toBe(true)

		await senderScope.reset()

		expect(policy.allows(1, 'layout.resize')).toBe(false)
	})

	// d) senderScope.close() revokes (window destroy drops authorization)
	it('senderScope.close() revokes the grant (window destroy drops authorization)', async () => {
		const senderScope = createScope()
		const targetScope = createScope()
		const { policy, issue } = createCapabilityRegistry()
		issue(grant(1, ['layout.resize'], senderScope, targetScope))
		expect(policy.allows(1, 'layout.resize')).toBe(true)

		await senderScope.close()

		expect(policy.allows(1, 'layout.resize')).toBe(false)
	})

	// e) early dispose + double-dispose no-op + close-after-dispose does not throw
	it('the issue() Disposable revokes early, double-dispose is a no-op, and a later close does not throw', async () => {
		const senderScope = createScope()
		const targetScope = createScope()
		const { policy, issue } = createCapabilityRegistry()
		const d = issue(grant(1, ['layout.resize'], senderScope, targetScope))
		expect(policy.allows(1, 'layout.resize')).toBe(true)

		d.dispose()
		expect(policy.allows(1, 'layout.resize')).toBe(false)

		// disposing twice is a safe no-op (no throw, stays revoked)
		expect(() => d.dispose()).not.toThrow()
		expect(policy.allows(1, 'layout.resize')).toBe(false)

		// after a manual dispose, a later senderScope.close() must not throw
		// (the revoke subscription was already torn down cleanly).
		await expect(senderScope.close()).resolves.toBeUndefined()
		expect(policy.allows(1, 'layout.resize')).toBe(false)
	})

	// f) two grants for one senderId union; revoking one leaves the other
	it('two grants for the same senderId union their commands; revoking one keeps the other', async () => {
		const targetScope = createScope()
		const scopeA = createScope()
		const scopeB = createScope()
		const { policy, issue } = createCapabilityRegistry()
		issue(grant(1, ['layout.resize'], scopeA, targetScope))
		issue(grant(1, ['view.focus'], scopeB, targetScope))

		// union: both commands allowed for the shared senderId
		expect(policy.allows(1, 'layout.resize')).toBe(true)
		expect(policy.allows(1, 'view.focus')).toBe(true)

		// revoke ONE grant (its scope dies) → only its commands drop
		await scopeA.close()
		expect(policy.allows(1, 'layout.resize')).toBe(false)
		expect(policy.allows(1, 'view.focus')).toBe(true)
	})

	// g) wc.id-reuse safety: a re-issued grant for the same senderId does not
	//    inherit the old grant, and the old (closed) scope's revoke does not kill
	//    the new grant bound to a fresh scope.
	it('wc.id-reuse safety: a closed-then-reissued senderId gets only the new grant commands', async () => {
		const targetScope = createScope()
		const scopeA = createScope()
		const scopeB = createScope()
		const { policy, issue } = createCapabilityRegistry()

		issue(grant(5, ['old.cmd'], scopeA, targetScope))
		expect(policy.allows(5, 'old.cmd')).toBe(true)

		// scopeA dies (wc destroyed) → old grant revoked
		await scopeA.close()
		expect(policy.allows(5, 'old.cmd')).toBe(false)

		// same wc.id (5) reused for a NEW webContents bound to a DIFFERENT scope
		// with DIFFERENT commands.
		issue(grant(5, ['new.cmd'], scopeB, targetScope))

		// new grant does NOT inherit the old command…
		expect(policy.allows(5, 'old.cmd')).toBe(false)
		// …and the new command IS allowed (closed scopeA's revoke didn't reap it).
		expect(policy.allows(5, 'new.cmd')).toBe(true)
	})
})
