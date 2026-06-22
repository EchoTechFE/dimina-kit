/**
 * Turnkey `exposeDeckLayoutBridge()` preload helper.
 *
 * Today `exposeDeckBridge()` exposes only the host-service / event RPC bridge
 * (probe / invoke / onEvent). It does NOT wire the three slot-token LAYOUT
 * channels (`slot-grant` PUSH, `place` send, `layout-subscribe` invoke). So
 * every host re-implements the same preload over hard-coded `DeckChannel.*`
 * strings and hand-rolls a `bridge` for `createDeckLayoutClient`.
 *
 * The contract (Part B): a new `exposeDeckLayoutBridge(options?)` in
 * `@dimina-kit/electron-deck/preload` exposes — under a stable global
 * (`__electronDeckLayoutBridge`) — a `LayoutBridge`-shaped object so the
 * renderer does `createDeckLayoutClient({ bridge: window.__electronDeckLayoutBridge })`.
 *
 * `exposeDeckLayoutBridge` is reached through a typed escape hatch on the
 * imported preload module, so the file COMPILES regardless of the exact export
 * surface and the guard is a runtime check, not a type error.
 *
 * Reuses the fake `contextBridge` / `ipcRenderer` pattern from
 * `src/preload/index.test.ts` (vi.hoisted mock state so the vi.mock factory can
 * reach it).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeckChannel } from '../shared/protocol.js'
import type { LayoutBridge, SlotGrant } from '../client/layout-client.js'

// The stable global the renderer reads (`window.__electronDeckLayoutBridge`).
// Hard-pinned here because the renderer's `createDeckLayoutClient({ bridge })`
// call site references exactly this name; the helper MUST default to it.
const LAYOUT_BRIDGE_GLOBAL = '__electronDeckLayoutBridge'

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
	const ipcSend = vi.fn((_channel: string, ..._args: unknown[]) => {})
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
		ipcSend,
		ipcOn,
		ipcOff,
		ipcRemoveListener,
	}
})

vi.mock('electron', () => ({
	contextBridge: { exposeInMainWorld: mocks.exposeInMainWorld },
	ipcRenderer: {
		invoke: mocks.ipcInvoke,
		send: mocks.ipcSend,
		on: mocks.ipcOn,
		off: mocks.ipcOff,
		removeListener: mocks.ipcRemoveListener,
	},
}))

// Pull in the SUT *after* vi.mock has registered. `exposeDeckLayoutBridge` is
// reached through a loose shape so the file COMPILES regardless of the exact
// module typing, with the guard enforced at runtime.
const preloadModule = await import('./index.js')
type ExposeLayoutBridge = (options?: { globalName?: string }) => void
const exposeDeckLayoutBridge = (preloadModule as unknown as {
	exposeDeckLayoutBridge?: ExposeLayoutBridge
}).exposeDeckLayoutBridge as ExposeLayoutBridge

function getExposedLayoutBridge(name = LAYOUT_BRIDGE_GLOBAL): LayoutBridge {
	const bridge = mocks.exposed.get(name)
	if (bridge === undefined) throw new Error(`layout bridge not exposed at "${name}"`)
	return bridge as LayoutBridge
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
	mocks.ipcSend.mockClear()
	mocks.ipcOn.mockClear()
	mocks.ipcOff.mockClear()
	mocks.ipcRemoveListener.mockClear()
})

afterEach(() => {
	const g = globalThis as unknown as Record<string, unknown>
	for (const name of mocks.exposed.keys()) delete g[name]
})

describe('exposeDeckLayoutBridge()', () => {
	// ── B1: binds a LayoutBridge-shaped object under the stable global ──────────
	describe('B1 — binding to contextBridge', () => {
		it('B1) calls exposeInMainWorld(<stable global>, bridge) where bridge has onSlotGrant / sendPlace / subscribe', () => {
			expect(typeof exposeDeckLayoutBridge).toBe('function')
			exposeDeckLayoutBridge()
			expect(mocks.exposeInMainWorld).toHaveBeenCalledTimes(1)
			// The exact stable global name the renderer reads.
			expect(mocks.exposeInMainWorld.mock.calls[0]?.[0]).toBe(LAYOUT_BRIDGE_GLOBAL)
			const bridge = getExposedLayoutBridge()
			expect(typeof bridge.onSlotGrant).toBe('function')
			expect(typeof bridge.sendPlace).toBe('function')
			expect(typeof bridge.subscribe).toBe('function')
		})
	})

	// ── B2: onSlotGrant subscribes to the slot-grant PUSH + returns unsub ───────
	describe('B2 — onSlotGrant subscribes to the slot-grant push', () => {
		beforeEach(() => {
			exposeDeckLayoutBridge()
		})

		it('B2) onSlotGrant(cb) subscribes ipcRenderer.on(SlotGrant) and invokes cb with the grant payload', () => {
			const bridge = getExposedLayoutBridge()
			const received: SlotGrant[] = []
			bridge.onSlotGrant(g => received.push(g))

			expect(mocks.ipcOn).toHaveBeenCalled()
			expect(mocks.ipcOn.mock.calls[0]?.[0]).toBe(DeckChannel.SlotGrant)

			const grant: SlotGrant = { viewId: 'v1', slotId: '#sim', slotToken: 'tok-1' }
			emitIpc(DeckChannel.SlotGrant, grant)
			expect(received).toEqual([grant])
		})

		it('B2) onSlotGrant returns a plain unsubscribe that removes the listener (no further deliveries)', () => {
			const bridge = getExposedLayoutBridge()
			const received: string[] = []
			const unsub = bridge.onSlotGrant(g => received.push(g.viewId))
			expect(typeof unsub).toBe('function')

			emitIpc(DeckChannel.SlotGrant, { viewId: 'a', slotId: '#a', slotToken: 't-a' })
			unsub()
			emitIpc(DeckChannel.SlotGrant, { viewId: 'b', slotId: '#b', slotToken: 't-b' })
			expect(received).toEqual(['a'])
		})
	})

	// ── B3: channel names come from DeckChannel (NO hand-duplicated strings) ────
	describe('B3 — channel names sourced from DeckChannel (no hard-coded strings)', () => {
		beforeEach(() => {
			exposeDeckLayoutBridge()
		})

		it('B3) sendPlace(msg) sends/invokes the Place channel with the msg; subscribe() invokes LayoutSubscribe', () => {
			const bridge = getExposedLayoutBridge()
			mocks.state.invokeImpl = vi.fn(async () => undefined)

			const msg = {
				slotToken: 'tok-1',
				placement: { visible: true as const, bounds: { x: 1, y: 2, width: 3, height: 4 } },
			}
			bridge.sendPlace(msg)
			bridge.subscribe()

			// sendPlace went out on the Place channel carrying the msg (either via
			// ipcRenderer.send or .invoke — accept both transports).
			const placeViaSend = mocks.ipcSend.mock.calls.find(c => c[0] === DeckChannel.Place)
			const placeViaInvoke = mocks.ipcInvoke.mock.calls.find(c => c[0] === DeckChannel.Place)
			const placeCall = placeViaSend ?? placeViaInvoke
			expect(placeCall, 'expected a Place IPC carrying the msg').toBeTruthy()
			expect(placeCall?.[1]).toEqual(msg)

			// subscribe() invoked the LayoutSubscribe channel.
			const subViaInvoke = mocks.ipcInvoke.mock.calls.some(c => c[0] === DeckChannel.LayoutSubscribe)
			const subViaSend = mocks.ipcSend.mock.calls.some(c => c[0] === DeckChannel.LayoutSubscribe)
			expect(subViaInvoke || subViaSend, 'expected a LayoutSubscribe IPC').toBe(true)
		})

		it('B3) the exact channel strings match the framework protocol (NOT hand-duplicated)', () => {
			// Guard the literals so a drifted hand-copy in the helper is caught:
			// onSlotGrant → ":slot-grant", sendPlace → ":place", subscribe → ":layout-subscribe".
			expect(DeckChannel.SlotGrant).toBe('__electron-deck:slot-grant')
			expect(DeckChannel.Place).toBe('__electron-deck:place')
			expect(DeckChannel.LayoutSubscribe).toBe('__electron-deck:layout-subscribe')

			const bridge = getExposedLayoutBridge()
			mocks.state.invokeImpl = vi.fn(async () => undefined)

			bridge.onSlotGrant(() => {})
			bridge.sendPlace({
				slotToken: 't',
				placement: { visible: true as const, bounds: { x: 0, y: 0, width: 1, height: 1 } },
			})
			bridge.subscribe()

			// onSlotGrant subscribed to exactly the slot-grant string.
			expect(mocks.ipcOn.mock.calls.some(c => c[0] === '__electron-deck:slot-grant')).toBe(true)
			// Place + LayoutSubscribe went out on exactly those strings (send OR invoke).
			const allOutbound = [
				...mocks.ipcSend.mock.calls.map(c => c[0]),
				...mocks.ipcInvoke.mock.calls.map(c => c[0]),
			]
			expect(allOutbound).toContain('__electron-deck:place')
			expect(allOutbound).toContain('__electron-deck:layout-subscribe')
		})
	})

	// ── guard outside a preload ─────────────────────────────────────────────
	describe('guard outside a preload', () => {
		it('throws a clear error when contextBridge / ipcRenderer are unavailable (mirrors exposeDeckBridge guard)', async () => {
			// Re-import the module under a fresh registry where `electron` has no
			// contextBridge / ipcRenderer, so the guard fires.
			vi.resetModules()
			vi.doMock('electron', () => ({ contextBridge: undefined, ipcRenderer: undefined }))
			const mod = await import('./index.js')
			const fn = (mod as unknown as { exposeDeckLayoutBridge?: ExposeLayoutBridge }).exposeDeckLayoutBridge
			expect(typeof fn).toBe('function')
			expect(() => fn!()).toThrow(/preload/i)
			vi.doUnmock('electron')
			vi.resetModules()
		})
	})

	// ── B5: structural compatibility with createDeckLayoutClient's LayoutBridge ─
	describe('B5 — produced bridge matches LayoutBridge structurally', () => {
		it('B5) the exposed object satisfies the LayoutBridge interface (onSlotGrant→unsub, sendPlace, subscribe)', () => {
			exposeDeckLayoutBridge()
			// Structural pin: assigning to a typed LayoutBridge is the compile-time
			// half; the runtime half asserts the members are the right shapes.
			const bridge: LayoutBridge = getExposedLayoutBridge()
			const unsub = bridge.onSlotGrant(() => {})
			expect(typeof unsub).toBe('function')
			// Not a Disposable-shaped object (must be plain callable across contextBridge).
			expect((unsub as unknown as { dispose?: unknown }).dispose).toBeUndefined()
			unsub()
			expect(bridge.sendPlace.length).toBeGreaterThanOrEqual(1)
			expect(typeof bridge.subscribe).toBe('function')
		})
	})
})
