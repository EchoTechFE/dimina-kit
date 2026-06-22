import { describe, expect, it, vi } from 'vitest'
import type { DeckConfig, RuntimeBackend, WebviewSource } from '../types.js'
import { DeckApp } from './deck-app.js'
import type {
	MinimalBrowserWindow,
	MinimalBrowserWindowOptions,
	MinimalElectron,
	MinimalRect,
	MinimalWebContentsLike,
	MinimalWebContentsView,
} from './electron-types.js'

/**
 * FAILURE-FIRST (TDD) — contract for the NEW `config.app.source` field.
 *
 * Contract under test:
 *   • `AppConfig` gains `readonly source?: WebviewSource`.
 *   • When `config.app.source` is set AND the framework owns the main window
 *     (NOT an `ownsWindows: true` backend), the framework MUST load that source
 *     into the main window automatically AFTER the window is built, via the same
 *     safeLoad path the toolbar / declared windows use
 *     (`{ url }` → `webContents.loadURL(url)`; `{ file }` → `webContents.loadFile(path)`).
 *   • When `config.app.source` is absent, the framework does NOT auto-load the
 *     main window (current behavior — host owns the load).
 *   • When an `ownsWindows: true` backend is present, `config.app.source` is
 *     IGNORED (the backend builds & loads its own window).
 *
 * The positive tests assert that `loadAssembledSources()` also loads the main
 * window from `config.app.source` (the main window's loadURL/loadFile is called),
 * alongside the toolbar + declared windows.
 */

// ── Fakes (mirroring deck-app.test.ts's Electron fakes) ─────────────────────

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
}

interface FakeWebContentsView extends MinimalWebContentsView {
	readonly webContents: FakeWebContentsLike
	setBounds: ReturnType<typeof vi.fn> & MinimalWebContentsView['setBounds']
}

interface FakeElectron extends MinimalElectron {
	browserWindows: FakeBrowserWindow[]
	webContentsViews: FakeWebContentsView[]
	browserWindowCtorCalls: MinimalBrowserWindowOptions[]
}

function createFakeElectron(
	initialContentBounds: MinimalRect = { x: 0, y: 0, width: 1024, height: 768 },
): FakeElectron {
	let wcIdCounter = 100
	let winIdCounter = 1
	const browserWindows: FakeBrowserWindow[] = []
	const webContentsViews: FakeWebContentsView[] = []
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
			this.on = vi.fn(() => this) as FakeBrowserWindow['on']
			browserWindows.push(this as unknown as FakeBrowserWindow)
		}

		isDestroyed(): boolean {
			return this.destroyed
		}
	}

	class FakeWCV implements MinimalWebContentsView {
		readonly webContents: FakeWebContentsLike
		setBounds: FakeWebContentsView['setBounds']

		constructor() {
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
	}
}

/**
 * Typed helper so these tests compile even before `source` is added to
 * `AppConfig`. We attach `source` onto a normal `DeckConfig` via a localized
 * cast — the tests then fail on BEHAVIOR (main window not loaded), not on TS.
 */
function configWithAppSource(source: WebviewSource, base: DeckConfig = {}): DeckConfig {
	return {
		...base,
		app: { ...(base.app ?? {}), source } as DeckConfig['app'],
	}
}

describe('DeckApp — config.app.source auto-load into the main window', () => {
	it('config.app.source = { url } → main window webContents.loadURL called once with that url (framework owns window)', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp(configWithAppSource({ url: 'app://main' }), { electron })
		await app.start()

		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow
		expect(mainWin).toBeDefined()
		expect(mainWin.webContents.loadURL).toHaveBeenCalledTimes(1)
		expect(mainWin.webContents.loadURL).toHaveBeenCalledWith('app://main')
		expect(mainWin.webContents.loadFile).not.toHaveBeenCalled()

		await app.shutdown()
	})

	it('config.app.source = { file } → main window webContents.loadFile called with that path (framework owns window)', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp(configWithAppSource({ file: '/x/index.html' }), { electron })
		await app.start()

		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow
		expect(mainWin).toBeDefined()
		expect(mainWin.webContents.loadFile).toHaveBeenCalledTimes(1)
		expect(mainWin.webContents.loadFile).toHaveBeenCalledWith('/x/index.html')
		expect(mainWin.webContents.loadURL).not.toHaveBeenCalled()

		await app.shutdown()
	})

	it('no config.app.source → framework does NOT auto-load the main window (current behavior preserved)', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron })
		await app.start()

		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow
		expect(mainWin).toBeDefined()
		expect(mainWin.webContents.loadURL).not.toHaveBeenCalled()
		expect(mainWin.webContents.loadFile).not.toHaveBeenCalled()

		await app.shutdown()
	})

	it('ownsWindows:true backend present → config.app.source is IGNORED (framework does not load the main window)', async () => {
		const electron = createFakeElectron()
		// The backend owns the window: it builds + loads its own in assemble().
		// The framework must NOT build a main window NOR load config.app.source.
		const backend: RuntimeBackend = {
			ownsWindows: true,
			assemble: (runtime) => {
				// Backend builds its own window via the injected electron module.
				const electronMod = runtime.electron as unknown as MinimalElectron
				const win = new electronMod.BrowserWindow({}) as unknown as FakeBrowserWindow
				// Backend loads its OWN source — NOT app://owned.
				win.webContents.loadURL('app://backend-own')
			},
		}
		const app = new DeckApp(
			configWithAppSource({ url: 'app://owned' }, { backend }),
			{ electron, backend },
		)
		await app.start()

		// No framework-built main window content should have been loaded from
		// config.app.source. Assert that NO window's loadURL was called with the
		// ignored framework source.
		const loadedWithFrameworkSource = electron.browserWindows.some(w =>
			w.webContents.loadURL.mock.calls.some(c => c[0] === 'app://owned'),
		)
		expect(loadedWithFrameworkSource).toBe(false)

		await app.shutdown()
	})
})
