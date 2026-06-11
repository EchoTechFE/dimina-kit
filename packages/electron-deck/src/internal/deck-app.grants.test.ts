import { describe, expect, it, vi } from 'vitest'
import type { Disposable } from '../types.js'
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
import { createScope, type Scope } from '../main/scope.js'

/**
 * P4 Phase B — `runtime.grants.issue` integration over DeckApp.
 *
 * FAILING-FIRST: `runtime.grants` and the test accessor `app.__capabilityPolicy()`
 * do not exist yet (Phase B implementer adds them), so these are RED at RUNTIME
 * (`runtime.grants` is undefined / `__capabilityPolicy` is not a function).
 *
 * The contract these pin:
 *   • `runtime.grants.issue(controlWc, { targetScope, commands })` binds the
 *     grant's senderScope to controlWc's per-wc `wcScope` (from DeckApp trust
 *     records) and senderId to controlWc.id.
 *   • the capability policy (via the `__capabilityPolicy()` accessor) reflects the
 *     grant: allows(controlWc.id, listedCmd) true, others false.
 *   • closing the control wc's wcScope revokes the grant → wc.id-reuse safe.
 *   • an UNtrusted sender (no wcRecord) can NEVER be granted (throws OR no-op).
 *
 * The fakes below are copied verbatim from deck-app.test.ts (createFakeIpcMain /
 * createFakeElectron) — they are not exported, so this file replicates the
 * minimum it needs and stays self-contained.
 */

// ── replicated fakes (minimal subset of deck-app.test.ts) ───────────────────

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

// ── escape hatches for the (not-yet-existent) Phase B surface ───────────────

interface GrantIssueOpts {
	targetScope: Scope
	commands: readonly string[]
}

interface TestPolicy {
	allows(senderId: number, name: string): boolean
}

interface GrantsView {
	grants: {
		issue(controlWc: MinimalWebContents, opts: GrantIssueOpts): Disposable
	}
}

/** Surface runtime.grants (RUNTIME-absent until Phase B lands). */
function grantsOf(app: DeckApp): GrantsView {
	return app.runtime as unknown as GrantsView
}

/** Surface app.__capabilityPolicy() (RUNTIME-absent until Phase B lands). */
function policyOf(app: DeckApp): TestPolicy {
	return (app as unknown as { __capabilityPolicy(): TestPolicy }).__capabilityPolicy()
}

interface WcRecordsView {
	__wcRecords(): Map<MinimalWebContents, { wcScope: Scope }>
}
function wcRecordsOf(app: DeckApp): WcRecordsView {
	return app as unknown as WcRecordsView
}

function mainWc(electron: FakeElectron): MinimalWebContents {
	const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow
	return mainWin.webContents as unknown as MinimalWebContents
}

describe('runtime.grants.issue — integration over DeckApp', () => {
	// a) runtime.grants exists and issue() returns a Disposable for a trusted wc.
	it('runtime.grants exists after start() and issue(mainWc, …) returns a Disposable', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain } })
		await app.start()

		const g = grantsOf(app).grants
		expect(g).toBeDefined()
		expect(typeof g.issue).toBe('function')

		const targetScope = createScope()
		const d = g.issue(mainWc(electron), {
			targetScope,
			commands: ['layout.resize'],
		})
		expect(d).toBeDefined()
		expect(typeof d.dispose).toBe('function')

		await app.shutdown()
	})

	// b) issuing for the main control wc → policy reflects the grant (exact match).
	it('after issue for the main control wc, the capability policy allows exactly the granted command', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain } })
		await app.start()

		const wc = mainWc(electron)
		const targetScope = createScope()
		grantsOf(app).grants.issue(wc, { targetScope, commands: ['layout.resize'] })

		const policy = policyOf(app)
		expect(policy.allows(wc.id, 'layout.resize')).toBe(true)
		// non-granted command → DENY (whitelist, exact match)
		expect(policy.allows(wc.id, 'nope')).toBe(false)

		await app.shutdown()
	})

	// c) closing the main wc's wcScope revokes the grant → bound to wcScope
	//    generation = wc.id-reuse safe.
	it('closing the main control wc wcScope revokes the grant (grant bound to wcScope generation)', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain } })
		await app.start()

		const wc = mainWc(electron)
		const targetScope = createScope()
		grantsOf(app).grants.issue(wc, { targetScope, commands: ['layout.resize'] })
		expect(policyOf(app).allows(wc.id, 'layout.resize')).toBe(true)

		// close the wc's wcScope (the window-destroy authorization boundary).
		const rec = wcRecordsOf(app).__wcRecords().get(wc)
		expect(rec).toBeDefined()
		await rec!.wcScope.close()

		expect(policyOf(app).allows(wc.id, 'layout.resize')).toBe(false)

		await app.shutdown()
	})

	// c2) NEW — wc.id-reuse seal: the window's SYNCHRONOUS 'closed' handler revokes
	//     the grant immediately, BEFORE the async wcScope cascade fences. This pins
	//     that a new window reusing the same wc.id can never observe the old grant
	//     as live, mirroring the synchronous trust revocation (revokeWindowTrust).
	it('the window closed handler revokes the grant SYNCHRONOUSLY (no async wcScope fence)', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain } })
		await app.start()

		const wc = mainWc(electron)
		const targetScope = createScope()
		grantsOf(app).grants.issue(wc, { targetScope, commands: ['layout.resize'] })
		expect(policyOf(app).allows(wc.id, 'layout.resize')).toBe(true)

		// Fire the deck-app main-window 'closed' handler SYNCHRONOUSLY (its sync
		// revokeWindowTrust pass now also revokes capability grants) WITHOUT
		// awaiting the async wcScope.close() cascade.
		const mainWin = electron.browserWindows[0] as unknown as FakeBrowserWindow
		mainWin._emit('closed')

		// The grant is gone the INSTANT the window closes — asserted with NO await
		// of any scope fence in between (sync revocation = wc.id-reuse safe).
		expect(policyOf(app).allows(wc.id, 'layout.resize')).toBe(false)

		await app.shutdown()
	})

	// d) an UNtrusted sender (no wcRecord) can NEVER be granted. The implementer
	//    may THROW or return a no-op Disposable — accept either, but pin that the
	//    policy never allows that senderId.
	it('issuing for an untrusted wc (no wcRecord) can never grant: throws OR never-allows', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain } })
		await app.start()

		// a fabricated webContents that DeckApp never trusted (no wcRecord).
		const untrusted = { id: 4242, isDestroyed: () => false } as unknown as MinimalWebContents
		expect(wcRecordsOf(app).__wcRecords().has(untrusted)).toBe(false)

		const targetScope = createScope()
		let threw = false
		try {
			grantsOf(app).grants.issue(untrusted, {
				targetScope,
				commands: ['layout.resize'],
			})
		}
		catch {
			threw = true
		}

		// Whichever contract the implementer picked, the untrusted sender is NEVER
		// authorized.
		expect(policyOf(app).allows(untrusted.id, 'layout.resize')).toBe(false)
		// (threw is allowed to be true or false — both honor "never granted".)
		void threw

		await app.shutdown()
	})
})
