import { describe, expect, it, vi } from 'vitest'
import { defineEvent } from '../events.js'
import {
	BRIDGE_PROTOCOL_VERSION,
	DeckChannel,
} from '../shared/protocol.js'
import type { JsonValue, Runtime, RuntimeBackend, WebviewSource, DeckConfig } from '../types.js'
import type {
	MinimalBrowserWindow,
	MinimalBrowserWindowOptions,
	MinimalElectron,
	MinimalRect,
	MinimalWebContentsLike,
	MinimalWebContentsView,
} from './electron-types.js'
import { DeckApp } from './deck-app.js'
import type { MinimalIpcMain, MinimalWebContents } from './wire-transport.js'

/**
 * Phase 2 contract tests for DeckApp lifecycle driver.
 *
 * Source of truth: JSDoc on DeckApp. Phase 2 in-memory only —
 * Electron-specific runtime fields (electron / mainWindow / toolbarView)
 * are not exercised here.
 */
describe('DeckApp — construction', () => {
	it('constructs with an empty config without throwing', () => {
		expect(() => new DeckApp({})).not.toThrow()
	})

	it('exposes config back via app.config', () => {
		const cfg: DeckConfig = {}
		const app = new DeckApp(cfg)
		expect(app.config).toBe(cfg)
	})

	// CONTRACT-AMBIGUOUS: JSDoc does not specify whether ctor validates or
	// whether validation runs in start(). We assert "rejection happens on
	// start() (validate-on-call)" because the public electronDeck() entry uses
	// the same pattern, and ctor-throwing makes it hard to wire test fixtures.
	it('invalid config rejects on start(), not at construction time (CONTRACT-AMBIGUOUS)', async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const bad: any = { simulatorApis: { broken: 'oops' } }
		// Either ctor throws OR start() rejects — both honour validate-on-call.
		let ctorThrew = false
		let app: DeckApp | null = null
		try {
			app = new DeckApp(bad)
		}
		catch {
			ctorThrew = true
		}
		if (!ctorThrew && app) {
			await expect(app.start()).rejects.toThrow(TypeError)
		}
	})
})

describe('DeckApp — start() phase progression', () => {
	it('phase advances from init to ready after start()', async () => {
		const app = new DeckApp({})
		await app.start()
		expect(app.phase).toBe('ready')
	})

	it('start() invokes config.setup(runtime) before reaching ready', async () => {
		const setup = vi.fn()
		const app = new DeckApp({ setup })
		await app.start()
		expect(setup).toHaveBeenCalledTimes(1)
		const arg = setup.mock.calls[0]?.[0] as Runtime | undefined
		expect(arg).toBeDefined()
		expect(typeof arg?.add).toBe('function')
	})

	it('start() awaits an async setup before resolving', async () => {
		let setupFinished = false
		const app = new DeckApp({
			setup: async () => {
				await new Promise(r => setTimeout(r, 20))
				setupFinished = true
			},
		})
		await app.start()
		expect(setupFinished).toBe(true)
		expect(app.phase).toBe('ready')
	})

	it('runtime is unavailable before setup phase (throws on access)', () => {
		const app = new DeckApp({})
		expect(() => app.runtime).toThrow()
	})

	it('runtime is available after start()', async () => {
		const app = new DeckApp({})
		await app.start()
		expect(() => app.runtime).not.toThrow()
		expect(app.runtime).toBeDefined()
	})

	it('setup throwing → start() rejects with the same error and app proceeds through cleanup → destroy', async () => {
		const err = new Error('setup-boom')
		const app = new DeckApp({
			setup: () => {
				throw err
			},
		})
		await expect(app.start()).rejects.toBe(err)
		// dispose must have run; phase should NOT be 'ready'
		expect(app.phase).not.toBe('ready')
		// Phase must have progressed to a teardown state (cleanup/destroy/quit)
		// — not stuck at setup.
		expect(['cleanup', 'destroy', 'quit']).toContain(app.phase)
	})

	it('setup throwing causes registered disposables to run', async () => {
		const dispose = vi.fn()
		const err = new Error('setup-boom')
		const app = new DeckApp({
			setup: (rt) => {
				rt.add(dispose)
				throw err
			},
		})
		await expect(app.start()).rejects.toBe(err)
		expect(dispose).toHaveBeenCalledTimes(1)
	})
})

describe('DeckApp — declared events during setup', () => {
	it('a declared HostEvent.publish() is bound before setup runs (does not throw)', async () => {
		const ev = defineEvent<JsonValue>('declared-evt')
		let threw = false
		const app = new DeckApp({
			events: [ev],
			setup: () => {
				try {
					ev.publish({ ok: true })
				}
				catch {
					threw = true
				}
			},
		})
		await app.start()
		expect(threw).toBe(false)
	})
})

describe('DeckApp — shutdown()', () => {
	it('shutdown() drives phase through to quit', async () => {
		const app = new DeckApp({})
		await app.start()
		await app.shutdown()
		expect(app.phase).toBe('quit')
	})

	it('shutdown() is idempotent — second call resolves without throwing', async () => {
		const app = new DeckApp({})
		await app.start()
		await app.shutdown()
		await expect(app.shutdown()).resolves.toBeUndefined()
		expect(app.phase).toBe('quit')
	})

	it('shutdown() awaits lifecycle.beforeClose', async () => {
		let beforeFinished = false
		const app = new DeckApp({
			lifecycle: {
				beforeClose: async () => {
					await new Promise(r => setTimeout(r, 20))
					beforeFinished = true
				},
			},
		})
		await app.start()
		await app.shutdown()
		expect(beforeFinished).toBe(true)
	})

	it('shutdown() invokes runtime.add() disposables in LIFO order', async () => {
		const calls: string[] = []
		const app = new DeckApp({
			setup: (rt) => {
				rt.add(() => {
					calls.push('a')
				})
				rt.add(() => {
					calls.push('b')
				})
				rt.add(() => {
					calls.push('c')
				})
			},
		})
		await app.start()
		await app.shutdown()
		expect(calls).toEqual(['c', 'b', 'a'])
	})

	it('shutdown() disposes a Disposable added during setup', async () => {
		const dispose = vi.fn()
		const app = new DeckApp({
			setup: (rt) => {
				rt.add({ dispose })
			},
		})
		await app.start()
		expect(dispose).not.toHaveBeenCalled()
		await app.shutdown()
		expect(dispose).toHaveBeenCalledTimes(1)
	})

	// CONTRACT-AMBIGUOUS: JSDoc says "timeout → log error" but does not say
	// whether shutdown rejects or continues. We assert "log error then
	// continue into cleanup", which avoids leaving the host in a stuck
	// half-shut state — the safer choice for a framework boundary.
	it('beforeClose timing out logs an error but shutdown() still resolves to quit (CONTRACT-AMBIGUOUS)', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		try {
			const app = new DeckApp({
				lifecycle: {
					timeoutMs: 30,
					beforeClose: () => new Promise(() => {
						// never resolves
					}),
				},
			})
			await app.start()
			await expect(app.shutdown()).resolves.toBeUndefined()
			expect(app.phase).toBe('quit')
			expect(errorSpy).toHaveBeenCalled()
		}
		finally {
			errorSpy.mockRestore()
		}
	}, 5000)
})

// ── Phase 3b: WireTransport integration via DeckAppOptions.wireTransport ──

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

interface FakeWebContents extends MinimalWebContents {
	send: ReturnType<typeof vi.fn> & MinimalWebContents['send']
	destroyed: boolean
}

function createFakeWebContents(id: number): FakeWebContents {
	const wc: FakeWebContents = {
		id,
		destroyed: false,
		isDestroyed(): boolean {
			return wc.destroyed
		},
		send: vi.fn() as FakeWebContents['send'],
	}
	return wc
}

describe('DeckApp — wireTransport integration', () => {
	it('start() registers ipcMain.handle for invoke + probe + place + layout-subscribe channels', async () => {
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp({}, { wireTransport: { ipcMain } })
		await app.start()
		// P5 eager-arm: channels now armed at start — the slot-token Place /
		// LayoutSubscribe handlers are registered eagerly (no longer lazily on the
		// first anchored placeIn), so a slot-less app also registers all 4.
		expect(ipcMain.handle).toHaveBeenCalledTimes(4)
		const channels = ipcMain.handle.mock.calls.map(c => c[0] as string).sort()
		expect(channels).toEqual(
			[DeckChannel.Invoke, DeckChannel.Probe, DeckChannel.Place, DeckChannel.LayoutSubscribe].sort(),
		)
	})

	it('declared hostServices are reachable through the ipcMain invoke handler (trusted sender)', async () => {
		const ipcMain = createFakeIpcMain()
		const wc = createFakeWebContents(11)
		const app = new DeckApp(
			{
				hostServices: {
					ping: () => 'pong' as JsonValue,
				},
			},
			{ wireTransport: { ipcMain, trustedWebContents: () => [wc] } },
		)
		await app.start()

		const invoke = ipcMain.handlers.get(DeckChannel.Invoke)
		if (!invoke) throw new Error('invoke handler missing')
		const res = (await invoke(
			{ sender: { id: 11 } },
			{ kind: 'host', name: 'ping', args: [] },
		)) as { ok: true, result: JsonValue }
		expect(res.ok).toBe(true)
		expect(res.result).toBe('pong')

		await app.shutdown()
	})

	it('declared simulatorApis are reachable through the ipcMain invoke handler (trusted sender)', async () => {
		const ipcMain = createFakeIpcMain()
		const wc = createFakeWebContents(12)
		const app = new DeckApp(
			{
				simulatorApis: {
					echo: (msg: string) => msg,
				},
			},
			{ wireTransport: { ipcMain, trustedWebContents: () => [wc] } },
		)
		await app.start()

		const invoke = ipcMain.handlers.get(DeckChannel.Invoke)
		if (!invoke) throw new Error('invoke handler missing')
		const res = (await invoke(
			{ sender: { id: 12 } },
			{ kind: 'simulator', name: 'echo', args: ['hello'] },
		)) as { ok: true, result: JsonValue }
		expect(res.ok).toBe(true)
		expect(res.result).toBe('hello')

		await app.shutdown()
	})

	it('untrusted sender hitting the ipcMain invoke handler resolves to InvokeFailure with code UNTRUSTED_SENDER', async () => {
		const ipcMain = createFakeIpcMain()
		const hostServices = { secret: vi.fn(() => 'no' as JsonValue) }
		const app = new DeckApp(
			{ hostServices },
			// no trusted webContents → all senders untrusted
			{ wireTransport: { ipcMain, trustedWebContents: () => [] } },
		)
		await app.start()

		const invoke = ipcMain.handlers.get(DeckChannel.Invoke)
		if (!invoke) throw new Error('invoke handler missing')
		const res = (await invoke(
			{ sender: { id: 99 } },
			{ kind: 'host', name: 'secret', args: [] },
		)) as { ok: false, error: { code?: string } }
		expect(res.ok).toBe(false)
		expect(res.error.code).toBe('DECK_UNTRUSTED_SENDER')
		expect(hostServices.secret).not.toHaveBeenCalled()
		await app.shutdown()
	})

	it('probe handler returns ready + BRIDGE_PROTOCOL_VERSION', async () => {
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp({}, { wireTransport: { ipcMain } })
		await app.start()
		const probe = ipcMain.handlers.get(DeckChannel.Probe)
		if (!probe) throw new Error('probe handler missing')
		const res = await probe({ sender: { id: 1 } })
		expect(res).toEqual({ ready: true, version: BRIDGE_PROTOCOL_VERSION })
		await app.shutdown()
	})

	it('declared HostEvent.publish() fans out to trusted webContents via send(__electron-deck:event, envelope)', async () => {
		const ipcMain = createFakeIpcMain()
		const wc = createFakeWebContents(20)
		const ev = defineEvent<JsonValue>('hello')
		const app = new DeckApp(
			{ events: [ev] },
			{ wireTransport: { ipcMain, trustedWebContents: () => [wc] } },
		)
		await app.start()

		ev.publish({ msg: 'world' })

		expect(wc.send).toHaveBeenCalledTimes(1)
		expect(wc.send).toHaveBeenCalledWith(DeckChannel.Event, {
			name: 'hello',
			payload: { msg: 'world' },
		})
		await app.shutdown()
	})

	it('shutdown() calls ipcMain.removeHandler for invoke + probe + place + layout-subscribe', async () => {
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp({}, { wireTransport: { ipcMain } })
		await app.start()
		await app.shutdown()
		// P5 eager-arm: channels now armed at start, so shutdown removes all 4
		// (the eagerly-registered Place / LayoutSubscribe handlers too).
		expect(ipcMain.removeHandler).toHaveBeenCalledTimes(4)
		const removed = ipcMain.removeHandler.mock.calls.map(c => c[0] as string).sort()
		expect(removed).toEqual(
			[DeckChannel.Invoke, DeckChannel.Probe, DeckChannel.Place, DeckChannel.LayoutSubscribe].sort(),
		)
	})

	it('after shutdown(), declared HostEvent.publish no longer fans out (best-effort)', async () => {
		// HostEvent publisher is unbound by bus.unbindAll() in shutdown — publish
		// after shutdown throws EventNotBoundError. We assert that path here.
		const ipcMain = createFakeIpcMain()
		const wc = createFakeWebContents(30)
		const ev = defineEvent<JsonValue>('drain-me')
		const app = new DeckApp(
			{ events: [ev] },
			{ wireTransport: { ipcMain, trustedWebContents: () => [wc] } },
		)
		await app.start()
		ev.publish({ x: 1 })
		expect(wc.send).toHaveBeenCalledTimes(1)
		await app.shutdown()
		expect(() => ev.publish({ x: 2 })).toThrow()
		expect(wc.send).toHaveBeenCalledTimes(1)
	})

	it('default senderPolicy treats _trustWebContents() entries as trusted (Phase 4 windows.trust path)', async () => {
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp(
			{ hostServices: { ping: () => 'pong' as JsonValue } },
			{ wireTransport: { ipcMain } },
		)
		await app.start()

		const invoke = ipcMain.handlers.get(DeckChannel.Invoke)
		if (!invoke) throw new Error('invoke handler missing')

		// Untrusted by default — no _trustWebContents() called yet.
		const untrustedRes = (await invoke(
			{ sender: { id: 50 } },
			{ kind: 'host', name: 'ping', args: [] },
		)) as { ok: false, error: { code?: string } }
		expect(untrustedRes.ok).toBe(false)
		expect(untrustedRes.error.code).toBe('DECK_UNTRUSTED_SENDER')

		// Trust a webContents → its sender id should now route through.
		const wc = createFakeWebContents(50)
		const trustDispose = app._trustWebContents(wc)
		const trustedRes = (await invoke(
			{ sender: { id: 50 } },
			{ kind: 'host', name: 'ping', args: [] },
		)) as { ok: true, result: JsonValue }
		expect(trustedRes.ok).toBe(true)
		expect(trustedRes.result).toBe('pong')

		// Dispose returns it to untrusted.
		trustDispose.dispose()
		const afterRes = (await invoke(
			{ sender: { id: 50 } },
			{ kind: 'host', name: 'ping', args: [] },
		)) as { ok: false, error: { code?: string } }
		expect(afterRes.ok).toBe(false)
		expect(afterRes.error.code).toBe('DECK_UNTRUSTED_SENDER')

		await app.shutdown()
	})
})

