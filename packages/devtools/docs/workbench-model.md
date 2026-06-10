# workbench 模型（host 集成参考）

> 落地的抽取设计：framework `electronDeck()` 经注入式 `RuntimeBackend` 编排 devtools，
> `launch()` 是唯一入口，经框架启动；旧的 `createWorkbenchApp`
> 已被它取代、不复存在。框架内部机制见
> [`framework-extraction-v2.md`](../../electron-deck/docs/framework-extraction-v2.md)。
> 下文的概念框架（config 字段 / Runtime 门面 / 不变量）是 host 集成参考。
>
> 下游 host（如 qdmp）写一份 `WorkbenchConfig` 交给 `launch(config)`，framework
> 接管 Electron 装配、IPC、生命周期。本文是 host 集成参考：怎么用 + API + 必知约束。
>
> 面板数据同步（preload 为唯一真相源）见 [`miniapp-snapshot.md`](./miniapp-snapshot.md)。

## 两条必知坑（先读）

**1. 入口包归属：`launch` 从 `@dimina-kit/devtools` 导入，其余从 `@dimina-kit/electron-deck`。**

```ts
import { launch } from '@dimina-kit/devtools'        // 入口函数
import { defineEvent } from '@dimina-kit/electron-deck'     // 事件 token + config 类型
```

`launch()` 的实现住在 `@dimina-kit/devtools`，因为它要驱动 devtools 真运行时，而
devtools 已依赖 `@dimina-kit/electron-deck`——入口若放 workbench 包会形成循环依赖。所以：

| 你要的 | 从哪导入 |
|---|---|
| `launch(config)` 入口函数 | `@dimina-kit/devtools` |
| `defineEvent` / `WorkbenchConfig` 等类型 | `@dimina-kit/electron-deck` |
| preload bridge `exposeWorkbenchBridge()` | `@dimina-kit/electron-deck/preload` |
| renderer client `createWorkbenchClient()` | `@dimina-kit/electron-deck/client` |

（`@dimina-kit/electron-deck/host` 导出 transport 原语，仅供入口装配，host 不直接用。）

**2. 不要在 ESM main 里顶层 `await launch(...)`。**

Electron 在 main 模块求值完成前不会触发 `app.whenReady()`，而 `launch()` 内部
要 await whenReady——顶层 await 会死锁（ready 等模块求值、模块求值等 launch、
launch 等 ready）。**fire-and-forget + `.catch()`**，event loop 会撑住进程：

```ts
launch({ /* ... */ }).catch((err) => {
  console.error('launch() failed:', err)
})
```

## 1. 最小例子

```ts
// main.ts
import { launch } from '@dimina-kit/devtools'
import { defineEvent } from '@dimina-kit/electron-deck'

const authChanged = defineEvent<{ user: { id: string } | null }>('authChanged')

launch({
  app: { name: 'My DevTools' },
  hostServices: {
    getUser: async () => ({ user: null }),
  },
  events: [authChanged],
}).catch((err) => { console.error('launch() failed:', err) })
```

host 写好这一个调用即可启动。webview 侧 preload / renderer 的用法见 §4。

## 2. config 字段

host 通过 `WorkbenchConfig` 注入扩展能力。绝大多数能力在字段里**声明**，framework
一次性装配；动态创建窗口、监听 Electron app event 等运行时操作通过 `setup(runtime)`
**命令式** escape 完成。

| 字段 | 用途 | 受众 / 方向 |
|---|---|---|
| `app` | 品牌（`name`/`icon`/`headerHeight`）、主窗口尺寸（`window`）、编译适配器（`adapter`） | — |
| `simulatorApis` | 暴露给模拟器小程序的 API，自动投影为 `wx.<name>` | main → 小程序（自动投影） |
| `hostServices` | 暴露给 trusted webview（toolbar 等）的 RPC | trusted webview → main（请求/响应） |
| `events` | main → webview 单向推送；必须 `defineEvent` 且列进此数组 | main → webview（单向） |
| `toolbar` | host 完全拥有的 WebContentsView（UI + preload 都在 host 这边） | — |
| `windows` | 声明式独立窗口的类型位（**当前未接线**——独立窗口用 `runtime.windows.create()` 命令式建） | — |
| `menu` | 应用菜单构造器 `build(ctx)` 的类型位（**当前未接线**） | — |
| `lifecycle` | `beforeClose`（仅"有活跃 session 的主窗口 close"触发，非通用 quit 钩子）+ `timeoutMs` 超时 | — |
| `projects` | 项目列表 provider | — |
| `templates` | 自定义模板 + builtin 开关 | — |
| `update` | 更新检查器 | — |
| `setup(runtime)` | 运行时 escape：声明表达不了的命令式操作 | — |

