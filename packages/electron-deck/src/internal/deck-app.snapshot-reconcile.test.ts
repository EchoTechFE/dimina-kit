/**
 * Hardening tests for the snapshot reconcile logic in DeckApp:
 * detach-from-absence, all-invalid-no-detach, generation reset after
 * layout-subscribe (reload), and stale-epoch rejection within the same
 * generation. These complement deck-app.slot-token.test.ts which covers
 * the basic apply / anti-spoof / revoke contract.
 */
import { describe, expect, it, vi } from 'vitest'
import type { JsonValue, Runtime, ViewPlacement } from '../types.js'
import type {
	MinimalBrowserWindow,
	MinimalBrowserWindowOptions,
	MinimalElectron,
	MinimalRect,
	MinimalWebContentsLike,
	MinimalWebContentsView,
} from './electron-types.js'
import { DeckApp } from './deck-app.js'
import type { MinimalIpcMain } from './wire-transport.js'

const SNAPSHOT_CHANNEL = '__electron-deck:snapshot'
const SLOT_GRANT_CHANNEL = '__electron-deck:slot-grant'
const LAYOUT_SUBSCRIBE_CHANNEL = '__electron-deck:layout-subscribe'

// ── Compact fakes ─────────────────────────────────────────────────────────────

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

interface FakeWebContentsLike extends MinimalWebContentsLike {
	loadURL: ReturnType<typeof vi.fn> & MinimalWebContentsLike['loadURL']
	loadFile: ReturnType<typeof vi.fn> & MinimalWebContentsLike['loadFile']
	send: ReturnType<typeof vi.fn> & MinimalWebContentsLike['send']
	destroyed: boolean
}

interface FakeBrowserWindow extends MinimalBrowserWindow {
	readonly webContents: FakeWebContentsLike
	getContentBounds: ReturnType<typeof vi.fn> & MinimalBrowserWindow['getContentBounds']
	show: ReturnType<typeof vi.fn> & MinimalBrowserWindow['show']
	destroy: ReturnType<typeof vi.fn> & MinimalBrowserWindow['destroy']
	on: ReturnType<typeof vi.fn> & MinimalBrowserWindow['on']
	contentView: MinimalBrowserWindow['contentView'] & {
		addChildView: ReturnType<typeof vi.fn>
		removeChildView: ReturnType<typeof vi.fn>
	}
	destroyed: boolean
}

interface FakeWebContentsView extends MinimalWebContentsView {
	readonly webContents: FakeWebContentsLike
	setBounds: ReturnType<typeof vi.fn> & MinimalWebContentsView['setBounds']
	destroyed: boolean
}

interface FakeElectron extends MinimalElectron {
	browserWindows: FakeBrowserWindow[]
	webContentsViews: FakeWebContentsView[]
	browserWindowCtorCalls: MinimalBrowserWindowOptions[]
	webContentsViewCtorCalls: Array<{ webPreferences?: { preload?: string } } | undefined>
}

