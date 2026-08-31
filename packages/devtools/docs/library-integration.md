# 作为库集成 Dimina DevTools

本文面向把 `@dimina-kit/devtools` 嵌入自己 Electron 应用的维护者。直接使用桌面应用时，只需要读包 [README](../README.md)。

## 安装与入口

```bash
pnpm add @dimina-kit/devtools electron@^43.2.0
```

根入口和 `/launch` 都导出 `launch(config?)`。不传配置时使用内置 renderer、编译后端、项目存储和菜单：

```ts
import { launch } from '@dimina-kit/devtools'

await launch()
```

`launch()` 返回 `Promise<void>`，并通过 `@dimina-kit/electron-deck` 接管 Electron 的 ready、启动和退出流程。一个进程只应选择一条应用启动入口。

## 配置一个宿主

```ts
import { launch, suppressEpipe } from '@dimina-kit/devtools'

suppressEpipe()

await launch({
  appName: 'My Miniapp Studio',
  adapter: myCompilationAdapter,
  apiNamespaces: ['my'],
  icon: '/absolute/path/to/icon.png',
  onBeforeOpenProject: async (projectPath) => {
    await ensureProjectPermission(projectPath)
  },
  onSetup(instance) {
    instance.registerSimulatorApi('login', params => login(params))
  },
})
```

### `WorkbenchConfig`

| 字段 | 用途 |
| --- | --- |
| `appName` | 窗口标题，默认 `Dimina DevTools` |
| `fileTypes` | 追加模板、样式和视图脚本扩展名；这些扩展名会同时交给编辑器和编译后端 |
| `adapter` | 替换默认 `CompilationAdapter` |
| `preloadPath` | 覆盖 simulator preload 的绝对路径 |
| `apiNamespaces` | 增加 `wx`、`dd` 之外的自定义 API 命名空间 |
| `brandingProvider` | 运行时返回 `{ appName }` |
| `panels` | 已废弃，运行时忽略 |
| `headerHeight` | 已废弃，运行时忽略；宿主工具条应使用 host toolbar |

### `WorkbenchAppConfig` 追加字段

| 字段 | 用途 |
| --- | --- |
| `rendererDir` | 覆盖内置 renderer 目录 |
| `modules` | 按 `projects`、`session`、`simulator`、`popover`、`settings` 开关内置 IPC 模块组 |
| `window` | 主窗口尺寸和 `autoShow` 设置 |
| `icon` | 窗口或任务栏图标 |
| `menuBuilder` | 安装宿主菜单；参数是主窗口和窄化后的 `MenuContext` |
| `onSetup` | 窗口与 context 建好后注册宿主扩展，可返回 Promise |
| `onBeforeClose` | 有活动会话时，在自动关闭会话前运行宿主清理，可返回 Promise |
| `onBeforeOpenProject` | 任何打开项目副作用发生前执行；抛错会拒绝本次打开并保留当前会话 |
| `editorViewConfig` | 覆盖 VS Code 工作台 bundle，或提供 web extensions 目录 |
| `updateChecker`、`updateOptions` | 接入更新检查与检查间隔 |
| `projectsProvider` | 替换默认项目列表存储 |
| `projectTemplates`、`builtinTemplates` | 注入模板或控制内置模板 |
| `customCreateProjectDialog` | 用宿主窗口接管新建项目流程 |
| `customEditProjectDialog` | 用宿主窗口接管编辑项目流程 |

字段的完整 TypeScript 形状从 `@dimina-kit/devtools/types` 导入。`panels` 与 `headerHeight` 只为旧宿主保留，不应在新接入中使用。

## 自定义编译后端

`CompilationAdapter` 只有一个 `openProject()` 方法。它接收项目路径、文件类型、sourcemap 与编译回调，返回当前会话：

```ts
import type { CompilationAdapter } from '@dimina-kit/devtools/types'

const adapter: CompilationAdapter = {
  async openProject(options) {
    const server = await startCompilerAndServer(options.projectPath)

    return {
      port: server.port,
      appInfo: {
        appId: server.appId,
        name: server.name,
        path: options.projectPath,
      },
      rebuild: () => server.rebuild(),
      close: () => server.close(),
    }
  },
}
```

`rebuild` 是可选字段，用于兼容旧 adapter；省略后，devtools 的显式重新编译会报告不支持，并退回重新挂载路径。`close()` 必须释放编译器、服务器和 watcher。

## 项目列表和模板

默认项目列表保存在 Electron `userData` 下的 `dimina-projects.json`。`projectsProvider` 可以把必需的 `listProjects`、`addProject`、`removeProject` 接到远端服务或其他本地存储；其余方法按接口定义可选。

```ts
import type { ProjectsProvider } from '@dimina-kit/devtools/projects-provider'

const projectsProvider: ProjectsProvider = {
  listProjects: () => projectStore.list(),
  addProject: path => projectStore.add(path),
  removeProject: path => projectStore.remove(path),
}
```

`projectTemplates` 会放到模板列表前面，同 `id` 会覆盖内置模板。`builtinTemplates` 接受 `'all'`、`'none'` 或允许保留的 ID 数组。

