/**
 * ControlBus — a thin, domain-neutral facade over the existing
 * {@link WireTransport} + {@link EventBus} + an injectable refcount
 * {@link TrustSet}.
 *
 * Three verbs, no new gating logic of its own:
 *
 *  - `command(name, handler)` : webview → main RPC. The facade owns the single
 *    command table and exposes {@link ControlBus.dispatch}; the wire's
 *    `invokeHost` (and `invokeSimulator`) seam calls `dispatch(name, args)` so a
 *    real webview→main invoke (after the wire's sender + main-frame gate) lands on
 *    the registered handler. Callers never see the wire `kind`. Trust + main-frame
 *    gating are entirely the wire's (`handleInvoke`): a trusted main-frame sender
 *    reaches the handler, an untrusted sender → `DECK_UNTRUSTED_SENDER`, a
 *    sub-frame → `DECK_UNTRUSTED_FRAME`.
 *  - `event(name)` : main → webview push, default-deny. `name` is added to the
 *    declared-event allowlist the wire reads; `publish` goes through `bus.publish`
 *    → wire fanout (undeclared names are dropped by the wire). `dispose` revokes
 *    the declaration.
 *  - `trust(wc, owner)` : delegates to `trustSet.admit` (refcount membership owned
 *    by `owner` Scope, so the lease is released when the owner tears down).
 *
 * Real wiring (Bug C): the command table is the SOLE command authority. The
 * production caller builds the {@link WireTransport} with
 * `invokeHost = (name, args) => controlBus.dispatch(name, args)` (and the same
 * for `invokeSimulator`, since the facade hides the kind), and `declaredEvents`
 * reading {@link ControlBus.declaredEvents}. So a real IPC invoke reaches the
 * command handler through the wire — not a private test-only seam. Any
 * config-declared host services register into this SAME table via `command()`,
 * so there is one namespace (the host keeps names unique), never two registries
 * that can collide.
 *
 * @internal exported via `/host`.
 */

import { DeckRemoteError } from '../errors.js'
import type { Disposable, JsonValue } from '../types.js'
import type { EventBus } from '../internal/event-bus.js'
import { DECK_CODE } from '../internal/wire-transport.js'
import type { InvokeCtx, MinimalWebContents, WireTransport } from '../internal/wire-transport.js'
import type { TrustSet } from '../internal/trust-set.js'
import type { Scope } from '../main/scope.js'
import type { CapabilityPolicy } from './capability.js'

export type { TrustSet }
export { createTrustSet } from '../internal/trust-set.js'

type CommandHandler = (...args: JsonValue[]) => JsonValue | Promise<JsonValue>

export interface ControlBusEventHandle<P extends JsonValue> {
	publish(payload: P): void
	dispose(): void
}

export interface ControlBus {
	/** Register a webview → main RPC handler under a domain-neutral `name`. */
	command(name: string, handler: CommandHandler): Disposable
	/** Declare a main → webview push event (default-deny allowlist). */
	event<P extends JsonValue>(name: string): ControlBusEventHandle<P>
	/** Admit a webContents into the refcount trust set, owned by `owner` Scope
	 *  (the lease is released when `owner` resets/closes). */
	trust(wc: MinimalWebContents, owner: Scope): Disposable
	/**
	 * Real wire entry point — the {@link WireTransport}'s `invokeHost` /
	 * `invokeSimulator` seam calls this with a domain-neutral `name` AFTER its
	 * trust + main-frame gate. Resolves the command table; throws if `name` is
	 * unregistered (the wire serialises that into an `InvokeFailure`). `ctx`
	 * carries the gated senderId (Phase B's grant gate reads it; Phase A passes
	 * it through unused).
	 */
	dispatch(name: string, args: readonly JsonValue[], ctx: InvokeCtx): Promise<JsonValue>
	/**
	 * Current declared-event allowlist snapshot — the wire's `declaredEvents`
	 * seam reads this (lazy, per publish) so default-deny tracks `event()` /
	 * `dispose()` in real time.
	 */
	declaredEvents(): readonly string[]
}

export interface CreateControlBusDeps {
	/**
	 * Vestigial — the facade never calls into the wire from inside `dispatch` /
	 * `command` / `event` / `trust` (the wire is the one that calls `dispatch`,
	 * not the reverse). Made OPTIONAL so deck-app can construct the ControlBus
	 * BEFORE the WireTransport (which references the ControlBus from its
	 * `invokeHost` seam) — no circular dependency at construction time.
	 */
	readonly transport?: WireTransport
	readonly bus: EventBus
	readonly trustSet: TrustSet
	/**
	 * P4 Phase B — privileged-command grant gate. When provided, `dispatch`
	 * default-DENIES any command not authorized by a live grant for the gated
	 * `ctx.senderId`. Omitted → no gate (backward-compatible "trusted may
	 * dispatch" behaviour).
	 */
	readonly policy?: CapabilityPolicy
}

export function createControlBus(deps: CreateControlBusDeps): ControlBus {
	const { bus, trustSet, policy } = deps
	// The facade owns the single command table + declared-event set. The wire
	// resolves invokes through `dispatch()` and reads the allowlist through
	// `declaredEvents()` — no shared mutable Map handed across the boundary.
	const commandRegistry = new Map<string, CommandHandler>()
	const declaredEventSet = new Set<string>()

	return {
		command(name: string, handler: CommandHandler): Disposable {
			// Last-writer-wins, but dispose only unregisters if still the live owner —
			// a re-register under the same name must not be clobbered by a stale dispose.
			commandRegistry.set(name, handler)
			let disposed = false
			return {
				dispose: () => {
					if (disposed) return
					disposed = true
					if (commandRegistry.get(name) === handler) {
						commandRegistry.delete(name)
					}
				},
			}
		},

		event<P extends JsonValue>(name: string): ControlBusEventHandle<P> {
			declaredEventSet.add(name)
			let disposed = false
			return {
				publish: (payload: P) => {
					// Always route through the bus; the wire drops it if `name` is no
					// longer declared (default-deny), so a disposed handle can't fan out.
					bus.publish(name, payload as JsonValue)
				},
				dispose: () => {
					if (disposed) return
					disposed = true
					declaredEventSet.delete(name)
				},
			}
		},

		trust(wc: MinimalWebContents, owner: Scope): Disposable {
			return trustSet.admit(wc, owner)
		},

		async dispatch(name: string, args: readonly JsonValue[], ctx: InvokeCtx): Promise<JsonValue> {
			const handler = commandRegistry.get(name)
			if (!handler) {
				throw new Error(`no command registered: ${name}`)
			}
			// P4 Phase B — grant gate (A5-1.4). After resolving the command but
			// BEFORE running it, default-DENY any command the sender lacks a live
			// grant for. No policy injected → no gate (backward compatible).
			if (policy && !policy.allows(ctx.senderId, name)) {
				throw new DeckRemoteError(name, `forbidden: ${name}`, DECK_CODE.Forbidden)
			}
			return handler(...(args as JsonValue[]))
		},

		declaredEvents(): readonly string[] {
			return Array.from(declaredEventSet)
		},
	}
}
