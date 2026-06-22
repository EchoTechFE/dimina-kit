/**
 * Contract tests for FOUR behaviours in the electron-deck view move +
 * close/shutdown lifecycle, each guarding against a real bug that was fixed.
 *
 *   F1. moveTo rehome AFTER a display-only move. A view does ONE non-rehome
 *       (display-only) cross-window move, THEN a `rehome:true` move. The second
 *       move must SUCCEED. The bug guarded against: re-parenting the viewScope
 *       via `src.windowScope.adopt(viewScope, dest.windowScope)`, where `src`
 *       is the CURRENT DISPLAY window — but after a display-only move the
 *       viewScope's lifetime still lives under the ORIGINAL home window, so the
 *       donor passed to `adopt` is not the viewScope's real parent → adopt
 *       throws "child is not a direct child …" → moveTo rolls back + rejects.
 *
 *   F2. same-window moveTo (src === dest, only re-anchor/zone) must KEEP the
 *       view in the window's substrate registry. The current implementation
 *       `registerView`s into dest THEN `unregisterView`s from src — and for a
 *       same-window move src === dest, so the net effect DELETES the registry
 *       entry. A later `dispose()` then can't resolve viewId → wcv in the
 *       substrate, so the native `removeChildView` is silently skipped (the WCV
 *       leaks attached to the live window).
 *
 *   F3. concurrent shutdown must MERGE, never TRUNCATE. While a first teardown's
 *       cleanup is in flight (parked on a slow disposer), a second shutdown that
 *       reaches the cleanup body must AWAIT the in-flight cleanup before driving
 *       the app to quit. The current `runShutdownCleanup` guards with a plain
 *       `if (cleanupRan) return` boolean latch that returns IMMEDIATELY while
 *       the first run is still parked — so the second path forces lifecycle to
 *       'quit' and calls `app.quit()` BEFORE the first cleanup finished
 *       (truncation: app exits mid-teardown).
 *
 *   F4. moveTo rollback when the DEST window is already destroyed. The rollback
 *       reads `destWin.contentView.children` BEFORE checking `isDestroyed()`.
 *       On a real (destroyed) BrowserWindow, property access throws
 *       "Object has been destroyed" — so the cleanup throws a SECONDARY error
 *       instead of letting the ORIGINAL move error rethrow. The fix checks
 *       `isDestroyed()` FIRST and skips the contentView read for a dead window.
 *
 * These reach un-typed members (`moveTo` on the public handle) through a
 * typed escape hatch (`withView`) so the file COMPILES and the failure is a
 * behaviour assertion, not a type error. Fakes are copied (minimal) from
 * deck-app.move.test.ts / start-electron-deck.test.ts.
 */
