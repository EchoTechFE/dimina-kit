/**
 * TDD failing-first contract tests for "slot-token main-process plumbing"
 * (view-handle.md「slot-token 握手」/ capability-and-lifecycle.md「anchor slotToken 原子下发」) — the deck-app side:
 * the per-view slot-grant PUSH, the secure `__electron-deck:place` apply path
 * with anti-spoof, the per-wc layout-subscribe REPLAY, and token revocation on
 * view dispose.
 *
 * Source of truth: docs/contracts/capability-and-lifecycle.md「anchor slotToken 原子下发」+
 * docs/contracts/view-handle.md「slot-token 握手」+「slot-token replay 分桶」.
 *
 * What does NOT exist yet:
 *   - `runtime.view(...).placeIn(win, { anchor })` minting a slotToken and
 *     pushing `win.webContents.send('__electron-deck:slot-grant', {...})`.
 *   - the deck-app `onPlace` handler (token table + anti-spoof + placement
 *     validation) wired into WireTransport's `__electron-deck:place` channel.
 *   - the `onLayoutSubscribe` per-wc replay over `__electron-deck:layout-subscribe`.
 *
 * So every spec here is RED at RUNTIME: either the slot-grant `send` never
 * fires (so the token-capture helper throws / asserts fail) OR the place handler
 * is never registered (so `ipcMain.handlers.get('__electron-deck:place')` is
 * undefined). Reached through a single typed escape hatch (`withView`) so the
 * file COMPILES — the RED is a missing-member / never-called assertion, not a
 * type error.
 *
 * Channel string literals are used directly ('__electron-deck:place',
 * '__electron-deck:slot-grant', '__electron-deck:layout-subscribe') because the
 * corresponding `DeckChannel.*` members do not exist yet — importing them would
 * be a compile error rather than a clean runtime RED.
 *
 * Fakes copied (minimal) from deck-app.host-view.test.ts: `createFakeElectron`
 * (FakeBrowserWindow with addChildView/removeChildView spies + FakeWebContents
 * with a `send` spy + a stable `webContents.id`) and `createFakeIpcMain` (a
 * `handlers` Map so we can drive the `__electron-deck:place` /
 * `__electron-deck:layout-subscribe` handlers directly).
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
const SLOT_GRANT_CHANNEL = '__electron-deck:slot-grant'
const LAYOUT_SUBSCRIBE_CHANNEL = '__electron-deck:layout-subscribe'

// ── Minimal fakes (copied from deck-app.host-view.test.ts) ───────────────────

// Frame-aware event shape so the place handler's main-frame gate sees a real
// main frame (mirrors wire-transport.frame-trust.test.ts). All sends here come
// from the main frame of the authorized wc.
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
	_emit(event: 'resize' | 'closed' | 'close'): void
	_lastCloseEvent: { preventDefault: ReturnType<typeof vi.fn> } | null
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
		_lastCloseEvent: { preventDefault: ReturnType<typeof vi.fn> } | null

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
			this._lastCloseEvent = null
			this.on = vi.fn((event: 'resize' | 'closed' | 'close', listener: (...args: unknown[]) => void) => {
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

		_emit(event: 'resize' | 'closed' | 'close'): void {
			const arr = this._listeners.get(event)
			if (!arr) return
			if (event === 'close') {
				const ev = { preventDefault: vi.fn() }
				this._lastCloseEvent = ev
				for (const fn of arr) fn(ev)
				return
			}
			for (const fn of arr) fn()
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
//
// `placeIn`'s `anchor` option is already in the public type (stored-but-unused);
// what's missing is the slot-grant push + the place handler. We reach `view`
// through a loose view so absence fails at RUNTIME (no send / no handler).
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

// The slot-grant payload the framework pushes to the authorized wc.
interface SlotGrant {
	viewId: string
	slotId: string
	slotToken: string
}

function lastWcv(electron: FakeElectron): FakeWebContentsView {
	const wcv = electron.webContentsViews[electron.webContentsViews.length - 1]
	if (!wcv) throw new Error('no WebContentsView was constructed')
	return wcv
}

// Pull the most recent slot-grant the framework `send`-pushed to `wc`. RED guard:
// if the framework never sends a slot-grant, this throws → the test fails loud.
function lastSlotGrant(wc: FakeWebContentsLike): SlotGrant {
	const calls = (wc.send as ReturnType<typeof vi.fn>).mock.calls
	for (let i = calls.length - 1; i >= 0; i -= 1) {
		const [channel, payload] = calls[i] as [string, unknown]
		if (channel === SLOT_GRANT_CHANNEL) {
			return payload as SlotGrant
		}
	}
	throw new Error(`no "${SLOT_GRANT_CHANNEL}" was sent to wc#${wc.id}`)
}

function countSlotGrants(wc: FakeWebContentsLike, slotToken?: string): number {
	const calls = (wc.send as ReturnType<typeof vi.fn>).mock.calls
	return calls.filter((c) => {
		if (c[0] !== SLOT_GRANT_CHANNEL) return false
		if (slotToken === undefined) return true
		return (c[1] as SlotGrant)?.slotToken === slotToken
	}).length
}

function getPlaceHandler(ipcMain: FakeIpcMain): Handler {
	const h = ipcMain.handlers.get(PLACE_CHANNEL)
	if (!h) throw new Error(`"${PLACE_CHANNEL}" handler not registered`)
	return h
}

function getLayoutSubscribeHandler(ipcMain: FakeIpcMain): Handler {
	const h = ipcMain.handlers.get(LAYOUT_SUBSCRIBE_CHANNEL)
	if (!h) throw new Error(`"${LAYOUT_SUBSCRIBE_CHANNEL}" handler not registered`)
	return h
}

// Build a frame-modeled event for the given wc id whose senderFrame === mainFrame
// (a genuine main-frame sender so the gate passes when the id is trusted).
function mainFrameEvent(senderId: number): FrameEvent {
	const frame: FrameRef = { routingId: 1, processId: 1000 + senderId }
	return { sender: { id: senderId, mainFrame: frame }, senderFrame: frame }
}

async function bootApp(): Promise<{
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
// 1. placeIn({anchor}) pushes a slot-grant to the authorized wc.
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp slot-token — placeIn({anchor}) pushes slot-grant', () => {
	it('1) placeIn(mainWindow,{zone:0,anchor:"#sim"}) sends __electron-deck:slot-grant with a non-empty token + matching viewId', async () => {
		const { app, electron, mainWc } = await bootApp()

		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		lastWcv(electron) // ensure a WCV was constructed for this view
		handle.placeIn(app.runtime.mainWindow, { zone: 0, anchor: '#sim' })

		// The framework pushed a slot-grant to the authorized window's wc.
		const sendCalls = (mainWc.send as ReturnType<typeof vi.fn>).mock.calls
			.filter(c => c[0] === SLOT_GRANT_CHANNEL)
		expect(sendCalls.length).toBe(1)

		const grant = lastSlotGrant(mainWc)
		expect(typeof grant.slotToken).toBe('string')
		expect(grant.slotToken.length).toBeGreaterThan(0)
		expect(grant.slotId).toBe('#sim')
		expect(typeof grant.viewId).toBe('string')
		expect(grant.viewId.length).toBeGreaterThan(0)

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. authorized wc + granted token → setBounds with those bounds.
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp slot-token — authorized place drives setBounds', () => {
	it('2) place from the authorized wc with the granted token + visible bounds → WCV setBounds(those bounds)', async () => {
		const { app, electron, ipcMain, mainWc, mainWcId } = await bootApp()

		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)
		handle.placeIn(app.runtime.mainWindow, { zone: 0, anchor: '#sim' })
		const { slotToken } = lastSlotGrant(mainWc)

		const place = getPlaceHandler(ipcMain)
		await place(mainFrameEvent(mainWcId), {
			slotToken,
			placement: { visible: true, bounds: { x: 10, y: 20, width: 300, height: 200 } },
		})

		expect(wcv.setBounds).toHaveBeenCalledWith({ x: 10, y: 20, width: 300, height: 200 })

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. ANTI-SPOOF (security): a different trusted wc using the same token → DROP.
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp slot-token — anti-spoof (SECURITY)', () => {
	it('3) place from a DIFFERENT trusted wc using the same token → DROPPED (no setBounds)', async () => {
		const { app, electron, ipcMain, mainWc, mainWcId } = await bootApp()

		// Trust a second, unrelated webContents (a different control wc).
		const otherWc = { id: mainWcId + 777, isDestroyed: () => false, send: vi.fn() }
		app._trustWebContents(otherWc as unknown as Parameters<DeckApp['_trustWebContents']>[0])

		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)
		handle.placeIn(app.runtime.mainWindow, { zone: 0, anchor: '#sim' })
		const { slotToken } = lastSlotGrant(mainWc)

		const before = wcv.setBounds.mock.calls.length
		const place = getPlaceHandler(ipcMain)
		// otherWc is trusted + main-frame, but is NOT the wc the token was granted to.
		await place(mainFrameEvent(otherWc.id), {
			slotToken,
			placement: { visible: true, bounds: { x: 1, y: 1, width: 50, height: 50 } },
		})

		expect(wcv.setBounds.mock.calls.length).toBe(before)

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. unknown / forged token → DROP.
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp slot-token — unknown token', () => {
	it('4) unknown/forged token from the authorized wc → DROPPED (no setBounds)', async () => {
		const { app, electron, ipcMain, mainWc, mainWcId } = await bootApp()

		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)
		handle.placeIn(app.runtime.mainWindow, { zone: 0, anchor: '#sim' })
		lastSlotGrant(mainWc) // a real grant exists, but we send a forged token

		const before = wcv.setBounds.mock.calls.length
		const place = getPlaceHandler(ipcMain)
		await place(mainFrameEvent(mainWcId), {
			slotToken: 'totally-forged-token',
			placement: { visible: true, bounds: { x: 1, y: 1, width: 50, height: 50 } },
		})

		expect(wcv.setBounds.mock.calls.length).toBe(before)

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. NEGATIVE ORIGIN allowed (security/correctness): negative x/y not rejected.
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp slot-token — negative origin allowed (scroll-follow)', () => {
	it('5) authorized place with negative x/y bounds → setBounds with the negative origin (NOT rejected)', async () => {
		const { app, electron, ipcMain, mainWc, mainWcId } = await bootApp()

		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)
		handle.placeIn(app.runtime.mainWindow, { zone: 0, anchor: '#sim' })
		const { slotToken } = lastSlotGrant(mainWc)

		const place = getPlaceHandler(ipcMain)
		await place(mainFrameEvent(mainWcId), {
			slotToken,
			placement: { visible: true, bounds: { x: -50, y: -20, width: 300, height: 200 } },
		})

		expect(wcv.setBounds).toHaveBeenCalledWith({ x: -50, y: -20, width: 300, height: 200 })

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. visible:false → detach (removeChildView), not setBounds.
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp slot-token — visible:false detaches', () => {
	it('6) authorized place with {visible:false} → view detached (removeChildView), no setBounds', async () => {
		const { app, electron, ipcMain, mainWc, mainWcId } = await bootApp()

		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow
		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)
		handle.placeIn(app.runtime.mainWindow, { zone: 0, anchor: '#sim' })
		const { slotToken } = lastSlotGrant(mainWc)

		// Make it visible first so there is something to detach.
		const place = getPlaceHandler(ipcMain)
		await place(mainFrameEvent(mainWcId), {
			slotToken,
			placement: { visible: true, bounds: { x: 0, y: 0, width: 10, height: 10 } },
		})
		const boundsBefore = wcv.setBounds.mock.calls.length
		const removesBefore = mainWin.contentView.removeChildView.mock.calls.length

		await place(mainFrameEvent(mainWcId), { slotToken, placement: { visible: false } })

		expect(mainWin.contentView.removeChildView.mock.calls.length).toBeGreaterThan(removesBefore)
		expect(mainWin.contentView.removeChildView).toHaveBeenCalledWith(wcv)
		// No extra setBounds for a detach.
		expect(wcv.setBounds.mock.calls.length).toBe(boundsBefore)

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. REPLAY: layout-subscribe from the authorized wc re-sends its grant; a
//    DIFFERENT wc's subscribe does NOT re-send this view's grant.
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp slot-token — per-wc layout-subscribe replay', () => {
	it('7) layout-subscribe from the authorized wc re-sends the grant; a different wc does NOT get it', async () => {
		const { app, electron, ipcMain, mainWc, mainWcId } = await bootApp()

		// Trust a second control wc whose subscribe must NOT receive this grant.
		const otherSend = vi.fn()
		const otherWc = { id: mainWcId + 555, isDestroyed: () => false, send: otherSend }
		app._trustWebContents(otherWc as unknown as Parameters<DeckApp['_trustWebContents']>[0])

		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		lastWcv(electron)
		handle.placeIn(app.runtime.mainWindow, { zone: 0, anchor: '#sim' })
		const { slotToken } = lastSlotGrant(mainWc)

		const grantsBefore = countSlotGrants(mainWc, slotToken)
		const otherBefore = countSlotGrants(otherWc as unknown as FakeWebContentsLike)

		const layoutSubscribe = getLayoutSubscribeHandler(ipcMain)

		// Authorized wc subscribes → its grant is re-delivered (replay).
		await layoutSubscribe(mainFrameEvent(mainWcId))
		expect(countSlotGrants(mainWc, slotToken)).toBe(grantsBefore + 1)

		// A DIFFERENT trusted wc subscribes → this view's grant is NOT sent to it.
		await layoutSubscribe(mainFrameEvent(otherWc.id))
		expect(countSlotGrants(otherWc as unknown as FakeWebContentsLike)).toBe(otherBefore)

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// 8. token revoked on dispose: a place with the stale token → DROP.
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp slot-token — token revoked on dispose', () => {
	it('8) after handle.dispose(), a place with the now-stale token → DROPPED (no setBounds)', async () => {
		const { app, electron, ipcMain, mainWc, mainWcId } = await bootApp()

		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)
		handle.placeIn(app.runtime.mainWindow, { zone: 0, anchor: '#sim' })
		const { slotToken } = lastSlotGrant(mainWc)

		await handle.dispose()

		const before = wcv.setBounds.mock.calls.length
		const place = getPlaceHandler(ipcMain)
		await place(mainFrameEvent(mainWcId), {
			slotToken,
			placement: { visible: true, bounds: { x: 5, y: 5, width: 5, height: 5 } },
		})

		expect(wcv.setBounds.mock.calls.length).toBe(before)

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// 9. back-compat: placeIn WITHOUT anchor → no slot-grant sent.
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp slot-token — placeIn without anchor (back-compat)', () => {
	it('9) placeIn(mainWindow,{zone:0}) with NO anchor → no __electron-deck:slot-grant sent', async () => {
		const { app, electron, mainWc } = await bootApp()

		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		lastWcv(electron)
		handle.placeIn(app.runtime.mainWindow, { zone: 0 })

		expect(countSlotGrants(mainWc)).toBe(0)

		await app.shutdown()
	})
})

// Parity ref so an unused-import lint never masks the RED.
const _jsonParityRef: JsonValue = null
void _jsonParityRef
