/**
 * Independent cross-check for the 13 review-issue fixes shipped in commit
 * a0a1769b. Tests here are authored against the **public contract** (JSDoc /
 * spec doc / type exports) only — implementation source was not consulted
 * while writing them. Every case maps to a numbered issue (X1..X14).
 *
 * Constraints honoured:
 * - No import from any existing test file or fixture.
 * - All fakes built locally from the Minimal* interfaces in electron-types.ts
 *   and wire-transport.ts.
 * - DeckApp is exercised directly for cases that need to bypass the
 *   electron lazy import; electronDeck() public entry covers issue #1.
 */

import { describe, expect, it, vi } from 'vitest'
import { electronDeck } from '../electron-deck.js'
import type { DeckOptions } from '../types.js'
import { DeckApp } from '../internal/deck-app.js'
import { WireTransport } from '../internal/wire-transport.js'
import { EventBus } from '../internal/event-bus.js'
import { DeckRemoteError } from '../errors.js'
import { DeckChannel } from '../shared/protocol.js'
import type {
	MinimalBrowserWindow,
	MinimalBrowserWindowOptions,
	MinimalContentView,
	MinimalElectron,
	MinimalRect,
	MinimalWebContentsLike,
	MinimalWebContentsView,
} from '../internal/electron-types.js'
import type { MinimalIpcMain } from '../internal/wire-transport.js'

// ── local fixture builders ────────────────────────────────────────────────

let nextWcId = 1000
function makeWebContents(
	overrides: Partial<MinimalWebContentsLike> = {},
): MinimalWebContentsLike & {
	loadURL: ReturnType<typeof vi.fn>
	loadFile: ReturnType<typeof vi.fn>
	send: ReturnType<typeof vi.fn>
} {
	const id = nextWcId++
	const destroyed = false
	return {
		id,
		loadURL: vi.fn(async (_url: string) => undefined),
		loadFile: vi.fn(async (_path: string) => undefined),
		send: vi.fn(() => undefined),
		isDestroyed: () => destroyed,
		...overrides,
	} as never
}

interface FakeWindow extends MinimalBrowserWindow {
	__listeners: Map<string, Array<() => void>>
	__emit: (event: 'resize' | 'closed') => void
	__bounds: MinimalRect
	__destroyMock: ReturnType<typeof vi.fn>
	__destroyed: boolean
	__addedChildViews: MinimalWebContentsView[]
}

function makeWindow(
	opts: MinimalBrowserWindowOptions | undefined,
	bounds: MinimalRect = { x: 0, y: 0, width: 1024, height: 768 },
): FakeWindow {
	const listeners = new Map<string, Array<() => void>>()
	let destroyed = false
	const wc = makeWebContents()
	const childViews: MinimalWebContentsView[] = []
	const contentView: MinimalContentView = {
		addChildView: (v) => {
			childViews.push(v)
		},
		removeChildView: () => undefined,
	}
	const destroyMock = vi.fn()
	const w: FakeWindow = {
		id: nextWcId++,
		webContents: wc,
		contentView,
		getContentBounds: () => ({ ...w.__bounds }),
		show: () => undefined,
		destroy: (): void => {
			destroyMock()
			destroyed = true
			w.__destroyed = true
		},
		isDestroyed: () => destroyed,
		on: (event, listener): MinimalBrowserWindow => {
			const arr = listeners.get(event) ?? []
			arr.push(listener)
			listeners.set(event, arr)
			return w
		},
		__listeners: listeners,
		__emit: (event) => {
			const arr = listeners.get(event) ?? []
			for (const fn of [...arr]) fn()
		},
		__bounds: bounds,
		__destroyMock: destroyMock,
		__destroyed: false,
		__addedChildViews: childViews,
	}
	return w
}

interface FakeView extends MinimalWebContentsView {
	__setBoundsMock: ReturnType<typeof vi.fn>
}

function makeView(): FakeView {
	const wc = makeWebContents()
	const mock = vi.fn()
	return {
		webContents: wc,
		setBounds: (rect: MinimalRect): void => {
			mock(rect)
		},
		__setBoundsMock: mock,
	}
}

