/**
 * TDD failing-first contract tests for the LOCKED "DeckWindow facade"
 * (.repro/deck-window-facade-LOCKED.md — C4 + C6).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * C4 — per-window `onClose` close-arbitration:
 *   `deckWindow.onClose(decider)` registers a cancelable close decider FOR THAT
 *   window. On a close attempt the framework `preventDefault()`s, runs the
 *   registered deciders (registration order); any `'keep'` vetoes (window stays);
 *   `'close'` (or a thrown / rejected decider → fail-closed) closes the window.
 *   A LIVE per-window decider on the MAIN window STRICTLY supersedes
 *   `backend.onMainWindowClose` (the backend hook is only the fallback when no
 *   live per-window decider exists). A re-entrant close during a slow decision
 *   decides ONCE (in-flight latch). Deciders must not call destroy themselves.
 *
 * C6 — unified create/adopt registration + LIFO teardown ordering:
 *   `windows.create()` (ownership=framework) and `windows.adopt()`
 *   (observe/transfer) go through ONE internal registration producing identical
 *   windowScope + substrate + trust invariants. ORDERING INVARIANT: the
 *   window-destroy disposable must be registered on the windowScope BEFORE the
 *   substrate.detachAll disposable, so on teardown the substrate DETACHES (LIFO)
 *   BEFORE the window is destroyed. This is currently VIOLATED on the
 *   transfer-adopt path (adoptWindow registers the substrate first, then the
 *   transfer destroy-own) — a regression test pins it.
 *
 * STATUS: every spec here is RED at authoring time.
 *   • C4: there is NO per-window `onClose` machine yet — `create()` returns a
 *     bare BrowserWindow (no `.onClose`), and the main window only wires the
 *     backend-level close-decision machine. The per-window deciders never run.
 *   • C6 ordering: the transfer-adopt path destroys the window BEFORE the
 *     substrate detaches (LIFO violated), so the substrate's `removeChildView`
 *     never runs on a live host (commit short-circuits on the destroyed host).
 *
 * Reached through typed escape hatches (`asDeckWindow`, `mainDeckWindowOf`,
 * `withAdopt`) so the file COMPILES and fails on BEHAVIOR, not types.
 *
 * Fakes: copied (minimal) from deck-app.adopt.test.ts (the richer fake — it has
 * `prependListener`, records every listener into a single ordered list, and
 * marks the window destroyed on `'closed'`) + `makeExternalWindow()` for adopt.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Disposable, JsonValue, Runtime, RuntimeBackend } from '../types.js'
import type {
	MinimalBrowserWindow,
	MinimalBrowserWindowOptions,
	MinimalElectron,
	MinimalRect,
	MinimalWebContentsLike,
	MinimalWebContentsView,
} from './electron-types.js'
import { DeckApp } from './deck-app.js'
import type { DeckAppOptions } from './deck-app.js'
import type { MinimalIpcMain, MinimalWebContents } from './wire-transport.js'

// ── Minimal fakes (copied from deck-app.adopt.test.ts) ───────────────────────

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
	prependListener: ReturnType<typeof vi.fn>
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
	/** Construct an EXTERNAL window NOT registered by the framework (the host's). */
	makeExternalWindow(): FakeBrowserWindow
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
		prependListener: FakeBrowserWindow['prependListener']
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
			// `destroy` is a spy that ALSO marks the window+wc destroyed, so the
			// compositor host's `isDestroyed` getter flips true the instant destroy
			// runs — the C6 ordering tests rely on this to detect a destroy-before-
			// detach (LIFO) violation (the destroyed host commit is a silent no-op,
			// so `removeChildView` never fires if destroy ran first).
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
			this.prependListener = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
				let arr = this._listeners.get(event)
				if (!arr) {
					arr = []
					this._listeners.set(event, arr)
				}
				arr.unshift(listener)
				return this
			}) as FakeBrowserWindow['prependListener']
			browserWindows.push(this as unknown as FakeBrowserWindow)
		}

		_emit(event: 'resize' | 'closed' | 'close'): void {
			const arr = this._listeners.get(event)
			if (!arr) return
			if (event === 'close') {
				const ev = { preventDefault: vi.fn() }
				this._lastCloseEvent = ev
				for (const fn of arr.slice()) fn(ev)
				return
			}
			// Real Electron destroys the window synchronously-with 'closed'.
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
		makeExternalWindow(): FakeBrowserWindow {
			return new FakeBW() as unknown as FakeBrowserWindow
		},
	}
}

