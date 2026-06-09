import { randomUUID } from 'node:crypto'
import type {
	Disposable,
	FrameworkEvents,
	JsonValue,
	MaybePromise,
	RuntimeBackend,
	Runtime,
	SenderPolicy,
	WebviewSource,
	WindowContribution,
	WindowCreateOptions,
	DeckConfig,
	DeckContext,
	DeckViewHandle,
	DeckSession,
	ViewPlacement,
} from '../types.js'
import { validateConfig } from '../electron-deck.js'
import { DeckChannel } from '../shared/protocol.js'
import type {
	MinimalApp,
	MinimalBrowserWindow,
	MinimalBrowserWindowOptions,
	MinimalElectron,
	MinimalWebContentsLike,
	MinimalWebContentsView,
} from './electron-types.js'
import { EventBus } from './event-bus.js'
import { InMemoryTypedIpcRegistry } from './ipc-registry-memory.js'
import { createTrustSet } from './trust-set.js'
import type { TrustSet } from './trust-set.js'
import { LifecycleManager } from './lifecycle-manager.js'
import type { LifecyclePhase } from './lifecycle-manager.js'
import { ResourceRegistryImpl } from './resource-registry.js'
import { createScope, type Scope } from '../main/scope.js'
import {
	createCompositor,
	type Compositor,
	type ContentViewHost,
	type NativeViewRef,
} from '../main/compositor.js'
import { createViewHandle } from '../main/view-handle.js'
import {
	createCapabilityRegistry,
	type CapabilityPolicy,
} from '../host/capability.js'
import {
	createControlBus,
	type ControlBus,
} from '../host/control-bus.js'
import {
	WireTransport,
	type MinimalIpcMain,
	type MinimalWebContents,
} from './wire-transport.js'

const SIMULATOR_CHANNEL_PREFIX = '__electron-deck:simulator:'
const HOST_CHANNEL_PREFIX = '__electron-deck:host:'

const DEFAULT_MAIN_WIDTH = 1024
const DEFAULT_MAIN_HEIGHT = 768

/**
 * Optional dependencies for {@link DeckApp} —— Phase 3b 用于注入真 (或
 * mock) Electron `ipcMain` + trusted webContents 集合，让 framework 接通跨进程
 * wire transport。不注入则保持 Phase 2 main-internal-only 行为。
 *
 * @internal
 */
export interface DeckAppOptions {
	readonly wireTransport?: {
		readonly ipcMain: MinimalIpcMain
		/** 默认返回 framework 内部维护的 trusted set（Phase 4 由 windows.trust 填）。 */
		readonly trustedWebContents?: () => readonly MinimalWebContents[]
		/** 自定义 senderPolicy（默认按 trusted set 判断）。 */
		readonly senderPolicy?: SenderPolicy
	}
	/**
	 * Phase 4 — 注入真 (或 fake) Electron `BrowserWindow` / `WebContentsView`
	 * 构造器；提供后 framework 会装配 mainWindow / toolbarView / declared
	 * windows，否则保持 Phase 3b electron-unavailable 行为。
	 */
	readonly electron?: MinimalElectron
	/**
	 * v2 — 领域 backend。提供后 framework 在 whenReady 前跑 `beforeReady`，
	 * 在 setup 阶段跑 `assemble(runtime)`。不提供则退化为纯框架（桩 context，
	 * 仅测试/演示用）。
	 */
	readonly backend?: RuntimeBackend
}

/**
 * Internal record for replaying window-created events into setup-time listeners
 * (#6 R3): bind 期间 ctor 已经完成时，setup 还没机会订阅；framework 缓存
 * baseline window-created 事件，setup 期间第一个 listener 注册时一次性消费
 * 整个队列（splice 0）。后续 listener 注册时队列已空，不重复 replay。
 *
 * **限制（CONTRACT）**：host 若在 setup 内注册多个 'window-created' listener，
 * 只有第一个会拿到 baseline replay；其它 listener 仅接收 runtime.windows.create()
 * 实时 emit。建议 host 用单一 listener 入口。
 */
interface PendingWindowCreated {
	window: MinimalBrowserWindow
	role: 'main' | 'toolbar' | 'host'
}

/**
 * Internal record for buffering load-failed events that fired before any
 * 'load-failed' listener was registered (D1 race fix). bind 阶段
 * loadAssembledSources() 触发的 loadURL/loadFile 是异步，rejection 的 microtask
 * 可能在 setup callback 的 await 点之间先跑，listener 还没注册。framework 在
 * fwListeners 上无 'load-failed' listener 时把 payload push 进队列；第一个
 * listener 注册时 splice 消费整个队列重放。
 */
interface PendingLoadFailed {
	source: WebviewSource
	error: unknown
}

/**
 * host-view slice 1 — per-window native-view substrate. Each tracked window
 * gets ONE `Compositor` whose {@link ContentViewHost} adapts that window's
 * `contentView`. The minimal `contentView` has no `children()`, so the host
 * adapter TRACKS the Compositor-managed views' z-order itself (the toolbar,
 * added directly to `contentView`, is invisible to this `order`). `registerView`
 * binds a view id to its native `WebContentsView` so the adapter can translate a
 * Compositor `NativeViewRef` into the real `addChildView`/`removeChildView` call.
 */
interface ViewSubstrate {
	compositor: Compositor
	windowScope: Scope
	registerView(id: string, wcv: MinimalWebContentsView): void
	/** host-view slice 1 (Bug 3a) — drop a disposed/detached view from this
	 *  substrate's registry + tracked z-order, so a long-lived window doesn't
	 *  accumulate dead views. Safe to call twice (Map.delete + guarded splice). */
	unregisterView(id: string): void
}

/**
 * Framework-internal "app" object —— `electronDeck(config)` 顶层入口的 plain-class
 * 形态，便于 Phase 2 测试驱动 lifecycle 转换。Phase 3b 加 wireTransport 注入
 * 后可接真 ipcMain；Phase 4 加 electron 注入后可装配 mainWindow / toolbarView
 * / declared windows。两者都不注入时退化为同进程内存 fake。
 *
 * @internal
 */
export class DeckApp {
	readonly config: DeckConfig

	private readonly lifecycle = new LifecycleManager()
	private readonly registry = new ResourceRegistryImpl()
	private readonly bus = new EventBus()
	private readonly ipc = new InMemoryTypedIpcRegistry()
	private readonly fwListeners = new Map<keyof FrameworkEvents, Set<(payload: unknown) => void>>()
	private readonly trustSet: TrustSet = createTrustSet()
	/** P4 Phase B — privileged-command grant registry. The policy gates
	 *  ControlBus.dispatch; grants are minted via `runtime.grants.issue`. */
	private readonly capability = createCapabilityRegistry()
	/** P4 Phase B — the grant-gated command bus for PRIVILEGED `layout.*`
	 *  commands. Constructed in `bindWireTransport` with the capability policy
	 *  injected, so `dispatch` default-DENIES any command lacking a live grant.
	 *  Privileged commands are registered via `runtime.layout.command`; ordinary
	 *  domain APIs stay on the un-gated `InMemoryTypedIpcRegistry`. */
	private controlBus: ControlBus | null = null
	/** v2 — per-webContents backend `onWindowTrusted` Disposable, so a window's
	 *  trust mirror is undone when THAT window closes (not only at teardown). */
	private readonly backendTrustDisposables = new Map<MinimalWebContents, Disposable>()
	private readonly options: DeckAppOptions
	private wireTransport: WireTransport | null = null
	/** v2 — the live wire senderPolicy, reused by buildRuntime so
	 *  `context._senderPolicy` reflects real trust instead of a `() => true` stub. */
	private wireSenderPolicy: SenderPolicy | null = null
	private mainWindow: MinimalBrowserWindow | null = null
	private toolbarView: MinimalWebContentsView | null = null
	private readonly declaredWindows = new Map<string, MinimalBrowserWindow>()
	private readonly trackedWindows = new Set<MinimalBrowserWindow>()
	/**
	 * unified-lifetime P0 (observation-only, zero-regression). The root lifetime
	 * scope of the app + a shadow map mirroring `trackedWindows`, keyed by each
	 * window's webContents, carrying a per-window child Scope. P0 is PURELY
	 * OBSERVATIONAL: these windowScopes own NO resources (no destroy/trust/wire is
	 * moved onto them), so `rootScope.close()` during shutdown is a no-op for app
	 * behaviour — it exists only to lay the foundation P1 will take over. The
	 * shadow's key set is kept in lock-step with `trackedWindows` at every
	 * maintenance point.
	 */
	private readonly rootScope: Scope = createScope()
	private readonly lifetimeShadow = new Map<
		MinimalWebContents,
		{ window: MinimalBrowserWindow, windowScope: Scope }
	>()
	/**
	 * unified-lifetime P1b: per-trusted-webContents trust record. `wcScope` is a
	 * child of the owning window's `windowScope`; it OWNS the wc's trust ref-count
	 * lease(s). When the window closes, `windowScope.close()` cascades into this
	 * `wcScope` (children-first LIFO), disposing every lease → ref-count hits 0 →
	 * the wc leaves the trust set. This replaces the imperative `deleteEntry`.
	 * A wc can be trusted more than once (framework auto-trust + host
	 * `windows.trust`), so `leases` is a Set.
	 */
	private readonly wcRecords = new Map<
		MinimalWebContents,
		{ wcScope: Scope, leases: Set<Disposable>, windowScope: Scope }
	>()
	private readonly pendingWindowCreated: PendingWindowCreated[] = []
	private readonly pendingLoadFailed: PendingLoadFailed[] = []
	/**
	 * host-view slice 1 — per-window native-view substrate, keyed by the window's
	 * webContents (same key discipline as `lifetimeShadow`). Created at both
	 * window-construction sites; dropped in `handleSubWindowClosed`.
	 */
	private readonly windowSubstrates = new Map<MinimalWebContents, ViewSubstrate>()
	/**
	 * P3 — per-adopted-window registration handle, keyed by the adopted window's
	 * webContents. `runtime.windows.adopt` is idempotent by wc identity: a second
	 * adopt of the same window returns this stored Disposable (no double-admit, no
	 * second substrate). The entry is removed when the registration is disposed
	 * (early un-adopt) or the window's windowScope closes.
	 */
	private readonly adoptedWindows = new Map<MinimalWebContents, Disposable>()
	/** host-view slice 1 — monotonic id source for `runtime.view` native views. */
	private viewSeq = 0
	/**
	 * P2 — provenance map for `runtime.scopes.create()` sessions: maps an opaque
	 * {@link DeckSession} to its internal `rootScope.child()` Scope. A WeakMap so a
	 * dropped session is GC'd; the framework holds the scope's lifetime via
	 * rootScope anyway (the session scope is a rootScope child). `runtime.view`
	 * resolves a passed session through this map — a foreign/raw Scope is absent
	 * and therefore REJECTED.
	 */
	private readonly sessions = new WeakMap<DeckSession, Scope>()
	/**
	 * keepAlive B3.2 — opt-in per-group LRU of HIDDEN keep-alive views. Group key is
	 * `lru:${max}` (all `keepAlive:{policy:'lru',max:N}` views share one group per
	 * `max`). Each group holds an ORDERED list of HIDDEN view ids (front = least
	 * recently visible = first to evict) + a map from view id to its host handle so
	 * an eviction can dispose it (→ its WebContents is destroyed). Views created
	 * without `keepAlive` never participate.
	 */
	private readonly keepAliveGroups = new Map<
		string,
		{ hidden: string[], handles: Map<string, DeckViewHandle> }
	>()
	/**
	 * slot-token registry (build-plan §2(e) / capability-and-lifecycle §A5-2):
	 * each anchored `placeIn` mints an unguessable token bound to (viewId, slotId,
	 * authorizedWcId). The `__electron-deck:place` apply path looks the token up,
	 * checks the sender is the authorized wc (anti-spoof), validates the placement,
	 * then `apply`s it. `resend` re-pushes the slot-grant (layout-subscribe replay).
	 */
	private readonly slotTokens = new Map<
		string,
		{ viewId: string, slotId: string, authorizedWcId: number, resend: () => void, apply: (placement: unknown) => void }
	>()
	private slotSeq = 0
	private _runtime: Runtime | null = null
	private startCalled = false
	private shutdownPromise: Promise<void> | null = null
	/** Set when shutdown is driven by the `will-quit` handler — the app is already
	 *  quitting, so `doShutdown()` must NOT re-`app.quit()` (re-entrant quit). */
	private quitInitiated = false
	/** v2 close machine: non-null while a close decision is awaiting (in-flight latch). */
	private closingDecisionPromise: Promise<'keep' | 'close'> | null = null
	/** v2 close machine: set once a 'close' decision is committed (guards the
	 *  window between decision-resolve and the 'closed' event). Never resets. */
	private shuttingDown = false

