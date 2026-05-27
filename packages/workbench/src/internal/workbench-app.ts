import type {
	Disposable,
	FrameworkEvents,
	JsonValue,
	MaybePromise,
	Runtime,
	SenderPolicy,
	WebviewSource,
	WindowContribution,
	WindowCreateOptions,
	WorkbenchConfig,
	WorkbenchContext,
} from '../types.js'
import { validateConfig } from '../workbench.js'
import type {
	MinimalBrowserWindow,
	MinimalBrowserWindowOptions,
	MinimalElectron,
	MinimalWebContentsLike,
	MinimalWebContentsView,
} from './electron-types.js'
import { EventBus } from './event-bus.js'
import { InMemoryTypedIpcRegistry } from './ipc-registry-memory.js'
import { LifecycleManager } from './lifecycle-manager.js'
import type { LifecyclePhase } from './lifecycle-manager.js'
import { ResourceRegistryImpl } from './resource-registry.js'
import {
	WireTransport,
	type MinimalIpcMain,
	type MinimalWebContents,
} from './wire-transport.js'

const SIMULATOR_CHANNEL_PREFIX = '__workbench:simulator:'
const HOST_CHANNEL_PREFIX = '__workbench:host:'

const DEFAULT_MAIN_WIDTH = 1024
const DEFAULT_MAIN_HEIGHT = 768

/**
 * Optional dependencies for {@link WorkbenchApp} —— Phase 3b 用于注入真 (或
 * mock) Electron `ipcMain` + trusted webContents 集合，让 framework 接通跨进程
 * wire transport。不注入则保持 Phase 2 main-internal-only 行为。
 *
 * @internal
 */
export interface WorkbenchAppOptions {
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
 * Framework-internal "app" object —— `workbench(config)` 顶层入口的 plain-class
 * 形态，便于 Phase 2 测试驱动 lifecycle 转换。Phase 3b 加 wireTransport 注入
 * 后可接真 ipcMain；Phase 4 加 electron 注入后可装配 mainWindow / toolbarView
 * / declared windows。两者都不注入时退化为同进程内存 fake。
 *
 * @internal
 */
export class WorkbenchApp {
	readonly config: WorkbenchConfig

	private readonly lifecycle = new LifecycleManager()
	private readonly registry = new ResourceRegistryImpl()
	private readonly bus = new EventBus()
	private readonly ipc = new InMemoryTypedIpcRegistry()
	private readonly fwListeners = new Map<keyof FrameworkEvents, Set<(payload: unknown) => void>>()
	private readonly trustedWcRefs = new Map<MinimalWebContents, number>()
	private readonly options: WorkbenchAppOptions
	private wireTransport: WireTransport | null = null
	private mainWindow: MinimalBrowserWindow | null = null
	private toolbarView: MinimalWebContentsView | null = null
	private readonly declaredWindows = new Map<string, MinimalBrowserWindow>()
	private readonly trackedWindows = new Set<MinimalBrowserWindow>()
	private readonly pendingWindowCreated: PendingWindowCreated[] = []
	private readonly pendingLoadFailed: PendingLoadFailed[] = []
	private _runtime: Runtime | null = null
	private startCalled = false
	private shutdownPromise: Promise<void> | null = null

	constructor(config: WorkbenchConfig, options: WorkbenchAppOptions = {}) {
		this.config = config
		this.options = options
	}

	get phase(): LifecyclePhase {
		return this.lifecycle.current
	}

	get runtime(): Runtime {
		if (this._runtime === null) {
			throw new Error('WorkbenchApp.runtime is unavailable before setup phase')
		}
		return this._runtime
	}