### simulatorApis / hostServices / events 三者的区别

这三个字段刻意分开，受众和方向都不同，不要合并理解：

- **`simulatorApis`**：注册进 devtools 的 simulator API registry，自动投影成小程序里的
  `wx.<name>(params)`（单参约定）。
- **`hostServices`**：trusted webview（toolbar 等）通过 client `invoke(name, ...)` 调的
  RPC，走 framework typed transport（senderPolicy + envelope 形状校验；JSON-safe 是跨进程
  类型约束，不是运行时深度校验）。
- **`events`**：main 主动 `publish()` 推给 webview 的单向事件。每个事件必须用
  `defineEvent(name)` 创建并列进 `config.events`，framework 才会绑 transport。
  对一个**没列进当前 `config.events`** 的 token（或 transport 尚未就绪时）调 `publish()`，
  会因其 publisher 为 null 抛 `EventNotBoundError`；列进去并经 Setup 之后才安全。

### toolbar

`toolbar` 是 host **完全拥有**的 WebContentsView：

```ts
toolbar: {
  source: { url: 'http://localhost:5173/toolbar.html' }, // 或 { file: '...' }
  preloadPath: '/abs/path/to/toolbar/preload.js',         // 必填
  height: 48,                                             // 必填，固定高度；宽度跟随主窗口
}
```

- `preloadPath` **必填**：framework 不自动注入 bridge，host 在自己的 preload 里调
  `exposeWorkbenchBridge()`（见 §4）。
- `height` **必填**：固定高度，framework 显式推给占位区；不推则占位为 0、toolbar 不可见。
- toolbar 属于 wire transport 的信任集，因此它**能**调 `hostServices` / 收 `events`；
  但它**不能**碰 devtools 全局 IpcRegistry（~72 条内部 channel）——这是安全边界，
  防止 toolbar 内容触达 devtools 内部 IPC。

## 3. 公共 API

### defineEvent

```ts
// @dimina-kit/electron-deck
export function defineEvent<P extends JsonValue>(name: string): HostEvent<P>

export interface HostEvent<P extends JsonValue> {
  readonly name: string
  publish(payload: P): void
  on(listener: (payload: P) => void): Disposable
}
```

`defineEvent` 是零 side-effect 的 pure factory。创建后必须列进 `config.events`，
framework 才会在 Bind 阶段绑 transport。`payload` 必须 JSON-safe（function / Date /
Map / 循环引用等跨进程会失败）。把 event token 放独立模块，main 与 renderer 共享。

### WorkbenchConfig 顶层

```ts
// @dimina-kit/electron-deck
export type SimulatorApiHandler = (...args: any[]) => unknown
export type HostServiceHandler = (...args: any[]) => unknown

export interface WorkbenchConfig {
  readonly app?: AppConfig
  readonly simulatorApis?: Record<string, SimulatorApiHandler>
  readonly hostServices?: Record<string, HostServiceHandler>
  readonly events?: readonly HostEvent<JsonValue>[]
  readonly toolbar?: ToolbarContribution
  readonly windows?: Record<string, WindowContribution>
  readonly menu?: MenuContribution
  readonly lifecycle?: LifecycleContribution
  readonly projects?: ProjectsProvider
  readonly templates?: { custom?: readonly ProjectTemplate[]; builtins?: 'all' | 'none' | readonly string[] }
  readonly update?: UpdateContribution
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

export interface ToolbarContribution {
  readonly source: WebviewSource
  readonly preloadPath: string   // 必填
  readonly height: number        // 必填，固定高度
}

export interface LifecycleContribution {
  readonly beforeClose?: () => MaybePromise<void>  // 仅"有活跃 session 的主窗口 close"时 await；超时 log 后继续。非通用 quit 钩子
  readonly timeoutMs?: number                      // 默认 10_000
}

export function launch(config: WorkbenchConfig): Promise<void>  // 从 @dimina-kit/devtools 导入
```

Handler 形参故意宽松（`any[]`），让 host 写 `(p: { code: string }) => ...` 这种
narrower 签名能直接赋值；webview 侧 `createWorkbenchClient<HS, EV>()` 通过
`Parameters<HS[K]>` 还原精确签名。返回值 runtime 强制 JSON-safe。

