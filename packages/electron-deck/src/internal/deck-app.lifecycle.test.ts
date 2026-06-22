import { describe, expect, it, vi } from 'vitest'
import type { DeckConfig, RuntimeBackend } from '../types.js'
import type {
	MinimalApp,
	MinimalBrowserWindow,
	MinimalBrowserWindowOptions,
	MinimalElectron,
	MinimalRect,
	MinimalWebContentsLike,
} from './electron-types.js'
import { DeckApp } from './deck-app.js'

/**
 * Phase 4 — FAILURE-FIRST (TDD) contract for the framework binding the
 * Electron `app` process lifecycle hooks (opt-in). These tests pin behaviour
 * the implementation does NOT yet have:
 *
 *   1. `window-all-closed` — opt-in via `config.app.quitOnAllWindowsClosed`:
 *        true      → framework registers the listener AND calls app.quit() on emit.
 *        false     → framework registers the listener but SUPPRESSES app.quit().
 *        undefined → framework does NOT register the listener at all.
 *   2. `will-quit` → shutdown() — always bound; emitting it runs framework
 *        teardown (registry disposables fire); idempotent across repeat emits.
 *   3. single-instance — opt-in via `config.app.singleInstance`:
 *        true + lock denied (false)  → app.quit() + abort (no whenReady / no
 *                                       window / no assemble).
 *        true + lock granted (true)  → continue; `second-instance` emit →
 *                                       backend.onSecondInstance?.().
 *        undefined                   → requestSingleInstanceLock() never called.
 *   4. lifecycle binding is process-level — fires even for an ownsWindows:true
 *        backend (NOT short-circuited by assembleElectron's early-return).
 *
 * The framework must bind these AFTER `app.whenReady()`; the single-instance
 * lock check must run BEFORE `app.whenReady()`.
 *
 * Config fields / backend hooks are attached through a loose structural cast so
 * this file COMPILES and any regression surfaces as an *assertion* failure (spy
 * never called), not a type error.
 *
 * Pins the `bindAppLifecycle` + single-instance gating + `onSecondInstance`
 * contract.
 */

// ── Fake MinimalApp ──────────────────────────────────────────────────────────

type AppEvent = 'will-quit' | 'before-quit' | 'window-all-closed' | 'second-instance'

interface FakeApp extends MinimalApp {
	whenReady: ReturnType<typeof vi.fn> & MinimalApp['whenReady']
	setName: ReturnType<typeof vi.fn> & MinimalApp['setName']
	quit: ReturnType<typeof vi.fn> & MinimalApp['quit']
	on: ReturnType<typeof vi.fn> & MinimalApp['on']
	requestSingleInstanceLock: ReturnType<typeof vi.fn> & NonNullable<MinimalApp['requestSingleInstanceLock']>
	/** Test-only — event → registered listeners. */
	_listeners: Map<AppEvent, Array<(e?: { preventDefault(): void }) => void>>
	/** Test-only — invoke all listeners registered for the given event. */
	_emit(event: AppEvent): void
	/** Test-only — true once whenReady() has resolved at least once. */
	_whenReadyResolved: boolean
}

function createFakeApp(opts: { singleInstanceLock?: boolean } = {}): FakeApp {
	const lock = opts.singleInstanceLock ?? true
	const _listeners = new Map<AppEvent, Array<(e?: { preventDefault(): void }) => void>>()
	const app = {
		_listeners,
		_whenReadyResolved: false,
		whenReady: vi.fn(async () => {
			app._whenReadyResolved = true
		}),
		setName: vi.fn((_name: string) => undefined),
		quit: vi.fn(() => undefined),
		on: vi.fn((event: AppEvent, listener: (e?: { preventDefault(): void }) => void) => {
			let arr = _listeners.get(event)
			if (!arr) {
				arr = []
				_listeners.set(event, arr)
			}
			arr.push(listener)
			return app
		}),
		requestSingleInstanceLock: vi.fn(() => lock),
		_emit(event: AppEvent): void {
			const arr = _listeners.get(event)
			if (!arr) return
			for (const fn of arr) fn({ preventDefault: vi.fn() })
		},
	} as unknown as FakeApp
	return app
}

/** Did `app.on` get called with the given event name at least once? */
function onCalledWith(app: FakeApp, event: AppEvent): boolean {
	return app.on.mock.calls.some(c => c[0] === event)
}

