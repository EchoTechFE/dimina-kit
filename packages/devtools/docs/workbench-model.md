# workbench 模型

> 状态：**草稿（2026-05-25），待评审。** 取代 `extension-model.md`（2026-05-22 定稿版本）。
> 配套：[`miniapp-snapshot.md`](./miniapp-snapshot.md)。`miniappSnapshot` 统一面板数据同步；本文统一下游 host 对 devtools 的扩展模型。

## 摘要（TL;DR）

devtools 不是独立 app，而是供下游 host（当前是 qdmp + dimina-devtools 自身）集成、定制的开发者工具平台。host 写一份 `WorkbenchConfig` 给 framework，framework 装配 Electron + 跑 runtime + 接管 lifecycle。

> **`workbench(config)` 是唯一入口。** host 在 declared path 上写大部分扩展（声明优先），在 `setup(runtime)` escape 上写运行时操作（imperative 兜底）。dimina-devtools 自身和 host 走同一条入口。

两类操作共同守三条硬规则：

| 规则 | 含义 |
|---|---|
| **I1 容器归属** | 注册物挂 framework runtime registry，绝不进程全局、绝不模块级可变量 |
| **I2 IPC 经网关** | host 跨进程 IPC 一律经 framework typed transport（senderPolicy + JSON 校验）。`simulatorApis` / `hostServices` / `events` / `runtime.ipc` 是受支持路径 |
| **I3 生命周期** | 注册返 Disposable，进 registry，随 runtime shutdown LIFO 级联清理 |

> **I2 的诚实表述**：host 在技术上永远能 `import { ipcMain } from 'electron'` 裸调 —— 框架无法物理阻止。`runtime.rawIpcMain` 是 framework 显式提供的 escape（doc 必读警告）：用 raw 等于绕过 senderPolicy、不进 registry、自负 audience / dispose / 错误处理。I2 的保证是「**受支持路径**」上的服务承诺，不号称「裸 IPC 物理不可能」。

**clean break**：qdmp 与 devtools 同团队、可协调，迁移 lockstep —— 旧 `createWorkbenchApp / onSetup / WorkbenchHostInstance` 路径随重构一并删除，不留 `@deprecated`、不留双轨。

## 1. 什么是扩展点

host 用 `workbench(config)` 集成 devtools，注入自己的实现：

| 扩展需求 | 例子 |
|---|---|
| 编译适配器 `adapter` | 用 host 自己的编译器替换内置 devkit |
| 品牌 / 应用菜单 / 主窗口配置 | 换 logo、改菜单、设置主窗口尺寸 |
| simulator 自定义 API | 让模拟器里的小程序能调 `wx.<hostApi>()` |
| host RPC | host 主进程能力（登录、上传、统计…）暴露给 toolbar / 别的 webview |
| main → webview 推送 | 登录态、active project 等变化通知 toolbar |
| Toolbar | host 完全拥有 WebContentsView，自渲染 UI、自定 IPC bridge |
| 独立窗口 | settings / dialog / debug 等独立 BrowserWindow |
| 项目面板扩展 | host 提供 ProjectsProvider / 项目模板 |
| 更新机制 | host 提供 UpdateChecker |

## 2. 老 extension-model 已识别问题的处理

老 doc 第 2 节列三个病灶 + 两笔卫生债，R19 在新架构下全部覆盖：

| 老 doc 病灶 | R19 处理 |
|---|---|
| **范式分裂**（toolbarActions config + 裸 `toolbar:action:*` IPC 两半两种范式） | toolbar 改为 host 完全拥有 WebContentsView，UI 渲染 + 按钮事件 + 数据通信全在 host 自己的 webview/preload/hostServices —— **不复存在两边** |
| **安全边界不齐 (a)** 裸 IPC 绕 senderPolicy | `hostServices` declarative + `runtime.ipc` typed wrapper 是推荐路径，自动 senderPolicy + JSON 校验；`runtime.rawIpcMain` 是显式 escape，doc 警示 |
| **安全边界不齐 (b)** IpcRegistry 没对外导出 | `IpcRegistry` 不暴露给 host（只在 framework 内部使用）；host 用更高层 `hostServices` / `runtime.ipc` |
| **安全边界不齐 (c)** UpdateManager 漏传 senderPolicy | framework 内部统一应用 senderPolicy 在所有 declared transport 上 |
| **生命周期混乱 (a)** `register*Ipc` 进 registry | declared 字段 + `runtime.add()` 全部进 framework runtime registry |
| **生命周期混乱 (b)** `registerSimulatorApi` 进程级单例、被覆盖成 no-op | `simulatorApis` 是 declared 字段、per-config 单 runtime，无进程全局概念 |
| **生命周期混乱 (c)** 裸 IPC handler 完全无主 | declared / `runtime.ipc.handle` 进 registry 自动清；`runtime.rawIpcMain` 不进、host 自管（doc 警示） |
| **卫生债** `setHeaderHeight` 进程级可变量、renderer 端硬编码 HEADER_H | `app.headerHeight` config 字段，framework 同时下发 main + renderer |
| **卫生债** `extraModules` 幽灵字段（JSDoc 承诺、无实现） | R19 全新接口，无此字段 |
| **叙事 bug** 第 3.1 节"基数二分" 论证有反例（`projectTemplates` pre-context 多个、`toolbar.set` post-context 单表） | R19 不引入基数概念，按 **audience**（simulator / toolbar / events）+ **lifecycle phase**（declarative / imperative escape）双轴切分 |