	async start(): Promise<void> {
		if (this.startCalled) {
			throw new Error('WorkbenchApp.start() already called')
		}
		this.startCalled = true

		// 校验在 lifecycle 转换之前；invalid config → reject，phase 不动
		validateConfig(this.config)

		// #12 C7 — half-state guard: electron + (toolbar | windows) without
		// wireTransport would leave the host with webviews that can never
		// reach back via __workbench:invoke. Reject early with a clear msg.
		const hasWebviewContent = !!(this.config.toolbar || this.config.windows)
		if (this.options.electron && hasWebviewContent && !this.options.wireTransport) {
			throw new Error(
				'WorkbenchAppOptions: wireTransport.ipcMain is required when config has toolbar or windows',
			)
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

	shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise
		this.shutdownPromise = this.doShutdown()
		return this.shutdownPromise
	}

	/** @internal Phase 4 windows.trust() / framework 内部添加 trusted webContents */
	_trustWebContents(wc: MinimalWebContents): Disposable {
		const cur = this.trustedWcRefs.get(wc) ?? 0
		this.trustedWcRefs.set(wc, cur + 1)
		let disposed = false
		return {
			dispose: () => {
				if (disposed) return
				disposed = true
				const c = this.trustedWcRefs.get(wc)
				if (c === undefined) return
				if (c <= 1) this.trustedWcRefs.delete(wc)
				else this.trustedWcRefs.set(wc, c - 1)
			},
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
				const d = this.ipc.handle(
					`${HOST_CHANNEL_PREFIX}${name}`,
					handler as (...args: JsonValue[]) => MaybePromise<JsonValue>,
				)
				this.registry.add(d)
			}
		}
	}