// ── Phase 4: Electron assembly via DeckAppOptions.electron ──────────────

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
	/** Test-only — map of event name → listeners registered via `.on(event, fn)`. */
	_listeners: Map<string, Array<(...args: unknown[]) => void>>
	/** Test-only — invoke all listeners registered for the given event. */
	_emit(event: 'resize' | 'closed' | 'close'): void
	/** Test-only — the last cancelable event passed to 'close' listeners. */
	_lastCloseEvent: { preventDefault: ReturnType<typeof vi.fn> } | null
}

interface FakeWebContentsView extends MinimalWebContentsView {
	readonly webContents: FakeWebContentsLike
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
			// Electron's 'close' fires with a cancelable event object; the
			// framework's close-decision handler calls e.preventDefault().
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

describe('DeckApp — electron assembly', () => {
	// MUST 1: mainWindow ctor reflects config.app.window + name + icon
	it('start() constructs the mainWindow with title/icon/width/height/minWidth/minHeight from config.app', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp(
			{
				app: {
					name: 'Demo Deck',
					icon: '/abs/path/icon.png',
					window: { width: 1280, height: 800, minWidth: 800, minHeight: 600 },
				},
			},
			{ electron },
		)
		await app.start()

		// First BrowserWindow ctor call = mainWindow
		expect(electron.browserWindowCtorCalls.length).toBeGreaterThanOrEqual(1)
		const mainOpts = electron.browserWindowCtorCalls[0]
		expect(mainOpts).toBeDefined()
		expect(mainOpts!.title).toBe('Demo Deck')
		expect(mainOpts!.icon).toBe('/abs/path/icon.png')
		expect(mainOpts!.width).toBe(1280)
		expect(mainOpts!.height).toBe(800)
		expect(mainOpts!.minWidth).toBe(800)
		expect(mainOpts!.minHeight).toBe(600)
	})

	// MUST 2: mainWindow defaults to *some* numeric width/height (CONTRACT-AMBIGUOUS).
	// We only assert presence + type, not specific defaults — framework picks.
	it('mainWindow ctor receives numeric width/height even when config.app.window is omitted (CONTRACT-AMBIGUOUS defaults)', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron })
		await app.start()