import { describe, expect, it, vi } from 'vitest'
import type { JsonValue, Runtime } from '../types.js'
import type {
	MinimalApp,
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

// ── Minimal fakes (copied from deck-app.move.test.ts) ────────────────────────

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

interface FakeContentView {
	addChildView: ReturnType<typeof vi.fn>
	removeChildView: ReturnType<typeof vi.fn>
	children: MinimalWebContentsView[]
}

interface FakeBrowserWindow extends MinimalBrowserWindow {
	readonly webContents: FakeWebContentsLike
	getContentBounds: ReturnType<typeof vi.fn> & MinimalBrowserWindow['getContentBounds']
	show: ReturnType<typeof vi.fn> & MinimalBrowserWindow['show']
	destroy: ReturnType<typeof vi.fn> & MinimalBrowserWindow['destroy']
	on: ReturnType<typeof vi.fn> & MinimalBrowserWindow['on']
	contentView: MinimalBrowserWindow['contentView'] & FakeContentView
	destroyed: boolean
	/** Test-only: when set, reading `.contentView` THROWS once the window is
	 *  destroyed — modelling real Electron, where any property access on a
	 *  destroyed BrowserWindow throws "Object has been destroyed". Used by F4. */
	_throwContentViewWhenDestroyed: boolean
	_listeners: Map<string, Array<(...args: unknown[]) => void>>
	_emit(event: 'resize' | 'closed' | 'close'): void
}

interface FakeWebContentsView extends MinimalWebContentsView {
	readonly webContents: FakeWebContentsLike
	setBounds: ReturnType<typeof vi.fn> & MinimalWebContentsView['setBounds']
	destroyed: boolean
}

interface FakeElectron extends MinimalElectron {
	browserWindows: FakeBrowserWindow[]
	webContentsViews: FakeWebContentsView[]
}

function createFakeElectron(
	app?: MinimalApp,
	initialContentBounds: MinimalRect = { x: 0, y: 0, width: 1024, height: 768 },
): FakeElectron {
	let wcIdCounter = 100
	let winIdCounter = 1
	const browserWindows: FakeBrowserWindow[] = []
	const webContentsViews: FakeWebContentsView[] = []

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
		destroyed: boolean
		_throwContentViewWhenDestroyed: boolean
		getContentBounds: FakeBrowserWindow['getContentBounds']
		show: FakeBrowserWindow['show']
		destroy: FakeBrowserWindow['destroy']
		on: FakeBrowserWindow['on']
		_listeners: Map<string, Array<(...args: unknown[]) => void>>
		private readonly _contentView: FakeContentView

		constructor(_opts?: MinimalBrowserWindowOptions) {
			this.id = winIdCounter++
			this.webContents = makeFakeWebContents()
			this.destroyed = false
			this._throwContentViewWhenDestroyed = false
			// Model real Electron `contentView.children` so the moveTo rollback's
			// membership guard sees the window's real child set; add/remove keep it
			// in sync.
			const children: MinimalWebContentsView[] = []
			this._contentView = {
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
			this.getContentBounds = vi.fn(() => initialContentBounds) as FakeBrowserWindow['getContentBounds']
			this.show = vi.fn() as FakeBrowserWindow['show']
			this.destroy = vi.fn(() => {
				this.destroyed = true
				this.webContents.destroyed = true
			}) as FakeBrowserWindow['destroy']
			this._listeners = new Map()
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

		// `contentView` is a GETTER so a destroyed window can model real Electron's
		// "Object has been destroyed" throw when `_throwContentViewWhenDestroyed`
		// is armed (F4). Otherwise it returns the live content view.
		get contentView(): MinimalBrowserWindow['contentView'] & FakeContentView {
			if (this._throwContentViewWhenDestroyed && this.destroyed) {
				throw new Error('Object has been destroyed')
			}
			return this._contentView as MinimalBrowserWindow['contentView'] & FakeContentView
		}

		_emit(event: 'resize' | 'closed' | 'close'): void {
			const arr = this._listeners.get(event)
			if (!arr) return
			if (event === 'close') {
				const ev = { preventDefault: vi.fn() }
				for (const fn of arr.slice()) fn(ev)
				return
			}
			if (event === 'closed') {
				this.destroyed = true
				this.webContents.destroyed = true
			}
			for (const fn of arr.slice()) fn()
		}

		isDestroyed(): boolean {
			return this.destroyed
		}
	}

	class FakeWCV implements MinimalWebContentsView {
		readonly webContents: FakeWebContentsLike
		setBounds: FakeWebContentsView['setBounds']
		destroyed: boolean

		constructor(_opts?: { webPreferences?: { preload?: string } }) {
			this.webContents = makeFakeWebContents()
			this.setBounds = vi.fn() as FakeWebContentsView['setBounds']
			this.destroyed = false
			webContentsViews.push(this as unknown as FakeWebContentsView)
		}
	}

	return {
		...(app ? { app } : {}),
		BrowserWindow: FakeBW as unknown as MinimalElectron['BrowserWindow'],
		WebContentsView: FakeWCV as unknown as MinimalElectron['WebContentsView'],
		browserWindows,
		webContentsViews,
	} as FakeElectron
}

// ── Controllable fake app (observe quit + drive whenReady) ───────────────────

type AppEvent = 'will-quit' | 'before-quit' | 'window-all-closed' | 'second-instance'

interface FakeApp extends MinimalApp {
	quit: ReturnType<typeof vi.fn> & MinimalApp['quit']
	_listeners: Map<AppEvent, Array<(e?: { preventDefault(): void }) => void>>
}

function createFakeApp(): FakeApp {
	const _listeners = new Map<AppEvent, Array<(e?: { preventDefault(): void }) => void>>()
	const app = {
		_listeners,
		whenReady: vi.fn(async () => undefined),
		setName: vi.fn((_name: string) => undefined),
		quit: vi.fn(() => undefined),
		requestSingleInstanceLock: vi.fn(() => true),
		on: vi.fn((event: AppEvent, listener: (e?: { preventDefault(): void }) => void) => {
			let arr = _listeners.get(event)
			if (!arr) {
				arr = []
				_listeners.set(event, arr)
			}
			arr.push(listener)
			return app
		}),
	} as unknown as FakeApp
	return app
}

// ── Typed escape hatch for the not-yet-typed `moveTo` shape on the host handle ─
interface ViewSource { url?: string, file?: string }
interface HostViewHandle {
	placeIn(win: unknown, opts: { zone?: number, anchor?: string }): HostViewHandle
	moveTo(win: unknown, opts: { zone?: number, anchor?: string, rehome?: boolean }): Promise<void>
	dispose(): Promise<void>
}
interface RuntimeWithView {
	view(spec: { source: ViewSource, scope?: unknown }): HostViewHandle
}
function withView(runtime: Runtime): RuntimeWithView {
	return runtime as unknown as RuntimeWithView
}

interface SlotGrant { viewId: string, slotId: string, slotToken: string }

function lastWcv(electron: FakeElectron): FakeWebContentsView {
	const wcv = electron.webContentsViews[electron.webContentsViews.length - 1]
	if (!wcv) throw new Error('no WebContentsView was constructed')
	return wcv
}

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

// Boot the app + create N extra framework-tracked windows (winB, winC, …).
async function bootWindows(extra: number): Promise<{
	app: DeckApp
	electron: FakeElectron
	ipcMain: FakeIpcMain
	wins: FakeBrowserWindow[]
}> {
	const electron = createFakeElectron()
	const ipcMain = createFakeIpcMain()
	const app = new DeckApp({}, { electron, wireTransport: { ipcMain } })
	await app.start()
	const winA = electron.browserWindows[0] as unknown as FakeBrowserWindow
	const wins: FakeBrowserWindow[] = [winA]
	for (let i = 0; i < extra; i += 1) {
		const w = app.runtime.windows.create({
			source: { url: `http://localhost:5173/win${i}.html` },
		}).window as unknown as FakeBrowserWindow
		wins.push(w)
	}
	return { app, electron, ipcMain, wins }
}

// ─────────────────────────────────────────────────────────────────────────────
// F1. display-only move, THEN rehome move → the rehome move SUCCEEDS.
// ─────────────────────────────────────────────────────────────────────────────
describe('moveTo — rehome after a display-only move (correct adopt donor)', () => {
	it('F1) a display-only move(winB) followed by a rehome move(winC) RESOLVES (not rejects via wrong adopt donor)', async () => {
		const { app, electron, wins } = await bootWindows(2)
		const winA = wins[0]!
		const winB = wins[1]!
		const winC = wins[2]!

		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)
		handle.placeIn(app.runtime.mainWindow, { zone: 0, anchor: '#a' })
		expect(winA.contentView.addChildView).toHaveBeenCalledWith(wcv)

		// 1) DISPLAY-ONLY move to winB (rehome:false). Display moves to winB; the
		//    view's LIFETIME stays parented under winA's windowScope.
		await handle.moveTo(winB as unknown as Runtime['mainWindow'], { zone: 0, anchor: '#b', rehome: false })
		expect(winB.contentView.addChildView).toHaveBeenCalledWith(wcv)

		// 2) REHOME move to winC. The fix must re-parent from the viewScope's ACTUAL
		//    parent (winA), not the current display window (winB). With the bug, the
		//    adopt donor is winB → "child is not a direct child" → rollback → reject.
		await expect(
			handle.moveTo(winC as unknown as Runtime['mainWindow'], { zone: 0, anchor: '#c', rehome: true }),
		).resolves.toBeUndefined()

		// Post-condition: the view actually landed in winC (the move was not rolled
		// back to winB).
		expect(winC.contentView.addChildView).toHaveBeenCalledWith(wcv)

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// F2. same-window moveTo keeps the substrate registration → later dispose still
//     reaches native removeChildView.
// ─────────────────────────────────────────────────────────────────────────────
describe('moveTo — same-window move keeps the substrate registration', () => {
	it('F2) moveTo(sameWindow, new anchor) then dispose() STILL detaches the WCV natively (registration not erased)', async () => {
		const { app, electron, wins } = await bootWindows(0)
		const winA = wins[0]!

		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)
		handle.placeIn(app.runtime.mainWindow, { zone: 0, anchor: '#a' })
		expect(winA.contentView.addChildView).toHaveBeenCalledWith(wcv)

		// Move WITHIN the same window (src === dest) — only the anchor/zone changes.
		await handle.moveTo(app.runtime.mainWindow, { zone: 1, anchor: '#a2' })

		// The current bug: registerView(dest=winA) then unregisterView(src=winA) on
		// the SAME substrate → the registry entry is gone. So a later dispose can no
		// longer resolve viewId → wcv and silently skips the native detach.
		const removesBefore = winA.contentView.removeChildView.mock.calls.filter(c => c[0] === wcv).length
		await handle.dispose()

		// The dispose MUST reach the native layer: winA detached the WCV.
		const removesAfter = winA.contentView.removeChildView.mock.calls.filter(c => c[0] === wcv).length
		expect(removesAfter).toBeGreaterThan(removesBefore)
		expect(winA.contentView.removeChildView).toHaveBeenCalledWith(wcv)

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// F3. concurrent shutdown MERGES: a second shutdown reaching the cleanup body
//     while the first is parked on a slow disposer must NOT drive app.quit()
//     until the first cleanup truly finishes.
// ─────────────────────────────────────────────────────────────────────────────
describe('shutdown — concurrent shutdown merges (no truncation of in-flight cleanup)', () => {
	it('F3) a second shutdown does NOT call app.quit() until the first cleanup\'s slow disposer completes', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		try {
			const app = createFakeApp()
			const electron = createFakeElectron(app)

			// A slow disposer owned by the app's teardown registry. `start()` then
			// THROWS, so `cleanupOnError` (which bypasses the shutdown() single-flight)
			// runs the FIRST cleanup; the slow disposer parks it mid-teardown.
			let releaseDisposer!: () => void
			const disposerGate = new Promise<void>((res) => {
				releaseDisposer = res
			})
			let disposerFinished = false
			const deckApp = new DeckApp(
				{
					setup: (rt) => {
						rt.add(async () => {
							await disposerGate
							disposerFinished = true
						})
						// Trigger the FIRST teardown via cleanupOnError (a late start failure).
						throw new Error('setup-boom (drives cleanupOnError)')
					},
				},
				{ electron },
			)

			// start() rejects after kicking off cleanupOnError, which parks on the
			// slow disposer.
			const startP = deckApp.start()
			startP.catch(() => {})

			// Let the first cleanup reach (and park on) the slow disposer.
			await Promise.resolve()
			await Promise.resolve()
			expect(disposerFinished).toBe(false)

			// A SECOND shutdown arrives while the first cleanup is still in flight. It
			// must MERGE with the first — NOT race ahead to app.quit().
			const secondShutdown = deckApp.shutdown()
			secondShutdown.catch(() => {})
			await Promise.resolve()
			await Promise.resolve()

			// CRITICAL: the second shutdown must NOT have driven the app to quit while
			// the first cleanup's slow disposer is still parked (truncation guard).
			expect(disposerFinished).toBe(false)
			expect(app.quit).not.toHaveBeenCalled()

			// Release the slow disposer → the first cleanup finishes → only THEN may
			// shutdown advance to quit.
			releaseDisposer()
			await secondShutdown
			await startP.catch(() => {})

			expect(disposerFinished).toBe(true)
			// The app quit AT MOST once, and only after cleanup completed.
			expect(app.quit.mock.calls.length).toBeLessThanOrEqual(1)
		}
		finally {
			errorSpy.mockRestore()
		}
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// F4. moveTo rollback when the DEST window is already destroyed must rethrow the
//     ORIGINAL move error, not a secondary "contentView of destroyed window" error.
// ─────────────────────────────────────────────────────────────────────────────
describe('moveTo — rollback tolerates a destroyed dest window', () => {
	it('F4) when the dest add fails AND the dest window is destroyed, the ORIGINAL error rethrows (no destroyed-window read error)', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		try {
			const { app, electron, wins } = await bootWindows(1)
			const winA = wins[0]!
			const winB = wins[1]!
			// Arm winB so that reading `.contentView` AFTER it is destroyed throws
			// (real Electron "Object has been destroyed").
			winB._throwContentViewWhenDestroyed = true

			const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
			const wcv = lastWcv(electron)
			handle.placeIn(app.runtime.mainWindow, { zone: 0, anchor: '#a' })
			expect(winA.contentView.addChildView).toHaveBeenCalledWith(wcv)

			// The dest add throws the ORIGINAL move failure; while throwing, destroy the
			// dest window so the rollback's contentView read would blow up if it ran
			// BEFORE the isDestroyed() check.
			winB.contentView.addChildView.mockImplementation(() => {
				winB.destroyed = true
				winB.webContents.destroyed = true
				throw new Error('ORIGINAL dest add failure')
			})

			// moveTo must REJECT with the ORIGINAL error — not "Object has been
			// destroyed" leaked from reading destWin.contentView during cleanup.
			await expect(
				handle.moveTo(winB as unknown as Runtime['mainWindow'], { zone: 0, anchor: '#b' }),
			).rejects.toThrow(/ORIGINAL dest add failure/)

			// The fix checks `isDestroyed()` FIRST and skips the contentView read for a
			// dead dest window, so the cleanup step is SILENTLY skipped — NO secondary
			// "Object has been destroyed" error is produced/logged during the rollback.
			// The current code reads `destWin.contentView` BEFORE the isDestroyed guard,
			// so the getter throws, gets caught, and is logged as a cleanup failure.
			const loggedDestroyedRead = errorSpy.mock.calls.some(call =>
				call.some(arg =>
					(typeof arg === 'string' && /Object has been destroyed/.test(arg))
					|| (arg instanceof Error && /Object has been destroyed/.test(arg.message)),
				),
			)
			expect(loggedDestroyedRead).toBe(false)

			await app.shutdown()
		}
		finally {
			errorSpy.mockRestore()
		}
	})
})

// keep the place handler + slot-grant helpers referenced so an unused-symbol
// lint never masks a runtime failure (these mirror the move-suite helper surface).
void getPlaceHandler
void lastSlotGrant
void mainFrameEvent

// Parity ref so an unused-import lint never masks a runtime failure.
const _jsonParityRef: JsonValue = null
void _jsonParityRef
