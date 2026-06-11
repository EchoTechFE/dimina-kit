/**
 * TDD failing-first contract tests for "P2: sealed DeckSession +
 * runtime.scopes.create" (codex-confirmed #7).
 *
 * THE PROBLEM: `runtime.view({scope})` and `runtime.grants.issue({targetScope})`
 * both demand a `Scope`, but `Runtime` exposes NO scope factory — a host has
 * nowhere to legitimately GET one. The only public scope source is the exported
 * `createScope()`, which mints a ROOTLESS scope (not a child of the app root), and
 * `Scope.adopt()` can re-parent across roots. Letting `runtime.view` accept a raw
 * `Scope` therefore lets a host smuggle in a rootless / adopted scope and break
 * the unified-lifetime invariants (app shutdown would not cascade into it).
 *
 * THE FIX (pinned here):
 *   - `runtime.scopes.create()` mints an OPAQUE `DeckSession` (internally a
 *     `rootScope.child()`), tracked in a private WeakSet. It exposes ONLY
 *     `dispose(): Promise<void>` — NOT the raw Scope surface (`child`/`adopt`/
 *     `reset`).
 *   - `runtime.view({scope: session})` accepts a DeckSession and binds the view
 *     to the session's lifetime; `session.dispose()` tears the view down (native
 *     WebContents closed + unregistered), and because the session is a child of
 *     the app root, app shutdown also cascades into it.
 *   - `runtime.view({scope: <raw createScope()>})` is REJECTED (provenance check)
 *     — a host can't pass a scope the framework didn't mint. [SECURITY PIN]
 *   - `runtime.view({source})` with NO scope still works (bound to the app root,
 *     disposed at shutdown) — unchanged default.
 *   - `runtime.grants.issue(controlWc, { commands })` no longer REQUIRES
 *     `targetScope` (it's optional / reserved-not-consulted).
 *
 * None of `runtime.scopes`, the DeckSession type, or the DeckSession-accepting
 * `view({scope})` exists yet, so every spec is RED — reached through a single
 * typed escape hatch so the file still compiles (the failure is a runtime
 * TypeError "runtime.scopes is undefined", not a compile error).
 *
 * Fakes mirror deck-app.host-view.test.ts / deck-app.grants-fork.test.ts. The
 * FakeWebContentsView gains a `close` spy + `destroyed` flag so the native-WC
 * teardown (view's wc.close()) is observable.
 */
import { describe, expect, it, vi } from 'vitest'
import { DeckChannel } from '../shared/protocol.js'
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

// ── Minimal fakes (mirrors deck-app.host-view.test.ts) ───────────────────────

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
}

interface FakeWebContentsView extends MinimalWebContentsView {
	readonly webContents: FakeWebContentsLike
	setBounds: ReturnType<typeof vi.fn> & MinimalWebContentsView['setBounds']
	/** Test-only: mirrors a destroyed/closed WCV native WebContents. */
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
			// The view's native-WC teardown calls `wc.close()` (B3.1). Mark destroyed
			// so the session-dispose teardown is observable.
			close: vi.fn(function (this: FakeWebContentsLike) {
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

// ── Typed escape hatch for the not-yet-typed sealed-session surface ──────────
//
// `runtime.scopes`, the `DeckSession` type, and the DeckSession-accepting
// `view({scope})` / targetScope-optional `grants.issue` are not on the public
// `Runtime` type yet, so we reach them through a loose view. Absence then fails
// at RUNTIME (`runtime.scopes is undefined`) — the RED we want — rather than a
// compile error that would stop the suite running.

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
/** The opaque session handle minted by `runtime.scopes.create()`. */
interface DeckSession {
	dispose(): Promise<void>
}
interface SealedRuntime {
	scopes: { create(): DeckSession }
	view(spec: { source: ViewSource, scope?: unknown }): HostViewHandle
	grants: {
		issue(controlWc: unknown, opts: { commands: readonly string[], targetScope?: unknown }): { dispose(): void }
	}
}
function sealed(runtime: Runtime): SealedRuntime {
	return runtime as unknown as SealedRuntime
}

// The WCV the handle owns is the LAST WebContentsView the fake electron
// constructed during the `runtime.view(...)` call (no toolbar in these tests).
function lastWcv(electron: FakeElectron): FakeWebContentsView {
	const wcv = electron.webContentsViews[electron.webContentsViews.length - 1]
	if (!wcv) throw new Error('no WebContentsView was constructed')
	return wcv
}

/** The auto-trusted main window's webContents — the trusted control wc. */
function mainWc(electron: FakeElectron): FakeWebContentsLike {
	return (electron.browserWindows[0] as unknown as FakeBrowserWindow).webContents
}

type InvokeOk = { ok: true, result: JsonValue }
type InvokeFail = { ok: false, error: { code?: string, message?: string } }

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

// ─────────────────────────────────────────────────────────────────────────────
// 1. runtime.scopes.create() returns an OPAQUE DeckSession — has dispose(), does
//    NOT expose the raw Scope surface (adopt/child/reset).
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp P2 — runtime.scopes.create() mints an opaque DeckSession', () => {
	it('returns a handle with dispose() and NO raw Scope surface (no adopt/child/reset)', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain: createFakeIpcMain() } })
		await app.start()

