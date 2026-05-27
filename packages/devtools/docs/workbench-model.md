# workbench 模型

`@dimina-kit/workbench` 是 dimina devtools 的 host 集成框架：host 写一份 `WorkbenchConfig` 交给 `workbench(config)`，framework 接管 Electron 装配、IPC、生命周期。`@dimina-kit/devtools` 自身和下游 host（qdmp 等）走同一条入口。

配套文档：[`miniapp-snapshot.md`](./miniapp-snapshot.md) 描述面板数据同步（preload 为唯一真相源）；本文描述 host 的扩展模型（`workbench(config)` 为唯一入口）。

## 1. 最小例子

```ts
// main.ts
import { workbench, defineEvent } from '@dimina-kit/workbench'

const authChanged = defineEvent<{ user: { id: string } | null }>('authChanged')

await workbench({
  app: { name: 'My DevTools' },
  hostServices: {
    getUser: async () => ({ user: null }),
  },
  events: [authChanged],
})
```

host 写好 `workbench(config)` 调用即可启动；`@dimina-kit/workbench/preload` 与 `@dimina-kit/workbench/client` 分别给 webview preload / renderer 用（见 §3）。

## 2. 扩展能力一览

host 通过 `WorkbenchConfig` 注入这些能力：

| 字段 | 用途 |
|---|---|
| `app.adapter` | 编译适配器，替换内置 devkit |
| `app.name` / `icon` / `headerHeight` / `window` | 品牌、主窗口尺寸 |
| `simulatorApis` | 暴露给模拟器小程序的 API（自动投影 `wx.<name>`） |
| `hostServices` | 暴露给 trusted webview（toolbar 等）的 RPC |
| `events` | main → webview 单向推送 |
| `toolbar` | host 完全拥有的 WebContentsView（UI / preload 都在 host 这边） |
| `windows` | 声明式独立窗口（settings / dialog 等） |
| `menu` | 应用菜单构造器 |
| `lifecycle` | `beforeClose` 钩子 + 超时 |
| `projects` / `templates` | 项目列表 / 模板 |
| `update` | 更新检查器 |
| `setup(runtime)` | 运行时 escape：声明表达不了的操作 |

切分维度是 **declarative vs imperative**：绝大多数能力在 `WorkbenchConfig` 字段里声明，framework 在 Bind 阶段一次性装配；动态创建窗口、监听 Electron app event 等运行时操作通过 `setup(runtime)` callback 完成。

## 3. 公共 API

`@dimina-kit/workbench` 暴露三个 import 路径：

| 路径 | 用途 |
|---|---|
| `@dimina-kit/workbench` | main 进程：`workbench(config)` 入口、`defineEvent`、类型定义 |
| `@dimina-kit/workbench/preload` | webview preload：`exposeWorkbenchBridge()` |
| `@dimina-kit/workbench/client` | webview renderer：`createWorkbenchClient<HS, EV>()` |

### 3.1 顶层 config 与入口

