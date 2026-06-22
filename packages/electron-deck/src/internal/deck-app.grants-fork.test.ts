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
 * grants-fork — contract tests for the "make it real"
 * wiring (view-handle.md「关键文件」/ capability-and-lifecycle.md「两条 invoke 路由的硬边界」+
 *「grant 强制闸（数据形状 + 插点）」).
 *
 * THE TWO-ROUTE BOUNDARY (intent): deck-app forks the wire's host `invokeHost`
 * seam at the wiring. A privileged command name (convention: starts with
 * `layout.`) routes through `controlBus.dispatch(name, args, ctx)` — which
 * applies the grant gate (`policy = capability.policy`): no live grant for
 * `(ctx.senderId, name)` → `DECK_FORBIDDEN`; granted → the registered
 * ControlBus command handler runs. An ORDINARY command name keeps the existing
 * `this.ipc.invoke(HOST_PREFIX + name, ...)` declarative `hostServices` route,
 * with NO grant gate (trusted-may-call, unchanged).
 *
 * These specs pin that wiring: deck-app instantiates `createControlBus`, the
 * privileged-command route applies the grant gate, and the
 * `runtime.layout.command` surface is live.
 *
 * Privileged commands are reached via a typed escape hatch
 * (`runtime.layout.command(name, handler): Disposable`) because the surface is
 * not on the public `Runtime` type. Invokes are driven through the ipcMain
 * Invoke handler with a
 * `{ kind:'host', name:'layout.*', args }` request, exactly like the real wire.
 */

// ── Fakes (mirrors deck-app.test.ts) ────────────────────────────────────────

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

// ── Typed escape hatch for the not-yet-typed privileged-command surface ──────
//
// Contract suggests `runtime.layout.command(name, handler): Disposable` (or
// `runtime.privilegedCommand`). Pin `runtime.layout.command` — adjust this one
// accessor if the implementer exposes a different name.
interface PrivilegedRuntime {
	layout: {
		command(name: string, handler: (...args: JsonValue[]) => JsonValue | Promise<JsonValue>): { dispose(): void }
	}
}

function privileged(runtime: Runtime): PrivilegedRuntime {
	return runtime as unknown as PrivilegedRuntime
}

// `grants.issue` no longer requires a `targetScope`; the old `targetScope`
// helper (a raw `rootScope.child()`) is removed — a raw Scope is no longer a
// valid value for the now-optional, DeckSession-typed `targetScope` field.

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

/** The auto-trusted main window's webContents — the trusted control wc. */
function mainWc(electron: FakeElectron): FakeWebContentsLike {
	return (electron.browserWindows[0] as unknown as FakeBrowserWindow).webContents
}

/** Cast a fake webContents to the `WebContents` param `grants.issue` expects,
 *  without importing the electron type into this fake-only test. */