## 3. 目标模型

### 3.1 两层

切分维度是 **declarative vs imperative**，不是基数。

**Declarative（声明优先）**：host 写一份 `WorkbenchConfig` 数据描述自己的所有扩展。framework 在 declared path 上保证 I1/I2/I3。

涵盖：
- `app` —— 主窗口配置、品牌、icon、headerHeight、adapter
- `simulatorApis` —— 给小程序的 API（自动投影 `wx.<name>`）
- `hostServices` —— 给 toolbar webview 的 RPC
- `events` —— main → webview 单向推送
- `toolbar` —— host 完全拥有的 contentWebview（WebContentsView 嵌入主窗口）
- `windows` —— 独立窗口（settings / dialog 等）
- `menu` / `lifecycle` / `projects` / `templates` / `update`

→ 在 `WorkbenchConfig` 字段里声明，构造期/Bind 期完成装配。

**Imperative escape（运行时兜底）**：声明表达不了的运行时操作，host 在 `setup(runtime)` callback 里 imperative 写。`runtime` 暴露完整 Electron module proxy + framework context + raw IPC。

涵盖：动态创建 host 窗口、监听 Electron app event、运行时根据 host 状态触发 framework 操作、调原生 dialog 等。

→ 通过 `setup(runtime)` 拿到的 `Runtime` 对象，runtime 是 long-lived（setup 返回后 host 可继续在 channel handler 里用 runtime reference）。

### 3.2 三条硬规则

无论 declarative 还是 imperative，都受同一组规则约束。

| 规则 | 含义 |
|---|---|
| **I1 容器归属** | 注册物挂 framework runtime registry，绝不进程全局、绝不模块级可变量 |
| **I2 IPC 经网关** | host 跨进程 IPC 一律经 framework typed transport（senderPolicy + JSON 校验 + audience）。`simulatorApis` / `hostServices` / `events` / `runtime.ipc` 是唯一**受支持**路径 |
| **I3 生命周期** | 注册返 Disposable，进 registry，随 runtime shutdown LIFO 级联清理 |

> **I2 的诚实表述**：host 在技术上永远能 `import { ipcMain } from 'electron'` 裸调 —— 框架无法物理阻止。`runtime.rawIpcMain` 是 framework 显式提供的 escape（doc 警示）：用 raw 等于绕过 senderPolicy、不进 registry、自负 audience / dispose / 错误处理。I2 的保证是「**受支持路径**」上的服务承诺，不号称「裸 IPC 物理不可能」。

类型契约由 host export 字段类型（`SimulatorApis` / `HostServices` / `Events`）供 webview / miniapp import；preload 漏装 framework bridge 时 webview client `ready()` 会 reject `WorkbenchClientNotReadyError`。这些是实现要求，不单列为不变量。

### 3.3 接口

#### 顶层 config 与入口

```ts
// @dimina-kit/workbench

export type MaybePromise<T> = T | Promise<T>
export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | { readonly [k: string]: JsonValue } | readonly JsonValue[]

export interface Disposable { dispose(): void | Promise<void> }

/** Event 工厂（pure factory；name 由 host 自定） */
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
   * main → webview 推送（必须显式列出，避免 module load order 隐式注册）。
   * payload 必须 JSON-safe；非 JSON 值（function / Date / Map / 循环引用 / 等）
   * 会在跨进程时反序列化失败（structured clone error 或 hostEvent envelope 校验失败）。
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
   * 主窗口关闭 / app 退出之前调，await 完成；超时阻止关闭并 log error。
   * host 若要区分 close vs quit 等细粒度时机，用 `setup(runtime)` 内
   * `runtime.electron.app.on('before-quit', ...)` escape。
   */
  readonly beforeClose?: () => MaybePromise<void>
  /** beforeClose 超时（ms），默认 10_000 */
  readonly timeoutMs?: number
}

/** 唯一入口 */
export function workbench(config: WorkbenchConfig): Promise<void>
```