```ts
// @dimina-kit/workbench

export type MaybePromise<T> = T | Promise<T>
export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | { readonly [k: string]: JsonValue } | readonly JsonValue[]

export interface Disposable { dispose(): void | Promise<void> }

/** HostEvent 是 pure factory：`defineEvent(name)` 创建后必须在 `config.events` 显式列出，framework 才会绑定 transport */
export interface HostEvent<P extends JsonValue> {
  readonly name: string
  publish(payload: P): void
  on(listener: (payload: P) => void): Disposable
}
export function defineEvent<P extends JsonValue>(name: string): HostEvent<P>

export interface WorkbenchConfig {
  readonly app?: AppConfig

  /**
   * 暴露给小程序，自动投影为 `wx.<name>`。
   * Handler 形参故意宽松（`any[]`）—— host 写 `(p: { code: string }) => ...`
   * 必须能赋给这个 map；narrower 类型由 webview-side
   * `createWorkbenchClient<HS, EV>()` 通过 `Parameters<HS[K]>` 推断。返回值
   * runtime 强制 JSON-safe。
   */
  readonly simulatorApis?: Record<string, (...args: any[]) => unknown>

  /** 暴露给 trusted webview（toolbar 等）的 RPC；签名约束同 simulatorApis */
  readonly hostServices?: Record<string, (...args: any[]) => unknown>

  /**
   * main → webview 推送。必须显式列出，避免 module load order 隐式注册。
   * payload 必须 JSON-safe；非 JSON 值（function / Date / Map / 循环引用 等）
   * 会在跨进程时反序列化失败。
   */
  readonly events?: readonly HostEvent<JsonValue>[]

  /** Toolbar：host 完全拥有的 WebContentsView */
  readonly toolbar?: ToolbarContribution
  /** 独立窗口 */
  readonly windows?: Record<string, WindowContribution>

  readonly menu?: MenuContribution
  readonly lifecycle?: LifecycleContribution
  readonly projects?: ProjectsProvider
  readonly templates?: { custom?: readonly ProjectTemplate[]; builtins?: 'all' | 'none' | readonly string[] }
  readonly update?: UpdateContribution

  /** Imperative escape：声明表达不了的运行时操作 */
  readonly setup?: (runtime: Runtime) => MaybePromise<void>
}

export interface AppConfig {
  readonly name?: string
  readonly adapter?: CompilationAdapter
  readonly headerHeight?: number
  readonly icon?: string
  readonly window?: { width?: number; height?: number; minWidth?: number; minHeight?: number }
}

export type WebviewSource = { readonly url: string } | { readonly file: string }

/** Toolbar：host 完全拥有 WebContentsView，自渲染 UI + 自控 preload */
export interface ToolbarContribution {
  readonly source: WebviewSource
  readonly preloadPath: string   // 必填，host 完全控制
  readonly height: number        // 必填，固定高度；width 自动跟随主窗口
}

export interface WindowContribution {
  readonly title?: string
  readonly source: WebviewSource
  readonly preloadPath?: string
  readonly width?: number
  readonly height?: number
  readonly modal?: boolean
}

export interface LifecycleContribution {
  /**
   * 主窗口关闭 / app 退出前调用，await 完成；超时则阻止关闭并 log error。
   * 如需区分 close vs quit 等细粒度时机，用 `setup(runtime)` 内
   * `runtime.electron.app.on('before-quit', ...)`。
   */
  readonly beforeClose?: () => MaybePromise<void>
  /** beforeClose 超时（ms），默认 10_000 */
  readonly timeoutMs?: number
}

/**
 * Framework 入口。第二参数 `options` 在生产路径下不传（framework lazy
 * `await import('electron')` 取真模块）；测试或非 Electron 环境可注入
 * `{ electron, ipcMain }` 等 fake。
 */
export function workbench(config: WorkbenchConfig, options?: WorkbenchOptions): Promise<void>

export interface WorkbenchOptions {
  readonly electron?: MinimalElectron
  readonly ipcMain?: MinimalIpcMain
  readonly trustedWebContents?: () => readonly MinimalWebContents[]
  readonly senderPolicy?: SenderPolicy
}
```

字段设计要点：

- **`simulatorApis` / `hostServices` / `events` 三个字段分开**：受众、调用方向、是否自动投影都不同（simulator 自动投 `wx.<name>`；hostServices 是 trusted webview RPC；events 是 main → webview push）。不合并成单一 `channels` 抽象，避免引入 Audience / projection / mode union 等表面统一。
- **`toolbar.preloadPath` / `height` 必填**：host 完全控制 toolbar webview 的 preload（framework 不自动注入 bridge，host 在自己的 preload 里 import `exposeWorkbenchBridge()`）；高度固定，宽度自动跟随主窗口。
- **`events` 必须显式列出**：`defineEvent(name)` 是零 side effect 的 pure factory，只有出现在 `config.events` 里 framework 才会绑 transport。emit 未声明的 event 抛 `UndeclaredHostEventError`。
- **`setup(runtime)` 是 await 的 callback**：framework 在 Bind 完成后调用、await 它返回才进入 Ready；`runtime` 是 long-lived，setup 返回后仍可在 channel handler 里使用。

### 3.2 Runtime

