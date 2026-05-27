/**
 * Phase 3a contract tests for `exposeWorkbenchBridge()` (preload-side entry).
 *
 * These tests intentionally avoid reaching into Phase 1/2 implementation files
 * or the long-form workbench-model.md doc. The behaviour contract is taken
 * exclusively from:
 *   - `src/shared/protocol.ts` (channel names + envelope shapes + WorkbenchBridge interface)
 *   - the JSDoc on `exposeWorkbenchBridge()` in `src/preload/index.ts`
 *
 * Strategy:
 *   - mock the `electron` module so the preload-only `contextBridge` /
 *     `ipcRenderer` imports resolve under node test env
 *   - capture every `exposeInMainWorld` call to assert (a) collision
 *     diagnostics and (b) bridge shape conformance
 *   - hoist all mock state into vi.hoisted so the vi.mock factory can reach it
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	BRIDGE_PROTOCOL_VERSION,
	DEFAULT_BRIDGE_GLOBAL,
	WorkbenchChannel,
} from '../shared/protocol.js'
import type {
	EventEnvelope,
	InvokeRequest,
	InvokeResponse,
	WorkbenchBridge,
} from '../shared/protocol.js'

// vi.mock is hoisted, so any state it touches must be declared via vi.hoisted.
// The mock fns themselves are created at hoist time (NOT lazily in the factory)
// so the test setup can call `.mockClear()` on them even when the SUT throws
// before it ever imports `electron`.
const mocks = vi.hoisted(() => {
	type IpcListener = (event: unknown, ...args: unknown[]) => void
	type InvokeHandler = (...args: unknown[]) => unknown
	const exposed = new Map<string, unknown>()
	const ipcListeners = new Map<string, Set<IpcListener>>()
	const state = { invokeImpl: null as InvokeHandler | null }

	const exposeInMainWorld = vi.fn((name: string, api: unknown) => {
		if (exposed.has(name)) {
			throw new Error(`Cannot bind an api on the contextBridge: "${name}"`)
		}
		exposed.set(name, api)
		;(globalThis as unknown as Record<string, unknown>)[name] = api
	})
	const ipcInvoke = vi.fn(async (channel: string, ...args: unknown[]) => {
		if (state.invokeImpl == null) {
			throw new Error(`No mock ipcRenderer.invoke handler set for channel "${channel}"`)
		}
		return state.invokeImpl(channel, ...args)
	})
	const ipcOn = vi.fn((channel: string, listener: IpcListener) => {
		let set = ipcListeners.get(channel)
		if (!set) {
			set = new Set()
			ipcListeners.set(channel, set)
		}
		set.add(listener)
	})
	const ipcOff = vi.fn((channel: string, listener: IpcListener) => {
		ipcListeners.get(channel)?.delete(listener)
	})
	const ipcRemoveListener = vi.fn((channel: string, listener: IpcListener) => {
		ipcListeners.get(channel)?.delete(listener)
	})

	return {
		exposed,
		ipcListeners,
		state,
		exposeInMainWorld,
		ipcInvoke,
		ipcOn,
		ipcOff,
		ipcRemoveListener,
	}
})

vi.mock('electron', () => ({
	contextBridge: { exposeInMainWorld: mocks.exposeInMainWorld },
	ipcRenderer: {
		invoke: mocks.ipcInvoke,
		on: mocks.ipcOn,
		off: mocks.ipcOff,
		removeListener: mocks.ipcRemoveListener,
	},
}))

// Pull in the SUT *after* vi.mock has been registered.
const { exposeWorkbenchBridge } = await import('./index.js')

function getExposedBridge(name = DEFAULT_BRIDGE_GLOBAL): WorkbenchBridge {
	const bridge = mocks.exposed.get(name)
	if (bridge === undefined) throw new Error(`bridge not exposed at "${name}"`)
	return bridge as WorkbenchBridge
}

function emitIpc(channel: string, ...args: unknown[]): void {
	const listeners = mocks.ipcListeners.get(channel)
	if (!listeners) return
	for (const l of [...listeners]) l({}, ...args)
}

beforeEach(() => {
	mocks.exposed.clear()
	mocks.ipcListeners.clear()
	mocks.state.invokeImpl = null
	mocks.exposeInMainWorld.mockClear()
	mocks.ipcInvoke.mockClear()
	mocks.ipcOn.mockClear()
	mocks.ipcOff.mockClear()
	mocks.ipcRemoveListener.mockClear()
})

afterEach(() => {
	const g = globalThis as unknown as Record<string, unknown>
	for (const name of mocks.exposed.keys()) delete g[name]
})

describe('exposeWorkbenchBridge()', () => {
	describe('binding to contextBridge', () => {
		it('binds a bridge object onto the default global name', () => {
			exposeWorkbenchBridge()
			expect(mocks.exposeInMainWorld).toHaveBeenCalledTimes(1)
			expect(mocks.exposeInMainWorld).toHaveBeenCalledWith(
				DEFAULT_BRIDGE_GLOBAL,
				expect.any(Object),
			)
		})

		it('uses a custom global name when provided via options', () => {
			exposeWorkbenchBridge({ globalName: '__custom_bridge' })
			expect(mocks.exposeInMainWorld).toHaveBeenCalledTimes(1)
			expect(mocks.exposeInMainWorld.mock.calls[0]?.[0]).toBe('__custom_bridge')
			expect(mocks.exposed.has('__custom_bridge')).toBe(true)
		})

		it('throws with a diagnostic "already exposed" message on duplicate global name', () => {
			exposeWorkbenchBridge()
			expect(() => exposeWorkbenchBridge()).toThrow(/already exposed/i)
		})

		it('throws for duplicate custom global names too', () => {
			exposeWorkbenchBridge({ globalName: '__dup' })
			expect(() => exposeWorkbenchBridge({ globalName: '__dup' })).toThrow(
				/already exposed/i,
			)
		})

		it('allows distinct global names to coexist', () => {
			exposeWorkbenchBridge({ globalName: '__a' })
			exposeWorkbenchBridge({ globalName: '__b' })
			expect(mocks.exposed.has('__a')).toBe(true)
			expect(mocks.exposed.has('__b')).toBe(true)
		})
	})

	describe('bridge shape (WorkbenchBridge interface)', () => {
		beforeEach(() => {
			exposeWorkbenchBridge()
		})

		it('exposes the protocol version constant', () => {
			const bridge = getExposedBridge()
			expect(bridge.version).toBe(BRIDGE_PROTOCOL_VERSION)
		})

		it('exposes invoke / probe / onEvent as functions', () => {
			const bridge = getExposedBridge()
			expect(typeof bridge.probe).toBe('function')
			expect(typeof bridge.invoke).toBe('function')
			expect(typeof bridge.onEvent).toBe('function')
		})

		it('onEvent returns a plain unsubscribe function (not a Disposable object)', () => {
			// contextBridge cannot pass objects-with-methods cleanly; the
			// protocol JSDoc explicitly says the unsubscribe must be a plain
			// callable. Asserting typeof === 'function' rather than checking a
			// `dispose` method.
			const bridge = getExposedBridge()
			const unsub = bridge.onEvent(() => {})
			expect(typeof unsub).toBe('function')
			// And not a Disposable-shaped object.
			expect((unsub as unknown as { dispose?: unknown }).dispose).toBeUndefined()
			unsub()
		})
	})

	describe('invoke() routing', () => {
		beforeEach(() => {
			exposeWorkbenchBridge()
		})

		it('forwards invoke() to ipcRenderer on the Invoke channel', async () => {
			mocks.state.invokeImpl = vi.fn(async () => {
				const res: InvokeResponse = { ok: true, result: 'pong' }
				return res
			})
			const bridge = getExposedBridge()
			const req: InvokeRequest = { kind: 'host', name: 'ping', args: [] }
			const res = await bridge.invoke(req)
			expect(mocks.ipcInvoke).toHaveBeenCalledTimes(1)
			expect(mocks.ipcInvoke.mock.calls[0]?.[0]).toBe(WorkbenchChannel.Invoke)
			expect(res).toEqual({ ok: true, result: 'pong' })
		})

		it('propagates failure envelopes verbatim', async () => {
			const failure: InvokeResponse = {
				ok: false,
				error: { remoteName: 'host:boom', message: 'remote exploded', code: 'E_BOOM' },
			}
			mocks.state.invokeImpl = vi.fn(async () => failure)
			const bridge = getExposedBridge()
			const res = await bridge.invoke({ kind: 'host', name: 'boom', args: [] })
			expect(res).toEqual(failure)
		})

		it('passes the request envelope through unchanged', async () => {
			let seen: unknown
			mocks.state.invokeImpl = vi.fn(async (..._args: unknown[]) => {
				seen = _args[1]
				return { ok: true, result: null } as InvokeResponse
			})
			const bridge = getExposedBridge()
			const req: InvokeRequest = {
				kind: 'simulator',
				name: 'wx.getStorage',
				args: ['key'],
			}
			await bridge.invoke(req)
			expect(seen).toEqual(req)
		})
	})

	describe('probe()', () => {
		beforeEach(() => {
			exposeWorkbenchBridge()
		})

		it('resolves a ProbeResponse with the protocol version', async () => {
			// Probe may be routed via ipcRenderer.invoke on the Probe channel,
			// or implemented locally — both satisfy the contract as long as it
			// resolves the documented shape.
			mocks.state.invokeImpl = vi.fn(async (...args: unknown[]) => {
				const channel = args[0]
				if (channel === WorkbenchChannel.Probe) {
					return { ready: true, version: BRIDGE_PROTOCOL_VERSION }
				}
				throw new Error(`unexpected channel ${String(channel)}`)
			})
			const bridge = getExposedBridge()
			const res = await bridge.probe()
			expect(res.ready).toBe(true)
			expect(res.version).toBe(BRIDGE_PROTOCOL_VERSION)
		})
	})

	describe('onEvent() routing', () => {
		beforeEach(() => {
			exposeWorkbenchBridge()
		})

		it('subscribes to the Event channel on ipcRenderer', () => {
			const bridge = getExposedBridge()
			bridge.onEvent(() => {})
			expect(mocks.ipcOn).toHaveBeenCalled()
			expect(mocks.ipcOn.mock.calls[0]?.[0]).toBe(WorkbenchChannel.Event)
		})

		it('delivers envelopes pushed from the Event channel to the listener', () => {
			const bridge = getExposedBridge()
			const received: EventEnvelope[] = []
			bridge.onEvent((env) => received.push(env))
			const env: EventEnvelope = { name: 'foo', payload: { x: 1 } }
			emitIpc(WorkbenchChannel.Event, env)
			expect(received).toEqual([env])
		})

		it('returns an unsubscribe function that stops further deliveries', () => {
			const bridge = getExposedBridge()
			const received: EventEnvelope[] = []
			const unsub = bridge.onEvent((env) => received.push(env))
			emitIpc(WorkbenchChannel.Event, { name: 'a', payload: 1 })
			unsub()
			emitIpc(WorkbenchChannel.Event, { name: 'b', payload: 2 })
			expect(received.map((e) => e.name)).toEqual(['a'])
		})

		it('supports multiple independent subscribers', () => {
			const bridge = getExposedBridge()
			const aSeen: string[] = []
			const bSeen: string[] = []
			bridge.onEvent((env) => aSeen.push(env.name))
			bridge.onEvent((env) => bSeen.push(env.name))
			emitIpc(WorkbenchChannel.Event, { name: 'x', payload: null })
			expect(aSeen).toEqual(['x'])
			expect(bSeen).toEqual(['x'])
		})

		it('unsubscribing one listener does not affect others', () => {
			const bridge = getExposedBridge()
			const aSeen: string[] = []
			const bSeen: string[] = []
			const unsubA = bridge.onEvent((env) => aSeen.push(env.name))
			bridge.onEvent((env) => bSeen.push(env.name))
			unsubA()
			emitIpc(WorkbenchChannel.Event, { name: 'after', payload: null })
			expect(aSeen).toEqual([])
			expect(bSeen).toEqual(['after'])
		})
	})
})