`customCreateProjectDialog` 的结果有三种：

- `null`：用户取消；
- `CreateProjectInput`：devtools 按模板在本地创建项目，再调用 provider；
- `{ ready: Project }`：宿主已经创建完成，devtools 只刷新列表。

`customEditProjectDialog` 可以返回 `null`、`{ name?, iconUrl? }`，或在宿主已经保存后返回 `{ updated: EditableProject }`。完整返回类型从 `/types` 或 `/projects-provider` 导入。

## `onSetup` 中的扩展

`onSetup(instance)` 提供三个受支持的注册面：

```ts
onSetup(instance) {
  instance.registerSimulatorApi('share', params => share(params))

  instance.registerSimulatorUiExtension({
    id: 'host.share-ui',
    rendererScriptPath: '/absolute/path/to/share-ui.js',
  })

  instance.ipc.handle('host:read-profile', () => readProfile())

  // 从宿主自建窗口调用上面的 IPC 时：
  // instance.registerTrustedWindow(dialogWindow)
}
```

这些注册都归当前 context 所有，并在 context 销毁时清理。`registerTrustedWindow()` 返回的对象也可以提前 `dispose()`。

### Simulator 自定义 API

`registerSimulatorApi(name, handler)` 让小程序代码通过 `wx.<name>()` 调用 handler。handler 可以同步返回或返回 Promise；参数和返回值必须能通过 Electron IPC 序列化。返回的 disposer 只删除本次注册，如果同名 API 后来已被覆盖，不会误删新 handler。

### Simulator UI

主进程用 `registerSimulatorUiExtension()` 注册可信的绝对脚本路径。renderer bundle 再从 `@dimina-kit/devtools/simulator-ui` 调用 `registerSimulatorUiExtension({ id, mount, invoke, onChromeAction? })`。主进程和 renderer 的 `id` 必须一致。

`mount()` 收到当前 DeviceShell 的 `overlayRoot`、`appId` 和 `AbortSignal`。扩展负责自己的 DOM 和清理；devtools 负责 simulator reload 时更换挂载点。详细生命周期见[模拟器渲染架构](./simulator-render-architecture.md#downstream-ui-extensions)。

### Host toolbar

`instance.context.views.hostToolbar` 是宿主工具条的主进程控制面，可以加载 URL 或文件、设置 preload 与高度，并通过 `onMessage`、`send`、`onReady` 与页面通信。完整契约和页面侧 `window.diminaHostToolbar` 见[宿主集成能力参考](./host-migration.md)。

## 自定义 simulator preload

`@dimina-kit/devtools/preload` 当前导出：

- `installSimulatorBridge`
- `installCustomApisBridge`
- `installNativeHostBridge`
- `installClipboardBridge`
- `installConsoleInstrumentation`
- `createAppDataSource`
- `setupApiCompatHook`
- `createWxmlSource`（已废弃，计划在 0.5.0 删除）
- `createMiniappSnapshotHost`（已废弃，计划在 0.5.0 删除）

这些 API 用于组合 simulator preload，不包含 main window 的 `contextBridge`。native-host 下的面板数据路径见[面板快照文档](./miniapp-snapshot.md)，不要在新代码中依赖两个已废弃的 snapshot/WXML preload 入口。

## 稳定宿主契约

宿主只需要打开项目、控制工具条、显示状态和打开设置时，优先使用根入口导出的 `asMiniappRuntime()` 与 `MiniappRuntime`。它是对真实 `WorkbenchContext` 的窄化视图，不会复制对象：

```ts
import { asMiniappRuntime } from '@dimina-kit/devtools'

const runtime = asMiniappRuntime(instance.context)
runtime.views.hostToolbar.send('theme', { value: 'dark' })
runtime.notify.projectStatus({ status: 'ready', message: '编译完成' })
```

`WorkbenchContext` 仍从根入口和 `/context` 导出，适合需要组装窗口或服务的宿主，但它包含更多内部 service 类型，受内部重构影响更大。

## 公共入口

下表与 `package.json` 的 `exports` 一致：

| 入口 | 主要内容 |
| --- | --- |
| `@dimina-kit/devtools` | `launch`、宿主 runtime、context、窗口、IPC、更新检查和公共类型 |
| `/launch` | `launch`、`buildDefaultMenu`、`openSettingsWindow` |
| `/types` | 跨进程和宿主配置类型 |
| `/simulator-ui` | renderer 侧 simulator UI 注册契约 |
| `/context` | `createWorkbenchContext` 与 context 类型 |
| `/projects-provider` | 项目 Provider、模板和创建项目服务 |
| `/create-window` | `createMainWindow` |
| `/paths` | renderer、preload、simulator 路径 helper |
| `/workbench-settings` | 工作台设置读写与主题应用 |
| `/preload` | 可组合的 simulator preload API |
| `/bootstrap` | `suppressEpipe`、`setupCdpPort` 等启动 helper |

根入口 `api.ts` 是推荐导入面。除非需要明确分包，否则优先从根入口导入。