```ts
import type { BrowserWindow, WebContentsView, ipcMain } from 'electron'

export interface Runtime {
  /** Electron module proxy：host 用什么自取，framework 不维护白名单 */
  readonly electron: typeof import('electron')
  readonly mainWindow: BrowserWindow
  readonly toolbarView: WebContentsView | null

  /** 类型化 IPC（推荐 escape 路径，自动 senderPolicy + audience） */
  readonly ipc: TypedIpcRegistry

  /** Raw IPC：绕过 framework 保证，host 自负 audience / dispose / 错误处理 */
  readonly rawIpcMain: typeof ipcMain

  /** main 进程内部 helper：直接调已声明的 simulator / host API */
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

  /** Framework 内部事件 bus（main-process only，不跨进程） */
  on<E extends keyof FrameworkEvents>(event: E, listener: (payload: FrameworkEvents[E]) => void): Disposable

  /** Disposable 注册：随 runtime shutdown LIFO 清理 */
  add(d: Disposable | (() => MaybePromise<void>)): Disposable
}

export type Audience = 'simulator' | 'toolbar' | `window:${string}`

export interface TypedIpcRegistry {
  handle<A extends JsonValue[], R extends JsonValue>(
    channel: string,
    handler: (...args: A) => MaybePromise<R>,
    options?: {
      audience?: readonly Audience[] | 'allTrusted'
      validator?: (args: unknown[]) => A
    },
  ): Disposable
  on<P extends JsonValue>(channel: string, listener: (payload: P) => void): Disposable
  send(target: 'mainWindow' | BrowserWindow, channel: string, payload: JsonValue): void
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
  /** @internal 使用 `_` 前缀字段属于 unsupported escape，破坏 framework 保证 */
  readonly _registry: ResourceRegistry
  /** @internal unsupported escape */
  readonly _senderPolicy: SenderPolicy
}

export interface FrameworkEvents {
  'window-created': { window: BrowserWindow; role: 'main' | 'toolbar' | 'host' }
  'window-closed': { window: BrowserWindow }
  'session-changed': { session: WorkbenchSession | null }
  'theme-changed': { theme: 'light' | 'dark' }
  /** webContents.loadURL/loadFile 失败时 emit；framework 不 reject start()，host 可订阅做兜底 */
  'load-failed': { source: WebviewSource; error: unknown }
}

export interface WindowCreateOptions {
  source: WebviewSource
  preloadPath?: string
  width?: number
  height?: number
  modal?: boolean
  parent?: BrowserWindow
  autoTrust?: boolean   // 默认 true
}
```

Runtime 设计要点：

- **`runtime.electron` 是完整 Electron module proxy**：host 想用 `app / dialog / shell / clipboard / nativeTheme / Menu / globalShortcut / screen / ...` 任何模块自取。
- **`runtime.rawIpcMain` 显式暴露**：host 在技术上永远能 `import { ipcMain } from 'electron'`，framework 无法物理阻止。显式暴露 + doc 警示：用这个字段即绕过 senderPolicy、不进 registry，host 自负 audience / dispose / 错误处理。
- **`runtime.context._registry` / `_senderPolicy`**：`@internal` 字段不藏。host 是 trusted partner（同团队），完整暴露让 framework 行为对 host 完全可观察可调试；使用 `_` 字段属于 unsupported escape，破坏 framework 保证。
- **`runtime.on` vs `events` 字段**：FrameworkEvents 是 main 进程内部 bus（不跨进程）；HostEvents 是 main → webview push（跨进程）。两者严格区分。
- **`runtime.windows.create()` 返回真 `Electron.BrowserWindow`**：production 下拥有完整方法（`minimize` / `setBounds` / `focus` 等）。framework 内部用结构类型 `MinimalBrowserWindow` 做 DI，host 在 production 代码按 `BrowserWindow` 全 API 调用是安全的。

### 3.3 Preload bridge helper

```ts
// @dimina-kit/workbench/preload

export interface ExposeBridgeOptions {
  /** 暴露到 window 的全局名，默认 '__workbenchBridge' */
  readonly globalName?: string
}

export function exposeWorkbenchBridge(options?: ExposeBridgeOptions): void
```

host 在自己的 preload 里 import 并调用：

