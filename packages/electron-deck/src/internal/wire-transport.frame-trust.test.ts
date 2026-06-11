// TDD (failing-first): frame-level trust for gated invoke.
//
// Contract under test (NOT yet implemented):
// The wire `handleInvoke` currently gates ONLY on `event.sender.id` via
// senderPolicy. That lets a sub-frame (iframe) inside a TRUSTED webContents
// spoof the main frame and reach gated invoke. We add a defense-in-depth
// main-frame check that mirrors devtools' verified `isMainFrameSender`
// (packages/devtools/src/main/utils/ipc-registry.ts):
//
//   const frame = event.senderFrame; const main = event.sender.mainFrame
//   - both undefined  → frame-unaware test stub → skip frame check (senderId
//                       still gates) → ALLOW (backward compat)
//   - frame == null || main == null → fail-closed → REJECT (navigate-after-send)
//   - frame.routingId === main.routingId && frame.processId === main.processId
//                     → main frame → ALLOW
//   - otherwise (sub frame) → REJECT
//
// Rejection returns an InvokeFailure with the NEW reserved code
// DECK_CODE.UntrustedFrame === 'DECK_UNTRUSTED_FRAME'.
//
// These tests assert the literal 'DECK_UNTRUSTED_FRAME' rather than importing
// DECK_CODE.UntrustedFrame, because that member does not exist yet and importing
// it would be a compile error rather than a clean test failure.
//
// Implementer note: `handleInvoke` today only receives `senderId` (see
// start(): `(event, ...args) => this.handleInvoke(event?.sender?.id, args[0])`).
// To satisfy this contract the registered invoke handler must additionally read
// `event.senderFrame` + `event.sender.mainFrame` and pass them into (or perform
// the check before delegating to) `handleInvoke`.

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

const UNTRUSTED_FRAME = 'DECK_UNTRUSTED_FRAME'

// ── harness (mirrors wire-transport.test.ts) ──────────────────────────────

// Event shape is intentionally looser than the existing `{ sender: { id } }`
// stub so we can model the frame fields (`senderFrame`, `sender.mainFrame`).
type FrameRef = { routingId: number, processId: number } | null
interface FrameEvent {
	sender: { id: number, mainFrame?: FrameRef }
	senderFrame?: FrameRef
}
type InvokeHandler = (event: FrameEvent, ...args: unknown[]) => unknown | Promise<unknown>

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

function createFakeSenderPolicy(trustedIds: Set<number>): SenderPolicy {
	return { isTrusted: (id: number) => trustedIds.has(id) }
}

interface Harness {
	transport: WireTransport
	ipcMain: FakeIpcMain
	bus: EventBus
	invokeHost: ReturnType<typeof vi.fn>
	invokeSimulator: ReturnType<typeof vi.fn>
	getInvokeHandler: () => InvokeHandler
}

function makeHarness(opts: {
	trustedIds?: number[]
	invokeHost?: WireTransportDeps['invokeHost']
	invokeSimulator?: WireTransportDeps['invokeSimulator']
} = {}): Harness {
	const ipcMain = createFakeIpcMain()
	const bus = new EventBus()
	const senderPolicy = createFakeSenderPolicy(new Set(opts.trustedIds ?? []))
	const invokeHost = vi.fn(opts.invokeHost ?? (async () => 'host-ok' as JsonValue))
	const invokeSimulator = vi.fn(opts.invokeSimulator ?? (async () => 'sim-ok' as JsonValue))
	const transport = new WireTransport({
		ipcMain,
		bus,
		senderPolicy,
		trustedWebContents: () => [] as readonly MinimalWebContents[],
		invokeHost: invokeHost as WireTransportDeps['invokeHost'],
		invokeSimulator: invokeSimulator as WireTransportDeps['invokeSimulator'],
		declaredEvents: () => ['e1'],
	})
	return {
		transport,
		ipcMain,
		bus,
		invokeHost,
		invokeSimulator,
		getInvokeHandler: () => {
			const h = ipcMain.handlers.get(DeckChannel.Invoke)
			if (!h) throw new Error('invoke handler not registered')
			return h
		},
	}
}

const HOST_REQ = { kind: 'host', name: 'doThing', args: [1, 2] } as const

// ── tests ─────────────────────────────────────────────────────────────────

