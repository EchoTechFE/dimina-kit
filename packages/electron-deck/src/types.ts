import type { BrowserWindow, NativeImage, WebContents, WebContentsView, ipcMain } from 'electron'
import type { MinimalApp, MinimalElectron } from './internal/electron-types.js'
import type { MinimalIpcMain, MinimalWebContents } from './internal/wire-transport.js'

export type MaybePromise<T> = T | Promise<T>

export type JsonPrimitive = string | number | boolean | null
export type JsonValue =
	| JsonPrimitive
	| { readonly [k: string]: JsonValue }
	| readonly JsonValue[]

export interface Disposable {
	dispose(): void | Promise<void>
}

/**
 * `@experimental` convention (used throughout this file)
 * --------------------------------------------------------
 * The high-level host-shell surface — `runtime.windows.*` (Window facade),
 * `runtime.view` / `DeckViewHandle`, `runtime.scopes` / `DeckSession`,
 * `runtime.grants`, `runtime.layout` — is fully built and wired, but has NO
 * production consumer yet: the only callers are `examples/layout-demo` and
 * `spike/popout`. The devtools/qdmp host integrates through the `RuntimeBackend`
 * lifecycle path with `ownsWindows:true` and never touches this surface.
 *
 * Until a SECOND, real consumer adopts it, these signatures are NOT API-stable —
 * treat them as `@experimental`. Do not assume any of it is validated against a
 * non-demo workload. Rationale + the ROI matrix that decided devtools should NOT
 * migrate onto it: packages/devtools/docs/deck-adoption-decision.md.
 */

/** Opaque session handle minted by `runtime.scopes.create()` (app-root) or
 *  `DeckWindow.newSession()` (window-rooted). Wraps a child Scope, so disposing
 *  it (or app shutdown / window close) tears down every view bound to it. Does
 *  NOT expose the internal Scope (no adopt/child escape).
 *  @experimental No production consumer yet — see the convention note above. */
export interface DeckSession {
	/** Release THIS session's views (and any other owned resources of its current
	 *  segment), keeping the session AND its window alive — a fresh segment opens. */
	reset(): Promise<void>
	/** Terminal: dispose every view bound to the session and close it. */
	dispose(): Promise<void>
}

/** A per-window close decision. `'keep'` vetoes the close; `'close'` proceeds.
 *  @experimental Only reached via the {@link DeckWindow} facade — see the
 *  convention note above. (`RuntimeBackend.onMainWindowClose` uses an inline
 *  `'keep' | 'close'`, not this alias.) */
export type WindowCloseDecision = 'keep' | 'close'
/** A cancelable per-window close decider registered via {@link DeckWindow.onClose}.
 *  @experimental No production consumer yet — see the convention note above. */
export type WindowCloseDecider = () => MaybePromise<WindowCloseDecision>

/**
 * Opaque handle over a framework-registered window (`runtime.windows.create()`
 * / `runtime.windows.main`). Exposes the BrowserWindow + its control wc, a
 * window-rooted session factory, and a per-window cancelable close decider.
 *
 * **Never exposes** the raw windowScope / substrate / trust lease.
 *
 * @experimental No production consumer yet — see the convention note above.
 */
export interface DeckWindow {
	/** The BrowserWindow this handle wraps. */
	readonly window: BrowserWindow
	/** The window's primary control WebContents (=== `window.webContents`),
	 *  captured once at registration. */
	readonly controlWc: WebContents
	/** Mint a window-rooted {@link DeckSession} (a child of this window's lifetime).
	 *  `runtime.view({ scope })` accepts it under the same provenance check as an
	 *  app-root session; closing the window cascades every session minted here. */
	newSession(): DeckSession
	/** Register a per-window cancelable close decider. On a close attempt the
	 *  framework `preventDefault()`s, runs the registered deciders in registration
	 *  order; any `'keep'` vetoes, else the window is destroyed. On the MAIN window
	 *  a live decider supersedes {@link RuntimeBackend.onMainWindowClose}. */
	onClose(decider: WindowCloseDecider): Disposable
}

/**
 * `defineEvent(name)` 创建的 HostEvent。pure factory，无 side effect —— 必须在
 * `DeckConfig.events` 中显式列出 framework 才会绑 transport。
 */
export interface HostEvent<P extends JsonValue> {
	readonly name: string
	publish(payload: P): void
	on(listener: (payload: P) => void): Disposable
}