```ts
// toolbar/preload.ts —— host 完全控制
import { contextBridge, ipcRenderer } from 'electron'
import { exposeWorkbenchBridge } from '@dimina-kit/workbench/preload'

exposeWorkbenchBridge()   // framework typed RPC + events bridge

// host 自己想暴露的额外 bridge —— 完全自由
contextBridge.exposeInMainWorld('qdmp', {
  trackEvent: (name: string, props: unknown) => ipcRenderer.invoke('qdmp:analytics', name, props),
})
```

host 极端情况下可以不调 `exposeWorkbenchBridge()` 自定义全套 IPC 协议，但这样 webview 里 `createWorkbenchClient()` 的 `ready()` 会 reject `WorkbenchClientNotReadyError`。

### 3.4 Webview-side client

```ts
// @dimina-kit/workbench/client

export class WorkbenchClientNotReadyError extends Error {}
export class WorkbenchRemoteError extends Error {
  readonly remoteName: string
  readonly code?: string
}

export interface CreateWorkbenchClientOptions {
  /** 默认 `__workbenchBridge`；必须与 host preload 的 `exposeWorkbenchBridge({ globalName })` 对齐 */
  readonly globalName?: string
}

export interface WorkbenchClient<
  HS extends Record<keyof HS, (...args: any[]) => unknown>,
  EV extends readonly HostEvent<JsonValue>[],
> {
  ready(): Promise<void>
  invoke<K extends keyof HS & string>(
    name: K,
    ...args: Parameters<HS[K]>
  ): Promise<Awaited<ReturnType<HS[K]>>>
  on<E extends EV[number]>(
    event: E,
    listener: (payload: E extends HostEvent<infer P> ? P : never) => void,
  ): Disposable
}

export function createWorkbenchClient<
  HS extends Record<keyof HS, (...args: any[]) => unknown>,
  EV extends readonly HostEvent<JsonValue>[],
>(options?: CreateWorkbenchClientOptions): WorkbenchClient<HS, EV>
```

`HS` 上界用 `Record<keyof HS, (...args: any[]) => unknown>` 而非 `JsonValue[]`：与 host 侧 `HostServiceHandler` 对称，host 在 `hostServices` 写 `(p: { code: string }) => ...` 这种 narrower 签名直接成立，`Parameters<HS[K]>` 在 client 端精确推出原签名。跨进程负载安全性由 wire envelope（`InvokeRequest.args: readonly JsonValue[]`）与 handler 端可选 `validator` 承担，不放在公开类型约束里——Electron IPC 走 structured clone 而非 JSON，把 `JsonValue` 当编译期硬约束既挡掉合理写法、又给不出真实运行时保证。

host 在 config 文件里 export `HostServices` / `Events` 类型，给 webview project import：

```ts
// workbench.config.ts（host 写的）
export const hostServices = { ... } as const
export const events = [authChanged, ...] as const
export type HostServices = typeof hostServices
export type Events = typeof events
```

```ts
// toolbar/src/main.ts（webview 端）
import type { HostServices, Events } from '../../workbench.config'
const client = createWorkbenchClient<HostServices, Events>()
```

不引入 `WorkbenchContract` generic、不引入 module augmentation——host 直接 export 自己已经写好的类型即可。

## 4. 关键不变量

| 编号 | 含义 |
|---|---|
| **I1 容器归属** | 注册物挂 framework runtime registry，不进进程全局、不进模块级可变量 |
| **I2 IPC 经网关** | host 跨进程 IPC 在受支持路径（`simulatorApis` / `hostServices` / `events` / `runtime.ipc`）上走 framework typed transport（senderPolicy + JSON 校验 + audience）。`runtime.rawIpcMain` 是显式 escape，框架不提供保证 |
| **I3 生命周期** | 注册返 Disposable，进 registry，随 runtime shutdown LIFO 级联清理 |

I2 的范围说明：framework 无法物理阻止 host `import { ipcMain }` 裸调；I2 是「受支持路径上的服务承诺」，不号称「裸 IPC 物理不可能」。`runtime.rawIpcMain` 把这条边界显式暴露给 host。

## 5. Lifecycle

启动：