	private assembleElectron(): void {
		const electron = this.options.electron
		if (!electron) return

		// mainWindow ── framework 不主动 load 内容，host 在 setup 里自管
		const appCfg = this.config.app ?? {}
		const winCfg = appCfg.window ?? {}
		const mainOpts: MinimalBrowserWindowOptions = {
			title: appCfg.name,
			icon: appCfg.icon,
			width: winCfg.width ?? DEFAULT_MAIN_WIDTH,
			height: winCfg.height ?? DEFAULT_MAIN_HEIGHT,
		}
		if (winCfg.minWidth !== undefined) mainOpts.minWidth = winCfg.minWidth
		if (winCfg.minHeight !== undefined) mainOpts.minHeight = winCfg.minHeight
		const main = new electron.BrowserWindow(mainOpts)
		this.mainWindow = main
		this.trackedWindows.add(main)
		// auto-trust (ref-count, framework holds one ref — never disposed)
		this._trustWebContentsLike(main.webContents)
		this.pendingWindowCreated.push({ window: main, role: 'main' })
		// #8 R7 — toolbar follows mainWindow resize
		main.on('resize', () => {
			if (!this.toolbarView || !this.config.toolbar) return
			const b = main.getContentBounds()
			this.toolbarView.setBounds({
				x: 0,
				y: 0,
				width: b.width,
				height: this.config.toolbar.height,
			})
		})
		// #2 R2 — closing the main window shuts down the whole framework.
		// D3: 关窗前先清 trust entries（safety：wc.id 复用 + 内存泄漏）；
		// 整个 framework 即将关，影响面小但语义干净。
		main.on('closed', () => {
			this.trustedWcRefs.delete(main.webContents as unknown as MinimalWebContents)
			if (this.toolbarView) {
				this.trustedWcRefs.delete(this.toolbarView.webContents as unknown as MinimalWebContents)
			}
			void this.shutdown()
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
			this._trustWebContentsLike(view.webContents)
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
				console.error(`[workbench] loadURL("${source.url}") failed:`, err)
				this.surfaceLoadFailed(source, err)
			})
		}
		else {
			wc.loadFile(source.file).catch((err: unknown) => {
				console.error(`[workbench] loadFile("${source.file}") failed:`, err)
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

		const trustedWebContents = wireOpts.trustedWebContents
			?? ((): readonly MinimalWebContents[] => Array.from(this.trustedWcRefs.keys()))
		// 默认 senderPolicy 与 trustedWebContents 共用同一来源 —— host 注入自
		// 定义 trustedWebContents 时，senderPolicy 跟着切，避免 split-brain。
		const senderPolicy = wireOpts.senderPolicy ?? {
			isTrusted: (id: number): boolean => {
				for (const wc of trustedWebContents()) {
					if (wc.id === id) return true
				}
				return false
			},
		}

		const transport = new WireTransport({
			ipcMain: wireOpts.ipcMain,
			bus: this.bus,
			senderPolicy,
			trustedWebContents,
			invokeHost: (name, args) =>
				this.ipc.invoke<JsonValue>(`${HOST_CHANNEL_PREFIX}${name}`, ...args),
			invokeSimulator: (name, args) =>
				this.ipc.invoke<JsonValue>(`${SIMULATOR_CHANNEL_PREFIX}${name}`, ...args),
			declaredEvents: () =>
				this.config.events ? this.config.events.map(ev => ev.name) : [],
		})
		transport.start()
		this.wireTransport = transport
		this.registry.add({
			dispose: () => {
				transport.dispose()
			},
		})
	}

	private constructWindow(
		opts: WindowContribution | (WindowCreateOptions & { title?: string }),
		autoTrust: boolean,
		deferLoad = false,
	): MinimalBrowserWindow {
		const electron = this.options.electron
		if (!electron) {
			throw new Error('WorkbenchApp.constructWindow called without electron injection')
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
		if (autoTrust) {
			this._trustWebContentsLike(win.webContents)
		}
		if (!deferLoad) {
			this.safeLoad(win.webContents, opts.source)
		}
		// #2 R2 — declared / runtime-created window 'closed' only cleans up
		// its own tracked state; full framework shutdown is reserved for
		// mainWindow.
		win.on('closed', () => {
			this.handleSubWindowClosed(win)
		})
		return win
	}

	private handleSubWindowClosed(win: MinimalBrowserWindow): void {
		this.trackedWindows.delete(win)
		for (const [key, w] of this.declaredWindows) {
			if (w === win) {
				this.declaredWindows.delete(key)
				break
			}
		}
		// D3: 清 closed wc 的 trust entries，避免 wc.id 被新窗口复用时错继承授权 +
		// 长会话内存泄漏。framework auto-trust 也一并清（refcount 不区分 baseline
		// vs host，因为 baseline 不再需要 — window 已关）。
		this.trustedWcRefs.delete(win.webContents as unknown as MinimalWebContents)
		this.emitFrameworkEvent('window-closed', { window: win as unknown as FrameworkEvents['window-closed']['window'] })
	}

	private _trustWebContentsLike(wc: MinimalWebContentsLike): Disposable {
		return this._trustWebContents(wc as unknown as MinimalWebContents)
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
				console.error(`[workbench] framework listener for "${event}" threw:`, err)
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
	}

	private async runShutdownCleanup(): Promise<void> {
		// beforeClose await + timeout
		if (this.config.lifecycle?.beforeClose) {
			const timeoutMs = this.config.lifecycle.timeoutMs ?? 10_000
			try {
				await runWithTimeout(this.config.lifecycle.beforeClose(), timeoutMs)
			}
			catch (e) {
				console.error('[workbench] lifecycle.beforeClose failed/timed out:', e)
			}
		}

		// #4 R4/C3 — destroy windows BEFORE registry.disposeAll().
		// Rationale: WireTransport (and any preload-side bridges) are torn
		// down by registry.disposeAll(); if windows still exist by then,
		// renderer-side teardown handlers may try to invoke __workbench:*
		// against a removed ipcMain handler. Destroying first guarantees
		// renderers are gone before their wire goes away.
		for (const win of Array.from(this.trackedWindows)) {
			if (win.isDestroyed()) continue
			try {
				win.destroy()
			}
			catch (e) {
				console.error('[workbench] window.destroy() failed:', e)
			}
		}
		this.trackedWindows.clear()
		this.declaredWindows.clear()
		this.mainWindow = null
		this.toolbarView = null

		// registry LIFO dispose (WireTransport.dispose() → ipcMain.removeHandler)
		try {
			await this.registry.disposeAll()
		}
		catch (e) {
			console.error('[workbench] registry.disposeAll failed:', e)
		}

		this.bus.unbindAll()
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

		const context: WorkbenchContext = {
			workspace: { activeProjectPath: null, session: null },
			settings: { theme: 'light' },
			theme: 'light',
			workspaceOps: {
				openProject: async () => undefined,
				closeProject: async () => undefined,
				on: () => ({ dispose: () => {} }),
			},
			_registry: this.registry,
			_senderPolicy: { isTrusted: () => true },
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
		const trustWebContents = (wc: MinimalWebContents): Disposable => this._trustWebContents(wc)
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
					return trustWebContents(w.webContents as unknown as MinimalWebContents)
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