// ── DeckConfig 顶层 ─────────────────────────────────────────────────

/**
 * Handler 形参故意宽松（`any[]`）—— host 写 `(p: { code: string }) => ...` 这种
 * narrower 签名必须能赋值给 `Record<string, Handler>`。framework 在 IPC 边界
 * 做 JSON 校验，narrower 类型在 webview-side `createDeckClient<HS, EV>()`
 * 通过 `Parameters<HS[K]>` 推断。返回值 framework 不约束 TS 类型，但 runtime
 * 强制要求 JSON-safe（非 JSON 值反序列化时报错）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SimulatorApiHandler = (...args: any[]) => unknown
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HostServiceHandler = (...args: any[]) => unknown

export interface AppConfig {
	readonly name?: string
	readonly icon?: string
	/**
	 * Optional content source for the framework-built main window. When set AND
	 * the framework owns the main window (NOT an `ownsWindows:true` backend), the
	 * framework auto-loads it after the window is built, via the same safeLoad path
	 * the toolbar / declared windows use. Omitted → the host owns the load. Ignored
	 * under an `ownsWindows:true` backend (the backend builds + loads its own window).
	 */
	readonly source?: WebviewSource
	/**
	 * Opt-in process-lifecycle: bind `window-all-closed`. Omitted → the framework
	 * does NOT touch `window-all-closed` (Electron's default, or the consumer's own
	 * handler, applies). `true` → quit when all windows close; `false` → bind but
	 * suppress the default quit.
	 */
	readonly quitOnAllWindowsClosed?: boolean
	/**
	 * Opt-in single-instance lock. When true, `start()` acquires the OS
	 * single-instance lock before `whenReady`; a second instance quits immediately.
	 * `second-instance` is forwarded to {@link RuntimeBackend.onSecondInstance}.
	 */
	readonly singleInstance?: boolean
	readonly window?: {
		readonly width?: number
		readonly height?: number
		readonly minWidth?: number
		readonly minHeight?: number
		readonly show?: boolean
		readonly backgroundColor?: string
		readonly webPreferences?: Record<string, unknown>
	}
}

export type WebviewSource = { readonly url: string } | { readonly file: string }

export interface ToolbarContribution {
	readonly source: WebviewSource
	/** 必填：host 完全控制 preload */
	readonly preloadPath: string
	/** 必填：固定高度（px）；宽度自动跟随主窗口 */
	readonly height: number
}

export interface WindowContribution {
	readonly title?: string
	readonly source: WebviewSource
	readonly preloadPath?: string
	readonly width?: number
	readonly height?: number
	readonly modal?: boolean
}

export interface MenuContribution {
	build(ctx: MenuBuildContext): void
}

export interface MenuBuildContext {
	readonly mainWindow: BrowserWindow
	readonly appName: string
	readonly theme: 'light' | 'dark'
}

export interface LifecycleContribution {
	/**
	 * 在主窗口关闭 / app 退出之前调用，await 完成；超时则 log error 后继续 shutdown 流程（不阻止关闭）。
	 * host 如需更细粒度（区分 close 与 quit），用 `setup(runtime)` 内
	 * `runtime.electron.app.on('before-quit', ...)` escape。
	 */
	readonly beforeClose?: () => MaybePromise<void>
	/** beforeClose 超时（ms），默认 10_000 */
	readonly timeoutMs?: number
}

/**
 * 顶层 `electronDeck(config, options?)` 的第二参数。
 *
 * **生产路径**：缺省即可——framework lazy `await import('electron')` 取真
 * `ipcMain` / `BrowserWindow` / `WebContentsView`。host 在 Electron main 进程
 * 入口直接 `electronDeck(config)`，不需要手动注入。
 *
 * **测试 / 非 Electron 环境**：完全显式注入 `{ electron, ipcMain }` 即可绕过
 * lazy import（vitest 跑 `await import('electron')` 会解析到 Electron 安装包
 * 的 entry stub —— 它导出可执行路径字符串而非 main-process module，所以
 * `ipcMain` / `BrowserWindow` 都是 undefined。framework 用 lazy import 时若
 * 取不到 `ipcMain` 会抛清晰错误，提示注入。
 *
 * `trustedWebContents` / `senderPolicy` 是可选 override —— 缺省 framework 用
 * 内部维护的 trusted set + 默认 isTrusted 策略。
 *
 * 注意：`backend` 不在这里——它是「这个 deck 跑什么领域装配」的配置，属于
 * {@link DeckConfig}，不是测试注入旋钮。
 */