describe('WireTransport — invoke handler: main-frame trust (frame-level gating)', () => {
	// Bug it catches: a sub-frame inside a trusted webContents currently passes
	// because gating is senderId-only. The main frame must be ACCEPTED.
	it('trusted webContents + MAIN frame (senderFrame == mainFrame) → ok=true, dispatches to host', async () => {
		const h = makeHarness({ trustedIds: [7], invokeHost: async () => 'result-A' as JsonValue })
		h.transport.start()
		const invoke = h.getInvokeHandler()
		const mainFrame: FrameRef = { routingId: 1, processId: 100 }
		const res = (await invoke(
			{ sender: { id: 7, mainFrame }, senderFrame: mainFrame },
			HOST_REQ,
		)) as { ok: boolean, result?: JsonValue }
		expect(res.ok).toBe(true)
		expect(res.result).toBe('result-A')
		expect(h.invokeHost).toHaveBeenCalledTimes(1)
	})

	// Bug it catches: sub-frame of a TRUSTED webContents spoofing the trusted
	// sender. senderId check passes (id is trusted) but routingId differs from
	// the main frame → must be REJECTED with DECK_UNTRUSTED_FRAME, no dispatch.
	it('trusted webContents + SUB frame (senderFrame.routingId !== mainFrame) → reject DECK_UNTRUSTED_FRAME, no dispatch', async () => {
		const h = makeHarness({ trustedIds: [7] })
		h.transport.start()
		const invoke = h.getInvokeHandler()
		const mainFrame: FrameRef = { routingId: 1, processId: 100 }
		const subFrame: FrameRef = { routingId: 2, processId: 100 } // different routingId
		const res = (await invoke(
			{ sender: { id: 7, mainFrame }, senderFrame: subFrame },
			HOST_REQ,
		)) as { ok: boolean, error?: { remoteName: string, code?: string } }
		expect(res.ok).toBe(false)
		expect(res.error?.code).toBe(UNTRUSTED_FRAME)
		expect(res.error?.remoteName).toBe('doThing')
		expect(h.invokeHost).not.toHaveBeenCalled()
		expect(h.invokeSimulator).not.toHaveBeenCalled()
	})

	// Same-routingId but a DIFFERENT processId is still a foreign frame (OOPIF).
	it('trusted webContents + frame with same routingId but different processId → reject DECK_UNTRUSTED_FRAME', async () => {
		const h = makeHarness({ trustedIds: [7] })
		h.transport.start()
		const invoke = h.getInvokeHandler()
		const mainFrame: FrameRef = { routingId: 1, processId: 100 }
		const foreign: FrameRef = { routingId: 1, processId: 200 } // same routingId, diff process
		const res = (await invoke(
			{ sender: { id: 7, mainFrame }, senderFrame: foreign },
			HOST_REQ,
		)) as { ok: boolean, error?: { code?: string } }
		expect(res.ok).toBe(false)
		expect(res.error?.code).toBe(UNTRUSTED_FRAME)
		expect(h.invokeHost).not.toHaveBeenCalled()
	})

	// Bug it catches: navigate-after-send / frame-destroyed → senderFrame resolves
	// to null on a REAL (frame-modeled) event. Must fail-closed, NOT fall through
	// to allow. mainFrame is present (real event), so this is not a frame-unaware
	// stub.
	it('frame-modeled event with null senderFrame (navigate-after-send) → reject DECK_UNTRUSTED_FRAME (fail-closed)', async () => {
		const h = makeHarness({ trustedIds: [7] })
		h.transport.start()
		const invoke = h.getInvokeHandler()
		const mainFrame: FrameRef = { routingId: 1, processId: 100 }
		const res = (await invoke(
			{ sender: { id: 7, mainFrame }, senderFrame: null },
			HOST_REQ,
		)) as { ok: boolean, error?: { code?: string } }
		expect(res.ok).toBe(false)
		expect(res.error?.code).toBe(UNTRUSTED_FRAME)
		expect(h.invokeHost).not.toHaveBeenCalled()
		expect(h.invokeSimulator).not.toHaveBeenCalled()
	})

	// Symmetric fail-closed: senderFrame present but sender.mainFrame null.
	it('frame-modeled event with senderFrame present but mainFrame null → reject DECK_UNTRUSTED_FRAME (fail-closed)', async () => {
		const h = makeHarness({ trustedIds: [7] })
		h.transport.start()
		const invoke = h.getInvokeHandler()
		const res = (await invoke(
			{ sender: { id: 7, mainFrame: null }, senderFrame: { routingId: 1, processId: 100 } },
			HOST_REQ,
		)) as { ok: boolean, error?: { code?: string } }
		expect(res.ok).toBe(false)
		expect(res.error?.code).toBe(UNTRUSTED_FRAME)
		expect(h.invokeHost).not.toHaveBeenCalled()
	})

	// Backward compat: frame-unaware stub (NEITHER senderFrame NOR mainFrame
	// modeled). This is exactly the shape every existing wire-transport.test.ts
	// case uses. The frame check MUST be skipped (senderId still gates) so we
	// don't break the existing suite.
	it('frame-unaware stub (no senderFrame, no mainFrame) trusted sender → still ok=true (backward compat)', async () => {
		const h = makeHarness({ trustedIds: [7], invokeHost: async () => 'compat-ok' as JsonValue })
		h.transport.start()
		const invoke = h.getInvokeHandler()
		// Exactly the legacy event shape: { sender: { id } }, nothing else.
		const res = (await invoke(
			{ sender: { id: 7 } } as FrameEvent,
			HOST_REQ,
		)) as { ok: boolean, result?: JsonValue }
		expect(res.ok).toBe(true)
		expect(res.result).toBe('compat-ok')
		expect(h.invokeHost).toHaveBeenCalledTimes(1)
	})

	// Ordering / precedence: an UNTRUSTED sender id is rejected as UNTRUSTED_SENDER
	// regardless of frame — the senderId gate still fires (frame check is
	// defense-in-depth ON TOP of it, not a replacement). This pins that the new
	// frame code does not shadow / replace the existing senderId rejection.
	it('untrusted sender id even with a valid main frame → still UNTRUSTED_SENDER (senderId gate unchanged)', async () => {
		const h = makeHarness({ trustedIds: [] }) // nobody trusted
		h.transport.start()
		const invoke = h.getInvokeHandler()
		const mainFrame: FrameRef = { routingId: 1, processId: 100 }
		const res = (await invoke(
			{ sender: { id: 42, mainFrame }, senderFrame: mainFrame },
			HOST_REQ,
		)) as { ok: boolean, error?: { code?: string } }
		expect(res.ok).toBe(false)
		expect(res.error?.code).toBe('DECK_UNTRUSTED_SENDER')
		expect(h.invokeHost).not.toHaveBeenCalled()
	})
})