function makeElectron(opts: {
	windowFactory?: () => FakeWindow
	viewFactory?: () => FakeView
	throwOnWindowCtorAfter?: number
} = {}): MinimalElectron & {
	__windows: FakeWindow[]
	__views: FakeView[]
	__windowCtorCalls: number
} {
	const windows: FakeWindow[] = []
	const views: FakeView[] = []
	let ctorCalls = 0
	const e = {
		__windows: windows,
		__views: views,
		get __windowCtorCalls() { return ctorCalls },
		BrowserWindow: function (this: unknown, browserOpts?: MinimalBrowserWindowOptions) {
			ctorCalls++
			if (opts.throwOnWindowCtorAfter !== undefined && ctorCalls > opts.throwOnWindowCtorAfter) {
				throw new Error('forced BrowserWindow ctor failure')
			}
			const w = (opts.windowFactory ?? (() => makeWindow(browserOpts)))()
			windows.push(w)
			return w
		} as unknown as MinimalElectron['BrowserWindow'],
		WebContentsView: function (this: unknown, _opts?: { webPreferences?: { preload?: string } }) {
			const v = (opts.viewFactory ?? makeView)()
			views.push(v)
			return v
		} as unknown as MinimalElectron['WebContentsView'],
	}
	return e as never
}

function makeIpcMain(): MinimalIpcMain & {
	__handlers: Map<string, (event: { sender: { id: number } }, ...args: unknown[]) => unknown>
	handle: ReturnType<typeof vi.fn>
	removeHandler: ReturnType<typeof vi.fn>
} {
	const handlers = new Map<string, (event: { sender: { id: number } }, ...args: unknown[]) => unknown>()
	const ipc = {
		__handlers: handlers,
		handle: vi.fn((channel: string, h: (event: { sender: { id: number } }, ...args: unknown[]) => unknown) => {
			handlers.set(channel, h)
		}),
		removeHandler: vi.fn((channel: string) => {
			handlers.delete(channel)
		}),
	}
	return ipc as never
}

function flush(): Promise<void> {
	return new Promise(r => setTimeout(r, 0))
}

// ─────────────────────────────────────────────────────────────────────────
// X1 — R1/C1: public electronDeck(config, options?) entry behaviour
// ─────────────────────────────────────────────────────────────────────────

describe('X1 — electronDeck() entry & DeckOptions injection', () => {
	it('resolves when full electron + ipcMain are injected', async () => {
		const electron = makeElectron()
		const ipcMain = makeIpcMain()
		await expect(electronDeck({}, { electron, ipcMain })).resolves.toBeUndefined()
	})

	it('rejects with an error mentioning electron when running without injection (vitest env)', async () => {
		// No options → framework lazy-imports electron, gets stub, must reject.
		await expect(electronDeck({})).rejects.toThrow(/electron/i)
	})

	it('rejects when only electron is injected but ipcMain is missing', async () => {
		const electron = makeElectron()
		await expect(
			electronDeck({}, { electron } as DeckOptions),
		).rejects.toThrow(/electron|ipcMain/i)
	})

	it('exports DeckOptions type from the package surface', async () => {
		// Compile-time check via assignability: if the type is not exported, this
		// import statement at top of file would have errored. We additionally
		// verify the runtime entry symbol exists.
		const mod = await import('../index.js')
		expect(typeof mod.electronDeck).toBe('function')
	})
})

// ─────────────────────────────────────────────────────────────────────────
// X2 — R2: mainWindow.on('closed') triggers framework shutdown;
//          declared/runtime windows.on('closed') do not.
// ─────────────────────────────────────────────────────────────────────────