// ── Fake Electron (BrowserWindow ctor tracking + injectable app) ──────────────

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
	app: FakeApp
	browserWindows: FakeBrowserWindow[]
	browserWindowCtorCalls: MinimalBrowserWindowOptions[]
}

function createFakeElectron(
	app: FakeApp,
	initialContentBounds: MinimalRect = { x: 0, y: 0, width: 1024, height: 768 },
): FakeElectron {
	let wcIdCounter = 100
	let winIdCounter = 1
	const browserWindows: FakeBrowserWindow[] = []
	const browserWindowCtorCalls: MinimalBrowserWindowOptions[] = []

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

		constructor(opts?: MinimalBrowserWindowOptions) {
			browserWindowCtorCalls.push(opts ?? {})
			this.id = winIdCounter++
			this.webContents = makeFakeWebContents()
			this.destroyed = false
			this.contentView = {
				addChildView: vi.fn(),
				removeChildView: vi.fn(),
			} as FakeBrowserWindow['contentView']
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

	return {
		app,
		BrowserWindow: FakeBW as unknown as MinimalElectron['BrowserWindow'],
		WebContentsView: class {} as unknown as MinimalElectron['WebContentsView'],
		browserWindows,
		browserWindowCtorCalls,
	}
}

// ── Config / backend builders (loose casts for the `app.*` lifecycle fields) ──

/** Build a DeckConfig carrying the `app.*` lifecycle fields. */
function lifecycleConfig(appExtra: Record<string, unknown>, rest: DeckConfig = {}): DeckConfig {
	return {
		...rest,
		app: { ...(rest.app ?? {}), ...appExtra },
	} as DeckConfig
}

type BackendExtra = Partial<RuntimeBackend> & {
	onSecondInstance?: (...args: unknown[]) => void
}

function makeBackend(extra: BackendExtra = {}): RuntimeBackend & { assemble: ReturnType<typeof vi.fn> } {
	const backend = {
		assemble: vi.fn(async () => undefined),
		...extra,
	} as unknown as RuntimeBackend & { assemble: ReturnType<typeof vi.fn> }
	return backend
}

// ── 1. window-all-closed (opt-in) ────────────────────────────────────────────

describe('DeckApp — app lifecycle: window-all-closed (opt-in)', () => {
	it('quitOnAllWindowsClosed:true → registers window-all-closed AND app.quit() fires on emit', async () => {
		const app = createFakeApp()
		const electron = createFakeElectron(app)
		const deck = new DeckApp(lifecycleConfig({ quitOnAllWindowsClosed: true }), { electron })
		await deck.start()

		expect(onCalledWith(app, 'window-all-closed')).toBe(true)
		expect(app.quit).not.toHaveBeenCalled()
		app._emit('window-all-closed')
		expect(app.quit).toHaveBeenCalled()
	})

	it('quitOnAllWindowsClosed:false → registers listener but SUPPRESSES app.quit() on emit', async () => {
		const app = createFakeApp()
		const electron = createFakeElectron(app)
		const deck = new DeckApp(lifecycleConfig({ quitOnAllWindowsClosed: false }), { electron })
		await deck.start()

		// Listener is registered (explicit suppression of Electron's default quit),
		expect(onCalledWith(app, 'window-all-closed')).toBe(true)
		app._emit('window-all-closed')
		// …but quit() is never called.
		expect(app.quit).not.toHaveBeenCalled()
	})

	it('quitOnAllWindowsClosed omitted → does NOT register window-all-closed; emit does not quit', async () => {
		const app = createFakeApp()
		const electron = createFakeElectron(app)
		const deck = new DeckApp({}, { electron })
		await deck.start()

		expect(onCalledWith(app, 'window-all-closed')).toBe(false)
		app._emit('window-all-closed')
		expect(app.quit).not.toHaveBeenCalled()
	})
})

// ── 2. will-quit → shutdown() (always bound) ─────────────────────────────────

describe('DeckApp — app lifecycle: will-quit → shutdown() (always bound)', () => {
	it('registers will-quit regardless of config', async () => {
		const app = createFakeApp()
		const electron = createFakeElectron(app)
		const deck = new DeckApp({}, { electron })
		await deck.start()
		expect(onCalledWith(app, 'will-quit')).toBe(true)
	})

	it('emitting will-quit runs framework teardown (registry disposables fire)', async () => {
		const app = createFakeApp()
		const electron = createFakeElectron(app)
		const dispose = vi.fn()
		const deck = new DeckApp(
			{
				setup: (rt) => {
					rt.add(dispose)
				},
			},
			{ electron },
		)
		await deck.start()
		expect(dispose).not.toHaveBeenCalled()

		// The emit ALONE must drive teardown — no explicit deck.shutdown() here,
		// so a framework that fails to bind will-quit leaves `dispose` uncalled.
		app._emit('will-quit')
		// allow the async shutdown chain to settle
		await new Promise(r => setTimeout(r, 0))

		expect(dispose).toHaveBeenCalledTimes(1)
		expect(deck.phase).toBe('quit')
	})

	it('repeated will-quit emits tear down only once (idempotent)', async () => {
		const app = createFakeApp()
		const electron = createFakeElectron(app)
		const dispose = vi.fn()
		const deck = new DeckApp(
			{
				setup: (rt) => {
					rt.add(dispose)
				},
			},
			{ electron },
		)
		await deck.start()

		// The first emit drives teardown; subsequent emits must be no-ops.
		// (No explicit deck.shutdown() — the binding is what must fire teardown.)
		app._emit('will-quit')
		app._emit('will-quit')
		app._emit('will-quit')
		await new Promise(r => setTimeout(r, 0))

		expect(dispose).toHaveBeenCalledTimes(1)
		expect(deck.phase).toBe('quit')
	})
})

// ── 3. single-instance (opt-in) ──────────────────────────────────────────────

describe('DeckApp — app lifecycle: single-instance (opt-in)', () => {
	it('singleInstance:true + lock DENIED → app.quit() + abort (no whenReady / no window / no assemble)', async () => {
		const app = createFakeApp({ singleInstanceLock: false })
		const electron = createFakeElectron(app)
		const backend = makeBackend()
		const deck = new DeckApp(lifecycleConfig({ singleInstance: true }), { electron, backend })

		await deck.start()

		// Lock was requested and denied → quit + abort.
		expect(app.requestSingleInstanceLock).toHaveBeenCalled()
		expect(app.quit).toHaveBeenCalled()
		// Aborted BEFORE whenReady — gate never awaited.
		expect(app.whenReady).not.toHaveBeenCalled()
		expect(app._whenReadyResolved).toBe(false)
		// No window constructed, backend.assemble never ran.
		expect(electron.browserWindowCtorCalls).toHaveLength(0)
		expect(backend.assemble).not.toHaveBeenCalled()
		// Did not progress past init.
		expect(deck.phase).toBe('init')
	})

	it('single-instance lock check runs BEFORE whenReady (lock requested, gate never reached)', async () => {
		const app = createFakeApp({ singleInstanceLock: false })
		const electron = createFakeElectron(app)
		const deck = new DeckApp(lifecycleConfig({ singleInstance: true }), { electron })

		await deck.start()

		const lockOrder = app.requestSingleInstanceLock.mock.invocationCallOrder
		expect(lockOrder.length).toBeGreaterThan(0)
		// whenReady never even called (abort happened before it).
		expect(app.whenReady).not.toHaveBeenCalled()
	})

	it('singleInstance:true + lock GRANTED → continues (whenReady + assemble run)', async () => {
		const app = createFakeApp({ singleInstanceLock: true })
		const electron = createFakeElectron(app)
		const backend = makeBackend()
		const deck = new DeckApp(lifecycleConfig({ singleInstance: true }), { electron, backend })

		await deck.start()

		expect(app.requestSingleInstanceLock).toHaveBeenCalled()
		expect(app.quit).not.toHaveBeenCalled()
		expect(app.whenReady).toHaveBeenCalled()
		expect(backend.assemble).toHaveBeenCalledTimes(1)
		expect(deck.phase).toBe('ready')
	})

	it('singleInstance:true + lock GRANTED → second-instance emit dispatches backend.onSecondInstance()', async () => {
		const app = createFakeApp({ singleInstanceLock: true })
		const electron = createFakeElectron(app)
		const onSecondInstance = vi.fn()
		const backend = makeBackend({ onSecondInstance })
		const deck = new DeckApp(lifecycleConfig({ singleInstance: true }), { electron, backend })

		await deck.start()

		// A second-instance listener must have been registered.
		expect(onCalledWith(app, 'second-instance')).toBe(true)
		expect(onSecondInstance).not.toHaveBeenCalled()
		app._emit('second-instance')
		expect(onSecondInstance).toHaveBeenCalledTimes(1)
	})

	it('singleInstance omitted → requestSingleInstanceLock() is never called', async () => {
		const app = createFakeApp()
		const electron = createFakeElectron(app)
		const deck = new DeckApp({}, { electron })

		await deck.start()

		expect(app.requestSingleInstanceLock).not.toHaveBeenCalled()
		expect(deck.phase).toBe('ready')
	})
})

// ── 4. ownsWindows-independence (process-level binding) ──────────────────────

describe('DeckApp — app lifecycle: bound process-level even under ownsWindows:true', () => {
	it('ownsWindows:true backend STILL gets will-quit→shutdown and opt-in window-all-closed→quit', async () => {
		const app = createFakeApp()
		const electron = createFakeElectron(app)
		const dispose = vi.fn()
		const backend = makeBackend({
			ownsWindows: true,
			assemble: vi.fn(async (rt) => {
				rt.add(dispose)
			}) as unknown as RuntimeBackend['assemble'],
		})
		const deck = new DeckApp(lifecycleConfig({ quitOnAllWindowsClosed: true }), { electron, backend })
		await deck.start()

		// Process-level binding is NOT gated by assembleElectron's ownsWindows
		// early-return: both hooks are registered.
		expect(onCalledWith(app, 'will-quit')).toBe(true)
		expect(onCalledWith(app, 'window-all-closed')).toBe(true)

		// window-all-closed → quit
		app._emit('window-all-closed')
		expect(app.quit).toHaveBeenCalled()

		// will-quit → framework teardown (registry disposable fires) — driven by
		// the emit alone, no explicit deck.shutdown() to mask a missing binding.
		app._emit('will-quit')
		await new Promise(r => setTimeout(r, 0))
		expect(dispose).toHaveBeenCalledTimes(1)
		expect(deck.phase).toBe('quit')
	})
})

// ── B1 — re-entrant quit guard: will-quit-driven shutdown must NOT re-app.quit() ──

describe('DeckApp — app lifecycle: re-entrant quit guard (quitInitiated)', () => {
	it('will-quit emit drives teardown but the framework does NOT call app.quit() again (app already quitting)', async () => {
		const app = createFakeApp()
		const electron = createFakeElectron(app)
		const dispose = vi.fn()
		const deck = new DeckApp(
			{
				setup: (rt) => {
					rt.add(dispose)
				},
			},
			{ electron },
		)
		await deck.start()

		// IMPORTANT: we do NOT call app.quit() ourselves to provoke will-quit —
		// we emit the event directly. Electron itself is the one already quitting,
		// so a framework that re-enters app.quit() in doShutdown() would re-drive
		// the quit sequence. The guard (quitInitiated set in the will-quit handler)
		// must suppress that re-entrant call.
		app._emit('will-quit')
		await new Promise(r => setTimeout(r, 0))

		// Teardown ran…
		expect(dispose).toHaveBeenCalledTimes(1)
		expect(deck.phase).toBe('quit')
		// …but the framework did NOT call app.quit() (would re-enter the quit seq).
		expect(app.quit).not.toHaveBeenCalled()
	})

	it('contrast: a main-window-close → shutdown (NOT will-quit) DOES call app.quit() exactly once (guard only blocks the will-quit source)', async () => {
		const app = createFakeApp()
		const electron = createFakeElectron(app)
		// Framework-owned main window (ownsWindows falsy) so the framework wires its
		// own `closed` → shutdown path. No backend, so onMainWindowClose defaults to
		// 'close', destroy() fires, and 'closed' triggers shutdown.
		const deck = new DeckApp({}, { electron })
		await deck.start()

		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow
		// Drive the real close→destroy→closed chain: close decides 'close' →
		// main.destroy() → we emit 'closed' to mirror Electron firing it.
		mainWin._emit('close')
		await new Promise(r => setTimeout(r, 0))
		expect(mainWin.destroy).toHaveBeenCalled()
		mainWin._emit('closed')
		await new Promise(r => setTimeout(r, 0))

		expect(deck.phase).toBe('quit')
		// quitInitiated stayed false (not a will-quit source) → framework owns the
		// process exit and quits exactly once.
		expect(app.quit).toHaveBeenCalledTimes(1)
	})
})
