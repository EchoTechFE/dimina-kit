/**
 * P4 Phase B — ControlBus grant gate (A5-1.4).
 *
 * Added by the Phase B implementer (flagged): pins that when a `policy` is
 * injected into `createControlBus`, `dispatch` default-DENIES a command the
 * sender lacks a live grant for — throwing a `DeckRemoteError` carrying
 * `DECK_FORBIDDEN` (the wire serialises that into an InvokeFailure) — and that an
 * allowed sender reaches the handler. The bug this catches: a privileged command
 * running for a trusted-but-ungranted sender (the gate being absent or wired
 * before the command-table lookup so an unknown name leaks `DECK_FORBIDDEN`
 * instead of "no command registered").
 */

import { describe, expect, it, vi } from 'vitest'
import { DeckRemoteError } from '../errors.js'
import { EventBus } from '../internal/event-bus.js'
import type { InvokeCtx, WireTransport } from '../internal/wire-transport.js'
import { createControlBus } from './control-bus.js'
import { createTrustSet } from '../internal/trust-set.js'
import type { CapabilityPolicy } from './capability.js'

const CTX: InvokeCtx = { senderId: 1, senderFrame: null }

function makeBus(policy: CapabilityPolicy) {
	// The grant gate path never touches the transport; a stub suffices.
	const transport = {} as unknown as WireTransport
	return createControlBus({ transport, bus: new EventBus(), trustSet: createTrustSet(), policy })
}

describe('ControlBus — grant gate (Phase B)', () => {
	it('policy.allows=false → dispatch rejects with a DeckRemoteError carrying DECK_FORBIDDEN; handler NOT run', async () => {
		const handler = vi.fn(() => 'ran' as const)
		const policy: CapabilityPolicy = { allows: () => false }
		const bus = makeBus(policy)
		bus.command('layout.x', handler)

		await expect(bus.dispatch('layout.x', [], CTX)).rejects.toMatchObject({
			name: 'DeckRemoteError',
			code: 'DECK_FORBIDDEN',
		})
		await expect(bus.dispatch('layout.x', [], CTX)).rejects.toBeInstanceOf(DeckRemoteError)
		expect(handler).not.toHaveBeenCalled()
	})

	it('policy.allows=true → handler runs and its value is returned', async () => {
		const handler = vi.fn(() => 'ran' as const)
		const policy: CapabilityPolicy = { allows: () => true }
		const bus = makeBus(policy)
		bus.command('layout.x', handler)

		await expect(bus.dispatch('layout.x', [], CTX)).resolves.toBe('ran')
		expect(handler).toHaveBeenCalledTimes(1)
	})
})
