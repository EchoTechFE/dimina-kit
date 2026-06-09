/**
 * Contract + real-wire tests for ControlBus, a thin domain-neutral facade over
 * the existing `WireTransport` + `EventBus` + an injectable refcount `TrustSet`.
 *
 * Target: `src/host/control-bus.ts`,
 *   export function createControlBus(deps): ControlBus
 *
 * Contract (pinned by these assertions):
 *
 *   interface ControlBus {
 *     command(name, handler): Disposable
 *     event<P>(name): { publish(payload): void; dispose(): void }
 *     trust(wc): Disposable
 *     dispatch(name, args): Promise<JsonValue>        // wire invoke entry point
 *     declaredEvents(): readonly string[]             // wire allowlist seam
 *   }
 *   createControlBus(deps: {
 *     transport: WireTransport
 *     bus: EventBus
 *     trustSet: { add(wc): Disposable; isTrusted(id): boolean; snapshot(): MinimalWebContents[] }
 *   }): ControlBus
 *
 * Three verbs, zero capability authorization this wave:
 *  - command : webview → main RPC. Reuses the wire's sender-id + main-frame
 *              gate; the facade maps the domain-neutral `name` onto the wire's
 *              internal `kind` (callers never see 'host'/'simulator').
 *  - event   : main → webview push, default-deny allowlist (only names passed
 *              to event() fan out).
 *  - trust   : refcount trust set membership; gates which webContents can issue
 *              commands AND which receive events.
 *
 * REAL WIRING (Bug C): the facade owns NO new gating logic — it delegates trust
 * to the injected `trustSet` and routing/frame checks to the real
 * `WireTransport`. These tests construct a REAL `WireTransport` whose invoke
 * seams (`invokeHost` / `invokeSimulator`) forward to the live
 * `controlBus.dispatch`, and whose `declaredEvents` seam reads
 * `controlBus.declaredEvents()` — exactly how production assembles them. There is
 * NO shared mutable registry handed across the boundary: a real
 * `ipcMain.handle(invoke)` call drives the wire's `handleInvoke` → (gate) →
 * `dispatch` → the registered handler.
 */

import { describe, expect, it, vi } from 'vitest'
import { DeckChannel } from '../shared/protocol.js'
import type { Disposable, JsonValue, SenderPolicy } from '../types.js'
import { EventBus } from '../internal/event-bus.js'
import type {
	InvokeCtx,
	MinimalIpcMain,
	MinimalWebContents,
} from '../internal/wire-transport.js'
import { WireTransport } from '../internal/wire-transport.js'
import { createControlBus } from './control-bus.js'
import { createScope, type Scope } from '../main/scope.js'

// ── facade contract surface (mirrors ./control-bus.ts exports) ──

type ControlBusDisposable = Disposable
interface ControlBusEventHandle<P extends JsonValue> {
	publish(payload: P): void
	dispose(): void
}
interface ControlBus {
	command(
		name: string,
		handler: (...args: JsonValue[]) => JsonValue | Promise<JsonValue>,
	): ControlBusDisposable
	event<P extends JsonValue>(name: string): ControlBusEventHandle<P>
	trust(wc: MinimalWebContents, owner: Scope): ControlBusDisposable
	dispatch(name: string, args: readonly JsonValue[], ctx: InvokeCtx): Promise<JsonValue>
	declaredEvents(): readonly string[]
}

/**
 * Minimal refcount trust set the facade depends on. Recommended shape extracted
 * from deck-app's `trustedWcRefs` (Map<wc, refcount>) — see report.
 */
interface TrustSet {
	admit(wc: MinimalWebContents, owner: Scope): Disposable
	isTrusted(id: number): boolean
	snapshot(): readonly MinimalWebContents[]
}

interface CreateControlBusDeps {
	transport: WireTransport
	bus: EventBus
	trustSet: TrustSet
}

// The facade's public type is structurally the same as the locally-declared
// `ControlBus` interface above; cast keeps the harness decoupled from the
// module's exact exported alias.
const makeControlBus = createControlBus as unknown as (
	deps: CreateControlBusDeps,
) => ControlBus

// ── fakes (same stub style as wire-transport.test.ts / event-bus.test.ts) ──

type InvokeHandler = (
	event: {
		sender: { id: number, mainFrame?: { routingId: number, processId: number } | null }
		senderFrame?: { routingId: number, processId: number } | null
	},
	...args: unknown[]
) => unknown | Promise<unknown>

interface FakeIpcMain extends MinimalIpcMain {
	handle: ReturnType<typeof vi.fn> & MinimalIpcMain['handle']
	removeHandler: ReturnType<typeof vi.fn> & MinimalIpcMain['removeHandler']
	handlers: Map<string, InvokeHandler>
}