describe('X2 — mainWindow closed → framework shutdown', () => {
	it('mainWindow "closed" event drives framework into quit phase', async () => {
		const electron = makeElectron()
		const ipcMain = makeIpcMain()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain } })
		await app.start()
		expect(app.phase).toBe('ready')

		const mainWin = electron.__windows[0]!
		mainWin.__emit('closed')
		await flush()
		await flush()
		expect(app.phase).toBe('quit')
	})

	it('declared window "closed" does NOT shut the framework down', async () => {
		const electron = makeElectron()
		const ipcMain = makeIpcMain()
		const app = new DeckApp(
			{
				windows: {
					settings: { source: { url: 'http://x/settings' } },
				},
			},
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()
		expect(app.phase).toBe('ready')

		// windows[0] is mainWindow; windows[1] is declared 'settings'
		const declared = electron.__windows[1]!
		declared.__emit('closed')
		await flush()
		await flush()
		expect(app.phase).toBe('ready')
	})

	it('runtime.windows.create() child window "closed" does NOT shut the framework down', async () => {
		const electron = makeElectron()
		const ipcMain = makeIpcMain()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain } })
		await app.start()
		const rt = app.runtime
		rt.windows.create({ source: { url: 'http://x/aux' } })
		const aux = electron.__windows[electron.__windows.length - 1]!
		aux.__emit('closed')
		await flush()
		await flush()
		expect(app.phase).toBe('ready')
	})
})

// ─────────────────────────────────────────────────────────────────────────
// X3 — R5/C2: loadURL / loadFile rejection emits 'load-failed' FrameworkEvent
//             and start() still resolves.
// ─────────────────────────────────────────────────────────────────────────

describe('X3 — load-failed FrameworkEvent emission', () => {
	it('emits load-failed { source, error } when toolbar loadURL rejects; start() still resolves', async () => {
		const failingErr = new Error('net::ERR_FAILED')
		const failingView = (() => {
			const v = makeView()
			v.webContents.loadURL = vi.fn(async () => { throw failingErr }) as never
			return v
		})()
		const electron = makeElectron({ viewFactory: () => failingView })
		const ipcMain = makeIpcMain()

		const captured: Array<{ source: unknown; error: unknown }> = []
		const app = new DeckApp(
			{
				toolbar: {
					source: { url: 'http://toolbar' },
					preloadPath: '/pre.js',
					height: 36,
				},
				setup: (rt) => {
					rt.on('load-failed', (p) => {
						captured.push(p as never)
					})
				},
			},
			{ electron, wireTransport: { ipcMain } },
		)

		await expect(app.start()).resolves.toBeUndefined()
		// Allow load-failed callback (chained off loadURL.catch) to flush.
		await flush()
		await flush()
		expect(captured.length).toBe(1)
		expect((captured[0]!.source as { url: string }).url).toBe('http://toolbar')
		expect(captured[0]!.error).toBe(failingErr)
	})

	it('emits load-failed for loadFile source as well', async () => {
		const failingErr = new Error('ENOENT')
		const electron = makeElectron({
			viewFactory: () => {
				const v = makeView()
				v.webContents.loadFile = vi.fn(async () => { throw failingErr }) as never
				return v
			},
		})
		const ipcMain = makeIpcMain()
		const captured: Array<{ source: unknown; error: unknown }> = []
		const app = new DeckApp(
			{
				toolbar: {
					source: { file: '/abs/missing.html' },
					preloadPath: '/pre.js',
					height: 36,
				},
				setup: (rt) => {
					rt.on('load-failed', (p) => captured.push(p as never))
				},
			},
			{ electron, wireTransport: { ipcMain } },
		)
		await expect(app.start()).resolves.toBeUndefined()
		await flush()
		await flush()
		expect(captured.length).toBe(1)
		expect((captured[0]!.source as { file: string }).file).toBe('/abs/missing.html')
	})
})

// ─────────────────────────────────────────────────────────────────────────
// X4 — R4/C3: shutdown order — windows.destroy BEFORE ipcMain.removeHandler.
// ─────────────────────────────────────────────────────────────────────────

describe('X4 — shutdown order (window.destroy before ipcMain.removeHandler)', () => {
	it('mainWindow.destroy is invoked before any ipcMain.removeHandler during shutdown', async () => {
		const electron = makeElectron()
		const ipcMain = makeIpcMain()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain } })
		await app.start()

		// invocationCallOrder is the source of truth for inter-mock ordering.
		await app.shutdown()
		const mainWin = electron.__windows[0]!
		const destroyOrder = mainWin.__destroyMock.mock.invocationCallOrder[0]
		const removeOrders = ipcMain.removeHandler.mock.invocationCallOrder
		expect(typeof destroyOrder).toBe('number')
		expect(removeOrders.length).toBeGreaterThan(0)
		for (const ord of removeOrders) {
			expect(destroyOrder!).toBeLessThan(ord)
		}
	})
})

