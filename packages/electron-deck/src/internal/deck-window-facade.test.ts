/**
 * Contract tests for the LOCKED "DeckWindow facade"
 * (.repro/deck-window-facade-LOCKED.md — C1 + C2).
 *
 * CONTRACT (C1 — return shape, BREAKING):
 *   `runtime.windows.create(opts)` now returns a `DeckWindow` handle (was a bare
 *   BrowserWindow):
 *     { readonly window: BrowserWindow,
 *       readonly controlWc: WebContents,
 *       newSession(): DeckSession,
 *       onClose(decider): Disposable }
 *   `.window` is the created BrowserWindow; `controlWc === window.webContents`.
 *
 * CONTRACT (C2 — window-rooted sessions):
 *   `deckWindow.newSession()` returns an opaque `DeckSession`
 *   ({ reset(): Promise<void>, dispose(): Promise<void> }) that
 *   `runtime.view({ scope })` ACCEPTS — under the SAME provenance check that
 *   today accepts `runtime.scopes.create()` sessions. BOTH app-root sessions and
 *   window-rooted sessions are accepted; a raw Scope / forged object is REJECTED.
 *   `session.reset()` disposes that session's views but keeps the session AND the
 *   window alive. Closing the window disposes all sessions minted from it.
 *
 * Every spec here exercises the runtime contract of the window facade returned by
 * `runtime.windows.create`: it carries `.newSession` / `.controlWc` / `.window` /
 * `.onClose` (the C1 specs), and a window-rooted session can be fed into
 * `runtime.view({ scope })` (the C2 view-accepts spec). Reached through a typed
 * escape hatch (`asDeckWindow`) so the file COMPILES and asserts on BEHAVIOR.
 *
 * Fakes: copied (minimal) from deck-app.host-view.test.ts — `createFakeElectron`
 * / `createFakeIpcMain`. The existing fake shapes (contentView add/removeChildView
 * spies, `_emit('closed')`, stable `webContents.id`) cover every assertion.
 */
import { describe, expect, it, vi } from 'vitest'
import type { DeckSession, Disposable, JsonValue, Runtime } from '../types.js'
import type {
	MinimalBrowserWindow,
	MinimalBrowserWindowOptions,
	MinimalElectron,
	MinimalRect,
	MinimalWebContentsLike,
	MinimalWebContentsView,
} from './electron-types.js'
import { DeckApp } from './deck-app.js'
import { createScope } from '../main/scope.js'
import type { MinimalIpcMain } from './wire-transport.js'

// ── Minimal fakes (copied from deck-app.host-view.test.ts) ───────────────────

type InvokeHandler = (
	event: { sender: { id: number } },
	...args: unknown[]
) => unknown | Promise<unknown>

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

// ── Typed escape hatches ─────────────────────────────────────────────────────
//
// `runtime.windows.create` is TYPED today as returning a bare `BrowserWindow`
// (no `.window` / `.controlWc` / `.newSession` / `.onClose`). The LOCKED C1
// contract upgrades it to a `DeckWindow`. We reach the new surface through a
// loose view so its ABSENCE fails at RUNTIME (`...create(...).newSession is not
// a function`) — the runtime failure we want — instead of a compile error that would stop
// the suite from running.

interface DeckWindow {
	readonly window: unknown // BrowserWindow
	readonly controlWc: unknown // WebContents (=== window.webContents)
	newSession(): DeckSession
	onClose(decider: () => 'keep' | 'close' | Promise<'keep' | 'close'>): Disposable
}

// `DeckSession` in this branch only declares `dispose()`; C2 adds `reset()`. We
// reach `reset` through a loose view so its absence is a RUNTIME failure.
interface DeckSessionWithReset extends DeckSession {
	reset(): Promise<void>
}

// `runtime.view` is not in the public Runtime type yet (host-view slice). Reach
// it the same way the host-view test does.
type Bounds = { x: number, y: number, width: number, height: number }
type Placement = { visible: true, bounds: Bounds } | { visible: false }
interface ViewSource { url?: string, file?: string }
interface HostViewHandle {
	placeIn(win: unknown, opts: { zone?: number }): HostViewHandle
	applyPlacement(p: Placement): void
	dispose(): Promise<void>
}
interface RuntimeWithView {
	view(spec: { source: ViewSource, scope?: unknown }): HostViewHandle
	scopes: { create(): DeckSession }
	windows: { create(opts: unknown): unknown }
}

