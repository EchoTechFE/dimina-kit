/**
 * Contract tests for moveTo on the public host handle + re-placement.
 *
 * BACKGROUND:
 *   - The INNER `createViewHandle` (src/main/view-handle.ts) implements
 *     `moveTo(dest,{zone,rehome})` (rollback + Scope.adopt), and the PUBLIC
 *     `DeckViewHandle` returned by `runtime.view()` surfaces it alongside
 *     placeIn/applyPlacement/dispose.
 *
 * Contract pinned here:
 *   - `runtime.view().moveTo(dest, { zone, anchor, rehome? })` moves the
 *     per-window SUBSTRATE registration (unregister from src, register in dest),
 *     moves the WCV (winB.contentView gains it / winA loses it), re-issues the
 *     slot-token anchor for the dest, and ROLLS BACK on dest failure (the view
 *     stays in src; the promise rejects).
 *   - `placeIn` TWICE on the public handle THROWS (re-placement disallowed).
 *
 * Channel string literals are used directly (the `DeckChannel.*` members are
 * internal); fakes are copied (minimal) from deck-app.slot-token.test.ts.
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

// ── Minimal fakes (copied from deck-app.slot-token.test.ts) ──────────────────

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
	close: ReturnType<typeof vi.fn>
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
		children: MinimalWebContentsView[]
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
			close: vi.fn(() => {
				wc.destroyed = true
			}),
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
			// Model real Electron `contentView.children` so the moveTo rollback's
			// membership guard has a truthful view of which WCVs the window actually
			// hosts. The default add/remove keep the array in sync; a test may
			// override addChildView (e.g. B3's mid-apply throw) while still pushing
			// into `children` to model a leaked-then-detached child.
			const children: MinimalWebContentsView[] = []
			const cv = {
				children,
				addChildView: vi.fn((v: MinimalWebContentsView) => {
					const i = children.indexOf(v)
					if (i >= 0) children.splice(i, 1)
					children.push(v)
				}),
				removeChildView: vi.fn((v: MinimalWebContentsView) => {
					const i = children.indexOf(v)
					if (i >= 0) children.splice(i, 1)
				}),
			}
			this.contentView = cv as unknown as FakeBrowserWindow['contentView']
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

// ── Typed escape hatch for the not-yet-typed `moveTo` on the host handle ──────
//
// Reaching `moveTo` through a loose view keeps the suite running regardless of
// whether the public `DeckViewHandle` type declares it.
interface ViewSource { url?: string, file?: string }
interface HostViewHandle {
	placeIn(win: unknown, opts: { zone?: number, anchor?: string }): HostViewHandle
	applyPlacement(p: ViewPlacement): HostViewHandle
	// the surface under test
	moveTo(win: unknown, opts: { zone?: number, anchor?: string, rehome?: boolean }): Promise<void>
	dispose(): Promise<void>
}
interface RuntimeWithView {
	view(spec: { source: ViewSource, scope?: unknown }): HostViewHandle
}
function withView(runtime: Runtime): RuntimeWithView {
	return runtime as unknown as RuntimeWithView
}

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

// Pull the most recent slot-grant the framework `send`-pushed to `wc` (or null
// if none). Used to assert the dest re-anchor and to capture tokens.
function lastSlotGrant(wc: FakeWebContentsLike): SlotGrant | null {
	const calls = (wc.send as ReturnType<typeof vi.fn>).mock.calls
	for (let i = calls.length - 1; i >= 0; i -= 1) {
		const [channel, payload] = calls[i] as [string, unknown]
		if (channel === SLOT_GRANT_CHANNEL) return payload as SlotGrant
	}
	return null
}

function getPlaceHandler(ipcMain: FakeIpcMain): Handler {
	const h = ipcMain.handlers.get(PLACE_CHANNEL)
	if (!h) throw new Error(`"${PLACE_CHANNEL}" handler not registered`)
	return h
}

function mainFrameEvent(senderId: number): FrameEvent {
	const frame: FrameRef = { routingId: 1, processId: 1000 + senderId }
	return { sender: { id: senderId, mainFrame: frame }, senderFrame: frame }
}

// Boot the app + create a SECOND framework-tracked window (winB). Both windows
// have a per-window substrate (keyed by their wc), so the view can move between
// them and each control wc can receive its own slot-grant.
async function bootTwoWindows(): Promise<{
	app: DeckApp
	electron: FakeElectron
	ipcMain: FakeIpcMain
	winA: FakeBrowserWindow
	winB: FakeBrowserWindow
}> {
	const electron = createFakeElectron()
	const ipcMain = createFakeIpcMain()
	const app = new DeckApp({}, { electron, wireTransport: { ipcMain } })
	await app.start()
	const winA = electron.browserWindows[0] as unknown as FakeBrowserWindow
	const winB = app.runtime.windows.create({
		source: { url: 'http://localhost:5173/winB.html' },
	}).window as unknown as FakeBrowserWindow
	return { app, electron, ipcMain, winA, winB }
}

// ─────────────────────────────────────────────────────────────────────────────
// moveTo moves the native view to winB's substrate (registered in winB,
// UNREGISTERED from winA) — the WCV moved (winB gained it, winA lost it).
// Pin: winB.contentView.addChildView(wcv) fired on the move; winA detached it
// (removeChildView(wcv)); and the dest registration is real — a place driven via
// winB's NEW token reaches the WCV's setBounds.
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp moveTo (public handle) — moves the view to winB substrate', () => {
	it('B1) moveTo(winB) adds the WCV to winB, removes it from winA, and re-binds to winB', async () => {
		const { app, electron, ipcMain, winA, winB } = await bootTwoWindows()

		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)
		handle.placeIn(app.runtime.mainWindow, { zone: 0, anchor: '#a' })
		expect(winA.contentView.addChildView).toHaveBeenCalledWith(wcv)

		const aRemovesBefore = winA.contentView.removeChildView.mock.calls.length
		await handle.moveTo(winB as unknown as Runtime['mainWindow'], { zone: 0, anchor: '#b' })

		// The WCV moved: winB GAINED it, winA LOST it (substrate re-registration).
		expect(winB.contentView.addChildView).toHaveBeenCalledWith(wcv)
		expect(winA.contentView.removeChildView.mock.calls.length).toBeGreaterThan(aRemovesBefore)
		expect(winA.contentView.removeChildView).toHaveBeenCalledWith(wcv)

		// winB now tracks the view: a place driven via winB's NEW slot-token reaches
		// the WCV (proves register-in-dest is real, not just a native add).
		const bGrant = lastSlotGrant(winB.webContents)
		expect(bGrant).not.toBeNull()
		const place = getPlaceHandler(ipcMain)
		await place(mainFrameEvent(winB.webContents.id), {
			slotToken: bGrant!.slotToken,
			placement: { visible: true, bounds: { x: 7, y: 8, width: 9, height: 10 } },
		})
		expect(wcv.setBounds).toHaveBeenCalledWith({ x: 7, y: 8, width: 9, height: 10 })

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// placeIn TWICE on the public handle THROWS (re-placement disallowed; moveTo
// is the migration path).
// Pin: the second placeIn throws; the view stays in winA (no corruption).
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp moveTo (public handle) — second placeIn throws (N3)', () => {
	it('B2) calling placeIn twice on the same host handle throws', async () => {
		const { app, electron, winA, winB } = await bootTwoWindows()

		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)
		handle.placeIn(app.runtime.mainWindow, { zone: 0, anchor: '#a' })
		expect(winA.contentView.addChildView).toHaveBeenCalledWith(wcv)

		// A SECOND placeIn must THROW — moveTo is the only migration path.
		expect(() =>
			handle.placeIn(winB as unknown as Runtime['mainWindow'], { zone: 0, anchor: '#b' }),
		).toThrow(/already placed|use moveTo/i)

		// No corruption: the view never landed in winB via the rejected placeIn.
		expect(winB.contentView.addChildView).not.toHaveBeenCalledWith(wcv)

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// (CRITICAL) moveTo ROLLBACK — a dest commit failure leaves the view in winA.
// Pin: arm winB.contentView.addChildView to THROW on the dest attach (the
// Compositor surfaces a CommitError; moveTo rolls back). The view STAYS in winA
// (still its child, re-mounted), winB never gains it, and the promise REJECTS.
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp moveTo (public handle) — dest-failure rollback (atomicity)', () => {
	it('B3) moveTo rejects and leaves the view in winA when the dest add throws', async () => {
		const { app, electron, winA, winB } = await bootTwoWindows()

		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)
		handle.placeIn(app.runtime.mainWindow, { zone: 0, anchor: '#a' })
		expect(winA.contentView.addChildView).toHaveBeenCalledWith(wcv)

		// Inject a dest-attach failure: winB's native addChildView throws ONCE (the
		// move's dest mount), then becomes a no-op (the default spy behaviour — a src
		// rollback re-mounts on winA, a DIFFERENT host, so winB's spy is irrelevant
		// after the throw).
		let failNext = true
		winB.contentView.addChildView.mockImplementation((v: MinimalWebContentsView) => {
			// Model a MID-APPLY native leak: the child IS added to the window before
			// the call throws (real Electron's addChildView can partially apply). This
			// is exactly the residue the moveTo rollback's membership-guarded
			// removeChildView must clean up — so the dest stays net-zero (the
			// assertion below).
			const children = winB.contentView.children
			const i = children.indexOf(v)
			if (i >= 0) children.splice(i, 1)
			children.push(v)
			if (failNext) {
				failNext = false
				throw new Error('winB addChildView: injected dest failure')
			}
		})

		const aAddsBefore = winA.contentView.addChildView.mock.calls.length

		await expect(
			handle.moveTo(winB as unknown as Runtime['mainWindow'], { zone: 0, anchor: '#b' }),
		).rejects.toBeTruthy()

		// ROLLBACK: the view is back in winA (re-mounted) and winB never kept it.
		expect(winA.contentView.addChildView.mock.calls.length).toBeGreaterThan(aAddsBefore)
		expect(winA.contentView.addChildView).toHaveBeenLastCalledWith(wcv)
		// winB ended with the view detached (its only successful add never happened).
		const bAdds = winB.contentView.addChildView.mock.calls.filter(c => c[0] === wcv)
		const bRemoves = winB.contentView.removeChildView.mock.calls.filter(c => c[0] === wcv)
		expect(bAdds.length).toBe(bRemoves.length) // net-zero in winB (never resident)

		// Still placeable in winA via its ORIGINAL token (src token survived rollback).
		const aGrant = lastSlotGrant(winA.webContents)
		expect(aGrant).not.toBeNull()

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// slot-token re-anchor on move: after moveTo(winB,{anchor:'#b'}), a NEW
// slot-grant for the moved view is pushed to winB's control wc with slotId '#b';
// AND a stale `place` using the OLD (winA) token is DROPPED (the old token was
// revoked on move).
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp moveTo (public handle) — slot-token re-anchor + old-token revoke', () => {
	it('B4) moveTo pushes a winB slot-grant for #b and the old winA token stops working', async () => {
		const { app, electron, ipcMain, winB } = await bootTwoWindows()

		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)
		const winA = electron.browserWindows[0] as unknown as FakeBrowserWindow
		handle.placeIn(app.runtime.mainWindow, { zone: 0, anchor: '#a' })
		const aGrant = lastSlotGrant(winA.webContents)
		expect(aGrant).not.toBeNull()
		const oldToken = aGrant!.slotToken

		await handle.moveTo(winB as unknown as Runtime['mainWindow'], { zone: 0, anchor: '#b' })

		// A NEW slot-grant landed on winB's control wc for THIS view, slotId '#b'.
		const bGrant = lastSlotGrant(winB.webContents)
		expect(bGrant).not.toBeNull()
		expect(bGrant!.slotId).toBe('#b')
		expect(bGrant!.viewId).toBe(aGrant!.viewId)
		// A fresh, different token (the dest renderer's new credential).
		expect(bGrant!.slotToken).not.toBe(oldToken)

		// The OLD (winA) token was REVOKED on move: a stale `place` using it is
		// DROPPED (no setBounds), even though it comes from the (still-trusted) winA wc.
		const place = getPlaceHandler(ipcMain)
		const before = wcv.setBounds.mock.calls.length
		await place(mainFrameEvent(winA.webContents.id), {
			slotToken: oldToken,
			placement: { visible: true, bounds: { x: 1, y: 1, width: 1, height: 1 } },
		})
		expect(wcv.setBounds.mock.calls.length).toBe(before) // stale token dropped

		// The NEW winB token DOES drive it (the dest renderer can now place it).
		await place(mainFrameEvent(winB.webContents.id), {
			slotToken: bGrant!.slotToken,
			placement: { visible: true, bounds: { x: 2, y: 3, width: 4, height: 5 } },
		})
		expect(wcv.setBounds).toHaveBeenCalledWith({ x: 2, y: 3, width: 4, height: 5 })

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// dispose after moveTo destroys the view in winB (unregistered from winB,
// webContents.close called) — no leak, no double.
// Pin: after moveTo(winB) then dispose(), winB detached the WCV (removeChildView)
// and the WCV's webContents.close() was called (destroy), exactly once.
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp moveTo (public handle) — dispose after move destroys in winB', () => {
	it('B5) dispose after moveTo detaches from winB and closes the view WebContents (once)', async () => {
		const { app, electron, winB } = await bootTwoWindows()

		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)
		handle.placeIn(app.runtime.mainWindow, { zone: 0, anchor: '#a' })
		await handle.moveTo(winB as unknown as Runtime['mainWindow'], { zone: 0, anchor: '#b' })
		expect(winB.contentView.addChildView).toHaveBeenCalledWith(wcv)

		const bRemovesBefore = winB.contentView.removeChildView.mock.calls.length
		await handle.dispose()

		// Detached from winB (its current host), and the native WebContents closed.
		expect(winB.contentView.removeChildView.mock.calls.length).toBeGreaterThan(bRemovesBefore)
		expect(winB.contentView.removeChildView).toHaveBeenCalledWith(wcv)
		expect(wcv.webContents.close).toHaveBeenCalledTimes(1) // destroyed once, no double

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// placeIn's `placed` flag is set BEFORE the best-effort slot-grant push, so a
// slot-grant `send` failure does NOT leave the handle re-placeable.
//
// `placed = true` must run right after the CORE placement (registerView +
// inner.placeIn), before the grant push. If it ran AFTER mintSlotToken (which
// `send`s the slot-grant) and `send` threw, `placed` would stay false → a
// RETRY's public guard would pass → it would overwrite `placedSubstrate`
// (corruption). The view IS placed (winA gained the WCV); the renderer can
// re-subscribe to get the grant. We force the grant `send` to throw and assert:
// the first placeIn threw (the grant push failed) BUT a subsequent placeIn STILL
// throws "already placed" and does NOT overwrite (winB never gains the WCV).
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp placeIn (public handle) — slot-grant send failure still marks placed', () => {
	it('a placeIn whose slot-grant send throws still marks the handle placed (a later placeIn throws, does NOT overwrite)', async () => {
		const { app, electron, winA, winB } = await bootTwoWindows()

		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)

		// Arm winA's control wc `send` to throw — the slot-grant push (resend) fails
		// AFTER the core placement (registerView + inner.placeIn) already succeeded.
		winA.webContents.send.mockImplementation(() => {
			throw new Error('injected slot-grant send failure')
		})

		// The anchored placeIn throws BECAUSE the grant push threw — but the CORE
		// placement landed first (winA gained the WCV).
		expect(() => handle.placeIn(app.runtime.mainWindow, { zone: 0, anchor: '#a' })).toThrow(
			/injected slot-grant send failure/,
		)
		expect(winA.contentView.addChildView).toHaveBeenCalledWith(wcv)

		// Spy on winB's substrate.registerView. The CORRUPTION the BUG-1 ordering
		// fix prevents: a retry whose HOST guard does NOT fire (because `placed`
		// stayed false after the grant-send throw) runs `substrate.registerView` +
		// `placedSubstrate = winBSubstrate` BEFORE the inner N3 guard throws —
		// overwriting placedSubstrate to winB (a substrate the view never actually
		// lives in). With the fix, `placed` is already true, so the host guard throws
		// FIRST and winB's registerView is NEVER reached.
		const winBSub = (app as unknown as {
			windowSubstrates: Map<unknown, { registerView: (...a: unknown[]) => void }>
		}).windowSubstrates.get(winB.webContents as unknown as object)!
		const winBRegisterSpy = vi.spyOn(winBSub, 'registerView')

		// CRITICAL: the handle is marked placed despite the grant failure. A retry
		// must THROW "already placed" at the HOST guard and must NOT overwrite
		// placedSubstrate (winB's substrate is never registered into; winB never
		// gains the WCV — no corruption).
		expect(() =>
			handle.placeIn(winB as unknown as Runtime['mainWindow'], { zone: 0, anchor: '#b' }),
		).toThrow(/already placed|use moveTo/i)
		expect(winBRegisterSpy).not.toHaveBeenCalled() // host guard fired BEFORE any winB registration
		expect(winB.contentView.addChildView).not.toHaveBeenCalledWith(wcv)

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// the moveTo rollback `removeChildView` is
// DEFENSIVE: it (a) does NOT remove a child the dest never added (a source-side
// failure path), and (b) a cleanup-throw never masks the ORIGINAL moveTo error.
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp moveTo (public handle) — defensive rollback cleanup', () => {
	it('a SOURCE-side failure does not removeChildView from a dest that never added it', async () => {
		const { app, electron, winA, winB } = await bootTwoWindows()

		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)
		handle.placeIn(app.runtime.mainWindow, { zone: 0, anchor: '#a' })
		expect(winA.contentView.addChildView).toHaveBeenCalledWith(wcv)

		// Make the SRC detach (winA.removeChildView, driven by the move's STEP-1 src
		// commit) throw → the inner move fails at the SOURCE before ever touching the
		// dest. The Compositor surfaces a CommitError and rolls back to src.
		winA.contentView.removeChildView.mockImplementationOnce(() => {
			throw new Error('winA removeChildView: injected SRC detach failure')
		})
		const bRemovesBefore = winB.contentView.removeChildView.mock.calls.length

		await expect(
			handle.moveTo(winB as unknown as Runtime['mainWindow'], { zone: 0, anchor: '#b' }),
		).rejects.toBeTruthy()

		// The dest (winB) was NEVER added → the defensive guard
		// (`children.includes(wcv)`) skips removeChildView entirely: no remove for a
		// child dest never had (pre-fix this fired an unconditional removeChildView).
		expect(winB.contentView.removeChildView.mock.calls.length).toBe(bRemovesBefore)
		expect(winB.contentView.removeChildView).not.toHaveBeenCalledWith(wcv)

		await app.shutdown()
	})

	it('a cleanup-throw does NOT mask the original moveTo (dest) error', async () => {
		const { app, electron, winA, winB } = await bootTwoWindows()

		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)
		handle.placeIn(app.runtime.mainWindow, { zone: 0, anchor: '#a' })
		expect(winA.contentView.addChildView).toHaveBeenCalledWith(wcv)

		// Dest add throws (the ORIGINAL move failure) AND leaks the child (mid-apply),
		// so the rollback's membership-guarded removeChildView WILL run...
		let failAdd = true
		winB.contentView.addChildView.mockImplementation((v: MinimalWebContentsView) => {
			const children = winB.contentView.children
			const i = children.indexOf(v)
			if (i >= 0) children.splice(i, 1)
			children.push(v)
			if (failAdd) {
				failAdd = false
				throw new Error('ORIGINAL dest add failure')
			}
		})
		// ...and that cleanup removeChildView THROWS — it must be swallowed+logged,
		// NEVER surfaced in place of the original dest error.
		winB.contentView.removeChildView.mockImplementation(() => {
			throw new Error('CLEANUP removeChildView failure (must not mask)')
		})

		await expect(
			handle.moveTo(winB as unknown as Runtime['mainWindow'], { zone: 0, anchor: '#b' }),
		).rejects.toThrow(/ORIGINAL dest add failure/)

		await app.shutdown()
	})
})

// Parity ref so an unused-import lint never masks a runtime failure.
const _jsonParityRef: JsonValue = null
void _jsonParityRef