### Runtime（setup 拿到的门面）

```ts
export interface Runtime {
  readonly electron: typeof import('electron')   // 完整 module proxy，host 自取任意模块
  readonly mainWindow: BrowserWindow
  readonly toolbarView: WebContentsView | null

  readonly ipc: TypedIpcRegistry                 // 同进程 in-memory typed registry（host RPC 内部承载，非跨进程网关）
  readonly rawIpcMain: typeof ipcMain            // 跨进程裸 IPC：自定义 channel 走这里（绕过框架保证，host 自负）

  readonly call: {
    simulator(name: string, ...args: JsonValue[]): Promise<JsonValue>  // 内部直调已声明 API
    host(name: string, ...args: JsonValue[]): Promise<JsonValue>
  }

  readonly windows: {
    create(opts: WindowCreateOptions): BrowserWindow
    get(id: string): BrowserWindow | undefined
    all(): BrowserWindow[]
    trust(win: BrowserWindow): Disposable
  }

  readonly context: WorkbenchContext
  on<E extends keyof FrameworkEvents>(event: E, listener: (p: FrameworkEvents[E]) => void): Disposable
  add(d: Disposable | (() => MaybePromise<void>)): Disposable  // 注册随 shutdown LIFO 清理
}
```

可用且实装的：`electron`、`mainWindow`、`ipc`、`rawIpcMain`、`call.simulator`、
`call.host`、`windows.create / all / trust`、`add`，以及 `context.workspace` /
`context.workspaceOps.openProject / closeProject`。

**当前 minimal-entry 占位（尚未接线，调用不报错但行为是惰性的）**：

| 字段 | 现状 |
|---|---|
| `toolbarView` | 恒为 `null`（host 经 `config.toolbar` + 自己的 preload 驱动 toolbar；raw view 不外露） |
| `windows.get(id)` | 恒返 `undefined`（声明式 `config.windows` 尚未装配；`windows.create` 是真的） |
| `on(...)`（FrameworkEvents） | 监听器能注册，但 framework 暂无 emitter——**不会 fire** |
| `context.theme` / `context.settings` | 占位 `'dark'`（devtools 暂无顶层 live theme 源） |
| `context.workspaceOps.on('session-changed')` | 返回惰性 Disposable（WorkspaceService 暂不 emit session 变化） |
| `WorkbenchSession.startedAt` | 投影为 `0`（devtools session 暂无开始时间戳） |

`runtime.electron` 是完整 Electron module proxy（`app`/`dialog`/`shell`/`Menu`/…
自取）。`runtime.rawIpcMain` 是显式 escape：用它即绕过 framework 保证、不进 registry，
host 自负 dispose / 错误处理。`runtime.context` 上的 `_registry` / `_senderPolicy`
是 `@internal` escape，使用即破坏 framework 保证。

**启动 / 失败行为（当前 entry）**：

- `setup(runtime)` 抛错时，framework 会 `dispose()` 已装配的 context（连带拆掉
  WireTransport handler 与已绑的 contributions）再把错误抛出，不残留。
- `toolbar` 加载是 best-effort：`source` load 失败只 log、不中断 `launch()`；固定
  `height` 仍会推给占位区。
- `simulatorApis` 经 wire 的 simulator 路由按**单参**（`args[0]`）调，多参不支持
  （devtools simulator API 是 `wx.<name>(params)` 单参约定）。

### exposeWorkbenchBridge（preload）

```ts
// @dimina-kit/electron-deck/preload
export function exposeWorkbenchBridge(options?: { globalName?: string }): void
```

host 在自己的 toolbar/window preload 里调用，把 framework 的 typed RPC + event
bridge 暴露到 webview window（默认全局名 `__workbenchBridge`）。不调它，webview 端
`createWorkbenchClient().ready()` 会抛 `WorkbenchClientNotReadyError`。

### createWorkbenchClient（renderer）

```ts
// @dimina-kit/electron-deck/client
export class WorkbenchClientNotReadyError extends Error {}
export class WorkbenchRemoteError extends Error { readonly remoteName: string; readonly code?: string }

export interface WorkbenchClient<
  HS extends Record<keyof HS, (...args: any[]) => unknown>,
  EV extends readonly HostEvent<JsonValue>[],
> {
  ready(): Promise<void>
  invoke<K extends keyof HS & string>(name: K, ...args: Parameters<HS[K]>): Promise<Awaited<ReturnType<HS[K]>>>
  on<E extends EV[number]>(event: E, listener: (payload: E extends HostEvent<infer P> ? P : never) => void): Disposable
}

export function createWorkbenchClient<
  HS extends Record<keyof HS, (...args: any[]) => unknown>,
  EV extends readonly HostEvent<JsonValue>[],
>(options?: { globalName?: string }): WorkbenchClient<HS, EV>
```