| Phase | Framework 行为 |
|---|---|
| **Init** | `app.whenReady()` + framework internal 起 + senderPolicy + IPC transport |
| **Bind** | declared 全字段绑 transport；mainWindow + toolbar WebContentsView + declared windows 建好；wireTransport 启动后才触发 webview `loadURL` / `loadFile`（best-effort，不 await） |
| **Setup** | 调 `config.setup(runtime)` 并 await；runtime 完全可用，topic publish 不抛错（但 toolbar webview 可能尚未 subscribe，初始状态用 hostServices 拉一次 snapshot） |
| **Ready** | runtime/transport 装配完成，declared sources 已开始加载；webview 实际 load 完成属于 host 侧异步事件，加载失败通过 `runtime.on('load-failed', ...)` 兜底 |

关闭：

| Phase | Framework 行为 |
|---|---|
| **Drain** | 进入排空 phase（暂未做 in-flight handler grace；目前是 phase 标记，不阻塞） |
| **Cleanup** | `lifecycle.beforeClose` await + timeout（超时只 log，不阻止 shutdown 继续）；之后 destroy 跟踪窗口、`registry.disposeAll()` LIFO 释放 `runtime.add()` 注册的 disposable |
| **Destroy** | toolbar WebContentsView + windows + transport 关 |
| **Quit** | lifecycle phase 进入 `quit`（framework 不主动调 `electron.app.quit()`；host 自行决定何时退出进程） |

关键时序保证：

- `HostEvent.publish()` 在 Init / Bind 阶段调用抛 `EventNotBoundError`；Setup / Ready 之后调用是安全的（fire-and-forget，无 replay——setup 内 publish 给 toolbar 的事件可能丢失，初始状态走 hostServices snapshot）
- `setup(runtime)` 内异步操作 framework 严格 await
- `beforeClose` 超时 → log error 后继续 shutdown 流程

### Shutdown 的 host 责任

framework 在 shutdown 路径上**故意留出三个 host-owned 缝隙**，每条都对应一个 host 自管点：

1. **关闭不可抢断**：framework hook 的是 `mainWindow` 的 `'closed'` 事件（窗口已销毁后触发），不是 `'close'`（可 preventDefault 的拦截点）。如果 host 需要"保存未提交内容才允许关闭"这种语义，自行在 `setup(runtime)` 里 `runtime.mainWindow.on('close', e => { e.preventDefault(); ...; win.destroy() })`，由 host 控制最终关闭时机。
2. **drain 不拒新 invoke**：drain phase 当前只是状态标记，不阻塞新进来的 RPC 调用。`beforeClose` await 期间，toolbar / declared windows 仍可发 invoke。host 若依赖"shutdown 期间没有新写入"，在 host 自己的 webview 端实现"close→ stop issuing requests"逻辑。
3. **进程退出**：framework 在 `Quit` phase 不主动调 `electron.app.quit()`。所有 trackedWindow 已 destroy 后，Electron 默认 `window-all-closed` 行为会 quit（macOS 除外）；host 若有多窗口或独立退出 UX，自行用 `app.on('window-all-closed')` / `app.quit()` 控制。

## 6. mainWindow 加载归属

framework 不主动 `loadURL` / `loadFile` mainWindow。host 在 `setup(runtime)` 内调 `runtime.mainWindow.loadURL(...)` 加载自己的入口页（dimina default 加载 dimina 内置 React app；qdmp 加载 qdmp 自己的 main webview）。

toolbar / declared windows 由 framework 根据 `source` 字段自动加载——mainWindow 的视图层归属 host，framework 只保证容器装配与生命周期。

## 7. 设计取舍