		const mainOpts = electron.browserWindowCtorCalls[0]
		expect(mainOpts).toBeDefined()
		expect(typeof mainOpts!.width).toBe('number')
		expect(typeof mainOpts!.height).toBe('number')
	})

	// MUST 8: runtime.electron / mainWindow / rawIpcMain available after start()
	it('runtime.electron returns the injected fake (same reference) after start()', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron })
		await app.start()
		expect(app.runtime.electron).toBe(electron as unknown as Runtime['electron'])
	})

	it('runtime.mainWindow returns the constructed mainWindow after start()', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron })
		await app.start()
		expect(() => app.runtime.mainWindow).not.toThrow()
		expect(app.runtime.mainWindow).toBe(electron.browserWindows[0] as unknown as Runtime['mainWindow'])
	})

	it('runtime.rawIpcMain returns the wired ipcMain (no longer throws) when wireTransport is provided', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain } })
		await app.start()
		expect(() => app.runtime.rawIpcMain).not.toThrow()
	})

	// MUST 3: mainWindow.webContents is auto-trusted (via default senderPolicy)
	it('mainWindow.webContents is automatically trusted (default senderPolicy lets its id through)', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp(
			{ hostServices: { ping: () => 'pong' as JsonValue } },
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()

		const mainWcId = (electron.browserWindows[0] as unknown as FakeBrowserWindow).webContents.id
		const invoke = ipcMain.handlers.get(DeckChannel.Invoke)
		if (!invoke) throw new Error('invoke handler missing')
		const res = (await invoke(
			{ sender: { id: mainWcId } },
			{ kind: 'host', name: 'ping', args: [] },
		)) as { ok: true, result: JsonValue }
		expect(res.ok).toBe(true)
		expect(res.result).toBe('pong')

		await app.shutdown()
	})

	// MUST 4a: toolbar WebContentsView ctor with preloadPath
	it('config.toolbar present → WebContentsView is constructed with webPreferences.preload === toolbar.preloadPath', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp(
			{
				toolbar: {
					source: { url: 'http://localhost:5173/toolbar.html' },
					preloadPath: '/abs/preload/toolbar.cjs',
					height: 60,
				},
			},
			{ electron, wireTransport: { ipcMain: createFakeIpcMain() } },
		)
		await app.start()

		expect(electron.webContentsViewCtorCalls).toHaveLength(1)
		const opts = electron.webContentsViewCtorCalls[0]
		expect(opts).toBeDefined()
		expect(opts?.webPreferences?.preload).toBe('/abs/preload/toolbar.cjs')
	})

	// MUST 4b: toolbar view attached to mainWindow.contentView
	it('toolbar view is added to mainWindow.contentView via addChildView', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp(
			{
				toolbar: {
					source: { url: 'http://localhost:5173/toolbar.html' },
					preloadPath: '/abs/preload/toolbar.cjs',
					height: 60,
				},
			},
			{ electron, wireTransport: { ipcMain: createFakeIpcMain() } },
		)
		await app.start()

		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow
		const view = electron.webContentsViews[0]
		expect(mainWin.contentView.addChildView).toHaveBeenCalledTimes(1)
		expect(mainWin.contentView.addChildView).toHaveBeenCalledWith(view)
	})

	// MUST 4c: toolbar source.url → view.webContents.loadURL
	it('toolbar source.url → view.webContents.loadURL is called with that url', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp(
			{
				toolbar: {
					source: { url: 'http://localhost:5173/toolbar.html' },
					preloadPath: '/abs/preload/toolbar.cjs',
					height: 60,
				},
			},
			{ electron, wireTransport: { ipcMain: createFakeIpcMain() } },
		)
		await app.start()

		const view = electron.webContentsViews[0] as FakeWebContentsView
		expect(view.webContents.loadURL).toHaveBeenCalledTimes(1)
		expect(view.webContents.loadURL).toHaveBeenCalledWith('http://localhost:5173/toolbar.html')
		expect(view.webContents.loadFile).not.toHaveBeenCalled()
	})

	// MUST 4c (file branch)
	it('toolbar source.file → view.webContents.loadFile is called with that path', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp(
			{
				toolbar: {
					source: { file: '/abs/dist/toolbar/index.html' },
					preloadPath: '/abs/preload/toolbar.cjs',
					height: 60,
				},
			},
			{ electron, wireTransport: { ipcMain: createFakeIpcMain() } },
		)
		await app.start()

		const view = electron.webContentsViews[0] as FakeWebContentsView
		expect(view.webContents.loadFile).toHaveBeenCalledTimes(1)
		expect(view.webContents.loadFile).toHaveBeenCalledWith('/abs/dist/toolbar/index.html')
		expect(view.webContents.loadURL).not.toHaveBeenCalled()
	})

	// MUST 4d: toolbar view webContents auto-trusted
	it('toolbar view.webContents is automatically trusted (default senderPolicy lets its id through)', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp(
			{
				toolbar: {
					source: { url: 'http://localhost:5173/toolbar.html' },
					preloadPath: '/abs/preload/toolbar.cjs',
					height: 60,
				},
				hostServices: { ping: () => 'pong' as JsonValue },
			},
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()

		const toolbarWcId = (electron.webContentsViews[0] as FakeWebContentsView).webContents.id
		const invoke = ipcMain.handlers.get(DeckChannel.Invoke)
		if (!invoke) throw new Error('invoke handler missing')
		const res = (await invoke(
			{ sender: { id: toolbarWcId } },
			{ kind: 'host', name: 'ping', args: [] },
		)) as { ok: true, result: JsonValue }
		expect(res.ok).toBe(true)
		expect(res.result).toBe('pong')

		await app.shutdown()
	})

	// MUST 4e: toolbar.height → view.setBounds, x=0,y=0, width=mainWindow.getContentBounds().width
	it('toolbar.height drives view.setBounds: x=0, y=0, height=toolbar.height, width=mainWindow.getContentBounds().width', async () => {
		const electron = createFakeElectron({ x: 0, y: 0, width: 1440, height: 900 })
		const app = new DeckApp(
			{
				toolbar: {
					source: { url: 'http://localhost:5173/toolbar.html' },
					preloadPath: '/abs/preload/toolbar.cjs',
					height: 48,
				},
			},
			{ electron, wireTransport: { ipcMain: createFakeIpcMain() } },
		)
		await app.start()

		const view = electron.webContentsViews[0] as FakeWebContentsView
		expect(view.setBounds).toHaveBeenCalled()
		const lastCall = view.setBounds.mock.calls[view.setBounds.mock.calls.length - 1]
		const rect = lastCall?.[0] as MinimalRect
		expect(rect.x).toBe(0)
		expect(rect.y).toBe(0)
		expect(rect.height).toBe(48)
		expect(rect.width).toBe(1440)
	})

	// MUST 5: no toolbar → runtime.toolbarView is null, WebContentsView never constructed
	it('config.toolbar absent → runtime.toolbarView === null and WebContentsView ctor was never called', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron })
		await app.start()

		expect(app.runtime.toolbarView).toBeNull()
		expect(electron.webContentsViewCtorCalls).toHaveLength(0)
	})

	// MUST 6: declared windows in config.windows each → BrowserWindow ctor + load*
	it('declared windows each construct a BrowserWindow with title/width/height/modal/preload from contribution', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp(
			{
				windows: {
					reauth: {
						title: 'Re-Authenticate',
						source: { url: 'http://localhost:5173/reauth.html' },
						preloadPath: '/abs/preload/reauth.cjs',
						width: 480,
						height: 320,
						modal: true,
					},
				},
			},
			{ electron, wireTransport: { ipcMain: createFakeIpcMain() } },
		)
		await app.start()

		// First ctor = mainWindow; second = declared 'reauth'
		expect(electron.browserWindowCtorCalls.length).toBeGreaterThanOrEqual(2)
		const reauthOpts = electron.browserWindowCtorCalls[1]
		expect(reauthOpts).toBeDefined()
		expect(reauthOpts!.title).toBe('Re-Authenticate')
		expect(reauthOpts!.width).toBe(480)
		expect(reauthOpts!.height).toBe(320)
		expect(reauthOpts!.modal).toBe(true)
		expect(reauthOpts!.webPreferences?.preload).toBe('/abs/preload/reauth.cjs')

		// loadURL called
		const reauthWin = electron.browserWindows[1] as unknown as FakeBrowserWindow
		expect(reauthWin.webContents.loadURL).toHaveBeenCalledWith('http://localhost:5173/reauth.html')
	})

	it('declared window source.file → win.webContents.loadFile is called with that path', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp(
			{
				windows: {
					welcome: {
						source: { file: '/abs/dist/welcome/index.html' },
					},
				},
			},
			{ electron, wireTransport: { ipcMain: createFakeIpcMain() } },
		)
		await app.start()

		const win = electron.browserWindows[1] as unknown as FakeBrowserWindow
		expect(win.webContents.loadFile).toHaveBeenCalledWith('/abs/dist/welcome/index.html')
		expect(win.webContents.loadURL).not.toHaveBeenCalled()
	})

	// MUST 7: declared windows auto-trusted by default
	it('declared windows webContents are automatically trusted', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp(
			{
				windows: {
					reauth: {
						source: { url: 'http://localhost:5173/reauth.html' },
					},
				},
				hostServices: { ping: () => 'pong' as JsonValue },
			},
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()

		const reauthWin = electron.browserWindows[1] as unknown as FakeBrowserWindow
		const invoke = ipcMain.handlers.get(DeckChannel.Invoke)
		if (!invoke) throw new Error('invoke handler missing')
		const res = (await invoke(
			{ sender: { id: reauthWin.webContents.id } },
			{ kind: 'host', name: 'ping', args: [] },
		)) as { ok: true, result: JsonValue }
		expect(res.ok).toBe(true)
		expect(res.result).toBe('pong')

		await app.shutdown()
	})

	// MUST 9: runtime.windows.create(opts) constructs a BrowserWindow + autoTrust default true
	it('runtime.windows.create({ source: url }) constructs a BrowserWindow and loads the url; autoTrust defaults to true', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp(
			{ hostServices: { ping: () => 'pong' as JsonValue } },
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()

		const before = electron.browserWindowCtorCalls.length
		const win = app.runtime.windows.create({
			source: { url: 'http://localhost:5173/dyn.html' },
			width: 500,
			height: 400,
		}).window as unknown as FakeBrowserWindow

		expect(electron.browserWindowCtorCalls.length).toBe(before + 1)
		expect(win.webContents.loadURL).toHaveBeenCalledWith('http://localhost:5173/dyn.html')

		// autoTrust default true → its webContents.id resolves trusted
		const invoke = ipcMain.handlers.get(DeckChannel.Invoke)
		if (!invoke) throw new Error('invoke handler missing')
		const res = (await invoke(
			{ sender: { id: win.webContents.id } },
			{ kind: 'host', name: 'ping', args: [] },
		)) as { ok: true, result: JsonValue }
		expect(res.ok).toBe(true)

		await app.shutdown()
	})

	it('runtime.windows.create({ autoTrust: false }) does NOT trust the new webContents', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp(
			{ hostServices: { ping: () => 'pong' as JsonValue } },
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()

		const win = app.runtime.windows.create({
			source: { url: 'http://localhost:5173/untrusted.html' },
			autoTrust: false,
		}).window as unknown as FakeBrowserWindow

		const invoke = ipcMain.handlers.get(DeckChannel.Invoke)
		if (!invoke) throw new Error('invoke handler missing')
		const res = (await invoke(
			{ sender: { id: win.webContents.id } },
			{ kind: 'host', name: 'ping', args: [] },
		)) as { ok: false, error: { code?: string } }
		expect(res.ok).toBe(false)
		expect(res.error.code).toBe('DECK_UNTRUSTED_SENDER')

		await app.shutdown()
	})

	// MUST 10: runtime.windows.get(id) returns declared window by record key
	it('runtime.windows.get("reauth") returns the declared window registered under that key', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp(
			{
				windows: {
					reauth: {
						source: { url: 'http://localhost:5173/reauth.html' },
					},
				},
			},
			{ electron, wireTransport: { ipcMain: createFakeIpcMain() } },
		)
		await app.start()

		const declared = app.runtime.windows.get('reauth') as unknown as FakeBrowserWindow | undefined
		expect(declared).toBeDefined()
		expect(declared).toBe(electron.browserWindows[1])
	})

	it('runtime.windows.get(unknown-id) returns undefined', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron })
		await app.start()
		expect(app.runtime.windows.get('nope')).toBeUndefined()
	})

	// MUST 11: runtime.windows.all()
	it('runtime.windows.all() includes mainWindow + declared + runtime.windows.create() spawned windows', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp(
			{
				windows: {
					reauth: { source: { url: 'http://localhost:5173/reauth.html' } },
				},
			},
			{ electron, wireTransport: { ipcMain: createFakeIpcMain() } },
		)
		await app.start()

		const created = app.runtime.windows.create({
			source: { url: 'http://localhost:5173/dyn.html' },
		}).window
		const all = app.runtime.windows.all()
		expect(all.length).toBeGreaterThanOrEqual(3)
		expect(all).toContain(app.runtime.mainWindow)
		expect(all).toContain(app.runtime.windows.get('reauth') as unknown as Runtime['mainWindow'])
		expect(all).toContain(created)
	})

	// MUST 12: runtime.windows.trust(win) → trusts; dispose → un-trusts
	it('runtime.windows.trust(win) adds the win.webContents to trusted set; dispose removes it', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp(
			{ hostServices: { ping: () => 'pong' as JsonValue } },
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()

		// Construct a window with autoTrust:false so it starts untrusted.
		const win = app.runtime.windows.create({
			source: { url: 'http://localhost:5173/x.html' },
			autoTrust: false,
		}).window as unknown as FakeBrowserWindow

		const invoke = ipcMain.handlers.get(DeckChannel.Invoke)
		if (!invoke) throw new Error('invoke handler missing')

		const before = (await invoke(
			{ sender: { id: win.webContents.id } },
			{ kind: 'host', name: 'ping', args: [] },
		)) as { ok: false, error: { code?: string } }
		expect(before.ok).toBe(false)
		expect(before.error.code).toBe('DECK_UNTRUSTED_SENDER')

		const dispose = app.runtime.windows.trust(win as unknown as Runtime['mainWindow'])
		const after = (await invoke(
			{ sender: { id: win.webContents.id } },
			{ kind: 'host', name: 'ping', args: [] },
		)) as { ok: true, result: JsonValue }
		expect(after.ok).toBe(true)

		dispose.dispose()
		const afterDispose = (await invoke(
			{ sender: { id: win.webContents.id } },
			{ kind: 'host', name: 'ping', args: [] },
		)) as { ok: false, error: { code?: string } }
		expect(afterDispose.ok).toBe(false)
		expect(afterDispose.error.code).toBe('DECK_UNTRUSTED_SENDER')

		await app.shutdown()
	})

	// MUST 13: shutdown destroys mainWindow + declared windows; idempotent.
	// CONTRACT-AMBIGUOUS: order between mainWindow / declared / runtime-created
	// is not asserted, only that all destroy() calls fire and none happen
	// twice on an already-destroyed window.
	it('shutdown() destroys mainWindow and declared windows (CONTRACT-AMBIGUOUS order)', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp(
			{
				windows: {
					reauth: { source: { url: 'http://localhost:5173/reauth.html' } },
				},
			},
			{ electron, wireTransport: { ipcMain: createFakeIpcMain() } },
		)
		await app.start()

		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow
		const reauthWin = electron.browserWindows[1] as unknown as FakeBrowserWindow

		await app.shutdown()

		expect(mainWin.destroy).toHaveBeenCalled()
		expect(reauthWin.destroy).toHaveBeenCalled()
	})

	it('shutdown() destroys windows spawned via runtime.windows.create() too', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron })
		await app.start()

		const created = app.runtime.windows.create({
			source: { url: 'http://localhost:5173/dyn.html' },
		}).window as unknown as FakeBrowserWindow

		await app.shutdown()
		expect(created.destroy).toHaveBeenCalled()
	})

	it('shutdown() does not double-destroy a window that is already destroyed', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron })
		await app.start()

		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow
		// Mark as already destroyed before shutdown
		mainWin.destroyed = true

		await app.shutdown()
		// destroy should NOT have been called (or, equivalently, isDestroyed() guard skipped it)
		expect(mainWin.destroy).not.toHaveBeenCalled()
	})

	// CONTRACT-AMBIGUOUS: framework does NOT proactively load mainWindow content
	// (host owns that via setup). We assert mainWindow.webContents.loadURL/loadFile
	// were never called by framework during start().
	it('framework does NOT proactively load mainWindow content during start() (host owns mainWindow loadURL/loadFile, CONTRACT-AMBIGUOUS)', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron })
		await app.start()

		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow
		expect(mainWin.webContents.loadURL).not.toHaveBeenCalled()
		expect(mainWin.webContents.loadFile).not.toHaveBeenCalled()
	})

	// race regression: codex review #2 — preload 在 ipcMain handler 未注册时
	// invoke 会失败。framework 必须保证 ipcMain.handle 早于 webContents.loadURL。
	it('declared windows loadURL/loadFile fires AFTER ipcMain.handle is registered (race regression)', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp(
			{
				toolbar: {
					source: { url: 'http://localhost:5173/toolbar.html' },
					preloadPath: '/abs/preload/toolbar.cjs',
					height: 48,
				},
				windows: {
					reauth: { source: { url: 'http://localhost:5173/reauth.html' } },
				},
			},
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()

		const handleOrders = ipcMain.handle.mock.invocationCallOrder
		expect(handleOrders.length).toBeGreaterThan(0)
		const lastHandle = Math.max(...handleOrders)

		const reauth = electron.browserWindows[1] as unknown as FakeBrowserWindow
		const toolbar = electron.webContentsViews[0] as unknown as FakeWebContentsView
		const reauthLoad = reauth.webContents.loadURL.mock.invocationCallOrder
		const toolbarLoad = toolbar.webContents.loadURL.mock.invocationCallOrder

		expect(reauthLoad.length).toBe(1)
		expect(toolbarLoad.length).toBe(1)
		expect(reauthLoad[0]!).toBeGreaterThan(lastHandle)
		expect(toolbarLoad[0]!).toBeGreaterThan(lastHandle)

		await app.shutdown()
	})
})

// ── Review fix #2 R2 — mainWindow 'closed' triggers framework shutdown ──────