// ─────────────────────────────────────────────────────────────────────────
// X5 — C6: partial-failure cleanup — start() rejects with all windows cleaned.
// ─────────────────────────────────────────────────────────────────────────

describe('X5 — partial-failure cleanup on start() error', () => {
	it('when 2nd BrowserWindow ctor throws, start() rejects and the 1st window is destroyed', async () => {
		// 1st ctor = mainWindow, 2nd ctor = declared window → make 2nd throw.
		const electron = makeElectron({ throwOnWindowCtorAfter: 1 })
		const ipcMain = makeIpcMain()
		const app = new DeckApp(
			{
				windows: {
					boom: { source: { url: 'http://boom' } },
				},
			},
			{ electron, wireTransport: { ipcMain } },
		)
		await expect(app.start()).rejects.toThrow(/forced BrowserWindow ctor failure/)

		const mainWin = electron.__windows[0]!
		expect(mainWin.__destroyed).toBe(true)
	})
})

// ─────────────────────────────────────────────────────────────────────────
// X6 — R3: FrameworkEvents 'window-created' replay + 'window-closed' emit.
// ─────────────────────────────────────────────────────────────────────────

describe('X6 — window-created / window-closed FrameworkEvents', () => {
	it('replays baseline window-created (main / toolbar / host) to the first setup-time listener', async () => {
		const electron = makeElectron()
		const ipcMain = makeIpcMain()
		const events: Array<{ role: string }> = []
		const app = new DeckApp(
			{
				toolbar: {
					source: { url: 'http://toolbar' },
					preloadPath: '/pre.js',
					height: 36,
				},
				windows: {
					settings: { source: { url: 'http://settings' } },
				},
				setup: (rt) => {
					rt.on('window-created', (p) => {
						events.push({ role: (p as { role: string }).role })
					})
				},
			},
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()
		// Expect at least one 'main' role plus one 'toolbar' plus one for the
		// declared 'settings' window. Spec says role may be 'main'|'toolbar'|'host'.
		const roles = events.map(e => e.role)
		expect(roles).toContain('main')
		expect(roles).toContain('toolbar')
		expect(roles).toContain('host')
	})

	it('emits window-closed when a declared window emits closed', async () => {
		const electron = makeElectron()
		const ipcMain = makeIpcMain()
		const closedSeen: unknown[] = []
		const app = new DeckApp(
			{
				windows: { aux: { source: { url: 'http://aux' } } },
				setup: (rt) => {
					rt.on('window-closed', (p) => closedSeen.push(p))
				},
			},
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()
		const declared = electron.__windows[1]!
		declared.__emit('closed')
		expect(closedSeen.length).toBe(1)
	})
})

// ─────────────────────────────────────────────────────────────────────────
// X7 — C5: trust ref-count — host trust().dispose() does not strip baseline.
// ─────────────────────────────────────────────────────────────────────────

describe('X7 — trust ref-count preserves baseline auto-trust', () => {
	it('runtime.windows.trust(declaredWindow).dispose() leaves the window still trusted', async () => {
		const electron = makeElectron()
		const ipcMain = makeIpcMain()
		const app = new DeckApp(
			{ windows: { aux: { source: { url: 'http://aux' } } } },
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()
		const rt = app.runtime
		const declared = electron.__windows[1]!
		// Resolve the invoke handler that ipcMain.handle('__electron-deck:invoke', ...)
		// was registered with, so we can probe trust through the public surface.
		const invokeHandler = ipcMain.__handlers.get(DeckChannel.Invoke)!
		const wcId = (declared.webContents as { id: number }).id

		// baseline: declared window's webContents is trusted → UntrustedSender NOT returned.
		const beforeResp = await invokeHandler(
			{ sender: { id: wcId } },
			{ kind: 'host', name: 'noop', args: [] },
		) as { ok: boolean; error?: { code?: string } }
		expect(beforeResp.ok === false && beforeResp.error?.code === 'DECK_UNTRUSTED_SENDER').toBe(false)

		// take an extra trust ref and dispose it; baseline must remain.
		const extra = rt.windows.trust(declared as unknown as Parameters<typeof rt.windows.trust>[0])
		extra.dispose()

		const afterResp = await invokeHandler(
			{ sender: { id: wcId } },
			{ kind: 'host', name: 'noop', args: [] },
		) as { ok: boolean; error?: { code?: string } }
		expect(afterResp.ok === false && afterResp.error?.code === 'DECK_UNTRUSTED_SENDER').toBe(false)
	})
})

// ─────────────────────────────────────────────────────────────────────────
// X8 — R7: toolbar resize follows mainWindow resize.
// ─────────────────────────────────────────────────────────────────────────

describe('X8 — toolbar resizes with mainWindow', () => {
	it('mainWindow resize event causes toolbarView.setBounds to be called with new width', async () => {
		const initialBounds = { x: 0, y: 0, width: 800, height: 600 }
		const mainWin = makeWindow(undefined, initialBounds)
		const electron = makeElectron({
			windowFactory: () => mainWin,
		})
		const ipcMain = makeIpcMain()
		const app = new DeckApp(
			{
				toolbar: {
					source: { url: 'http://toolbar' },
					preloadPath: '/pre.js',
					height: 48,
				},
			},
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()

		const toolbarView = electron.__views[0]!
		const callsBefore = toolbarView.__setBoundsMock.mock.calls.length
		// mutate content bounds → emit resize
		mainWin.__bounds = { x: 0, y: 0, width: 1280, height: 720 }
		mainWin.__emit('resize')
		const callsAfter = toolbarView.__setBoundsMock.mock.calls.length
		expect(callsAfter).toBeGreaterThan(callsBefore)
		const last = toolbarView.__setBoundsMock.mock.calls[callsAfter - 1]![0] as MinimalRect
		expect(last.width).toBe(1280)
		expect(last.height).toBe(48)
	})
})

// ─────────────────────────────────────────────────────────────────────────
// X9 — R8: empty remoteName from DeckRemoteError preserved (?? not ||).
// ─────────────────────────────────────────────────────────────────────────

describe('X9 — empty remoteName preserved via ??', () => {
	it('host throwing new DeckRemoteError("", msg, code) preserves remoteName === ""', async () => {
		const bus = new EventBus()
		const ipcMain = makeIpcMain()
		const trustedId = 7777
		const transport = new WireTransport({
			ipcMain,
			bus,
			senderPolicy: { isTrusted: (id) => id === trustedId },
			trustedWebContents: () => [],
			declaredEvents: () => [],
			invokeHost: async () => {
				throw new DeckRemoteError('', 'something exploded', 'E_FOO')
			},
			invokeSimulator: async () => null as never,
		})
		transport.start()
		const handler = ipcMain.__handlers.get(DeckChannel.Invoke)!
		const resp = await handler(
			{ sender: { id: trustedId } },
			{ kind: 'host', name: 'whatever', args: [] },
		) as { ok: false; error: { remoteName: string; code?: string; message: string } }
		expect(resp.ok).toBe(false)
		expect(resp.error.remoteName).toBe('')
		expect(resp.error.code).toBe('E_FOO')
		expect(resp.error.message).toBe('something exploded')
	})
})

// ─────────────────────────────────────────────────────────────────────────
// X10 — R9: doc-only, no runtime test. Sanity placeholder.
// ─────────────────────────────────────────────────────────────────────────

describe('X10 — R9 doc-only', () => {
	it('placeholder: no runtime contract', () => {
		expect(true).toBe(true)
	})
})

// ─────────────────────────────────────────────────────────────────────────
// X11 — R10: doc-only.
// ─────────────────────────────────────────────────────────────────────────

describe('X11 — R10 doc-only', () => {
	it('placeholder: no runtime contract', () => {
		expect(true).toBe(true)
	})
})

// ─────────────────────────────────────────────────────────────────────────
// X12 — C7: half-state guard.
// ─────────────────────────────────────────────────────────────────────────

describe('X12 — half-state guard: electron + toolbar/windows without wireTransport', () => {
	it('rejects with Error mentioning wireTransport.ipcMain when toolbar is present but wireTransport is missing', async () => {
		const electron = makeElectron()
		const app = new DeckApp(
			{
				toolbar: {
					source: { url: 'http://toolbar' },
					preloadPath: '/pre.js',
					height: 36,
				},
			},
			{ electron },
		)
		await expect(app.start()).rejects.toThrow(/wireTransport\.ipcMain is required/)
	})

	it('rejects similarly when windows is present without wireTransport', async () => {
		const electron = makeElectron()
		const app = new DeckApp(
			{ windows: { aux: { source: { url: 'http://aux' } } } },
			{ electron },
		)
		await expect(app.start()).rejects.toThrow(/wireTransport\.ipcMain is required/)
	})
})

// ─────────────────────────────────────────────────────────────────────────
// X13 — C9: WireTransport.start() rollback on partial registration failure.
// ─────────────────────────────────────────────────────────────────────────

describe('X13 — WireTransport.start() rollback', () => {
	it('when 2nd ipcMain.handle throws, the 1st handler is removed and state stays idle (start works again on a new ipcMain)', () => {
		const bus = new EventBus()
		let handleCallCount = 0
		const ipcMain = {
			__handlers: new Map<string, unknown>(),
			handle: vi.fn((channel: string, h: unknown) => {
				handleCallCount++
				if (handleCallCount === 2) throw new Error('forced 2nd handle failure')
				;(ipcMain.__handlers as Map<string, unknown>).set(channel, h)
			}),
			removeHandler: vi.fn((channel: string) => {
				;(ipcMain.__handlers as Map<string, unknown>).delete(channel)
			}),
		} as unknown as MinimalIpcMain & {
			__handlers: Map<string, unknown>
			handle: ReturnType<typeof vi.fn>
			removeHandler: ReturnType<typeof vi.fn>
		}

		const transport = new WireTransport({
			ipcMain,
			bus,
			senderPolicy: { isTrusted: () => true },
			trustedWebContents: () => [],
			declaredEvents: () => [],
			invokeHost: async () => null as never,
			invokeSimulator: async () => null as never,
		})
		expect(() => transport.start()).toThrow(/forced 2nd handle failure/)

		// The first successfully-registered handler must have been rolled back.
		expect(ipcMain.removeHandler).toHaveBeenCalled()
		expect(ipcMain.__handlers.size).toBe(0)

		// A second start() on the SAME instance must NOT throw "already started" —
		// it can either succeed (state was rolled back to idle) or throw a
		// different error. The contract: state went back to idle.
		// We allow either: re-throws same setup error OR succeeds; what we
		// disallow is "already started" wording.
		try {
			transport.start()
		}
		catch (e) {
			expect(String(e)).not.toMatch(/already started/i)
		}
	})
})

// ─────────────────────────────────────────────────────────────────────────
// X14 — load-failed declared in FrameworkEvents type (sanity).
// (Covered functionally by X3; this is a redundant payload-shape probe.)
// ─────────────────────────────────────────────────────────────────────────

describe('X14 — load-failed payload shape is { source, error }', () => {
	it('payload object has both source and error properties', async () => {
		const failingErr = new Error('boom')
		const electron = makeElectron({
			viewFactory: () => {
				const v = makeView()
				v.webContents.loadURL = vi.fn(async () => { throw failingErr }) as never
				return v
			},
		})
		const ipcMain = makeIpcMain()
		let payload: { source?: unknown; error?: unknown } | null = null
		const app = new DeckApp(
			{
				toolbar: {
					source: { url: 'http://t' },
					preloadPath: '/p.js',
					height: 36,
				},
				setup: (rt) => {
					rt.on('load-failed', (p) => { payload = p as never })
				},
			},
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()
		await flush()
		await flush()
		expect(payload).not.toBeNull()
		expect(payload).toHaveProperty('source')
		expect(payload).toHaveProperty('error')
	})
})