	constructor(config: DeckConfig, options: DeckAppOptions = {}) {
		this.config = config
		this.options = options
		// unified-lifetime P1a: rootScope owns the app-level teardown resources
		// (event bus + resource registry). Owned here so they dispose as rootScope
		// RESOURCES — which, per Scope's children-first LIFO, run AFTER every
		// windowScope child has torn down its window. This reproduces the legacy
		// "destroy all windows BEFORE registry.disposeAll()" ordering structurally,
		// without a manual loop. Own order encodes reverse disposal order: bus first
		// (disposed last), then registry (disposed first) → registry.disposeAll runs
		// before bus.unbindAll, matching the pre-P1a runShutdownCleanup sequence.
		this.rootScope.own(() => {
			this.bus.unbindAll()
		})
		this.rootScope.own(async () => {
			try {
				await this.registry.disposeAll()
			}
			catch (e) {
				console.error('[electron-deck] registry.disposeAll failed:', e)
			}
		})
	}

	get phase(): LifecyclePhase {
		return this.lifecycle.current
	}

	get runtime(): Runtime {
		if (this._runtime === null) {
			throw new Error('DeckApp.runtime is unavailable before setup phase')
		}
		return this._runtime
	}

	async start(): Promise<void> {
		if (this.startCalled) {
			throw new Error('DeckApp.start() already called')
		}
		this.startCalled = true

		// 校验在 lifecycle 转换之前；invalid config → reject，phase 不动
		validateConfig(this.config)

		// #12 C7 — half-state guard: electron + (toolbar | windows) without
		// wireTransport would leave the host with webviews that can never
		// reach back via __electron-deck:invoke. Reject early with a clear msg.
		const hasWebviewContent = !!(this.config.toolbar || this.config.windows)
		if (this.options.electron && hasWebviewContent && !this.options.wireTransport) {
			throw new Error(
				'DeckAppOptions: wireTransport.ipcMain is required when config has toolbar or windows',
			)
		}

		// v2 — pre-ready + whenReady gate. Only runs when a real `app` surface is
		// injected (production path / gate tests); legacy fakes without `app`
		// skip it and keep Phase-4 behaviour. The framework must NOT construct any
		// BrowserWindow before `whenReady` resolves in a real main process.
		const app = this.options.electron?.app
		if (app) {
			// Single-instance gate (opt-in): a second instance must quit BEFORE any
			// side effect (beforeReady bootstrap / whenReady / window). Phase stays
			// `init`.
			if (this.config.app?.singleInstance && typeof app.requestSingleInstanceLock === 'function') {
				if (!app.requestSingleInstanceLock()) {
					try { app.quit() }
					catch { /* best-effort */ }
					return
				}
			}
			if (this.options.backend?.beforeReady) {
				await this.options.backend.beforeReady(app)
			}
			else if (this.config.app?.name) {
				try { app.setName(this.config.app.name) }
				catch { /* best-effort */ }
			}
			await app.whenReady()
			this.bindAppLifecycle(app)
		}

		// #5 C6 — wrap assemble/bind in a single try; on any failure run
		// cleanupOnError() so partially-constructed windows / handlers get
		// disposed before the start() promise rejects.
		try {
			// Init → Bind
			this.lifecycle.enter('bind')
			this.bindDeclarativeFields()
			this.assembleElectron()
			this.bindWireTransport()
			// loadURL / loadFile **必须**晚于 bindWireTransport：webContents 一旦
			// 加载，preload 立刻执行；若 preload 调 framework bridge 时 ipcMain
			// handler 还没注册会 "no handler" 拒绝。先注册再加载。
			this.loadAssembledSources()

			// Bind → Setup
			this.lifecycle.enter('setup')
			this._runtime = this.buildRuntime()

			// v2 — domain assembly before the host's imperative setup escape.
			if (this.options.backend) {
				await this.options.backend.assemble(this._runtime)
			}
			if (this.config.setup) {
				await this.config.setup(this._runtime)
			}

			// Setup → Ready
			this.lifecycle.enter('ready')
		}
		catch (err) {
			await this.cleanupOnError()
			throw err
		}
	}

	/**
	 * Process-level Electron lifecycle bindings (post-whenReady, independent of
	 * `ownsWindows` — these are app events, not window events):
	 * - `will-quit` → framework teardown (idempotent via `shutdownPromise`).
	 * - `window-all-closed` → bound ONLY when `quitOnAllWindowsClosed` is set
	 *   (opt-in; omitted leaves Electron's default / the consumer's own handler).
	 * - `second-instance` → backend hook, bound only under `singleInstance`.
	 */
	private bindAppLifecycle(app: MinimalApp): void {
		app.on('will-quit', () => {
			// The app is already quitting — teardown must NOT re-`app.quit()`.
			this.quitInitiated = true
			void this.shutdown()
		})

		const quitOnAllClosed = this.config.app?.quitOnAllWindowsClosed
		if (quitOnAllClosed !== undefined) {
			app.on('window-all-closed', () => {
				if (quitOnAllClosed) {
					try { app.quit() }
					catch { /* best-effort */ }
				}
			})
		}

		if (this.config.app?.singleInstance) {
			app.on('second-instance', () => {
				this.options.backend?.onSecondInstance?.()
			})
		}
	}

	shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise
		this.shutdownPromise = this.doShutdown()
		return this.shutdownPromise
	}

	/**
	 * @internal Phase 4 windows.trust() / framework 内部添加 trusted webContents.
	 * Backend-owned / untracked-window fallback: there is no framework windowScope
	 * for these (the backend manages their lifetime), so the trust lease is owned
	 * by `rootScope` as an app-shutdown backstop. The backend still disposes the
	 * returned handle early when it untrusts / destroys its own window.
	 */
	_trustWebContents(wc: MinimalWebContents): Disposable {
		return this.trustSet.admit(wc, this.rootScope)
	}

	/**
	 * unified-lifetime P1b: admit `wc` to the trust set under `windowScope`. Gets
	 * or creates the wc's `wcScope` (a child of `windowScope`), takes a fresh
	 * `trustSet.admit(wc, wcScope)` ref-count lease OWNED BY that wcScope, and returns a
	 * one-shot host-facing Disposable that releases just THIS lease early. On
	 * `wcScope.close()` (window-close cascade) every still-held lease is disposed
	 * → ref-count zeroes → the wc leaves the set (equivalent to the old
	 * `deleteEntry`, but driven by Scope teardown and covering partially-built
	 * windows too). Idempotent registry cleanup is owned by the wcScope.
	 */
	private admitTrust(wc: MinimalWebContents, windowScope: Scope): Disposable {
		// Never trust an already-destroyed webContents. Trust is keyed/observed by
		// wc.id, which Electron REUSES — admitting a dead wc would leave a trusted
		// entry that a later window reusing the same id would inherit (privilege
		// escalation). The window's 'closed' handler is registered BEFORE this call
		// (see constructWindow), so any destruction after admit is revoked; this
		// guard closes the "destroyed before/at admit" half. Returns a no-op handle.
		if (wc.isDestroyed()) {
			return { dispose: () => {} }
		}
		let rec = this.wcRecords.get(wc)
		if (!rec) {
			const wcScope = windowScope.child()
			rec = { wcScope, leases: new Set<Disposable>(), windowScope }
			this.wcRecords.set(wc, rec)
			// Drop the registry entry when the wcScope tears down (any trigger).
			wcScope.own(() => {
				this.wcRecords.delete(wc)
			})
		}
		const record = rec
		const lease = this.trustSet.admit(wc, record.wcScope)
		record.leases.add(lease)
		let released = false
		return {
			dispose: () => {
				if (released) return
				released = true
				record.leases.delete(lease)
				lease.dispose()
			},
		}
	}

	/**
	 * @internal unified-lifetime P0 accessors (observation-only). The live shadow
	 * map mirroring `trackedWindows`, the root Scope, and a consistency assertion.
	 */
	__lifetimeShadow(): Map<MinimalWebContents, { window: MinimalBrowserWindow, windowScope: Scope }> {
		return this.lifetimeShadow
	}

	/** @internal unified-lifetime P0: the root lifetime Scope. */
	__rootScope(): Scope {
		return this.rootScope
	}

	/** @internal unified-lifetime P1b: the per-trusted-wc trust records. */
	__wcRecords(): Map<MinimalWebContents, { wcScope: Scope, leases: Set<Disposable>, windowScope: Scope }> {
		return this.wcRecords
	}

	/** @internal P4 Phase B: the live capability policy (grant gate reads it). */
	__capabilityPolicy(): CapabilityPolicy {
		return this.capability.policy
	}

	/**
	 * @internal unified-lifetime P0 invariant (A): the shadow's per-window set
	 * (the `window` of each entry) must equal `trackedWindows` membership. Throws
	 * if violated; no-op otherwise.
	 */
	__assertLifetimeConsistent(): void {
		const shadowWindows = new Set<MinimalBrowserWindow>()
		for (const entry of this.lifetimeShadow.values()) {
			shadowWindows.add(entry.window)
		}
		if (shadowWindows.size !== this.trackedWindows.size) {
			throw new Error(
				`lifetime shadow inconsistent: shadow has ${shadowWindows.size} windows, trackedWindows has ${this.trackedWindows.size}`,
			)
		}
		for (const win of this.trackedWindows) {
			if (!shadowWindows.has(win)) {
				throw new Error('lifetime shadow inconsistent: a trackedWindows member is absent from the shadow')
			}
		}
	}

	private bindDeclarativeFields(): void {
		if (this.config.events) {
			this.bus.bindDeclaredEvents(this.config.events)
		}
		if (this.config.simulatorApis) {
			for (const [name, handler] of Object.entries(this.config.simulatorApis)) {
				const d = this.ipc.handle(
					`${SIMULATOR_CHANNEL_PREFIX}${name}`,
					handler as (...args: JsonValue[]) => MaybePromise<JsonValue>,
				)
				this.registry.add(d)
			}
		}
		if (this.config.hostServices) {
			for (const [name, handler] of Object.entries(this.config.hostServices)) {
				// GF-1: ENFORCE the layout.* boundary at registration. `layout.*` names
				// are reserved for the grant-gated ControlBus (runtime.layout.command);
				// they must NEVER be registered on the un-gated declarative hostServices
				// route, or a privileged name would be reachable without a grant.
				// Together with runtime.layout.command's throw, this makes the invariant
				// `layout.* ⟺ gated` total.
				if (name.startsWith('layout.')) {
					throw new Error(
						`config.hostServices: "layout.*" names are reserved for privileged ControlBus commands `
						+ `(use runtime.layout.command); got: ${name}`,
					)
				}
				const d = this.ipc.handle(
					`${HOST_CHANNEL_PREFIX}${name}`,
					handler as (...args: JsonValue[]) => MaybePromise<JsonValue>,
				)
				this.registry.add(d)
			}
		}
	}

	/**
	 * host-view slice 1 — build a per-window {@link ViewSubstrate}. The
	 * `ContentViewHost` adapts `win.contentView` and tracks the Compositor-managed
	 * z-order in `order` (the minimal `contentView` has no `children()`). The
	 * substrate's `detachAll` is owned on `windowScope` AFTER the window's
	 * `win.destroy` own, so LIFO teardown runs detachAll (STEP1) BEFORE destroy
	 * (STEP4) — the A4 ordering.
	 */
	private createWindowSubstrate(win: MinimalBrowserWindow, windowScope: Scope): ViewSubstrate {
		const wcvById = new Map<string, MinimalWebContentsView>()
		const order: string[] = []
		const host: ContentViewHost = {
			addChildView: (ref: NativeViewRef) => {
				const wcv = wcvById.get(ref.id)
				if (!wcv) return
				// Bug 2: native call FIRST — if it throws, the tracked `order` stays
				// consistent with Electron reality (the op didn't happen) so the
				// Compositor's diff/rollback works against a truthful order. Only
				// mutate `order` AFTER the native add returns successfully.
				win.contentView.addChildView(wcv)
				const i = order.indexOf(ref.id)
				if (i >= 0) order.splice(i, 1)
				order.push(ref.id)
			},
			removeChildView: (ref: NativeViewRef) => {
				const wcv = wcvById.get(ref.id)
				if (!wcv) return
				// Bug 2: native remove FIRST, then splice `order` — a native throw
				// leaves `order` consistent with reality.
				win.contentView.removeChildView(wcv)
				const i = order.indexOf(ref.id)
				if (i >= 0) order.splice(i, 1)
			},
			get isDestroyed() {
				return win.isDestroyed()
			},
			children: () => order.map(id => ({ id })),
		}
		const compositor = createCompositor(host)
		// A4 STEP1 — owned AFTER the win.destroy own ⇒ runs BEFORE destroy (LIFO).
		// `detachAll` is optional on the interface but always present on the real
		// `createCompositor`; guard for the type only.
		windowScope.own(() => {
			compositor.detachAll?.()
		})
		return {
			compositor,
			windowScope,
			registerView: (id: string, wcv: MinimalWebContentsView) => {
				wcvById.set(id, wcv)
			},
			unregisterView: (id: string) => {
				wcvById.delete(id)
				const i = order.indexOf(id)
				if (i >= 0) order.splice(i, 1)
			},
		}
	}

	private assembleElectron(): void {
		const electron = this.options.electron
		if (!electron) return

		// v2 — a window-owning backend builds the real (domain) main window in
		// `assemble()` via its own factory. The framework must NOT create its own
		// here, or the app would show a second, empty BrowserWindow. The framework
		// still provides lifecycle / wire / trust. Backends that only react to
		// close (onMainWindowClose) leave `ownsWindows` false and use the
		// framework's window. (`runtime.mainWindow` is unset under ownsWindows.)
		if (this.options.backend?.ownsWindows) return

		// mainWindow ── framework 不主动 load 内容，host 在 setup 里自管
		const appCfg = this.config.app ?? {}
		const winCfg = appCfg.window ?? {}
		// Only write keys that are actually defined: Electron distinguishes an
		// omitted option from an explicit `undefined` (e.g. `show: undefined`
		// is treated as a provided value, not the default), so we never spread
		// `undefined` into the ctor options.
		const mainOpts: MinimalBrowserWindowOptions = {
			...(appCfg.name !== undefined ? { title: appCfg.name } : {}),
			...(appCfg.icon !== undefined ? { icon: appCfg.icon } : {}),
			width: winCfg.width ?? DEFAULT_MAIN_WIDTH,
			height: winCfg.height ?? DEFAULT_MAIN_HEIGHT,
		}
		if (winCfg.minWidth !== undefined) mainOpts.minWidth = winCfg.minWidth
		if (winCfg.minHeight !== undefined) mainOpts.minHeight = winCfg.minHeight
		if (winCfg.show !== undefined) mainOpts.show = winCfg.show
		if (winCfg.backgroundColor !== undefined) mainOpts.backgroundColor = winCfg.backgroundColor
		// webPreferences merge: config.app.window.webPreferences first, then the
		// backend's mainWindowWebPreferences() (backend keys win on collision).
		const backendPrefs = this.options.backend?.mainWindowWebPreferences?.()
		if (winCfg.webPreferences || backendPrefs) {
			mainOpts.webPreferences = { ...winCfg.webPreferences, ...backendPrefs }
		}
		const main = new electron.BrowserWindow(mainOpts)
		this.mainWindow = main
		this.trackedWindows.add(main)
		// unified-lifetime P1a: the window's lifetime is a child Scope of rootScope,
		// and that windowScope now OWNS the window's destruction. rootScope.close()
		// (shutdown) cascades into it, destroying the window as part of Scope
		// teardown rather than a manual loop. The isDestroyed() guard means an
		// externally-closed or already-destroyed window is never double-destroyed.
		const mainWindowScope = this.rootScope.child()
		mainWindowScope.own(() => {
			if (!main.isDestroyed()) main.destroy()
		})
		this.lifetimeShadow.set(main.webContents as unknown as MinimalWebContents, {
			window: main,
			windowScope: mainWindowScope,
		})
		// host-view slice 1 — per-window native-view substrate. Created AFTER the
		// `win.destroy` own above so its `detachAll` (owned inside) runs FIRST in
		// the LIFO teardown (STEP1), before win.destroy (STEP4).
		this.windowSubstrates.set(
			main.webContents as unknown as MinimalWebContents,
			this.createWindowSubstrate(main, mainWindowScope),
		)
		// Arm trust + grant revocation as the FIRST 'closed' listener — registered
		// BEFORE the backend's onMainWindowCreated hook (which may register its own
		// 'closed' listener) AND before admitTrust. This guarantees revokeWindowTrust
		// (which synchronously drops BOTH trust leases AND capability grants for the
		// window's wcs) runs FIRST in the 'closed' tick, so no other 'closed' listener
		// — backend or framework — can observe a stale trust/grant for a wc whose id
		// Electron may immediately reuse. Idempotent with the async wcScope cascade
		// and the later close-decision handler (revoke is one-shot / by-senderId).
		// Capture the main wc.id WHILE the window is alive (Bug 2, codex slot-token
		// review): reading `main.webContents` inside the 'closed' handler is a
		// post-destroy access that can throw — leaving tokens un-revoked until
		// shutdown, where a reused wc.id could then pass the authorizedWcId check.
		const mainWcId = (main.webContents as unknown as MinimalWebContents).id
		main.on('closed', () => {
			this.revokeWindowTrust(mainWindowScope)
			// slot-token leak hygiene — drop tokens authorized to the main wc (using
			// the captured id, never a post-destroy webContents read).
			this.revokeSlotTokensForWc(mainWcId)
		})
		// v2 — backend post-ctor / pre-load hook (synchronous, exactly once):
		// runs after the window exists but before any source load, so the backend
		// can attach views / listeners before the renderer starts.
		this.options.backend?.onMainWindowCreated?.(
			main as unknown as Parameters<NonNullable<RuntimeBackend['onMainWindowCreated']>>[0],
			electron as unknown as Parameters<NonNullable<RuntimeBackend['onMainWindowCreated']>>[1],
		)
		// auto-trust — the framework's ref-count lease is OWNED by the main window's
		// wcScope (child of mainWindowScope), so the window-close cascade zeroes it.
		this.admitTrust(main.webContents as unknown as MinimalWebContents, mainWindowScope)
		// v2 — let the backend mirror main-window trust into its domain set.
		// This onWindowTrusted call belongs to the **main-window-assembly seam**
		// and is therefore ownsWindows-gated: under `ownsWindows:true` we
		// early-return above (the backend builds + trusts its own main window via
		// runtime.windows.trust / runtime.windows.create), so this line is never
		// reached. The framework only auto-trusts — and notifies the backend about
		// — a main window it built itself.
		this._notifyBackendTrusted(main.webContents)
		this.pendingWindowCreated.push({ window: main, role: 'main' })
		// #8 R7 — toolbar follows mainWindow resize
		main.on('resize', () => {
			// v2 — backend repositions its overlays against the main window.
			this.options.backend?.repositionOverlays?.(
				main as unknown as Parameters<NonNullable<RuntimeBackend['repositionOverlays']>>[0],
			)
			if (!this.toolbarView || !this.config.toolbar) return
			const b = main.getContentBounds()
			this.toolbarView.setBounds({
				x: 0,
				y: 0,
				width: b.width,
				height: this.config.toolbar.height,
			})
		})
		// v2 close-decision machine. `close` is cancelable: we always
		// preventDefault first, then ask the backend whether to keep the window
		// (e.g. tear down the active session and stay) or actually close. Only a
		// 'close' decision destroys the window → fires 'closed' → shutdown.
		//   [B] closingDecisionPromise — in-flight latch: swallows re-entrant
		//       close attempts during the (possibly slow) decision.
		//   [C] shuttingDown — covers the window between decision-resolve and
		//       the 'closed' event; never resets.
		main.on('close', (e?: { preventDefault(): void }) => {
			e?.preventDefault?.()
			if (this.closingDecisionPromise) return // [B] decision in flight
			if (this.shuttingDown) return // [C] already committed to close
			// Arm the in-flight latch SYNCHRONOUSLY (via a deferred) BEFORE invoking
			// the hook, so a 'close' re-entered during a synchronous hook body can't
			// slip past [B] before the latch is set.
			let settle!: (d: 'keep' | 'close') => void
			this.closingDecisionPromise = new Promise<'keep' | 'close'>((res) => { settle = res })
			// A SYNCHRONOUS throw from onMainWindowClose must not escape the
			// listener (it already preventDefault'd, so the window would be stuck
			// open with no recovery). Fail-closed to 'close', same as a rejection.
			let decide: MaybePromise<'keep' | 'close'>
			try {
				decide = this.options.backend?.onMainWindowClose?.() ?? 'close'
			}
			catch (err) {
				console.error('[electron-deck] onMainWindowClose threw (sync); closing:', err)
				decide = 'close'
			}
			Promise.resolve(decide).then(
				d => settle(d === 'keep' ? 'keep' : 'close'),
				(err: unknown) => {
					console.error('[electron-deck] onMainWindowClose threw; closing:', err)
					settle('close')
				},
			)
			void this.closingDecisionPromise.then((decision) => {
				if (decision === 'keep') {
					this.closingDecisionPromise = null // stay; next close re-decides
					return
				}
				this.shuttingDown = true
				this.closingDecisionPromise = null
				if (!main.isDestroyed()) main.destroy() // → fires 'closed'
			})
		})
		// 'closed' revokes trust + triggers shutdown. The 'keep' path never
		// destroys, so it never reaches here. P1b: close mainWindowScope and AWAIT
		// its cascade BEFORE starting shutdown. The cascade closes the main +
		// toolbar wcScopes (its children, LIFO) → disposes their trust leases →
		// ref-count zeroes → untrusted, the Scope-teardown replacement for the old
		// imperative deleteEntry. Awaiting to COMPLETION before `shutdown()` matters
		// (codex ISSUE-1): a fire-and-forget `void close()` would pause at the
		// async boundary between the two child wcScopes while shutdown's synchronous
		// `beforeClose` prefix runs — leaving the main wc briefly trusted, unlike the
		// old synchronous deleteEntry. The cascade is cheap (trust leases + the
		// isDestroyed-guarded win.destroy no-op). `shutdown()` is reached via
		// `.finally` so it still runs if the cascade throws; rootScope.close() during
		// shutdown is idempotent over the already-closed mainWindowScope.
		main.on('closed', () => {
			// Synchronously revoke main + toolbar trust the instant the window is
			// destroyed (matches the old synchronous deleteEntry; no async-cascade
			// race can leave a destroyed wc trusted during a later beforeClose).
			this.revokeWindowTrust(mainWindowScope)
			// Then the async windowScope teardown (idempotent re-dispose of the now
			// already-revoked leases + win.destroy + wcRecords cleanup) and shutdown.
			void mainWindowScope
				.close()
				.catch((e: unknown) => { console.error('[electron-deck] mainWindowScope.close() failed:', e) })
				.finally(() => { void this.shutdown() })
		})

		// Toolbar contentWebview —— 装好 view + addChildView + setBounds + trust，
		// 但 loadURL/loadFile 推迟到 loadAssembledSources() 在 wireTransport.start
		// 之后调，避免 preload 先于 ipcMain handler 注册触发 invoke。
		if (this.config.toolbar) {
			const tb = this.config.toolbar
			const view = new electron.WebContentsView({
				webPreferences: { preload: tb.preloadPath },
			})
			this.toolbarView = view
			main.contentView.addChildView(view)
			const bounds = main.getContentBounds()
			view.setBounds({ x: 0, y: 0, width: bounds.width, height: tb.height })
			// toolbar lives in the main window → its wcScope parents under the SAME
			// mainWindowScope, so the main window's close revokes toolbar trust too.
			this.admitTrust(view.webContents as unknown as MinimalWebContents, mainWindowScope)
			this.pendingWindowCreated.push({ window: main, role: 'toolbar' })
		}

		// Declared windows —— ctor + trust，loadURL 同样推迟
		if (this.config.windows) {
			for (const [key, contrib] of Object.entries(this.config.windows)) {
				const win = this.constructWindow(contrib, /* autoTrust */ true, /* deferLoad */ true)
				this.declaredWindows.set(key, win)
				this.pendingWindowCreated.push({ window: win, role: 'host' })
			}
		}
	}

	/** Phase 4 race fix：在 wireTransport.start 之后再 loadURL/loadFile。 */
	private loadAssembledSources(): void {
		if (this.toolbarView && this.config.toolbar) {
			this.safeLoad(this.toolbarView.webContents, this.config.toolbar.source)
		}
		if (this.config.windows) {
			for (const [key, contrib] of Object.entries(this.config.windows)) {
				const win = this.declaredWindows.get(key)
				if (win) this.safeLoad(win.webContents, contrib.source)
			}
		}
	}

	/**
	 * #3 R5/C2 — load is best-effort: log + emit `load-failed` if it rejects,
	 * but never let start() reject because of a renderer load issue (we'd
	 * leave the host blocked indefinitely while the framework is otherwise
	 * happy).
	 */
	private safeLoad(wc: MinimalWebContentsLike, source: WebviewSource): void {
		if ('url' in source) {
			wc.loadURL(source.url).catch((err: unknown) => {
				console.error(`[electron-deck] loadURL("${source.url}") failed:`, err)
				this.surfaceLoadFailed(source, err)
			})
		}
		else {
			wc.loadFile(source.file).catch((err: unknown) => {
				console.error(`[electron-deck] loadFile("${source.file}") failed:`, err)
				this.surfaceLoadFailed(source, err)
			})
		}
	}

	/**
	 * D1 fix: load-failed 在 listener 注册之前到达时 buffer 到 pendingLoadFailed；
	 * 第一个 listener 注册时 splice 消费整个队列。已有 listener 时直接 emit。
	 */
	private surfaceLoadFailed(source: WebviewSource, error: unknown): void {
		const listeners = this.fwListeners.get('load-failed')
		if (listeners && listeners.size > 0) {
			this.emitFrameworkEvent('load-failed', { source, error })
			return
		}
		this.pendingLoadFailed.push({ source, error })
	}

	private bindWireTransport(): void {
		const wireOpts = this.options.wireTransport
		if (!wireOpts) return

		// Single trust authority. Two clean branches, never split:
		//
		//  - DEFAULT (no override): the internal `trustSet` is the sole authority.
		//    `senderPolicy` reads `trustSet.isTrusted(id)` and `trustedWebContents`
		//    reads `trustSet.snapshot()` — gate (isTrusted) and fanout (snapshot)
		//    are the SAME source, so `_trustWebContents()` / `runtime.windows.trust()`
		//    writes are visible to both. (Previously the default policy chained off
		//    the `trustedWebContents` *closure* instead of `trustSet`, which let a
		//    consumer override desync the gate from the internal set.)
		//
		//  - OVERRIDE: the consumer takes full authority for whatever it overrides.
		//    A custom `trustedWebContents` becomes the membership source for fanout
		//    AND (when no explicit `senderPolicy` is given) the gate derives from
		//    that SAME closure — so policy and fanout stay同源 on the override side
		//    too, never one-from-trustSet / one-from-closure. A custom `senderPolicy`
		//    replaces the gate outright. The internal `trustSet` is simply not the
		//    authority on the override branch (`windows.trust()` writes it but the
		//    consumer-supplied closure governs), which is the consumer's contract.
		const trustedWebContents = wireOpts.trustedWebContents
			?? ((): readonly MinimalWebContents[] => this.trustSet.snapshot())
		const defaultSenderPolicy: SenderPolicy = wireOpts.trustedWebContents
			? {
					// override fanout source → derive the gate from the SAME closure.
					isTrusted: (id: number): boolean => {
						for (const wc of wireOpts.trustedWebContents!()) {
							if (wc.id === id) return true
						}
						return false
					},
				}
			: {
					// default → trustSet is the single authority for both gate + fanout.
					isTrusted: (id: number): boolean => this.trustSet.isTrusted(id),
				}
		const senderPolicy = wireOpts.senderPolicy ?? defaultSenderPolicy
		// v2 — expose the live policy to buildRuntime (replaces `() => true` stub).
		this.wireSenderPolicy = senderPolicy

		// grants-fork — construct the grant-gated ControlBus BEFORE the
		// WireTransport. `CreateControlBusDeps.transport` is vestigial (the facade
		// never calls back into the wire; the wire calls `dispatch`, not the
		// reverse), so there is NO circular dependency: the ControlBus is built
		// first, then the wire's `invokeHost` reads `this.controlBus` lazily at
		// call time. Injecting `this.capability.policy` arms the grant gate.
		this.controlBus = createControlBus({
			bus: this.bus,
			trustSet: this.trustSet,
			policy: this.capability.policy,
		})

		const transport = new WireTransport({
			ipcMain: wireOpts.ipcMain,
			bus: this.bus,
			senderPolicy,
			trustedWebContents,
			// The two-route boundary (§A5-1.2 硬约束): the wire's host `invokeHost`
			// seam FORKS by command name.
			//  - PRIVILEGED `layout.*` names route through `controlBus.dispatch`,
			//    which applies the grant gate (DECK_FORBIDDEN when no live grant
			//    covers (ctx.senderId, name)). These names MUST NOT be registered
			//    in `hostServices` — they live only in the gated ControlBus command
			//    table (`runtime.layout.command`).
			//  - ORDINARY domain APIs keep the existing un-gated declarative
			//    `hostServices` route over InMemoryTypedIpcRegistry (trusted may
			//    call, no grant gate).
			invokeHost: (name, args, ctx) => {
				if (this.isPrivilegedCommandName(name)) {
					return this.controlBus!.dispatch(name, args, ctx)
				}
				return this.ipc.invoke<JsonValue>(`${HOST_CHANNEL_PREFIX}${name}`, ...args)
			},
			// simulator APIs are not privileged layout commands — unchanged.
			invokeSimulator: (name, args, _ctx) =>
				this.ipc.invoke<JsonValue>(`${SIMULATOR_CHANNEL_PREFIX}${name}`, ...args),
			declaredEvents: () =>
				this.config.events ? this.config.events.map(ev => ev.name) : [],
		})
		transport.start()
		this.wireTransport = transport
		// P5 eager-arm: arm the slot-token Place / LayoutSubscribe channels at
		// framework START (right after the wire binds) instead of lazily on the
		// first anchored placeIn. This lets a `createDeckLayoutClient` subscribe
		// before any view is placed without hitting a "no handler" reject. The
		// gate (trust + main-frame + token) lives in the handlers and is unchanged
		// by arm timing — eager arming widens no attack surface.
		this.ensureSlotChannelsArmed()
		this.registry.add({
			dispose: () => {
				transport.dispose()
			},
		})
	}

	/**
	 * The two-route boundary's privileged-name predicate (§A5-1.2 硬约束). A
	 * PRIVILEGED command name — by convention `layout.*` — routes through the
	 * grant-gated {@link ControlBus} (`controlBus.dispatch`). Ordinary domain
	 * APIs (any other name) stay on the un-gated declarative `hostServices`
	 * route. Privileged names MUST NOT be registered in `hostServices`.
	 */
	private isPrivilegedCommandName(name: string): boolean {
		return name.startsWith('layout.')
	}

	/**
	 * KA-4: warn ONCE about an invalid `keepAlive.max` (negative / non-integer /
	 * NaN). Such a view is not keep-alive-managed (the group is skipped); warning
	 * once avoids log spam when many views share the same bad config.
	 */
	private warnedInvalidKeepAliveMax = false
	private warnInvalidKeepAliveMax(max: number): void {
		if (this.warnedInvalidKeepAliveMax) return
		this.warnedInvalidKeepAliveMax = true
		console.warn(
			`[electron-deck] runtime.view keepAlive.max must be a non-negative integer (got: ${max}); `
			+ 'the view is NOT keep-alive-managed (no eviction).',
		)
	}

	private constructWindow(
		opts: WindowContribution | (WindowCreateOptions & { title?: string }),
		autoTrust: boolean,
		deferLoad = false,
	): MinimalBrowserWindow {
		const electron = this.options.electron
		if (!electron) {
			throw new Error('DeckApp.constructWindow called without electron injection')
		}
		const browserOpts: MinimalBrowserWindowOptions = {}
		if (opts.title !== undefined) browserOpts.title = opts.title
		if (opts.width !== undefined) browserOpts.width = opts.width
		if (opts.height !== undefined) browserOpts.height = opts.height
		if (opts.modal !== undefined) browserOpts.modal = opts.modal
		if (opts.preloadPath !== undefined) {
			browserOpts.webPreferences = { preload: opts.preloadPath }
		}
		if ('parent' in opts && opts.parent !== undefined) {
			browserOpts.parent = opts.parent as unknown as MinimalBrowserWindow
		}
		const win = new electron.BrowserWindow(browserOpts)
		this.trackedWindows.add(win)
		// Capture the webContents ONCE while the window is alive. Real Electron
		// fires 'closed' AFTER the window is destroyed, at which point reading
		// `win.webContents` may throw / return a different value — so every later
		// keyed lookup (shadow, wcRecords, backend-trust mirror) MUST use this
		// captured reference, never re-read `win.webContents` post-destroy. (A
		// re-read in the 'closed' handler is what silently skipped windowScope.close
		// → trust revocation leak under real Electron.)
		const wc = win.webContents as unknown as MinimalWebContents
		// unified-lifetime P1a: windowScope (child of rootScope) owns this window's
		// destruction; rootScope.close() cascades the destroy. Declared and
		// runtime.windows.create() windows both flow through here. The isDestroyed()
		// guard avoids double-destroy when the window was already closed externally.
		const windowScope = this.rootScope.child()
		windowScope.own(() => {
			if (!win.isDestroyed()) win.destroy()
		})
		this.lifetimeShadow.set(wc, {
			window: win,
			windowScope,
		})
		// host-view slice 1 — per-window native-view substrate, keyed by the
		// captured `wc`. Created AFTER the `win.destroy` own above so its
		// `detachAll` runs FIRST in the LIFO teardown (STEP1) before destroy (STEP4).
		this.windowSubstrates.set(wc, this.createWindowSubstrate(win, windowScope))
		// #2 R2 — declared / runtime-created window 'closed' only cleans up its own
		// tracked state; full framework shutdown is reserved for mainWindow. Pass the
		// CAPTURED `wc` (not a post-destroy re-read). Registered BEFORE admitTrust so
		// the revocation hook is armed before trust is admitted: combined with
		// admitTrust's isDestroyed() guard, a window destroyed at any point can never
		// leave a trusted-but-unrevoked wc (no construction gap).
		win.on('closed', () => {
			this.handleSubWindowClosed(win, wc)
		})
		if (autoTrust) {
			this.admitTrust(wc, windowScope)
			// v2 — let the backend mirror trust for framework-built windows.
			// This onWindowTrusted call is **orthogonal to ownsWindows**: it fires
			// for any window the framework itself constructs and trusts — declared
			// `config.windows` (assembleElectron) and imperative
			// `runtime.windows.create()` (buildRuntime). A window-owning backend
			// that calls runtime.windows.create() in its assemble() has explicitly
			// asked the framework to build + trust that window, so notifying it is
			// correct even under ownsWindows:true. (Contrast the main-window
			// auto-trust above, which IS ownsWindows-gated.)
			// Construction-time (window alive) → reading win.webContents is safe and
			// keeps the Like type; the map key is the same object identity as `wc`.
			this._notifyBackendTrusted(win.webContents)
		}
		if (!deferLoad) {
			this.safeLoad(win.webContents, opts.source)
		}
		return win
	}

	/**
	 * P3 — register an EXTERNALLY-created window into the framework so
	 * `runtime.view().placeIn(win)` works for it: a `rootScope.child()`
	 * windowScope, a per-window {@link ViewSubstrate}, and the TRUST lifecycle —
	 * mirroring {@link constructWindow}'s registration, but for a window the host
	 * built (e.g. under `ownsWindows:true`). The framework holds NO windowScope /
	 * substrate / trust for such a window until this call.
	 *
	 * Ordering MIRRORS the framework's own windows (constructWindow / main-window):
	 *  1) build the windowScope (child of rootScope so shutdown cascades it),
	 *  2) build + register the per-window substrate (so placeIn can resolve it),
	 *  3) for `ownership:'transfer'` ONLY, OWN `() => win.destroy()` on the
	 *     windowScope so app shutdown destroys the window; for `'observe'` the host
	 *     keeps lifetime control (the framework never destroys it),
	 *  4) arm trust+grant+slot-token revocation as the FIRST `'closed'` listener via
	 *     `prependListener` (codex R2 — runs before any external `'closed'` listener),
	 *  5) `admitTrust` AFTER the revoke listener is registered (constructWindow order).
	 *
	 * Idempotent by webContents identity: a second adopt of the same window returns
	 * the existing registration. Throws if the window/webContents is destroyed.
	 */
	private adoptWindow(
		win: MinimalBrowserWindow,
		opts?: { ownership?: 'transfer' | 'observe' },
	): Disposable {
		const wc = win.webContents as unknown as MinimalWebContents
		// SECURITY: never adopt a dead window. wc.id is reused by Electron, so
		// admitting a destroyed wc would leave trust a later window could inherit.
		if (win.isDestroyed?.() || wc.isDestroyed?.()) {
			throw new Error('runtime.windows.adopt: window is already destroyed')
		}
		// Idempotent by wc identity: an already-adopted window returns its existing
		// registration (no second substrate, no second trust lease).
		const existing = this.adoptedWindows.get(wc)
		if (existing) return existing
		// codex P3 review (MEDIUM): a window the framework ALREADY tracks (its own
		// constructed main/toolbar/declared window) must NOT be re-adopted — that
		// would replace its substrate and add a SECOND trust lease for the same wc.
		if (this.windowSubstrates.has(wc)) {
			throw new Error('runtime.windows.adopt: window is already framework-tracked (cannot adopt a framework-owned window)')
		}

		// (1) windowScope — a child of rootScope so rootScope.close() (shutdown)
		// cascades the adopted window's teardown automatically.
		const windowScope = this.rootScope.child()
		// (2) per-window substrate (mirror constructWindow) so placeIn resolves it.
		// Created BEFORE the destroy-own below in the transfer case so its detachAll
		// runs FIRST in LIFO teardown (STEP1) before win.destroy (STEP4), matching
		// the framework's own A4 ordering. (For 'observe' there is no destroy-own.)
		this.windowSubstrates.set(wc, this.createWindowSubstrate(win, windowScope))
		// (3) ownership: only OWN the destroy when TRANSFERRING the window's lifetime
		// to the framework. For 'observe' (default) the HOST owns the window — the
		// framework tears down substrate+trust but NEVER destroys the window itself.
		if (opts?.ownership === 'transfer') {
			windowScope.own(() => {
				if (!win.isDestroyed()) win.destroy()
			})
		}
		// (4) Arm trust+grant+slot-token revocation as the FIRST 'closed' listener via
		// prependListener (codex R2): it MUST run before any external 'closed' listener
		// the host registered earlier, so that listener never observes the adopted wc
		// still trusted (its id may be reused by Electron). Capture wc.id WHILE the
		// window is alive — a post-destroy webContents read inside 'closed' can throw.
		const adoptedWcId = wc.id
		const revoke = (): void => {
			this.revokeWindowTrust(windowScope)
			this.revokeSlotTokensForWc(adoptedWcId)
		}
		if (typeof win.prependListener === 'function') {
			win.prependListener('closed', revoke)
		}
		else {
			// Real Electron BrowserWindow always has prependListener; a fake lacking it
			// can't guarantee revoke-first, but trust must still be revoked on close.
			win.on('closed', revoke)
		}
		// (5) admit trust AFTER the revoke listener is armed (constructWindow order):
		// combined with admitTrust's isDestroyed() guard, a window destroyed at any
		// point can never leave a trusted-but-unrevoked wc.
		this.admitTrust(wc, windowScope)
		// Also run the synchronous revoke during the windowScope's teardown cascade
		// (un-adopt / app shutdown), so substrate+trust are torn down even when no
		// 'closed' fires (e.g. 'observe' shutdown where the host never closes it).
		// The async wcScope cascade (own() in admitTrust) is idempotent with it.
		windowScope.own(() => {
			this.windowSubstrates.delete(wc)
			this.adoptedWindows.delete(wc)
			this.revokeSlotTokensForWc(adoptedWcId)
		})

		let disposed = false
		const registration: Disposable = {
			dispose: () => {
				if (disposed) return
				disposed = true
				// codex P3 review (MEDIUM): synchronously revoke trust + grants + slot
				// tokens BEFORE the async windowScope.close(), so an un-adopt leaves NO
				// window where the wc is still observable-as-trusted after dispose()
				// returns (mirrors the synchronous 'closed' revoke). Idempotent with the
				// windowScope.close() cascade below.
				this.revokeWindowTrust(windowScope)
				this.revokeSlotTokensForWc(adoptedWcId)
				// Un-adopt: close the windowScope → cascades substrate detachAll +
				// (transfer) win.destroy + trust leases + the cleanup own above.
				void windowScope.close().catch((e: unknown) => {
					console.error('[electron-deck] adopted windowScope.close() failed:', e)
				})
			},
		}
		this.adoptedWindows.set(wc, registration)
		return registration
	}

	/**
	 * unified-lifetime P1b: synchronously revoke BOTH trust leases AND capability
	 * grants for every wc admitted under `windowScope` (the window's control wc +
	 * any siblings like the toolbar wc). Called from the window's 'closed' handler
	 * so both authorizations are gone the instant the window is destroyed —
	 * matching the old synchronous `deleteEntry` timing and closing every
	 * async-cascade race (a destroyed wc can never be observed trusted OR granted
	 * by a later shutdown/beforeClose, nor by a NEW window that reuses the same
	 * wc.id before the async scope cascade revokes it). The leases are ALSO owned
	 * by their wcScope, so the async `windowScope.close()` still runs (it disposes
	 * the already-disposed leases idempotently, plus win.destroy + wcRecords
	 * cleanup) and remains the teardown/partial-init fallback for paths where no
	 * 'closed' fires (cleanupOnError, shutdown of a never-closed window).
	 * `lease.dispose()` is synchronous (trustSet ref-count--) and one-shot, so no
	 * double-decrement; `revokeBySenderId` is likewise idempotent, so the grant's
	 * own async `senderScope.on('closed')` revoke later becomes a no-op.
	 */
	private revokeWindowTrust(windowScope: Scope): void {
		for (const [wc, rec] of this.wcRecords) {
			if (rec.windowScope === windowScope) {
				for (const lease of rec.leases) {
					lease.dispose()
				}
				// wc.id-reuse safety: synchronously drop this wc's grants too,
				// mirroring the trust-lease revocation above. `wc.id` is the
				// senderId the grant was issued with.
				this.capability.revokeBySenderId(wc.id)
			}
		}
	}

	/**
	 * Arm the wire's slot-token inbound channels (idempotent). P5 eager-arm:
	 * called once at framework start() (bindWireTransport, right after
	 * transport.start()) so a layout client can subscribe before the first
	 * anchored placeIn; the anchored `placeIn` call site is now a redundant no-op
	 * (kept for safety). No-op when there's no wire transport (main-internal-only
	 * builds can't serve a renderer slot anyway).
	 */
	private ensureSlotChannelsArmed(): void {
		this.wireTransport?.armSlotChannels(
			(senderId, slotToken, placement) => this.handleSlotPlace(senderId, slotToken, placement),
			senderId => this.handleLayoutSubscribe(senderId),
		)
	}

	/**
	 * slot-token apply path (`__electron-deck:place`). The token is the credential:
	 * look it up, verify the sender IS the wc the token was granted to (anti-spoof),
	 * validate the placement, then apply. Any failure → DROP (silent).
	 */
	private handleSlotPlace(senderId: number, slotToken: string, placement: unknown): void {
		const entry = this.slotTokens.get(slotToken)
		if (!entry) return // unknown / expired (revoked on dispose / window close)
		if (entry.authorizedWcId !== senderId) return // anti-spoof: wrong wc
		if (!isValidPlacement(placement)) return // malformed geometry
		entry.apply(placement)
	}

	/**
	 * Per-wc layout-subscribe replay (`__electron-deck:layout-subscribe`). When the
	 * authorized control wc (re)subscribes (e.g. after reload), re-push every grant
	 * it owns so it can re-bind its DOM slots. A DIFFERENT wc's subscribe never
	 * receives another wc's grants.
	 */
	private handleLayoutSubscribe(senderId: number): void {
		for (const entry of this.slotTokens.values()) {
			if (entry.authorizedWcId === senderId) entry.resend()
		}
	}

	/** Drop every slot token authorized to `wcId` (window-close / shutdown hygiene). */
	private revokeSlotTokensForWc(wcId: number): void {
		for (const [token, entry] of this.slotTokens) {
			if (entry.authorizedWcId === wcId) this.slotTokens.delete(token)
		}
	}

	private handleSubWindowClosed(win: MinimalBrowserWindow, wc: MinimalWebContents): void {
		this.trackedWindows.delete(win)
		// host-view slice 1 — drop this window's view substrate (keyed by the
		// captured `wc`). The Compositor's `detachAll` already ran via the
		// windowScope cascade (STEP1); this just clears the registry entry.
		this.windowSubstrates.delete(wc)
		// slot-token leak hygiene — drop every token authorized to this window's
		// control wc (a closed wc can't send `place` anyway, but don't leak the map).
		this.revokeSlotTokensForWc(wc.id)
		// P0 shadow: close + drop this window's child Scope, in lock-step with
		// trackedWindows. Idempotent: a repeated 'closed' finds no entry and returns
		// without touching the scope twice. Keyed by the CAPTURED `wc` — re-reading
		// `win.webContents` here (post-destroy) could miss the entry and silently
		// skip windowScope.close(), leaking the window's trust (P1b regression).
		const shadowEntry = this.lifetimeShadow.get(wc)
		if (shadowEntry) {
			this.lifetimeShadow.delete(wc)
			// Synchronously revoke this window's trust the instant it is destroyed,
			// then run the async windowScope teardown (idempotent re-dispose + clean
			// up). The sync revoke means no shutdown/beforeClose can observe this
			// destroyed wc as trusted, regardless of cascade timing.
			this.revokeWindowTrust(shadowEntry.windowScope)
			void shadowEntry.windowScope.close()
		}
		for (const [key, w] of this.declaredWindows) {
			if (w === win) {
				this.declaredWindows.delete(key)
				break
			}
		}
		// P1b: trust revocation is now a pure Scope-teardown effect — the
		// `void shadowEntry.windowScope.close()` above cascades into this wc's
		// wcScope, disposing every lease → ref-count zeroes → untrusted (wc.id-reuse
		// + leak safety). No imperative deleteEntry.
		// Undo the backend trust mirror for THIS window now (not at teardown).
		this.backendTrustDisposables.get(wc)?.dispose()
		this.emitFrameworkEvent('window-closed', { window: win as unknown as FrameworkEvents['window-closed']['window'] })
	}

	/**
	 * v2 — notify the backend that the framework has edge-trusted one of its
	 * (framework-built) webContents, so the backend can mirror it into the domain
	 * trust set. The returned Disposable is disposed when THAT window closes
	 * ({@link handleSubWindowClosed}) — honouring the contract "framework disposes
	 * on untrust / window destroy" — and is also added to the registry as a
	 * teardown safety net (e.g. the main window, which dies with the app). The
	 * wrapper is one-shot so the two paths don't double-dispose.
	 */
	private _notifyBackendTrusted(wc: MinimalWebContentsLike): void {
		const hook = this.options.backend?.onWindowTrusted
		if (!hook) return
		const d = hook(wc as unknown as MinimalWebContents)
		if (!d) return
		const key = wc as unknown as MinimalWebContents
		let disposed = false
		const once: Disposable = {
			dispose: () => {
				if (disposed) return
				disposed = true
				this.backendTrustDisposables.delete(key)
				d.dispose()
			},
		}
		this.backendTrustDisposables.set(key, once)
		this.registry.add(once)
	}

	private emitFrameworkEvent<E extends keyof FrameworkEvents>(
		event: E,
		payload: FrameworkEvents[E],
	): void {
		const set = this.fwListeners.get(event)
		if (!set || set.size === 0) return
		// Copy first to be safe against listener-time mutation
		for (const fn of Array.from(set)) {
			try {
				fn(payload as unknown)
			}
			catch (err) {
				console.error(`[electron-deck] framework listener for "${event}" threw:`, err)
			}
		}
	}

	private async cleanupOnError(): Promise<void> {
		this.lifecycle._force('cleanup')
		await this.runShutdownCleanup()
		this.lifecycle._force('destroy')
		this.lifecycle._force('quit')
	}

	private async doShutdown(): Promise<void> {
		if (this.lifecycle.current === 'quit') return

		const cur = this.lifecycle.current
		if (cur === 'ready') {
			this.lifecycle.enter('drain')
			this.lifecycle.enter('cleanup')
		}
		else {
			// 紧急 shutdown（尚未到 ready）
			this.lifecycle._force('cleanup')
		}

		await this.runShutdownCleanup()

		this.lifecycle._force('destroy')
		this.lifecycle._force('quit')

		// As the sole orchestrator, the framework owns process exit: once teardown
		// completes, quit Electron so a framework-owned app doesn't linger with no
		// windows. No-op when no app is injected (window-only fakes / hosts like
		// devtools that own their window + drive their own app lifecycle).
		// Skip when shutdown was DRIVEN BY `will-quit` (the app is already quitting):
		// re-calling `app.quit()` mid-quit re-enters the quit sequence.
		if (!this.quitInitiated) {
			try { this.options.electron?.app?.quit() }
			catch (e) { console.error('[electron-deck] app.quit() failed:', e) }
		}
	}

	private async runShutdownCleanup(): Promise<void> {
		// unified-lifetime P1b: no pre-beforeClose trust fence is needed here. Trust
		// for a destroyed window is revoked SYNCHRONOUSLY in its 'closed' handler
		// (revokeWindowTrust), so any already-destroyed window is already untrusted
		// before beforeClose runs — regardless of which shutdown trigger (a window's
		// 'closed' vs `will-quit`) got here first. LIVE windows stay correctly
		// trusted through beforeClose (their wc is still usable) and are revoked when
		// rootScope.close() below destroys them (→ 'closed' → revokeWindowTrust).

		// beforeClose await + timeout
		if (this.config.lifecycle?.beforeClose) {
			const timeoutMs = this.config.lifecycle.timeoutMs ?? 10_000
			try {
				await runWithTimeout(this.config.lifecycle.beforeClose(), timeoutMs)
			}
			catch (e) {
				console.error('[electron-deck] lifecycle.beforeClose failed/timed out:', e)
			}
		}

		// unified-lifetime P1a: teardown via rootScope.close() replaces the legacy
		// "destroy all trackedWindows in a loop, then registry.disposeAll(), then
		// bus.unbindAll()". rootScope disposes children-first LIFO: every windowScope
		// (each owning () => win.destroy()) tears down its window BEFORE rootScope's
		// directly-owned resources run — and those resources are registry.disposeAll()
		// then bus.unbindAll() (owned in the ctor, reverse-disposal order). So the
		// critical "#4 R4/C3" ordering — windows destroyed BEFORE WireTransport /
		// ipcMain handlers are removed — is preserved STRUCTURALLY, with no manual
		// loop. Each windowScope's destroy disposer is isDestroyed()-guarded, so an
		// already-closed window is skipped (no double-destroy).
		//
		// NOTE (teardown order): rootScope tears children down LIFO = reverse
		// creation order (last-created window destroyed first), the standard stack
		// discipline — intentionally replacing the old loop's creation-order
		// destroy. No consumer contract pins inter-window destroy order at app
		// shutdown; the LIFO order is the one pinned by the P0/P1 suite.
		//
		// NOTE (`mainWindow`/`toolbarView` nulled AFTER close, not before): real
		// Electron fires `'closed'` synchronously inside `win.destroy()`, so a host
		// `window-closed` listener runs DURING rootScope.close()'s cascade. The old
		// loop nulled these refs only AFTER destroying every window, so such a
		// listener still saw a live `runtime.mainWindow`. Clearing before close
		// would expose a prematurely-null ref — so we null AFTER, matching legacy.
		await this.rootScope.close()
		this.mainWindow = null
		this.toolbarView = null
		this.trackedWindows.clear()
		this.declaredWindows.clear()
		this.lifetimeShadow.clear()
		// host-view slice 1 (Bug 1): sub-window substrates self-delete per-close in
		// handleSubWindowClosed, but the MAIN window's substrate entry is never
		// removed there (main 'closed' → shutdown → here). Clear the map so no
		// substrate (main or residual) survives the app's lifetime.
		this.windowSubstrates.clear()
		// P3 belt-and-suspenders: adopted-window registrations self-delete via their
		// windowScope cleanup during the rootScope cascade; clear any residue.
		this.adoptedWindows.clear()
		// P1b belt-and-suspenders: entries self-delete via the wcScope cleanup
		// during the rootScope cascade; clear any untracked residue.
		this.wcRecords.clear()
		// slot-token registry — drop any residual tokens at app teardown.
		this.slotTokens.clear()
		// KA-2: drop any residual keep-alive groups at app teardown (each view's
		// dispose self-deletes its empty group, but clear belt-and-suspenders so no
		// group survives the app's lifetime).
		this.keepAliveGroups.clear()
	}

	private buildRuntime(): Runtime {
		const { ipc, registry, fwListeners } = this
		const electronModule = this.options.electron
		const wireIpcMain = this.options.wireTransport?.ipcMain

		const electronUnavailable = (field: string): never => {
			throw new Error(`runtime.${field} is unavailable in this build (no Electron)`)
		}
		const rawIpcMainUnavailable = (): never => {
			throw new Error('runtime.rawIpcMain is unavailable (no wireTransport.ipcMain injected)')
		}

		const context: DeckContext = {
			settings: { theme: 'light' },
			theme: 'light',
			_registry: this.registry,
			// v2 — forward the live wire senderPolicy (fail-closed when no wire);
			// the old `() => true` stub was a domain-auth bypass.
			_senderPolicy: this.wireSenderPolicy ?? { isTrusted: () => false },
		}

		const trackedWindows = this.trackedWindows
		const declaredWindows = this.declaredWindows
		const getMainWindow = (): MinimalBrowserWindow | null => this.mainWindow
		const getToolbarView = (): MinimalWebContentsView | null => this.toolbarView
		const constructWindow = (opts: WindowCreateOptions, autoTrust: boolean): MinimalBrowserWindow => {
			const win = this.constructWindow(opts, autoTrust)
			// runtime.windows.create() runs in setup/ready phase — emit
			// window-created in real time (no replay needed).
			this.emitFrameworkEvent('window-created', {
				window: win as unknown as FrameworkEvents['window-created']['window'],
				role: 'host',
			})
			return win
		}
		const emitPendingFor = (event: keyof FrameworkEvents): void => {
			// 消费式 splice(0)：第一个 listener 注册时 drain 全队列，后续 listener
			// 注册时队列空，不重复 replay（D2 修复：避免 isFirst && inSetupPhase
			// 多次回放同一份 baseline）。
			if (event === 'window-created') {
				if (this.pendingWindowCreated.length === 0) return
				const queue = this.pendingWindowCreated.splice(0)
				for (const item of queue) {
					this.emitFrameworkEvent('window-created', {
						window: item.window as unknown as FrameworkEvents['window-created']['window'],
						role: item.role,
					})
				}
			}
			else if (event === 'load-failed') {
				if (this.pendingLoadFailed.length === 0) return
				const queue = this.pendingLoadFailed.splice(0)
				for (const item of queue) {
					this.emitFrameworkEvent('load-failed', { source: item.source, error: item.error })
				}
			}
		}

		const runtime: Runtime = {
			get electron() {
				if (!electronModule) return electronUnavailable('electron')
				return electronModule as unknown as typeof import('electron')
			},
			get mainWindow() {
				const mw = getMainWindow()
				if (!mw) return electronUnavailable('mainWindow')
				return mw as unknown as typeof runtime.mainWindow
			},
			get toolbarView() {
				return (getToolbarView() ?? null) as unknown as typeof runtime.toolbarView
			},
			ipc,
			get rawIpcMain() {
				if (!wireIpcMain) return rawIpcMainUnavailable()
				return wireIpcMain as unknown as typeof import('electron').ipcMain
			},
			call: {
				simulator: async (name, ...args) =>
					ipc.invoke<JsonValue>(`${SIMULATOR_CHANNEL_PREFIX}${name}`, ...args),
				host: async (name, ...args) =>
					ipc.invoke<JsonValue>(`${HOST_CHANNEL_PREFIX}${name}`, ...args),
			},
			windows: {
				create: (opts): typeof runtime.mainWindow => {
					if (!electronModule) return electronUnavailable('windows.create')
					const autoTrust = opts.autoTrust ?? true
					const win = constructWindow(opts, autoTrust)
					return win as unknown as typeof runtime.mainWindow
				},
				get: (id): typeof runtime.mainWindow | undefined => {
					const w = declaredWindows.get(id)
					return w ? (w as unknown as typeof runtime.mainWindow) : undefined
				},
				all: (): typeof runtime.mainWindow[] => {
					const result: typeof runtime.mainWindow[] = []
					for (const w of trackedWindows) {
						if (!w.isDestroyed()) result.push(w as unknown as typeof runtime.mainWindow)
					}
					return result
				},
				trust: (win): Disposable => {
					const w = win as unknown as MinimalBrowserWindow
					const wc = w.webContents as unknown as MinimalWebContents
					// P1b: a framework-tracked window has a windowScope → admit the
					// trust lease under it so the window's close revokes it. A
					// backend-owned window (ownsWindows:true builds its own main
					// window with no framework windowScope) is NOT tracked; fall back
					// to a raw ref the BACKEND owns/disposes (unchanged from before —
					// the framework never managed those windows' lifetime).
					const tracked = this.lifetimeShadow.get(wc)
					if (tracked) {
						return this.admitTrust(wc, tracked.windowScope)
					}
					return this._trustWebContents(wc)
				},
				adopt: (win, opts): Disposable => {
					const w = win as unknown as MinimalBrowserWindow
					return this.adoptWindow(w, opts)
				},
			},
			view: (opts): DeckViewHandle => {
				if (!electronModule) return electronUnavailable('view')
				// P2 — `opts.scope` is now a DeckSession (or undefined). Resolve it to
				// the internal Scope through the provenance map. A foreign / raw Scope
				// (e.g. createScope(), or an adopted one) is absent → REJECTED, so a host
				// can't smuggle in a scope the framework didn't mint. Undefined → bind to
				// the app root (default).
				let displayScope: Scope = this.rootScope
				if (opts.scope !== undefined) {
					const resolved = this.sessions.get(opts.scope)
					if (!resolved) {
						throw new Error(
							'runtime.view: `scope` must be a DeckSession from runtime.scopes.create() '
							+ '(a foreign/raw Scope is rejected)',
						)
					}
					displayScope = resolved
				}
				const wcv = new electronModule.WebContentsView({})
				this.safeLoad(wcv.webContents, opts.source)
				const viewId = `view:${++this.viewSeq}`
				// A never-placed DEFAULT (root-scope) view has no viewScope (placeIn makes it) and
				// no session scope to cascade its teardown, so its WebContents would leak past app
				// shutdown (codex P2 review). Register a guarded WC-close on rootScope, and REMOVE
				// it once the view is placed (viewScope takes over the destroy) or disposed — so
				// the long-lived rootScope never accumulates disposers for placed/disposed views.
				//
				// NOTE: `Scope.own` (DisposableRegistry) RUNS the disposer when its handle is
				// disposed early, so we can't "silently unregister" via the handle. Instead a
				// `rootCloseDisarmed` flag makes the shutdown-time disposer a no-op once the
				// view is placed/disposed (the viewScope / catch-all then owns the close), and
				// the handle is disposed only to splice the now-no-op entry off rootScope so it
				// doesn't accumulate for the process lifetime.
				let rootCloseReg: Disposable | null = null
				let rootCloseDisarmed = false
				const disarmRootClose = (): void => {
					rootCloseDisarmed = true
					rootCloseReg?.dispose()
					rootCloseReg = null
				}
				if (displayScope === this.rootScope) {
					rootCloseReg = this.rootScope.own(() => {
						if (rootCloseDisarmed) return
						// `wc &&` guard (real-electron demo finding): on a double-teardown
						// (session-bound view at shutdown) Electron may already have nulled
						// `wcv.webContents`, so reading `.isDestroyed()` on it would throw.
						const wc = wcv.webContents
						if (wc && !wc.isDestroyed()) wc.close?.()
					})
				}
				// keepAlive B3.1: destroy the backing WebContents (guarded -> idempotent,
				// never double-closed). Leak fix: a `runtime.view` previously only
				// DETACHED its native view, leaking its renderer for the app's life.
				const closeNativeWc = (): void => {
					// `wc &&` guard (real-electron demo finding): a double-teardown
					// (e.g. a session-bound view closed by both its session scope AND the
					// rootScope cascade at shutdown) can see `wcv.webContents` already
					// nulled by Electron — reading `.isDestroyed()` on undefined throws.
					const wc = wcv.webContents
					if (wc && !wc.isDestroyed()) wc.close?.()
				}
				const nativeView = {
					ref: { id: viewId } as NativeViewRef,
					setBounds: (b: { x: number, y: number, width: number, height: number }) => wcv.setBounds(b),
					// Owned by the viewScope (AFTER detach, via view-handle's A4 order), so
					// an explicit dispose / window-close cascade / explicit-scope close
					// destroys the wc, not just detaches it.
					destroy: closeNativeWc,
				}
				// keepAlive B3.2: opt-in LRU group, only when configured. Views sharing
				// the same `max` form one group keyed `lru:${max}`.
				//
				// KA-4: validate `max`. A negative `max` would make the eviction
				// `while (hidden.length > max)` loop evict every hidden view (and a
				// fractional / NaN max is meaningless). A `max` that is not a finite
				// integer >= 0 is NOT keep-alive-managed — the view is treated as if no
				// keepAlive was passed (skip the group entirely), warned once. This is
				// safer than silently clamping (which would change LRU semantics).
				const keepAlive = opts.keepAlive
				const keepAliveMaxValid = keepAlive
					? Number.isInteger(keepAlive.max) && keepAlive.max >= 0
					: false
				if (keepAlive && !keepAliveMaxValid) {
					this.warnInvalidKeepAliveMax(keepAlive.max)
				}
				const groupKey = keepAlive && keepAliveMaxValid ? `lru:${keepAlive.max}` : null
				const keepAliveGroup = (): { hidden: string[], handles: Map<string, DeckViewHandle> } => {
					let g = this.keepAliveGroups.get(groupKey!)
					if (!g) {
						g = { hidden: [], handles: new Map() }
						this.keepAliveGroups.set(groupKey!, g)
					}
					return g
				}
				// KA-2: drop this view from its keepAlive group (hidden list + handles
				// map), deleting the group when it empties. IDEMPOTENT so it is safe to
				// fire from EVERY teardown path: the viewScope's onDispose (window-close
				// cascade OR explicit dispose OR LRU eviction → hostHandle.dispose →
				// viewScope.close) AND hostHandle.dispose directly (the never-placed view
				// has no viewScope, so onDispose never runs for it). A window-close
				// cascades the inner viewScope WITHOUT going through hostHandle.dispose,
				// so this MUST hang off the scope or the group would leak a dead handle.
				const removeFromKeepAliveGroup = (id: string): void => {
					if (!groupKey) return
					const group = this.keepAliveGroups.get(groupKey)
					if (!group) return
					group.handles.delete(id)
					const i = group.hidden.indexOf(id)
					if (i >= 0) group.hidden.splice(i, 1)
					if (group.handles.size === 0) {
						this.keepAliveGroups.delete(groupKey)
					}
				}
				const inner = createViewHandle({
					nativeView,
					scope: displayScope,
					// KA-2: fire group cleanup on viewScope teardown (covers window-close,
					// explicit dispose, AND LRU eviction). Idempotent with the hostHandle
					// .dispose() call below.
					onDispose: () => removeFromKeepAliveGroup(viewId),
				})
				// Bug 3a — remember WHICH substrate this view was placed into, so
				// dispose() can unregister its WCV from that substrate's registry +
				// z-order (preventing a long-lived window from accumulating disposed
				// views). null until first placeIn → if never placed, nothing to
				// unregister.
				let placedSubstrate: ViewSubstrate | null = null
				// slot-token minted by an anchored placeIn (undefined for un-anchored
				// placeIn). Captured so dispose() can revoke it from `slotTokens`.
				let slotToken: string | undefined
				// N3: one placeIn per host handle. A second placeIn THROWS (re-placement
				// is moveTo's job) — never overwrite the inner current/viewScope.
				let placed = false
				// Mint + register + push a slot-token anchor for an anchored placement on
				// `controlWc`/`anchor`. Shared by placeIn (first placement) and moveTo
				// (re-anchor for the dest window). Sets the captured `slotToken`.
				const mintSlotToken = (controlWc: MinimalWebContents, anchor: string): void => {
					// P5 eager-arm: the wire's Place / LayoutSubscribe channels are
					// now armed eagerly at framework start() (see bindWireTransport).
					// This call is kept for safety/idempotency — it is a no-op when the
					// channels are already armed.
					this.ensureSlotChannelsArmed()
					const authorizedWcId = controlWc.id
					const token = randomUUID()
					slotToken = token
					void ++this.slotSeq
					const grant = { viewId, slotId: anchor, slotToken: token }
					const resend = (): void => { controlWc.send(DeckChannel.SlotGrant, grant) }
					this.slotTokens.set(token, {
						viewId,
						slotId: anchor,
						authorizedWcId,
						resend,
						apply: p => { hostHandle.applyPlacement(p as ViewPlacement) },
					})
					resend()
				}
				// Chainable host-API wrapper: placeIn resolves the target window's
				// per-window substrate, registers the native view, then delegates to
				// the inner ViewHandle. placeIn/applyPlacement both return the handle.
				const hostHandle: DeckViewHandle = {
					placeIn: (win, placeOpts) => {
						// N3: re-placement is disallowed at the host level too — guard
						// BEFORE any substrate registration so a rejected re-placeIn leaves
						// no partial state. moveTo() is the only migration path.
						if (placed) {
							throw new Error('DeckViewHandle.placeIn: view already placed — use moveTo() to migrate')
						}
						const controlWc = (win as unknown as MinimalBrowserWindow).webContents
						const wc = controlWc as unknown as MinimalWebContents
						const substrate = this.windowSubstrates.get(wc)
						if (!substrate) {
							throw new Error('runtime.view().placeIn: window is not framework-tracked')
						}
						substrate.registerView(viewId, wcv)
						placedSubstrate = substrate
						inner.placeIn(
							{ compositor: substrate.compositor, windowScope: substrate.windowScope },
							{ zone: placeOpts.zone },
						)
						// codex P0 round-3 (BUG 1): mark placed the INSTANT the CORE placement
						// succeeds (registerView + inner.placeIn), BEFORE the best-effort slot
						// -grant mint/push below. The view IS placed now; if the grant `send`
						// throws, the handle must NOT stay re-placeable (a retry's public guard
						// would otherwise pass and overwrite placedSubstrate → corruption). A
						// failed slot-grant push is recoverable WITHOUT re-placing — the
						// renderer can re-subscribe (layout-subscribe replay) to get the grant.
						placed = true
						// codex P2 review: the viewScope (created by inner.placeIn) now owns
						// nativeView.destroy → wc.close at shutdown (windowScope→viewScope
						// cascade), so the rootScope guard is redundant. DISARM + drop it to
						// avoid double-handling + disposer accumulation on the long-lived
						// rootScope.
						disarmRootClose()
						// slot-token (build-plan §2(e)): an anchored placeIn binds a DOM
						// slot in the control wc to this native view. Mint an unguessable
						// token, register it (authorized to that wc), and PUSH a slot-grant
						// so the renderer learns (viewId, slotId, slotToken). The token is
						// the only credential the renderer needs to drive `place`.
						const anchor = placeOpts.anchor
						if (typeof anchor === 'string' && anchor.length > 0) {
							mintSlotToken(controlWc, anchor)
						}
						return hostHandle
					},
					moveTo: async (win, moveOpts) => {
						// Host-level orchestration around the inner (atomic) cross-window
						// move. The inner.moveTo does the native Compositor migration +
						// (rehome) Scope.adopt + rollback; the host only mutates its local
						// substrate/token bookkeeping AFTER the inner move resolves, so a
						// dest failure (inner rolls back to src) never corrupts host state.
						const destControlWc = (win as unknown as MinimalBrowserWindow).webContents
						const destWc = destControlWc as unknown as MinimalWebContents
						const destSub = this.windowSubstrates.get(destWc)
						if (!destSub) {
							throw new Error('runtime.view().moveTo: window is not framework-tracked')
						}
						const srcSub = placedSubstrate
						// Register the WCV in the DEST substrate BEFORE the inner move: the
						// dest Compositor's host adapter resolves `ref.id → wcv` to do the
						// real `addChildView`, so an unregistered dest add is a silent no-op.
						// The SRC registration stays until the move succeeds (a rollback
						// re-mounts on src, which needs its WCV still resolvable).
						destSub.registerView(viewId, wcv)
						try {
							// Atomic native + lifetime migration. If this REJECTS, the inner
							// already rolled back native/scope state to src.
							await inner.moveTo(
								{ compositor: destSub.compositor, windowScope: destSub.windowScope },
								{ zone: moveOpts.zone, rehome: moveOpts.rehome },
							)
						}
						catch (e) {
							// Dest failed → inner rolled back to src. The dest Compositor
							// snapshots/rolls back its OWN tracked order, but a native
							// addChildView that throws MID-APPLY may have leaked the WCV into
							// the dest window's contentView before throwing (the substrate's
							// tracked `order` never recorded the failed add, so the
							// Compositor rollback can't remove it). Balance it with an
							// explicit dest detach so the dest window is net-zero.
							//
							// codex P0 round-3 (BUG 2): the cleanup must be DEFENSIVE and must
							// NEVER mask the original moveTo error.
							//   - Only removeChildView if the dest WCV was ACTUALLY added (a
							//     SOURCE-commit failure never touched dest; the Compositor
							//     rollback may already have removed it) — guard on
							//     `children.includes(wcv)`, so we never double-remove nor remove
							//     a child dest never had.
							//   - Wrap the WHOLE cleanup in try/catch that swallows+logs its own
							//     error, then ALWAYS rethrow the ORIGINAL `e` — a cleanup throw
							//     can never shadow the real cause of the move failure.
							// codex P0 round-4: the two cleanup steps are INDEPENDENT — a throw in
							// the native detach must NOT skip the registry unregister (else the dest
							// substrate leaks a view it doesn't host, and a later dispose only frees
							// `placedSubstrate`=src). Each step is its own try/catch; the original
							// `e` is ALWAYS rethrown.
							const destWin = win as unknown as MinimalBrowserWindow
							try {
								// Best-effort dest detach: attempt when the WCV is a known child OR
								// when membership is UNKNOWN (`children` absent → can't verify, but a
								// leaked mid-apply add must still be detached; removeChildView of a
								// non-child is a no-op in real Electron). A SOURCE-commit failure that
								// truly never touched dest → removeChildView is a harmless no-op.
								const destChildren = destWin.contentView.children
								// `== null` covers BOTH undefined and null (a null `children` would
								// throw on `.includes` before the unregister below — codex P0 round-5).
								const maybeAttached = destChildren == null || destChildren.includes(wcv)
								if (!destWin.isDestroyed() && maybeAttached) {
									destWin.contentView.removeChildView(wcv)
								}
							}
							catch (cleanupErr) {
								console.error('[electron-deck] moveTo dest detach failed (original error rethrown):', cleanupErr)
							}
							try {
								// ALWAYS undo the dest registration so the dest substrate never tracks
								// a view it doesn't host — independent of the detach above.
								destSub.unregisterView(viewId)
							}
							catch (cleanupErr) {
								console.error('[electron-deck] moveTo dest unregister failed (original error rethrown):', cleanupErr)
							}
							throw e
						}
						// inner.moveTo succeeded → move the substrate registration: drop
						// from src now that the view lives in dest.
						srcSub?.unregisterView(viewId)
						placedSubstrate = destSub
						// codex P0 round-3 (BUG 6): a successful move ALWAYS re-mounts the
						// view VISIBLE in dest, so it is no longer hidden/evictable in its
						// (window-independent `lru:${max}`) keepAlive group. If it was on the
						// group's `hidden` list (moved while hidden), drop it — otherwise a
						// stale hidden entry would let a later eviction dispose a now-visible
						// view (and skew the LRU order). Idempotent: a no-op when the view was
						// already visible (not in the list) or has no group.
						if (groupKey) {
							const group = this.keepAliveGroups.get(groupKey)
							if (group) {
								const hi = group.hidden.indexOf(viewId)
								if (hi >= 0) group.hidden.splice(hi, 1)
							}
						}
						// Re-issue the slot-token anchor for the dest. Revoke the OLD token
						// first (a stale `place` from the src renderer drops), then mint a
						// fresh one bound to the dest control wc + dest slot.
						if (slotToken) {
							this.slotTokens.delete(slotToken)
							slotToken = undefined
						}
						const anchor = moveOpts.anchor
						if (typeof anchor === 'string' && anchor.length > 0) {
							mintSlotToken(destControlWc, anchor)
						}
					},
					applyPlacement: (p) => {
						inner.applyPlacement(p)
						// keepAlive B3.2: maintain this group's LRU of HIDDEN views.
						if (groupKey) {
							const group = keepAliveGroup()
							const dropFromHidden = (): void => {
								const i = group.hidden.indexOf(viewId)
								if (i >= 0) group.hidden.splice(i, 1)
							}
							if (p.visible) {
								// Recently used + currently visible: never evictable.
								dropFromHidden()
							}
							else {
								// KA-1: append only on the VISIBLE→HIDDEN transition. A repeated
								// `visible:false` for an ALREADY-hidden view is a no-op for LRU
								// ordering — re-appending would move it to most-recently-hidden,
								// corrupting "least-recently-VISIBLE" order. Membership guard:
								// push only if not already in the hidden list.
								if (!group.hidden.includes(viewId)) {
									group.hidden.push(viewId)
								}
								// Over budget: evict the FRONT (least-recently-visible) hidden
								// view -> dispose it (its WebContents is destroyed). `keepAlive.max`
								// is a validated non-negative integer here (groupKey is null for an
								// invalid max — KA-4 — so this block never runs for one).
								while (keepAlive && group.hidden.length > keepAlive.max) {
									const victimId = group.hidden.shift()!
									const victim = group.handles.get(victimId)
									if (victim) void victim.dispose()
								}
							}
						}
						return hostHandle
					},
					// Bug 3a — detach (inner, idempotent) THEN unregister from the
					// substrate so the disposed view leaves `wcvById` + `order`.
					// `unregisterView` is itself idempotent (Map.delete + guarded
					// splice), so a double-dispose is harmless.
					dispose: async () => {
						await inner.dispose()
						// codex P2 review: dispose already closes the WC via closeNativeWc
						// below, so the rootScope guard is now redundant — disarm + drop it
						// (no double-close, and no disposer left on the long-lived rootScope).
						disarmRootClose()
						// keepAlive B3.1: catch-all destroy for a NEVER-PLACED view (no
						// viewScope ran the destroy own). Guarded -> a no-op when the
						// viewScope already closed the wc (never double-closed).
						closeNativeWc()
						placedSubstrate?.unregisterView(viewId)
						// Revoke the slot token so a stale `place` after dispose drops.
						if (slotToken) this.slotTokens.delete(slotToken)
						// keepAlive B3.2 / KA-2: drop this view from its LRU group. Idempotent
						// + redundant-but-safe for placed views (the viewScope's onDispose
						// already ran it on inner.dispose above); REQUIRED for a never-placed
						// keepAlive view whose viewScope never existed (no onDispose fired).
						removeFromKeepAliveGroup(viewId)
					},
				}
				// keepAlive B3.2: register this handle so its group can evict/dispose it.
				if (groupKey) keepAliveGroup().handles.set(viewId, hostHandle)
				// Bug 3b — bind the display lifetime to an EXPLICIT session scope only.
				// When a DeckSession was passed, `displayScope` is its internal child of
				// rootScope; closing the session (→ scope.close()) OR app shutdown
				// cascading detaches + unregisters the view AND closes its native
				// WebContents. Exclude the rootScope default: rootScope lives the whole
				// app, so a self-dispose there would be a pointless per-view disposer that
				// accumulates on the root for the process lifetime (codex).
				if (displayScope !== this.rootScope) {
					// KA-3: RETURN the dispose promise so Scope.own awaits it — the
					// session's close() then fences the WebContents close (it does not
					// resolve until dispose settles). CATCH rejection so a dispose failure
					// is logged, not an unhandled promise rejection.
					displayScope.own(() => hostHandle.dispose().catch((e) => {
						console.error('[electron-deck] view session-scope dispose failed:', e)
					}))
				}
				return hostHandle
			},
			scopes: {
				// P2 — mint an opaque DeckSession. Internally a child of the app root,
				// so disposing it (→ scope.close()) OR app shutdown (rootScope.close
				// cascade) tears down every view bound to it. The returned handle
				// exposes ONLY dispose() — the internal Scope's adopt/child/reset
				// escape surface is never leaked. Tracked in the provenance WeakMap so
				// `runtime.view` can resolve it (and reject a foreign/raw Scope).
				create: (): DeckSession => {
					const scope = this.rootScope.child()
					const session: DeckSession = { dispose: () => scope.close() }
					this.sessions.set(session, scope)
					return session
				},
			},
			grants: {
				issue: (controlWc, opts): Disposable => {
					const wc = controlWc as unknown as MinimalWebContents
					const rec = this.wcRecords.get(wc)
					if (!rec) {
						// Cannot grant an untrusted sender — there is no wcScope to bind
						// the grant's lifetime to (wc.id-reuse safety REQUIRES the grant
						// die with the wc). Refuse rather than mint an unrevocable grant.
						throw new Error('runtime.grants.issue: webContents is not trusted (no wcScope to bind the grant to)')
					}
					// P2 — `targetScope` is optional + reserved (not consulted at
					// dispatch). When supplied it is a DeckSession; resolve it to the
					// internal Scope for storage, ignore an unresolvable/foreign one
					// (the grant gate doesn't read it yet).
					const targetScope = opts.targetScope ? this.sessions.get(opts.targetScope) : undefined
					return this.capability.issue({
						senderId: wc.id,
						senderScope: rec.wcScope,
						targetScope,
						commands: new Set(opts.commands),
					})
				},
			},
			layout: {
				// grants-fork — register a PRIVILEGED (`layout.*`) command into the
				// grant-gated ControlBus command table. A real webview→main invoke of
				// this name (after the wire's trust + main-frame gate) reaches the
				// handler ONLY when a live grant covers (senderId, name); otherwise
				// ControlBus.dispatch throws DECK_FORBIDDEN.
				command: (
					name: string,
					handler: (...args: JsonValue[]) => JsonValue | Promise<JsonValue>,
				): Disposable => {
					// GF-1: ENFORCE the layout.* boundary (not just convention). A
					// privileged command name MUST start with `layout.` so it always
					// routes to the grant-gated ControlBus dispatch (isPrivilegedCommandName
					// forks `layout.*` there). Reject any other name at registration.
					if (!name.startsWith('layout.')) {
						throw new Error(
							`runtime.layout.command: privileged command names must start with "layout." (got: ${name})`,
						)
					}
					return this.controlBus!.command(name, handler)
				},
			},
			context,
			on: <E extends keyof FrameworkEvents>(
				event: E,
				listener: (payload: FrameworkEvents[E]) => void,
			): Disposable => {
				let set = fwListeners.get(event)
				const isFirst = !set
				if (!set) {
					set = new Set()
					fwListeners.set(event, set)
				}
				const cast = listener as unknown as (payload: unknown) => void
				set.add(cast)
				// #6 R3 + D1/D2 — bind 期间已发生的 baseline 事件
				// （window-created / load-failed）在第一个 listener 注册时
				// 一次性消费式 replay。后续 listener 注册时队列空，no-op。
				// 不再检查 inSetupPhase：host 在 ready 之后注册的 first listener
				// 仍可拿到尚未被消费的 baseline（如果队列非空）。
				if (isFirst) emitPendingFor(event)
				const ref = set
				return {
					dispose: () => {
						ref.delete(cast)
					},
				}
			},
			add: d => registry.add(d),
		}
		return runtime
	}
}