describe('DeckApp — mainWindow.closed → framework shutdown (#2 R2)', () => {
	it('mainWindow.on("closed") triggers framework shutdown', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron })
		await app.start()
		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow
		// Sanity: an 'closed' listener has been registered
		const closedListeners = mainWin._listeners.get('closed') ?? []
		expect(closedListeners.length).toBeGreaterThan(0)
		// Simulate the host destroying the main window
		mainWin._emit('closed')
		// Allow the async shutdown chain to settle
		await new Promise(r => setTimeout(r, 0))
		// Wait for the shutdown promise as well (idempotent guard)
		await app.shutdown()
		expect(app.phase).toBe('quit')
	})

	it('declared window "closed" cleans up its tracked state but does NOT shut down the framework', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp(
			{
				windows: {
					reauth: { source: { url: 'http://localhost:5173/reauth.html' } },
				},
			},
			{ electron, wireTransport: { ipcMain: createFakeIpcMain() } },
		)
		await app.start()
		const reauthWin = electron.browserWindows[1] as unknown as FakeBrowserWindow
		const closedListeners = reauthWin._listeners.get('closed') ?? []
		expect(closedListeners.length).toBeGreaterThan(0)
		reauthWin._emit('closed')
		await new Promise(r => setTimeout(r, 0))
		// Framework should still be ready, not quit
		expect(app.phase).toBe('ready')
		// Declared window should no longer appear in windows.all()
		const all = app.runtime.windows.all()
		expect(all.find(w => (w as unknown as FakeBrowserWindow).id === reauthWin.id)).toBeUndefined()
		// Cleanup
		await app.shutdown()
	})
})

// ── v2 — mainWindow close-decision state machine ────────────────────────────
//
// FAILURE-FIRST (TDD): these tests encode the v2 close-decision contract
// (JSDoc on RuntimeBackend.onMainWindowClose + DeckApp). At authoring
// time the implementation still wires only `closed` (legacy #2 R2), so the
// `close`-handler tests below are expected to be RED until the close-decision
// machine lands. The `closed → shutdown` regression test stays GREEN.
//
// Contract under test (v2):
//   • framework registers a `close` handler (cancelable) on the main window.
//   • close handler: ① always e.preventDefault(); ② if a decision is in
//     flight → return (swallow, no re-dispatch); ③ else dispatch exactly one
//     decision = backend?.onMainWindowClose?.() (default 'close'; reject →
//     fail-closed 'close'); ④ 'keep' → window NOT destroyed, in-flight gate
//     cleared, next close re-decides; ⑤ 'close' → main.destroy().
//   • `closed` handler only clears trust + triggers framework shutdown.
describe('DeckApp — mainWindow close-decision machine (v2)', () => {
	// A fake RuntimeBackend with a controllable onMainWindowClose decision.
	function makeBackend(
		onMainWindowClose?: RuntimeBackend['onMainWindowClose'],
	): RuntimeBackend & { assemble: ReturnType<typeof vi.fn> } {
		const backend = {
			assemble: vi.fn(async () => undefined),
		} as RuntimeBackend & { assemble: ReturnType<typeof vi.fn> }
		if (onMainWindowClose) {
			;(backend as { onMainWindowClose?: RuntimeBackend['onMainWindowClose'] }).onMainWindowClose
				= onMainWindowClose
		}
		return backend
	}

	// 1 — decision 'keep' → preventDefault called, window NOT destroyed,
	//     framework NOT shut down (runtime/registry stay live).
	it('backend onMainWindowClose → "keep": preventDefault called, window not destroyed, framework not shut down', async () => {
		const electron = createFakeElectron()
		const onMainWindowClose = vi.fn().mockResolvedValue('keep')
		const backend = makeBackend(onMainWindowClose)
		const app = new DeckApp({}, { electron, backend })
		await app.start()
		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow

		// A 'close' handler must have been registered (v2).
		const closeListeners = mainWin._listeners.get('close') ?? []
		expect(closeListeners.length).toBeGreaterThan(0)

		mainWin._emit('close')
		await new Promise(r => setTimeout(r, 0))

		// ① cancelable event was prevented
		expect(mainWin._lastCloseEvent?.preventDefault).toHaveBeenCalled()
		// ③ decision dispatched exactly once
		expect(onMainWindowClose).toHaveBeenCalledTimes(1)
		// ④ 'keep' → window survives
		expect(mainWin.destroy).not.toHaveBeenCalled()
		expect(mainWin.isDestroyed()).toBe(false)
		// framework still alive — runtime accessible, not quit
		expect(app.phase).toBe('ready')
		expect(() => app.runtime.windows.all()).not.toThrow()

		await app.shutdown()
	})

	// 2 — decision 'close' → window destroyed; the subsequent 'closed'
	//     (driven manually to simulate Electron destroy→closed) → shutdown.
	it('backend onMainWindowClose → "close": window destroyed, then "closed" triggers framework shutdown', async () => {
		const electron = createFakeElectron()
		const onMainWindowClose = vi.fn().mockResolvedValue('close')
		const backend = makeBackend(onMainWindowClose)
		const app = new DeckApp({}, { electron, backend })
		await app.start()
		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow

		mainWin._emit('close')
		await new Promise(r => setTimeout(r, 0))

		expect(mainWin._lastCloseEvent?.preventDefault).toHaveBeenCalled()
		expect(onMainWindowClose).toHaveBeenCalledTimes(1)
		// ⑤ 'close' → window destroyed
		expect(mainWin.destroy).toHaveBeenCalled()

		// Simulate Electron's destroy → 'closed' emission and assert the
		// existing closed → shutdown chain still fires.
		mainWin._emit('closed')
		await new Promise(r => setTimeout(r, 0))
		await app.shutdown()
		expect(app.phase).toBe('quit')
	})

	// 3 — in-flight pincer: a pending decision swallows a second 'close' and
	//     must NOT re-dispatch onMainWindowClose.
	it('in-flight: second "close" during a pending decision is prevented but does NOT re-dispatch onMainWindowClose', async () => {
		const electron = createFakeElectron()
		let resolveDecision: ((v: 'keep' | 'close') => void) | undefined
		const onMainWindowClose = vi.fn(
			() => new Promise<'keep' | 'close'>((resolve) => { resolveDecision = resolve }),
		)
		const backend = makeBackend(onMainWindowClose as RuntimeBackend['onMainWindowClose'])
		const app = new DeckApp({}, { electron, backend })
		await app.start()
		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow

		// First close → dispatches the (pending) decision.
		mainWin._emit('close')
		await new Promise(r => setTimeout(r, 0))
		expect(onMainWindowClose).toHaveBeenCalledTimes(1)
		const firstEvent = mainWin._lastCloseEvent
		expect(firstEvent?.preventDefault).toHaveBeenCalled()

		// Second close WHILE the first decision is still pending.
		mainWin._emit('close')
		await new Promise(r => setTimeout(r, 0))
		// ② swallowed: still prevented, but no re-dispatch.
		expect(mainWin._lastCloseEvent?.preventDefault).toHaveBeenCalled()
		expect(onMainWindowClose).toHaveBeenCalledTimes(1)
		// Not destroyed yet (decision unresolved).
		expect(mainWin.destroy).not.toHaveBeenCalled()

		// Resolve to 'close' to drain in-flight state cleanly.
		resolveDecision?.('close')
		await new Promise(r => setTimeout(r, 0))
		await app.shutdown()
	})

	// 4 — no backend injected → default decision 'close' → window destroyed.
	it('no backend: "close" defaults to a "close" decision → window destroyed', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron })
		await app.start()
		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow

		const closeListeners = mainWin._listeners.get('close') ?? []
		expect(closeListeners.length).toBeGreaterThan(0)

		mainWin._emit('close')
		await new Promise(r => setTimeout(r, 0))

		expect(mainWin._lastCloseEvent?.preventDefault).toHaveBeenCalled()
		expect(mainWin.destroy).toHaveBeenCalled()

		await app.shutdown()
	})

	// 5 — decision rejects → fail-closed: window still destroyed.
	it('decision reject → fail-closed: window is destroyed', async () => {
		const electron = createFakeElectron()
		const onMainWindowClose = vi.fn().mockRejectedValue(new Error('decision-boom'))
		const backend = makeBackend(onMainWindowClose)
		const app = new DeckApp({}, { electron, backend })
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		try {
			await app.start()
			const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow

			mainWin._emit('close')
			await new Promise(r => setTimeout(r, 0))

			expect(mainWin._lastCloseEvent?.preventDefault).toHaveBeenCalled()
			expect(onMainWindowClose).toHaveBeenCalledTimes(1)
			expect(mainWin.destroy).toHaveBeenCalled()
		}
		finally {
			errorSpy.mockRestore()
			await app.shutdown()
		}
	})

	// 6 — REGRESSION (legacy #2 R2): a direct 'closed' (external destroy)
	//     still triggers framework shutdown. Mirrors test at the #2 R2 block.
	it('regression: direct "closed" (external destroy) still triggers framework shutdown', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron })
		await app.start()
		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow
		const closedListeners = mainWin._listeners.get('closed') ?? []
		expect(closedListeners.length).toBeGreaterThan(0)
		mainWin._emit('closed')
		await new Promise(r => setTimeout(r, 0))
		await app.shutdown()
		expect(app.phase).toBe('quit')
	})
})

// ── Review fix #3 R5/C2 — loadAssembledSources catches load errors ──────────