function createFakeElectron(
	initialContentBounds: MinimalRect = { x: 0, y: 0, width: 1024, height: 768 },
): FakeElectron {
	let wcIdCounter = 100
	let winIdCounter = 1
	const browserWindows: FakeBrowserWindow[] = []
	const webContentsViews: FakeWebContentsView[] = []
	const browserWindowCtorCalls: MinimalBrowserWindowOptions[] = []
	const webContentsViewCtorCalls: Array<{ webPreferences?: { preload?: string } } | undefined> = []

	function makeFakeWC(): FakeWebContentsLike {
		const id = wcIdCounter++
		const wc: FakeWebContentsLike = {
			id,
			destroyed: false,
			loadURL: vi.fn(async () => undefined) as FakeWebContentsLike['loadURL'],
			loadFile: vi.fn(async () => undefined) as FakeWebContentsLike['loadFile'],
			send: vi.fn() as FakeWebContentsLike['send'],
			isDestroyed: () => wc.destroyed,
		}
		return wc
	}

	class FakeBW implements MinimalBrowserWindow {
		readonly id: number
		readonly webContents: FakeWebContentsLike
		readonly contentView: FakeBrowserWindow['contentView']
		destroyed = false
		getContentBounds: FakeBrowserWindow['getContentBounds']
		show: FakeBrowserWindow['show']
		destroy: FakeBrowserWindow['destroy']
		on: FakeBrowserWindow['on']

		constructor(opts?: MinimalBrowserWindowOptions) {
			browserWindowCtorCalls.push(opts ?? {})
			this.id = winIdCounter++
			this.webContents = makeFakeWC()
			const cv = { addChildView: vi.fn(), removeChildView: vi.fn() }
			this.contentView = cv as FakeBrowserWindow['contentView']
			this.getContentBounds = vi.fn(() => initialContentBounds) as FakeBrowserWindow['getContentBounds']
			this.show = vi.fn() as FakeBrowserWindow['show']
			this.destroy = vi.fn(() => {
				this.destroyed = true
				this.webContents.destroyed = true
			}) as FakeBrowserWindow['destroy']
			this.on = vi.fn(() => this) as FakeBrowserWindow['on']
			browserWindows.push(this as unknown as FakeBrowserWindow)
		}

		isDestroyed(): boolean { return this.destroyed }
	}

	class FakeWCV implements MinimalWebContentsView {
		readonly webContents: FakeWebContentsLike
		setBounds: FakeWebContentsView['setBounds']
		destroyed = false

		constructor(opts?: { webPreferences?: { preload?: string } }) {
			webContentsViewCtorCalls.push(opts)
			this.webContents = makeFakeWC()
			this.setBounds = vi.fn() as FakeWebContentsView['setBounds']
			webContentsViews.push(this as unknown as FakeWebContentsView)
		}
	}

	return {
		BrowserWindow: FakeBW as unknown as MinimalElectron['BrowserWindow'],
		WebContentsView: FakeWCV as unknown as MinimalElectron['WebContentsView'],
		browserWindows,
		webContentsViews,
		browserWindowCtorCalls,
		webContentsViewCtorCalls,
	}
}

// ── helpers ───────────────────────────────────────────────────────────────────

interface ViewSource { url?: string, file?: string }
interface HostViewHandle {
	placeIn(win: unknown, opts: { zone?: number, anchor?: string }): HostViewHandle
	applyPlacement(p: ViewPlacement): HostViewHandle
	dispose(): Promise<void>
}
function withView(runtime: Runtime) {
	return runtime as unknown as {
		view(spec: { source: ViewSource }): HostViewHandle
	}
}

interface SlotGrant {
	viewId: string
	slotId: string
	slotToken: string
	generation: number
}

function lastSlotGrant(wc: FakeWebContentsLike): SlotGrant {
	const calls = (wc.send as ReturnType<typeof vi.fn>).mock.calls
	for (let i = calls.length - 1; i >= 0; i--) {
		const [ch, pay] = calls[i] as [string, unknown]
		if (ch === SLOT_GRANT_CHANNEL) return pay as SlotGrant
	}
	throw new Error(`no "${SLOT_GRANT_CHANNEL}" was sent to wc#${wc.id}`)
}

function mainFrameEvent(senderId: number): FrameEvent {
	const frame: FrameRef = { routingId: 1, processId: 1000 + senderId }
	return { sender: { id: senderId, mainFrame: frame }, senderFrame: frame }
}

function buildSnapshot(
	views: Array<{ slotToken: string; placement: object }>,
	generation: number,
	epoch: number,
) {
	return {
		generation,
		epoch,
		views: views.map(v => ({ placement: v.placement, extra: { slotToken: v.slotToken } })),
	}
}

function getHandler(ipcMain: FakeIpcMain, channel: string): Handler {
	const h = ipcMain.handlers.get(channel)
	if (!h) throw new Error(`handler for "${channel}" not registered`)
	return h
}

