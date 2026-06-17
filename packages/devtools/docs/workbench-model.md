# workbench 模型（host 集成参考）

> `@dimina-kit/devtools` 的入口是 `launch(config: WorkbenchAppConfig)`。下游 host（如 qdmp）
> 写一份 `WorkbenchAppConfig` 交给 `launch()`，即接管 devtools 的启动、IPC、生命周期。
> 本文是 host 集成的**走查 / 时序 / 不变量**参考：扩展点怎么接、按什么顺序跑、必须守住什么。
>
> `launch()` 是 devtools 自身的领域入口；它把 config 包成框架 backend 调
> `electronDeck({ backend })`，由领域中立的框架编排 Electron 装配。框架底层（`electronDeck` /
> `DeckConfig` / `RuntimeBackend` / wire / trust / 生命周期门控）见
> [`../../electron-deck/docs/architecture.md`](../../electron-deck/docs/architecture.md)，本文不重复。
>
> `WorkbenchAppConfig` 的**完整字段表**见 [devtools README](../README.md) 的「配置参考」一节，本文
> 不照抄字段；这里只讲集成时序与不变量。
>
> 面板数据同步（preload 为唯一真相源）见 [`miniapp-snapshot.md`](./miniapp-snapshot.md)。

## 1. 入口与导入

```ts
import { launch } from '@dimina-kit/devtools'   // 唯一入口
```

- `launch(config?: WorkbenchAppConfig): Promise<void>`。不传 config 即零配置直接运行；传
  `WorkbenchAppConfig` 即配置驱动定制。
- `WorkbenchAppConfig extends WorkbenchConfig`，携带 devtools 专属的扩展面：`window` / `icon` /
  `rendererDir` / `modules` / `menuBuilder` / `onSetup` / `onBeforeClose` / `onBeforeOpenProject` /
  `projectsProvider` / `projectTemplates` / `builtinTemplates` / `customCreateProjectDialog` /
  `updateChecker` / `updateOptions`。这是与框架 `DeckConfig` 不同的一层——`DeckConfig` 是领域中立的
  框架 config，`WorkbenchAppConfig` 是 devtools 的领域 config。
- host hook（`menuBuilder` / `onSetup` / `onBeforeClose`）拿到的是 `WorkbenchHostInstance`：
  `{ mainWindow, context, ipc, registerTrustedWindow(), registerSimulatorApi() }`。

**不要在 ESM main 里顶层 `await launch(...)`。** Electron 在 main 模块求值完成前不会触发
`app.whenReady()`，而启动内部要 await whenReady——顶层 await 会死锁（ready 等模块求值、模块求值等
launch、launch 等 ready）。fire-and-forget + `.catch()`，event loop 会撑住进程：

```ts
launch({ /* ... */ }).catch((err) => {
  console.error('launch() failed:', err)
})
```

## 2. 扩展模型：配置 Provider vs Contribution

devtools 的扩展点分两类（字段全表见 README）：

- **配置 Provider**——构造期、一对一，替换某个内置能力。走 `launch` 的 config 字段：
  `adapter` / `brandingProvider` / `menuBuilder` / `projectsProvider` / `customCreateProjectDialog` /
  `updateChecker` 等。
- **Contribution**——`onSetup` 期、一对多，往同一类里添加多个条目。走 `onSetup(instance)` 上的
  typed 方法。

`onSetup(instance)` 拿到的 `instance` 上有一组 per-context 注册方法，全部进 `context.registry`，
随 context 销毁自动清理：

| 方法 | 语义 |
|---|---|
| `instance.registerSimulatorApi(name, handler)` | 注册 simulator 自定义 API，小程序里 `wx.<name>(params)` 调用（单参约定）。返回 `Disposable` |
| `instance.ipc.handle(channel, fn)` | 经 gated `IpcRegistry` 注册自定义 IPC——绑定 `context.senderPolicy` 网关，不走裸 `ipcMain.handle`。这是 host 自定义 IPC 的唯一受支持路径 |
| `instance.registerTrustedWindow(win)` | 把 host 自有 `BrowserWindow` 的 renderer 加入受信 sender 集，否则它发起的 `instance.ipc` 调用被网关拒绝。窗口关闭即自动移除；返回的 `Disposable` 显式移除 |

## 3. 启动时序

host 集成关心的执行序（生产路径）：

1. `launch(config)` 把 config 包成 backend 调框架 `electronDeck({ backend })`。
2. 框架做 lazy `import('electron')` → 进程生命周期门控（whenReady / single-instance）→ `app.whenReady()`。
3. whenReady 之后框架调 backend assemble：devtools 自建主窗口并加载内置 main renderer。
4. 窗口与 context 就绪后调 `onSetup(instance)`——此刻才安全做命令式接线（注册 IPC / 监听 app event / 建附属窗口）。

时序不变量：

- `onSetup` 在窗口与 context **就绪** 之后跑。config 阶段定义的 handler 拿不到 runtime——需要
  `mainWindow` / `dialog` 的能力必须在 `onSetup` 里接。
