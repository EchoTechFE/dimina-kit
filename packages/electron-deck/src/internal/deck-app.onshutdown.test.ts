/**
 * Contract tests for the NEW `RuntimeBackend.onShutdown?()`
 * hook.
 *
 * Contract under test:
 *   • The framework MUST AWAIT `backend.onShutdown()` exactly ONCE during the
 *     deterministic teardown path (`app.shutdown()`), so an `ownsWindows:true`
 *     backend no longer hand-rolls `app.once('before-quit', ...)`.
 *   • It is AWAITED — an async `onShutdown`'s work fully completes BEFORE
 *     `shutdown()` resolves.
 *   • It runs even when `ownsWindows: true`.
 *   • A backend WITHOUT `onShutdown` still shuts down cleanly (no crash).
 *   • An `onShutdown` that throws/rejects is best-effort: it MUST NOT prevent
 *     shutdown from completing (phase still reaches 'quit'), but it WAS still
 *     attempted exactly once.
 *
 * The awaited / called-once assertions pin that the framework wires
 * `onShutdown`. The hook is reached through a typed escape hatch
 * (`BackendWithOnShutdown`) so the file COMPILES and asserts on BEHAVIOUR, not
 * types.
 *
 * Fake-electron setup mirrors deck-app.test.ts / deck-app.adopt.test.ts exactly.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Runtime, RuntimeBackend } from '../types.js'
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

// ── Minimal fakes (copied from deck-app.test.ts) ────────────────────────────

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
				for (const fn of arr.slice()) fn(ev)
				return
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

// ── Typed escape hatch for the `onShutdown` hook ─────────────────────────────
//
// Attach `onShutdown` via a loose view so any regression that stops wiring it
// fails at BEHAVIOUR (hook never awaited / called) — the runtime failure we
// want — rather than a compile error.
type BackendWithOnShutdown = RuntimeBackend & {
	onShutdown?: () => void | Promise<void>
}

/** A framework-owns-windows backend (default `ownsWindows` falsy). */
function makeFrameworkBackend(
	onShutdown?: BackendWithOnShutdown['onShutdown'],
): BackendWithOnShutdown & { assemble: ReturnType<typeof vi.fn> } {
	const backend = {
		assemble: vi.fn(async () => undefined),
	} as BackendWithOnShutdown & { assemble: ReturnType<typeof vi.fn> }
	if (onShutdown) backend.onShutdown = onShutdown
	return backend
}

/** An `ownsWindows:true` backend (builds no framework main window). */
function makeOwnsWindowsBackend(
	onShutdown?: BackendWithOnShutdown['onShutdown'],
): BackendWithOnShutdown & { assemble: ReturnType<typeof vi.fn> } {
	const backend = {
		ownsWindows: true,
		assemble: vi.fn(async () => undefined),
	} as BackendWithOnShutdown & { assemble: ReturnType<typeof vi.fn> }
	if (onShutdown) backend.onShutdown = onShutdown
	return backend
}

// ─────────────────────────────────────────────────────────────────────────────

describe('RuntimeBackend.onShutdown — awaited exactly once on shutdown()', () => {
	it('onShutdown is awaited once; its async work completes BEFORE shutdown() resolves', async () => {
		const electron = createFakeElectron()
		let onShutdownCalls = 0
		let asyncWorkFinished = false
		const onShutdown = vi.fn(async () => {
			onShutdownCalls++
			// Awaited work crosses a real async boundary. If the framework does not
			// AWAIT onShutdown, shutdown() resolves with this flag still false.
			await new Promise(r => setTimeout(r, 20))
			asyncWorkFinished = true
		})
		const backend = makeFrameworkBackend(onShutdown)
		const app = new DeckApp({}, { electron, backend })
		await app.start()

		await app.shutdown()

		// Called exactly once.
		expect(onShutdownCalls).toBe(1)
		expect(onShutdown).toHaveBeenCalledTimes(1)
		// AWAITED: the post-await flag must be set by the time shutdown() resolved.
		expect(asyncWorkFinished).toBe(true)
		expect(app.phase).toBe('quit')
	})

	it('onShutdown is NOT called more than once even across an idempotent second shutdown()', async () => {
		const electron = createFakeElectron()
		const onShutdown = vi.fn(async () => undefined)
		const backend = makeFrameworkBackend(onShutdown)
		const app = new DeckApp({}, { electron, backend })
		await app.start()

		await app.shutdown()
		await app.shutdown()

		expect(onShutdown).toHaveBeenCalledTimes(1)
	})
})

describe('RuntimeBackend.onShutdown — runs even with ownsWindows:true', () => {
	it('an ownsWindows:true backend has its onShutdown awaited once on shutdown()', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		let asyncWorkFinished = false
		const onShutdown = vi.fn(async () => {
			await new Promise(r => setTimeout(r, 20))
			asyncWorkFinished = true
		})
		const backend = makeOwnsWindowsBackend(onShutdown)
		const app = new DeckApp({}, { electron, backend, wireTransport: { ipcMain } })
		await app.start()

		await app.shutdown()

		expect(onShutdown).toHaveBeenCalledTimes(1)
		expect(asyncWorkFinished).toBe(true)
		expect(app.phase).toBe('quit')
	})
})

describe('RuntimeBackend.onShutdown — absent hook shuts down cleanly', () => {
	it('a backend WITHOUT onShutdown still shuts down to quit without throwing', async () => {
		const electron = createFakeElectron()
		// makeFrameworkBackend(undefined) → no onShutdown property at all.
		const backend = makeFrameworkBackend()
		expect((backend as BackendWithOnShutdown).onShutdown).toBeUndefined()
		const app = new DeckApp({}, { electron, backend })
		await app.start()

		await expect(app.shutdown()).resolves.toBeUndefined()
		expect(app.phase).toBe('quit')
	})
})

describe('RuntimeBackend.onShutdown — best-effort: a rejecting hook does not block shutdown', () => {
	it('onShutdown that rejects is still attempted exactly once; shutdown() completes to quit', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		try {
			const electron = createFakeElectron()
			const onShutdown = vi.fn(async () => {
				await new Promise(r => setTimeout(r, 5))
				throw new Error('onShutdown-boom')
			})
			const backend = makeFrameworkBackend(onShutdown)
			const app = new DeckApp({}, { electron, backend })
			await app.start()

			// Best-effort: a rejecting onShutdown must NOT reject shutdown().
			await expect(app.shutdown()).resolves.toBeUndefined()
			// But it WAS attempted exactly once.
			expect(onShutdown).toHaveBeenCalledTimes(1)
			expect(app.phase).toBe('quit')
		}
		finally {
			errorSpy.mockRestore()
		}
	})

	it('onShutdown that throws synchronously is still attempted once; shutdown() completes to quit', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		try {
			const electron = createFakeElectron()
			const onShutdown = vi.fn(() => {
				throw new Error('onShutdown-sync-boom')
			})
			const backend = makeFrameworkBackend(onShutdown)
			const app = new DeckApp({}, { electron, backend })
			await app.start()

			await expect(app.shutdown()).resolves.toBeUndefined()
			expect(onShutdown).toHaveBeenCalledTimes(1)
			expect(app.phase).toBe('quit')
		}
		finally {
			errorSpy.mockRestore()
		}
	})
})

// Parity ref so an unused-import lint never masks a runtime failure.
const _runtimeParityRef: Runtime | null = null
void _runtimeParityRef
