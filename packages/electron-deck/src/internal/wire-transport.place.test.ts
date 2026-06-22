// TDD (failing-first): slot-token main-process plumbing — WireTransport's
// `__electron-deck:place` + `__electron-deck:layout-subscribe` inbound channels.
//
// Contract under test (NOT yet implemented — view-handle.md「slot-token 握手」/
// capability-and-lifecycle.md「anchor slotToken 原子下发」):
//
//   WireTransportDeps gains two OPTIONAL deps:
//     onPlace?(senderId: number, slotToken: string, placement: unknown): void
//     onLayoutSubscribe?(senderId: number): void
//
//   When provided, start() additionally registers:
//     ipcMain.handle('__electron-deck:place', ...)
//     ipcMain.handle('__electron-deck:layout-subscribe', ...)
//   and dispose() removes both.
//
//   Both handlers apply the SAME gate as invoke:
//     senderPolicy.isTrusted(senderId) AND isMainFrameSender(senderFrame, mainFrame)
//   On gate FAIL → DROP silently (return undefined; do NOT call the callback).
//   On gate PASS → onPlace(senderId, msg.slotToken, msg.placement) /
//                  onLayoutSubscribe(senderId).
//
//   When `onPlace` is absent from deps → NO place handler is registered
//   (back-compat); same for layout-subscribe.
//
// These tests deliberately reference the channel string LITERALS
// ('__electron-deck:place' / '__electron-deck:layout-subscribe') instead of
// `DeckChannel.Place` / `DeckChannel.LayoutSubscribe`, so they pin the on-the-wire
// channel strings directly — a rename of the enum member can't silently drift the
// wire contract past these specs. `onPlace`/`onLayoutSubscribe` are reached through
// a typed escape hatch on the deps.

import { describe, expect, it, vi } from 'vitest'
import type { JsonValue, SenderPolicy } from '../types.js'
import { DeckChannel } from '../shared/protocol.js'
import { EventBus } from './event-bus.js'
import type {
	MinimalIpcMain,
	MinimalWebContents,
	WireTransportDeps,
} from './wire-transport.js'
import { WireTransport } from './wire-transport.js'

const PLACE_CHANNEL = '__electron-deck:place'
const LAYOUT_SUBSCRIBE_CHANNEL = '__electron-deck:layout-subscribe'

// ── harness (mirrors wire-transport.frame-trust.test.ts) ─────────────────────

// Looser event shape than the legacy `{ sender: { id } }` stub so we can model
// the frame fields the gate consults.
type FrameRef = { routingId: number, processId: number } | null
interface FrameEvent {
	sender: { id: number, mainFrame?: FrameRef }
	senderFrame?: FrameRef
}
type Handler = (event: FrameEvent, ...args: unknown[]) => unknown | Promise<unknown>

interface FakeIpcMain extends MinimalIpcMain {
	handle: ReturnType<typeof vi.fn> & MinimalIpcMain['handle']
	removeHandler: ReturnType<typeof vi.fn> & MinimalIpcMain['removeHandler']
	handlers: Map<string, Handler>
}

function createFakeIpcMain(): FakeIpcMain {
	const handlers = new Map<string, Handler>()
	const handle = vi.fn((channel: string, handler: Handler) => {
		handlers.set(channel, handler)
	}) as FakeIpcMain['handle']
	const removeHandler = vi.fn((channel: string) => {
		handlers.delete(channel)
	}) as FakeIpcMain['removeHandler']
	return { handle, removeHandler, handlers }
}

function createFakeSenderPolicy(trustedIds: Set<number>): SenderPolicy {
	return { isTrusted: (id: number) => trustedIds.has(id) }
}

// The new optional deps are not in the public WireTransportDeps type yet; reach
// them through a loose view so the file compiles and fails at RUNTIME (the
// handler is never registered → handlers.get(...) is undefined) instead of at
// compile time.
type PlaceDeps = WireTransportDeps & {
	onPlace?: (senderId: number, slotToken: string, placement: unknown) => void
	onLayoutSubscribe?: (senderId: number) => void
}

interface Harness {
	transport: WireTransport
	ipcMain: FakeIpcMain
	onPlace: ReturnType<typeof vi.fn>
	onLayoutSubscribe: ReturnType<typeof vi.fn>
	getPlaceHandler: () => Handler
	getLayoutSubscribeHandler: () => Handler
}

function makeHarness(opts: {
	trustedIds?: number[]
	withOnPlace?: boolean
	withOnLayoutSubscribe?: boolean
} = {}): Harness {
	const ipcMain = createFakeIpcMain()
	const bus = new EventBus()
	const senderPolicy = createFakeSenderPolicy(new Set(opts.trustedIds ?? []))
	const onPlace = vi.fn()
	const onLayoutSubscribe = vi.fn()
	const deps: PlaceDeps = {
		ipcMain,
		bus,
		senderPolicy,
		trustedWebContents: () => [] as readonly MinimalWebContents[],
		invokeHost: async () => null as JsonValue,
		invokeSimulator: async () => null as JsonValue,
		declaredEvents: () => ['e1'],
	}
	if (opts.withOnPlace ?? true) deps.onPlace = onPlace
	if (opts.withOnLayoutSubscribe ?? true) deps.onLayoutSubscribe = onLayoutSubscribe
	const transport = new WireTransport(deps as WireTransportDeps)
	return {
		transport,
		ipcMain,
		onPlace,
		onLayoutSubscribe,
		getPlaceHandler: () => {
			const h = ipcMain.handlers.get(PLACE_CHANNEL)
			if (!h) throw new Error('place handler not registered')
			return h
		},
		getLayoutSubscribeHandler: () => {
			const h = ipcMain.handlers.get(LAYOUT_SUBSCRIBE_CHANNEL)
			if (!h) throw new Error('layout-subscribe handler not registered')
			return h
		},
	}
}