async function bootApp() {
	const electron = createFakeElectron()
	const ipcMain = createFakeIpcMain()
	const app = new DeckApp({}, { electron, wireTransport: { ipcMain } })
	await app.start()
	const mainWc = (electron.browserWindows[0] as unknown as FakeBrowserWindow).webContents
	return { app, electron, ipcMain, mainWc, mainWcId: mainWc.id }
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. detach-from-absence: a view absent from a non-empty snapshot is detached.
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp snapshot-reconcile — detach-from-absence', () => {
	it('a view omitted from a later snapshot (but present in actual) is detached via removeChildView', async () => {
		const { app, electron, ipcMain, mainWc, mainWcId } = await bootApp()
		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow

		// Place two anchored views.
		const handleA = withView(app.runtime).view({ source: { url: 'data:text/html,a' } })
		const wcvA = electron.webContentsViews[electron.webContentsViews.length - 1]!
		handleA.placeIn(app.runtime.mainWindow, { zone: 0, anchor: '#slotA' })
		const grantA = lastSlotGrant(mainWc)

		const handleB = withView(app.runtime).view({ source: { url: 'data:text/html,b' } })
		const wcvB = electron.webContentsViews[electron.webContentsViews.length - 1]!
		handleB.placeIn(app.runtime.mainWindow, { zone: 1, anchor: '#slotB' })
		const grantB = lastSlotGrant(mainWc)

		const gen = grantA.generation // both grants on same wc → same generation

		const snapshotHandler = getHandler(ipcMain, SNAPSHOT_CHANNEL)

		// Snapshot A (epoch 0): both visible.
		await snapshotHandler(
			mainFrameEvent(mainWcId),
			buildSnapshot(
				[
					{ slotToken: grantA.slotToken, placement: { visible: true, bounds: { x: 0, y: 0, width: 100, height: 100 } } },
					{ slotToken: grantB.slotToken, placement: { visible: true, bounds: { x: 100, y: 0, width: 100, height: 100 } } },
				],
				gen,
				0,
			),
		)
		expect(wcvA.setBounds).toHaveBeenCalled()
		expect(wcvB.setBounds).toHaveBeenCalled()

		const removesBefore = mainWin.contentView.removeChildView.mock.calls.length

		// Snapshot B (epoch 1): only view A — view B is absent, triggering detach.
		await snapshotHandler(
			mainFrameEvent(mainWcId),
			buildSnapshot(
				[
					{ slotToken: grantA.slotToken, placement: { visible: true, bounds: { x: 0, y: 0, width: 100, height: 100 } } },
				],
				gen,
				1,
			),
		)

		expect(mainWin.contentView.removeChildView.mock.calls.length).toBeGreaterThan(removesBefore)
		expect(mainWin.contentView.removeChildView).toHaveBeenCalledWith(wcvB)

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// 10. Q1 all-invalid → whole snapshot rejected, prior views NOT detached.
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp snapshot-reconcile — all-invalid snapshot not detached', () => {
	it('a snapshot whose views all fail authorization is rejected wholesale (prior view remains, no detach)', async () => {
		const { app, electron, ipcMain, mainWc, mainWcId } = await bootApp()
		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow

		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = electron.webContentsViews[electron.webContentsViews.length - 1]!
		handle.placeIn(app.runtime.mainWindow, { zone: 0, anchor: '#sim' })
		const grant = lastSlotGrant(mainWc)

		const snapshotHandler = getHandler(ipcMain, SNAPSHOT_CHANNEL)

		// Epoch 0: place the view visibly so the reconciler records it in actual.
		await snapshotHandler(
			mainFrameEvent(mainWcId),
			buildSnapshot(
				[{ slotToken: grant.slotToken, placement: { visible: true, bounds: { x: 0, y: 0, width: 50, height: 50 } } }],
				grant.generation,
				0,
			),
		)
		expect(wcv.setBounds).toHaveBeenCalled()

		const removesBefore = mainWin.contentView.removeChildView.mock.calls.length

		// Epoch 1: send a snapshot with only UNKNOWN tokens → non-empty but fully
		// unauthorized → cleanSnapshot returns null → handleSnapshot drops it.
		// The reconciler must NOT interpret this as "detach everything".
		await snapshotHandler(
			mainFrameEvent(mainWcId),
			buildSnapshot(
				[{ slotToken: 'unknown-token-xyz', placement: { visible: true, bounds: { x: 9, y: 9, width: 9, height: 9 } } }],
				grant.generation,
				1,
			),
		)

		expect(mainWin.contentView.removeChildView.mock.calls.length).toBe(removesBefore)

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// 11. generation reset after layout-subscribe (reload semantics).
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp snapshot-reconcile — generation reset on layout-subscribe', () => {
	it('after layout-subscribe bumps the generation, a snapshot at the new generation + epoch 0 is accepted', async () => {
		const { app, electron, ipcMain, mainWc, mainWcId } = await bootApp()

		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = electron.webContentsViews[electron.webContentsViews.length - 1]!
		handle.placeIn(app.runtime.mainWindow, { zone: 0, anchor: '#sim' })
		const grant = lastSlotGrant(mainWc)

		const snapshotHandler = getHandler(ipcMain, SNAPSHOT_CHANNEL)
		const layoutSubscribeHandler = getHandler(ipcMain, LAYOUT_SUBSCRIBE_CHANNEL)

		// Send at initial generation, high epoch.
		await snapshotHandler(
			mainFrameEvent(mainWcId),
			buildSnapshot(
				[{ slotToken: grant.slotToken, placement: { visible: true, bounds: { x: 0, y: 0, width: 10, height: 10 } } }],
				grant.generation,
				99,
			),
		)
		expect(wcv.setBounds).toHaveBeenCalled()

		// Simulate reload: layout-subscribe bumps generation + resets reconciler.
		await layoutSubscribeHandler(mainFrameEvent(mainWcId))

		// The resent grant carries the new (bumped) generation.
		const newGrant = lastSlotGrant(mainWc)
		expect(newGrant.generation).toBeGreaterThan(grant.generation)

		const setBoundsBefore = wcv.setBounds.mock.calls.length

		// New generation + epoch 0: must be accepted (not stale-rejected).
		await snapshotHandler(
			mainFrameEvent(mainWcId),
			buildSnapshot(
				[{ slotToken: newGrant.slotToken, placement: { visible: true, bounds: { x: 5, y: 5, width: 20, height: 20 } } }],
				newGrant.generation,
				0,
			),
		)

		expect(wcv.setBounds.mock.calls.length).toBeGreaterThan(setBoundsBefore)

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// 12. stale epoch within same generation is silently ignored.
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp snapshot-reconcile — stale epoch rejected within same generation', () => {
	it('a snapshot with epoch <= lastEpoch for the same generation is a no-op (not an error)', async () => {
		const { app, electron, ipcMain, mainWc, mainWcId } = await bootApp()

		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = electron.webContentsViews[electron.webContentsViews.length - 1]!
		handle.placeIn(app.runtime.mainWindow, { zone: 0, anchor: '#sim' })
		const grant = lastSlotGrant(mainWc)

		const snapshotHandler = getHandler(ipcMain, SNAPSHOT_CHANNEL)

		const boundsA = { x: 0, y: 0, width: 10, height: 10 }
		// Epoch 5: accepted, becomes lastEpoch.
		await snapshotHandler(
			mainFrameEvent(mainWcId),
			buildSnapshot(
				[{ slotToken: grant.slotToken, placement: { visible: true, bounds: boundsA } }],
				grant.generation,
				5,
			),
		)
		expect(wcv.setBounds).toHaveBeenCalledWith(boundsA)
		const countAfterFirst = wcv.setBounds.mock.calls.length

		// Epoch 5 again (== lastEpoch): stale, no-op.
		await snapshotHandler(
			mainFrameEvent(mainWcId),
			buildSnapshot(
				[{ slotToken: grant.slotToken, placement: { visible: true, bounds: { x: 9, y: 9, width: 9, height: 9 } } }],
				grant.generation,
				5,
			),
		)
		expect(wcv.setBounds.mock.calls.length).toBe(countAfterFirst)

		// Epoch 3 (< lastEpoch): also stale, no-op.
		await snapshotHandler(
			mainFrameEvent(mainWcId),
			buildSnapshot(
				[{ slotToken: grant.slotToken, placement: { visible: true, bounds: { x: 9, y: 9, width: 9, height: 9 } } }],
				grant.generation,
				3,
			),
		)
		expect(wcv.setBounds.mock.calls.length).toBe(countAfterFirst)

		await app.shutdown()
	})
})

// Parity ref so an unused-import lint never masks a runtime failure.
const _jsonParityRef: JsonValue = null
void _jsonParityRef
