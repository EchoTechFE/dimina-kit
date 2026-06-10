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
 * C3 (P0 security) — navigation-driven grant revocation.
 *
 * CONTRACT (deck-window-facade-LOCKED.md §C3): a trusted control wc that has
 * been issued capability grants MUST lose those grants when it performs a
 * MAIN-FRAME CROSS-DOCUMENT navigation — so the navigated-to document cannot
 * inherit the prior page's `layout.*` privileges (privilege-inheritance hole).
 *
 * Mechanism the framework must wire:
 *   wc.on('did-start-navigation', (e, url, isInPlace, isMainFrame) => {
 *     if (isMainFrame && !isInPlace) wcScope.reset()
 *   })
 * `wcScope.reset()` synchronously revokes the grants bound to that sender
 * (capability registry already binds `senderScope.on('reset')`).
 *
 *   • main-frame CROSS-DOCUMENT (isMainFrame=true, isInPlace=false) → REVOKE.
 *   • in-place (hash/pushState, isInPlace=true)                     → NO revoke.
 *   • sub-frame (isMainFrame=false)                                 → NO revoke.
 *
 * FAILING-FIRST: at authoring time deck-app.ts wires NO `did-start-navigation`
 * hook on the control wc (grep confirms only `closed`/`close`/`resize`/
 * `did-...`-free `.on(...)` registrations). So firing a main-frame cross-doc
 * navigation does NOT reset the wcScope → the grant survives → the gated
 * `layout.*` command is STILL allowed where the contract demands DECK_FORBIDDEN.
 * That positive test is RED until the hook lands. The negative tests
 * (in-place / sub-frame don't revoke) already pass (nothing revokes today).
 *
 * Fakes mirror deck-app.test.ts / grants-fork.test.ts, EXTENDED so the control
 * wc is an EventEmitter-ish object that can register + emit
 * 'did-start-navigation' listeners (the real Electron `webContents` is an
 * EventEmitter; the Minimal fake had no `.on`).
 */

// ── Fakes ────────────────────────────────────────────────────────────────────

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

// ── Helpers (mirror grants-fork.test.ts) ─────────────────────────────────────

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

/** The auto-trusted main window's webContents — the trusted CONTROL wc. */
function mainWc(electron: FakeElectron): NavFakeWebContents {
	return (electron.browserWindows[0] as unknown as FakeBrowserWindow).webContents
}

/** Cast the fake wc to the `WebContents` param `grants.issue` expects. */
function controlWc(wc: NavFakeWebContents): Parameters<Runtime['grants']['issue']>[0] {
	return wc as unknown as Parameters<Runtime['grants']['issue']>[0]
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('DeckApp — C3: main-frame cross-document navigation revokes the control wc grants', () => {
	// POSITIVE (RED until the did-start-navigation hook lands): issue a grant,
	// confirm the gated layout.* command is ALLOWED, then perform a MAIN-FRAME
	// CROSS-DOCUMENT navigation on the control wc; the SAME command must now be
	// FORBIDDEN — the grant was revoked (the navigated-to page can't inherit it).
	it('main-frame cross-document nav (isMainFrame=true, isInPlace=false) revokes the grant → DECK_FORBIDDEN', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp(
			{ hostServices: { ping: () => 'pong' as JsonValue } },
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()

		const handler = vi.fn(() => 'resized' as JsonValue)
		privileged(app.runtime).layout.command('layout.resize', handler)

		const wc = mainWc(electron)
		app.runtime.grants.issue(controlWc(wc), { commands: ['layout.resize'] })

		// Sanity: while granted, the gated command passes.
		const granted = await invokeHost(ipcMain, wc.id, 'layout.resize', [{ w: 320 }])
		expect(granted.ok).toBe(true)

		// Sanity: the framework wired the nav hook onto the control wc (so the
		// revocation is even reachable). If this fails, the hook is entirely absent.
		expect(wc.on).toHaveBeenCalledWith('did-start-navigation', expect.any(Function))

		// Cross-document main-frame navigation — the navigated-to document must
		// NOT inherit the prior page's grant.
		wc._emitNav({ url: 'http://localhost/evil', isInPlace: false, isMainFrame: true })

		// Let any async wcScope.reset() cascade settle.
		await new Promise(r => setTimeout(r, 0))

		const afterNav = await invokeHost(ipcMain, wc.id, 'layout.resize', [{ w: 999 }])
		expect(afterNav.ok).toBe(false)
		expect((afterNav as InvokeFail).error.code).toBe('DECK_FORBIDDEN')
		// The post-nav handler must NOT have run (its first call was the granted one).
		expect(handler).toHaveBeenCalledTimes(1)

		await app.shutdown()
	})

	// NEGATIVE: in-place navigation (hash change / history.pushState) is the SAME
	// document — it must NOT revoke. The grant survives, the command stays allowed.
	it('in-place navigation (isMainFrame=true, isInPlace=true) does NOT revoke the grant', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp(
			{ hostServices: { ping: () => 'pong' as JsonValue } },
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()

		const handler = vi.fn(() => 'resized' as JsonValue)
		privileged(app.runtime).layout.command('layout.resize', handler)

		const wc = mainWc(electron)
		app.runtime.grants.issue(controlWc(wc), { commands: ['layout.resize'] })
		expect((await invokeHost(ipcMain, wc.id, 'layout.resize', [])).ok).toBe(true)

		// hash/pushState — same document, must NOT revoke.
		wc._emitNav({ url: 'http://localhost/page#section', isInPlace: true, isMainFrame: true })
		await new Promise(r => setTimeout(r, 0))

		const afterInPlace = await invokeHost(ipcMain, wc.id, 'layout.resize', [])
		expect(afterInPlace.ok).toBe(true)

		await app.shutdown()
	})

	// NEGATIVE: a sub-frame (iframe) navigation must NOT revoke the top-level
	// control wc's grant — only a MAIN-FRAME navigation is a document swap for the
	// privileged surface.
	it('sub-frame navigation (isMainFrame=false) does NOT revoke the grant', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp(
			{ hostServices: { ping: () => 'pong' as JsonValue } },
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()

		const handler = vi.fn(() => 'resized' as JsonValue)
		privileged(app.runtime).layout.command('layout.resize', handler)

		const wc = mainWc(electron)
		app.runtime.grants.issue(controlWc(wc), { commands: ['layout.resize'] })
		expect((await invokeHost(ipcMain, wc.id, 'layout.resize', [])).ok).toBe(true)

		// A subframe cross-document navigation — must NOT revoke the top-level grant.
		wc._emitNav({ url: 'http://ads.example/frame', isInPlace: false, isMainFrame: false })
		await new Promise(r => setTimeout(r, 0))

		const afterSubframe = await invokeHost(ipcMain, wc.id, 'layout.resize', [])
		expect(afterSubframe.ok).toBe(true)

		await app.shutdown()
	})

	// TRUST: after a main-frame cross-document nav, wcScope.reset() re-opens a
	// clean segment — the wc stays TRUSTED/usable (only the grant is gone). An
	// ORDINARY (un-gated) hostServices call must still succeed for the same sender.
	it('after main-frame cross-doc nav the wc stays trusted (ordinary hostServices.ping still ok) — only the grant is gone', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp(
			{ hostServices: { ping: () => 'pong' as JsonValue } },
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()

		privileged(app.runtime).layout.command('layout.resize', vi.fn(() => 'resized' as JsonValue))

		const wc = mainWc(electron)
		app.runtime.grants.issue(controlWc(wc), { commands: ['layout.resize'] })

		wc._emitNav({ url: 'http://localhost/next', isInPlace: false, isMainFrame: true })
		await new Promise(r => setTimeout(r, 0))

		// The grant is gone …
		const gated = await invokeHost(ipcMain, wc.id, 'layout.resize', [])
		expect(gated.ok).toBe(false)
		expect((gated as InvokeFail).error.code).toBe('DECK_FORBIDDEN')

		// … but the wc is still TRUSTED — ordinary (un-gated) calls succeed.
		const ordinary = await invokeHost(ipcMain, wc.id, 'ping', [])
		expect(ordinary.ok).toBe(true)
		expect((ordinary as InvokeOk).result).toBe('pong')

		await app.shutdown()
	})
})
