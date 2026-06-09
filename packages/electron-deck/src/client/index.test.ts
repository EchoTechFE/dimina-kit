/**
 * Phase 3a contract tests for `createDeckClient()` + `readBridgeFromGlobal()`.
 *
 * Source-of-truth referenced (and only these):
 *   - `src/shared/protocol.ts` (DeckBridge, envelope shapes, version)
 *   - `src/errors.ts` (DeckClientNotReadyError, DeckRemoteError)
 *   - `src/client/index.ts` JSDoc on DeckClient + createDeckClient
 *
 * The client only talks to whatever the bridge global exposes. So instead of
 * mocking `electron`, we install a fake `DeckBridge` directly onto
 * `globalThis[<globalName>]`, matching what `contextBridge.exposeInMainWorld`
 * would do at runtime.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	DeckClientNotReadyError,
	DeckRemoteError,
} from '../errors.js'
import { defineEvent } from '../events.js'
import {
	BRIDGE_PROTOCOL_VERSION,
	DEFAULT_BRIDGE_GLOBAL,
} from '../shared/protocol.js'
import type {
	EventEnvelope,
	InvokeRequest,
	InvokeResponse,
	ProbeResponse,
	DeckBridge,
} from '../shared/protocol.js'
import type { JsonValue } from '../types.js'
import {
	createDeckClient,
	readBridgeFromGlobal,
} from './index.js'

// ── fake bridge ──────────────────────────────────────────────────────────

interface FakeBridge extends DeckBridge {
	invokeCalls: InvokeRequest[]
	emit(env: EventEnvelope): void
	listeners: Set<(env: EventEnvelope) => void>
}

interface FakeBridgeOptions {
	version?: string
	invokeImpl?: (req: InvokeRequest) => Promise<InvokeResponse>
	probeImpl?: () => Promise<ProbeResponse>
}

function makeFakeBridge(opts: FakeBridgeOptions = {}): FakeBridge {
	const invokeCalls: InvokeRequest[] = []
	const listeners = new Set<(env: EventEnvelope) => void>()
	const bridge: FakeBridge = {
		// `version` typing on DeckBridge narrows to the literal constant,
		// but the cast lets tests inject a mismatched version on purpose.
		version: (opts.version ?? BRIDGE_PROTOCOL_VERSION) as typeof BRIDGE_PROTOCOL_VERSION,
		invokeCalls,
		listeners,
		probe: opts.probeImpl ?? (async () => ({ ready: true, version: BRIDGE_PROTOCOL_VERSION })),
		invoke: async (req) => {
			invokeCalls.push(req)
			if (opts.invokeImpl) return opts.invokeImpl(req)
			return { ok: true, result: null }
		},
		onEvent: (listener) => {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		emit(env) {
			for (const l of [...listeners]) l(env)
		},
	}
	return bridge
}

function installBridge(bridge: DeckBridge, name = DEFAULT_BRIDGE_GLOBAL): void {
	;(globalThis as unknown as Record<string, unknown>)[name] = bridge
}

function uninstallBridge(name = DEFAULT_BRIDGE_GLOBAL): void {
	delete (globalThis as unknown as Record<string, unknown>)[name]
}

afterEach(() => {
	// Conservatively scrub any names tests might have used.
	uninstallBridge()
	uninstallBridge('__custom_bridge')
	uninstallBridge('__alt')
	uninstallBridge('__bad_ver')
})

// ── readBridgeFromGlobal ─────────────────────────────────────────────────

describe('readBridgeFromGlobal()', () => {
	it('returns undefined when no bridge is installed', () => {
		expect(readBridgeFromGlobal()).toBeUndefined()
	})

	it('returns the bridge object when one is installed at the default name', () => {
		const fake = makeFakeBridge()
		installBridge(fake)
		expect(readBridgeFromGlobal()).toBe(fake)
	})

	it('respects a custom global name', () => {
		const fake = makeFakeBridge()
		installBridge(fake, '__custom_bridge')
		expect(readBridgeFromGlobal('__custom_bridge')).toBe(fake)
		expect(readBridgeFromGlobal()).toBeUndefined()
	})

	it('does not perform shape validation — that is ready()s job', () => {
		// Install an object that does NOT match the bridge contract.
		;(globalThis as unknown as Record<string, unknown>)[DEFAULT_BRIDGE_GLOBAL] = {
			not: 'a real bridge',
		}
		// Should still return the value as-is; validation is deferred.
		expect(readBridgeFromGlobal()).toEqual({ not: 'a real bridge' })
	})
})

// ── createDeckClient: ready() ───────────────────────────────────────

describe('createDeckClient.ready()', () => {
	it('rejects with DeckClientNotReadyError when bridge is missing', async () => {
		const client = createDeckClient()
		await expect(client.ready()).rejects.toBeInstanceOf(
			DeckClientNotReadyError,
		)
	})

	it('resolves to undefined when a matching-version bridge is installed', async () => {
		installBridge(makeFakeBridge())
		const client = createDeckClient()
		await expect(client.ready()).resolves.toBeUndefined()
	})

	it('uses the configured globalName option', async () => {
		installBridge(makeFakeBridge(), '__custom_bridge')
		const client = createDeckClient({ globalName: '__custom_bridge' })
		await expect(client.ready()).resolves.toBeUndefined()
	})

	it('rejects with DeckClientNotReadyError on major version mismatch', async () => {
		// Construct a v2.x.x bridge — major mismatch with the current v1.
		installBridge(makeFakeBridge({ version: '2.0.0' }))
		const client = createDeckClient()
		await expect(client.ready()).rejects.toBeInstanceOf(
			DeckClientNotReadyError,
		)
	})

	it('mismatch error message mentions both expected and actual version', async () => {
		installBridge(makeFakeBridge({ version: '2.5.0' }))
		const client = createDeckClient()
		try {
			await client.ready()
			throw new Error('ready() should have rejected')
		}
		catch (err) {
			expect(err).toBeInstanceOf(DeckClientNotReadyError)
			const msg = (err as Error).message
			// Expected and actual major versions should both appear so devs can
			// diagnose preload/client version skew.
			expect(msg).toContain('2.5.0')
			expect(msg).toContain(BRIDGE_PROTOCOL_VERSION)
		}
	})
})

// ── createDeckClient: invoke() ──────────────────────────────────────

// Demo host services use real-world typed signatures (named params, narrow
// return types). With the relaxed `(...args: any[]) => unknown` constraint
// `Parameters<HS[K]>` infers the exact tuple — so `client.invoke('add', 2, 3)`
// is type-checked at the call site, and `(p: { code: string }) => ...` style
// handlers also assign cleanly (previously blocked by the JsonValue index
// signature). Cross-process payload safety is owned by the wire envelope
// (`InvokeRequest.args: readonly JsonValue[]`) and any handler-side validator,
// not by this constraint.
interface DemoHostServices {
	ping: () => Promise<string>
	add: (a: number, b: number) => Promise<number>
	login: (p: { code: string }) => Promise<{ userId: string }>
	boom: () => Promise<never>
}

type NoEvents = readonly []

describe('createDeckClient.invoke()', () => {
	it('forwards to bridge.invoke with kind="host", name, and args', async () => {
		const bridge = makeFakeBridge({
			invokeImpl: async (req) => {
				if (req.name === 'add') {
					const [a, b] = req.args as [number, number]
					return { ok: true, result: a + b }
				}
				return { ok: true, result: null }
			},
		})
		installBridge(bridge)
		const client = createDeckClient<DemoHostServices, NoEvents>()
		await client.ready()
		const result = await client.invoke('add', 2, 3)
		expect(result).toBe(5)
		expect(bridge.invokeCalls).toEqual([
			{ kind: 'host', name: 'add', args: [2, 3] },
		])
	})

	it('resolves with response.result on ok=true', async () => {
		installBridge(
			makeFakeBridge({
				invokeImpl: async () => ({ ok: true, result: 'pong' }),
			}),
		)
		const client = createDeckClient<DemoHostServices, NoEvents>()
		await client.ready()
		await expect(client.invoke('ping')).resolves.toBe('pong')
	})

	it('rejects with DeckRemoteError on ok=false', async () => {
		installBridge(
			makeFakeBridge({
				invokeImpl: async () => ({
					ok: false,
					error: { remoteName: 'host:boom', message: 'kaboom' },
				}),
			}),
		)
		const client = createDeckClient<DemoHostServices, NoEvents>()
		await client.ready()
		await expect(client.invoke('boom')).rejects.toBeInstanceOf(DeckRemoteError)
	})

	it('DeckRemoteError carries remoteName + message + code', async () => {
		installBridge(
			makeFakeBridge({
				invokeImpl: async () => ({
					ok: false,
					error: { remoteName: 'host:boom', message: 'kaboom', code: 'E_BOOM' },
				}),
			}),
		)
		const client = createDeckClient<DemoHostServices, NoEvents>()
		await client.ready()
		try {
			await client.invoke('boom')
			throw new Error('should have rejected')
		}
		catch (err) {
			expect(err).toBeInstanceOf(DeckRemoteError)
			const e = err as DeckRemoteError
			expect(e.remoteName).toBe('host:boom')
			expect(e.message).toBe('kaboom')
			expect(e.code).toBe('E_BOOM')
		}
	})

	it('omits code when failure envelope did not carry one', async () => {
		installBridge(
			makeFakeBridge({
				invokeImpl: async () => ({
					ok: false,
					error: { remoteName: 'host:x', message: 'nope' },
				}),
			}),
		)
		const client = createDeckClient<DemoHostServices, NoEvents>()
		await client.ready()
		try {
			await client.invoke('boom')
			throw new Error('should have rejected')
		}
		catch (err) {
			expect((err as DeckRemoteError).code).toBeUndefined()
		}
	})

	it('throws / rejects DeckClientNotReadyError when bridge is absent', async () => {
		// CONTRACT-AMBIGUOUS: DeckClient JSDoc does not state whether
		// invoke() pre-ready must throw vs queue. We pick the strict
		// interpretation — no bridge means no possible IPC channel, so
		// invoke() surfaces a `DeckClientNotReadyError` (matching the
		// same error type ready() uses for the missing-bridge case). This is
		// the safest contract for the implementer; relax later if needed.
		const client = createDeckClient<DemoHostServices, NoEvents>()
		const result = client.invoke('ping')
		// invoke() returns a Promise per the typed signature; the failure must
		// surface on that promise, regardless of whether it was thrown sync.
		await expect(Promise.resolve(result)).rejects.toBeInstanceOf(
			DeckClientNotReadyError,
		)
	})
})

// ── createDeckClient: on() ──────────────────────────────────────────

describe('createDeckClient.on()', () => {
	it('subscribes via bridge.onEvent and filters by event.name', async () => {
		const bridge = makeFakeBridge()
		installBridge(bridge)
		const targetEvent = defineEvent<{ x: number }>('demo.target')
		const otherEvent = defineEvent<{ y: number }>('demo.other')
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const events = [targetEvent, otherEvent] as const
		const client = createDeckClient<DemoHostServices, typeof events>()
		await client.ready()

		const received: { x: number }[] = []
		client.on(targetEvent, (payload) => received.push(payload))

		// Emit an envelope matching the target event:
		bridge.emit({ name: 'demo.target', payload: { x: 42 } })
		// And one for a different event name — must NOT be delivered:
		bridge.emit({ name: 'demo.other', payload: { y: 99 } })

		expect(received).toEqual([{ x: 42 }])
	})

	it('returns a Disposable with a dispose() method', () => {
		installBridge(makeFakeBridge())
		const targetEvent = defineEvent<{ x: number }>('demo.shape')
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const events = [targetEvent] as const
		const client = createDeckClient<DemoHostServices, typeof events>()
		const sub = client.on(targetEvent, () => {})
		expect(sub).toBeDefined()
		expect(typeof sub.dispose).toBe('function')
	})

	it('dispose() removes the underlying bridge subscription', async () => {
		const bridge = makeFakeBridge()
		installBridge(bridge)
		const ev = defineEvent<JsonValue>('demo.dispose')
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const events = [ev] as const
		const client = createDeckClient<DemoHostServices, typeof events>()
		await client.ready()

		const seen: JsonValue[] = []
		const sub = client.on(ev, (payload) => seen.push(payload))
		bridge.emit({ name: 'demo.dispose', payload: 'first' })
		sub.dispose()
		bridge.emit({ name: 'demo.dispose', payload: 'second' })
		expect(seen).toEqual(['first'])
		// After dispose, the bridge should hold no client listeners for this
		// subscription. We assert listener count went back to 0.
		expect(bridge.listeners.size).toBe(0)
	})

	it('multiple on() calls register independent listeners', async () => {
		const bridge = makeFakeBridge()
		installBridge(bridge)
		const ev = defineEvent<JsonValue>('demo.multi')
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const events = [ev] as const
		const client = createDeckClient<DemoHostServices, typeof events>()
		await client.ready()

		const a: JsonValue[] = []
		const b: JsonValue[] = []
		client.on(ev, (p) => a.push(p))
		client.on(ev, (p) => b.push(p))
		bridge.emit({ name: 'demo.multi', payload: 'hello' })
		expect(a).toEqual(['hello'])
		expect(b).toEqual(['hello'])
	})

	it('disposing one subscription leaves siblings active', async () => {
		const bridge = makeFakeBridge()
		installBridge(bridge)
		const ev = defineEvent<JsonValue>('demo.partial')
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const events = [ev] as const
		const client = createDeckClient<DemoHostServices, typeof events>()
		await client.ready()

		const a: JsonValue[] = []
		const b: JsonValue[] = []
		const subA = client.on(ev, (p) => a.push(p))
		client.on(ev, (p) => b.push(p))
		subA.dispose()
		bridge.emit({ name: 'demo.partial', payload: 'after' })
		expect(a).toEqual([])
		expect(b).toEqual(['after'])
	})

	it('rejects / throws DeckClientNotReadyError when bridge is absent', () => {
		// CONTRACT-AMBIGUOUS: same reasoning as the invoke() pre-ready test.
		// JSDoc does not specify pre-ready on() semantics; the strict reading
		// is that without a bridge no real subscription can be made, so on()
		// throws synchronously with a DeckClientNotReadyError.
		const ev = defineEvent<JsonValue>('demo.no-bridge')
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const events = [ev] as const
		const client = createDeckClient<DemoHostServices, typeof events>()
		expect(() => client.on(ev, () => {})).toThrow(DeckClientNotReadyError)
	})
})

// ── unused-symbol guard (keeps imports honest even if a test is skipped) ─
// vitest does not run this, but importing `vi` ensures the symbol is reachable
// in case future tests want to spy on a method.
void vi