设计要点：

- **`simulatorApis` / `hostServices` / `events` 三独立字段，按 audience 分**：simulator audience 自动投影 `wx.<name>`；toolbar audience 走 typed RPC；events 是 main → webview 单向。**不引入统一 `channels` 抽象**——三件事在 audience / 调用方向 / projection 上本就不同，硬合并是虚假统一。
- **`toolbar.preloadPath` / `height` 都必填**：host 完全控制 preload（framework 不自动注入 bridge，host 自己在 preload 里 import `exposeWorkbenchBridge()`）；高度固定、宽度自动跟随主窗口。
- **`events` 必须显式列出**：`defineEvent(name)` 只是 pure factory（零 side effect），config.events 数组是 framework 知道有这个 event 的唯一来源 —— 避免 module load order 隐式注册。emit 到未在 config 列出的 event 抛 `UndeclaredHostEventError`。
- **`setup(runtime)` 是 callback**：framework 在 Bind 完成后调用、await 它完成才进入 Ready。runtime 是 long-lived，setup 返回后仍可在 channel handler 里用。

#### Runtime 接口

```ts
import type { BrowserWindow, WebContentsView, ipcMain } from 'electron'

export interface Runtime {
  /** Electron 全部 module proxy —— host 想用什么自取 */
  readonly electron: typeof import('electron')
  readonly mainWindow: BrowserWindow
  readonly toolbarView: WebContentsView | null

  /** 类型化 IPC（推荐 escape 路径，senderPolicy 自动） */
  readonly ipc: TypedIpcRegistry

  /** Raw IPC escape —— 显式承认 I2 是受支持路径而非物理强制 */
  readonly rawIpcMain: typeof ipcMain

  /** 已声明 API 的 main-internal 调用 */
  readonly call: {
    simulator(name: string, ...args: JsonValue[]): Promise<JsonValue>
    host(name: string, ...args: JsonValue[]): Promise<JsonValue>
  }

  /** Window 管理 */
  readonly windows: {
    create(opts: WindowCreateOptions): BrowserWindow
    get(id: string): BrowserWindow | undefined
    all(): BrowserWindow[]
    trust(win: BrowserWindow): Disposable
  }

  /** Framework context（完整暴露；`_` 前缀字段是 unsupported escape，破坏 I1/I2/I3 服务承诺） */
  readonly context: WorkbenchContext

  /** Framework internal 事件 bus（main-process only，不跨进程） */
  on<E extends keyof FrameworkEvents>(event: E, listener: (payload: FrameworkEvents[E]) => void): Disposable

  /** Disposable 管理 */
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
  workspaceOps: {
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

设计要点：

- **`runtime.electron` 是完整 Electron module proxy，不预选**：host 想用 `app / dialog / shell / clipboard / nativeTheme / Menu / globalShortcut / screen / ...` 任何模块自取。framework 不维护"白名单"。
- **`runtime.toolbarView`**：暴露 `WebContentsView` 原始对象，host 可直接 `runtime.toolbarView?.webContents.openDevTools()` 等。
- **`runtime.rawIpcMain` 显式暴露**：承认 I2 是受支持路径而非物理强制（见 I2 诚实表述脚注）。doc 警示：用 raw 等于绕过所有 framework 保证。
- **`runtime.context` 完整暴露**：包括 `_registry` / `_senderPolicy` 等 `@internal` 字段。host 用这些字段属于 unsupported escape，破坏 I1/I2/I3 服务承诺 —— 老 doc 早就承认 framework 不能物理阻止 host 越界，R19 把这条态度从"假装藏起来"变为"明示暴露 + 警示"。
- **`runtime.on`**：main-process 内部事件 bus，不跨进程。`window-created` / `session-changed` 等都是 framework 内部状态变化通知。**和 `events` 字段（main → webview push）严格区分**——FrameworkEvents 不跨进程、HostEvents 跨进程。
- **类型 trade-off**：`runtime.windows.create()` 返回的对象在 production 是真 `Electron.BrowserWindow`（拥有 `minimize()` / `setBounds()` / `maximize()` / `isVisible()` / `focus()` 等完整方法）；framework 内部用 `MinimalBrowserWindow` 结构类型做 DI，只声明装配所需面（`webContents` / `contentView` / `getContentBounds` / `destroy` / `show` / `on`）。host 在 production 代码里按 `Electron.BrowserWindow` 的全 API 调用是安全的；测试注入 fake 时需自行扩展 fake 以满足所调方法。

#### Preload bridge helper

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

host 极端情况下可以**不调** `exposeWorkbenchBridge()`，自定义全套 IPC 协议——但这样 webview 里的 `createWorkbenchClient()` 会 reject。

#### Webview-side client

```ts
// @dimina-kit/workbench/client

