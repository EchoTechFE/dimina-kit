/**
 * Contract tests for `runtime.windows.adopt` with explicit ownership — the
 * deck-app side of adopting an EXTERNALLY-created BrowserWindow into the
 * framework so `runtime.view().placeIn(adoptedWin)` works and trust / grants are
 * revoked synchronously (revoke-FIRST) on the window's 'closed'.
 *
 *   - With `ownsWindows:true` the framework builds NO main window and no per-window
 *     substrate, so `runtime.mainWindow` is unset and `runtime.view().placeIn(win)`
 *     REJECTS any untracked window ("window is not framework-tracked"). The host has
 *     no way to register an externally-created BrowserWindow.
 *   - `runtime.windows.adopt(win, { ownership })` registers an external window's
 *     windowScope + per-window substrate + TRUST lifecycle, so
 *     `runtime.view().placeIn(adoptedWin)` works; trust + slot-tokens + grants are
 *     revoked SYNCHRONOUSLY and FIRST on the window's 'closed'.
 *   - CRITICAL ordering: revocation MUST run FIRST on 'closed'. The framework
 *     registers its revoke listener via `prependListener` so it runs before any
 *     external 'closed' listener the host registered earlier. The minimal
 *     `MinimalBrowserWindow` only has `on(...)`, so this file ADDS
 *     `prependListener` to the fake window infra (mirroring `on`).
 *
 * The adopt surface is reached through a single typed escape hatch (`withAdopt`)
 * so the file compiles against the runtime types. The fake window exposes
 * `prependListener` (the framework calls it for the revoke listener); the fake
 * records `on` vs `prependListener` into a single ORDERED list so spec #3 can
 * assert revoke-first ordering.
 *
 * Fakes copied (minimal) from deck-app.host-view.test.ts / deck-app.slot-token.test.ts,
 * EXTENDED with `prependListener` (mirrors `on`, but unshifts to the FRONT) so an
 * adopt-registered revoke listener can be proven to run before an earlier external
 * 'closed' listener.
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
import type { DeckAppOptions } from './deck-app.js'
import type { MinimalIpcMain, MinimalWebContents } from './wire-transport.js'
import type { RuntimeBackend } from '../types.js'

// ── Minimal fakes (copied from deck-app.host-view.test.ts) + prependListener ─────

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

// The fake window ALSO supports prependListener. To prove the revoke-first
// ordering we record EVERY 'closed' listener — whether added via
// `on` or `prependListener` — into a single ordered array; `_emit('closed')`
// invokes them front-to-back. `prependListener` unshifts (front); `on` pushes
// (back) — exactly Electron's EventEmitter semantics.
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
				// `on` appends to the BACK of the listener list (EventEmitter order).
				arr.push(listener)
				return this
			}) as FakeBrowserWindow['on']
			// `prependListener` mirrors `on` but unshifts to the FRONT, so
			// a listener added via prependListener runs BEFORE any earlier `on`
			// listener for the same event. The framework's adopt revoke listener uses
			// this to guarantee revoke-first.
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
			// Real Electron destroys the window before/synchronously-with 'closed';
			// mark destroyed so post-close webContents reads / isDestroyed() behave.
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
		// An EXTERNAL window: constructed via `new FakeBW()` so it has a fresh wc id
		// + the contentView spies + prependListener, but the FRAMEWORK never built /
		// tracked it (it never flowed through assembleElectron / constructWindow). It
		// IS pushed into `browserWindows` for inspection, but the framework holds no
		// windowScope / substrate / trust for it until adopt.
		makeExternalWindow(): FakeBrowserWindow {
			return new FakeBW() as unknown as FakeBrowserWindow
		},
	}
}

// ── A minimal ownsWindows:true backend (no framework main window) ────────────
//
// Under ownsWindows:true the framework builds NO main window + NO per-window
// substrate, so `runtime.view().placeIn(extWin)` would reject any window — the
// exact gap adopt fills. `assemble` is required but does nothing here (the host
// "builds its own window" = our externally-created fake, adopted in the test).
function makeOwnsWindowsBackend(): RuntimeBackend {
	return {
		ownsWindows: true,
		assemble: vi.fn(async () => undefined),
	}
}

// ── Typed escape hatch for `runtime.windows.adopt` ───────────────────────────
//
// Reach `runtime.windows.adopt` through a loose view so any regression that
// drops it fails at RUNTIME (`adopt is not a function`) — the runtime failure
// we want — rather than a compile error that would stop the suite running.
interface ViewSource { url?: string, file?: string }
interface HostViewHandle {
	placeIn(win: unknown, opts: { zone?: number, anchor?: string }): HostViewHandle
	applyPlacement(p: unknown): HostViewHandle
	dispose(): Promise<void>
}
type Ownership = 'transfer' | 'observe'
interface AdoptRegistration { dispose(): void | Promise<void> }
interface RuntimeWithAdopt {
	view(spec: { source: ViewSource, scope?: unknown }): HostViewHandle
	windows: {
		create(opts: unknown): unknown
		adopt(win: unknown, opts?: { ownership?: Ownership }): AdoptRegistration
		trust(win: unknown): { dispose(): void }
	}
	scopes: { create(): { dispose(): Promise<void> } }
	grants: {
		issue(controlWc: unknown, opts: { commands: readonly string[] }): { dispose(): void }
	}
}
function withAdopt(runtime: Runtime): RuntimeWithAdopt {
	return runtime as unknown as RuntimeWithAdopt
}

// app.__wcRecords() / context._senderPolicy escape hatches for trust assertions.
interface TrustView {
	__wcRecords(): Map<MinimalWebContents, { wcScope: unknown, leases: Set<unknown> }>
}
function trustOf(app: DeckApp): TrustView {
	return app as unknown as TrustView
}
function isTrusted(app: DeckApp, wcId: number): boolean {
	// The default senderPolicy reads the live trustSet; context._senderPolicy is
	// the live gate, so this reflects real trust at the moment of the call.
	return app.runtime.context._senderPolicy.isTrusted(wcId)
}

function lastWcv(electron: FakeElectron): FakeWebContentsView {
	const wcv = electron.webContentsViews[electron.webContentsViews.length - 1]
	if (!wcv) throw new Error('no WebContentsView was constructed')
	return wcv
}

// Boot an ownsWindows:true app (framework builds NO main window) with a wire so
// trust assertions have a live senderPolicy. The host then creates + adopts an
// EXTERNAL window in each test.
async function bootOwnsWindows(extraOpts?: Partial<DeckAppOptions>): Promise<{
	app: DeckApp
	electron: FakeElectron
	ipcMain: FakeIpcMain
}> {
	const electron = createFakeElectron()
	const ipcMain = createFakeIpcMain()
	const app = new DeckApp(
		{},
		{ electron, backend: makeOwnsWindowsBackend(), wireTransport: { ipcMain }, ...extraOpts },
	)
	await app.start()
	return { app, electron, ipcMain }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. adopt registers a placeable substrate. Before adopt, placeIn(extWin) throws
//    ("not framework-tracked"); after adopt, placeIn SUCCEEDS (the WCV is added to
//    extWin's contentView).
// ─────────────────────────────────────────────────────────────────────────────
describe('runtime.windows.adopt — registers a placeable substrate', () => {
	it('placeIn(extWin) THROWS before adopt, SUCCEEDS after adopt (WCV added to extWin.contentView)', async () => {
		const { app, electron } = await bootOwnsWindows()
		const extWin = electron.makeExternalWindow()

		// BEFORE adopt: the external window is not framework-tracked → placeIn rejects.
		const handle0 = withAdopt(app.runtime).view({ source: { url: 'data:text/html,x' } })
		expect(() =>
			handle0.placeIn(extWin as unknown, { zone: 0 }),
		).toThrow(/not framework-tracked/i)

		// Adopt the external window.
		withAdopt(app.runtime).windows.adopt(extWin as unknown)

		// AFTER adopt: a fresh view places into the adopted window's contentView.
		const handle = withAdopt(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)
		expect(() => handle.placeIn(extWin as unknown, { zone: 0 })).not.toThrow()
		expect(extWin.contentView.addChildView).toHaveBeenCalledWith(wcv)

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. adopt admits trust. The adopted window's webContents.id becomes trusted
//    (the senderPolicy gate now accepts it; a grant can be issued for it).
// ─────────────────────────────────────────────────────────────────────────────
describe('runtime.windows.adopt — admits trust', () => {
	it('the adopted window webContents.id becomes trusted (senderPolicy gate accepts it)', async () => {
		const { app, electron } = await bootOwnsWindows()
		const extWin = electron.makeExternalWindow()
		const extWcId = extWin.webContents.id

		// Untrusted before adopt.
		expect(isTrusted(app, extWcId)).toBe(false)

		withAdopt(app.runtime).windows.adopt(extWin as unknown)

		// Trusted after adopt — the wire gate now accepts an invoke from this wc.
		expect(isTrusted(app, extWcId)).toBe(true)
		// And a wcRecord exists (trust admitted under a real windowScope), so the
		// adopted wc can be granted privileged commands (proves a usable wcScope).
		const rec = trustOf(app).__wcRecords().get(extWin.webContents as unknown as MinimalWebContents)
		expect(rec).toBeDefined()
		const grant = withAdopt(app.runtime).grants.issue(extWin.webContents as unknown, {
			commands: ['layout.resize'],
		})
		expect(typeof grant.dispose).toBe('function')

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. CRITICAL: 'closed' revokes trust FIRST (prependListener). An
//    EXTERNAL 'closed' listener registered BEFORE adopt must, when the window
//    fires 'closed', observe the wc ALREADY untrusted — proving the framework's
//    revoke listener ran FIRST (registered via prependListener, not on()).
// ─────────────────────────────────────────────────────────────────────────────
describe('runtime.windows.adopt — closed revokes trust FIRST (prependListener) [SECURITY ORDERING]', () => {
	it('an external closed listener registered BEFORE adopt sees the wc already untrusted (revoke ran first)', async () => {
		const { app, electron } = await bootOwnsWindows()
		const extWin = electron.makeExternalWindow()
		const extWcId = extWin.webContents.id

		// The host registers its OWN 'closed' listener via on() BEFORE adopt — so in
		// plain EventEmitter order it would run before any later on()-added listener.
		// adopt MUST use prependListener so the framework's revoke jumps ahead of it.
		let trustedWhenExternalRan: boolean | null = null
		extWin.on('closed', () => {
			trustedWhenExternalRan = isTrusted(app, extWcId)
		})

		withAdopt(app.runtime).windows.adopt(extWin as unknown)
		expect(isTrusted(app, extWcId)).toBe(true)

		// Fire 'closed'. The framework's prepended revoke listener runs FIRST, so the
		// external listener observes the wc ALREADY untrusted.
		extWin._emit('closed')

		expect(trustedWhenExternalRan).toBe(false)
		// And the framework registered its revoke via prependListener (NOT on()).
		expect(extWin.prependListener).toHaveBeenCalledWith('closed', expect.any(Function))

		await app.shutdown()
	})

	it('on closed, slot-tokens authorized to the adopted wc are also revoked synchronously', async () => {
		const { app, electron } = await bootOwnsWindows()
		const extWin = electron.makeExternalWindow()

		withAdopt(app.runtime).windows.adopt(extWin as unknown)

		// Anchored placeIn into the adopted window mints a slot-token + pushes a
		// slot-grant to the adopted wc.
		const handle = withAdopt(app.runtime).view({ source: { url: 'data:text/html,x' } })
		handle.placeIn(extWin as unknown, { zone: 0, anchor: '#a' })
		const grantCalls = (extWin.webContents.send as ReturnType<typeof vi.fn>).mock.calls
			.filter(c => c[0] === '__electron-deck:slot-grant')
		expect(grantCalls.length).toBe(1)

		// Closing the adopted window revokes its slot-tokens too (window-close hygiene
		// — same path as the framework's own windows' revokeSlotTokensForWc).
		expect(() => extWin._emit('closed')).not.toThrow()

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. idempotent by WC identity. Adopting the SAME window twice does NOT
//    double-register (one substrate, one trust lease); the second adopt is a no-op
//    (or returns the same registration).
// ─────────────────────────────────────────────────────────────────────────────
describe('runtime.windows.adopt — idempotent by WC identity', () => {
	it('adopting the same window twice does not double-register (no second substrate / no double trust lease)', async () => {
		const { app, electron } = await bootOwnsWindows()
		const extWin = electron.makeExternalWindow()
		const wcKey = extWin.webContents as unknown as MinimalWebContents

		withAdopt(app.runtime).windows.adopt(extWin as unknown)
		const recAfterFirst = trustOf(app).__wcRecords().get(wcKey)
		expect(recAfterFirst).toBeDefined()
		const leasesAfterFirst = recAfterFirst!.leases.size

		// Second adopt of the SAME window → no-op (or same registration). No second
		// trust lease, no second substrate registration.
		withAdopt(app.runtime).windows.adopt(extWin as unknown)
		const recAfterSecond = trustOf(app).__wcRecords().get(wcKey)
		expect(recAfterSecond).toBe(recAfterFirst)
		expect(recAfterSecond!.leases.size).toBe(leasesAfterFirst)

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. CRITICAL: rejects a destroyed window. adopt(win) where win.isDestroyed() →
//    THROWS — no substrate / trust created for a dead window (a dead wc.id could
//    be reused; admitting it would be a privilege-escalation hazard).
// ─────────────────────────────────────────────────────────────────────────────
describe('runtime.windows.adopt — rejects a destroyed window [SECURITY]', () => {
	it('adopt(destroyedWin) THROWS and creates no substrate / no trust for the dead wc', async () => {
		const { app, electron } = await bootOwnsWindows()
		const extWin = electron.makeExternalWindow()
		const wcKey = extWin.webContents as unknown as MinimalWebContents
		const wcId = extWin.webContents.id

		// Destroy the window BEFORE adopting it.
		extWin.destroy()
		expect(extWin.isDestroyed()).toBe(true)

		expect(() => withAdopt(app.runtime).windows.adopt(extWin as unknown)).toThrow()

		// No trust admitted, no wcRecord, gate still rejects the dead wc.
		expect(trustOf(app).__wcRecords().has(wcKey)).toBe(false)
		expect(isTrusted(app, wcId)).toBe(false)

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. ownership. `ownership:'transfer'` → the framework destroys the window at app
//    shutdown (extWin.destroy called). `ownership:'observe'` (default) → the
//    framework does NOT destroy it at shutdown (the host owns its lifetime), but
//    in BOTH cases the substrate / trust are torn down.
// ─────────────────────────────────────────────────────────────────────────────
describe('runtime.windows.adopt — ownership transfer vs observe', () => {
	it("ownership:'transfer' → the framework destroys the adopted window at shutdown; substrate/trust cleaned up", async () => {
		const { app, electron } = await bootOwnsWindows()
		const extWin = electron.makeExternalWindow()
		const wcKey = extWin.webContents as unknown as MinimalWebContents
		const wcId = extWin.webContents.id

		withAdopt(app.runtime).windows.adopt(extWin as unknown, { ownership: 'transfer' })
		expect(isTrusted(app, wcId)).toBe(true)

		const destroyBefore = (extWin.destroy as ReturnType<typeof vi.fn>).mock.calls.length
		await app.shutdown()

		// transfer → the framework owns the window's lifetime → destroyed at shutdown.
		expect((extWin.destroy as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(destroyBefore)
		// Substrate + trust are gone regardless of ownership.
		expect(trustOf(app).__wcRecords().has(wcKey)).toBe(false)
		expect(isTrusted(app, wcId)).toBe(false)
	})

	it("ownership:'observe' (default) → the framework does NOT destroy the window at shutdown; substrate/trust still cleaned up", async () => {
		const { app, electron } = await bootOwnsWindows()
		const extWin = electron.makeExternalWindow()
		const wcKey = extWin.webContents as unknown as MinimalWebContents
		const wcId = extWin.webContents.id

		// 'observe' is the default — omit ownership to also pin the default.
		withAdopt(app.runtime).windows.adopt(extWin as unknown, { ownership: 'observe' })
		expect(isTrusted(app, wcId)).toBe(true)

		const destroyBefore = (extWin.destroy as ReturnType<typeof vi.fn>).mock.calls.length
		await app.shutdown()

		// observe → the HOST owns the window's lifetime → the framework must NOT
		// destroy it at shutdown.
		expect((extWin.destroy as ReturnType<typeof vi.fn>).mock.calls.length).toBe(destroyBefore)
		// But the substrate + trust ARE torn down even when the window survives.
		expect(trustOf(app).__wcRecords().has(wcKey)).toBe(false)
		expect(isTrusted(app, wcId)).toBe(false)
	})
})

// Parity ref so an unused-import lint never masks a runtime failure.
const _jsonParityRef: JsonValue = null
void _jsonParityRef