describe('DeckApp — loadURL failures do not reject start() (#3 R5/C2)', () => {
	it('toolbar loadURL rejection is caught and start() resolves', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp(
			{
				toolbar: {
					source: { url: 'http://localhost:5173/toolbar.html' },
					preloadPath: '/p',
					height: 48,
				},
			},
			{ electron, wireTransport: { ipcMain: createFakeIpcMain() } },
		)
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		try {
			// Make the toolbar webContents.loadURL reject
			const origCtor = electron.WebContentsView
			Object.defineProperty(electron, 'WebContentsView', {
				value: class extends (origCtor as unknown as { new(opts?: { webPreferences?: { preload?: string } }): MinimalWebContentsView })  {
					constructor(opts?: { webPreferences?: { preload?: string } }) {
						super(opts)
						const wc = this.webContents as FakeWebContentsLike
						wc.loadURL = vi.fn(async () => {
							throw new Error('load-boom')
						}) as FakeWebContentsLike['loadURL']
					}
				},
				configurable: true,
			})
			await expect(app.start()).resolves.toBeUndefined()
			// Allow microtasks for caught rejection logging
			await new Promise(r => setTimeout(r, 0))
			expect(errorSpy).toHaveBeenCalled()
		}
		finally {
			errorSpy.mockRestore()
			await app.shutdown()
		}
	})

	it('declared window loadFile rejection is caught and start() resolves', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp(
			{
				windows: {
					broken: { source: { file: '/abs/missing.html' } },
				},
			},
			{ electron, wireTransport: { ipcMain: createFakeIpcMain() } },
		)
		// Patch BrowserWindow so the SECOND (declared) ctor produces a wc.loadFile that rejects
		let count = 0
		const origCtor = electron.BrowserWindow
		Object.defineProperty(electron, 'BrowserWindow', {
			value: class extends (origCtor as unknown as { new(opts?: MinimalBrowserWindowOptions): MinimalBrowserWindow }) {
				constructor(opts?: MinimalBrowserWindowOptions) {
					super(opts)
					count++
					if (count === 2) {
						const wc = (this as unknown as FakeBrowserWindow).webContents
						wc.loadFile = vi.fn(async () => {
							throw new Error('file-boom')
						}) as FakeWebContentsLike['loadFile']
					}
				}
			},
			configurable: true,
		})
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		try {
			await expect(app.start()).resolves.toBeUndefined()
			await new Promise(r => setTimeout(r, 0))
			expect(errorSpy).toHaveBeenCalled()
		}
		finally {
			errorSpy.mockRestore()
			await app.shutdown()
		}
	})

	// SELF-AUTHORED test (implementer 自补) — types.ts 加 'load-failed' FrameworkEvent 后，
	// safeLoad 在 catch 里 emitFrameworkEvent('load-failed', {...})，host 在 setup 内
	// 订阅可观测到。codex 终审请重点 cross-check。
	it('loadURL rejection emits FrameworkEvent "load-failed" with source + error', async () => {
		const electron = createFakeElectron()
		let receivedPayload: { source: WebviewSource, error: unknown } | null = null
		const app = new DeckApp(
			{
				toolbar: {
					source: { url: 'http://localhost:5173/will-fail.html' },
					preloadPath: '/p',
					height: 48,
				},
				setup: (rt) => {
					rt.on('load-failed', (p) => {
						receivedPayload = p
					})
				},
			},
			{ electron, wireTransport: { ipcMain: createFakeIpcMain() } },
		)
		const origCtor = electron.WebContentsView
		Object.defineProperty(electron, 'WebContentsView', {
			value: class extends (origCtor as unknown as { new(opts?: { webPreferences?: { preload?: string } }): MinimalWebContentsView }) {
				constructor(opts?: { webPreferences?: { preload?: string } }) {
					super(opts)
					const wc = this.webContents as FakeWebContentsLike
					wc.loadURL = vi.fn(async () => {
						throw new Error('load-failed-boom')
					}) as FakeWebContentsLike['loadURL']
				}
			},
			configurable: true,
		})
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		try {
			await app.start()
			// allow microtasks for catch -> emit
			await new Promise(r => setTimeout(r, 0))
			expect(receivedPayload).not.toBeNull()
			const p = receivedPayload as unknown as { source: WebviewSource, error: unknown }
			expect(p.source).toEqual({ url: 'http://localhost:5173/will-fail.html' })
			expect((p.error as Error).message).toBe('load-failed-boom')
		}
		finally {
			errorSpy.mockRestore()
			await app.shutdown()
		}
	})

	// D3 regression — codex 四审：declared/runtime-created window 'closed' 时
	// 必须把 webContents 从 trustedWcRefs 移除，避免 wc.id 复用 + 内存泄漏。
	it('declared window closed removes its webContents from trust set (D3)', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp(
			{
				windows: {
					tmp: { source: { url: 'http://localhost:5173/tmp.html' } },
				},
				hostServices: { ping: () => 'pong' as JsonValue },
			},
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()
		const tmpWin = electron.browserWindows[1] as unknown as FakeBrowserWindow
		const wcId = tmpWin.webContents.id
		const invoke = ipcMain.handlers.get(DeckChannel.Invoke)
		if (!invoke) throw new Error('invoke handler missing')

		// trusted while alive
		const before = (await invoke(
			{ sender: { id: wcId } },
			{ kind: 'host', name: 'ping', args: [] },
		)) as { ok: true, result: JsonValue }
		expect(before.ok).toBe(true)

		// fire 'closed' callback → handleSubWindowClosed should evict from trustedWcRefs
		const closedCb = (tmpWin.on.mock.calls.find(c => c[0] === 'closed')?.[1]) as (() => void) | undefined
		expect(closedCb).toBeDefined()
		closedCb!()

		// the same wc.id now untrusted
		const after = (await invoke(
			{ sender: { id: wcId } },
			{ kind: 'host', name: 'ping', args: [] },
		)) as { ok: false, error: { code?: string } }
		expect(after.ok).toBe(false)
		expect(after.error.code).toBe('DECK_UNTRUSTED_SENDER')

		await app.shutdown()
	})

	// D1 race regression — codex 四审：load-failed catch microtask 可能在 setup
	// callback 内 await 之后才能 register listener 之前就跑过 → listener 错过。
	// pending queue + 第一个 listener register 时 splice 消费应当兜住。
	it('load-failed pending payload is replayed to a listener registered AFTER an async setup boundary', async () => {
		const electron = createFakeElectron()
		let received: { source: WebviewSource, error: unknown } | null = null
		const app = new DeckApp(
			{
				toolbar: {
					source: { url: 'http://localhost:5173/late.html' },
					preloadPath: '/p',
					height: 48,
				},
				setup: async (rt) => {
					// host 先 await 一个真异步任务 — catch microtask 已经跑完
					await new Promise(r => setTimeout(r, 5))
					rt.on('load-failed', (p) => {
						received = p
					})
				},
			},
			{ electron, wireTransport: { ipcMain: createFakeIpcMain() } },
		)
		const origCtor = electron.WebContentsView
		Object.defineProperty(electron, 'WebContentsView', {
			value: class extends (origCtor as unknown as { new(opts?: { webPreferences?: { preload?: string } }): MinimalWebContentsView }) {
				constructor(opts?: { webPreferences?: { preload?: string } }) {
					super(opts)
					const wc = this.webContents as FakeWebContentsLike
					wc.loadURL = vi.fn(async () => {
						throw new Error('late-boom')
					}) as FakeWebContentsLike['loadURL']
				}
			},
			configurable: true,
		})
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		try {
			await app.start()
			await new Promise(r => setTimeout(r, 0))
			expect(received).not.toBeNull()
			const p = received as unknown as { source: WebviewSource, error: unknown }
			expect((p.error as Error).message).toBe('late-boom')
		}
		finally {
			errorSpy.mockRestore()
			await app.shutdown()
		}
	})
})

// ── Review fix #4 R4/C3 — runShutdownCleanup ordering ──────────────────────

describe('DeckApp — shutdown cleanup ordering (#4 R4/C3)', () => {
	it('window.destroy() is called BEFORE ipcMain.removeHandler() during shutdown', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp(
			{
				windows: {
					reauth: { source: { url: 'http://localhost:5173/reauth.html' } },
				},
			},
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()
		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow
		const reauthWin = electron.browserWindows[1] as unknown as FakeBrowserWindow
		await app.shutdown()

		const mainDestroyOrder = mainWin.destroy.mock.invocationCallOrder[0] ?? Infinity
		const reauthDestroyOrder = reauthWin.destroy.mock.invocationCallOrder[0] ?? Infinity
		const earliestDestroy = Math.min(mainDestroyOrder, reauthDestroyOrder)
		const removeOrders = ipcMain.removeHandler.mock.invocationCallOrder
		expect(removeOrders.length).toBeGreaterThan(0)
		const earliestRemove = Math.min(...removeOrders)
		expect(earliestDestroy).toBeLessThan(earliestRemove)
	})
})

// ── Review fix #5 C6 — start() wraps assemble/bind in try and cleans up on throw ──

describe('DeckApp — start() rolls back on assembly failure (#5 C6)', () => {
	it('BrowserWindow ctor throwing on the second (declared) window rejects start() and destroys mainWindow', async () => {
		const electron = createFakeElectron()
		// Patch BrowserWindow so the SECOND ctor throws
		let count = 0
		const origCtor = electron.BrowserWindow
		Object.defineProperty(electron, 'BrowserWindow', {
			value: class extends (origCtor as unknown as { new(opts?: MinimalBrowserWindowOptions): MinimalBrowserWindow }) {
				constructor(opts?: MinimalBrowserWindowOptions) {
					super(opts)
					count++
					if (count === 2) {
						throw new Error('ctor-boom')
					}
				}
			},
			configurable: true,
		})
		const app = new DeckApp(
			{
				windows: {
					reauth: { source: { url: 'http://localhost:5173/reauth.html' } },
				},
			},
			{ electron, wireTransport: { ipcMain: createFakeIpcMain() } },
		)
		await expect(app.start()).rejects.toThrow('ctor-boom')
		// mainWindow (first ctor) should have been destroyed by cleanup
		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow
		expect(mainWin.destroy).toHaveBeenCalled()
		expect(app.phase).not.toBe('ready')
	})
})

// ── Review fix #6 R3 — emitFrameworkEvent + window-created replay ───────────

describe('DeckApp — FrameworkEvents emission (#6 R3)', () => {
	it('setup() can subscribe to window-created and observe replay for mainWindow / toolbar / declared windows', async () => {
		const electron = createFakeElectron()
		const seen: Array<{ role: string; id: number }> = []
		const app = new DeckApp(
			{
				toolbar: {
					source: { url: 'http://localhost:5173/toolbar.html' },
					preloadPath: '/p',
					height: 40,
				},
				windows: {
					reauth: { source: { url: 'http://localhost:5173/reauth.html' } },
				},
				setup: (rt) => {
					rt.on('window-created', (p) => {
						const win = p.window as unknown as FakeBrowserWindow
						seen.push({ role: p.role, id: win.id })
					})
				},
			},
			{ electron, wireTransport: { ipcMain: createFakeIpcMain() } },
		)
		await app.start()
		// Should have main + toolbar + host(reauth)
		const roles = seen.map(s => s.role).sort()
		expect(roles).toContain('main')
		expect(roles).toContain('toolbar')
		expect(roles).toContain('host')
		await app.shutdown()
	})

	it('runtime.windows.create() emits window-created in real-time after setup', async () => {
		const electron = createFakeElectron()
		const events: Array<{ role: string; id: number }> = []
		const app = new DeckApp(
			{
				setup: (rt) => {
					rt.on('window-created', (p) => {
						events.push({ role: p.role, id: (p.window as unknown as FakeBrowserWindow).id })
					})
				},
			},
			{ electron },
		)
		await app.start()
		const before = events.length
		const created = app.runtime.windows.create({
			source: { url: 'http://localhost:5173/dyn.html' },
		}).window as unknown as FakeBrowserWindow
		expect(events.length).toBe(before + 1)
		const last = events[events.length - 1]
		expect(last?.role).toBe('host')
		expect(last?.id).toBe(created.id)
		await app.shutdown()
	})

	it('window-closed is emitted when a tracked window fires closed', async () => {
		const electron = createFakeElectron()
		const closed: number[] = []
		const app = new DeckApp(
			{
				windows: {
					reauth: { source: { url: 'http://localhost:5173/reauth.html' } },
				},
				setup: (rt) => {
					rt.on('window-closed', (p) => {
						closed.push((p.window as unknown as FakeBrowserWindow).id)
					})
				},
			},
			{ electron, wireTransport: { ipcMain: createFakeIpcMain() } },
		)
		await app.start()
		const reauthWin = electron.browserWindows[1] as unknown as FakeBrowserWindow
		reauthWin._emit('closed')
		await new Promise(r => setTimeout(r, 0))
		expect(closed).toContain(reauthWin.id)
		await app.shutdown()
	})
})

// ── Review fix #7 C5 — trust ref-count ──────────────────────────────────────

describe('DeckApp — trust ref-count (#7 C5)', () => {
	it('declared auto-trust + runtime.windows.trust() + dispose() → window remains trusted', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp(
			{
				windows: {
					reauth: { source: { url: 'http://localhost:5173/reauth.html' } },
				},
				hostServices: { ping: () => 'pong' as JsonValue },
			},
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()
		const reauthWin = electron.browserWindows[1] as unknown as FakeBrowserWindow
		// Already trusted via auto-trust
		const invoke = ipcMain.handlers.get(DeckChannel.Invoke)
		if (!invoke) throw new Error('invoke handler missing')

		// Take a second trust ref from runtime
		const d = app.runtime.windows.trust(reauthWin as unknown as Runtime['mainWindow'])
		const trustedRes = (await invoke(
			{ sender: { id: reauthWin.webContents.id } },
			{ kind: 'host', name: 'ping', args: [] },
		)) as { ok: true, result: JsonValue }
		expect(trustedRes.ok).toBe(true)

		// Dispose: ref-count goes from 2 → 1, NOT 0 → still trusted
		d.dispose()
		const afterRes = (await invoke(
			{ sender: { id: reauthWin.webContents.id } },
			{ kind: 'host', name: 'ping', args: [] },
		)) as { ok: true, result: JsonValue }
		expect(afterRes.ok).toBe(true)

		await app.shutdown()
	})
})

// ── Review fix #8 R7 — toolbar follows mainWindow resize ────────────────────

describe('DeckApp — toolbar resize tracking (#8 R7)', () => {
	it('mainWindow.on("resize") → toolbarView.setBounds updates with new content width', async () => {
		const initial = { x: 0, y: 0, width: 1024, height: 768 }
		const electron = createFakeElectron(initial)
		const app = new DeckApp(
			{
				toolbar: {
					source: { url: 'http://localhost:5173/toolbar.html' },
					preloadPath: '/p',
					height: 48,
				},
			},
			{ electron, wireTransport: { ipcMain: createFakeIpcMain() } },
		)
		await app.start()
		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow
		const view = electron.webContentsViews[0] as unknown as FakeWebContentsView
		const callsBefore = view.setBounds.mock.calls.length
		// Mutate the reported content bounds to simulate a real resize
		mainWin.getContentBounds = vi.fn(() => ({ x: 0, y: 0, width: 1600, height: 900 })) as FakeBrowserWindow['getContentBounds']
		mainWin._emit('resize')
		expect(view.setBounds.mock.calls.length).toBeGreaterThan(callsBefore)
		const lastCall = view.setBounds.mock.calls[view.setBounds.mock.calls.length - 1]
		const rect = lastCall?.[0] as MinimalRect
		expect(rect.width).toBe(1600)
		expect(rect.height).toBe(48)
		expect(rect.x).toBe(0)
		expect(rect.y).toBe(0)
		await app.shutdown()
	})
})