host 在 config 文件里 export `HostServices` / `Events` 类型，给 webview project import：

```ts
// workbench.config.ts（host 写的）
export const hostServices = { /* ... */ } as const
export const events = [authChanged] as const
export type HostServices = typeof hostServices
export type Events = typeof events
```

```ts
// toolbar/src/main.ts（webview 端）
import { createWorkbenchClient } from '@dimina-kit/electron-deck/client'
import type { HostServices, Events } from '../../workbench.config'
const client = createWorkbenchClient<HostServices, Events>()
```

`globalName` 必须与 host preload 的 `exposeWorkbenchBridge({ globalName })` 对齐。

## 4. 最小可跑的三段（main / preload / client）

```ts
// events.ts —— 无 side-effect 的 HostEvent token，main / renderer 共享
import { defineEvent } from '@dimina-kit/electron-deck'
export const authChanged = defineEvent<{ user: { id: string } | null }>('authChanged')
```

```ts
// main.ts —— host entry（顶层执行 launch()，有 side-effect）
import { launch } from '@dimina-kit/devtools'
import { authChanged } from './events'

export const hostServices = {
  getUser: async () => ({ user: null as { id: string } | null }),
} as const
export type HostServices = typeof hostServices
export type Events = readonly [typeof authChanged]

launch({
  app: { name: 'My DevTools' },
  hostServices,
  events: [authChanged],
  toolbar: {
    source: { url: 'http://localhost:5173/toolbar.html' },
    preloadPath: new URL('./toolbar-preload.js', import.meta.url).pathname,
    height: 48,
  },
}).catch((err) => { console.error('launch() failed:', err) })
```

```ts
// toolbar-preload.ts —— host 完全控制
import { exposeWorkbenchBridge } from '@dimina-kit/electron-deck/preload'
exposeWorkbenchBridge()   // framework typed RPC + events bridge
```

```ts
// toolbar/src/main.ts —— webview renderer
import { createWorkbenchClient } from '@dimina-kit/electron-deck/client'
import type { HostServices, Events } from '../../main'   // type-only：被擦除，不拖 main side-effect
import { authChanged } from '../../events'               // token 来自无 side-effect 模块

const client = createWorkbenchClient<HostServices, Events>()
await client.ready()

const { user } = await client.invoke('getUser')
renderLogin(user)

const off = client.on(authChanged, ({ user }) => renderLogin(user))
window.addEventListener('beforeunload', () => off.dispose())
```

## 5. mainWindow 加载归属

当前 devtools entry **会**装配并加载内置 main renderer（`createDevtoolsRuntime` 在 host
`setup` 之前就 `loadFile` 了 devtools 自带的 renderer）。所以 host **不应**在
`setup(runtime)` 里覆盖 `runtime.mainWindow` 的内容——除非有明确替换整个 shell 的新实现。
`runtime.mainWindow` 给 host 做窗口控制（show / bounds / 监听 app event 等），不是让
host 重新 `loadURL` 入口页。`toolbar` 由 framework 按 `source` 加载。

## 6. 关键不变量

| 编号 | 含义 |
|---|---|
| **I1 容器归属** | 注册物挂 framework runtime registry，不进进程全局、不进模块级可变量 |
| **I2 IPC 经网关** | host 跨进程 IPC 的受支持路径（`simulatorApis` / `hostServices` / `events`）走 framework typed transport（senderPolicy + envelope 形状校验）。`runtime.ipc` 是同进程 in-memory registry（host RPC 内部承载），`runtime.rawIpcMain` 是跨进程裸 escape——两者框架都不提供跨进程 senderPolicy 保证 |
| **I3 Disposable 级联** | 注册返 Disposable，进 registry，随 runtime shutdown LIFO 级联清理 |

I2 是「受支持路径上的服务承诺」：framework 无法物理阻止 host 裸 `import { ipcMain }`，
`runtime.rawIpcMain` 把这条边界显式暴露出来。

## 附录 A：host 完整集成示例（qdmp）

