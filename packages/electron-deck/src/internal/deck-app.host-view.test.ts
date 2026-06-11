/**
 * TDD failing-first contract tests for "host API make-it-real slice 1":
 *   runtime.view({ source, scope? })
 *     .placeIn(win, { zone })
 *     .applyPlacement(p)
 *     .dispose()
 * wired into the REAL DeckApp, with a per-window native-view substrate + A4
 * `detachAll` teardown.
 *
 * Source of truth: docs/contracts/view-handle-build-plan.md §2(a) + gap#1, and
 * docs/layout-architecture-demo.md (the target `runtime.view(...).placeIn(...)`
 * call shape). The increment-1 unit (`src/main/view-handle.ts` +
 * `src/main/compositor.ts` detachAll) already exists; what does NOT exist yet is
 * the deck-app WIRING: `runtime.view` is absent. So every spec here is RED at
 * RUNTIME (`runtime.view is not a function`), reached through a single typed
 * escape hatch so the file still compiles (TypeError, not a compile error).
 *
 * The contract pinned (per the brief):
 *   1. runtime.view exists + creates a native WebContentsView (via injected
 *      electron) and returns a handle with placeIn/applyPlacement/dispose.
 *   2. placeIn(win,{zone:0}) mounts the native view into THAT window's
 *      contentView (addChildView with the view's WCV).
 *   3. applyPlacement(visible:true,bounds) → the native WCV's setBounds with
 *      EXACTLY those bounds (gap#1: handle drives bounds, not the Compositor).
 *   4. applyPlacement(visible:false) → detach (removeChildView), WCV NOT
 *      destroyed; a later visible:true re-adds (addChildView) + setBounds again.
 *   5. dispose() detaches (removeChildView); a later applyPlacement is a no-op
 *      (no setBounds).
 *   6. window close cascades view teardown (A4): a view placed in a
 *      runtime-created window is detached from that window's contentView when
 *      the window fires 'closed' (detachAll / windowScope cascade), no throw.
 *   8. runtime.view with no electron injected throws a clear "unavailable"
 *      error (mirrors runtime.windows.create's electronUnavailable path).
 *
 * (Brief item 7 — placeIn into a second window — is OUT OF SCOPE for slice 1
 *  and DEFERRED to moveTo (build-plan §2(d)); see the `it.skip` note below.)
 *
 * Fakes: copied (minimal) from deck-app.test.ts — `createFakeElectron` /
 * `createFakeIpcMain`. `FakeBrowserWindow.contentView` already exposes
 * `addChildView`/`removeChildView` vi.fns; `FakeWebContentsView` already exposes
 * a `setBounds` vi.fn and a stable `webContents.id`. NO fake EXTENSION was
 * needed — the existing shapes cover every assertion. (The minimal contentView
 * is a pair of spies that do NOT track children; per the build plan the
 * production per-window `ContentViewHost` tracks z-order itself, so we assert
 * against the spies directly rather than via a child-tracking host.)
 */
import { describe, expect, it, vi } from 'vitest'
import type { JsonValue, Runtime } from '../types.js'
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

// ── Minimal fakes (copied from deck-app.test.ts) ─────────────────────────────

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
	/** Test-only: mirrors a destroyed WCV (asserts dispose keeps it alive). */
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

// ── Typed escape hatch for the not-yet-typed `runtime.view` factory ──────────
//
// `Runtime.view` is not in the public type yet, so we reach it through a loose
// view. Absence then fails at RUNTIME (`runtime.view is not a function`) — the
// RED we want — rather than a compile error that would stop the suite running.
type Bounds = { x: number, y: number, width: number, height: number }
type Placement = { visible: true, bounds: Bounds } | { visible: false }
interface ViewSource {
	url?: string
	file?: string
}
interface HostViewHandle {
	placeIn(win: unknown, opts: { zone?: number }): HostViewHandle
	applyPlacement(p: Placement): void
	dispose(): Promise<void>
}
interface RuntimeWithView {
	view(spec: { source: ViewSource, scope?: unknown }): HostViewHandle
	// P2: the sealed session factory — the ONLY legitimate source of a `scope`.
	scopes: { create(): { dispose(): Promise<void> } }
}
function withView(runtime: Runtime): RuntimeWithView {
	return runtime as unknown as RuntimeWithView
}