export interface DeckOptions {
	/** 注入自定义 Electron（测试 fake 或 production override）。缺省时 framework lazy import 真 electron。 */
	readonly electron?: MinimalElectron
	/** 注入 ipcMain；缺省时 framework 用 lazy-imported electron.ipcMain。 */
	readonly ipcMain?: MinimalIpcMain
	/** 自定义 trustedWebContents 回调；默认走 framework 内部维护 set。 */
	readonly trustedWebContents?: () => readonly MinimalWebContents[]
	/** 自定义 senderPolicy；默认按 trusted 集判断。 */
	readonly senderPolicy?: SenderPolicy
}

export interface DeckConfig {
	readonly app?: AppConfig
	/**
	 * 领域 backend。提供后 framework 跑 `beforeReady`(pre-ready) + `assemble`
	 * (setup)，并把 main-window 装配让给 backend（framework 不建自己的窗口）。
	 * backend host 的主入口字段：`electronDeck({ backend })`——无需空 `{}` + options。
	 */
	readonly backend?: RuntimeBackend
	/** 暴露给小程序，自动投影为 `wx.<name>` */
	readonly simulatorApis?: Record<string, SimulatorApiHandler>
	/** 暴露给 trusted webview（toolbar 等）的 RPC */
	readonly hostServices?: Record<string, HostServiceHandler>
	/** main → webview 推送；必须显式列出，避免 module load order 隐式注册 */
	readonly events?: readonly HostEvent<JsonValue>[]
	readonly toolbar?: ToolbarContribution
	readonly windows?: Record<string, WindowContribution>
	readonly menu?: MenuContribution
	readonly lifecycle?: LifecycleContribution
	/** Imperative escape：声明表达不了的运行时操作 */
	readonly setup?: (runtime: Runtime) => MaybePromise<void>
}

// ── Runtime ──────────────────────────────────────────────────────────────

export interface TypedIpcRegistry {
	handle<A extends JsonValue[], R extends JsonValue>(
		channel: string,
		handler: (...args: A) => MaybePromise<R>,
		options?: {
			validator?: (args: unknown[]) => A
		},
	): Disposable
	on<P extends JsonValue>(channel: string, listener: (payload: P) => void): Disposable
	send(target: 'mainWindow' | BrowserWindow, channel: string, payload: JsonValue): void
}

export interface SettingsSnapshot {
	readonly theme: 'light' | 'dark'
	readonly [k: string]: JsonValue
}

export interface SenderPolicy {
	/** trusted webContentsId set，框架内部维护；@internal */
	isTrusted(senderId: number): boolean
}

export interface ResourceRegistry {
	/** @internal LIFO dispose */
	add(d: Disposable | (() => MaybePromise<void>)): Disposable
	disposeAll(): Promise<void>
}

export interface DeckContext {
	readonly settings: SettingsSnapshot
	readonly theme: 'light' | 'dark'
	/** @internal unsupported escape；破坏 I1/I2/I3 服务承诺 */
	readonly _registry: ResourceRegistry
	/** @internal unsupported escape */
	readonly _senderPolicy: SenderPolicy
}

export interface FrameworkEvents {
	'window-created': { window: BrowserWindow; role: 'main' | 'toolbar' | 'host' }
	'window-closed': { window: BrowserWindow }
	/** webContents.loadURL/loadFile 失败时 emit。framework 不 reject start()，host 可订阅做兜底/重试 */
	'load-failed': { source: WebviewSource; error: unknown }
}

/** @experimental Window facade option bag — no production consumer yet (see the
 *  convention note above). */
export interface WindowCreateOptions {
	readonly source: WebviewSource
	readonly preloadPath?: string
	readonly width?: number
	readonly height?: number
	readonly modal?: boolean
	readonly parent?: BrowserWindow
	/** 默认 true */
	readonly autoTrust?: boolean
}

/** A screen-space rectangle (CSS px), mirroring the `view-handle` `Bounds`.
 *  @experimental Part of the host-view surface — no production consumer yet (see
 *  the convention note above). */
export interface ViewBounds {
	readonly x: number
	readonly y: number
	readonly width: number
	readonly height: number
}