- 内置 main renderer 由 devtools 在 `onSetup` 之前 `loadFile` 加载。host **不应** 在 `onSetup`
  里覆盖 `instance.mainWindow` 的内容；`mainWindow` 给 host 做窗口控制（show / bounds / 监听 app
  event），不是让 host 重新 `loadURL` 入口页。

## 4. 项目打开 / 关闭

- `onBeforeOpenProject(projectPath)`：在任何副作用（session teardown / compile / dev-server）
  **之前** 跑，用来按登录 / 权限态 gate 打开。**THROW 即否决**——`openProject` resolve
  `{ success: false, error }`，当前活跃 session 不动，不起 adapter。框架会把抛出的错误投到状态栏
  （`notify.projectStatus({ status: 'error', message })`），host 无需自己 reach `notify` 就能报告
  拒绝，也可在其上叠更丰富的 UX（如弹窗）。声明式替代 monkey-patch `workspace.openProject`。
- `onBeforeClose(instance)`：仅「有活跃 session 的主窗口 close」时 await，不是通用 quit 钩子。
  session 的销毁由框架在此 hook 之后自动处理；host 在这里做持久化等收尾。

## 5. 项目面板扩展（projectsProvider / templates / 自定义对话框）

宿主对项目面板的三个正交扩展点——`projectsProvider`（接管项目列表存储）/ `projectTemplates` +
`builtinTemplates`（注入 / 覆盖 / 裁剪模板）/ `customCreateProjectDialog`（替换内置「新建项目」
对话框）——的字段语义、何时用哪个、最小示例，见 [devtools README](../README.md) 的
「Embedding & Extending the Project Panel」一节。本文不重复其字段细节。

`customCreateProjectDialog` 的返回是 `CustomCreateProjectDialogResult` 三选一：

- `null` —— 用户取消。
- `CreateProjectInput` —— 让 devtools 在本地物化模板（copy template → 写 `project.config.json`
  → `provider.addProject`）。
- `{ ready: Project }` —— 宿主已自建好项目（通常经自家后端），devtools 跳过物化、只刷新列表。

## 6. host 自定义 IPC 与受信边界

host 跨进程 IPC 的受支持路径是 `instance.ipc`（gated `IpcRegistry`，绑 `context.senderPolicy`，
随 context LIFO 清理）。三条不变量：

| 编号 | 含义 |
|---|---|
| **I1 容器归属** | Contribution 注册物挂 `context.registry`，不进进程全局、不进模块级可变量 |
| **I2 IPC 经网关** | host 自定义 IPC 走 `instance.ipc`——sender 须在受信集（toolbar / 经 `registerTrustedWindow` 加入的窗口），否则被网关拒绝 |
| **I3 Disposable 级联** | 注册返 `Disposable`，进 registry，随 context shutdown LIFO 级联清理 |

host 自有弹窗的 renderer 默认不在受信集；要让它调 `instance.ipc`，先
`instance.registerTrustedWindow(win)`。

## 附录 A：host 完整集成示例（qdmp）

> 下面是**示意性的 host 侧集成代码**，住在下游 host 工程（如 qdmp）里，**不在本仓库**。
> `./qdmp-adapter` / `./projects` / `./menu` 等都是 host 自己写的模块，这里只演示它们怎么拼到
> `launch(config)` 上。

```ts
import { launch } from '@dimina-kit/devtools'
import { qdmpAdapter } from './qdmp-adapter'
import { qdmpProjects } from './projects'
import { buildQdmpMenu } from './menu'

// fire-and-forget + .catch()，不要顶层 await（见 §1）
launch({
  appName: 'QDMP DevTools',
  adapter: qdmpAdapter,
  menuBuilder: buildQdmpMenu,

  // 项目面板扩展（字段语义见 README）
  projectsProvider: qdmpProjects,

  // 按登录态 gate 打开项目：THROW 即否决
  onBeforeOpenProject: async (projectPath) => {
    if (!(await qdmp.isLoggedIn())) {
      throw new Error('请先登录')
    }
  },

  // 有活跃 session 的主窗口 close 前持久化
  onBeforeClose: async () => {
    await qdmpProjects.persistSession()
  },

  onSetup: (instance) => {
    // 命令式接线只能在这里做——窗口与 context 已就绪（见 §3）。

    // simulator 自定义 API：per-context，小程序里 wx.qdmpLogin(...)
    instance.registerSimulatorApi('qdmpLogin', (params) => qdmp.login(params))

    // host 自定义 IPC：经 gated IpcRegistry，绑 senderPolicy
    instance.ipc.handle('qdmp:export', async () => {
      const r = await dialog.showSaveDialog(instance.mainWindow, { defaultPath: 'export.zip' })
      return { canceled: r.canceled, filePath: r.filePath ?? null }   // JSON-safe
    })

    // host 自有弹窗须先加入受信集，否则其 instance.ipc 调用被网关拒绝
    if (process.env.QDMP_DEBUG) {
      const debugWin = new BrowserWindow({ width: 600, height: 400 })
      instance.registerTrustedWindow(debugWin)
      void debugWin.loadURL('http://localhost:5175/debug.html')
    }
  },
}).catch((err) => {
  console.error('[qdmp] launch() failed:', err)
})
```