// ── Typed escape hatches ─────────────────────────────────────────────────────

type Decision = 'keep' | 'close'
type Decider = () => Decision | Promise<Decision>

/** The LOCKED C1/C4 `DeckWindow` surface (per-window `onClose` not yet typed). */
interface DeckWindow {
	readonly window: unknown
	readonly controlWc: unknown
	onClose(decider: Decider): Disposable
}

interface ViewSource { url?: string, file?: string }
interface HostViewHandle {
	placeIn(win: unknown, opts: { zone?: number, anchor?: string }): HostViewHandle
	dispose(): Promise<void>
}
type Ownership = 'transfer' | 'observe'
interface RuntimeWithFacade {
	view(spec: { source: ViewSource, scope?: unknown }): HostViewHandle
	scopes: { create(): unknown }
	windows: {
		create(opts: unknown): unknown
		adopt(win: unknown, opts?: { ownership?: Ownership }): Disposable
	}
}

function withFacade(runtime: Runtime): RuntimeWithFacade {
	return runtime as unknown as RuntimeWithFacade
}

/** Treat `windows.create(...)` (a bare BrowserWindow today) as a DeckWindow. */
function asDeckWindow(created: unknown): DeckWindow {
	return created as unknown as DeckWindow
}

/**
 * Resolve the BrowserWindow behind a `windows.create(...)` result. Per the LOCKED
 * C1 facade the result is a DeckWindow whose `.window` is the BrowserWindow; today
 * it's a BARE BrowserWindow. Prefer `.window`, else the value itself — so the C6
 * specs below fail on the genuine substrate / ordering behavior, NOT on the
 * (separately-covered C1) missing `.window` accessor.
 */
function bwOf(created: unknown): FakeBrowserWindow {
	const maybe = (created as { window?: unknown }).window
	return (maybe ?? created) as unknown as FakeBrowserWindow
}

/**
 * Resolve the MAIN window's `DeckWindow` handle so a per-window `onClose` can be
 * registered on it. The LOCKED facade ("create/adopt/main 统一返回形态") exposes
 * the main window through this surface; the accessor name is not pinned, so probe
 * the plausible shapes. If none exposes a callable `onClose`, throw — the RED we
 * want (the per-window facade does not exist on the main window yet).
 */
function mainDeckWindowOf(app: DeckApp): DeckWindow {
	const rt = app.runtime as unknown as {
		mainDeckWindow?: DeckWindow
		windows?: { main?: (() => DeckWindow) | DeckWindow, mainWindow?: DeckWindow }
		mainWindow?: unknown
	}
	const candidates: unknown[] = [
		rt.mainDeckWindow,
		typeof rt.windows?.main === 'function' ? rt.windows.main() : rt.windows?.main,
		rt.windows?.mainWindow,
		// last resort: the bare main BrowserWindow, treated as a DeckWindow (it has
		// no `onClose`, so this still fails RED — but COMPILES + RUNS the assertion).
		rt.mainWindow,
	]
	for (const c of candidates) {
		const dw = c as DeckWindow | undefined
		if (dw && typeof dw.onClose === 'function') return dw
	}
	throw new Error(
		'main window does not expose a per-window onClose facade '
		+ '(C4 per-window close-arbitration not implemented)',
	)
}

function lastWcv(electron: FakeElectron): FakeWebContentsView {
	const wcv = electron.webContentsViews[electron.webContentsViews.length - 1]
	if (!wcv) throw new Error('no WebContentsView was constructed')
	return wcv
}

