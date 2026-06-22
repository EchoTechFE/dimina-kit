/**
 * EAGER ARMING of the slot-token layout channels.
 *
 * Without eager arming the Place + LayoutSubscribe ipc handlers are armed
 * LAZILY — `ensureSlotChannelsArmed()` (deck-app.ts ~1095)
 * calls `wireTransport.armSlotChannels(...)`, and its ONLY call site is the
 * anchored `placeIn` path (~1569). So a `createDeckLayoutClient` that boots
 * BEFORE any view is placed sends `__electron-deck:layout-subscribe` and main
 * rejects with "No handler registered for layout-subscribe".
 *
 * The contract: the slot channels must be armed at framework START (when the
 * wire transport binds) so a layout client can subscribe before the first
 * anchored placeIn. THE GATE MUST STAY IDENTICAL — eager arming widens no
 * attack surface (trust + main-frame + token checks intact).
 *
 * What each spec pins:
 *   - A1: with NO views placed, the layout-subscribe handler must already be
 *         present (armed eagerly) → `handlers.has(...)` is true.
 *   - A3: the place handler is likewise present at framework START.
 *   - A2: the gate-unchanged pin proves the untrusted-sender DROP still holds
 *         once the handler is armed eagerly.
 *
 * Reached through the SAME typed escape hatch + fakes pattern as
 * `deck-app.slot-token.test.ts` so the file COMPILES.
 *
 * Channel string literals are used directly (matching the slot-token test) so
 * the pin reads exactly what the renderer wire sends.
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

const PLACE_CHANNEL = '__electron-deck:place'
const LAYOUT_SUBSCRIBE_CHANNEL = '__electron-deck:layout-subscribe'

// ── Minimal fakes (mirrors deck-app.slot-token.test.ts) ──────────────────────

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
	_listeners: Map<string, Array<(...args: unknown[]) => void>>
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

	function makeFakeWebContents(): FakeWebContentsLike {
		const id = wcIdCounter++
		const wc: FakeWebContentsLike = {
			id,
			destroyed: false,
			loadURL: vi.fn(async (_u: string) => undefined) as FakeWebContentsLike['loadURL'],
			loadFile: vi.fn(async (_p: string) => undefined) as FakeWebContentsLike['loadFile'],
			send: vi.fn() as FakeWebContentsLike['send'],
			isDestroyed: () => wc.destroyed,
		}
		return wc
	}

	class FakeBW implements MinimalBrowserWindow {
		readonly id: number
		readonly webContents: FakeWebContentsLike
		readonly contentView: FakeBrowserWindow['contentView']
		destroyed: boolean
		getContentBounds: FakeBrowserWindow['getContentBounds']
		show: FakeBrowserWindow['show']
		destroy: FakeBrowserWindow['destroy']
		on: FakeBrowserWindow['on']
		_listeners: Map<string, Array<(...args: unknown[]) => void>>

		constructor(opts?: MinimalBrowserWindowOptions) {
			browserWindowCtorCalls.push(opts ?? {})
			this.id = winIdCounter++
			this.webContents = makeFakeWebContents()
			this.destroyed = false
			const cv = {
				addChildView: vi.fn(),
				removeChildView: vi.fn(),
			}
			this.contentView = cv as FakeBrowserWindow['contentView']
			this.getContentBounds = vi.fn(() => initialContentBounds) as FakeBrowserWindow['getContentBounds']
			this.show = vi.fn() as FakeBrowserWindow['show']
			this.destroy = vi.fn(() => {
				this.destroyed = true
				this.webContents.destroyed = true
			}) as FakeBrowserWindow['destroy']
			this._listeners = new Map()
			this.on = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
				let arr = this._listeners.get(event)
				if (!arr) {
					arr = []
					this._listeners.set(event, arr)
				}
				arr.push(listener)
				return this
			}) as FakeBrowserWindow['on']
			browserWindows.push(this as unknown as FakeBrowserWindow)
		}

		isDestroyed(): boolean {
			return this.destroyed
		}
	}

	class FakeWCV implements MinimalWebContentsView {
		readonly webContents: FakeWebContentsLike
		setBounds: FakeWebContentsView['setBounds']
		destroyed: boolean

		constructor(opts?: { webPreferences?: { preload?: string } }) {
			webContentsViewCtorCalls.push(opts)
			this.webContents = makeFakeWebContents()
			this.setBounds = vi.fn() as FakeWebContentsView['setBounds']
			this.destroyed = false
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

// ── Typed escape hatch for the not-yet-typed slot-token surface ──────────────
interface ViewSource { url?: string, file?: string }
interface HostViewHandle {
	placeIn(win: unknown, opts: { zone?: number, anchor?: string }): HostViewHandle
	applyPlacement(p: ViewPlacement): HostViewHandle
	dispose(): Promise<void>
}
interface RuntimeWithView {
	view(spec: { source: ViewSource, scope?: unknown }): HostViewHandle
}
function withView(runtime: Runtime): RuntimeWithView {
	return runtime as unknown as RuntimeWithView
}

// Build a frame-modeled event whose senderFrame === mainFrame (genuine
// main-frame sender so the gate passes when the id is trusted).
function mainFrameEvent(senderId: number): FrameEvent {
	const frame: FrameRef = { routingId: 1, processId: 1000 + senderId }
	return { sender: { id: senderId, mainFrame: frame }, senderFrame: frame }
}

// An UNtrusted sender: a wc id never trusted by the framework (no main window,
// no _trustWebContents). Frame is a genuine main frame so the ONLY reason the
// gate drops it is the trust check.
function untrustedMainFrameEvent(senderId: number): FrameEvent {
	const frame: FrameRef = { routingId: 1, processId: 9000 + senderId }
	return { sender: { id: senderId, mainFrame: frame }, senderFrame: frame }
}

function getLayoutSubscribeHandler(ipcMain: FakeIpcMain): Handler {
	const h = ipcMain.handlers.get(LAYOUT_SUBSCRIBE_CHANNEL)
	if (!h) throw new Error(`"${LAYOUT_SUBSCRIBE_CHANNEL}" handler not registered (armed lazily? expected eager at start())`)
	return h
}

function getPlaceHandler(ipcMain: FakeIpcMain): Handler {
	const h = ipcMain.handlers.get(PLACE_CHANNEL)
	if (!h) throw new Error(`"${PLACE_CHANNEL}" handler not registered (armed lazily? expected eager at start())`)
	return h
}

// Boot an app that places NO views (no anchored placeIn → lazy arming never
// fires → today the slot channels are absent).
async function bootAppNoViews(): Promise<{
	app: DeckApp
	electron: FakeElectron
	ipcMain: FakeIpcMain
	mainWc: FakeWebContentsLike
	mainWcId: number
}> {
	const electron = createFakeElectron()
	const ipcMain = createFakeIpcMain()
	const app = new DeckApp({}, { electron, wireTransport: { ipcMain } })
	await app.start()
	const mainWc = (electron.browserWindows[0] as unknown as FakeBrowserWindow).webContents
	return { app, electron, ipcMain, mainWc, mainWcId: mainWc.id }
}

// ─────────────────────────────────────────────────────────────────────────────
// A1 — layout-subscribe is armed at START (no views placed).
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp eager-arm — layout-subscribe armed at start()', () => {
	it('A1) immediately after start() with NO views, the layout-subscribe handler IS registered and a trusted main-frame subscribe RESOLVES (not "no handler")', async () => {
		const { app, ipcMain, mainWcId } = await bootAppNoViews()

		// PIN: the handler exists at start() — armed eagerly when the wire
		// transport binds, so it is present even with no views placed.
		expect(ipcMain.handlers.has(LAYOUT_SUBSCRIBE_CHANNEL)).toBe(true)

		// And invoking it from a trusted main-frame sender resolves (no "No handler
		// registered for layout-subscribe" reject). With no grants it simply
		// replays nothing — but it MUST NOT throw "no handler".
		const layoutSubscribe = getLayoutSubscribeHandler(ipcMain)
		await expect(
			Promise.resolve(layoutSubscribe(mainFrameEvent(mainWcId))),
		).resolves.not.toThrow()

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// A2 — GATE UNCHANGED by eager arming (untrusted sender still DROPPED).
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp eager-arm — gate unchanged (SECURITY)', () => {
	it('A2) an UNtrusted sender place/layout-subscribe is still DROPPED even though the channel is armed at start (no widened attack surface)', async () => {
		const { app, electron, ipcMain } = await bootAppNoViews()

		// Place a view WITH an anchor so a real grant + slotToken exists; eager
		// arming must not have changed the gate that protects the apply path.
		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = electron.webContentsViews[electron.webContentsViews.length - 1]!
		handle.placeIn(app.runtime.mainWindow, { zone: 0, anchor: '#sim' })

		// Pull the granted token off the main wc's slot-grant push.
		const mainWc = (electron.browserWindows[0] as unknown as FakeBrowserWindow).webContents
		const sendCalls = (mainWc.send as ReturnType<typeof vi.fn>).mock.calls
		const grantCall = [...sendCalls].reverse().find(c => c[0] === '__electron-deck:slot-grant')
		const slotToken = (grantCall?.[1] as { slotToken?: string } | undefined)?.slotToken
		expect(typeof slotToken).toBe('string')

		const place = getPlaceHandler(ipcMain)
		const before = wcv.setBounds.mock.calls.length

		// An UNtrusted wc presents the (valid) token. The trust gate — unchanged
		// by eager arming — must DROP it: no setBounds.
		const untrustedId = 424242 // never trusted
		await place(untrustedMainFrameEvent(untrustedId), {
			slotToken,
			placement: { visible: true, bounds: { x: 9, y: 9, width: 9, height: 9 } },
		})

		expect(wcv.setBounds.mock.calls.length).toBe(before)

		// And an untrusted layout-subscribe is a silent drop too (no throw).
		const layoutSubscribe = getLayoutSubscribeHandler(ipcMain)
		await expect(
			Promise.resolve(layoutSubscribe(untrustedMainFrameEvent(untrustedId))),
		).resolves.not.toThrow()

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// A3 — Place handler likewise armed at start (token-gated, not "no handler").
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp eager-arm — place armed at start()', () => {
	it('A3) immediately after start() with NO views, the place handler IS registered; a trusted-sender place with an UNKNOWN token is token-gated DROP (not a "no handler" reject)', async () => {
		const { app, ipcMain, mainWcId } = await bootAppNoViews()

		// PIN: the place handler exists at start() — armed eagerly.
		expect(ipcMain.handlers.has(PLACE_CHANNEL)).toBe(true)

		const place = getPlaceHandler(ipcMain)
		// Trusted main-frame sender, but the token is unknown (no view minted one).
		// The handler must be PRESENT and silently DROP on the token check — it must
		// NOT reject with "no handler registered".
		await expect(
			Promise.resolve(
				place(mainFrameEvent(mainWcId), {
					slotToken: 'no-such-token',
					placement: { visible: true, bounds: { x: 0, y: 0, width: 1, height: 1 } },
				}),
			),
		).resolves.not.toThrow()

		await app.shutdown()
	})
})

// Parity ref so an unused-import lint never masks a runtime failure.
const _jsonParityRef: JsonValue = null
void _jsonParityRef