// ── Review fix #12 C7 — half-state config check ─────────────────────────────

describe('DeckApp — wireTransport required when toolbar/windows declared (#12 C7)', () => {
	it('electron + toolbar but no wireTransport → start() rejects with clear message', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp(
			{
				toolbar: {
					source: { url: 'http://localhost:5173/toolbar.html' },
					preloadPath: '/p',
					height: 48,
				},
			},
			{ electron },
		)
		await expect(app.start()).rejects.toThrow(/wireTransport\.ipcMain is required/)
	})

	it('electron + windows but no wireTransport → start() rejects with clear message', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp(
			{
				windows: {
					reauth: { source: { url: 'http://localhost:5173/reauth.html' } },
				},
			},
			{ electron },
		)
		await expect(app.start()).rejects.toThrow(/wireTransport\.ipcMain is required/)
	})

	it('electron only (no toolbar/windows) without wireTransport is permitted', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron })
		await expect(app.start()).resolves.toBeUndefined()
		await app.shutdown()
	})
})

// ── unified-lifetime P0: shadow map (observation-only, zero-regression) ──────
//
// FAILURE-FIRST (TDD): this block pins the P0 切口 of the unified-lifetime
// refactor (codex 定的真零回归 seam). The implementer will add, IN PARALLEL with
// the existing trackedWindows.add/delete points (main-window assembly, declared
// `config.windows`, runtime.windows.create, handleSubWindowClosed, doShutdown):
//
//   • `private rootScope = createScope()` (from ../main/scope.js)
//   • `private lifetimeShadow: Map<MinimalWebContents, { window, windowScope }>`
//     where `windowScope = rootScope.child()`
//
// P0 IS PURELY OBSERVATIONAL: the windowScopes own NO resources (no
// destroy/trust/wire is moved onto them), and the shutdown path is UNCHANGED —
// the shadow exists only to lay the foundation P1 will take over. The contract
// the implementer must honour, pinned below:
//
//   (A) the shadow's KEY SET (per-window webContents) === the membership of
//       `trackedWindows`, at every observable point;
//   (B) when a window's 'closed' clears it from trackedWindows
//       (handleSubWindowClosed), its windowScope is close()d (alive → false),
//       idempotently across a repeated 'closed';
//   (C) at doShutdown the windowScopes release in LIFO order (children-first,
//       reverse creation order) — matching the existing window-destroy order.
//
// Accessors the test agrees on (implementer may pick the internal shape; these
// are the names this suite calls — all referenced via the typed escape hatch
// below so a still-absent member fails at RUNTIME, not compile time):
//
//   • deck.__lifetimeShadow()  → the live Map<wc, { window, windowScope }>
//   • deck.__rootScope()       → the root Scope (alive while the app lives)
//   • deck.__assertLifetimeConsistent() → throws if (A) is violated; no-op else
//
// NOTE: these members do NOT exist yet, so each test here is RED until P0 lands.
// We reach them through a loose-typed view (NOT @ts-expect-error on every call —
// a single typed escape keeps the file compiling so the failures are RUNTIME
// red, per the brief) so the suite RUNS and reports assertion/throw failures.
describe('unified-lifetime P0: shadow map (observation-only, zero-regression)', () => {
	interface ShadowEntry {
		window: MinimalBrowserWindow
		windowScope: { readonly alive: boolean, on(ev: 'reset' | 'closed', cb: () => void): { dispose(): void } }
	}
	interface LifetimeView {
		__lifetimeShadow(): Map<MinimalWebContents, ShadowEntry>
		__rootScope(): { readonly alive: boolean }
		__assertLifetimeConsistent(): void
	}
	// Single typed escape hatch: surfaces the (not-yet-existent) P0 accessors so
	// the calls below compile; absence then fails at RUNTIME (TypeError), which is
	// exactly the RED we want for a TDD-first contract.
	function lifetime(app: DeckApp): LifetimeView {
		return app as unknown as LifetimeView
	}
	// The shadow is keyed by each window's webContents; this helper maps a fake
	// window → the key the implementer must have used.
	function wcKeyOf(win: FakeBrowserWindow): MinimalWebContents {
		return win.webContents as unknown as MinimalWebContents
	}
	// The set of fake-window ids currently present as shadow keys, for set-equality
	// assertions against trackedWindows (observed via runtime.windows.all()).
	function shadowWindowIds(app: DeckApp): number[] {
		const ids: number[] = []
		for (const entry of lifetime(app).__lifetimeShadow().values()) {
			ids.push((entry.window as unknown as FakeBrowserWindow).id)
		}
		return ids.sort((a, b) => a - b)
	}

	// 1 — main-window creation populates the shadow; key set == trackedWindows.
	it('after main window creation: shadow contains the main wc; key set === trackedWindows membership', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron })
		await app.start()

		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow
		const shadow = lifetime(app).__lifetimeShadow()
		// main wc is present as a key with the right window reference
		expect(shadow.has(wcKeyOf(mainWin))).toBe(true)
		expect(shadow.get(wcKeyOf(mainWin))?.window).toBe(mainWin)
		// (A) shadow key set === trackedWindows membership (observed via all()).
		const trackedIds = app.runtime.windows
			.all()
			.map(w => (w as unknown as FakeBrowserWindow).id)
			.sort((a, b) => a - b)
		expect(shadowWindowIds(app)).toEqual(trackedIds)
		// the consistency assertion must pass (no throw)
		expect(() => lifetime(app).__assertLifetimeConsistent()).not.toThrow()

		await app.shutdown()
	})

	// 2 — declared `config.windows` + runtime.windows.create() each add an entry,
	//     kept in lock-step with trackedWindows.
	it('declared and runtime.windows.create() windows each add a shadow entry in lock-step with trackedWindows', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp(
			{
				windows: {
					reauth: { source: { url: 'http://localhost:5173/reauth.html' } },
				},
			},
			{ electron, wireTransport: { ipcMain: createFakeIpcMain() } },
		)
		await app.start()

		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow
		const declaredWin = electron.browserWindows[1] as unknown as FakeBrowserWindow
		const shadow = lifetime(app).__lifetimeShadow()
		expect(shadow.has(wcKeyOf(mainWin))).toBe(true)
		expect(shadow.has(wcKeyOf(declaredWin))).toBe(true)

		// runtime.windows.create() must add another entry, lock-step with all().
		const beforeSize = lifetime(app).__lifetimeShadow().size
		const created = app.runtime.windows.create({
			source: { url: 'http://localhost:5173/dyn.html' },
		}).window as unknown as FakeBrowserWindow
		expect(lifetime(app).__lifetimeShadow().size).toBe(beforeSize + 1)
		expect(lifetime(app).__lifetimeShadow().has(wcKeyOf(created))).toBe(true)

		// (A) still holds across all three windows.
		const trackedIds = app.runtime.windows
			.all()
			.map(w => (w as unknown as FakeBrowserWindow).id)
			.sort((a, b) => a - b)
		expect(shadowWindowIds(app)).toEqual(trackedIds)
		expect(() => lifetime(app).__assertLifetimeConsistent()).not.toThrow()

		await app.shutdown()
	})

	// 3 — handleSubWindowClosed: shadow entry removed AND its windowScope closed.
	it('sub-window "closed" removes the shadow entry and closes its windowScope (alive → false)', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp(
			{
				windows: {
					reauth: { source: { url: 'http://localhost:5173/reauth.html' } },
				},
			},
			{ electron, wireTransport: { ipcMain: createFakeIpcMain() } },
		)
		await app.start()

		const reauthWin = electron.browserWindows[1] as unknown as FakeBrowserWindow
		const entry = lifetime(app).__lifetimeShadow().get(wcKeyOf(reauthWin))
		expect(entry).toBeDefined()
		const windowScope = entry!.windowScope
		expect(windowScope.alive).toBe(true)

		// Fire the real 'closed' path (→ handleSubWindowClosed).
		reauthWin._emit('closed')
		await new Promise(r => setTimeout(r, 0))

		// shadow entry gone, trackedWindows no longer lists it.
		expect(lifetime(app).__lifetimeShadow().has(wcKeyOf(reauthWin))).toBe(false)
		const stillTracked = app.runtime.windows
			.all()
			.some(w => (w as unknown as FakeBrowserWindow).id === reauthWin.id)
		expect(stillTracked).toBe(false)
		// (B) its windowScope was close()d.
		expect(windowScope.alive).toBe(false)
		// (A) still consistent after the removal.
		expect(() => lifetime(app).__assertLifetimeConsistent()).not.toThrow()

		await app.shutdown()
	})

	// 4 — repeated 'closed' on the same window is idempotent: no throw, no
	//     resurrected/stale shadow entry, scope stays closed.
	it('a duplicate "closed" on the same window is idempotent (no throw, no stale shadow entry)', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp(
			{
				windows: {
					reauth: { source: { url: 'http://localhost:5173/reauth.html' } },
				},
			},
			{ electron, wireTransport: { ipcMain: createFakeIpcMain() } },
		)
		await app.start()

		const reauthWin = electron.browserWindows[1] as unknown as FakeBrowserWindow
		const windowScope = lifetime(app).__lifetimeShadow().get(wcKeyOf(reauthWin))!.windowScope

		reauthWin._emit('closed')
		await new Promise(r => setTimeout(r, 0))
		// Second 'closed' for the same window must not throw nor leave residue.
		expect(() => reauthWin._emit('closed')).not.toThrow()
		await new Promise(r => setTimeout(r, 0))

		expect(lifetime(app).__lifetimeShadow().has(wcKeyOf(reauthWin))).toBe(false)
		expect(windowScope.alive).toBe(false)
		expect(() => lifetime(app).__assertLifetimeConsistent()).not.toThrow()

		await app.shutdown()
	})

	// 5 — consistency invariant verified pointwise across a sequence of ops:
	//     after create, after another create, after a close — the assertion
	//     holds at every step and the key set tracks all() each time.
	it('consistency invariant (shadow key set === trackedWindows) holds after each create/close op', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp(
			{
				windows: {
					reauth: { source: { url: 'http://localhost:5173/reauth.html' } },
				},
			},
			{ electron, wireTransport: { ipcMain: createFakeIpcMain() } },
		)
		await app.start()

		const assertConsistent = (): void => {
			expect(() => lifetime(app).__assertLifetimeConsistent()).not.toThrow()
			const trackedIds = app.runtime.windows
				.all()
				.map(w => (w as unknown as FakeBrowserWindow).id)
				.sort((a, b) => a - b)
			expect(shadowWindowIds(app)).toEqual(trackedIds)
		}

		assertConsistent() // after start (main + declared)

		app.runtime.windows.create({ source: { url: 'http://localhost:5173/a.html' } })
		assertConsistent() // after first runtime create

		const second = app.runtime.windows.create({
			source: { url: 'http://localhost:5173/b.html' },
		}).window as unknown as FakeBrowserWindow
		assertConsistent() // after second runtime create

		second._emit('closed')
		await new Promise(r => setTimeout(r, 0))
		assertConsistent() // after closing one

		await app.shutdown()
	})

	// 6 — doShutdown releases windowScopes in LIFO (children-first, reverse
	//     creation order). We record each windowScope's 'closed' firing order and
	//     assert it is the exact reverse of creation order — pinning the order so
	//     P1 can rely on it without re-deriving teardown sequencing.
	it('doShutdown releases windowScopes in LIFO (reverse creation) order', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp(
			{
				windows: {
					reauth: { source: { url: 'http://localhost:5173/reauth.html' } },
				},
			},
			{ electron, wireTransport: { ipcMain: createFakeIpcMain() } },
		)
		await app.start()

		// Creation order = main (0) → declared reauth (1) → two runtime windows.
		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow
		const reauthWin = electron.browserWindows[1] as unknown as FakeBrowserWindow
		const w3 = app.runtime.windows.create({
			source: { url: 'http://localhost:5173/w3.html' },
		}).window as unknown as FakeBrowserWindow
		const w4 = app.runtime.windows.create({
			source: { url: 'http://localhost:5173/w4.html' },
		}).window as unknown as FakeBrowserWindow

		const creationOrder = [mainWin.id, reauthWin.id, w3.id, w4.id]

		// Subscribe to each windowScope's 'closed' to capture release ordering.
		const closedOrder: number[] = []
		const shadow = lifetime(app).__lifetimeShadow()
		for (const win of [mainWin, reauthWin, w3, w4]) {
			const entry = shadow.get(wcKeyOf(win))
			expect(entry).toBeDefined()
			entry!.windowScope.on('closed', () => {
				closedOrder.push(win.id)
			})
		}

		await app.shutdown()
		// Allow any trailing scope-teardown microtasks to settle.
		await new Promise(r => setTimeout(r, 0))

		// LIFO === reverse creation order.
		expect(closedOrder).toEqual([...creationOrder].reverse())
		// rootScope itself must be dead after shutdown.
		expect(lifetime(app).__rootScope().alive).toBe(false)
	})

	// 7 — zero-regression guard: P0 must not change shutdown behaviour. With the
	//     shadow in place, the legacy window-destroy + phase=quit contract still
	//     holds exactly as the pre-P0 suite expects.
	it('zero-regression: shadow does not alter shutdown — windows still destroyed and phase reaches quit', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp(
			{
				windows: {
					reauth: { source: { url: 'http://localhost:5173/reauth.html' } },
				},
			},
			{ electron, wireTransport: { ipcMain: createFakeIpcMain() } },
		)
		await app.start()
		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow
		const reauthWin = electron.browserWindows[1] as unknown as FakeBrowserWindow

		await app.shutdown()

		expect(mainWin.destroy).toHaveBeenCalled()
		expect(reauthWin.destroy).toHaveBeenCalled()
		expect(app.phase).toBe('quit')
	})
})

