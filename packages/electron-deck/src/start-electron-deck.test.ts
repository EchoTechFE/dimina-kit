import { describe, expect, it, vi } from 'vitest'
import type {
	MinimalApp,
	MinimalBrowserWindow,
	MinimalBrowserWindowOptions,
	MinimalElectron,
	MinimalRect,
	MinimalWebContentsLike,
	MinimalWebContentsView,
} from './internal/electron-types.js'
import type { MinimalIpcMain } from './internal/wire-transport.js'
import type { DeckConfig, DeckOptions, Runtime } from './types.js'
// `startElectronDeck` is imported ALONGSIDE the existing `electronDeck` so the
// compat smoke (#6) proves the Promise form is untouched.
import { electronDeck, startElectronDeck } from './electron-deck.js'

/**
 * Contract for `startElectronDeck(config, opts?)`.
 *
 * BACKGROUND: `electronDeck(config)` is `async` and internally
 * `await app.start()` → `await app.whenReady()`. A host ESM main entry that
 * does `await electronDeck(config)` SUSPENDS module evaluation on the whenReady
 * gate — but Electron's `ready` only fires once module evaluation finishes, so
 * the gate never resolves: HARD DEADLOCK.
 *
 * The fix is a NEW non-async entry `startElectronDeck(config, opts?)` that
 * returns a handle SYNCHRONOUSLY (a plain object, NOT a thenable) so the host's
 * top-level `await` never sits on the whenReady gate. Assembly still runs
 * STRICTLY AFTER `app.whenReady()` resolves; `handle.ready` resolves with the
 * Runtime once assembly completes; `handle.dispose()` tears the app down even
 * if called before the in-flight start finished.
 *
 *   handle = startElectronDeck(config, opts?): {
 *     ready: Promise<Runtime>
 *     dispose(): Promise<void>
 *   }
 *
 * Where handle members are reached, we use a typed escape hatch (`StartHandle`)
 * so this file COMPILES against the export surface and each guard is a runtime
 * check, not a type error.
 */

// ── Typed escape hatch for the handle surface ────────────────────────────────

interface StartHandle {
	ready: Promise<Runtime>
	dispose(): Promise<void>
}

// ── Controllable fake `MinimalApp` (whenReady resolvable ON DEMAND) ───────────
//
// Unlike the lifecycle suite's fake (whenReady resolves immediately), this one
// hands back a DEFERRED whenReady so a test can keep `start()` parked on the
// gate and observe that NO window was constructed yet (#2), then release it.

type AppEvent = 'will-quit' | 'before-quit' | 'window-all-closed' | 'second-instance'

interface FakeApp extends MinimalApp {
	whenReady: ReturnType<typeof vi.fn> & MinimalApp['whenReady']
	/** Test-only — resolve the pending whenReady() promise. */
	_resolveReady(): void
	/** Test-only — true once whenReady() has actually been awaited-through. */
	_whenReadyResolved: boolean
	/** Test-only — # of times whenReady() was invoked by the framework. */
	_whenReadyCalls: number
	quit: ReturnType<typeof vi.fn> & MinimalApp['quit']
	_listeners: Map<AppEvent, Array<(e?: { preventDefault(): void }) => void>>
	_emit(event: AppEvent): void
}

function createFakeApp(): FakeApp {
	const _listeners = new Map<AppEvent, Array<(e?: { preventDefault(): void }) => void>>()
	let resolveReady!: () => void
	const readyPromise = new Promise<void>((res) => {
		resolveReady = res
	})
	const app = {
		_listeners,
		_whenReadyResolved: false,
		_whenReadyCalls: 0,
		whenReady: vi.fn(async () => {
			app._whenReadyCalls++
			await readyPromise
			app._whenReadyResolved = true
		}),
		_resolveReady(): void {
			resolveReady()
		},
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
		requestSingleInstanceLock: vi.fn(() => true),
		_emit(event: AppEvent): void {
			const arr = _listeners.get(event)
			if (!arr) return
			for (const fn of arr) fn({ preventDefault: vi.fn() })
		},
	} as unknown as FakeApp
	return app
}

// ── Fake Electron — BrowserWindow ctor tracking + injectable app ──────────────
//
// `browserWindowCtorCount` is the OBSERVABLE assembly side-effect: assembly
// constructs the framework main window, so a non-zero count means assembly ran.

interface FakeWebContentsLike extends MinimalWebContentsLike {
	destroyed: boolean
}

interface FakeBrowserWindow extends MinimalBrowserWindow {
	readonly webContents: FakeWebContentsLike
	destroyed: boolean
	_listeners: Map<string, Array<(e?: { preventDefault(): void }) => void>>
	_emit(event: 'resize' | 'closed' | 'close'): void
}

