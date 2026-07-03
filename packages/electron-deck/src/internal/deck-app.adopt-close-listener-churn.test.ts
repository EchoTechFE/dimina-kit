/**
 * Contract: repeatedly adopt → un-adopt → re-adopt the SAME window must NOT
 * accumulate close listeners on that window. adopt arms a window-close listener
 * pair (`prependListener('closed', revoke)` for trust/slot revocation +
 * `on('close', …)` for the per-window close decider machine); un-adopting
 * (disposing the adopt registration → closing the windowScope) must relinquish
 * ownership of those listeners so re-adoption does not leave stale duplicates
 * firing on the next close.
 *
 * Fakes copied (minimal) from deck-app.adopt.test.ts, EXTENDED with
 * `removeListener`/`off` so a windowScope-owned listener registration can be
 * observed to leave the window when the scope tears down (the fix). The current
 * code registers the listeners and never removes them, so the active-count
 * assertion fails (red) until the fix routes listener ownership through the
 * windowScope.
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
import type { MinimalIpcMain, MinimalWebContents } from './wire-transport.js'
import type { RuntimeBackend } from '../types.js'

// ── Minimal fakes (copied from deck-app.adopt.test.ts + removeListener/off) ───

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
	removeListener: ReturnType<typeof vi.fn>
	off: ReturnType<typeof vi.fn>
	contentView: MinimalBrowserWindow['contentView'] & {
		addChildView: ReturnType<typeof vi.fn>
		removeChildView: ReturnType<typeof vi.fn>
	}
	destroyed: boolean
	_listeners: Map<string, Array<(...args: unknown[]) => void>>
	_emit(event: 'resize' | 'closed' | 'close'): void
	/** Live count of registered listeners for an event (add - remove). */
	_activeCount(event: string): number
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
	makeExternalWindow(): FakeBrowserWindow
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
		removeListener: FakeBrowserWindow['removeListener']
		off: FakeBrowserWindow['off']
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
			const add = (event: string, listener: (...args: unknown[]) => void, front: boolean): FakeBW => {
				let arr = this._listeners.get(event)
				if (!arr) {
					arr = []
					this._listeners.set(event, arr)
				}
				if (front) arr.unshift(listener)
				else arr.push(listener)
				return this
			}
			const remove = (event: string, listener: (...args: unknown[]) => void): FakeBW => {
				const arr = this._listeners.get(event)
				if (arr) {
					const i = arr.indexOf(listener)
					if (i >= 0) arr.splice(i, 1)
				}
				return this
			}
			this.on = vi.fn((event: string, listener: (...args: unknown[]) => void) =>
				add(event, listener, false)) as FakeBrowserWindow['on']
			this.prependListener = vi.fn((event: string, listener: (...args: unknown[]) => void) =>
				add(event, listener, true)) as FakeBrowserWindow['prependListener']
			this.removeListener = vi.fn((event: string, listener: (...args: unknown[]) => void) =>
				remove(event, listener)) as FakeBrowserWindow['removeListener']
			this.off = vi.fn((event: string, listener: (...args: unknown[]) => void) =>
				remove(event, listener)) as FakeBrowserWindow['off']
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

		_activeCount(event: string): number {
			return this._listeners.get(event)?.length ?? 0
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

// ── Typed escape hatches ─────────────────────────────────────────────────────
type Ownership = 'transfer' | 'observe'
interface AdoptRegistration { dispose(): void | Promise<void> }
interface RuntimeWithAdopt {
	windows: {
		adopt(win: unknown, opts?: { ownership?: Ownership }): AdoptRegistration
	}
}
function withApi(runtime: Runtime): RuntimeWithAdopt {
	return runtime as unknown as RuntimeWithAdopt
}

type Decision = 'close' | 'keep'
interface DeckWindowLike { onClose(decider: () => Decision | Promise<Decision>): { dispose(): void } }
/** Reach the adopted window's per-window DeckWindow facade (keyed by control wc
 *  in the framework's windowRegistrations) so a close decider can be armed. */
function adoptedDeckWindowOf(app: DeckApp, wc: MinimalWebContents): DeckWindowLike {
	const regs = (app as unknown as {
		windowRegistrations: Map<MinimalWebContents, { deckWindow: DeckWindowLike }>
	}).windowRegistrations
	const rec = regs.get(wc)
	if (!rec) throw new Error('no windowRegistration for the adopted window')
	return rec.deckWindow
}

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0))

async function bootOwnsWindows(): Promise<{ app: DeckApp, electron: FakeElectron }> {
	const electron = createFakeElectron()
	const app = new DeckApp(
		{},
		{ electron, backend: makeOwnsWindowsBackend(), wireTransport: { ipcMain: createFakeIpcMain() } },
	)
	await app.start()
	return { app, electron }
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-adopting a window does not accumulate window-close listeners.
// ─────────────────────────────────────────────────────────────────────────────
describe('adopt / un-adopt / re-adopt — window close listeners do not accumulate', () => {
	it('after 3 adopt→un-adopt→re-adopt rounds the window carries at most one "closed" and one "close" listener', async () => {
		const { app, electron } = await bootOwnsWindows()
		const win = electron.makeExternalWindow()

		let maxClosed = 0
		let maxClose = 0
		for (let round = 0; round < 3; round++) {
			const reg = withApi(app.runtime).windows.adopt(win as unknown)
			maxClosed = Math.max(maxClosed, win._activeCount('closed'))
			maxClose = Math.max(maxClose, win._activeCount('close'))
			// Un-adopt: dispose the registration → windowScope.close() cascade. The
			// listeners' ownership belongs to that windowScope, so its teardown must
			// remove them (await the async cascade before re-adopting).
			await Promise.resolve(reg.dispose())
			await tick()
		}

		// The window is adopted at most once at a time, so no more than one of each
		// close listener may be live. Without windowScope-owned listener registration
		// the count climbs to 3 (one per round, never removed).
		expect(win._activeCount('closed')).toBeLessThanOrEqual(1)
		expect(win._activeCount('close')).toBeLessThanOrEqual(1)
		expect(maxClosed).toBeLessThanOrEqual(1)
		expect(maxClose).toBeLessThanOrEqual(1)

		await app.shutdown()
	})

	// ── Regression guard (green under current behavior): even with residual
	//    listeners the in-flight close latch fires the decider once. Guards the
	//    fix from breaking single-decision close arbitration. ───────────────────
	it('[regression] after re-adopt churn, closing the window runs the per-window close decider exactly once', async () => {
		const { app, electron } = await bootOwnsWindows()
		const win = electron.makeExternalWindow()

		// Churn: adopt→un-adopt twice, then a final live adopt.
		for (let round = 0; round < 2; round++) {
			const reg = withApi(app.runtime).windows.adopt(win as unknown)
			await Promise.resolve(reg.dispose())
			await tick()
		}
		withApi(app.runtime).windows.adopt(win as unknown)

		const decider = vi.fn<() => Decision>().mockReturnValue('keep')
		adoptedDeckWindowOf(app, win.webContents as unknown as MinimalWebContents).onClose(decider)

		// A single close attempt must consult the decider exactly once, regardless of
		// how many close listeners the churn left behind.
		win._emit('close')
		await tick()

		expect(decider).toHaveBeenCalledTimes(1)

		await app.shutdown()
	})
})

// Parity ref so an unused-import lint never masks a runtime failure.
const _jsonParityRef: JsonValue = null
void _jsonParityRef
