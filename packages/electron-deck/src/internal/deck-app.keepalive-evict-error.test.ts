/**
 * Contract: when the keepAlive LRU evicts a victim view whose dispose() rejects
 * (its native teardown throws), the framework must NOT leak an unhandled promise
 * rejection — the eviction's `victim.dispose()` failure has to be caught and
 * logged (console.error), the same discipline every other fire-and-forget dispose
 * in the framework follows.
 *
 * Fakes copied (minimal) from deck-app.keepalive.test.ts — the fake webContents
 * carries a `close` spy that flips the destroyed flag. Here the victim's `close`
 * is overridden to THROW, so its viewScope teardown rejects and the eviction's
 * `void victim.dispose()` becomes a rejected floating promise.
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
import type { MinimalIpcMain } from './wire-transport.js'

// ── Minimal fakes (copied from deck-app.keepalive.test.ts) ───────────────────

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
}

function createFakeElectron(
	initialContentBounds: MinimalRect = { x: 0, y: 0, width: 1024, height: 768 },
): FakeElectron {
	let wcIdCounter = 100
	let winIdCounter = 1
	const browserWindows: FakeBrowserWindow[] = []
	const webContentsViews: FakeWebContentsView[] = []

	function makeFakeWebContents(): FakeWebContentsLike {
		const id = wcIdCounter++
		const wc: FakeWebContentsLike = {
			id,
			destroyed: false,
			loadURL: vi.fn(async (_u: string) => undefined) as FakeWebContentsLike['loadURL'],
			loadFile: vi.fn(async (_p: string) => undefined) as FakeWebContentsLike['loadFile'],
			send: vi.fn() as FakeWebContentsLike['send'],
			close: vi.fn(() => {
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
		_lastCloseEvent: { preventDefault: ReturnType<typeof vi.fn> } | null

		constructor(_opts?: MinimalBrowserWindowOptions) {
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
		destroyed: boolean

		constructor() {
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
	}
}

// ── Typed escape hatches ─────────────────────────────────────────────────────
type Bounds = { x: number, y: number, width: number, height: number }
type Placement = { visible: true, bounds: Bounds } | { visible: false }
interface ViewSource { url?: string, file?: string }
interface KeepAliveSpec { policy: 'lru', max: number }
interface HostViewHandle {
	placeIn(win: unknown, opts: { zone?: number }): HostViewHandle
	applyPlacement(p: Placement): HostViewHandle
	dispose(): Promise<void>
}
interface RuntimeWithView {
	view(spec: { source: ViewSource, scope?: unknown, keepAlive?: KeepAliveSpec }): HostViewHandle
}
function withView(runtime: Runtime): RuntimeWithView {
	return runtime as unknown as RuntimeWithView
}

function lastWcv(electron: FakeElectron): FakeWebContentsView {
	const wcv = electron.webContentsViews[electron.webContentsViews.length - 1]
	if (!wcv) throw new Error('no WebContentsView was constructed')
	return wcv
}

const HIDDEN: Placement = { visible: false }
const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0))

/** True iff `reason` (an Error, possibly an AggregateError) mentions the boom. */
function mentionsBoom(reason: unknown): boolean {
	const seen = new Set<unknown>()
	const walk = (x: unknown): boolean => {
		if (x == null || seen.has(x)) return false
		seen.add(x)
		if (typeof x === 'string') return x.includes('victim-dispose-boom')
		if (x instanceof Error) {
			if (x.message.includes('victim-dispose-boom')) return true
			const agg = x as { errors?: unknown[] }
			return Array.isArray(agg.errors) && agg.errors.some(walk)
		}
		return false
	}
	return walk(reason)
}

// ─────────────────────────────────────────────────────────────────────────────
// A keepAlive eviction whose victim.dispose() rejects must not leak an unhandled
// rejection; the failure is caught and logged.
// ─────────────────────────────────────────────────────────────────────────────
describe('keepAlive LRU eviction — a victim whose dispose rejects is handled, not leaked', () => {
	it('evicting a view whose native teardown throws logs the error and surfaces no unhandled rejection', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain: createFakeIpcMain() } })
		await app.start()

		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

		const keepAlive: KeepAliveSpec = { policy: 'lru', max: 1 }
		// A: the view that will be evicted first (least-recently-hidden). Make its
		// native WebContents.close() THROW so its viewScope teardown rejects → the
		// eviction's fire-and-forget dispose() becomes a rejected floating promise.
		const a = withView(app.runtime).view({ source: { url: 'data:text/html,a' }, keepAlive })
		const wcvA = lastWcv(electron)
		wcvA.webContents.close = vi.fn(() => {
			throw new Error('victim-dispose-boom')
		})
		const b = withView(app.runtime).view({ source: { url: 'data:text/html,b' }, keepAlive })

		a.placeIn(app.runtime.mainWindow, { zone: 0 })
		b.placeIn(app.runtime.mainWindow, { zone: 0 })

		// Capture unhandled rejections ONLY through our own handler so the red
		// signal is this assertion, not the runner's own global trap. Detach the
		// existing handlers for the window, restore them after.
		const seen: unknown[] = []
		const onUnhandled = (reason: unknown): void => {
			seen.push(reason)
		}
		const prior = process.listeners('unhandledRejection')
		for (const l of prior) process.removeListener('unhandledRejection', l)
		process.on('unhandledRejection', onUnhandled)
		try {
			a.applyPlacement(HIDDEN) // hidden group [A] (1 ≤ max)
			b.applyPlacement(HIDDEN) // hidden [A,B] > max=1 → evict least-recent = A → A.dispose() rejects
			await flush()
			await flush()
			await new Promise(r => setTimeout(r, 0))
		}
		finally {
			process.removeListener('unhandledRejection', onUnhandled)
			for (const l of prior) process.on('unhandledRejection', l)
		}

		// No unhandled rejection referencing the victim's failure escaped.
		expect(seen.filter(mentionsBoom)).toHaveLength(0)
		// The failure was logged instead (console.error carries the boom error).
		const logged = errorSpy.mock.calls.some(call => call.some(arg => mentionsBoom(arg)))
		expect(logged).toBe(true)

		errorSpy.mockRestore()
		await app.shutdown()
	})
})

// Parity ref so an unused-import lint never masks a runtime failure.
const _jsonParityRef: JsonValue = null
void _jsonParityRef