interface FakeElectron extends MinimalElectron {
	app: FakeApp
	browserWindows: FakeBrowserWindow[]
	/** OBSERVABLE assembly side-effect — # of BrowserWindow ctor calls so far. */
	readonly browserWindowCtorCount: number
	/** # of windows still alive (not destroyed) — used to assert no leak. */
	readonly liveWindowCount: number
}

function createFakeElectron(
	app: FakeApp,
	initialContentBounds: MinimalRect = { x: 0, y: 0, width: 1024, height: 768 },
): FakeElectron {
	let wcIdCounter = 100
	let winIdCounter = 1
	let browserWindowCtorCount = 0
	const browserWindows: FakeBrowserWindow[] = []

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
		readonly contentView: MinimalBrowserWindow['contentView']
		destroyed: boolean
		_listeners: Map<string, Array<(e?: { preventDefault(): void }) => void>>

		constructor(_opts?: MinimalBrowserWindowOptions) {
			browserWindowCtorCount++
			this.id = winIdCounter++
			this.webContents = makeFakeWebContents()
			this.destroyed = false
			this.contentView = {
				addChildView: vi.fn(),
				removeChildView: vi.fn(),
			} as MinimalBrowserWindow['contentView']
			this._listeners = new Map()
			browserWindows.push(this as unknown as FakeBrowserWindow)
		}

		getContentBounds(): MinimalRect {
			return initialContentBounds
		}

		show(): void { /* noop */ }

		destroy(): void {
			this.destroyed = true
			this.webContents.destroyed = true
			this._emit('closed')
		}

		isDestroyed(): boolean {
			return this.destroyed
		}

		on(
			event: 'resize' | 'closed' | 'close',
			listener: (e?: { preventDefault(): void }) => void,
		): MinimalBrowserWindow {
			let arr = this._listeners.get(event)
			if (!arr) {
				arr = []
				this._listeners.set(event, arr)
			}
			arr.push(listener)
			return this
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
	}

	class FakeWCV implements MinimalWebContentsView {
		readonly webContents: MinimalWebContentsLike
		constructor(_opts?: { webPreferences?: { preload?: string } }) {
			this.webContents = makeFakeWebContents()
		}

		setBounds(): void { /* noop */ }
	}

	return {
		app,
		BrowserWindow: FakeBW as unknown as MinimalElectron['BrowserWindow'],
		WebContentsView: FakeWCV as unknown as MinimalElectron['WebContentsView'],
		browserWindows,
		get browserWindowCtorCount() {
			return browserWindowCtorCount
		},
		get liveWindowCount() {
			return browserWindows.filter(w => !w.destroyed).length
		},
	}
}

// ── Fake ipcMain ──────────────────────────────────────────────────────────────

function createFakeIpcMain(): MinimalIpcMain {
	return {
		handle: () => undefined,
		removeHandler: () => undefined,
	}
}

/** Inject a fresh {app-bearing electron, ipcMain} pair for one test. */
function makeInjected(): { electron: FakeElectron, ipcMain: MinimalIpcMain, app: FakeApp } {
	const app = createFakeApp()
	const electron = createFakeElectron(app)
	return { electron, ipcMain: createFakeIpcMain(), app }
}

/** A microtask-flush helper: let any already-scheduled microtasks drain so an
 *  assertion about "assembly has NOT run" is not just observing scheduling lag. */
async function flush(): Promise<void> {
	await Promise.resolve()
	await Promise.resolve()
}

// ── 1. returns synchronously / non-thenable ──────────────────────────────────

describe('startElectronDeck — synchronous handle', () => {
	it('returns a non-thenable handle synchronously (no top-level await needed)', () => {
		const { electron, ipcMain } = makeInjected()
		// Pin: calling does NOT block / does NOT need awaiting — it returns a value.
		const handle = startElectronDeck({}, { electron, ipcMain }) as unknown as StartHandle

		// The handle itself must NOT be a promise — a host that `await`s the handle
		// would suspend the module on the whenReady gate (the original deadlock).
		expect(typeof (handle as unknown as { then?: unknown }).then).not.toBe('function')

		// It exposes `ready` (a Promise) + `dispose` (a function).
		expect(handle.ready).toBeInstanceOf(Promise)
		expect(typeof handle.dispose).toBe('function')
	})
})

// ── 2. CRITICAL: assembly STRICTLY after whenReady (P1a invariant) ────────────

describe('startElectronDeck — whenReady gating (CRITICAL)', () => {
	it('constructs NO window before whenReady resolves; assembly + ready run ONLY after', async () => {
		const { electron, ipcMain, app } = makeInjected()
		const handle = startElectronDeck({}, { electron, ipcMain }) as unknown as StartHandle

		// whenReady is still PENDING — let any scheduled microtasks drain.
		await flush()

		// CRITICAL invariant (P1a): the framework must NOT construct a BrowserWindow
		// before `app.whenReady()` resolves in a real main process.
		expect(electron.browserWindowCtorCount).toBe(0)
		expect(app._whenReadyResolved).toBe(false)

		// Release the gate → assembly runs → ready resolves.
		app._resolveReady()
		await handle.ready

		// Assembly side-effect (the framework main window) is now observable.
		expect(app._whenReadyResolved).toBe(true)
		expect(electron.browserWindowCtorCount).toBeGreaterThanOrEqual(1)
	})
})

