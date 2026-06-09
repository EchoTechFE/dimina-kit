/**
 * TDD failing-first contract tests for "keepAlive" (build-plan §2(f) /
 * docs/contracts/capability-and-lifecycle.md §B3). TWO parts:
 *
 * PART 1 — LIFETIME / LEAK FIX (the critical half). Today a `runtime.view`'s
 * native `WebContentsView` is only DETACHED on teardown (removeChildView); its
 * backing `webContents` is NEVER destroyed (the slice-1 host-view test even
 * pins `wcv.destroyed === false`). That leaks a renderer process for the life
 * of the app. The contract (§B3.1): the keep-alive view's WebContents is `own()`d
 * by its Scope, so it is DESTROYED (`webContents.close()`, guarded by
 * `isDestroyed()`) when the view is explicitly disposed, when its window closes
 * (windowScope cascade), or when an explicit `opts.scope` (home/session) closes —
 * idempotent (never double-closed).
 *
 * PART 2 — opt-in LRU helper (§B3.2). `runtime.view({ keepAlive:{policy:'lru',
 * max:N} })` tracks a per-policy-group LRU of HIDDEN views; making a view visible
 * marks it recently-used; when the count of HIDDEN keep-alive views in a group
 * exceeds `max`, the LEAST-recently-visible HIDDEN view is disposed (its
 * WebContents destroyed). Visible views are NEVER evicted. Omitting `keepAlive`
 * → the framework evicts nothing.
 *
 * These are RED today because (1) no `webContents.close()` is ever called by the
 * view factory's dispose / scope cascade, and (2) `keepAlive` is not honored.
 *
 * Fakes: replicated minimally from deck-app.host-view.test.ts. The fake
 * `webContents` is EXTENDED with a `close: vi.fn()` spy that flips the
 * `destroyed` flag backing `isDestroyed()` — so "the native WebContents was
 * destroyed" is observable as `close()` being called (and idempotency as
 * "not called twice once destroyed").
 *
 * The not-yet-typed `keepAlive` option and the not-yet-typed `webContents.close`
 * are reached through typed escape hatches so the file COMPILES (RED at runtime /
 * assertion, not a compile error that would stop the suite running).
 */
import { describe, expect, it, vi } from 'vitest'
import { createScope } from '../main/scope.js'
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

// ── Minimal fakes (replicated from deck-app.host-view.test.ts) ───────────────

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

// EXTENDED vs the host-view fake: a `close` spy that flips the `destroyed` flag
// backing `isDestroyed()`. This is what makes "the native WebContents was
// destroyed (not leaked)" observable — and idempotency ("not closed twice once
// destroyed") testable via the spy's call count.
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
			// EXTENSION: destroy the native WebContents (flips the isDestroyed flag).
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
// `keepAlive` is not in `ViewCreateOptions` yet, and `webContents.close` is not
// in `MinimalWebContentsLike` yet. Reach both through loose views so the file
// COMPILES — absence then fails as a RED assertion (close() never called), not a
// compile error that would stop the suite running.
type Bounds = { x: number, y: number, width: number, height: number }
type Placement = { visible: true, bounds: Bounds } | { visible: false }
interface ViewSource {
	url?: string
	file?: string
}
interface KeepAliveSpec {
	policy: 'lru'
	max: number
}
interface HostViewHandle {
	placeIn(win: unknown, opts: { zone?: number }): HostViewHandle
	applyPlacement(p: Placement): HostViewHandle
	dispose(): Promise<void>
}
interface RuntimeWithView {
	view(spec: { source: ViewSource, scope?: unknown, keepAlive?: KeepAliveSpec }): HostViewHandle
}
function withView(runtime: Runtime): RuntimeWithView {
	return runtime as unknown as RuntimeWithView
}

// The WCV the handle owns is the LAST WebContentsView the fake electron
// constructed during the `runtime.view(...)` call (no toolbar in these tests).
function lastWcv(electron: FakeElectron): FakeWebContentsView {
	const wcv = electron.webContentsViews[electron.webContentsViews.length - 1]
	if (!wcv) throw new Error('no WebContentsView was constructed')
	return wcv
}