- **不引入 plugin 系统**：当前使用者只有 qdmp 与 dimina 自身两个，feature 内聚用 plain TS module 边界（`auth.ts` / `projects.ts` 等）就够。等真有多供应商 plugin 生态再考虑。
- **`simulatorApis` / `hostServices` / `events` 三字段不合并**：audience、调用方向、是否自动投影都不同，统一成 `channels` 抽象需要引入 `Audience` 类型 / `projectAs` 字段 / `ChannelMode` 三 mode union 等额外概念，换来的是表面统一。
- **toolbar 由 host 完全拥有 WebContentsView**：按钮 UI / 状态显示是 host 业务，framework 提供容器 + IPC bridge 已够。WebContentsView 是 Electron 现代 API（替代 BrowserView），嵌入主窗口子区域、独立 webContents、preload 隔离开箱即用。
- **`runtime.rawIpcMain` 显式暴露**：host 永远能 `import { ipcMain }`，framework 无法物理拦截。显式暴露 + doc 警示告知 host **用这个字段即等于自负全部责任**。framework 不主动监控 raw IPC 用法（无 telemetry hook），可观测性靠 doc + 未来可选的 dev mode warn / lint rule。
- **`runtime.context` 完整暴露包括 `_` 字段**：host 是 trusted partner，"防御"的对象是手滑、不是恶意。完整暴露 + JSDoc 警示让 framework 行为对 host 可观察可调试。
- **不引入 CLI**：host 写 1 行 `main.ts` 就是 entry，framework 接管 Electron lifecycle 与 host 写 entry 文件不冲突。引入 CLI 要 framework 维护 TS loader / build / watch 一整套 sugar，对 KISS 不划算。
- **dimina builtin React panels 不进 public API**：dimina 内置的 projects / session / simulator / popover / settings 面板属于 framework baseline 私有路径（不在 `WorkbenchConfig` 表达）；host 不能加自己的 builtin panel，也不能关掉 dimina default 的 builtin panels。dogfooding 收敛的是 public config + lifecycle，不包括 baseline panels 装配。

## 附录 A：host 完整集成示例（qdmp）

### feature module

```ts
// events.ts —— 无 side effect 的 HostEvent token，main / renderer 共享
import { defineEvent } from '@dimina-kit/workbench'

export const authChanged = defineEvent<{ user: { id: string; name: string } | null }>('authChanged')
```

```ts
// auth.ts —— main 进程
import { qdmpLogin, qdmpLogout } from './qdmp-api'   // main-only deps
import { authChanged } from './events'

let currentUser: { id: string; name: string } | null = null
export const getCurrentUser = () => currentUser

export async function login(p: { code: string }) {
  const r = await qdmpLogin(p)
  currentUser = { id: r.userId, name: r.userName }
  authChanged.publish({ user: currentUser })
  return r
}

export async function logout() {
  await qdmpLogout()
  currentUser = null
  authChanged.publish({ user: null })
}

export async function getAuthState() {
  return { user: currentUser }
}
```

> 把 HostEvent token 独立到 `events.ts` —— renderer/toolbar 只 import token，不会把 main-only 的 `qdmp-api` 拖进 toolbar bundle。

### workbench.config.ts

```ts
import { fileURLToPath } from 'node:url'
import { workbench } from '@dimina-kit/workbench'
import { qdmpAdapter } from './qdmp-adapter'
import { qdmpProjects } from './projects'
import * as auth from './auth'
import * as projects from './projects'
import { authChanged, activeProjectChanged } from './events'
import { buildQdmpMenu } from './menu'

export const simulatorApis = {
  login: auth.login,
  logout: auth.logout,
} as const

export const hostServices = {
  getAuthState: auth.getAuthState,
  listProjects: projects.list,
  uploadCurrentProject: projects.upload,
} as const

export const events = [authChanged, activeProjectChanged] as const

export type SimulatorApis = typeof simulatorApis
export type HostServices = typeof hostServices
export type Events = typeof events

workbench({
  app: {
    name: 'QDMP DevTools',
    adapter: qdmpAdapter,
    headerHeight: 72,
  },

  simulatorApis,
  hostServices,
  events,

  toolbar: {
    source: { url: 'http://localhost:5173/toolbar.html' },
    preloadPath: fileURLToPath(new URL('./toolbar/preload.js', import.meta.url)),
    height: 48,
  },

  windows: {
    reauth: {
      title: '重新登录',
      source: { file: './dist/reauth/index.html' },
      width: 400,
      height: 300,
      modal: true,
    },
  },

  projects: qdmpProjects,
  menu: { build: buildQdmpMenu },
  lifecycle: { beforeClose: async () => qdmpProjects.persistSession(), timeoutMs: 10_000 },

  async setup(runtime) {
    // host 主动加载 mainWindow 入口页（framework 不主动 loadURL，见 §6）
    await runtime.mainWindow.loadURL('http://localhost:5173/main.html')

    // 监听 app 激活、重显主窗口
    runtime.electron.app.on('activate', () => {
      if (!runtime.mainWindow.isVisible()) runtime.mainWindow.show()
    })

    // 订阅 framework workspace 变化、触发 re-auth 弹窗
    runtime.on('session-changed', ({ session }) => {
      if ((session as { requiresReauth?: boolean } | null)?.requiresReauth) {
        runtime.windows.get('reauth')?.show()
      }
    })

    // 调原生 dialog 的 channel handler（imperative，但仍经 senderPolicy）
    // 注意：返回值必须 JSON-safe，所以 `r.filePath` 的 undefined 兜成 null
    runtime.ipc.handle('qdmp:export', async () => {
      const r = await runtime.electron.dialog.showSaveDialog(runtime.mainWindow, { defaultPath: 'export.zip' })
      return { canceled: r.canceled, filePath: r.filePath ?? null }
    }, { audience: ['toolbar'] })

    // host debug 窗口
    if (process.env.QDMP_DEBUG) {
      runtime.windows.create({
        width: 600,
        height: 400,
        source: { url: 'http://localhost:5175/debug.html' },
      })
    }
  },
})
```