// ── 3. ready resolves with the Runtime ───────────────────────────────────────

describe('startElectronDeck — ready resolves with Runtime', () => {
	it('ready resolves to a usable Runtime after whenReady + assembly', async () => {
		const { electron, ipcMain, app } = makeInjected()
		const handle = startElectronDeck({}, { electron, ipcMain }) as unknown as StartHandle

		app._resolveReady()
		const runtime = await handle.ready

		// Runtime is the real DeckApp runtime: `windows` registry + `view` factory.
		expect(runtime).toBeTruthy()
		expect(typeof runtime.view).toBe('function')
		expect(runtime.windows).toBeTruthy()
		expect(typeof runtime.windows.create).toBe('function')
		// The framework-built main window is present in the live window set.
		expect(runtime.windows.all().length).toBeGreaterThanOrEqual(1)
	})
})

// ── 4. CRITICAL: dispose-before-ready is safe (no race) ──────────────────────

describe('startElectronDeck — dispose before ready (CRITICAL)', () => {
	it('dispose() called while start is still pending awaits the in-flight start then shuts down cleanly', async () => {
		const { electron, ipcMain, app } = makeInjected()
		const handle = startElectronDeck({}, { electron, ipcMain }) as unknown as StartHandle

		// start() is parked on the still-pending whenReady gate.
		await flush()
		expect(electron.browserWindowCtorCount).toBe(0)

		// Call dispose BEFORE resolving whenReady. dispose must NOT resolve while the
		// start is still in flight on the gate — it has to await it (or the gate).
		const disposed = handle.dispose()

		// Release the gate so the in-flight start can complete; dispose then drives
		// (or joins) a clean shutdown.
		app._resolveReady()

		// dispose resolves WITHOUT throwing.
		await expect(disposed).resolves.toBeUndefined()

		// No half-constructed / leaked window survives: every window the framework
		// built during the raced assembly is torn down (rootScope cascade), so the
		// live count is zero.
		expect(electron.liveWindowCount).toBe(0)

		// Shutdown drives the framework to quit exactly once (idempotent, no double).
		expect(app.quit).toHaveBeenCalledTimes(1)
	})
})

// ── 5. invalid config surfaces the validation error (no deadlock) ────────────

describe('startElectronDeck — invalid config', () => {
	it('a clearly-invalid config surfaces a TypeError (sync throw OR ready-rejection)', async () => {
		const { electron, ipcMain } = makeInjected()
		// `null` config fails `validateConfig` with a TypeError. The contract: the
		// error SURFACES (never silently deadlocks) — either synchronously at the
		// call, or via `handle.ready` rejecting. Accept whichever is the contract.
		//
		// Assert the symbol EXISTS first, so this test fails because validation
		// didn't surface — not because `startElectronDeck` is undefined and
		// "not a function" happens to be a TypeError too.
		expect(typeof startElectronDeck).toBe('function')

		let syncThrew: unknown
		let handle: StartHandle | undefined
		try {
			handle = startElectronDeck(
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				null as any,
				{ electron, ipcMain },
			) as unknown as StartHandle
		}
		catch (err) {
			syncThrew = err
		}

		if (syncThrew !== undefined) {
			expect(syncThrew).toBeInstanceOf(TypeError)
			return
		}
		// Did not throw synchronously → the validation error must surface on `ready`.
		// Resolve whenReady so a (hypothetical) gate can't mask the rejection.
		electron.app._resolveReady()
		await expect(handle!.ready).rejects.toBeInstanceOf(TypeError)
	})
})

// ── 6. compat — electronDeck() Promise form still works ──────────────────────

describe('electronDeck — compat (unchanged Promise form)', () => {
	it('still assembles after whenReady and resolves', async () => {
		const { electron, ipcMain, app } = makeInjected()
		// The Promise form resolves the gate immediately (no host top-level await
		// needed here because the test drives the gate). Assembly runs AFTER ready.
		app._resolveReady()
		const cfg: DeckConfig = {}
		const opts: DeckOptions = { electron, ipcMain }
		await expect(electronDeck(cfg, opts)).resolves.toBeUndefined()
		// The framework main window was constructed (assembly ran post-whenReady).
		expect(electron.browserWindowCtorCount).toBeGreaterThanOrEqual(1)
		expect(app._whenReadyResolved).toBe(true)
	})
})