/**
 * Explicit visibility + geometry for a host-managed native view. Structurally
 * identical to the internal `view-handle` `Placement`; re-declared here so the
 * public `Runtime` surface adds no internal-module dependency.
 *
 * @experimental Part of the host-view surface — no production consumer yet (see
 * the convention note above).
 */
export type ViewPlacement = { readonly visible: true; readonly bounds: ViewBounds } | { readonly visible: false }

/** Options for {@link Runtime.view}.
 *  @experimental No production consumer yet — see the convention note above. */
export interface ViewCreateOptions {
	readonly source: WebviewSource
	/** The view's home lifetime — a {@link DeckSession} from
	 *  `runtime.scopes.create()`. Disposing the session detaches + unregisters the
	 *  view (display teardown) and closes its native WebContents; because the
	 *  session is a child of the app root, app shutdown also cascades into it.
	 *  Omitting it binds the view to the app root (no per-session teardown; the
	 *  view's display still tears down with its placeIn window, and shutdown closes
	 *  it). A raw/foreign Scope is REJECTED — only a session minted by
	 *  `runtime.scopes.create()` is accepted (provenance check). */
	readonly scope?: DeckSession
	/**
	 * Opt-in keep-alive eviction policy (opt-in LRU helper). When set, the framework disposes
	 * the least-recently-VISIBLE HIDDEN view in this view's group once the group's
	 * HIDDEN count exceeds `max` — destroying that view's native WebContents.
	 * Currently-visible views are NEVER evicted. Views sharing the same `max` form
	 * one group. Omitting `keepAlive` → the framework evicts nothing (pure host
	 * management; the host decides what to keep).
	 */
	readonly keepAlive?: { readonly policy: 'lru', readonly max: number }
}

/**
 * A host-API handle over ONE native view (`runtime.view(...)`). Chainable:
 * `placeIn` and `applyPlacement` both return the handle so calls compose.
 * `dispose` detaches the view and makes the placement sink inert.
 *
 * @experimental No production consumer yet — see the convention note above.
 */
export interface DeckViewHandle {
	/** Mount the native view into `window`'s content view at the given zone.
	 *  `anchor` is accepted + stored for the future slot-token step (unused in
	 *  slice 1). Chainable. */
	placeIn(window: BrowserWindow, opts: { zone?: number; anchor?: string }): DeckViewHandle
	/** Drive the native view's visibility + bounds. `visible:true` (re)mounts and
	 *  sets bounds directly; `visible:false` detaches but keeps the view alive.
	 *  A frame after `dispose` is dropped. Chainable. */
	applyPlacement(placement: ViewPlacement): DeckViewHandle
	/** Migrate the placed view to another window (the ONLY re-placement path —
	 *  placeIn twice throws). Moves the per-window substrate registration + re-issues
	 *  the slot-token anchor for the dest; atomic (rolls back to the source on dest
	 *  failure). `rehome:true` re-parents the view's lifetime to the dest window. */
	moveTo(win: BrowserWindow, opts: { zone?: number; anchor?: string; rehome?: boolean }): Promise<void>
	/** Tear down this placement (detach the native view, disable the sink). */
	dispose(): Promise<void>
	/** The native view's `WebContents`. Available immediately — the handle owns
	 *  its view before any `placeIn`, so a caller can recover the WebContents (and
	 *  its bounds/screenshot below) without diffing `mainWindow.contentView.children`. */
	readonly webContents: WebContents
	/** The view's LIVE screen-space rect when it is currently placed AND visible;
	 *  `null` before any placement, after `applyPlacement({visible:false})`, and
	 *  after `dispose()`. */
	bounds(): ViewBounds | null
	/** Capture the native view as a `NativeImage` (pass-through to the view's
	 *  `webContents.capturePage()`). */
	capturePage(): Promise<NativeImage>
}

export interface Runtime {
	readonly electron: typeof import('electron')
	readonly mainWindow: BrowserWindow
	readonly toolbarView: WebContentsView | null

	readonly ipc: TypedIpcRegistry
	readonly rawIpcMain: typeof ipcMain

	readonly call: {
		simulator(name: string, ...args: JsonValue[]): Promise<JsonValue>
		host(name: string, ...args: JsonValue[]): Promise<JsonValue>
	}

