import { describe, expect, it, vi } from 'vitest'
import type { RuntimeBackend, DeckConfig } from '../types.js'
import type {
	MinimalBrowserWindow,
	MinimalBrowserWindowOptions,
	MinimalElectron,
	MinimalRect,
	MinimalWebContentsLike,
	MinimalWebContentsView,
} from './electron-types.js'
import { DeckApp } from './deck-app.js'
import type { MinimalWebContents } from './wire-transport.js'

/**
 * Phase 3 — FAILURE-FIRST (TDD) contract for the framework's window-build seam
 * + the now-dead RuntimeBackend hooks that must get wired in the `ownsWindows`
 * falsy path (framework builds its own main window).
 *
 * These tests pin behaviour the implementation does NOT yet have:
 *   1. mainWindowWebPreferences()  — pre-ctor hook, merged into webPreferences.
 *   2. onMainWindowCreated(win, electron) — post-ctor / pre-load hook.
 *   3. AppConfig.window.{show,backgroundColor,webPreferences} pass-through.
 *   4. repositionOverlays(win)     — called with the window on resize.
 *   5. onWindowTrusted(wc)         — called for auto-trusted main + framework wcs.
 *   6. ownsWindows:true           — early-return: NO framework window and none of
 *      the 3 main-window-assembly hooks (onMainWindowCreated /
 *      mainWindowWebPreferences / repositionOverlays) nor the *main window's*
 *      auto-trust onWindowTrusted fire. onWindowTrusted is NOT a main-assembly
 *      hook though — it still fires for windows the backend explicitly asks the
 *      framework to build via runtime.windows.create() (see the positive case).
 *
 * They pin the Phase 3 seam contract. Hooks are attached via a loose structural
 * cast so the file COMPILES and any regression surfaces as an *assertion*
 * failure (spy never called), not a type error.
 */

// ── Minimal fake electron (self-contained mirror of deck-app.test.ts) ─────────

/** Raw ctor-options capture: typed loose so we can read seam-only fields
 *  (show / backgroundColor / webPreferences) that are not yet on
 *  MinimalBrowserWindowOptions. */
type RawWindowOptions = MinimalBrowserWindowOptions & {
	show?: boolean
	backgroundColor?: string
	webPreferences?: Record<string, unknown>
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
	destroyed: boolean
	_listeners: Map<string, Array<(...args: unknown[]) => void>>
	_emit(event: 'resize' | 'closed' | 'close'): void
}

interface FakeElectron extends MinimalElectron {
	browserWindows: FakeBrowserWindow[]
	webContentsViews: MinimalWebContentsView[]
	browserWindowCtorCalls: RawWindowOptions[]
}