// ── Substrate-level probe for the C6 LIFO regression ─────────────────────────
//
// A view placed through the public `runtime.view().placeIn()` gets a `viewScope`
// that is a CHILD of the window's `windowScope` and OWNS the native detach — so
// on teardown the viewScope (children-first) detaches the view BEFORE the
// windowScope's own destroy/detachAll resources run. That masks the C6
// registration-order bug (destroy-own vs substrate.detachAll-own) from a normally
// placed view.
//
// To make the SUBSTRATE's `detachAll` the SOLE detacher, mount a bare native view
// DIRECTLY into the window's substrate compositor (no viewScope). Now on teardown
// the only thing that can remove it is `substrate.detachAll()` — which runs while
// the host is ALIVE iff the detachAll disposable is owned AFTER the destroy
// disposable (correct LIFO). On the BUGGY transfer-adopt ordering the window is
// destroyed FIRST → detachAll commits against a destroyed host → removeChildView
// is NEVER called for the bare view. So `removeChildView).toHaveBeenCalledWith`
// is the clean RED.
interface MinimalSubstrate {
	compositor: { mount(ref: { id: string }, opts?: { zone?: number }): void, commit(): void }
	registerView(id: string, wcv: unknown): void
}
function substrateOf(app: DeckApp, wc: unknown): MinimalSubstrate {
	const substrates = (app as unknown as {
		windowSubstrates: Map<unknown, MinimalSubstrate>
	}).windowSubstrates
	const sub = substrates.get(wc)
	if (!sub) throw new Error('no substrate registered for the given window webContents')
	return sub
}

/**
 * Mount a bare native view (no viewScope) into the window's substrate compositor
 * so the substrate's `detachAll` becomes the SOLE detacher of that view at
 * teardown. Returns the WCV whose `removeChildView` the test asserts on.
 */
function mountBareViewInto(
	app: DeckApp,
	electron: FakeElectron,
	bw: FakeBrowserWindow,
): { id: string, wcv: FakeWebContentsView } {
	const sub = substrateOf(app, bw.webContents)
	const wcv = new (electron.WebContentsView as unknown as new () => FakeWebContentsView)()
	const id = `bare-${Math.random().toString(36).slice(2)}`
	sub.registerView(id, wcv)
	sub.compositor.mount({ id }, { zone: 0 })
	sub.compositor.commit()
	return { id, wcv }
}

function isTrusted(app: DeckApp, wcId: number): boolean {
	return app.runtime.context._senderPolicy.isTrusted(wcId)
}

function bootApp(extraOpts?: Partial<DeckAppOptions>): { app: DeckApp, electron: FakeElectron } {
	const electron = createFakeElectron()
	const app = new DeckApp(
		{},
		{ electron, wireTransport: { ipcMain: createFakeIpcMain() }, ...extraOpts },
	)
	return { app, electron }
}

function makeBackend(
	onMainWindowClose?: RuntimeBackend['onMainWindowClose'],
): RuntimeBackend {
	const backend = { assemble: vi.fn(async () => undefined) } as RuntimeBackend
	if (onMainWindowClose) {
		;(backend as { onMainWindowClose?: RuntimeBackend['onMainWindowClose'] }).onMainWindowClose
			= onMainWindowClose
	}
	return backend
}

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0))