> 下面是**示意性的 host 侧集成代码**，住在下游 host 工程（如 qdmp）里，**不在本仓库**。
> `./qdmp-api` / `./qdmp-adapter` / `./projects` / `./menu` / `toolbar/preload.ts` 等都是
> host 自己写的模块，这里只演示它们怎么拼到 `launch(config)` 上。

### feature module

```ts
// events.ts —— 无 side effect 的 HostEvent token，main / renderer 共享
import { defineEvent } from '@dimina-kit/electron-deck'

export const authChanged = defineEvent<{ user: { id: string; name: string } | null }>('authChanged')
```

```ts
// auth.ts —— main 进程
import { qdmpLogin, qdmpLogout } from './qdmp-api'   // main-only deps
import { authChanged } from './events'

let currentUser: { id: string; name: string } | null = null

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

> 把 HostEvent token 独立到 `events.ts`——renderer/toolbar 只 import token，不会把
> main-only 的 `qdmp-api` 拖进 toolbar bundle。

### workbench.config.ts

```ts
import { fileURLToPath } from 'node:url'
import { launch } from '@dimina-kit/devtools'     // 入口在 devtools
import { qdmpAdapter } from './qdmp-adapter'
import { qdmpProjects } from './projects'
import * as auth from './auth'
import * as projects from './projects'
import { authChanged } from './events'
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

export const events = [authChanged] as const

export type SimulatorApis = typeof simulatorApis
export type HostServices = typeof hostServices
export type Events = typeof events

// fire-and-forget + .catch()，不要顶层 await（见开头第 2 条坑）
launch({
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

  projects: qdmpProjects,
  menu: { build: buildQdmpMenu },
  lifecycle: { beforeClose: async () => qdmpProjects.persistSession(), timeoutMs: 10_000 },

  async setup(runtime) {
    // 内置 main renderer 已由 framework 加载（见 §5）；这里只做命令式接线。

    // 监听 app 激活、重显主窗口
    runtime.electron.app.on('activate', () => {
      if (!runtime.mainWindow.isVisible()) runtime.mainWindow.show()
    })

    // 把"需要 runtime（dialog/mainWindow）的能力"暴露给 toolbar：走 host 自己的裸
    // 通道（rawIpcMain + toolbar preload 里的 contextBridge），不是 hostServices——
    // hostServices handler 在 config 阶段定义、拿不到 runtime。toolbar 端用
    // `ipcRenderer.invoke('qdmp:export')` 调（见 toolbar/preload.ts）。
    runtime.rawIpcMain.handle('qdmp:export', async () => {
      const r = await runtime.electron.dialog.showSaveDialog(runtime.mainWindow, { defaultPath: 'export.zip' })
      return { canceled: r.canceled, filePath: r.filePath ?? null }   // JSON-safe
    })

    // host debug 窗口
    if (process.env.QDMP_DEBUG) {
      runtime.windows.create({
        width: 600,
        height: 400,
        source: { url: 'http://localhost:5175/debug.html' },
      })
    }
  },
}).catch((err) => {
  console.error('[qdmp] launch() failed:', err)
})
```

### main.ts（host entry）

```ts
import './workbench.config'
```

### toolbar/preload.ts

```ts
import { contextBridge, ipcRenderer } from 'electron'
import { exposeWorkbenchBridge } from '@dimina-kit/electron-deck/preload'

exposeWorkbenchBridge()

// host 自己的额外 bridge —— 完全自由。这里和 setup 里注册的
// `rawIpcMain.handle('qdmp:export', ...)` 配对：toolbar 调 `window.qdmp.exportProject()`。
contextBridge.exposeInMainWorld('qdmp', {
  exportProject: () => ipcRenderer.invoke('qdmp:export'),
})
```

### toolbar/src/main.ts

```ts
import { createWorkbenchClient } from '@dimina-kit/electron-deck/client'
import type { HostServices, Events } from '../../workbench.config'
import { authChanged } from '../../events'   // 只 import token

const client = createWorkbenchClient<HostServices, Events>()
await client.ready()

// 初始状态：先拉一次 snapshot
const { user } = await client.invoke('getAuthState')
renderLoginButton(user)

// 订阅变化
const off = client.on(authChanged, ({ user }) => renderLoginButton(user))
window.addEventListener('beforeunload', () => off.dispose())

// 业务调用
document.querySelector('#upload')?.addEventListener('click', async () => {
  const r = await client.invoke('uploadCurrentProject', { projectId: getActiveId() })
  showNotification(`Uploaded to ${r.url}`)
})
```
