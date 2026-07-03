/**
 * Contract: an adopted window's EXPLICIT `runtime.windows.trust(win)` lease is
 * owned by that window's windowScope, so it is revoked when the window closes —
 * not left on the app-level rootScope until shutdown (where a reused wc.id could
 * inherit stale trust).
 *
 * `adopt(win)` already admits trust under the window's windowScope and revokes it
 * on 'closed'. But a host that additionally calls `runtime.windows.trust(win)` on
 * an ALREADY-ADOPTED window must get a windowScope-owned lease too: the framework
 * tracks a windowScope for adopted windows, so trust() must route through it
 * rather than the rootScope fallback that only exists for backend-owned windows
 * with no framework windowScope.
 *
 * Fakes copied (minimal) from deck-app.adopt.test.ts — the fake window exposes
 * `prependListener` (adopt's revoke-first listener) and `makeExternalWindow()`.
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
import type { MinimalIpcMain } from './wire-transport.js'
import type { RuntimeBackend } from '../types.js'

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

function makeOwnsWindowsBackend(): RuntimeBackend {
	return {
		ownsWindows: true,
		assemble: vi.fn(async () => undefined),
	}
}

// ── Typed escape hatch for windows.adopt / windows.trust ─────────────────────
interface ViewSource { url?: string, file?: string }
type Ownership = 'transfer' | 'observe'
interface AdoptRegistration { dispose(): void | Promise<void> }
interface RuntimeWithAdopt {
	view(spec: { source: ViewSource, scope?: unknown }): unknown
	windows: {
		adopt(win: unknown, opts?: { ownership?: Ownership }): AdoptRegistration
		trust(win: unknown): { dispose(): void }
	}
}
function withApi(runtime: Runtime): RuntimeWithAdopt {
	return runtime as unknown as RuntimeWithAdopt
}

function isTrusted(app: DeckApp, wcId: number): boolean {
	return app.runtime.context._senderPolicy.isTrusted(wcId)
}

// Boot an ownsWindows:true app (framework builds NO main window) so the host
// can adopt an external window; a wire keeps the senderPolicy trust-driven.
async function bootOwnsWindows(): Promise<{ app: DeckApp, electron: FakeElectron }> {
	const electron = createFakeElectron()
	const app = new DeckApp(
		{},
		{ electron, backend: makeOwnsWindowsBackend(), wireTransport: { ipcMain: createFakeIpcMain() } },
	)
	await app.start()
	return { app, electron }
}

// Normal boot: the framework builds its OWN main window (browserWindows[0]) with
// a real windowScope — the constructWindow trust path.
async function bootFramework(extraOpts?: Partial<DeckAppOptions>): Promise<{
	app: DeckApp
	electron: FakeElectron
}> {
	const electron = createFakeElectron()
	const app = new DeckApp(
		{},
		{ electron, wireTransport: { ipcMain: createFakeIpcMain() }, ...extraOpts },
	)
	await app.start()
	return { app, electron }
}

// ─────────────────────────────────────────────────────────────────────────────
// An adopted window's explicit trust() lease is windowScope-owned → revoked on
// close, not left on rootScope until shutdown.
// ─────────────────────────────────────────────────────────────────────────────
describe('runtime.windows.trust on an adopted window — the lease is revoked when the window closes', () => {
	it('after adopt(win) then trust(win), the wc is NOT trusted once the window fires closed', async () => {
		const { app, electron } = await bootOwnsWindows()
		const extWin = electron.makeExternalWindow()
		const extWcId = extWin.webContents.id

		withApi(app.runtime).windows.adopt(extWin as unknown)
		// A host that additionally trusts the adopted window (e.g. re-affirming
		// trust) must get a windowScope-owned lease, revoked on window close.
		withApi(app.runtime).windows.trust(extWin as unknown)
		expect(isTrusted(app, extWcId)).toBe(true)

		extWin._emit('closed')

		// The window is gone → the wc must carry NO residual trust.
		expect(isTrusted(app, extWcId)).toBe(false)

		await app.shutdown()
	})

	it('a new wc reusing the closed adopted window\'s id is not trusted (no inherited trust)', async () => {
		const { app, electron } = await bootOwnsWindows()
		const extWin = electron.makeExternalWindow()
		const extWcId = extWin.webContents.id

		withApi(app.runtime).windows.adopt(extWin as unknown)
		withApi(app.runtime).windows.trust(extWin as unknown)
		extWin._emit('closed')

		// Electron REUSES webContents ids. A brand-new window that reuses the closed
		// window's id must present to the wire gate as UNtrusted — the id-reuse
		// privilege-escalation hazard the windowScope-owned lease closes.
		const reusedWc = { id: extWcId, isDestroyed: () => false }
		expect(isTrusted(app, reusedWc.id)).toBe(false)

		await app.shutdown()
	})

	// ── Regression guards (green under current behavior — they prevent the fix
	//    from over-reaching or breaking the idempotent Disposable). ────────────

	it('[regression] a framework-built window\'s explicit trust() lease is revoked on that window\'s close', async () => {
		const { app, electron } = await bootFramework()
		const mainWin = electron.browserWindows[0]!
		const mainWcId = mainWin.webContents.id
		expect(isTrusted(app, mainWcId)).toBe(true)

		// A framework-tracked window is in lifetimeShadow → trust() already routes to
		// its windowScope. Closing the window must revoke it (guards against the fix
		// regressing the constructWindow path).
		withApi(app.runtime).windows.trust(mainWin as unknown)
		mainWin._emit('closed')

		expect(isTrusted(app, mainWcId)).toBe(false)

		await app.shutdown()
	})

	it('[regression] the Disposable returned by trust() is idempotent under early double-dispose', async () => {
		const { app, electron } = await bootOwnsWindows()
		const extWin = electron.makeExternalWindow()

		withApi(app.runtime).windows.adopt(extWin as unknown)
		const lease = withApi(app.runtime).windows.trust(extWin as unknown)
		lease.dispose()
		expect(() => lease.dispose()).not.toThrow()

		await app.shutdown()
	})
})

// Parity ref so an unused-import lint never masks a runtime failure.
const _jsonParityRef: JsonValue = null
void _jsonParityRef
