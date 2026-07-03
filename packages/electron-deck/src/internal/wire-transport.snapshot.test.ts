// Wire-transport __electron-deck:snapshot + __electron-deck:layout-subscribe
// inbound channels.
//
// Contract:
//   WireTransportDeps.onSnapshot(senderId, rawSnapshot) is called when a
//   trusted main-frame sender invokes the Snapshot channel with an object
//   payload (non-object, null, and array payloads are dropped silently before
//   forwarding, even for trusted senders).
//   Untrusted senders and sub-frames are dropped with the same gate as invoke.
//   When onSnapshot is absent from deps → Snapshot handler is not registered.
//   dispose() removes snapshot + layout-subscribe handlers.
//
//   WireTransportDeps.onLayoutSubscribe(senderId) behaviour and gate are
//   unchanged from prior versions.
//
// Channel string literals pin the on-the-wire strings directly so a rename of
// the DeckChannel enum member can't silently drift the wire contract.

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

const SNAPSHOT_CHANNEL = '__electron-deck:snapshot'
const LAYOUT_SUBSCRIBE_CHANNEL = '__electron-deck:layout-subscribe'

// ── harness ──────────────────────────────────────────────────────────────────

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

interface Harness {
	transport: WireTransport
	ipcMain: FakeIpcMain
	onSnapshot: ReturnType<typeof vi.fn>
	onLayoutSubscribe: ReturnType<typeof vi.fn>
	getSnapshotHandler: () => Handler
	getLayoutSubscribeHandler: () => Handler
}

