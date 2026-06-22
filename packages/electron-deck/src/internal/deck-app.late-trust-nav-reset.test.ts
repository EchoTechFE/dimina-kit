import { describe, expect, it, vi } from 'vitest'
import { DeckChannel } from '../shared/protocol.js'
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

/**
 * Navigation-driven grant revocation on the LATE-TRUST path.
 *
 * A window built via `runtime.windows.create({ autoTrust: false })` and trusted
 * LATER via `runtime.windows.trust(win)` must bind the `did-start-navigation`
 * grant-reset hook — otherwise only auto-trusted windows get it bound in
 * `constructWindow`. So the late-trusted window's control wc could perform a
 * MAIN-FRAME CROSS-DOCUMENT navigation and the navigated-to document would
 * INHERIT the prior page's `layout.*` grants (privilege escalation).
 *
 * `bindNavigationGrantReset(wc)` is bound in the `windows.trust()` tracked
 * branch too (idempotently, guarded by `navHookBound`).
 *
 * CONTRACT pinned here (mirrors the auto-trust contract in
 * deck-app.navigation-grant-reset.test.ts, but exercised through the LATE-TRUST
 * path — `create({autoTrust:false})` + `windows.trust()`):
 *   • main-frame CROSS-DOCUMENT (isMainFrame=true, isInPlace=false) → REVOKE.
 *   • in-place (hash/pushState, isInPlace=true)                     → NO revoke.
 *   • trusting twice (idempotency) → a single nav revokes exactly once,
 *     no double-bind / no throw.
 *
 * The fakes are copied verbatim from deck-app.navigation-grant-reset.test.ts so
 * that every constructed window's control wc is an EventEmitter-ish object that
 * registers + emits 'did-start-navigation' (and thus the CREATED window's wc
 * supports `_emitNav`, not just the main window's).
 */

// ── Fakes (verbatim from deck-app.navigation-grant-reset.test.ts) ─────────────

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

/**
 * Electron `did-start-navigation` listener signature (subset we drive):
 *   (event, url, isInPlace, isMainFrame, frameProcessId, frameRoutingId)
 */
type NavListener = (
	event: { preventDefault(): void },
	url: string,
	isInPlace: boolean,
	isMainFrame: boolean,
	...rest: unknown[]
) => void

/** A webContents fake that is an EventEmitter for navigation events. */
interface NavFakeWebContents extends MinimalWebContentsLike {
	loadURL: ReturnType<typeof vi.fn> & MinimalWebContentsLike['loadURL']
	loadFile: ReturnType<typeof vi.fn> & MinimalWebContentsLike['loadFile']
	send: ReturnType<typeof vi.fn> & MinimalWebContentsLike['send']
	destroyed: boolean
	/** Real Electron webContents is an EventEmitter — the nav hook attaches here. */
	on: ReturnType<typeof vi.fn>
	/** Test-only: registered listeners keyed by event name. */
	_navListeners: Map<string, NavListener[]>
	/** Test-only: fire 'did-start-navigation' with the given (in/cross, frame) shape. */
	_emitNav(opts: { url?: string, isInPlace: boolean, isMainFrame: boolean }): void
}

interface FakeBrowserWindow extends MinimalBrowserWindow {
	readonly webContents: NavFakeWebContents
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
}

interface FakeWebContentsView extends MinimalWebContentsView {
	readonly webContents: NavFakeWebContents
	setBounds: ReturnType<typeof vi.fn> & MinimalWebContentsView['setBounds']
}

interface FakeElectron extends MinimalElectron {
	browserWindows: FakeBrowserWindow[]
	webContentsViews: FakeWebContentsView[]
	browserWindowCtorCalls: MinimalBrowserWindowOptions[]
	webContentsViewCtorCalls: Array<{ webPreferences?: { preload?: string } } | undefined>
}