/**
 * Validate an inbound `__electron-deck:place` placement before applying it.
 * `{visible:false}` is always OK; `{visible:true, bounds:{x,y,width,height}}`
 * requires width≥0 && height≥0 — x/y may be ANY finite number (negative origin
 * is legitimate for scroll-follow). Anything else is rejected.
 */
function isValidPlacement(placement: unknown): placement is ViewPlacement {
	if (placement === null || typeof placement !== 'object') return false
	const p = placement as Record<string, unknown>
	if (p.visible === false) return true
	if (p.visible !== true) return false
	const b = p.bounds
	if (b === null || typeof b !== 'object') return false
	const { x, y, width, height } = b as Record<string, unknown>
	if (typeof x !== 'number' || !Number.isFinite(x)) return false
	if (typeof y !== 'number' || !Number.isFinite(y)) return false
	if (typeof width !== 'number' || !Number.isFinite(width) || width < 0) return false
	if (typeof height !== 'number' || !Number.isFinite(height) || height < 0) return false
	return true
}

async function runWithTimeout<T>(work: MaybePromise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<never>((_, rej) => {
		timer = setTimeout(() => rej(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
	})
	try {
		return await Promise.race([Promise.resolve(work), timeout])
	}
	finally {
		if (timer !== undefined) clearTimeout(timer)
	}
}