// The WCV the handle owns is the LAST WebContentsView the fake electron
// constructed during the `runtime.view(...)` call. (No toolbar in these tests,
// so the only WCVs constructed are the views under test.)
function lastWcv(electron: FakeElectron): FakeWebContentsView {
	const wcv = electron.webContentsViews[electron.webContentsViews.length - 1]
	if (!wcv) throw new Error('no WebContentsView was constructed')
	return wcv
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. runtime.view exists + creates a native WebContentsView, returns a handle.
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp host-view slice 1 — runtime.view factory', () => {
	it('runtime.view({source}) constructs a WebContentsView and returns a handle with placeIn/applyPlacement/dispose', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain: createFakeIpcMain() } })
		await app.start()

		const before = electron.webContentsViewCtorCalls.length
		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })

		// A brand-new native view was constructed via the injected electron.
		expect(electron.webContentsViewCtorCalls.length).toBe(before + 1)
		// The handle exposes the slice-1 surface.
		expect(typeof handle.placeIn).toBe('function')
		expect(typeof handle.applyPlacement).toBe('function')
		expect(typeof handle.dispose).toBe('function')

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. placeIn(mainWindow,{zone:0}) mounts the native view into the window's
//    contentView (addChildView with the view's WCV).
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp host-view slice 1 — placeIn mounts into the window contentView', () => {
	it('placeIn(mainWindow,{zone:0}) adds the view WCV to the main window contentView', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain: createFakeIpcMain() } })
		await app.start()

		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow
		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)

		handle.placeIn(app.runtime.mainWindow, { zone: 0 })

		// The view's native WCV was mounted into the main window's content view.
		expect(mainWin.contentView.addChildView).toHaveBeenCalledWith(wcv)

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. applyPlacement(visible:true,bounds) → the native WCV's setBounds with
//    EXACTLY those bounds (gap#1: handle drives bounds, not the Compositor).
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp host-view slice 1 — applyPlacement drives setBounds (gap#1)', () => {
	it('applyPlacement(visible:true,bounds) calls the view WCV setBounds with exactly those bounds', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain: createFakeIpcMain() } })
		await app.start()

		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)
		handle.placeIn(app.runtime.mainWindow, { zone: 0 })

		handle.applyPlacement({ visible: true, bounds: { x: 10, y: 20, width: 300, height: 200 } })

		expect(wcv.setBounds).toHaveBeenCalledWith({ x: 10, y: 20, width: 300, height: 200 })

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. applyPlacement(visible:false) → detach (removeChildView), WCV NOT
//    destroyed; a later visible:true re-adds (addChildView) + setBounds again.
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp host-view slice 1 — applyPlacement(visible:false) detach-but-keep', () => {
	it('detaches via removeChildView (WCV kept alive), then re-adds + setBounds on visible:true', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain: createFakeIpcMain() } })
		await app.start()

		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow
		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)
		handle.placeIn(app.runtime.mainWindow, { zone: 0 })
		handle.applyPlacement({ visible: true, bounds: { x: 0, y: 0, width: 100, height: 100 } })

		// visible:false → detach.
		handle.applyPlacement({ visible: false })
		expect(mainWin.contentView.removeChildView).toHaveBeenCalledWith(wcv)
		// The native view object is NOT destroyed — only removed from the host.
		expect(wcv.destroyed).toBe(false)

		// visible:true again → re-add (addChildView) AND a fresh setBounds.
		const addsBefore = mainWin.contentView.addChildView.mock.calls.length
		const boundsBefore = wcv.setBounds.mock.calls.length
		handle.applyPlacement({ visible: true, bounds: { x: 5, y: 6, width: 7, height: 8 } })
		expect(mainWin.contentView.addChildView.mock.calls.length).toBeGreaterThan(addsBefore)
		expect(mainWin.contentView.addChildView).toHaveBeenCalledWith(wcv)
		expect(wcv.setBounds.mock.calls.length).toBe(boundsBefore + 1)
		expect(wcv.setBounds).toHaveBeenLastCalledWith({ x: 5, y: 6, width: 7, height: 8 })

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. dispose() detaches (removeChildView); a later applyPlacement is a no-op
//    (no setBounds).
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp host-view slice 1 — dispose detaches + makes the sink inert', () => {
	it('dispose removes the WCV from the contentView; a later applyPlacement does nothing', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain: createFakeIpcMain() } })
		await app.start()

		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow
		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)
		handle.placeIn(app.runtime.mainWindow, { zone: 0 })
		handle.applyPlacement({ visible: true, bounds: { x: 0, y: 0, width: 1, height: 1 } })

		await handle.dispose()
		expect(mainWin.contentView.removeChildView).toHaveBeenCalledWith(wcv)

		// A late place IPC after dispose drops entirely — no further setBounds.
		const boundsBefore = wcv.setBounds.mock.calls.length
		handle.applyPlacement({ visible: true, bounds: { x: 9, y: 9, width: 9, height: 9 } })
		expect(wcv.setBounds.mock.calls.length).toBe(boundsBefore)

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. window close cascades view teardown (A4). A view placed in a
//    runtime-created window is detached from that window's contentView when the
//    window fires 'closed' (handleSubWindowClosed → windowScope.close cascade →
//    viewScope detach / detachAll), without throwing.
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp host-view slice 1 — window close cascades view teardown (A4)', () => {
	it('a runtime window "closed" detaches its placed view (cascade), no throw', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain: createFakeIpcMain() } })
		await app.start()

		// A runtime-created window: its 'closed' runs handleSubWindowClosed (NOT a
		// full framework shutdown), which closes the windowScope → cascades into
		// the placed view's viewScope.
		const win = app.runtime.windows.create({
			source: { url: 'http://localhost:5173/popout.html' },
		}).window as unknown as FakeBrowserWindow

		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)
		handle.placeIn(win as unknown as Runtime['mainWindow'], { zone: 0 })
		expect(win.contentView.addChildView).toHaveBeenCalledWith(wcv)

		const removesBefore = win.contentView.removeChildView.mock.calls.length
		// Fire the window's 'closed' → windowScope cascade → view detached.
		expect(() => win._emit('closed')).not.toThrow()
		await new Promise(r => setTimeout(r, 0))

		expect(win.contentView.removeChildView.mock.calls.length).toBeGreaterThan(removesBefore)
		expect(win.contentView.removeChildView).toHaveBeenCalledWith(wcv)

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. placeIn into a second window — OUT OF SCOPE for slice 1, deferred to moveTo
//    (build-plan §2(d)). Documented as skipped so the goalpost is explicit.
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp host-view slice 1 — second placeIn (deferred to moveTo)', () => {
	it.skip('placing the same handle into a second window is moveTo\'s job (§2(d)) — not slice 1', () => {
		// Intentionally unspecified for slice 1. A cross-window move is the moveTo
		// state machine (build-plan §2(d): AT_SRC→DETACHED→AT_DEST|ROLLBACK with a
		// per-view migration lock). Pinning a behavior here would prejudge that
		// contract, so this is deferred.
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// NEW (flagged) — Bug 3b: an explicit `opts.scope` bounds the view's display
// lifetime. Closing that scope detaches the view (removeChildView) WITHOUT the
// caller calling dispose(). Pins the `opts.scope.own(() => hostHandle.dispose())`
// wiring (and only for an explicit scope, not the rootScope default).
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp host-view slice 1 — opts.scope close disposes the view (Bug 3b)', () => {
	it('closing an explicit opts.scope detaches the placed view (removeChildView), no caller dispose()', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain: createFakeIpcMain() } })
		await app.start()

		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow
		// P2: raw scope → sealed DeckSession. A raw `createScope()` is no longer a
		// valid `scope` (it would be REJECTED by the provenance check); the only
		// legitimate source is `runtime.scopes.create()`.
		const session = withView(app.runtime).scopes.create()
		const handle = withView(app.runtime).view({
			source: { url: 'data:text/html,x' },
			scope: session,
		})
		const wcv = lastWcv(electron)
		handle.placeIn(app.runtime.mainWindow, { zone: 0 })
		expect(mainWin.contentView.addChildView).toHaveBeenCalledWith(wcv)

		const removesBefore = mainWin.contentView.removeChildView.mock.calls.length
		// P2: dispose the SESSION (→ its internal scope.close()) — the view must
		// detach (display teardown) without anyone calling handle.dispose().
		await session.dispose()
		await new Promise(r => setTimeout(r, 0))

		expect(mainWin.contentView.removeChildView.mock.calls.length).toBeGreaterThan(removesBefore)
		expect(mainWin.contentView.removeChildView).toHaveBeenCalledWith(wcv)
		// Native WCV is NOT destroyed in slice 1 (deferred to keepAlive/B3).
		expect(wcv.destroyed).toBe(false)

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// 8. runtime.view with no electron injected throws a clear "unavailable" error
//    (mirrors runtime.windows.create's electronUnavailable path).
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp host-view slice 1 — runtime.view requires electron', () => {
	it('runtime.view without an injected electron throws a clear unavailable error', async () => {
		// No `electron` in DeckAppOptions → in-memory build. runtime.windows.create
		// throws electronUnavailable in this mode; runtime.view must mirror that.
		const app = new DeckApp({})
		await app.start()

		expect(() =>
			withView(app.runtime).view({ source: { url: 'data:text/html,x' } }),
		).toThrow(/unavailable/i)

		await app.shutdown()
	})
})

// A throwaway reference so an unused-import lint never masks the RED. (JsonValue
// is imported for parity with deck-app.test.ts's fake helpers; reference it.)
const _jsonValueParityRef: JsonValue = null
void _jsonValueParityRef