export class WorkbenchClientNotReadyError extends Error {}
export class WorkbenchRemoteError extends Error {
  readonly remoteName: string
  readonly code?: string
}

export interface WorkbenchClient<
  HS extends Record<string, (...args: any[]) => any>,
  EV extends readonly HostEvent<any>[],
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
  HS extends Record<string, (...args: any[]) => any>,
  EV extends readonly HostEvent<any>[],
>(): WorkbenchClient<HS, EV>
```

host 在 config 文件里 export `HostServices` / `Events` 类型给 webview import：

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

不引入 `WorkbenchContract` generic、不引入 module augmentation —— host 直接 export 自己已经写好的类型给 webview project import 即可。

### 3.4 Lifecycle phase 表

启动：

| Phase | Framework 行为 |
|---|---|
| **Init** | `app.whenReady()` + framework internal 起 + senderPolicy + IPC transport |
| **Bind** | declared 全字段绑 transport；mainWindow + toolbar WebContentsView + declared windows 建好 |
| **Setup** | 调 `config.setup(runtime)` 并 `await`；runtime 完全可用，topic publish 不抛错（但 toolbar webview 可能尚未 subscribe，初始状态用 snapshot service） |
| **Ready** | toolbar webview load 完成、所有 declared transport 进入正常服务 |

关闭：

| Phase | Framework 行为 |
|---|---|
| **Drain** | 停接新调用；in-flight handler 给 5s grace |
| **Cleanup** | `lifecycle.beforeClose` await + timeout；`runtime.add()` 注册的 host disposable LIFO 执行 |
| **Destroy** | toolbar WebContentsView + windows + transport 关 |
| **Quit** | `app.quit()` |

**关键时序保证**：

- topic `publish()` 在 Init / Bind 期间调抛 `EventNotBoundError`；Setup / Ready 之后调安全（但 fire-and-forget 无 replay，setup 内 publish 给 toolbar 的事件可能丢失，初始状态用 snapshot service）
- `setup(runtime)` 内异步操作 framework 严格 `await`
- `beforeClose` 超时 → 阻止关闭 + log error；host 显式 force quit 才跳过 hook

## 4. 各扩展点归位

| 扩展点 | 旧形态（extension-model） | R19 形态 |
|---|---|---|
| `adapter` / `brandingProvider` / `preloadPath` / `rendererDir` / `apiNamespaces` / `icon` / `appName` / `updateChecker` | config Provider | 归到 `WorkbenchConfig.app` 或顶层字段；语义不变 |
| `menuBuilder` | config Provider，收 menu-only context | `WorkbenchConfig.menu.build(ctx: MenuBuildContext)`；窄签名 |
| `headerHeight` | 老 doc step 1 收为 config 下发 main + renderer | `WorkbenchConfig.app.headerHeight`；framework 同时下发 |
| `IpcRegistry` | 老 doc step 1 对外导出 | **不对外**；host 用 `hostServices` declarative 或 `runtime.ipc` typed wrapper |
| `registerSimulatorApi` | 老 doc step 3 改 per-context instance 方法 | `simulatorApis: { name: handler }` declarative；自动投影 `wx.<name>` |
| toolbar：`toolbarActions` + 裸 `toolbar:action:*` | 老 doc step 4 合一为 `instance.toolbar.set()` | **host 完全拥有 WebContentsView**，自渲染 UI + 自控 preload + 自定 IPC；UI / 数据通信都在 host 自己的 webview，无 framework-rendered action 概念 |
| `onSetup` 内裸 `ipcMain.handle` | 老 doc step 5 改 `instance.ipc` + `registerTrustedWindow` | `hostServices: { name: handler }` declarative（推荐）或 `runtime.ipc.handle()`（next，仍走 senderPolicy）；`runtime.rawIpcMain` 显式 escape with warning |
| 模块组装 `register*Ipc` 公共导出 | 老 doc step 6 撤公共导出 | R19 完全不暴露模块组装概念给 host |
| `extraModules` 幽灵字段 | 老 doc step 6 删 JSDoc | R19 无此字段 |
| host 自定义弹窗 / debug 窗口 | `instance.registerTrustedWindow(win)` | 声明：`windows: { id: WindowContribution }`；imperative：`runtime.windows.create(opts)` 或 `runtime.windows.trust(existingWin)` |
| main → webview push（如 `notify.xxx`） | 散在 `instance.notify.*` 各处 | 显式 `events: [defineEvent<P>(name), ...]`；host 任意位置调 `event.publish(payload)` |
| dimina default 入口 | 老 doc 第 6 节"模块组装路线"（framework internal） | **dimina 自身也走 `workbench(config)` 入口** —— `app/menu/projects/templates/update` 这些字段对 host 与 dimina default 同形态。<br/>**但**：dimina 内置 React panels（projects / session / simulator / popover / settings）的 preload / audience / route 装配是 **framework baseline 私有路径**，不在 `WorkbenchConfig` 表达 —— host 不能加自己的 builtin panel（本期不开放），也不能关掉 dimina default 的 builtin panels（dimina 自身入口默认全装；host 入口默认不装）。dogfooding 收敛的是"public config + lifecycle"，不包括 baseline panels 装配。 |

## 5. 实施步骤

clean break，一次推完；按 PR 切分 6 步：

1. **新建 `@dimina-kit/workbench` package**：导出 `workbench` / `defineEvent` / `Runtime` 类型 / `WorkbenchConfig`；实现 EventBus / 三跨进程字段 transport / WebContentsView 装配 / lifecycle phase 控制 / dispose 链
2. **新建 `@dimina-kit/workbench/client` sub-path export**：webview 侧 `createWorkbenchClient<HS, EV>()` + 错误类型
3. **新建 `@dimina-kit/workbench/preload` sub-path export**：`exposeWorkbenchBridge()` helper
4. **`packages/devtools` 内部改造**：删 `createWorkbenchApp` / `WorkbenchHostInstance` / `IpcRegistry` / `registerSimulatorApi` 等公共导出；内部消费 `WorkbenchConfig`；toolbar 改用 WebContentsView 装配；dimina builtin React panels 固化为 framework baseline 不进 public API
5. **dimina default 入口改造**：把现有 dimina builtin 从 `BUILTIN_MODULES` 装配路径迁到 `workbench(config)` 同入口；builtin panels（projects / session / simulator / popover / settings）继续用 React route 实现，但其 hostServices / events / lifecycle 走 framework runtime 同管道
6. **qdmp 迁移**：删 main entry；新建 `workbench.config.ts` + feature 文件（`auth.ts` / `projects.ts` 等）；新建 toolbar webview 独立 Vite project（含 `preload.ts` + `src/main.ts`）；启动改 `node main.ts`（main.ts 一行 import config）

## 6. 取舍

- **为什么不引入 plugin 系统**：单 host qdmp + dimina 自己两个使用者，"feature 内聚"用 plain TS module 边界（`auth.ts` / `projects.ts` 等）就够，不需要 `definePlugin` 包装。未来若真的出现多供应商 plugin 生态再考虑，**当前不预埋**。
- **为什么 `simulatorApis` / `hostServices` / `events` 三字段分开**：三者 audience / 调用方向 / projection 不同——`simulatorApis` 自动投影 `wx.<name>`、`hostServices` 是 trusted webview RPC、`events` 是 main→webview push。统一成 `channels` 抽象需要引入 `Audience` 类型 / `projectAs` 字段 / `ChannelMode` 三 mode union 等大量额外概念，换来"统一"是表面的。三字段分开心智更直接。
- **为什么 toolbar 改 WebContentsView host 完全拥有**：老 doc 的"整表 `set` 替换"语义只解决 framework-rendered toolbar 的合一，但**toolbar 本质应该由 host 控**——按钮内容、UI 设计、状态显示完全是 host 业务，framework 提供 Web 容器 + IPC bridge 足够。WebContentsView 是 Electron 现代 API（替代 BrowserView），嵌入主窗口子区域、独立 webContents、preload 隔离都是开箱即用。
- **为什么 `runtime.rawIpcMain` 显式暴露而不是藏起来**：老 doc 第 3.2 节诚实表述早就承认 host 永远能 `import { ipcMain }` 裸调——藏起来只是假装隔离。R19 显式暴露 + doc 警示，告知 host **用这个字段即等于自负全部 audience / dispose / senderPolicy 责任**。注意 framework **不主动监控** raw IPC 用法（`runtime.electron` 同样是裸 module proxy，无 telemetry hook），可观测性靠 doc 警示 + 未来可选的 dev mode warn / lint rule，**不靠运行时拦截**——比假装隔离更老实。
- **为什么 `runtime.context` 完整暴露包括 `_` 前缀字段**：host 是 trusted partner（同团队 qdmp + dimina 自己），"防御"的对象是手滑、不是恶意。完整暴露 + JSDoc 警示让 framework 行为对 host 完全可观察、可调试；藏起来反而让 host 在真需要某个内部能力时只能去读 framework 源码自己 reach。
- **为什么不引入 CLI**：host 写 1 行 `main.ts`（`import './workbench.config'`）就是 entry；framework 接管 Electron lifecycle 与"host 写 main entry 文件"不冲突。引入 CLI 要 framework 维护 TS loader / build / watch 一整套 sugar，对 KISS 不划算。如果将来需要 dev sugar，可以加 optional `dimina-workbench` 薄 wrapper，**不是主路径**。
- **不在本文范围**：custom panel 第三方扩展 —— qdmp 不用（它用独立 toolbar webview + windows），本期不做；dimina 内置 React panels 不进 public API（属于 framework baseline）。

## 7. 与 miniapp-snapshot 的关系

| | miniapp-snapshot | 本文（workbench 模型）|
|---|---|---|
| 统一对象 | 面板**数据**同步 | host 对 devtools 的**扩展** |
| 收敛到 | 一个 Host + 全量快照投影 | 一个 `workbench(config)` 入口 + declarative / imperative escape 两层 + 三规则 |
| 核心句 | preload 是唯一真相源 | `workbench(config)` 是唯一入口 |

## 附录 A：host 完整集成代码示例（qdmp）

### feature module

```ts
// auth.ts
import { defineEvent } from '@dimina-kit/workbench'
import { qdmpLogin, qdmpLogout } from './qdmp-api'