function createFakeElectron(
	initialContentBounds: MinimalRect = { x: 0, y: 0, width: 1024, height: 768 },
): FakeElectron {
	let wcIdCounter = 100
	let winIdCounter = 1
	const browserWindows: FakeBrowserWindow[] = []
	const webContentsViews: MinimalWebContentsView[] = []
	const browserWindowCtorCalls: RawWindowOptions[] = []

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
		readonly contentView: MinimalBrowserWindow['contentView']
		destroyed: boolean
		getContentBounds: FakeBrowserWindow['getContentBounds']
		show: FakeBrowserWindow['show']
		destroy: FakeBrowserWindow['destroy']
		on: FakeBrowserWindow['on']
		_listeners: Map<string, Array<(...args: unknown[]) => void>>

		constructor(opts?: MinimalBrowserWindowOptions) {
			browserWindowCtorCalls.push((opts ?? {}) as RawWindowOptions)
			this.id = winIdCounter++
			this.webContents = makeFakeWebContents()
			this.destroyed = false
			this.contentView = {
				addChildView: vi.fn(),
				removeChildView: vi.fn(),
			} as MinimalBrowserWindow['contentView']
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

		_emit(event: 'resize' | 'closed' | 'close'): void {
			const arr = this._listeners.get(event)
			if (!arr) return
			if (event === 'close') {
				const ev = { preventDefault: vi.fn() }
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
		setBounds: MinimalWebContentsView['setBounds']

		constructor(_opts?: { webPreferences?: { preload?: string } }) {
			this.webContents = makeFakeWebContents()
			this.setBounds = vi.fn() as MinimalWebContentsView['setBounds']
			webContentsViews.push(this as unknown as MinimalWebContentsView)
		}
	}

	return {
		BrowserWindow: FakeBW as unknown as MinimalElectron['BrowserWindow'],
		WebContentsView: FakeWCV as unknown as MinimalElectron['WebContentsView'],
		browserWindows,
		webContentsViews,
		browserWindowCtorCalls,
	}
}

/**
 * Backend factory. Accepts loose seam hooks that are not yet declared on
 * RuntimeBackend (mainWindowWebPreferences / onMainWindowCreated) plus the
 * declared-but-currently-unused ones (onWindowTrusted / repositionOverlays).
 * Returns the value typed as RuntimeBackend so DeckApp accepts it; the loose
 * hooks ride along on the same object and the framework is expected to call
 * them once Phase 3 wires the seam.
 */
interface SeamBackend extends RuntimeBackend {
	mainWindowWebPreferences?(): Record<string, unknown> | undefined
	onMainWindowCreated?(win: unknown, electron: unknown): void
}

function makeBackend(extra: Partial<SeamBackend> = {}): SeamBackend & {
	assemble: ReturnType<typeof vi.fn>
} {
	const backend = {
		assemble: vi.fn(async () => undefined),
		...extra,
	} as SeamBackend & { assemble: ReturnType<typeof vi.fn> }
	return backend
}

// ── #1 mainWindowWebPreferences() ─────────────────────────────────────────────

describe('window-seam — backend.mainWindowWebPreferences() (framework-owned window)', () => {
	it('is called exactly once BEFORE the main BrowserWindow ctor', async () => {
		const electron = createFakeElectron()
		const order: string[] = []
		const mainWindowWebPreferences = vi.fn(() => {
			order.push('hook')
			return { sandbox: true }
		})
		// Wrap the ctor so we record when it runs relative to the hook.
		const OrigBW = electron.BrowserWindow
		Object.defineProperty(electron, 'BrowserWindow', {
			value: class extends (OrigBW as unknown as {
				new(opts?: MinimalBrowserWindowOptions): MinimalBrowserWindow
			}) {
				constructor(opts?: MinimalBrowserWindowOptions) {
					super(opts)
					order.push('ctor')
				}
			},
			configurable: true,
		})

		const backend = makeBackend({ mainWindowWebPreferences })
		const app = new DeckApp({}, { electron, backend })
		await app.start()

		expect(mainWindowWebPreferences).toHaveBeenCalledTimes(1)
		// hook must precede the very first BrowserWindow ctor (the main window)
		expect(order[0]).toBe('hook')
		expect(order).toContain('ctor')
		expect(order.indexOf('hook')).toBeLessThan(order.indexOf('ctor'))

		await app.shutdown()
	})

	it('returned prefs are merged into the main window webPreferences', async () => {
		const electron = createFakeElectron()
		const backend = makeBackend({
			mainWindowWebPreferences: () => ({ sandbox: true, nodeIntegration: false }),
		})
		const app = new DeckApp({}, { electron, backend })
		await app.start()

		const mainOpts = electron.browserWindowCtorCalls[0]
		expect(mainOpts).toBeDefined()
		expect(mainOpts!.webPreferences).toBeDefined()
		expect(mainOpts!.webPreferences!.sandbox).toBe(true)
		expect(mainOpts!.webPreferences!.nodeIntegration).toBe(false)

		await app.shutdown()
	})

	it('backend prefs win over AppConfig.window.webPreferences on key collision (backend precedence)', async () => {
		const electron = createFakeElectron()
		const backend = makeBackend({
			mainWindowWebPreferences: () => ({ sandbox: true }),
		})
		const cfg = {
			app: { window: { webPreferences: { sandbox: false, contextIsolation: true } } },
		} as unknown as DeckConfig
		const app = new DeckApp(cfg, { electron, backend })
		await app.start()

		const wp = electron.browserWindowCtorCalls[0]!.webPreferences!
		// config-supplied key survives
		expect(wp.contextIsolation).toBe(true)
		// collision resolved in backend's favour
		expect(wp.sandbox).toBe(true)

		await app.shutdown()
	})

	it('a backend WITHOUT mainWindowWebPreferences still builds the main window (hook optional)', async () => {
		const electron = createFakeElectron()
		const backend = makeBackend()
		const app = new DeckApp({}, { electron, backend })
		await app.start()
		expect(electron.browserWindows.length).toBeGreaterThanOrEqual(1)
		await app.shutdown()
	})
})

// ── #3 AppConfig.window pass-through ──────────────────────────────────────────

describe('window-seam — AppConfig.window pass-through into main window options', () => {
	it('window.show:false → main ctor options carry show:false', async () => {
		const electron = createFakeElectron()
		const cfg = { app: { window: { show: false } } } as unknown as DeckConfig
		const app = new DeckApp(cfg, { electron })
		await app.start()
		expect(electron.browserWindowCtorCalls[0]!.show).toBe(false)
		await app.shutdown()
	})

	it('window.backgroundColor → main ctor options carry backgroundColor', async () => {
		const electron = createFakeElectron()
		const cfg = { app: { window: { backgroundColor: '#1e1e1e' } } } as unknown as DeckConfig
		const app = new DeckApp(cfg, { electron })
		await app.start()
		expect(electron.browserWindowCtorCalls[0]!.backgroundColor).toBe('#1e1e1e')
		await app.shutdown()
	})

	it('window.webPreferences (no backend) → main ctor options carry those webPreferences', async () => {
		const electron = createFakeElectron()
		const cfg = {
			app: { window: { webPreferences: { contextIsolation: true } } },
		} as unknown as DeckConfig
		const app = new DeckApp(cfg, { electron })
		await app.start()
		const wp = electron.browserWindowCtorCalls[0]!.webPreferences
		expect(wp).toBeDefined()
		expect(wp!.contextIsolation).toBe(true)
		await app.shutdown()
	})
})

// ── #2 onMainWindowCreated(win, electron) ─────────────────────────────────────

describe('window-seam — backend.onMainWindowCreated(win, electron)', () => {
	it('is called once, AFTER the main window is constructed and BEFORE its content loads', async () => {
		const electron = createFakeElectron()
		const order: string[] = []

		// Record ctor completion order.
		const OrigBW = electron.BrowserWindow
		Object.defineProperty(electron, 'BrowserWindow', {
			value: class extends (OrigBW as unknown as {
				new(opts?: MinimalBrowserWindowOptions): MinimalBrowserWindow
			}) {
				constructor(opts?: MinimalBrowserWindowOptions) {
					super(opts)
					order.push('main-ctor')
					const wc = (this as unknown as FakeBrowserWindow).webContents
					// Tag load* so we can detect a load happening after the hook.
					const origURL = wc.loadURL
					wc.loadURL = vi.fn(async (u: string) => {
						order.push('load')
						return origURL(u)
					}) as FakeWebContentsLike['loadURL']
					const origFile = wc.loadFile
					wc.loadFile = vi.fn(async (p: string) => {
						order.push('load')
						return origFile(p)
					}) as FakeWebContentsLike['loadFile']
				}
			},
			configurable: true,
		})

		const onMainWindowCreated = vi.fn((_win: unknown, _electron: unknown) => {
			order.push('onMainWindowCreated')
		})
		const backend = makeBackend({ onMainWindowCreated })
		const app = new DeckApp({}, { electron, backend })
		await app.start()

		expect(onMainWindowCreated).toHaveBeenCalledTimes(1)
		// after the main ctor
		expect(order.indexOf('onMainWindowCreated')).toBeGreaterThan(order.indexOf('main-ctor'))
		// before any load on the main window (if a load happens at all, it is later)
		const loadIdx = order.indexOf('load')
		if (loadIdx !== -1) {
			expect(order.indexOf('onMainWindowCreated')).toBeLessThan(loadIdx)
		}

		await app.shutdown()
	})

	it('receives the framework-built main window and the injected electron module', async () => {
		const electron = createFakeElectron()
		const onMainWindowCreated = vi.fn()
		const backend = makeBackend({ onMainWindowCreated })
		const app = new DeckApp({}, { electron, backend })
		await app.start()

		expect(onMainWindowCreated).toHaveBeenCalledTimes(1)
		const [winArg, electronArg] = onMainWindowCreated.mock.calls[0] as [unknown, unknown]
		expect(winArg).toBe(electron.browserWindows[0])
		expect(electronArg).toBe(electron)

		await app.shutdown()
	})
})

// ── #4 repositionOverlays(win) on resize ─────────────────────────────────────

describe('window-seam — backend.repositionOverlays(win) on main window resize', () => {
	it('is called with the main window when the main window emits "resize"', async () => {
		const electron = createFakeElectron()
		const repositionOverlays = vi.fn()
		// repositionOverlays is declared on RuntimeBackend as `(): void` today;
		// Phase 3 widens it to `(win)`. We pass it through the loose factory.
		const backend = makeBackend({
			repositionOverlays: repositionOverlays as unknown as RuntimeBackend['repositionOverlays'],
		})
		const app = new DeckApp({}, { electron, backend })
		await app.start()

		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow
		mainWin._emit('resize')

		expect(repositionOverlays).toHaveBeenCalled()
		expect(repositionOverlays.mock.calls[0]?.[0]).toBe(mainWin)

		await app.shutdown()
	})
})

// ── #5 onWindowTrusted(wc) for auto-trusted framework webContents ─────────────

describe('window-seam — backend.onWindowTrusted(wc) for framework auto-trust', () => {
	it('is called exactly once with the main window webContents, and the returned Disposable is registered (disposed on teardown)', async () => {
		const electron = createFakeElectron()
		const trusted: MinimalWebContents[] = []
		const dispose = vi.fn()
		const onWindowTrusted = vi.fn((wc: MinimalWebContents) => {
			trusted.push(wc)
			return { dispose }
		})
		const backend = makeBackend({ onWindowTrusted })
		const app = new DeckApp({}, { electron, backend })
		await app.start()

		const mainWc = (electron.browserWindows[0] as unknown as FakeBrowserWindow).webContents
		// no framework webview content (no toolbar/windows), so the main
		// window is the only framework-built+trusted wc: exactly one call.
		expect(onWindowTrusted).toHaveBeenCalledTimes(1)
		expect(trusted.some(wc => wc.id === mainWc.id)).toBe(true)
		// The returned Disposable must be wired into the framework registry, so it
		// actually fires on shutdown rather than leaking the domain trust mirror.
		expect(dispose).not.toHaveBeenCalled()
		await app.shutdown()
		expect(dispose).toHaveBeenCalledTimes(1)
	})

	it('is called for a framework-built declared window webContents too', async () => {
		const electron = createFakeElectron()
		const seenIds: number[] = []
		const onWindowTrusted = vi.fn((wc: MinimalWebContents) => {
			seenIds.push(wc.id)
			return { dispose: () => {} }
		})
		const backend = makeBackend({ onWindowTrusted })
		const app = new DeckApp(
			{
				windows: {
					reauth: { source: { url: 'http://localhost:5173/reauth.html' } },
				},
			},
			{ electron, backend, wireTransport: { ipcMain: makeIpcMain() } },
		)
		await app.start()

		const declaredWc = (electron.browserWindows[1] as unknown as FakeBrowserWindow).webContents
		expect(seenIds).toContain(declaredWc.id)

		await app.shutdown()
	})
})

// ── #6 ownsWindows:true → early-return, NO window, NO seam hooks ──────────────

describe('window-seam — ownsWindows:true skips framework window build + all seam hooks', () => {
	it('framework constructs NO BrowserWindow when backend.ownsWindows is true', async () => {
		const electron = createFakeElectron()
		const backend = makeBackend({ ownsWindows: true })
		const app = new DeckApp({}, { electron, backend })
		await app.start()
		expect(electron.browserWindows).toHaveLength(0)
		expect(electron.browserWindowCtorCalls).toHaveLength(0)
		await app.shutdown()
	})

	it('none of the 3 main-window-assembly hooks fire under ownsWindows:true', async () => {
		// Narrowed (was "none of the seam hooks fire"): ownsWindows:true skips only
		// the **main-window-assembly seam** — the 3 main-build hooks plus the main
		// window's own auto-trust onWindowTrusted. It does NOT promise that
		// onWindowTrusted never fires at all: a window-owning backend may still ask
		// the framework to build + trust extra windows via runtime.windows.create()
		// (pinned by the positive case below). Here assemble() does nothing, so no
		// such window exists and onWindowTrusted stays uncalled — but we assert that
		// via the *main window* not being trusted, not as a blanket "never".
		const electron = createFakeElectron()
		const mainWindowWebPreferences = vi.fn(() => ({}))
		const onMainWindowCreated = vi.fn()
		const repositionOverlays = vi.fn()
		const onWindowTrusted = vi.fn(() => ({ dispose: () => {} }))
		const backend = makeBackend({
			ownsWindows: true,
			mainWindowWebPreferences,
			onMainWindowCreated,
			repositionOverlays: repositionOverlays as unknown as RuntimeBackend['repositionOverlays'],
			onWindowTrusted,
		})
		const app = new DeckApp({}, { electron, backend })
		await app.start()

		expect(mainWindowWebPreferences).not.toHaveBeenCalled()
		expect(onMainWindowCreated).not.toHaveBeenCalled()
		expect(repositionOverlays).not.toHaveBeenCalled()
		// The framework built no main window, so its main-window auto-trust seam
		// never fired. (We assert specifically about the main window rather than a
		// blanket "onWindowTrusted never called", which would over-claim — see the
		// positive case: runtime.windows.create() does trigger it under ownsWindows.)
		expect(electron.browserWindows).toHaveLength(0)
		expect(onWindowTrusted).not.toHaveBeenCalled()

		await app.shutdown()
	})

	it('runtime.windows.create() under ownsWindows:true STILL fires onWindowTrusted (orthogonal to ownsWindows)', async () => {
		// Positive pin: onWindowTrusted is NOT a main-window-assembly hook — it
		// fires for any window the framework itself builds + trusts. A window-owning
		// backend that calls runtime.windows.create() in assemble() has explicitly
		// asked the framework to build + trust that window, so the notification is
		// intentional, even though ownsWindows:true suppressed the main-window seam.
		const electron = createFakeElectron()
		const trustedIds: number[] = []
		const onWindowTrusted = vi.fn((wc: MinimalWebContents) => {
			trustedIds.push(wc.id)
			return { dispose: () => {} }
		})
		const backend = makeBackend({
			ownsWindows: true,
			onWindowTrusted,
			assemble: vi.fn(async (runtime: import('../types.js').Runtime) => {
				runtime.windows.create({ source: { url: 'http://localhost:5173/extra.html' } })
			}),
		})
		const app = new DeckApp(
			{},
			{ electron, backend, wireTransport: { ipcMain: makeIpcMain() } },
		)
		await app.start()

		// Exactly one framework-built window (the create() call); no main window.
		expect(electron.browserWindows).toHaveLength(1)
		const createdWc = (electron.browserWindows[0] as unknown as FakeBrowserWindow).webContents
		expect(onWindowTrusted).toHaveBeenCalledTimes(1)
		expect(trustedIds).toEqual([createdWc.id])

		await app.shutdown()
	})

	it('assemble() still runs under ownsWindows:true (backend owns its own window)', async () => {
		const electron = createFakeElectron()
		const backend = makeBackend({ ownsWindows: true })
		const app = new DeckApp({}, { electron, backend })
		await app.start()
		expect(backend.assemble).toHaveBeenCalledTimes(1)
		await app.shutdown()
	})
})

// ── A1a — onWindowTrusted Disposable disposed on the window's close ──────────

describe('window-seam — onWindowTrusted Disposable is disposed when THAT window closes', () => {
	it('a framework-built declared window: its trust Disposable is NOT disposed while alive, then disposed exactly once on close', async () => {
		const electron = createFakeElectron()
		// Map each trusted wc.id to its own spy Disposable so we can prove the
		// framework disposes the right one when a specific window closes.
		const disposeByWcId = new Map<number, ReturnType<typeof vi.fn>>()
		const onWindowTrusted = vi.fn((wc: MinimalWebContents) => {
			const dispose = vi.fn()
			disposeByWcId.set(wc.id, dispose)
			return { dispose }
		})
		const backend = makeBackend({ onWindowTrusted })
		const app = new DeckApp(
			{
				windows: {
					reauth: { source: { url: 'http://localhost:5173/reauth.html' } },
				},
			},
			{ electron, backend, wireTransport: { ipcMain: makeIpcMain() } },
		)
		await app.start()

		// browserWindows[0] = framework main window, [1] = declared sub-window.
		const subWin = electron.browserWindows[1] as unknown as FakeBrowserWindow
		const subDispose = disposeByWcId.get(subWin.webContents.id)
		expect(subDispose).toBeDefined()
		// Window is still alive → its trust mirror must NOT have been undone yet.
		expect(subDispose!).not.toHaveBeenCalled()

		// Close the sub-window → handleSubWindowClosed → dispose its trust mirror.
		subWin._emit('closed')
		expect(subDispose!).toHaveBeenCalledTimes(1)

		await app.shutdown()
		// teardown's registry safety net must not double-dispose (one-shot wrapper).
		expect(subDispose!).toHaveBeenCalledTimes(1)
	})

	it('closing a sub-window disposes ONLY that window\'s trust mirror; the main window\'s survives until teardown (per-window, not one-shot-all)', async () => {
		const electron = createFakeElectron()
		const disposeByWcId = new Map<number, ReturnType<typeof vi.fn>>()
		const onWindowTrusted = vi.fn((wc: MinimalWebContents) => {
			const dispose = vi.fn()
			disposeByWcId.set(wc.id, dispose)
			return { dispose }
		})
		const backend = makeBackend({ onWindowTrusted })
		const app = new DeckApp(
			{
				windows: {
					reauth: { source: { url: 'http://localhost:5173/reauth.html' } },
				},
			},
			{ electron, backend, wireTransport: { ipcMain: makeIpcMain() } },
		)
		await app.start()

		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow
		const subWin = electron.browserWindows[1] as unknown as FakeBrowserWindow
		const mainDispose = disposeByWcId.get(mainWin.webContents.id)
		const subDispose = disposeByWcId.get(subWin.webContents.id)
		expect(mainDispose).toBeDefined()
		expect(subDispose).toBeDefined()
		expect(mainDispose).not.toBe(subDispose)

		// Close ONLY the sub-window.
		subWin._emit('closed')
		// Sub's mirror undone; main's still active (window alive).
		expect(subDispose!).toHaveBeenCalledTimes(1)
		expect(mainDispose!).not.toHaveBeenCalled()

		// Teardown disposes the still-registered main-window mirror.
		await app.shutdown()
		expect(mainDispose!).toHaveBeenCalledTimes(1)
		// Sub's is not disposed a second time by teardown.
		expect(subDispose!).toHaveBeenCalledTimes(1)
	})

	it('a window created via runtime.windows.create(): its trust Disposable is disposed on that window\'s close', async () => {
		const electron = createFakeElectron()
		const disposeByWcId = new Map<number, ReturnType<typeof vi.fn>>()
		const onWindowTrusted = vi.fn((wc: MinimalWebContents) => {
			const dispose = vi.fn()
			disposeByWcId.set(wc.id, dispose)
			return { dispose }
		})
		const backend = makeBackend({
			onWindowTrusted,
			assemble: vi.fn(async (runtime: import('../types.js').Runtime) => {
				runtime.windows.create({ source: { url: 'http://localhost:5173/extra.html' } })
			}),
		})
		const app = new DeckApp(
			{},
			{ electron, backend, wireTransport: { ipcMain: makeIpcMain() } },
		)
		await app.start()

		// [0] = framework main window, [1] = runtime.windows.create() window.
		const createdWin = electron.browserWindows[1] as unknown as FakeBrowserWindow
		const createdDispose = disposeByWcId.get(createdWin.webContents.id)
		expect(createdDispose).toBeDefined()
		expect(createdDispose!).not.toHaveBeenCalled()

		createdWin._emit('closed')
		expect(createdDispose!).toHaveBeenCalledTimes(1)

		await app.shutdown()
		expect(createdDispose!).toHaveBeenCalledTimes(1)
	})
})

// #7 (reverse guarantee that RuntimeBackend drops mountToolbar / isDomainTrusted)
// is intentionally NOT encoded as a test: it can only be a compile-time pin, and
// per the TDD constraint these tests must fail by *assertion*, not by failing to
// compile. The deletion is verified in the report instead. Both hooks are still
// declared on RuntimeBackend today (src/types.ts:277 isDomainTrusted, :293
// mountToolbar) with no test references — safe for the implementer to remove.

// ── local ipcMain fake (only needed for the declared-windows trust test) ─────

function makeIpcMain(): import('./wire-transport.js').MinimalIpcMain {
	const handlers = new Map<string, unknown>()
	return {
		handle: ((channel: string, handler: unknown) => {
			handlers.set(channel, handler)
		}) as import('./wire-transport.js').MinimalIpcMain['handle'],
		removeHandler: ((channel: string) => {
			handlers.delete(channel)
		}) as import('./wire-transport.js').MinimalIpcMain['removeHandler'],
	}
}