function makeHarness(opts: {
	trustedIds?: number[]
	withOnSnapshot?: boolean
	withOnLayoutSubscribe?: boolean
} = {}): Harness {
	const ipcMain = createFakeIpcMain()
	const bus = new EventBus()
	const senderPolicy = createFakeSenderPolicy(new Set(opts.trustedIds ?? []))
	const onSnapshot = vi.fn()
	const onLayoutSubscribe = vi.fn()
	const deps: WireTransportDeps = {
		ipcMain,
		bus,
		senderPolicy,
		trustedWebContents: () => [] as readonly MinimalWebContents[],
		invokeHost: async () => null as JsonValue,
		invokeSimulator: async () => null as JsonValue,
		declaredEvents: () => ['e1'],
		...(opts.withOnSnapshot ?? true ? { onSnapshot } : {}),
		...(opts.withOnLayoutSubscribe ?? true ? { onLayoutSubscribe } : {}),
	}
	const transport = new WireTransport(deps)
	return {
		transport,
		ipcMain,
		onSnapshot,
		onLayoutSubscribe,
		getSnapshotHandler: () => {
			const h = ipcMain.handlers.get(SNAPSHOT_CHANNEL)
			if (!h) throw new Error('snapshot handler not registered')
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

// A minimal valid snapshot object (content is opaque to the wire layer).
const VALID_SNAPSHOT = {
	generation: 0,
	epoch: 0,
	views: [{ placement: { visible: false }, extra: { slotToken: 't' } }],
}

// ── Snapshot handler ──────────────────────────────────────────────────────────

describe('WireTransport — __electron-deck:snapshot handler', () => {
	it('trusted main-frame sender with object payload → onSnapshot(senderId, rawSnapshot)', async () => {
		const h = makeHarness({ trustedIds: [7] })
		h.transport.start()
		const handler = h.getSnapshotHandler()
		await handler(
			{ sender: { id: 7, mainFrame: MAIN }, senderFrame: MAIN },
			VALID_SNAPSHOT,
		)
		expect(h.onSnapshot).toHaveBeenCalledTimes(1)
		expect(h.onSnapshot).toHaveBeenCalledWith(7, VALID_SNAPSHOT)
	})

	it('untrusted sender → onSnapshot NOT called (dropped)', async () => {
		const h = makeHarness({ trustedIds: [] })
		h.transport.start()
		const handler = h.getSnapshotHandler()
		const res = await handler(
			{ sender: { id: 42, mainFrame: MAIN }, senderFrame: MAIN },
			VALID_SNAPSHOT,
		)
		expect(res).toBeUndefined()
		expect(h.onSnapshot).not.toHaveBeenCalled()
	})

	it('sub-frame sender (senderFrame !== mainFrame) → onSnapshot NOT called (dropped)', async () => {
		const h = makeHarness({ trustedIds: [7] })
		h.transport.start()
		const handler = h.getSnapshotHandler()
		const res = await handler(
			{ sender: { id: 7, mainFrame: MAIN }, senderFrame: SUB },
			VALID_SNAPSHOT,
		)
		expect(res).toBeUndefined()
		expect(h.onSnapshot).not.toHaveBeenCalled()
	})

	it('string payload → onSnapshot NOT called (non-object dropped before trust gate)', async () => {
		const h = makeHarness({ trustedIds: [7] })
		h.transport.start()
		const handler = h.getSnapshotHandler()
		await handler({ sender: { id: 7, mainFrame: MAIN }, senderFrame: MAIN }, 'not-an-object')
		expect(h.onSnapshot).not.toHaveBeenCalled()
	})

	it('array payload → onSnapshot NOT called (arrays are not plain objects)', async () => {
		const h = makeHarness({ trustedIds: [7] })
		h.transport.start()
		const handler = h.getSnapshotHandler()
		await handler({ sender: { id: 7, mainFrame: MAIN }, senderFrame: MAIN }, [{ ok: true }])
		expect(h.onSnapshot).not.toHaveBeenCalled()
	})

	it('null payload → onSnapshot NOT called', async () => {
		const h = makeHarness({ trustedIds: [7] })
		h.transport.start()
		const handler = h.getSnapshotHandler()
		await handler({ sender: { id: 7, mainFrame: MAIN }, senderFrame: MAIN }, null)
		expect(h.onSnapshot).not.toHaveBeenCalled()
	})

	it('onSnapshot absent in deps → snapshot handler is not registered (back-compat)', () => {
		const h = makeHarness({ trustedIds: [7], withOnSnapshot: false, withOnLayoutSubscribe: false })
		h.transport.start()
		expect(h.ipcMain.handlers.has(SNAPSHOT_CHANNEL)).toBe(false)
		const snapCalls = h.ipcMain.handle.mock.calls.filter(c => c[0] === SNAPSHOT_CHANNEL)
		expect(snapCalls.length).toBe(0)
		// Legacy invoke + probe channels are still registered.
		expect(h.ipcMain.handlers.has(DeckChannel.Invoke)).toBe(true)
		expect(h.ipcMain.handlers.has(DeckChannel.Probe)).toBe(true)
	})

	it('dispose() removes the snapshot + layout-subscribe handlers', () => {
		const h = makeHarness({ trustedIds: [7] })
		h.transport.start()
		expect(h.ipcMain.handlers.has(SNAPSHOT_CHANNEL)).toBe(true)
		expect(h.ipcMain.handlers.has(LAYOUT_SUBSCRIBE_CHANNEL)).toBe(true)
		h.transport.dispose()
		const removed = h.ipcMain.removeHandler.mock.calls.map(c => c[0] as string)
		expect(removed).toContain(SNAPSHOT_CHANNEL)
		expect(removed).toContain(LAYOUT_SUBSCRIBE_CHANNEL)
		expect(h.ipcMain.handlers.has(SNAPSHOT_CHANNEL)).toBe(false)
		expect(h.ipcMain.handlers.has(LAYOUT_SUBSCRIBE_CHANNEL)).toBe(false)
	})
})

// ── LayoutSubscribe handler (unchanged gate/behaviour) ────────────────────────

describe('WireTransport — __electron-deck:layout-subscribe handler', () => {
	it('trusted main-frame sender → onLayoutSubscribe(senderId) called', async () => {
		const h = makeHarness({ trustedIds: [7] })
		h.transport.start()
		const sub = h.getLayoutSubscribeHandler()
		await sub({ sender: { id: 7, mainFrame: MAIN }, senderFrame: MAIN })
		expect(h.onLayoutSubscribe).toHaveBeenCalledTimes(1)
		expect(h.onLayoutSubscribe).toHaveBeenCalledWith(7)
	})

	it('untrusted sender → onLayoutSubscribe NOT called (dropped)', async () => {
		const h = makeHarness({ trustedIds: [] })
		h.transport.start()
		const sub = h.getLayoutSubscribeHandler()
		const res = await sub({ sender: { id: 99, mainFrame: MAIN }, senderFrame: MAIN })
		expect(res).toBeUndefined()
		expect(h.onLayoutSubscribe).not.toHaveBeenCalled()
	})

	it('sub-frame sender → onLayoutSubscribe NOT called (dropped)', async () => {
		const h = makeHarness({ trustedIds: [7] })
		h.transport.start()
		const sub = h.getLayoutSubscribeHandler()
		const res = await sub({ sender: { id: 7, mainFrame: MAIN }, senderFrame: SUB })
		expect(res).toBeUndefined()
		expect(h.onLayoutSubscribe).not.toHaveBeenCalled()
	})
})