const VISIBLE = (b: Bounds = { x: 0, y: 0, width: 10, height: 10 }): Placement => ({ visible: true, bounds: b })
const HIDDEN: Placement = { visible: false }

// ═════════════════════════════════════════════════════════════════════════════
// PART 1 — LIFETIME / LEAK FIX (the critical half). The native WebContents
// backing a runtime.view is DESTROYED (webContents.close(), guarded by
// isDestroyed()) on dispose / window-close / explicit-scope-close, idempotently.
// ═════════════════════════════════════════════════════════════════════════════
describe('keepAlive — Part 1 lifetime/leak fix: the native WebContents is destroyed, not leaked', () => {
	// ── #1 (CRITICAL) — explicit dispose destroys the native WebContents. ──────
	it('#1 [CRITICAL] dispose() closes the placed view\'s native webContents exactly once', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain: createFakeIpcMain() } })
		await app.start()

		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)
		handle.placeIn(app.runtime.mainWindow, { zone: 0 })

		await handle.dispose()

		// The native WebContents was DESTROYED (close), not merely detached.
		expect(wcv.webContents.close).toHaveBeenCalledTimes(1)
		expect(wcv.webContents.isDestroyed()).toBe(true)

		await app.shutdown()
	})

	// ── #2 (CRITICAL) — window close destroys every placed view's WebContents. ──
	it('#2 [CRITICAL] closing the window (windowScope cascade) destroys the placed view\'s webContents', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain: createFakeIpcMain() } })
		await app.start()

		// A runtime-created window so its 'closed' runs the windowScope cascade
		// (not a full app shutdown), which must destroy the view it hosts.
		const win = app.runtime.windows.create({
			source: { url: 'http://localhost:5173/popout.html' },
		}) as unknown as FakeBrowserWindow

		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)
		handle.placeIn(win as unknown as Runtime['mainWindow'], { zone: 0 })

		expect(wcv.webContents.close).not.toHaveBeenCalled()
		win._emit('closed')
		await new Promise(r => setTimeout(r, 0))

		// The window's close cascaded into the view's scope → WebContents destroyed.
		expect(wcv.webContents.close).toHaveBeenCalled()
		expect(wcv.webContents.isDestroyed()).toBe(true)

		await app.shutdown()
	})

	// ── #3 — idempotent: dispose THEN window-close does not double-close. ───────
	it('#3 idempotent — dispose then window-close (and double dispose) never closes an already-destroyed wc twice; no throw', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain: createFakeIpcMain() } })
		await app.start()

		const win = app.runtime.windows.create({
			source: { url: 'http://localhost:5173/popout.html' },
		}) as unknown as FakeBrowserWindow

		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)
		handle.placeIn(win as unknown as Runtime['mainWindow'], { zone: 0 })

		await handle.dispose()
		expect(wcv.webContents.close).toHaveBeenCalledTimes(1)

		// A second dispose + the window's own 'closed' cascade must each find the
		// wc already destroyed (guard: if (!isDestroyed()) close()) → still 1 call.
		await expect(handle.dispose()).resolves.toBeUndefined()
		expect(() => win._emit('closed')).not.toThrow()
		await new Promise(r => setTimeout(r, 0))

		expect(wcv.webContents.close).toHaveBeenCalledTimes(1)

		await app.shutdown()
	})

	// ── #4 — explicit opts.scope close destroys the wc (backstop); and without
	//        an explicit scope, app.shutdown still destroys it. ─────────────────
	it('#4 an explicit opts.scope (session) closing destroys the view\'s webContents (home-scope backstop)', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain: createFakeIpcMain() } })
		await app.start()

		const sessionScope = createScope()
		const handle = withView(app.runtime).view({
			source: { url: 'data:text/html,x' },
			scope: sessionScope,
		})
		const wcv = lastWcv(electron)
		handle.placeIn(app.runtime.mainWindow, { zone: 0 })

		await sessionScope.close()
		await new Promise(r => setTimeout(r, 0))

		expect(wcv.webContents.close).toHaveBeenCalled()
		expect(wcv.webContents.isDestroyed()).toBe(true)

		await app.shutdown()
	})

	it('#4b without an explicit scope (rootScope default), app.shutdown() still destroys the view\'s webContents', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain: createFakeIpcMain() } })
		await app.start()

		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)
		handle.placeIn(app.runtime.mainWindow, { zone: 0 })

		await app.shutdown()

		expect(wcv.webContents.close).toHaveBeenCalled()
		expect(wcv.webContents.isDestroyed()).toBe(true)
	})

	// ── #5 — a NEVER-PLACED view still destroys its wc on dispose (no leak). ────
	it('#5 a runtime.view that is never placed, then dispose() → its webContents.close() is still called (no leak)', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain: createFakeIpcMain() } })
		await app.start()

		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)

		// Never placeIn — straight to dispose.
		await handle.dispose()

		expect(wcv.webContents.close).toHaveBeenCalledTimes(1)
		expect(wcv.webContents.isDestroyed()).toBe(true)

		await app.shutdown()
	})
})