		const session = sealed(app.runtime).scopes.create()
		expect(typeof session.dispose).toBe('function')

		// Opacity: the session must NOT leak the rootless-escape primitives that a
		// raw Scope exposes. `adopt` re-parents across roots; `child` would let a
		// host fork a sub-lifetime the framework can't track. Neither may exist.
		const s = session as unknown as Record<string, unknown>
		expect(s.adopt).toBeUndefined()
		expect(s.child).toBeUndefined()
		// C2 contract: `reset()` is now a first-class DeckSession method (per-session
		// segment reset that keeps the session + window alive) — it MUST be present.
		expect(typeof s.reset).toBe('function')

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. runtime.view({scope: session}) binds the view to the session's lifetime:
//    session.dispose() tears the view down (native WC closed + unregistered).
//    The session is a child of the app root, so app shutdown ALSO cascades.
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp P2 — view({scope: session}) is bound to the session lifetime', () => {
	it('session.dispose() detaches + closes the session-bound view native WebContents', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain: createFakeIpcMain() } })
		await app.start()

		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow
		const session = sealed(app.runtime).scopes.create()
		const handle = sealed(app.runtime).view({
			source: { url: 'data:text/html,x' },
			scope: session,
		})
		const wcv = lastWcv(electron)
		handle.placeIn(app.runtime.mainWindow, { zone: 0 })
		expect(mainWin.contentView.addChildView).toHaveBeenCalledWith(wcv)

		const removesBefore = mainWin.contentView.removeChildView.mock.calls.length
		// Disposing the SESSION must tear the view down with no explicit handle
		// dispose: detach (removeChildView) + destroy the native WebContents.
		await session.dispose()
		await new Promise(r => setTimeout(r, 0))

		expect(mainWin.contentView.removeChildView.mock.calls.length).toBeGreaterThan(removesBefore)
		expect(mainWin.contentView.removeChildView).toHaveBeenCalledWith(wcv)
		// view-handle B3.1: the view's native WebContents is closed on teardown.
		expect(wcv.webContents.close).toHaveBeenCalled()

		await app.shutdown()
	})

	it('app shutdown cascades into a session-bound view (session is a child of the app root)', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain: createFakeIpcMain() } })
		await app.start()

		const session = sealed(app.runtime).scopes.create()
		const handle = sealed(app.runtime).view({
			source: { url: 'data:text/html,x' },
			scope: session,
		})
		const wcv = lastWcv(electron)
		handle.placeIn(app.runtime.mainWindow, { zone: 0 })

		// Never dispose the session explicitly — app shutdown must cascade through
		// rootScope → the session child → the view, closing its native WebContents.
		await app.shutdown()
		await new Promise(r => setTimeout(r, 0))

		expect(wcv.webContents.close).toHaveBeenCalled()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. [SECURITY PIN] a FOREIGN / RAW Scope is REJECTED. A rootless `createScope()`
//    (not minted by runtime.scopes.create()) passed as `view({scope})` THROWS the
//    provenance check — a host can't smuggle a rootless / adopted scope in.
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp P2 — view rejects a foreign/raw Scope (provenance, SECURITY)', () => {
	it('view({scope: createScope()}) (a raw rootless Scope) THROWS — not minted by runtime.scopes.create()', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain: createFakeIpcMain() } })
		await app.start()

		const rawScope = createScope() // rootless escape — NOT from runtime.scopes.create()
		expect(() =>
			sealed(app.runtime).view({ source: { url: 'data:text/html,x' }, scope: rawScope }),
		).toThrow(/scope.*runtime\.scopes\.create|foreign|not a DeckSession/i)

		await rawScope.close()
		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. default (no scope) still works — view({source}) with NO scope binds to the