const MAIN: FrameRef = { routingId: 1, processId: 100 }
const SUB: FrameRef = { routingId: 2, processId: 100 }

// ── Part 1 tests ─────────────────────────────────────────────────────────────

describe('WireTransport — __electron-deck:place handler (slot-token inbound)', () => {
	// a) trusted main-frame sender → onPlace called with (senderId, slotToken, placement)
	it('a) trusted main-frame sender → onPlace(senderId, slotToken, placement)', async () => {
		const h = makeHarness({ trustedIds: [7] })
		h.transport.start()
		const place = h.getPlaceHandler()
		const placement = { visible: true, bounds: { x: 1, y: 2, width: 3, height: 4 } }
		await place(
			{ sender: { id: 7, mainFrame: MAIN }, senderFrame: MAIN },
			{ slotToken: 'tok-abc', placement },
		)
		expect(h.onPlace).toHaveBeenCalledTimes(1)
		expect(h.onPlace).toHaveBeenCalledWith(7, 'tok-abc', placement)
	})

	// b) UNtrusted sender → dropped (onPlace not called)
	it('b) untrusted sender → onPlace NOT called (dropped)', async () => {
		const h = makeHarness({ trustedIds: [] }) // nobody trusted
		h.transport.start()
		const place = h.getPlaceHandler()
		const res = await place(
			{ sender: { id: 42, mainFrame: MAIN }, senderFrame: MAIN },
			{ slotToken: 'tok', placement: { visible: false } },
		)
		expect(res).toBeUndefined()
		expect(h.onPlace).not.toHaveBeenCalled()
	})

	// c) sub-frame sender (isMainFrameSender false) → dropped
	it('c) sub-frame sender (senderFrame !== mainFrame) → onPlace NOT called (dropped)', async () => {
		const h = makeHarness({ trustedIds: [7] })
		h.transport.start()
		const place = h.getPlaceHandler()
		const res = await place(
			{ sender: { id: 7, mainFrame: MAIN }, senderFrame: SUB },
			{ slotToken: 'tok', placement: { visible: false } },
		)
		expect(res).toBeUndefined()
		expect(h.onPlace).not.toHaveBeenCalled()
	})

	// e) onPlace absent in deps → no Place handler registered (back-compat)
	it('e) onPlace NOT provided → place handler is not registered (back-compat)', () => {
		const h = makeHarness({ trustedIds: [7], withOnPlace: false, withOnLayoutSubscribe: false })
		h.transport.start()
		expect(h.ipcMain.handlers.has(PLACE_CHANNEL)).toBe(false)
		// ipcMain.handle was never called for the Place channel.
		const placeCalls = h.ipcMain.handle.mock.calls.filter(c => c[0] === PLACE_CHANNEL)
		expect(placeCalls.length).toBe(0)
		// The legacy invoke + probe channels are still registered.
		expect(h.ipcMain.handlers.has(DeckChannel.Invoke)).toBe(true)
		expect(h.ipcMain.handlers.has(DeckChannel.Probe)).toBe(true)
	})

	// f) dispose() removes the Place + LayoutSubscribe handlers
	it('f) dispose() removes the place + layout-subscribe handlers', () => {
		const h = makeHarness({ trustedIds: [7] })
		h.transport.start()
		// Both were registered.
		expect(h.ipcMain.handlers.has(PLACE_CHANNEL)).toBe(true)
		expect(h.ipcMain.handlers.has(LAYOUT_SUBSCRIBE_CHANNEL)).toBe(true)
		h.transport.dispose()
		const removed = h.ipcMain.removeHandler.mock.calls.map(c => c[0] as string)
		expect(removed).toContain(PLACE_CHANNEL)
		expect(removed).toContain(LAYOUT_SUBSCRIBE_CHANNEL)
		expect(h.ipcMain.handlers.has(PLACE_CHANNEL)).toBe(false)
		expect(h.ipcMain.handlers.has(LAYOUT_SUBSCRIBE_CHANNEL)).toBe(false)
	})
})

describe('WireTransport — __electron-deck:layout-subscribe handler', () => {
	// d) trusted main-frame → onLayoutSubscribe(senderId); untrusted → not.
	it('d) trusted main-frame sender → onLayoutSubscribe(senderId) called', async () => {
		const h = makeHarness({ trustedIds: [7] })
		h.transport.start()
		const sub = h.getLayoutSubscribeHandler()
		await sub({ sender: { id: 7, mainFrame: MAIN }, senderFrame: MAIN })
		expect(h.onLayoutSubscribe).toHaveBeenCalledTimes(1)
		expect(h.onLayoutSubscribe).toHaveBeenCalledWith(7)
	})

	it('d) untrusted sender → onLayoutSubscribe NOT called (dropped)', async () => {
		const h = makeHarness({ trustedIds: [] })
		h.transport.start()
		const sub = h.getLayoutSubscribeHandler()
		const res = await sub({ sender: { id: 99, mainFrame: MAIN }, senderFrame: MAIN })
		expect(res).toBeUndefined()
		expect(h.onLayoutSubscribe).not.toHaveBeenCalled()
	})

	it('d) sub-frame sender → onLayoutSubscribe NOT called (dropped)', async () => {
		const h = makeHarness({ trustedIds: [7] })
		h.transport.start()
		const sub = h.getLayoutSubscribeHandler()
		const res = await sub({ sender: { id: 7, mainFrame: MAIN }, senderFrame: SUB })
		expect(res).toBeUndefined()
		expect(h.onLayoutSubscribe).not.toHaveBeenCalled()
	})
})