// ═════════════════════════════════════════════════════════════════════════════
// PART 2 — opt-in LRU helper (§B3.2). keepAlive:{policy:'lru',max:N} evicts the
// least-recently-visible HIDDEN view in a group once HIDDEN keep-alive views
// exceed `max`. Visible views are never evicted. No keepAlive → evict nothing.
// ═════════════════════════════════════════════════════════════════════════════
describe('keepAlive — Part 2 opt-in LRU helper (B3.2)', () => {
	// ── a) exceed max hidden → least-recent-hidden disposed (wc destroyed). ─────
	it('a) keepAlive {policy:lru,max:2}: hiding a 3rd view (exceeds max) disposes the FIRST-hidden (least-recent) view', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain: createFakeIpcMain() } })
		await app.start()

		const keepAlive: KeepAliveSpec = { policy: 'lru', max: 2 }
		const a = withView(app.runtime).view({ source: { url: 'data:text/html,a' }, keepAlive })
		const wcvA = lastWcv(electron)
		const b = withView(app.runtime).view({ source: { url: 'data:text/html,b' }, keepAlive })
		const wcvB = lastWcv(electron)
		const c = withView(app.runtime).view({ source: { url: 'data:text/html,c' }, keepAlive })
		const wcvC = lastWcv(electron)

		a.placeIn(app.runtime.mainWindow, { zone: 0 })
		b.placeIn(app.runtime.mainWindow, { zone: 0 })
		c.placeIn(app.runtime.mainWindow, { zone: 0 })

		// Hide in a known order: A first (least recent), then B, then C.
		a.applyPlacement(HIDDEN) // hidden group: [A]            (1 ≤ max)
		b.applyPlacement(HIDDEN) // hidden group: [A, B]         (2 ≤ max)
		await new Promise(r => setTimeout(r, 0))
		// A and B still alive at this point (within max).
		expect(wcvA.webContents.close).not.toHaveBeenCalled()
		expect(wcvB.webContents.close).not.toHaveBeenCalled()

		c.applyPlacement(HIDDEN) // hidden group exceeds max=2 → evict LEAST-recent = A
		await new Promise(r => setTimeout(r, 0))

		// A (least-recently-hidden) is disposed → its WebContents destroyed.
		expect(wcvA.webContents.close).toHaveBeenCalled()
		expect(wcvA.webContents.isDestroyed()).toBe(true)
		// B and C (more recently hidden) survive.
		expect(wcvB.webContents.close).not.toHaveBeenCalled()
		expect(wcvC.webContents.close).not.toHaveBeenCalled()

		await app.shutdown()
	})

	// ── b) a VISIBLE view is never evicted. ─────────────────────────────────────
	it('b) keepAlive {max:1}: a currently-visible view is never evicted; only the least-recent HIDDEN one is', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain: createFakeIpcMain() } })
		await app.start()

		const keepAlive: KeepAliveSpec = { policy: 'lru', max: 1 }
		const a = withView(app.runtime).view({ source: { url: 'data:text/html,a' }, keepAlive })
		const wcvA = lastWcv(electron)
		const b = withView(app.runtime).view({ source: { url: 'data:text/html,b' }, keepAlive })
		const wcvB = lastWcv(electron)
		const c = withView(app.runtime).view({ source: { url: 'data:text/html,c' }, keepAlive })
		const wcvC = lastWcv(electron)

		a.placeIn(app.runtime.mainWindow, { zone: 0 })
		b.placeIn(app.runtime.mainWindow, { zone: 0 })
		c.placeIn(app.runtime.mainWindow, { zone: 0 })

		// A stays VISIBLE the whole time; B then C get hidden.
		a.applyPlacement(VISIBLE())
		b.applyPlacement(HIDDEN) // hidden group: [B]            (1 ≤ max)
		c.applyPlacement(HIDDEN) // hidden group exceeds max=1 → evict least-recent HIDDEN = B
		await new Promise(r => setTimeout(r, 0))

		// A (visible) is NEVER evicted.
		expect(wcvA.webContents.close).not.toHaveBeenCalled()
		expect(wcvA.webContents.isDestroyed()).toBe(false)
		// The least-recently-hidden (B) is evicted; C (most recent) survives.
		expect(wcvB.webContents.close).toHaveBeenCalled()
		expect(wcvC.webContents.close).not.toHaveBeenCalled()

		await app.shutdown()
	})

	// ── KA-4) a negative / invalid max is NOT keep-alive-managed (no eviction,
	//          no infinite loop). The view behaves as if no keepAlive was passed. ─
	it('KA-4) keepAlive {policy:lru,max:-1} is NOT managed: hiding views evicts/loops nothing', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain: createFakeIpcMain() } })
		await app.start()

		// max:-1 is invalid (negative). The view is NOT keep-alive-managed, so the
		// `while (hidden.length > max)` loop must never run (a negative max would
		// otherwise evict EVERY hidden view / spin).
		const keepAlive: KeepAliveSpec = { policy: 'lru', max: -1 }
		const a = withView(app.runtime).view({ source: { url: 'data:text/html,a' }, keepAlive })
		const wcvA = lastWcv(electron)
		const b = withView(app.runtime).view({ source: { url: 'data:text/html,b' }, keepAlive })
		const wcvB = lastWcv(electron)

		a.placeIn(app.runtime.mainWindow, { zone: 0 })
		b.placeIn(app.runtime.mainWindow, { zone: 0 })

		a.applyPlacement(HIDDEN)
		b.applyPlacement(HIDDEN)
		await new Promise(r => setTimeout(r, 0))

		// Nothing was evicted: an invalid max disables keep-alive management entirely.
		expect(wcvA.webContents.close).not.toHaveBeenCalled()
		expect(wcvB.webContents.close).not.toHaveBeenCalled()

		await app.shutdown()
	})

	// ── KA-2) [NEW PIN] window-close cleans the keepAlive group (no dead residue).
	//
	// Bug: the group cleanup used to live ONLY in hostHandle.dispose(). A WINDOW
	// close cascades the inner viewScope DIRECTLY (not via hostHandle.dispose), so
	// the group was never cleaned on window-close → a dead handle/hidden entry
	// stuck around and skewed later eviction. Fix: the cleanup hangs off the
	// viewScope (via createViewHandle's onDispose), so window-close cleans it too.
	//
	// Observable (the cleanest one): A is a keepAlive view placed + hidden in a
	// popout window. Closing that WINDOW (fire 'closed', NOT handle.dispose) must
	// (1) destroy A's WebContents AND (2) remove A from the shared `lru:1` group so
	// it occupies no slot. We prove (2) by then hiding B and C in the SAME group:
	// eviction is computed over the LIVE hidden views only, so hiding C (the 2nd
	// live hidden) evicts B — the FIRST LIVE least-recent — not nothing and not a
	// stale A. A dead-residue A would have sat at the front of `hidden` and been
	// (re)evicted first / corrupted the order. ───────────────────────────────────
	it('KA-2) [NEW PIN] a window-close cleans the keepAlive group (dead view occupies no slot; live eviction is unskewed)', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain: createFakeIpcMain() } })
		await app.start()

		const keepAlive: KeepAliveSpec = { policy: 'lru', max: 1 }

		// A: placed + hidden in a runtime-created popout window so its viewScope is a
		// child of THAT window's scope (closing the window cascades into it).
		const win = app.runtime.windows.create({
			source: { url: 'http://localhost:5173/popout.html' },
		}) as unknown as FakeBrowserWindow
		const a = withView(app.runtime).view({ source: { url: 'data:text/html,a' }, keepAlive })
		const wcvA = lastWcv(electron)
		a.placeIn(win as unknown as Runtime['mainWindow'], { zone: 0 })
		a.applyPlacement(HIDDEN) // hidden group `lru:1`: [A]  (1 ≤ max)
		await new Promise(r => setTimeout(r, 0))
		expect(wcvA.webContents.close).not.toHaveBeenCalled() // within budget, alive

		// Close the WINDOW (cascade) — NOT an explicit a.dispose().
		win._emit('closed')
		await new Promise(r => setTimeout(r, 0))
		// (1) lifetime: A's WebContents destroyed by the window-scope cascade.
		expect(wcvA.webContents.close).toHaveBeenCalledTimes(1)
		expect(wcvA.webContents.isDestroyed()).toBe(true)

		// (2) group residue: A must be GONE from the `lru:1` group. Prove it via the
		// live eviction below — B and C are placed + hidden in the SAME group.
		const b = withView(app.runtime).view({ source: { url: 'data:text/html,b' }, keepAlive })
		const wcvB = lastWcv(electron)
		const c = withView(app.runtime).view({ source: { url: 'data:text/html,c' }, keepAlive })
		const wcvC = lastWcv(electron)
		b.placeIn(app.runtime.mainWindow, { zone: 0 })
		c.placeIn(app.runtime.mainWindow, { zone: 0 })

		b.applyPlacement(HIDDEN) // live hidden: [B]            (1 ≤ max)
		await new Promise(r => setTimeout(r, 0))
		// If A had leaked into the group, [A,B] would already exceed max=1 and evict
		// the front (A or a corrupted entry) here. With a clean group, B is alone.
		expect(wcvB.webContents.close).not.toHaveBeenCalled()
		expect(wcvA.webContents.close).toHaveBeenCalledTimes(1) // A NOT re-disposed

		c.applyPlacement(HIDDEN) // live hidden exceeds max=1 → evict least-recent = B
		await new Promise(r => setTimeout(r, 0))
		// Eviction was over LIVE views only: B (the first live least-recent) is the
		// victim; C survives; A is untouched (still exactly one close).
		expect(wcvB.webContents.close).toHaveBeenCalledTimes(1)
		expect(wcvC.webContents.close).not.toHaveBeenCalled()
		expect(wcvA.webContents.close).toHaveBeenCalledTimes(1)

		await app.shutdown()
	})

	// ── c) no keepAlive → evict nothing. ───────────────────────────────────────
	it('c) NO keepAlive → creating many views and hiding them evicts nothing (no close beyond explicit dispose)', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain: createFakeIpcMain() } })
		await app.start()

		const a = withView(app.runtime).view({ source: { url: 'data:text/html,a' } })
		const wcvA = lastWcv(electron)
		const b = withView(app.runtime).view({ source: { url: 'data:text/html,b' } })
		const wcvB = lastWcv(electron)
		const c = withView(app.runtime).view({ source: { url: 'data:text/html,c' } })
		const wcvC = lastWcv(electron)

		a.placeIn(app.runtime.mainWindow, { zone: 0 })
		b.placeIn(app.runtime.mainWindow, { zone: 0 })
		c.placeIn(app.runtime.mainWindow, { zone: 0 })

		a.applyPlacement(HIDDEN)
		b.applyPlacement(HIDDEN)
		c.applyPlacement(HIDDEN)
		await new Promise(r => setTimeout(r, 0))

		// No keepAlive policy → the framework evicts NOTHING (pure host management).
		expect(wcvA.webContents.close).not.toHaveBeenCalled()
		expect(wcvB.webContents.close).not.toHaveBeenCalled()
		expect(wcvC.webContents.close).not.toHaveBeenCalled()

		await app.shutdown()
	})
})

// A throwaway reference so an unused-import lint never masks the RED.
const _jsonValueParityRef: JsonValue = null
void _jsonValueParityRef