	/** @experimental Window facade — no production consumer yet (see the
	 *  convention note near the top of this file). */
	readonly windows: {
		create(opts: WindowCreateOptions): DeckWindow
		get(id: string): BrowserWindow | undefined
		all(): BrowserWindow[]
		/** The framework-built main window's {@link DeckWindow}, or `null` when the
		 *  framework does not own a main window (e.g. an `ownsWindows:true` backend). */
		readonly main: DeckWindow | null
		trust(win: BrowserWindow): Disposable
		/**
		 * Register an EXTERNALLY-created window (one the host built itself, e.g.
		 * under a `ownsWindows:true` backend) into the framework: its windowScope,
		 * per-window native-view substrate, and TRUST lifecycle — so
		 * `runtime.view().placeIn(win)` works for it. Trust + slot-tokens + grants
		 * for the window's webContents are revoked SYNCHRONOUSLY and FIRST on the
		 * window's `'closed'` (the framework arms its revoke via `prependListener`,
		 * so it runs before any external `'closed'` listener the host registered
		 * earlier — a host listener must never observe a still-trusted wc whose id
		 * Electron may immediately reuse).
		 *
		 * Idempotent by webContents identity: adopting the same window twice returns
		 * the existing registration (no second substrate, no double trust lease).
		 * Throws if the window (or its webContents) is already destroyed — a dead
		 * wc.id could be reused, so admitting one would be a privilege-escalation
		 * hazard.
		 *
		 * `ownership`:
		 *  - `'transfer'` → the framework owns the window's lifetime and destroys it
		 *    at app shutdown (as it does for its own windows).
		 *  - `'observe'` (default) → the HOST owns the window's lifetime; the
		 *    framework NEVER calls `destroy()` on it, but still tears down the
		 *    substrate + trust when the registration is disposed or the app shuts down.
		 *
		 * The returned {@link Disposable} un-adopts the window early (tears down its
		 * substrate + trust); it is idempotent.
		 */
		adopt(win: BrowserWindow, opts?: { ownership?: 'transfer' | 'observe' }): Disposable
	}

	/** Create a host-managed native view and return a chainable handle. Throws
	 *  if the build has no Electron (mirrors `windows.create`).
	 *  @experimental No production consumer yet — see the convention note above. */
	view(opts: ViewCreateOptions): DeckViewHandle

	/** Session factory. `create()` mints an opaque {@link DeckSession} (internally
	 *  a child of the app root) — the ONLY legitimate source of a `scope` for
	 *  `runtime.view`. Disposing the session tears down every view bound to it;
	 *  app shutdown also cascades into it.
	 *  @experimental No production consumer yet — see the convention note above. */
	readonly scopes: {
		create(): DeckSession
	}

	/** @experimental Capability/grant surface — no production consumer yet (see
	 *  the convention note near the top of this file). */
	readonly grants: {
		/** Authorize `controlWc` to invoke the given privileged commands. The grant
		 *  is revoked automatically when the control wc's lifetime Scope resets
		 *  (navigation) or closes (destroy) — wc.id-reuse safe. Throws if `controlWc`
		 *  is not trusted.
		 *
		 *  `@experimental` `targetScope` is OPTIONAL and currently INERT: when supplied
		 *  it is stored as the authorization boundary for FUTURE per-target view-command
		 *  checks, but the current grant gate authorizes by (senderId, command-name)
		 *  only — no command resolves a target view yet, so targetScope is NOT consulted
		 *  at dispatch. Passing it today has no effect; do not rely on it for isolation. */
		issue(controlWc: WebContents, opts: { commands: readonly string[]; targetScope?: DeckSession }): Disposable
	}

	/** @experimental Privileged-command surface — no production consumer yet (see
	 *  the convention note near the top of this file). */
	readonly layout: {
		/** Register a PRIVILEGED command (must be a `layout.*` name) handled through
		 *  the capability-gated ControlBus. A caller can only invoke it if a live
		 *  grant covers (senderId, name); otherwise DECK_FORBIDDEN. Ordinary domain
		 *  APIs go in `hostServices` (un-gated) — never register privileged names there. */
		command(name: string, handler: (...args: JsonValue[]) => JsonValue | Promise<JsonValue>): Disposable
	}

	readonly context: DeckContext

	on<E extends keyof FrameworkEvents>(
		event: E,
		listener: (payload: FrameworkEvents[E]) => void,
	): Disposable

	add(d: Disposable | (() => MaybePromise<void>)): Disposable
}

// ── RuntimeBackend ─────────────────────────────────────────────────────────