function withView(runtime: Runtime): RuntimeWithView {
	return runtime as unknown as RuntimeWithView
}

// Treat the value `runtime.windows.create(...)` returns as a DeckWindow. At
// authoring time it's actually a bare BrowserWindow, so member access on the
// DeckWindow surface fails at RUNTIME.
function asDeckWindow(created: unknown): DeckWindow {
	return created as unknown as DeckWindow
}

function lastWcv(electron: FakeElectron): FakeWebContentsView {
	const wcv = electron.webContentsViews[electron.webContentsViews.length - 1]
	if (!wcv) throw new Error('no WebContentsView was constructed')
	return wcv
}

function bootApp(): { app: DeckApp, electron: FakeElectron } {
	const electron = createFakeElectron()
	const app = new DeckApp({}, { electron, wireTransport: { ipcMain: createFakeIpcMain() } })
	return { app, electron }
}

// ─────────────────────────────────────────────────────────────────────────────
// C1 — return shape: create() returns a DeckWindow handle.
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckWindow facade (C1) — create() returns a DeckWindow handle', () => {
	it('create() returns { window, controlWc, newSession, onClose } — .window is the BrowserWindow, controlWc === window.webContents', async () => {
		const { app, electron } = bootApp()
		await app.start()

		const created = withView(app.runtime).windows.create({
			source: { url: 'http://localhost:5173/dyn.html' },
		})
		const deckWindow = asDeckWindow(created)

		// The handle exposes the C1 surface.
		expect(typeof deckWindow.newSession).toBe('function')
		expect(typeof deckWindow.onClose).toBe('function')

		// `.window` is the BrowserWindow the framework just constructed (last one).
		const lastBw = electron.browserWindows[electron.browserWindows.length - 1]
		expect(deckWindow.window).toBe(lastBw)

		// controlWc === window.webContents.
		expect(deckWindow.controlWc).toBe((lastBw as unknown as FakeBrowserWindow).webContents)

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// C2 — newSession() mints a DeckSession that runtime.view ACCEPTS (window-rooted
// provenance), with NO regression on app-root sessions and a preserved REJECT of
// a raw / forged scope.
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckWindow facade (C2) — view accepts window-rooted sessions, rejects forgeries', () => {
	it('runtime.view({ scope: deckWindow.newSession() }).placeIn(deckWindow.window) is ACCEPTED (window-rooted provenance)', async () => {
		const { app, electron } = bootApp()
		await app.start()

		const deckWindow = asDeckWindow(
			withView(app.runtime).windows.create({
				source: { url: 'http://localhost:5173/dyn.html' },
			}),
		)
		const session = deckWindow.newSession()

		// runtime.view must ACCEPT a window-rooted session (same provenance WeakMap
		// as runtime.scopes.create()) — no rejection thrown.
		const handle = withView(app.runtime).view({
			source: { url: 'data:text/html,x' },
			scope: session,
		})
		const wcv = lastWcv(electron)
		expect(() =>
			handle.placeIn(deckWindow.window, { zone: 0 }),
		).not.toThrow()

		// Placement actually landed in THIS window's contentView.
		const bw = deckWindow.window as unknown as FakeBrowserWindow
		expect(bw.contentView.addChildView).toHaveBeenCalledWith(wcv)

		await app.shutdown()
	})

	it('NO REGRESSION — runtime.view still accepts an app-root runtime.scopes.create() session', async () => {
		const { app, electron } = bootApp()
		await app.start()

		const session = withView(app.runtime).scopes.create()
		const handle = withView(app.runtime).view({
			source: { url: 'data:text/html,x' },
			scope: session,
		})
		const wcv = lastWcv(electron)
		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow

		expect(() => handle.placeIn(app.runtime.mainWindow, { zone: 0 })).not.toThrow()
		expect(mainWin.contentView.addChildView).toHaveBeenCalledWith(wcv)

		await app.shutdown()
	})

	it('PROVENANCE PRESERVED — runtime.view REJECTS a raw / forged scope object', async () => {
		const { app } = bootApp()
		await app.start()

		// A raw Scope (createScope()) was never minted by the framework's session
		// factory → it is NOT in the provenance map → REJECTED.
		const rawScope = createScope()
		expect(() =>
			withView(app.runtime).view({ source: { url: 'data:text/html,x' }, scope: rawScope }),
		).toThrow(/scope|session|provenance|reject/i)

		// A hand-forged "session"-shaped object is likewise rejected.
		const forged = { reset: async () => undefined, dispose: async () => undefined }
		expect(() =>
			withView(app.runtime).view({ source: { url: 'data:text/html,x' }, scope: forged }),
		).toThrow(/scope|session|provenance|reject/i)

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// C2 — session.reset() disposes THAT session's views but keeps the window alive.
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckWindow facade (C2) — session.reset() tears down views, keeps window', () => {
	it('reset() detaches a view bound to the session (removeChildView) while the window stays alive', async () => {
		const { app, electron } = bootApp()
		await app.start()

		const deckWindow = asDeckWindow(
			withView(app.runtime).windows.create({
				source: { url: 'http://localhost:5173/dyn.html' },
			}),
		)
		const bw = deckWindow.window as unknown as FakeBrowserWindow
		const session = deckWindow.newSession() as DeckSessionWithReset

		const handle = withView(app.runtime).view({
			source: { url: 'data:text/html,x' },
			scope: session,
		})
		const wcv = lastWcv(electron)
		handle.placeIn(deckWindow.window, { zone: 0 })
		expect(bw.contentView.addChildView).toHaveBeenCalledWith(wcv)

		const removesBefore = bw.contentView.removeChildView.mock.calls.length

		// reset() — disposes the session's views (the bound view is torn down)...
		await session.reset()
		await new Promise(r => setTimeout(r, 0))

		// ...the view bound to the session was detached.
		expect(bw.contentView.removeChildView.mock.calls.length).toBeGreaterThan(removesBefore)
		expect(bw.contentView.removeChildView).toHaveBeenCalledWith(wcv)

		// ...but the WINDOW is still alive (reset keeps the session + window).
		expect(bw.destroy).not.toHaveBeenCalled()
		expect(bw.isDestroyed()).toBe(false)

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// C2 — closing the window disposes sessions minted from it (windowScope cascade).
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckWindow facade (C2) — window close cascades window-rooted sessions', () => {
	it('closing/destroying the window detaches the views of a still-open window-rooted session', async () => {
		const { app, electron } = bootApp()
		await app.start()

		const deckWindow = asDeckWindow(
			withView(app.runtime).windows.create({
				source: { url: 'http://localhost:5173/popout.html' },
			}),
		)
		const bw = deckWindow.window as unknown as FakeBrowserWindow

		// A session minted from THIS window, never reset/disposed by the caller.
		const session = deckWindow.newSession()
		const handle = withView(app.runtime).view({
			source: { url: 'data:text/html,x' },
			scope: session,
		})
		const wcv = lastWcv(electron)
		handle.placeIn(deckWindow.window, { zone: 0 })
		expect(bw.contentView.addChildView).toHaveBeenCalledWith(wcv)

		const removesBefore = bw.contentView.removeChildView.mock.calls.length

		// Fire the window's 'closed' → windowScope.close() must cascade into every
		// window-rooted session minted from it → the placed view is detached.
		expect(() => bw._emit('closed')).not.toThrow()
		await new Promise(r => setTimeout(r, 0))

		expect(bw.contentView.removeChildView.mock.calls.length).toBeGreaterThan(removesBefore)
		expect(bw.contentView.removeChildView).toHaveBeenCalledWith(wcv)

		await app.shutdown()
	})
})

// Parity ref so an unused-import lint never masks a runtime failure.
const _jsonParityRef: JsonValue = null
void _jsonParityRef