//    app root and is disposed at app shutdown. Unchanged default.
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp P2 — view with NO scope still binds to the app root', () => {
	it('view({source}) without a scope is created + placed, and shutdown closes it', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain: createFakeIpcMain() } })
		await app.start()

		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow
		const handle = sealed(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)
		handle.placeIn(app.runtime.mainWindow, { zone: 0 })
		expect(mainWin.contentView.addChildView).toHaveBeenCalledWith(wcv)

		// Default (root-bound) view: app shutdown tears it down (the window's
		// contentView is detached via the windowScope cascade), no throw.
		await expect(app.shutdown()).resolves.toBeUndefined()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. grants.issue no longer REQUIRES targetScope: issue(controlWc, { commands })
//    works WITHOUT a targetScope, returns a Disposable, and the grant gates the
//    command (granted sender passes, ungranted → FORBIDDEN). targetScope, if
//    accepted at all, is optional (omitting it does NOT throw).
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp P2 — grants.issue drops the mandatory targetScope', () => {
	it('issue(controlWc, { commands }) WITHOUT targetScope succeeds and gates the command', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp(
			{ hostServices: { ping: () => 'pong' as JsonValue } },
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()

		const handler = vi.fn((arg: JsonValue) => ({ ok: true, echo: arg }) as JsonValue)
		// runtime.layout.command exists today; register a privileged command to gate.
		;(app.runtime as unknown as {
			layout: { command(name: string, h: (...a: JsonValue[]) => JsonValue): { dispose(): void } }
		}).layout.command('layout.resize', handler)

		const wc = mainWc(electron)

		// Ungranted → FORBIDDEN (gate default-denies).
		const denied = await invokeHost(ipcMain, wc.id, 'layout.resize', [{ w: 1 }])
		expect(denied.ok).toBe(false)
		expect((denied as InvokeFail).error.code).toBe('DECK_FORBIDDEN')

		// Issue WITHOUT a targetScope — must not throw, must return a Disposable.
		const grant = sealed(app.runtime).grants.issue(
			wc as unknown as Parameters<Runtime['grants']['issue']>[0],
			{ commands: ['layout.resize'] },
		)
		expect(typeof grant.dispose).toBe('function')

		// Granted → the command passes (gate now authorizes this sender/command).
		const granted = await invokeHost(ipcMain, wc.id, 'layout.resize', [{ w: 320 }])
		expect(granted.ok).toBe(true)
		expect((granted as InvokeOk).result).toEqual({ ok: true, echo: { w: 320 } })
		expect(handler).toHaveBeenCalledWith({ w: 320 })

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. session.dispose is idempotent + closing the session disposes ALL views
//    created in it (create 2 views in a session → session.dispose closes both).
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckApp P2 — session.dispose is idempotent + disposes all its views', () => {
	it('two views created in one session are BOTH torn down by a single session.dispose; dispose is idempotent', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain: createFakeIpcMain() } })
		await app.start()

		const session = sealed(app.runtime).scopes.create()

		const handleA = sealed(app.runtime).view({ source: { url: 'data:text/html,a' }, scope: session })
		const wcvA = lastWcv(electron)
		handleA.placeIn(app.runtime.mainWindow, { zone: 0 })

		const handleB = sealed(app.runtime).view({ source: { url: 'data:text/html,b' }, scope: session })
		const wcvB = lastWcv(electron)
		handleB.placeIn(app.runtime.mainWindow, { zone: 1 })

		expect(wcvA).not.toBe(wcvB)

		// One session.dispose tears down BOTH views' native WebContents.
		await session.dispose()
		await new Promise(r => setTimeout(r, 0))
		expect(wcvA.webContents.close).toHaveBeenCalled()
		expect(wcvB.webContents.close).toHaveBeenCalled()

		// Idempotent: a second dispose resolves without throwing.
		await expect(session.dispose()).resolves.toBeUndefined()

		await app.shutdown()
	})
})