function createFakeElectron(initialContentBounds: MinimalRect = { x: 0, y: 0, width: 1024, height: 768 }): FakeElectron {
	let wcIdCounter = 100
	let winIdCounter = 1
	const browserWindows: FakeBrowserWindow[] = []
	const webContentsViews: FakeWebContentsView[] = []
	const browserWindowCtorCalls: MinimalBrowserWindowOptions[] = []
	const webContentsViewCtorCalls: Array<{ webPreferences?: { preload?: string } } | undefined> = []

	function makeFakeWebContents(): NavFakeWebContents {
		const id = wcIdCounter++
		const navListeners = new Map<string, NavListener[]>()
		const wc: NavFakeWebContents = {
			id,
			destroyed: false,
			loadURL: vi.fn(async (_u: string) => undefined) as NavFakeWebContents['loadURL'],
			loadFile: vi.fn(async (_p: string) => undefined) as NavFakeWebContents['loadFile'],
			send: vi.fn() as NavFakeWebContents['send'],
			isDestroyed: () => wc.destroyed,
			_navListeners: navListeners,
			on: vi.fn((event: string, listener: NavListener) => {
				let arr = navListeners.get(event)
				if (!arr) {
					arr = []
					navListeners.set(event, arr)
				}
				arr.push(listener)
				return wc
			}),
			_emitNav: ({ url = 'http://localhost/next', isInPlace, isMainFrame }) => {
				const arr = navListeners.get('did-start-navigation')
				if (!arr) return
				const ev = { preventDefault: vi.fn() }
				for (const fn of arr) fn(ev, url, isInPlace, isMainFrame, 1, 1)
			},
		}
		return wc
	}

	class FakeBW implements MinimalBrowserWindow {
		readonly id: number
		readonly webContents: NavFakeWebContents
		readonly contentView: FakeBrowserWindow['contentView']
		destroyed: boolean
		getContentBounds: FakeBrowserWindow['getContentBounds']
		show: FakeBrowserWindow['show']
		destroy: FakeBrowserWindow['destroy']
		on: FakeBrowserWindow['on']
		_listeners: Map<string, Array<(...args: unknown[]) => void>>

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
		readonly webContents: NavFakeWebContents
		setBounds: FakeWebContentsView['setBounds']

		constructor(opts?: { webPreferences?: { preload?: string } }) {
			webContentsViewCtorCalls.push(opts)
			this.webContents = makeFakeWebContents()
			this.setBounds = vi.fn() as FakeWebContentsView['setBounds']
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

// ── Helpers (mirror grants-fork.test.ts / navigation-grant-reset.test.ts) ─────

interface PrivilegedRuntime {
	layout: {
		command(name: string, handler: (...args: JsonValue[]) => JsonValue | Promise<JsonValue>): { dispose(): void }
	}
}

function privileged(runtime: Runtime): PrivilegedRuntime {
	return runtime as unknown as PrivilegedRuntime
}

type InvokeOk = { ok: true, result: JsonValue }
type InvokeFail = { ok: false, error: { code?: string, message?: string, remoteName?: string } }

async function invokeHost(
	ipcMain: FakeIpcMain,
	senderId: number,
	name: string,
	args: JsonValue[] = [],
): Promise<InvokeOk | InvokeFail> {
	const invoke = ipcMain.handlers.get(DeckChannel.Invoke)
	if (!invoke) throw new Error('invoke handler missing')
	return (await invoke(
		{ sender: { id: senderId } },
		{ kind: 'host', name, args },
	)) as InvokeOk | InvokeFail
}

/** Cast the fake wc to the `WebContents` param `grants.issue` expects. */
function controlWc(wc: NavFakeWebContents): Parameters<Runtime['grants']['issue']>[0] {
	return wc as unknown as Parameters<Runtime['grants']['issue']>[0]
}

/**
 * The DeckWindow handle `runtime.windows.create` returns: `.window` is the raw
 * BrowserWindow (what `windows.trust(win)` expects), `.window.webContents` is
 * the new window's CONTROL wc (a NavFakeWebContents that supports `_emitNav`).
 */
interface CreatedDeckWindow {
	window: { webContents: NavFakeWebContents }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('DeckApp — C3 LATE-TRUST: create({autoTrust:false}) + windows.trust() binds the nav grant-reset hook', () => {
	// POSITIVE regression: the bug was that a LATE-trusted window's control wc
	// never got the did-start-navigation hook (only auto-trusted windows did). So
	// issue a grant to the late-trusted window's control wc, confirm the gated
	// layout.* command is ALLOWED, perform a MAIN-FRAME CROSS-DOCUMENT navigation,
	// and assert the SAME command is now FORBIDDEN — the navigated-to document
	// must NOT inherit the prior page's grant.
	it('main-frame cross-document nav on a LATE-trusted window revokes its grant → DECK_FORBIDDEN', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp(
			{ hostServices: { ping: () => 'pong' as JsonValue } },
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()

		const handler = vi.fn(() => 'resized' as JsonValue)
		privileged(app.runtime).layout.command('layout.resize', handler)

		// LATE-TRUST PATH: build untrusted, then trust via windows.trust().
		const deckWin = app.runtime.windows.create({
			source: { url: 'http://localhost:5173/untrusted.html' },
			autoTrust: false,
		}) as unknown as CreatedDeckWindow
		const wc = deckWin.window.webContents

		// Sanity: while untrusted, the nav hook is NOT yet bound (autoTrust:false
		// path skips bindNavigationGrantReset in constructWindow).
		expect(wc.on).not.toHaveBeenCalledWith('did-start-navigation', expect.any(Function))

		// Trust it late — the FIX must bind the nav hook here.
		app.runtime.windows.trust(deckWin.window as unknown as Parameters<Runtime['windows']['trust']>[0])

		// The fix wired the nav hook onto the late-trusted control wc.
		expect(wc.on).toHaveBeenCalledWith('did-start-navigation', expect.any(Function))

		app.runtime.grants.issue(controlWc(wc), { commands: ['layout.resize'] })

		// Sanity: while granted, the gated command passes.
		const granted = await invokeHost(ipcMain, wc.id, 'layout.resize', [{ w: 320 }])
		expect(granted.ok).toBe(true)

		// Cross-document main-frame navigation — the navigated-to document must
		// NOT inherit the prior page's grant.
		wc._emitNav({ url: 'http://localhost/evil', isInPlace: false, isMainFrame: true })
		await new Promise(r => setTimeout(r, 0))

		const afterNav = await invokeHost(ipcMain, wc.id, 'layout.resize', [{ w: 999 }])
		expect(afterNav.ok).toBe(false)
		expect((afterNav as InvokeFail).error.code).toBe('DECK_FORBIDDEN')
		// The post-nav handler must NOT have run (its first call was the granted one).
		expect(handler).toHaveBeenCalledTimes(1)

		await app.shutdown()
	})

	// NEGATIVE: an in-place navigation (hash change / history.pushState) is the
	// SAME document — even on the late-trusted window it must NOT revoke.
	it('in-place navigation on a LATE-trusted window does NOT revoke its grant', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp(
			{ hostServices: { ping: () => 'pong' as JsonValue } },
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()

		privileged(app.runtime).layout.command('layout.resize', vi.fn(() => 'resized' as JsonValue))

		const deckWin = app.runtime.windows.create({
			source: { url: 'http://localhost:5173/untrusted.html' },
			autoTrust: false,
		}) as unknown as CreatedDeckWindow
		const wc = deckWin.window.webContents
		app.runtime.windows.trust(deckWin.window as unknown as Parameters<Runtime['windows']['trust']>[0])

		app.runtime.grants.issue(controlWc(wc), { commands: ['layout.resize'] })
		expect((await invokeHost(ipcMain, wc.id, 'layout.resize', [])).ok).toBe(true)

		// hash/pushState — same document, must NOT revoke.
		wc._emitNav({ url: 'http://localhost/page#section', isInPlace: true, isMainFrame: true })
		await new Promise(r => setTimeout(r, 0))

		const afterInPlace = await invokeHost(ipcMain, wc.id, 'layout.resize', [])
		expect(afterInPlace.ok).toBe(true)

		await app.shutdown()
	})

	// IDEMPOTENCY: if the late-trusted window is trusted TWICE, the nav hook must
	// be bound at most ONCE (navHookBound guard). A single main-frame cross-doc
	// nav must therefore revoke EXACTLY ONCE — no throw, no double-bind, grant gone.
	it('trusting a window twice does not double-bind the nav hook — a single nav revokes exactly once', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp(
			{ hostServices: { ping: () => 'pong' as JsonValue } },
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()

		privileged(app.runtime).layout.command('layout.resize', vi.fn(() => 'resized' as JsonValue))

		const deckWin = app.runtime.windows.create({
			source: { url: 'http://localhost:5173/untrusted.html' },
			autoTrust: false,
		}) as unknown as CreatedDeckWindow
		const wc = deckWin.window.webContents

		// Trust TWICE — the second trust must NOT register a second nav listener.
		const rawWin = deckWin.window as unknown as Parameters<Runtime['windows']['trust']>[0]
		app.runtime.windows.trust(rawWin)
		app.runtime.windows.trust(rawWin)

		// Exactly one 'did-start-navigation' listener bound, despite two trusts.
		const navRegistrations = wc.on.mock.calls.filter(
			(c: unknown[]) => c[0] === 'did-start-navigation',
		)
		expect(navRegistrations).toHaveLength(1)
		expect(wc._navListeners.get('did-start-navigation') ?? []).toHaveLength(1)

		app.runtime.grants.issue(controlWc(wc), { commands: ['layout.resize'] })
		expect((await invokeHost(ipcMain, wc.id, 'layout.resize', [])).ok).toBe(true)

		// A SINGLE main-frame cross-doc nav: must revoke cleanly (no throw / no
		// double-revoke error) and leave the grant gone.
		expect(() => wc._emitNav({ url: 'http://localhost/evil', isInPlace: false, isMainFrame: true })).not.toThrow()
		await new Promise(r => setTimeout(r, 0))

		const afterNav = await invokeHost(ipcMain, wc.id, 'layout.resize', [])
		expect(afterNav.ok).toBe(false)
		expect((afterNav as InvokeFail).error.code).toBe('DECK_FORBIDDEN')

		await app.shutdown()
	})
})