function createFakeIpcMain(): FakeIpcMain {
	const handlers = new Map<string, InvokeHandler>()
	const handle = vi.fn((channel: string, handler: InvokeHandler) => {
		handlers.set(channel, handler)
	}) as FakeIpcMain['handle']
	const removeHandler = vi.fn((channel: string) => {
		handlers.delete(channel)
	}) as FakeIpcMain['removeHandler']
	return { handle, removeHandler, handlers }
}

interface FakeWebContents extends MinimalWebContents {
	send: ReturnType<typeof vi.fn> & MinimalWebContents['send']
	destroyed: boolean
}

function createFakeWebContents(id: number, opts: { destroyed?: boolean } = {}): FakeWebContents {
	const wc: FakeWebContents = {
		id,
		destroyed: opts.destroyed ?? false,
		isDestroyed() {
			return wc.destroyed
		},
		send: vi.fn() as FakeWebContents['send'],
	}
	return wc
}

/**
 * Fake SEALED refcount TrustSet — mirrors the real `createTrustSet()` semantics:
 * admit(wc, owner) increments and OWNS the refcount-- on `owner`; the returned
 * one-shot Disposable decrements early (idempotent per handle), entry removed
 * when refcount hits zero. isTrusted(id) / snapshot() read live.
 */
function createFakeTrustSet(): TrustSet & { refs: Map<MinimalWebContents, number> } {
	const refs = new Map<MinimalWebContents, number>()
	return {
		refs,
		admit(wc: MinimalWebContents, owner: Scope): Disposable {
			refs.set(wc, (refs.get(wc) ?? 0) + 1)
			let disposed = false
			const raw: Disposable = {
				dispose: () => {
					if (disposed) return
					disposed = true
					const c = refs.get(wc)
					if (c === undefined) return
					if (c <= 1) refs.delete(wc)
					else refs.set(wc, c - 1)
				},
			}
			const lease = owner.own(raw)
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

/**
 * Build the real wire + facade the way production `createControlBus` is
 * expected to: the wire's gating seams delegate to the injected `trustSet`, and
 * the wire's `invokeHost` / `declaredEvents` route through facade-owned
 * registries. We expose those registries to the harness ONLY so the test can
 * point the wire deps at them — the facade is what fills them (via command() /
 * event()). The facade must NOT re-implement trust/frame gating: it reuses the
 * wire's `handleInvoke` path entirely.
 *
 * NOTE: the facade hides the wire `kind`. The wire's BOTH invoke seams
 * (`invokeHost` + `invokeSimulator`) forward to the live `controlBus.dispatch`,
 * so whichever single kind the facade maps `command` onto reaches the handler
 * through the real `handleInvoke` path.
 */
interface Wiring {
	controlBus: ControlBus
	ipcMain: FakeIpcMain
	bus: EventBus
	trustSet: ReturnType<typeof createFakeTrustSet>
	transport: WireTransport
	/** A real owner Scope for trust leases (the sealed admit forces an owner). */
	owner: Scope
	getInvokeHandler: () => InvokeHandler
	/** invoke through the wire as a trusted main-frame sender with the given id */
	invokeAsTrusted: (id: number, name: string, args: JsonValue[]) => Promise<unknown>
	/** invoke through the wire as a sub-frame (sender id trusted, frame != main) */
	invokeAsSubFrame: (id: number, name: string, args: JsonValue[]) => Promise<unknown>
}

const MAIN_FRAME = { routingId: 1, processId: 1 }
const SUB_FRAME = { routingId: 2, processId: 1 }

async function setup(): Promise<Wiring> {
	const ipcMain = createFakeIpcMain()
	const bus = new EventBus()
	const trustSet = createFakeTrustSet()
	const owner = createScope()

	// REAL WIRING — no shared mutable registry. The wire's invoke seams forward to
	// the live facade's `dispatch`, and its allowlist seam reads the facade's
	// `declaredEvents()`. The facade owns BOTH tables internally; the only thing
	// crossing the boundary is the function call (just like production). The
	// `ref` holder breaks the construction cycle: the transport closures capture
	// `ref` and the facade is slotted into `ref.bus` right after the transport is
	// built.
	const ref: { bus: ControlBus | null } = { bus: null }

	const senderPolicy: SenderPolicy = { isTrusted: id => trustSet.isTrusted(id) }

	const transport = new WireTransport({
		ipcMain,
		bus,
		senderPolicy,
		trustedWebContents: () => trustSet.snapshot(),
		// The facade hides the wire `kind`; point BOTH kind resolvers at the single
		// `dispatch` so whichever kind the facade maps `command` onto is exercised.
		invokeHost: (name, args, ctx) => ref.bus!.dispatch(name, args, ctx),
		invokeSimulator: (name, args, ctx) => ref.bus!.dispatch(name, args, ctx),
		declaredEvents: () => ref.bus!.declaredEvents(),
	})

	const controlBus = makeControlBus({ transport, bus, trustSet })
	ref.bus = controlBus

	transport.start()

	const getInvokeHandler = (): InvokeHandler => {
		const h = ipcMain.handlers.get(DeckChannel.Invoke)
		if (!h) throw new Error('invoke handler not registered')
		return h
	}

	return {
		controlBus,
		ipcMain,
		bus,
		trustSet,
		transport,
		owner,
		getInvokeHandler,
		invokeAsTrusted: (id, name, args) =>
			Promise.resolve(getInvokeHandler()(
				{ sender: { id, mainFrame: MAIN_FRAME }, senderFrame: MAIN_FRAME },
				{ kind: 'host', name, args },
			)),
		invokeAsSubFrame: (id, name, args) =>
			Promise.resolve(getInvokeHandler()(
				{ sender: { id, mainFrame: MAIN_FRAME }, senderFrame: SUB_FRAME },
				{ kind: 'host', name, args },
			)),
	}
}

// ── 1. command routing + trust ───────────────────────────────────────────

describe('ControlBus — command(): routing + trust gate', () => {
	it('trusted main-frame sender → handler invoked, return value propagated', async () => {
		const w = await setup()
		const handler = vi.fn((...args: JsonValue[]) => ({ echoed: args }) as JsonValue)
		w.controlBus.command('foo', handler)

		const wc = createFakeWebContents(7)
		w.controlBus.trust(wc, w.owner)

		const res = (await w.invokeAsTrusted(7, 'foo', [1, 2])) as
			| { ok: true, result: JsonValue }
			| { ok: false, error: { code?: string } }
		expect(res.ok).toBe(true)
		expect(handler).toHaveBeenCalledTimes(1)
		expect(handler).toHaveBeenCalledWith(1, 2)
		expect((res as { ok: true, result: JsonValue }).result).toEqual({ echoed: [1, 2] })
	})

	it('untrusted sender → rejected with DECK_UNTRUSTED_SENDER; handler NOT called', async () => {
		const w = await setup()
		const handler = vi.fn(() => null as JsonValue)
		w.controlBus.command('foo', handler)
		// note: never trust wc id=99

		const res = (await w.invokeAsTrusted(99, 'foo', [])) as
			{ ok: false, error: { code?: string } }
		expect(res.ok).toBe(false)
		expect(res.error.code).toBe('DECK_UNTRUSTED_SENDER')
		expect(handler).not.toHaveBeenCalled()
	})

	it('sub-frame of a trusted sender → rejected with DECK_UNTRUSTED_FRAME; handler NOT called', async () => {
		const w = await setup()
		const handler = vi.fn(() => null as JsonValue)
		w.controlBus.command('foo', handler)

		const wc = createFakeWebContents(7)
		w.controlBus.trust(wc, w.owner)

		const res = (await w.invokeAsSubFrame(7, 'foo', [])) as
			{ ok: false, error: { code?: string } }
		expect(res.ok).toBe(false)
		expect(res.error.code).toBe('DECK_UNTRUSTED_FRAME')
		expect(handler).not.toHaveBeenCalled()
	})
})

// ── 2. command returns a Disposable ───────────────────────────────────────

describe('ControlBus — command(): disposal', () => {
	it('disposing the command unregisters it — handler no longer invoked', async () => {
		const w = await setup()
		const handler = vi.fn(() => 'ok' as JsonValue)
		const sub = w.controlBus.command('foo', handler)

		const wc = createFakeWebContents(7)
		w.controlBus.trust(wc, w.owner)

		await w.invokeAsTrusted(7, 'foo', [])
		expect(handler).toHaveBeenCalledTimes(1)

		sub.dispose()

		const res = (await w.invokeAsTrusted(7, 'foo', [])) as
			| { ok: true }
			| { ok: false, error: { code?: string } }
		// After dispose the command must not reach the handler again.
		expect(handler).toHaveBeenCalledTimes(1)
		expect(res.ok).toBe(false)
	})
})

// ── 3. command is domain-neutral (no kind leakage) ────────────────────────

describe('ControlBus — command(): domain-neutral surface', () => {
	it('command() takes only (name, handler) — no host/simulator kind in the call', async () => {
		const w = await setup()
		// The facade signature must be (name, handler); passing a 3rd "kind" arg is
		// not part of the contract. We assert by registering with just name+handler
		// and confirming it routes — i.e. the facade supplies the kind internally.
		const handler = vi.fn(() => 'neutral' as JsonValue)
		const sub = w.controlBus.command('plainName', handler)
		expect(typeof sub.dispose).toBe('function')

		const wc = createFakeWebContents(7)
		w.controlBus.trust(wc, w.owner)

		const res = (await w.invokeAsTrusted(7, 'plainName', [])) as
			{ ok: true, result: JsonValue }
		expect(res.ok).toBe(true)
		expect(res.result).toBe('neutral')
		expect(handler).toHaveBeenCalledTimes(1)
	})

	it('ControlBus surface exposes no host/simulator kind verbs (only command/event/trust)', async () => {
		const w = await setup()
		const keys = Object.keys(w.controlBus as unknown as Record<string, unknown>)
		expect(keys).not.toContain('host')
		expect(keys).not.toContain('simulator')
		expect(typeof w.controlBus.command).toBe('function')
		expect(typeof w.controlBus.event).toBe('function')
		expect(typeof w.controlBus.trust).toBe('function')
	})
})

// ── 4. event allowlist (default-deny) ─────────────────────────────────────

describe('ControlBus — event(): declared allowlist', () => {
	it('event(name).publish fans out to trusted webContents via wire event channel', async () => {
		const w = await setup()
		const wc = createFakeWebContents(7) as FakeWebContents
		w.controlBus.trust(wc, w.owner)

		const ev = w.controlBus.event<{ x: number }>('e1')
		ev.publish({ x: 1 })

		expect(wc.send).toHaveBeenCalledTimes(1)
		expect(wc.send).toHaveBeenCalledWith(DeckChannel.Event, {
			name: 'e1',
			payload: { x: 1 },
		})
	})

	it('publishing on a name that was never declared via event() does NOT fan out (default-deny)', async () => {
		const w = await setup()
		const wc = createFakeWebContents(7) as FakeWebContents
		w.controlBus.trust(wc, w.owner)

		// declare a different event so the allowlist is non-empty
		w.controlBus.event('declared')
		// publish an UNDECLARED name straight on the bus → must be dropped by wire
		w.bus.publish('undeclared', { x: 1 })

		expect(wc.send).not.toHaveBeenCalled()
	})

	it('event().dispose() revokes the declaration — subsequent publish no longer fans out', async () => {
		const w = await setup()
		const wc = createFakeWebContents(7) as FakeWebContents
		w.controlBus.trust(wc, w.owner)

		const ev = w.controlBus.event<{ x: number }>('e1')
		ev.publish({ x: 1 })
		expect(wc.send).toHaveBeenCalledTimes(1)

		ev.dispose()
		ev.publish({ x: 2 })
		// dispose removed it from the allowlist → no further send
		expect(wc.send).toHaveBeenCalledTimes(1)
	})
})

// ── 5. trust(wc): refcount membership ─────────────────────────────────────

describe('ControlBus — trust(): refcount membership', () => {
	it('trust(wc) admits the wc — its commands become reachable', async () => {
		const w = await setup()
		const handler = vi.fn(() => 'ok' as JsonValue)
		w.controlBus.command('foo', handler)

		const wc = createFakeWebContents(7)
		// before trust: rejected
		const before = (await w.invokeAsTrusted(7, 'foo', [])) as { ok: false, error: { code?: string } }
		expect(before.ok).toBe(false)
		expect(before.error.code).toBe('DECK_UNTRUSTED_SENDER')

		// after trust: reachable
		w.controlBus.trust(wc, w.owner)
		const after = (await w.invokeAsTrusted(7, 'foo', [])) as { ok: true }
		expect(after.ok).toBe(true)
		expect(handler).toHaveBeenCalledTimes(1)
	})

	it('disposing trust removes the wc — its commands are rejected again', async () => {
		const w = await setup()
		const handler = vi.fn(() => 'ok' as JsonValue)
		w.controlBus.command('foo', handler)

		const wc = createFakeWebContents(7)
		const sub = w.controlBus.trust(wc, w.owner)
		expect(((await w.invokeAsTrusted(7, 'foo', [])) as { ok: boolean }).ok).toBe(true)

		sub.dispose()
		const res = (await w.invokeAsTrusted(7, 'foo', [])) as { ok: false, error: { code?: string } }
		expect(res.ok).toBe(false)
		expect(res.error.code).toBe('DECK_UNTRUSTED_SENDER')
	})

	it('refcount: trusting the same wc twice requires TWO disposes to fully untrust', async () => {
		const w = await setup()
		const handler = vi.fn(() => 'ok' as JsonValue)
		w.controlBus.command('foo', handler)

		const wc = createFakeWebContents(7)
		const subA = w.controlBus.trust(wc, w.owner)
		const subB = w.controlBus.trust(wc, w.owner)

		// one dispose → still trusted (refcount 1 remaining)
		subA.dispose()
		const stillTrusted = (await w.invokeAsTrusted(7, 'foo', [])) as { ok: boolean }
		expect(stillTrusted.ok).toBe(true)

		// second dispose → fully untrusted
		subB.dispose()
		const nowUntrusted = (await w.invokeAsTrusted(7, 'foo', [])) as { ok: false, error: { code?: string } }
		expect(nowUntrusted.ok).toBe(false)
		expect(nowUntrusted.error.code).toBe('DECK_UNTRUSTED_SENDER')
	})

	it('event push only reaches trusted webContents (untrusted wc receives nothing)', async () => {
		const w = await setup()
		const trustedWc = createFakeWebContents(7) as FakeWebContents
		const strangerWc = createFakeWebContents(8) as FakeWebContents
		w.controlBus.trust(trustedWc, w.owner)
		// strangerWc deliberately NOT trusted → not in trustSet.snapshot()

		const ev = w.controlBus.event<{ x: number }>('e1')
		ev.publish({ x: 1 })

		expect(trustedWc.send).toHaveBeenCalledTimes(1)
		expect(strangerWc.send).not.toHaveBeenCalled()
	})
})

// ── 6. real wire wiring (Bug C regression) ────────────────────────────────
//
// Pins that a command registered on the facade is reached — and its return value
// round-tripped — through the REAL `ipcMain.handle(invoke)` handler the wire
// registers, NOT a private test-only registry. The invoke handler is obtained
// from `ipcMain.handlers` (whatever the wire actually registered) and driven with
// a trusted main-frame sender envelope, the same shape Electron delivers. If the
// facade ever stops feeding the wire's `invokeHost`/`invokeSimulator` seam (the
// original disconnection), this fails because the handler can't resolve the name.

describe('ControlBus — real wire wiring (Bug C)', () => {
	it('command reached via the real ipcMain invoke handler; async return value propagated back over the wire', async () => {
		const w = await setup()
		const handler = vi.fn(async (a: JsonValue, b: JsonValue) => {
			// async handler → exercises the wire awaiting dispatch()
			await Promise.resolve()
			return { sum: (a as number) + (b as number) } as JsonValue
		})
		w.controlBus.command('add', handler)

		const wc = createFakeWebContents(7)
		w.controlBus.trust(wc, w.owner)

		// Drive the ACTUAL handler the wire registered on ipcMain (not dispatch()).
		const invoke = w.ipcMain.handlers.get(DeckChannel.Invoke)
		expect(invoke).toBeTypeOf('function')
		const res = (await Promise.resolve(
			invoke!(
				{ sender: { id: 7, mainFrame: MAIN_FRAME }, senderFrame: MAIN_FRAME },
				{ kind: 'host', name: 'add', args: [2, 3] },
			),
		)) as { ok: true, result: JsonValue } | { ok: false, error: { code?: string } }

		expect(res.ok).toBe(true)
		expect((res as { ok: true, result: JsonValue }).result).toEqual({ sum: 5 })
		expect(handler).toHaveBeenCalledWith(2, 3)
	})

	it('unregistered command over the real wire → InvokeFailure (handler throws, wire serialises it)', async () => {
		const w = await setup()
		const wc = createFakeWebContents(7)
		w.controlBus.trust(wc, w.owner)

		const res = (await w.invokeAsTrusted(7, 'nope', [])) as
			{ ok: false, error: { message?: string } }
		expect(res.ok).toBe(false)
		expect(res.error.message).toContain('no command registered: nope')
	})

	it('declaredEvents() drives the wire allowlist live — declare then dispose flips fanout', async () => {
		const w = await setup()
		const wc = createFakeWebContents(7) as FakeWebContents
		w.controlBus.trust(wc, w.owner)

		// Not yet declared → wire drops it.
		w.bus.publish('live', { x: 0 })
		expect(wc.send).not.toHaveBeenCalled()

		const ev = w.controlBus.event<{ x: number }>('live')
		ev.publish({ x: 1 })
		expect(wc.send).toHaveBeenCalledTimes(1)

		ev.dispose()
		ev.publish({ x: 2 })
		expect(wc.send).toHaveBeenCalledTimes(1)
	})
})
