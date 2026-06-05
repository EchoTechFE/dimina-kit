import type { BrowserWindow, WebContentsView, ipcMain } from 'electron'
import type { MinimalElectron } from './internal/electron-types.js'
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
 * `defineEvent(name)` 创建的 HostEvent。pure factory，无 side effect —— 必须在
 * `WorkbenchConfig.events` 中显式列出 framework 才会绑 transport。
 */
export interface HostEvent<P extends JsonValue> {
	readonly name: string
	publish(payload: P): void
	on(listener: (payload: P) => void): Disposable
}

// ── WorkbenchConfig 顶层 ─────────────────────────────────────────────────

/**
 * Handler 形参故意宽松（`any[]`）—— host 写 `(p: { code: string }) => ...` 这种
 * narrower 签名必须能赋值给 `Record<string, Handler>`。framework 在 IPC 边界
 * 做 JSON 校验，narrower 类型在 webview-side `createWorkbenchClient<HS, EV>()`
 * 通过 `Parameters<HS[K]>` 推断。返回值 framework 不约束 TS 类型，但 runtime
 * 强制要求 JSON-safe（非 JSON 值反序列化时报错）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SimulatorApiHandler = (...args: any[]) => unknown
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HostServiceHandler = (...args: any[]) => unknown

export interface AppConfig {
	readonly name?: string
	readonly adapter?: CompilationAdapter
	readonly headerHeight?: number
	readonly icon?: string
	readonly window?: {
		readonly width?: number
		readonly height?: number
		readonly minWidth?: number
		readonly minHeight?: number
	}
}

/** 后续 phase 由 devtools 内部实现填充 —— Phase 1 仅占位类型。 */
export interface CompilationAdapter {
	openProject(opts: { projectDir: string; [k: string]: unknown }): Promise<{
		close(): Promise<void>
		port: number
		appInfo: unknown
	}>
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

export interface ProjectsProvider {
	listProjects(): unknown[] | Promise<unknown[]>
	validateProjectDir?(dirPath: string): string | null
	addProject(dirPath: string): unknown
	removeProject(dirPath: string): void | Promise<void>
	updateLastOpened?(dirPath: string): void | Promise<void>
	getCompileConfig?(dirPath: string): unknown
	saveCompileConfig?(dirPath: string, cfg: unknown): void | Promise<void>
}

export interface ProjectTemplate {
	readonly id: string
	readonly name: string
	readonly description?: string
	readonly icon?: string
	readonly source?: { readonly type: 'directory'; readonly path: string }
	readonly generate?: (target: string, opts: { name: string }) => Promise<void>
}

export interface TemplatesContribution {
	readonly custom?: readonly ProjectTemplate[]
	readonly builtins?: 'all' | 'none' | readonly string[]
}

export interface UpdateInfo {
	readonly version: string
	readonly downloadUrl: string
	readonly releaseNotes?: string
	readonly mandatory?: boolean
}

export interface UpdateContribution {
	checkForUpdates(currentVersion: string): Promise<UpdateInfo | null>
	downloadUpdate(info: UpdateInfo, onProgress?: (percent: number) => void): Promise<string>
	readonly checkInterval?: number
	readonly initialDelay?: number
	readonly getCurrentVersion?: () => string
}

/**
 * 顶层 `workbench(config, options?)` 的第二参数。
 *
 * **生产路径**：缺省即可——framework lazy `await import('electron')` 取真
 * `ipcMain` / `BrowserWindow` / `WebContentsView`。host 在 Electron main 进程
 * 入口直接 `workbench(config)`，不需要手动注入。
 *
 * **测试 / 非 Electron 环境**：完全显式注入 `{ electron, ipcMain }` 即可绕过
 * lazy import（vitest 跑 `await import('electron')` 会解析到 Electron 安装包
 * 的 entry stub —— 它导出可执行路径字符串而非 main-process module，所以
 * `ipcMain` / `BrowserWindow` 都是 undefined。framework 用 lazy import 时若
 * 取不到 `ipcMain` 会抛清晰错误，提示注入。
 *
 * `trustedWebContents` / `senderPolicy` 是可选 override —— 缺省 framework 用
 * 内部维护的 trusted set + 默认 isTrusted 策略。
 */
export interface WorkbenchOptions {
	/** 注入自定义 Electron（测试 fake 或 production override）。缺省时 framework lazy import 真 electron。 */
	readonly electron?: MinimalElectron
	/** 注入 ipcMain；缺省时 framework 用 lazy-imported electron.ipcMain。 */
	readonly ipcMain?: MinimalIpcMain
	/** 自定义 trustedWebContents 回调；默认走 framework 内部维护 set。 */
	readonly trustedWebContents?: () => readonly MinimalWebContents[]
	/** 自定义 senderPolicy；默认按 trusted 集判断。 */
	readonly senderPolicy?: SenderPolicy
}

export interface WorkbenchConfig {
	readonly app?: AppConfig
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
	readonly projects?: ProjectsProvider
	readonly templates?: TemplatesContribution
	readonly update?: UpdateContribution
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

export interface WorkspaceState {
	readonly activeProjectPath: string | null
	readonly session: WorkbenchSession | null
}

export interface WorkbenchSession {
	readonly projectPath: string
	readonly port: number
	readonly startedAt: number
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

export interface WorkbenchContext {
	readonly workspace: WorkspaceState
	readonly settings: SettingsSnapshot
	readonly theme: 'light' | 'dark'
	readonly workspaceOps: {
		openProject(path: string): Promise<void>
		closeProject(): Promise<void>
		on(event: 'session-changed', cb: (s: WorkbenchSession | null) => void): Disposable
	}
	/** @internal unsupported escape；破坏 I1/I2/I3 服务承诺 */
	readonly _registry: ResourceRegistry
	/** @internal unsupported escape */
	readonly _senderPolicy: SenderPolicy
}

export interface FrameworkEvents {
	'window-created': { window: BrowserWindow; role: 'main' | 'toolbar' | 'host' }
	'window-closed': { window: BrowserWindow }
	'session-changed': { session: WorkbenchSession | null }
	'theme-changed': { theme: 'light' | 'dark' }
	/** webContents.loadURL/loadFile 失败时 emit。framework 不 reject start()，host 可订阅做兜底/重试 */
	'load-failed': { source: WebviewSource; error: unknown }
}

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

	readonly windows: {
		create(opts: WindowCreateOptions): BrowserWindow
		get(id: string): BrowserWindow | undefined
		all(): BrowserWindow[]
		trust(win: BrowserWindow): Disposable
	}

	readonly context: WorkbenchContext

	on<E extends keyof FrameworkEvents>(
		event: E,
		listener: (payload: FrameworkEvents[E]) => void,
	): Disposable

	add(d: Disposable | (() => MaybePromise<void>)): Disposable
}