// ─────────────────────────────────────────────────────────────────────────────
// C4.1 — per-window onClose on a CREATED window: 'keep' vetoes, 'close' closes.
// ─────────────────────────────────────────────────────────────────────────────
describe('per-window onClose (C4) — created window keep vetoes / close closes', () => {
	it('decider returns "keep" → close is prevented, window NOT destroyed', async () => {
		const { app, electron } = bootApp()
		await app.start()

		const deckWindow = asDeckWindow(withFacade(app.runtime).windows.create({
			source: { url: 'http://localhost:5173/dyn.html' },
		}))
		const bw = electron.browserWindows[electron.browserWindows.length - 1] as unknown as FakeBrowserWindow

		const decider = vi.fn<Decider>().mockResolvedValue('keep')
		deckWindow.onClose(decider)

		// Registering onClose must arm a cancelable 'close' listener on THAT window.
		const closeListeners = bw._listeners.get('close') ?? []
		expect(closeListeners.length).toBeGreaterThan(0)

		bw._emit('close')
		await tick()

		expect(bw._lastCloseEvent?.preventDefault).toHaveBeenCalled()
		expect(decider).toHaveBeenCalledTimes(1)
		// 'keep' → window survives.
		expect(bw.destroy).not.toHaveBeenCalled()
		expect(bw.isDestroyed()).toBe(false)

		await app.shutdown()
	})

	it('decider returns "close" → window is destroyed', async () => {
		const { app, electron } = bootApp()
		await app.start()

		const deckWindow = asDeckWindow(withFacade(app.runtime).windows.create({
			source: { url: 'http://localhost:5173/dyn.html' },
		}))
		const bw = electron.browserWindows[electron.browserWindows.length - 1] as unknown as FakeBrowserWindow

		const decider = vi.fn<Decider>().mockResolvedValue('close')
		deckWindow.onClose(decider)

		bw._emit('close')
		await tick()

		expect(bw._lastCloseEvent?.preventDefault).toHaveBeenCalled()
		expect(decider).toHaveBeenCalledTimes(1)
		expect(bw.destroy).toHaveBeenCalled()

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// C4.2 — MAIN window: a live per-window onClose STRICTLY supersedes
// backend.onMainWindowClose; with NO per-window decider the backend is fallback.
// ─────────────────────────────────────────────────────────────────────────────
describe('per-window onClose (C4) — main window supersedes backend.onMainWindowClose', () => {
	it('a LIVE per-window onClose on the main window is invoked and backend.onMainWindowClose is NOT', async () => {
		const onMainWindowClose = vi.fn<NonNullable<RuntimeBackend['onMainWindowClose']>>()
			.mockResolvedValue('close')
		const backend = makeBackend(onMainWindowClose)
		const { app, electron } = bootApp({ backend })
		await app.start()

		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow
		const perWindow = vi.fn<Decider>().mockResolvedValue('keep')
		mainDeckWindowOf(app).onClose(perWindow)

		mainWin._emit('close')
		await tick()

		// The per-window decider ran; the backend hook was superseded (NOT called).
		expect(perWindow).toHaveBeenCalledTimes(1)
		expect(onMainWindowClose).not.toHaveBeenCalled()
		// And its 'keep' decision held: the main window survived, framework alive.
		expect(mainWin._lastCloseEvent?.preventDefault).toHaveBeenCalled()
		expect(mainWin.destroy).not.toHaveBeenCalled()
		expect(app.phase).toBe('ready')

		await app.shutdown()
	})

	it('with NO per-window decider, backend.onMainWindowClose IS the fallback', async () => {
		const onMainWindowClose = vi.fn<NonNullable<RuntimeBackend['onMainWindowClose']>>()
			.mockResolvedValue('keep')
		const backend = makeBackend(onMainWindowClose)
		const { app, electron } = bootApp({ backend })
		await app.start()

		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow

		// No mainDeckWindowOf(app).onClose(...) registered → backend is the fallback.
		mainWin._emit('close')
		await tick()

		expect(onMainWindowClose).toHaveBeenCalledTimes(1)
		// Its 'keep' held — window survives.
		expect(mainWin._lastCloseEvent?.preventDefault).toHaveBeenCalled()
		expect(mainWin.destroy).not.toHaveBeenCalled()

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// C4.3 — re-entrant close during a pending decision runs the decider ONCE.
// ─────────────────────────────────────────────────────────────────────────────
describe('per-window onClose (C4) — in-flight latch decides once', () => {
	it('a second "close" during a pending decision is prevented but does NOT re-run the decider', async () => {
		const { app, electron } = bootApp()
		await app.start()

		const deckWindow = asDeckWindow(withFacade(app.runtime).windows.create({
			source: { url: 'http://localhost:5173/dyn.html' },
		}))
		const bw = electron.browserWindows[electron.browserWindows.length - 1] as unknown as FakeBrowserWindow

		let resolveDecision: ((v: Decision) => void) | undefined
		const decider = vi.fn<Decider>(
			() => new Promise<Decision>((resolve) => { resolveDecision = resolve }),
		)
		deckWindow.onClose(decider)

		// First close → dispatches the (still-pending) decision.
		bw._emit('close')
		await tick()
		expect(decider).toHaveBeenCalledTimes(1)
		expect(bw._lastCloseEvent?.preventDefault).toHaveBeenCalled()

		// Second close WHILE the first decision is still pending → swallowed.
		bw._emit('close')
		await tick()
		expect(bw._lastCloseEvent?.preventDefault).toHaveBeenCalled()
		expect(decider).toHaveBeenCalledTimes(1) // not re-run
		expect(bw.destroy).not.toHaveBeenCalled() // unresolved → no decision yet

		// Drain to 'close' so the latch clears cleanly.
		resolveDecision?.('close')
		await tick()

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// C4.4 — a thrown / rejected decider fails CLOSED (window closes).
// ─────────────────────────────────────────────────────────────────────────────
describe('per-window onClose (C4) — thrown decider fails closed', () => {
	it('a decider that throws → window is destroyed (fail-closed)', async () => {
		const { app, electron } = bootApp()
		await app.start()

		const deckWindow = asDeckWindow(withFacade(app.runtime).windows.create({
			source: { url: 'http://localhost:5173/dyn.html' },
		}))
		const bw = electron.browserWindows[electron.browserWindows.length - 1] as unknown as FakeBrowserWindow

		const decider = vi.fn<Decider>(() => {
			throw new Error('decider-boom')
		})
		deckWindow.onClose(decider)

		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		try {
			bw._emit('close')
			await tick()

			expect(bw._lastCloseEvent?.preventDefault).toHaveBeenCalled()
			expect(decider).toHaveBeenCalledTimes(1)
			// fail-closed → window destroyed despite the throw.
			expect(bw.destroy).toHaveBeenCalled()
		}
		finally {
			errorSpy.mockRestore()
			await app.shutdown()
		}
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// C6.1 — create() and adopt() expose the SAME registration invariants:
// both trusted, both have a working view substrate (placeIn lands a view).
// ─────────────────────────────────────────────────────────────────────────────
describe('unified registration (C6) — create + adopt share trust + substrate invariants', () => {
	it('a created window and an adopted window are BOTH trusted and BOTH have a working view substrate', async () => {
		const { app, electron } = bootApp()
		await app.start()

		// --- created window ---
		const created = withFacade(app.runtime).windows.create({
			source: { url: 'http://localhost:5173/created.html' },
		})
		const createdBw = bwOf(created)
		expect(isTrusted(app, createdBw.webContents.id)).toBe(true)

		const createdHandle = withFacade(app.runtime).view({ source: { url: 'data:text/html,c' } })
		const createdWcv = lastWcv(electron)
		expect(() => createdHandle.placeIn(createdBw as unknown, { zone: 0 })).not.toThrow()
		expect(createdBw.contentView.addChildView).toHaveBeenCalledWith(createdWcv)

		// --- adopted window (external, ownership default) ---
		const extWin = electron.makeExternalWindow()
		expect(isTrusted(app, extWin.webContents.id)).toBe(false)
		withFacade(app.runtime).windows.adopt(extWin as unknown)
		expect(isTrusted(app, extWin.webContents.id)).toBe(true)

		const adoptedHandle = withFacade(app.runtime).view({ source: { url: 'data:text/html,a' } })
		const adoptedWcv = lastWcv(electron)
		expect(() => adoptedHandle.placeIn(extWin as unknown, { zone: 0 })).not.toThrow()
		expect(extWin.contentView.addChildView).toHaveBeenCalledWith(adoptedWcv)

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// C6.2 — teardown ordering: the window's view SUBSTRATE must DETACH its views
// (substrate.detachAll → removeChildView) BEFORE the window is destroyed. Per the
// LOCKED C6 the window-destroy disposable must be registered on the windowScope
// BEFORE the substrate.detachAll disposable, so LIFO runs detachAll FIRST (on a
// still-LIVE host).
//
// ISOLATION (why a bare view, not placeIn): a view placed via runtime.view().
// placeIn() owns its native detach on a `viewScope` that is a CHILD of the
// window's windowScope. On teardown the viewScope (children-first) detaches the
// view BEFORE the windowScope's own destroy/detachAll resources run — masking the
// registration-order bug. To make the SUBSTRATE's detachAll the SOLE detacher, we
// mount a bare native view directly into the window's substrate compositor (no
// viewScope). Then:
//   • CORRECT ordering → detachAll (own) fires while the host is ALIVE →
//     removeChildView(wcv) is called.
//   • BUGGY transfer-adopt ordering (destroy-own registered AFTER detachAll-own) →
//     destroy fires FIRST → detachAll commits against a destroyed host → its
//     removeChildView is a SILENT no-op → removeChildView is NEVER called for the
//     bare view. So `removeChildView).toHaveBeenCalledWith(wcv)` is the clean RED.
// ─────────────────────────────────────────────────────────────────────────────
describe('unified registration (C6) — substrate detaches BEFORE window destroy (LIFO)', () => {
	it('CREATED window: substrate detachAll removes the view (live host) BEFORE window.destroy', async () => {
		const { app, electron } = bootApp()
		await app.start()

		const created = withFacade(app.runtime).windows.create({
			source: { url: 'http://localhost:5173/created.html' },
		})
		const bw = bwOf(created)

		// Bare view straight into the substrate compositor (no viewScope) → the
		// substrate.detachAll is the SOLE detacher at teardown.
		const { wcv } = mountBareViewInto(app, electron, bw)
		expect(bw.contentView.addChildView).toHaveBeenCalledWith(wcv)

		// Record whether the host was destroyed at each removeChildView call.
		const destroyedAtRemove: boolean[] = []
		bw.contentView.removeChildView.mockImplementation(() => { destroyedAtRemove.push(bw.destroyed) })

		await app.shutdown()

		// CORRECT (create path): substrate.detachAll ran on a LIVE host before destroy.
		expect(bw.contentView.removeChildView).toHaveBeenCalledWith(wcv)
		expect(bw.destroy).toHaveBeenCalled()
		expect(destroyedAtRemove).toContain(false)

		const removeOrder = bw.contentView.removeChildView.mock.invocationCallOrder[0]
		const destroyOrder = bw.destroy.mock.invocationCallOrder[0]
		expect(removeOrder).toBeDefined()
		expect(destroyOrder).toBeDefined()
		expect(removeOrder!).toBeLessThan(destroyOrder!)
	})

	it('TRANSFER-ADOPT window: substrate detachAll removes the view (live host) BEFORE window.destroy [REGRESSION-PIN]', async () => {
		const { app, electron } = bootApp()
		await app.start()

		const extWin = electron.makeExternalWindow()
		withFacade(app.runtime).windows.adopt(extWin as unknown, { ownership: 'transfer' })

		// Bare view straight into the adopted window's substrate compositor (no
		// viewScope) → substrate.detachAll is the SOLE detacher at teardown.
		const { wcv } = mountBareViewInto(app, electron, extWin)
		expect(extWin.contentView.addChildView).toHaveBeenCalledWith(wcv)

		const destroyedAtRemove: boolean[] = []
		extWin.contentView.removeChildView.mockImplementation(() => { destroyedAtRemove.push(extWin.destroyed) })

		await app.shutdown()

		// transfer → the framework destroys the window.
		expect(extWin.destroy).toHaveBeenCalled()

		// REGRESSION: adoptWindow owns the destroy disposable on the windowScope
		// AFTER the substrate's detachAll disposable, so LIFO destroys the window
		// FIRST. substrate.detachAll then commits against an ALREADY-destroyed host →
		// removeChildView is NEVER called for the bare view.
		expect(extWin.contentView.removeChildView).toHaveBeenCalledWith(wcv)
		expect(destroyedAtRemove).toContain(false)

		const removeOrder = extWin.contentView.removeChildView.mock.invocationCallOrder[0]
		const destroyOrder = extWin.destroy.mock.invocationCallOrder[0]
		expect(removeOrder).toBeDefined()
		expect(destroyOrder).toBeDefined()
		expect(removeOrder!).toBeLessThan(destroyOrder!)
	})
})

// Parity ref so an unused-import lint never masks the RED.
const _jsonParityRef: JsonValue = null
void _jsonParityRef
const _mwc: MinimalWebContents | null = null
void _mwc