// ── unified-lifetime P1a: windowScope owns window destruction ────────────────
//
// FAILURE-FIRST (TDD): pins the P1a 切口 — destruction AUTHORITY moves from the
// manual `for (win of trackedWindows) win.destroy()` loop in runShutdownCleanup
// ONTO the Scope tree built in P0. After P1a:
//
//   • each tracked window's windowScope (a child of rootScope, present in
//     __lifetimeShadow()) OWNS `() => { if (!win.isDestroyed()) win.destroy() }`;
//   • shutdown tears down by calling `rootScope.close()` — NOT the manual loop;
//   • children-first LIFO keeps window destroys ahead of resource disposal
//     (ipcMain.removeHandler) — same ordering the legacy loop guaranteed;
//   • TRUST handling is explicitly UNCHANGED in P1a.
//
// Each test below is RED today because windowScope does NOT yet own destroy and
// shutdown does NOT yet route through rootScope.close(). Reached through a single
// typed escape hatch (the P1a LifetimeView) so absence fails at RUNTIME, not
// compile time — the RED we want for a TDD-first contract.
describe('unified-lifetime P1a: windowScope owns window destruction', () => {
	// Scope shape P1a relies on: alive + close() (Promise) + on('closed') sub.
	interface P1aScope {
		readonly alive: boolean
		close(): Promise<void>
		on(ev: 'reset' | 'closed', cb: () => void): { dispose(): void }
	}
	interface P1aShadowEntry {
		window: MinimalBrowserWindow
		windowScope: P1aScope
	}
	interface P1aLifetimeView {
		__lifetimeShadow(): Map<MinimalWebContents, P1aShadowEntry>
		__rootScope(): P1aScope
	}
	// Single typed escape hatch (mirrors the P0 `lifetime()` pattern). The
	// not-yet-owned close()/alive semantics surface here so the calls compile;
	// they fail at RUNTIME until P1a lands.
	function lifetime(app: DeckApp): P1aLifetimeView {
		return app as unknown as P1aLifetimeView
	}
	function wcKeyOf(win: FakeBrowserWindow): MinimalWebContents {
		return win.webContents as unknown as MinimalWebContents
	}

	// 1 — windowScope owns its window's destroy: calling windowScope.close()
	//     DIRECTLY destroys exactly that window (once) and the scope goes dead.
	it('windowScope.close() destroys its window exactly once and marks the scope dead', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp(
			{
				windows: {
					reauth: { source: { url: 'http://localhost:5173/reauth.html' } },
				},
			},
			{ electron, wireTransport: { ipcMain: createFakeIpcMain() } },
		)
		await app.start()

		const declaredWin = electron.browserWindows[1] as unknown as FakeBrowserWindow
		const entry = lifetime(app).__lifetimeShadow().get(wcKeyOf(declaredWin))
		expect(entry).toBeDefined()
		const windowScope = entry!.windowScope
		expect(windowScope.alive).toBe(true)

		// Closing the scope DIRECTLY (not via shutdown) destroys the owned window.
		await windowScope.close()
		expect(declaredWin.destroy).toHaveBeenCalledTimes(1)
		expect(windowScope.alive).toBe(false)

		// Parallel assertion: the main window's destroy authority is ITS windowScope.
		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow
		const mainScope = lifetime(app).__lifetimeShadow().get(wcKeyOf(mainWin))!.windowScope
		expect(mainScope.alive).toBe(true)
		await mainScope.close()
		expect(mainWin.destroy).toHaveBeenCalledTimes(1)
		expect(mainScope.alive).toBe(false)

		await app.shutdown()
	})

	// 2 — rootScope.close() is the destruction driver: after shutdown the root is
	//     dead, every tracked window destroyed, and every windowScope dead.
	it('shutdown drives destruction through rootScope.close(): root dead, all windows destroyed, all windowScopes dead', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp(
			{
				windows: {
					reauth: { source: { url: 'http://localhost:5173/reauth.html' } },
				},
			},
			{ electron, wireTransport: { ipcMain: createFakeIpcMain() } },
		)
		await app.start()

		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow
		const declaredWin = electron.browserWindows[1] as unknown as FakeBrowserWindow
		const created = app.runtime.windows.create({
			source: { url: 'http://localhost:5173/dyn.html' },
		}).window as unknown as FakeBrowserWindow
		const trackedWins = [mainWin, declaredWin, created]

		// Capture every windowScope BEFORE shutdown (shadow is cleared by teardown).
		const scopes = trackedWins.map(
			win => lifetime(app).__lifetimeShadow().get(wcKeyOf(win))!.windowScope,
		)
		expect(lifetime(app).__rootScope().alive).toBe(true)

		await app.shutdown()

		expect(lifetime(app).__rootScope().alive).toBe(false)
		for (const win of trackedWins) {
			expect(win.destroy).toHaveBeenCalled()
		}
		for (const scope of scopes) {
			expect(scope.alive).toBe(false)
		}
	})

	// 3 — ordering: window destroys land BEFORE registry teardown
	//     (ipcMain.removeHandler). Same spirit as the #4 R4/C3 test, but framed
	//     as the Scope-driven (children-first LIFO) guarantee.
	it('Scope-driven LIFO: earliest window.destroy precedes earliest ipcMain.removeHandler', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp(
			{
				windows: {
					reauth: { source: { url: 'http://localhost:5173/reauth.html' } },
				},
			},
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()

		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow
		const declaredWin = electron.browserWindows[1] as unknown as FakeBrowserWindow

		await app.shutdown()

		const mainDestroyOrder = mainWin.destroy.mock.invocationCallOrder[0] ?? Infinity
		const declaredDestroyOrder = declaredWin.destroy.mock.invocationCallOrder[0] ?? Infinity
		const earliestDestroy = Math.min(mainDestroyOrder, declaredDestroyOrder)
		const removeOrders = ipcMain.removeHandler.mock.invocationCallOrder
		expect(removeOrders.length).toBeGreaterThan(0)
		const earliestRemove = Math.min(...removeOrders)
		expect(earliestDestroy).toBeLessThan(earliestRemove)
	})

	// 4 — idempotent / no double-destroy: an already-destroyed window is NOT
	//     re-destroyed by its owned disposer (the `if (!win.isDestroyed())` guard).
	it('owned disposer does not re-destroy a window already destroyed before shutdown', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp(
			{
				windows: {
					reauth: { source: { url: 'http://localhost:5173/reauth.html' } },
				},
			},
			{ electron, wireTransport: { ipcMain: createFakeIpcMain() } },
		)
		await app.start()

		const declaredWin = electron.browserWindows[1] as unknown as FakeBrowserWindow
		// Mark already destroyed BEFORE shutdown — the guard must skip destroy().
		declaredWin.destroyed = true

		await app.shutdown()

		expect(declaredWin.destroy).not.toHaveBeenCalled()
	})

	// 5 — zero-regression: the loop→rootScope.close() swap keeps the full shutdown
	//     contract — both windows destroyed, phase=quit, both ipc channels removed.
	it('zero-regression: both windows destroyed, phase=quit, both ipc channels removed', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp(
			{
				windows: {
					reauth: { source: { url: 'http://localhost:5173/reauth.html' } },
				},
			},
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()

		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow
		const declaredWin = electron.browserWindows[1] as unknown as FakeBrowserWindow

		await app.shutdown()

		expect(mainWin.destroy).toHaveBeenCalled()
		expect(declaredWin.destroy).toHaveBeenCalled()
		expect(app.phase).toBe('quit')
		// P5 eager-arm: channels now armed at start (Invoke + Probe + Place +
		// LayoutSubscribe), so quit removes all 4.
		expect(ipcMain.removeHandler).toHaveBeenCalledTimes(4)
	})

	// 6 — trust UNCHANGED (P1a out-of-scope guard): a declared sub-window is
	//     trusted while alive and untrusted after its 'closed'. P1a must NOT touch
	//     this. Reuses the D3 invoke pattern.
	it('trust unchanged: declared window trusted while alive, untrusted after "closed"', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp(
			{
				windows: {
					reauth: { source: { url: 'http://localhost:5173/reauth.html' } },
				},
				hostServices: { ping: () => 'pong' as JsonValue },
			},
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()

		const declaredWin = electron.browserWindows[1] as unknown as FakeBrowserWindow
		const wcId = declaredWin.webContents.id
		const invoke = ipcMain.handlers.get(DeckChannel.Invoke)
		if (!invoke) throw new Error('invoke handler missing')

		// trusted while alive
		const before = (await invoke(
			{ sender: { id: wcId } },
			{ kind: 'host', name: 'ping', args: [] },
		)) as { ok: true, result: JsonValue }
		expect(before.ok).toBe(true)
		expect(before.result).toBe('pong')

		// fire 'closed' → trust must be revoked (unchanged from pre-P1a behaviour)
		declaredWin._emit('closed')
		await new Promise(r => setTimeout(r, 0))

		const after = (await invoke(
			{ sender: { id: wcId } },
			{ kind: 'host', name: 'ping', args: [] },
		)) as { ok: false, error: { code?: string } }
		expect(after.ok).toBe(false)
		expect(after.error.code).toBe('DECK_UNTRUSTED_SENDER')

		await app.shutdown()
	})
})