function controlWc(wc: FakeWebContentsLike): Parameters<Runtime['grants']['issue']>[0] {
	return wc as unknown as Parameters<Runtime['grants']['issue']>[0]
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('DeckApp — grants-fork: privileged layout.* route is grant-gated through ControlBus', () => {
	// #1 — privileged command is grant-gated: a trusted sender WITHOUT a grant
	// is denied DECK_FORBIDDEN and the handler never runs. (The fork sends
	// layout.* to controlBus.dispatch, whose grant gate default-DENIES.)
	it('privileged layout.* from a trusted sender WITHOUT a grant → DECK_FORBIDDEN, handler NOT called', async () => {
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
		const res = await invokeHost(ipcMain, wc.id, 'layout.resize', [{ w: 100 }])

		expect(res.ok).toBe(false)
		expect((res as InvokeFail).error.code).toBe('DECK_FORBIDDEN')
		expect(handler).not.toHaveBeenCalled()

		await app.shutdown()
	})

	// #2 — granted sender passes: after grants.issue covers the command, the
	// SAME trusted sender reaches the registered ControlBus handler → ok:true.
	it('granted sender → handler runs and returns ok:true with its result', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp(
			{ hostServices: { ping: () => 'pong' as JsonValue } },
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()

		const handler = vi.fn((arg: JsonValue) => ({ ok: true, echo: arg }) as JsonValue)
		privileged(app.runtime).layout.command('layout.resize', handler)

		const wc = mainWc(electron)
		// mainWc is auto-trusted, so grants.issue accepts it (it has a wcScope).
		app.runtime.grants.issue(controlWc(wc), {
			commands: ['layout.resize'],
		})

		const res = await invokeHost(ipcMain, wc.id, 'layout.resize', [{ w: 320 }])

		expect(res.ok).toBe(true)
		expect((res as InvokeOk).result).toEqual({ ok: true, echo: { w: 320 } })
		expect(handler).toHaveBeenCalledTimes(1)
		expect(handler).toHaveBeenCalledWith({ w: 320 })

		await app.shutdown()
	})

	// #3 — ordinary command is NOT gated: the fork only gates privileged names.
	// An ordinary hostServices.ping from a trusted sender with NO grant still
	// returns ok:true (the un-gated InMemoryTypedIpcRegistry route is unchanged).
	it('ordinary hostServices.ping (non-layout) from a trusted sender WITHOUT a grant still returns ok:true', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp(
			{ hostServices: { ping: () => 'pong' as JsonValue } },
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()

		const wc = mainWc(electron)
		const res = await invokeHost(ipcMain, wc.id, 'ping', [])

		expect(res.ok).toBe(true)
		expect((res as InvokeOk).result).toBe('pong')

		await app.shutdown()
	})

	// #4 — unknown privileged command: a layout.* name with NO registered
	// ControlBus command, EVEN with a grant covering it, hits dispatch's
	// "no command registered" throw → an ERROR response (not a silent ok).
	// ControlBus.dispatch throws a plain Error("no command registered: ..."),
	// which the wire serialises to a failure with NO DECK_ code (code undefined).
	it('granted but UNregistered layout.* command → error response (no command registered), NOT a silent success', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp(
			{ hostServices: { ping: () => 'pong' as JsonValue } },
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()

		const wc = mainWc(electron)
		// Grant the command name even though no ControlBus handler is registered.
		app.runtime.grants.issue(controlWc(wc), {
			commands: ['layout.ghost'],
		})

		const res = await invokeHost(ipcMain, wc.id, 'layout.ghost', [])

		expect(res.ok).toBe(false)
		// dispatch threw a plain Error → serialised failure carries no DECK_ code,
		// and crucially is NOT a forbidden/trust error: the command genuinely is
		// missing from the ControlBus command table.
		const fail = res as InvokeFail
		expect(fail.error.code).toBeUndefined()
		expect(String(fail.error.message)).toMatch(/no command registered/i)

		await app.shutdown()
	})

	// #5 — GATE ORDERING (trust-before-grant): an UNTRUSTED sender invoking
	// layout.resize is rejected by the WIRE's trust gate FIRST →
	// DECK_UNTRUSTED_SENDER. The grant gate never even sees an untrusted sender,
	// so the code is UNTRUSTED_SENDER, NOT FORBIDDEN.
	it('UNTRUSTED sender invoking layout.* → DECK_UNTRUSTED_SENDER (trust gate fires before the grant gate)', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp(
			{ hostServices: { ping: () => 'pong' as JsonValue } },
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()

		const handler = vi.fn(() => 'resized' as JsonValue)
		privileged(app.runtime).layout.command('layout.resize', handler)

		// id 9999 is not the main wc and was never trusted.
		const res = await invokeHost(ipcMain, 9999, 'layout.resize', [])

		expect(res.ok).toBe(false)
		expect((res as InvokeFail).error.code).toBe('DECK_UNTRUSTED_SENDER')
		// NOT forbidden — the trust gate short-circuits before the grant gate.
		expect((res as InvokeFail).error.code).not.toBe('DECK_FORBIDDEN')
		expect(handler).not.toHaveBeenCalled()

		await app.shutdown()
	})

	// #6 — grant revoked: after issuing then disposing the grant, the SAME
	// trusted sender is denied DECK_FORBIDDEN again (the grant gate re-denies).
	it('after the grant is disposed, layout.* from the same sender → DECK_FORBIDDEN again', async () => {
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
		const grant = app.runtime.grants.issue(controlWc(wc), {
			commands: ['layout.resize'],
		})

		// Sanity: while granted it passes.
		const granted = await invokeHost(ipcMain, wc.id, 'layout.resize', [])
		expect(granted.ok).toBe(true)

		// Revoke the grant → the gate must re-deny.
		grant.dispose()
		const afterRevoke = await invokeHost(ipcMain, wc.id, 'layout.resize', [])
		expect(afterRevoke.ok).toBe(false)
		expect((afterRevoke as InvokeFail).error.code).toBe('DECK_FORBIDDEN')

		await app.shutdown()
	})
})

// GF-1 — the `layout.* ⟺ gated` invariant is ENFORCED, not merely convention:
//  (1) runtime.layout.command THROWS for a non-`layout.` name (a privileged
//      command can ONLY be a layout.* name → always routed to the gated dispatch);
//  (2) config.hostServices THROWS at registration for any `layout.*` name (a
//      layout.* name can NEVER be on the un-gated route).
describe('DeckApp — grants-fork GF-1: the layout.* boundary is enforced (both throws)', () => {
	it('runtime.layout.command throws for a non-layout.* name', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain } })
		await app.start()

		expect(() =>
			privileged(app.runtime).layout.command('resize', () => 'x' as JsonValue),
		).toThrow(/must start with "layout\."/)

		await app.shutdown()
	})

	it('config.hostServices throws at registration when a name starts with layout.', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		// The throw happens during start() (bindDeclarativeFields), so construct +
		// start inside the assertion.
		const app = new DeckApp(
			{ hostServices: { 'layout.resize': () => 'x' as JsonValue } },
			{ electron, wireTransport: { ipcMain } },
		)
		await expect(app.start()).rejects.toThrow(/"layout\.\*" names are reserved/)
	})
})
