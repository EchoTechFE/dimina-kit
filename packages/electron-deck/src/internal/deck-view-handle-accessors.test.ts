/**
 * Contract tests for the `DeckViewHandle` accessors
 * (an additive surface on the handle returned by `runtime.view(...)`):
 *
 *   interface DeckViewHandle {
 *     readonly webContents: WebContents     // the native view's WebContents
 *     bounds(): ViewBounds | null           // live screen-space rect; null when
 *                                           //   not placed/visible
 *     capturePage(): Promise<NativeImage>   // pass-through to wc.capturePage()
 *   }
 *
 * Purpose: a caller can recover a view's WebContents / live bounds / screenshot
 * directly from the handle, WITHOUT diffing `mainWindow.contentView.children`
 * to re-derive the underlying WebContentsView.
 *
 * Every spec here exercises the runtime contract of these three members on the
 * handle the deck-app builds (`hostHandle` in src/internal/deck-app.ts):
 *   - `handle.webContents` is the native view's WebContents (identity check),
 *   - `handle.bounds()` returns the live screen-space rect (or null),
 *   - `handle.capturePage()` passes through to `wc.capturePage()`.
 * Reached through a single typed escape hatch (`withAccessors`) so the file
 * COMPILES against the published type and asserts on BEHAVIOR.
 *
 * Fakes: copied (minimal) from deck-app.host-view.test.ts. The local
 * `FakeWebContentsView` is EXTENDED here so the gap is testable:
 *   - `webContents.capturePage` (a vi.fn the pass-through must call) — the base
 *     fake webContents has no capturePage.
 *   - `setBounds` RECORDS the last rect + a `getBounds()` returns it — so a
 *     `bounds()` impl that delegates to the native view's `getBounds()` (or that
 *     tracks the last applied placement itself) both satisfy the same assertion.
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

// EXTENSION: the view's webContents gains a `capturePage` spy (the base
// MinimalWebContentsLike has none) so the pass-through assertion can stub it.
interface FakeWebContentsLike extends MinimalWebContentsLike {
	loadURL: ReturnType<typeof vi.fn> & MinimalWebContentsLike['loadURL']
	loadFile: ReturnType<typeof vi.fn> & MinimalWebContentsLike['loadFile']
	send: ReturnType<typeof vi.fn> & MinimalWebContentsLike['send']
	capturePage: ReturnType<typeof vi.fn>
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

// EXTENSION: `setBounds` records the last rect; `getBounds()` returns it. This
// lets a `bounds()` impl that reads the native view satisfy the same behavioral
// assertion as one that tracks the last applied placement internally.
interface FakeWebContentsView extends MinimalWebContentsView {
	readonly webContents: FakeWebContentsLike
	setBounds: ReturnType<typeof vi.fn> & MinimalWebContentsView['setBounds']
	getBounds(): MinimalRect | null
	_lastBounds: MinimalRect | null
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
			// Default: resolves to a fresh object; individual tests override with a
			// sentinel to assert the pass-through.
			capturePage: vi.fn(async () => ({})),
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
		_lastBounds: MinimalRect | null
		destroyed: boolean

		constructor(opts?: { webPreferences?: { preload?: string } }) {
			webContentsViewCtorCalls.push(opts)
			this.webContents = makeFakeWebContents()
			this._lastBounds = null
			this.setBounds = vi.fn((rect: MinimalRect) => {
				this._lastBounds = rect
			}) as FakeWebContentsView['setBounds']
			this.destroyed = false
			webContentsViews.push(this as unknown as FakeWebContentsView)
		}

		getBounds(): MinimalRect | null {
			return this._lastBounds
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

// ── Typed escape hatch for the handle accessors ──────────────────────────────
//
// `webContents` / `bounds()` / `capturePage()` are reached through a loose view
// so any regression that drops a member fails at RUNTIME (undefined member /
// "is not a function") — the runtime failure we want — not a compile error that
// would stop the suite running.
type Bounds = { x: number, y: number, width: number, height: number }
type Placement = { visible: true, bounds: Bounds } | { visible: false }
interface ViewSource {
	url?: string
	file?: string
}
interface AccessorViewHandle {
	placeIn(win: unknown, opts: { zone?: number }): AccessorViewHandle
	applyPlacement(p: Placement): AccessorViewHandle
	dispose(): Promise<void>
	// The NEW surface under test:
	readonly webContents: unknown
	bounds(): Bounds | null
	capturePage(): Promise<unknown>
}
interface RuntimeWithView {
	view(spec: { source: ViewSource, scope?: unknown }): AccessorViewHandle
	scopes: { create(): { dispose(): Promise<void> } }
}
function withAccessors(runtime: Runtime): RuntimeWithView {
	return runtime as unknown as RuntimeWithView
}

// The WCV the handle owns is the LAST WebContentsView the fake electron
// constructed during the `runtime.view(...)` call (no toolbar in these tests).
function lastWcv(electron: FakeElectron): FakeWebContentsView {
	const wcv = electron.webContentsViews[electron.webContentsViews.length - 1]
	if (!wcv) throw new Error('no WebContentsView was constructed')
	return wcv
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. handle.webContents === the underlying native view's webContents (identity).
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckViewHandle accessors — webContents identity', () => {
	it('handle.webContents is the SAME object as the native WCV webContents', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain: createFakeIpcMain() } })
		await app.start()

		const handle = withAccessors(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)

		// Identity: not a copy / id-only — the literal webContents of the view.
		expect(handle.webContents).toBe(wcv.webContents)

		await app.shutdown()
	})

	it('handle.webContents is exposed BEFORE any placeIn (handle owns its view immediately)', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain: createFakeIpcMain() } })
		await app.start()

		const handle = withAccessors(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)
		// No placeIn yet — the WebContents accessor must still resolve.
		expect(handle.webContents).toBe(wcv.webContents)

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. handle.bounds() reflects placement state:
//    - null before any placement,
//    - the applied rect after applyPlacement({visible:true, bounds}),
//    - null after applyPlacement({visible:false}),
//    - null after dispose().
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckViewHandle accessors — bounds()', () => {
	it('returns null before any placement', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain: createFakeIpcMain() } })
		await app.start()

		const handle = withAccessors(app.runtime).view({ source: { url: 'data:text/html,x' } })
		// Never placed → not on screen → null.
		expect(handle.bounds()).toBeNull()

		await app.shutdown()
	})

	it('returns the rect set by applyPlacement({visible:true, bounds})', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain: createFakeIpcMain() } })
		await app.start()

		const handle = withAccessors(app.runtime).view({ source: { url: 'data:text/html,x' } })
		handle.placeIn(app.runtime.mainWindow, { zone: 0 })
		handle.applyPlacement({ visible: true, bounds: { x: 10, y: 20, width: 300, height: 200 } })

		expect(handle.bounds()).toEqual({ x: 10, y: 20, width: 300, height: 200 })

		await app.shutdown()
	})

	it('returns null after applyPlacement({visible:false}) (detached → not placed)', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain: createFakeIpcMain() } })
		await app.start()

		const handle = withAccessors(app.runtime).view({ source: { url: 'data:text/html,x' } })
		handle.placeIn(app.runtime.mainWindow, { zone: 0 })
		handle.applyPlacement({ visible: true, bounds: { x: 1, y: 2, width: 3, height: 4 } })
		// Sanity: visible → has bounds.
		expect(handle.bounds()).toEqual({ x: 1, y: 2, width: 3, height: 4 })

		handle.applyPlacement({ visible: false })
		expect(handle.bounds()).toBeNull()

		await app.shutdown()
	})

	it('returns null after dispose()', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain: createFakeIpcMain() } })
		await app.start()

		const handle = withAccessors(app.runtime).view({ source: { url: 'data:text/html,x' } })
		handle.placeIn(app.runtime.mainWindow, { zone: 0 })
		handle.applyPlacement({ visible: true, bounds: { x: 5, y: 6, width: 7, height: 8 } })
		expect(handle.bounds()).toEqual({ x: 5, y: 6, width: 7, height: 8 })

		await handle.dispose()
		expect(handle.bounds()).toBeNull()

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. handle.capturePage() passes through to the view webContents' capturePage
//    and resolves with its result (sentinel round-trip).
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckViewHandle accessors — capturePage()', () => {
	it('calls through to the view webContents.capturePage and resolves with its result', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain: createFakeIpcMain() } })
		await app.start()

		const handle = withAccessors(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)
		// Sentinel "NativeImage" the pass-through must return verbatim.
		const sentinel = { __nativeImage: true } as unknown
		wcv.webContents.capturePage.mockResolvedValueOnce(sentinel)

		const result = await handle.capturePage()

		expect(wcv.webContents.capturePage).toHaveBeenCalledTimes(1)
		expect(result).toBe(sentinel)

		await app.shutdown()
	})
})

// A throwaway reference so an unused-import lint never masks a runtime failure (JsonValue
// is imported for parity with the copied fake helpers; reference it).
const _jsonValueParityRef: JsonValue = null
void _jsonValueParityRef