### main.ts（host entry）

```ts
import './workbench.config'
```

### toolbar/preload.ts

```ts
import { contextBridge, ipcRenderer } from 'electron'
import { exposeWorkbenchBridge } from '@dimina-kit/workbench/preload'

exposeWorkbenchBridge()

contextBridge.exposeInMainWorld('qdmp', {
  trackEvent: (name: string, props: unknown) => ipcRenderer.invoke('qdmp:analytics', name, props),
})
```

### toolbar/src/main.ts

```ts
import { createWorkbenchClient } from '@dimina-kit/workbench/client'
import type { HostServices, Events } from '../../workbench.config'
import { authChanged } from '../../events'   // 只 import token，不拖 main-side deps

const client = createWorkbenchClient<HostServices, Events>()
await client.ready()

// 初始状态：先拉一次 snapshot
const { user } = await client.invoke('getAuthState')
renderLoginButton(user)

// 订阅变化：HostEvent 作为 token
const off = client.on(authChanged, ({ user }) => renderLoginButton(user))
window.addEventListener('beforeunload', () => off.dispose())

// 业务调用
document.querySelector('#upload')?.addEventListener('click', async () => {
  const r = await client.invoke('uploadCurrentProject', { projectId: getActiveId() })
  showNotification(`Uploaded to ${r.url}`)
})

// host 自己暴露的额外 API
declare global {
  interface Window {
    qdmp: { trackEvent(n: string, p: unknown): Promise<void> }
  }
}
window.qdmp.trackEvent('toolbar-loaded', {})
```

## 附录 B：dimina default 入口示例

```ts
// packages/devtools/src/default-workbench.ts
import { workbench } from '@dimina-kit/workbench'
import { defaultAdapter } from './services/default-adapter'
import { builtinProjects } from './services/projects'
import { buildDefaultMenu } from './menu'
import { defaultUpdate } from './services/update'

workbench({
  app: {
    name: 'Dimina DevTools',
    adapter: defaultAdapter,
    headerHeight: 40,
  },

  // dimina builtin host services（例：让 dimina 内置 React panels 通过这条路径调）
  hostServices: {
    'app.getVersion': async () => ({ version: '0.0.0' }),
  },

  projects: builtinProjects,
  menu: { build: buildDefaultMenu },
  lifecycle: { beforeClose: async () => builtinProjects.persistSession(), timeoutMs: 10_000 },
  templates: { builtins: 'all' },
  update: defaultUpdate,

  async setup(runtime) {
    // dimina default 也需要主动加载 mainWindow 入口页
    await runtime.mainWindow.loadURL('file://path/to/dimina-builtin/index.html')
  },
})
```

dimina-devtools 自身和 host 走同一条 `workbench(config)` 入口。dimina 内置 React panels 的 preload / audience / route 是 framework baseline 私有路径——不在 `WorkbenchConfig` 表达，也不暴露给 host 入口。dogfooding 收敛的是 `app/menu/projects/templates/update/lifecycle` 这些公共 config 与 IPC / dispose 同管道，不收敛 baseline panels 装配。