/**
 * Frame-aware sender identity for trust checks. `frame` is null when the
 * platform cannot resolve a sender frame (e.g. some sync paths / destroyed
 * frames) — callers decide fail-closed vs sender-level fallback per channel.
 */
export interface TrustedSenderRef {
	readonly webContentsId: number
	readonly frame: {
		readonly url: string
		readonly isMainFrame: boolean
		readonly processId: number
		readonly routingId: number
	} | null
}

/**
 * Domain backend injected into the framework. The framework owns process
 * lifecycle / windows / wire / trust primitives; the backend supplies the
 * domain assembly (real context, mainWindow content, projects/simulator/views,
 * IPC modules) the framework is deliberately ignorant of. All hooks except
 * `assemble` are optional; absent hooks fall back to framework defaults.
 *
 * @internal exported via `/host` for backend implementers.
 */
export interface RuntimeBackend {
	/**
	 * When true, the backend builds the main window itself (in `assemble`) and
	 * the framework skips its own window/toolbar/declared-window assembly — used
	 * by hosts whose window needs construction-time options the generic factory
	 * can't express (e.g. a per-session preload partition). Default false: the
	 * framework owns the window and the backend only reacts (onMainWindowClose).
	 */
	readonly ownsWindows?: boolean
	/**
	 * Pre-ready side effects (scheme/protocol registration, command-line
	 * switches, app name). Runs after electron is resolved but BEFORE
	 * `app.whenReady()`; receives the framework's resolved {@link MinimalApp}.
	 * Throwing aborts start() via cleanupOnError.
	 */
	beforeReady?(app: MinimalApp): MaybePromise<void>
	/**
	 * Domain assembly. Runs in setup phase, after the runtime skeleton is built
	 * and the wire transport is live. Loads the main renderer, registers domain
	 * IPC modules, stands up simulator/CDP/views, etc.
	 */
	assemble(runtime: Runtime): MaybePromise<void>
	/**
	 * Construction-time `webPreferences` for the framework-built main window.
	 * Called once, synchronously, BEFORE `new BrowserWindow(...)` in the
	 * `ownsWindows` falsy path. The returned prefs are merged into the window's
	 * `webPreferences` and take precedence over `config.app.window.webPreferences`
	 * on key collision. Only consulted when the framework owns the main window.
	 */
	mainWindowWebPreferences?(): Record<string, unknown> | undefined
	/**
	 * Called once, synchronously, AFTER the framework constructs the main window
	 * and BEFORE any content load (loadFile/loadURL). Receives the framework-built
	 * main window and the injected electron module so the backend can attach
	 * listeners / views / state before the renderer starts. Only fires in the
	 * `ownsWindows` falsy path.
	 */
	onMainWindowCreated?(win: BrowserWindow, electron: typeof import('electron')): void
	/**
	 * Called when the framework edge-trusts one of its webContents — covers the
	 * framework-built main window as well as framework-built declared / host /
	 * runtime-created windows. Lets the backend mirror trust into the domain
	 * trust set. Returns a Disposable the framework disposes on untrust / window
	 * destroy.
	 */
	onWindowTrusted?(wc: MinimalWebContents): Disposable
	/**
	 * Main-window `close` decision (cancelable). `'keep'` → framework keeps the
	 * window (backend has already torn down its session / navigated back);
	 * `'close'` → framework destroys the window and shuts down. Must NOT call
	 * close/destroy itself; must finish any flush before returning `'close'`.
	 */
	onMainWindowClose?(): MaybePromise<'keep' | 'close'>
	/** Framework resize hook — backend repositions its overlays against the
	 *  framework-built main window that emitted `resize`. */
	repositionOverlays?(win: BrowserWindow): void
	/**
	 * Fired on `second-instance` when `config.app.singleInstance` is set and this
	 * process holds the lock — the backend typically focuses/restores its main
	 * window. Process-level: fires regardless of `ownsWindows`.
	 */
	onSecondInstance?(): void
	/**
	 * Deterministic shutdown hook. AWAITED exactly ONCE during `app.shutdown()`'s
	 * cleanup, consistently with `config.lifecycle.beforeClose` — so a backend no
	 * longer hand-rolls `app.once('before-quit', ...)`. Best-effort: a throw/reject
	 * is logged and does NOT abort the rest of shutdown. Fires regardless of
	 * `ownsWindows`.
	 */
	onShutdown?(): void | Promise<void>
}