let currentUser: { id: string; name: string } | null = null
export const authChanged = defineEvent<{ user: { id: string; name: string } | null }>('authChanged')
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

### workbench.config.ts

```ts
import path from 'path'
import { workbench } from '@dimina-kit/workbench'
import { qdmpAdapter } from './qdmp-adapter'
import { qdmpProjects } from './projects'
import * as auth from './auth'
import * as projects from './projects'
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

export const events = [auth.authChanged, projects.activeProjectChanged] as const

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
    preloadPath: path.resolve(__dirname, './toolbar/preload.js'),
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
    runtime.ipc.handle('qdmp:export', async () => {
      const r = await runtime.electron.dialog.showSaveDialog(runtime.mainWindow, { defaultPath: 'export.zip' })
      return r.filePath
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
import { authChanged } from '../../auth'

const client = createWorkbenchClient<HostServices, Events>()
await client.ready()

// 初始状态：snapshot service
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

  // dimina default 不需要 setup —— 全 declarative 够用
})
```

dimina-devtools 自身和 host 走同一条 `workbench(config)` 入口。dimina 内置 React panels（projects / session / simulator / popover / settings）的 preload / audience / route 是 **framework baseline 私有路径**——它们不在 `WorkbenchConfig` 表达，也不暴露给 host 入口（host 不能加 builtin panel、也不能关 dimina default 的 builtin panels）。dogfooding 收敛的是 `app/menu/projects/templates/update/lifecycle` 这些公共 config 与 IPC / dispose 同管道，**不**收敛 baseline panels 装配。

> **mainWindow 加载归属**：framework 在 `start()` 内 **不**主动 `loadURL` / `loadFile` mainWindow。host（无论 qdmp 还是 dimina default）需要在 `setup(runtime)` 内调 `runtime.mainWindow.loadURL(...)` 加载自己的入口页（dimina default 是 dimina 内置 React app；qdmp 是 qdmp 自己的 main webview）。这与 toolbar / declared windows 由 framework 按 `source` 字段自动加载不同——mainWindow 的视图层归属 host，framework 只保证容器装配 + 生命周期。