// ── unified-lifetime P1b: wcScope owns trust leases ──────────────────────────
//
// FAILURE-FIRST (TDD): pins the P1b 切口 — a trusted webContents's TRUST becomes
// a Scope-owned lease instead of an imperative trustSet.deleteEntry(wc) call in
// the window's 'closed' handler. After P1b:
//
//   • each trusted wc gets a `wcScope` = its window's windowScope.child() (which
//     is itself a child of rootScope, both established in P0);
//   • the trust ref-count Disposable is wcScope.own(...)-ed — so trust is revoked
//     by Scope teardown: window close → windowScope.close() cascades into the
//     wcScope → leases dispose → ref-count hits 0 → wc leaves the trust set;
//   • the framework's OWN auto-trust lease is ALSO owned by the wcScope, so the
//     cascade zeroes it (no leaked forever-ref);
//   • the imperative deleteEntry is removed — trust revocation is now a pure
//     Scope-teardown effect.
//
// The NEW accessor `__wcRecords()` (Map<wc, { wcScope, leases }>) is RUNTIME-
// absent until P1b lands → that's the RED. Trust is asserted ONLY via the real
// ipcMain invoke round-trip (trusted → ok, untrusted → DECK_UNTRUSTED_SENDER) —
// never against trustSet internals. Reached through a single typed escape hatch
// (mirrors the P0/P1a `lifetime()` pattern) so absence fails at RUNTIME.
describe('unified-lifetime P1b: wcScope owns trust leases', () => {
	// Scope shape P1b relies on: alive + close() (Promise).
	interface P1bScope {
		readonly alive: boolean
		close(): Promise<void>
	}
	interface P1bWindowScope {
		readonly alive: boolean
		close(): Promise<void>
	}
	interface P1bShadowEntry {
		window: MinimalBrowserWindow
		windowScope: P1bWindowScope
	}
	interface P1bWcRecord {
		wcScope: P1bScope
		leases: Set<unknown>
	}
	interface P1bLifetimeView {
		__lifetimeShadow(): Map<MinimalWebContents, P1bShadowEntry>
		__rootScope(): P1bScope
		// NEW in P1b — RUNTIME-absent until implemented (the RED).
		__wcRecords(): Map<MinimalWebContents, P1bWcRecord>
	}
	// Single typed escape hatch: surfaces the (not-yet-existent) __wcRecords()
	// accessor so the calls compile; absence then fails at RUNTIME (TypeError),
	// exactly the RED we want for a TDD-first contract.
	function lifetime(app: DeckApp): P1bLifetimeView {
		return app as unknown as P1bLifetimeView
	}
	function wcKeyOf(win: FakeBrowserWindow): MinimalWebContents {
		return win.webContents as unknown as MinimalWebContents
	}

	// invoke round-trip helpers — the ONLY way this suite observes trust.
	async function isTrusted(
		invoke: InvokeHandler,
		wcId: number,
	): Promise<boolean> {
		const res = (await invoke(
			{ sender: { id: wcId } },
			{ kind: 'host', name: 'ping', args: [] },
		)) as { ok: boolean }
		return res.ok === true
	}

	// 1 — a trusted wc has a wcScope that is a child of its windowScope.
	it('trusted wc has a live wcScope; main + declared windows each have a wcRecord (observably trusted)', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp(
			{
				windows: {
					reauth: { source: { url: 'http://localhost:5173/reauth.html' } },
				},
				hostServices: { ping: () => 'pong' as JsonValue },
			},
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()

		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow
		const declaredWin = electron.browserWindows[1] as unknown as FakeBrowserWindow
		const invoke = ipcMain.handlers.get(DeckChannel.Invoke)
		if (!invoke) throw new Error('invoke handler missing')

		// (NEW) declared (auto-trusted) window has a wcRecord with a live wcScope.
		const records = lifetime(app).__wcRecords()
		const declaredRec = records.get(wcKeyOf(declaredWin))
		expect(declaredRec).toBeDefined()
		expect(declaredRec!.wcScope.alive).toBe(true)
		// observable: it is trusted via invoke.
		expect(await isTrusted(invoke, declaredWin.webContents.id)).toBe(true)

		// the main window's wc also has a wcRecord (it is auto-trusted too).
		const mainRec = lifetime(app).__wcRecords().get(wcKeyOf(mainWin))
		expect(mainRec).toBeDefined()
		expect(mainRec!.wcScope.alive).toBe(true)
		expect(await isTrusted(invoke, mainWin.webContents.id)).toBe(true)

		await app.shutdown()
	})

	// 2 — window close revokes trust via the windowScope → wcScope cascade
	//     (no imperative deleteEntry). Same wc.id is untrusted, record gone,
	//     wcScope dead.
	it('window "closed" revokes trust via Scope cascade: untrusted, wcRecord gone, wcScope dead', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp(
			{
				windows: {
					reauth: { source: { url: 'http://localhost:5173/reauth.html' } },
				},
				hostServices: { ping: () => 'pong' as JsonValue },
			},
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()

		const reauthWin = electron.browserWindows[1] as unknown as FakeBrowserWindow
		const wcId = reauthWin.webContents.id
		const invoke = ipcMain.handlers.get(DeckChannel.Invoke)
		if (!invoke) throw new Error('invoke handler missing')

		// trusted while alive
		expect(await isTrusted(invoke, wcId)).toBe(true)
		const wcScope = lifetime(app).__wcRecords().get(wcKeyOf(reauthWin))!.wcScope
		expect(wcScope.alive).toBe(true)

		reauthWin._emit('closed')
		await new Promise(r => setTimeout(r, 0))

		// the cascade revoked trust
		expect(await isTrusted(invoke, wcId)).toBe(false)
		// the wcRecord is gone and its wcScope is dead
		expect(lifetime(app).__wcRecords().has(wcKeyOf(reauthWin))).toBe(false)
		expect(wcScope.alive).toBe(false)

		await app.shutdown()
	})

	// 3 — closing the windowScope DIRECTLY revokes trust (isolates the
	//     wcScope-drives-trust contract, bypassing the Electron 'closed' event).
	it('closing the windowScope directly revokes trust (Scope-teardown effect, not tied to "closed")', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp(
			{
				windows: {
					reauth: { source: { url: 'http://localhost:5173/reauth.html' } },
				},
				hostServices: { ping: () => 'pong' as JsonValue },
			},
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()

		const reauthWin = electron.browserWindows[1] as unknown as FakeBrowserWindow
		const wcId = reauthWin.webContents.id
		const invoke = ipcMain.handlers.get(DeckChannel.Invoke)
		if (!invoke) throw new Error('invoke handler missing')

		expect(await isTrusted(invoke, wcId)).toBe(true)

		// Drive trust revocation purely via the Scope tree — NOT the 'closed' event.
		const windowScope = lifetime(app).__lifetimeShadow().get(wcKeyOf(reauthWin))!.windowScope
		await windowScope.close()

		expect(await isTrusted(invoke, wcId)).toBe(false)

		await app.shutdown()
	})

	// 4 — ref-count preserved across the framework auto-trust lease: declared
	//     (auto, ref 1) + windows.trust() (ref 2); dispose the 2nd → STILL
	//     trusted; THEN window close cascades → zeroes the framework lease too.
	it('auto-trust + windows.trust + host dispose → still trusted; then "closed" → untrusted', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp(
			{
				windows: {
					reauth: { source: { url: 'http://localhost:5173/reauth.html' } },
				},
				hostServices: { ping: () => 'pong' as JsonValue },
			},
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()

		const reauthWin = electron.browserWindows[1] as unknown as FakeBrowserWindow
		const wcId = reauthWin.webContents.id
		const invoke = ipcMain.handlers.get(DeckChannel.Invoke)
		if (!invoke) throw new Error('invoke handler missing')

		// auto-trusted (ref 1)
		expect(await isTrusted(invoke, wcId)).toBe(true)

		// host takes a 2nd ref
		const d = app.runtime.windows.trust(reauthWin as unknown as Runtime['mainWindow'])
		expect(await isTrusted(invoke, wcId)).toBe(true)

		// dispose the 2nd ref → 2 → 1, STILL trusted (auto-trust lease survives)
		d.dispose()
		expect(await isTrusted(invoke, wcId)).toBe(true)

		// window close → cascade zeroes the framework's auto-trust lease too
		reauthWin._emit('closed')
		await new Promise(r => setTimeout(r, 0))
		expect(await isTrusted(invoke, wcId)).toBe(false)

		await app.shutdown()
	})

	// 5 — autoTrust:false window + host windows.trust() → trusted, wcRecord
	//     created; window close revokes it (host-driven trust still lands under
	//     the window's windowScope).
	it('autoTrust:false + host windows.trust → trusted with a wcRecord; "closed" revokes + removes record', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp(
			{ hostServices: { ping: () => 'pong' as JsonValue } },
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()

		const win = app.runtime.windows.create({
			source: { url: 'http://localhost:5173/nt.html' },
			autoTrust: false,
		}).window as unknown as FakeBrowserWindow
		const wcId = win.webContents.id
		const invoke = ipcMain.handlers.get(DeckChannel.Invoke)
		if (!invoke) throw new Error('invoke handler missing')

		// untrusted before host trusts it; no wcRecord yet.
		expect(await isTrusted(invoke, wcId)).toBe(false)
		expect(lifetime(app).__wcRecords().has(wcKeyOf(win))).toBe(false)

		// host trusts → trusted AND a wcRecord now exists.
		app.runtime.windows.trust(win as unknown as Runtime['mainWindow'])
		expect(await isTrusted(invoke, wcId)).toBe(true)
		expect(lifetime(app).__wcRecords().has(wcKeyOf(win))).toBe(true)

		// window close → revoked + record gone (host trust still landed under the
		// window's windowScope, so the cascade reaps it).
		win._emit('closed')
		await new Promise(r => setTimeout(r, 0))
		expect(await isTrusted(invoke, wcId)).toBe(false)
		expect(lifetime(app).__wcRecords().has(wcKeyOf(win))).toBe(false)

		await app.shutdown()
	})

	// 6 — shutdown revokes all trust. After shutdown the ipc invoke handler is
	//     removed (removeHandler fires during shutdown), so trust is not directly
	//     observable; pin the post-shutdown-observable form instead: no wcRecord
	//     survives + rootScope is dead.
	it('shutdown revokes all trust: no wcRecord survives and rootScope is dead', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp(
			{
				windows: {
					reauth: { source: { url: 'http://localhost:5173/reauth.html' } },
				},
				hostServices: { ping: () => 'pong' as JsonValue },
			},
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()

		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow
		const declaredWin = electron.browserWindows[1] as unknown as FakeBrowserWindow
		const invoke = ipcMain.handlers.get(DeckChannel.Invoke)
		if (!invoke) throw new Error('invoke handler missing')

		// both trusted while alive
		expect(await isTrusted(invoke, mainWin.webContents.id)).toBe(true)
		expect(await isTrusted(invoke, declaredWin.webContents.id)).toBe(true)
		// both have wcRecords
		expect(lifetime(app).__wcRecords().has(wcKeyOf(mainWin))).toBe(true)
		expect(lifetime(app).__wcRecords().has(wcKeyOf(declaredWin))).toBe(true)

		await app.shutdown()

		// every previously-trusted wcRecord is gone; rootScope is dead.
		expect(lifetime(app).__wcRecords().size).toBe(0)
		expect(lifetime(app).__rootScope().alive).toBe(false)

		await new Promise(r => setTimeout(r, 0))
	})

	// 7 — zero-regression guard for the WHOLE POINT of P1b: (a) the #7 C5 contract
	//     (dispose one of two refs keeps trusted) still holds; (b) an auto-trusted
	//     window with NO host ref is revoked PURELY by close — proving the
	//     framework-held auto-trust ref is owned by the wcScope, not leaked forever.
	it('zero-regression: dispose-one-of-two keeps trusted; auto-trust-only window revoked purely by close', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp(
			{
				windows: {
					reauth: { source: { url: 'http://localhost:5173/reauth.html' } },
				},
				hostServices: { ping: () => 'pong' as JsonValue },
			},
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()

		const reauthWin = electron.browserWindows[1] as unknown as FakeBrowserWindow
		const wcId = reauthWin.webContents.id
		const invoke = ipcMain.handlers.get(DeckChannel.Invoke)
		if (!invoke) throw new Error('invoke handler missing')

		// (a) #7 C5: 2nd ref taken then disposed → still trusted (ref-count 2→1).
		const d = app.runtime.windows.trust(reauthWin as unknown as Runtime['mainWindow'])
		expect(await isTrusted(invoke, wcId)).toBe(true)
		d.dispose()
		expect(await isTrusted(invoke, wcId)).toBe(true)

		// (b) NO outstanding host ref now (auto-trust only) → close alone revokes,
		//     which can ONLY happen if the auto-trust ref is owned by the wcScope.
		reauthWin._emit('closed')
		await new Promise(r => setTimeout(r, 0))
		expect(await isTrusted(invoke, wcId)).toBe(false)

		await app.shutdown()
	})
})
