# Electron Container 架构

> 给新加入 dimina-kit devtools 的工程师：本文描述 devtools 整个 Electron 容器的拓扑、IPC、Session、关键服务、native-host 运行时、以及安全与启动序列。读完应能 onboard 到 `src/main/`、`src/preload/`、`src/simulator/` 这三棵代码树。
> 配套文档：[`native-bridge-protocol.md`](./native-bridge-protocol.md) —— native-host 运行时 Bridge 协议契约；[`project-window-layout.md`](./project-window-layout.md) —— 三宫格布局抽象层。

## 摘要（TL;DR）

devtools 容器是一个 BrowserWindow（workbench 主舞台）+ 若干 WebContentsView 覆盖层（simulator DevTools / settings / popover）。mini-program 跑在 native-host 运行时上：simulator 自身是主进程顶层 `WebContentsView`（承载 React DeviceShell），每个页面是一个子 `<webview>`（由主进程钉到该项目的 `persist:miniapp-<key>` partition，见 §3.1），service 逻辑跑在一个隐藏的 ServiceHost BrowserWindow。所有 mini-program runtime 消息经 main 进程的 BridgeRouter（`src/main/ipc/bridge-router.ts`）这条总线编排 service ↔ simulator ↔ render 的两级 session（AppSession / PageSession）。

## 1. 窗口拓扑全景图

> 一句话：一个 BrowserWindow（workbench）做主舞台，里面挂多个 WebContentsView 做覆盖层；mini-program 跑在 native-host 运行时上——simulator 是顶层 WebContentsView，页面用子 `<webview>` 承载，service 逻辑在隐藏的 ServiceHost 窗口里。

### 1.1 进程清单

| 进程类别 | 数量 | 备注 |
|---|---|---|
| Electron main | 1 | 唯一可触达 fs/net/Electron API 的进程 |
| Renderer（workbench main） | 1 | React workbench UI（内嵌 Monaco 编辑器，见 [`editor-integration.md`](./editor-integration.md)） |
| Renderer（settings 独立窗口） | 0..1 | 用户打开「开发工具设置」时按需创建，见 `windows/settings-window/create.ts` |
| Overlay renderer（settings overlay / popover） | 0..n | 跑在 WebContentsView 里，附在 main window 上 |
| WebContentsView（simulator DeviceShell） | 1 per project | 主进程顶层 WebContentsView，跑 React DeviceShell，partition = 该项目的 `persist:miniapp-<key>`（appId 派生，见 §3.1 / §5） |
| Renderer（page `<webview>`） | n | 每个 mini-program 页面一个子 `<webview>`，挂在 simulator WebContentsView 里 |
| BrowserWindow（service-host） | 0..1 | 跑 mini-program service 逻辑的隐藏窗口；`constructServiceHostWindow` 建窗在 `windows/service-host-window/create.ts` |

### 1.2 窗口与 View 嵌套层级

```
Electron app
└── BrowserWindow (workbench main window)         ← main-window/create.ts（createMainWindow）
    ├── webPreferences.preload = mainPreloadPath   ← 暴露 window.devtools.ipc
    └── contentView (V)                            ← 通过 new View() 包了一层
        ├── mainWebView (主 renderer)              ← workbench React UI
        ├── nativeSimulatorView : WebContentsView  ← simulator DeviceShell（顶层，托管子 webview）
        │   ← view-manager.ts 的 attachNativeSimulator 创建
        │   preload = cjsSiblingPreloadPath(ctx.preloadPath)（webPreferences.preload）
        │   partition = persist:miniapp-<key>（项目 appId 派生，attachNativeSimulator 从 simulator URL 的 ?appId= 解析）
        │   └── DeviceShell（React，device-shell.tsx）
        │       └── <webview> ×N  ← 每页一个，device-shell.tsx；不带静态 partition，
        │           由 will-attach-webview 钉到宿主 WCV 同一 per-project partition
        │           preload = dist/render-host/preload.cjs       ← 跑 @dimina/render bundle
        ├── simulatorView : WebContentsView        ← DevTools 面板（Chrome DevTools 实例本身）
        │   ← view-manager.ts 的 attachNativeSimulatorDevtoolsHost 创建，绑到 bridge 报告的活跃 service-host wc
        ├── settingsView : WebContentsView         ← 「设置」覆盖层
        └── popoverView  : WebContentsView         ← 通用悬浮层

另起：BrowserWindow (settings window)             ← 用户主动 open settings 时
    preload = mainPreloadPath
    （独立 top-level window，非 overlay）

另起：BrowserWindow (service-host window)         ← 隐藏，跑 @dimina/service bundle
    partition = persist:miniapp-<key>（createServiceHostWindow 传项目 appId；
    预热池 / 无 appId 时回落 persist:simulator，见 serviceHostSpec / create.ts）
    preload = dist/service-host/preload.cjs
    见 createServiceHostWindow（windows/service-host-window/create.ts）
```

> simulator 之所以是主进程的顶层 `WebContentsView` 而不是 renderer 里的 `<webview>`：Electron 不支持 webview 套 webview（`webviewTag` 在 webview guest 里被强制 false），所以若 simulator 自己是 `<webview>`，DeviceShell 的每页 render-host `<webview>` 永远 attach 不上。顶层 WebContentsView 不是 guest，才能托管子 `<webview>`。细节见 §5。

### 1.3 关键放置约束

- DevTools 面板（`simulatorView`）是 Chromium 自己的 DevTools UI，挂在主窗口上做 overlay；它通过 `wc.setDevToolsWebContents(simulatorView.webContents)` 绑定到逻辑层 service-host wc（Console/Network/Sources 都在那跑），并由 bridge 的 render 事件在页面切换时重指向，见 `view-manager.ts` 的 `pointNativeDevtoolsAtServiceWc`。Elements 面板的 DOM 另经 elements-forward 路由到活跃 render-host guest。
- WXML / AppData / Storage 三个右侧 panel 的数据**不是**独立 WebContentsView，是 React 组件读 IPC 数据后画的（见 `renderer/controllers/use-panel-data.ts`）。容器层只负责 simulator / settings / popover 三种 overlay 的生命周期。

## 2. 进程间通信 (IPC)

> 一句话：channel 名集中在 `src/shared/ipc-channels.ts`，按业务域加前缀；main 注册 handler，renderer 通过 contextBridge 注入的 `window.devtools.ipc` 调用。

### 2.1 channel 前缀地图

> channel 常量全部导出自 `src/shared/ipc-channels.ts`（bridge 协议另在 `src/shared/bridge-channels.ts`）。下表按业务域列出真实导出的 `*Channel` 常量。

| 前缀 | 常量 | 域 |
|---|---|---|
| `simulator:attach-native` / `set-native-bounds` / `set-device-info` / `detach` / `console` / `current-page` | `SimulatorChannel` | simulator overlay 生命周期 + 设备信息 + 当前页推送 |
| `service-host:host-env:update` | `ServiceHostChannel` | main → service-host 窗 live-update host-env 快照（设备切换不重启）|
| `simulator:custom-apis:invoke` | `SimulatorCustomApiChannel` | main-window renderer 直接调下游注册的 custom API |
| `simulator:custom-apis:bridge-request` / `bridge-response` | `SimulatorCustomApiBridgeChannel` | simulator WCV 的 custom-apis 桥：preload `ipcRenderer.send` Request → 绑定该 simWc 的 `ipcMain.on` 派发器（`view-manager.ts` `attachNativeCustomApiBridge`）→ `simWc.send` 回 Response（不经 main renderer 代理）|
| `simulator:storage:*` | `SimulatorStorageChannel` | CDP-backed storage 面板 |
| `simulator:element:*` | `SimulatorElementChannel` | CDP-backed 元素审查 |
| `simulator:wxml:*` | `SimulatorWxmlChannel` | main 推 WXML 树（seed `GetSnapshot` + push `Event`）|
| `simulator:appdata:*` | `SimulatorAppDataChannel` | main 推 AppData 快照（seed `GetSnapshot` + push `Event`）|
| `workbenchSettings:*` | `WorkbenchSettingsChannel` | 全局开发工具设置 + 主题 |
| `project:*` | `ProjectChannel` | 当前 project 会话（open / close / status / compile / thumbnail）|
| `project:fs:*` | `ProjectFsChannel` | 项目文件系统沙箱（Monaco 编辑器读写）|
| `editor:openFile` | `EditorChannel` | main → renderer 在 Monaco 打开文件到 line:col |
| `projects:*` | `ProjectsChannel` | project 列表 / 模板 / 创建 |
| `dialog:*` | `DialogChannel` | OS dialog |
| `view:*` | `ViewChannel` | renderer → main 报告 simulator DevTools / host-toolbar overlay 的 bounds + 高度协商 |
| `popover:*` | `PopoverChannel` | popover overlay |
| `window:navigateBack` | `WindowChannel` | 容器层导航 |
| `app:getBranding` | `AppChannel` | branding |
| `miniapp-snapshot:*` | `MiniappSnapshotChannel` | AppData / WXML 通用 push/pull（**已废弃**：native-host 下无收端，面板数据改走 `simulator:wxml:*` / `simulator:appdata:*`，见 `miniapp-snapshot.md` §6）|
| `automation:port` | `AutomationChannel` | 自动化 ws 端口查询 |
| `settings:*` | `SettingsChannel` | 嵌入式 settings overlay |
| `updates:*` | `UpdateChannel` | UpdateManager |
| `dmb:*` | `bridge-channels.ts` | bridge-router 协议（service ↔ simulator）|
| `simulator:dom-ready` / `navigation-bar` / `nav-action` / `tab-action` / `api-call` | `SIMULATOR_EVENTS`（`bridge-channels.ts`）| main → simulator window 推送事件 |

### 2.2 invoke vs send

| 模式 | 用途 | 注册端 | 调用端 |
|---|---|---|---|
| `ipcMain.handle(ch, fn)` ↔ `ipcRenderer.invoke(ch, ...)` | 请求/响应、有返回值或异步副作用 | main：`src/main/ipc/*.ts` | renderer：`renderer/shared/api/ipc-transport.ts` |
| `ipcMain.on(ch, fn)` ↔ `ipcRenderer.send(ch, ...)` | 单向通知（lifecycle、ack）| 同上 | 同上 |
| `webContents.send(ch, payload)` | main → renderer 主动推送 | — | main 端 |
| `simulatorWc.send(ch, payload)` | main → simulator WCV（顶层 WebContentsView，**非** renderer `<webview>`）；走 `WebContents.send` | — | bridge-router（`ap.simulatorWc.send(E.NAV_BAR/NAV_ACTION/TAB_ACTION/API_CALL, …)`）|
| `ipcRenderer.sendToHost(ch, p)` | guest webview → 其 embedder（不走 main）| — | snapshot 框架的 console 抓取（`instrumentation/console.ts`）与 miniappSnapshot push（`miniapp-snapshot/host.ts`）——只在**有 embedder 的 composed/external preload** 里走这条路。**native-host 默认的 render-host 子 `<webview>` guest 不用它**：它的 console 改走 `DiminaRenderBridge.invoke({ type:'consoleLog', target:'container' })` 这条 bridge 容器消息直达 main（`render-host/preload.cjs`，service-host 同理）→ bridge-router → `ctx.guestConsole`（见 `services/console-forward/index.ts`）。custom-apis 也**不**用 `sendToHost`（已改 `ipcRenderer.send` 直达 main）|

### 2.3 注册端在哪里

```
src/main/ipc/
├── app.ts                ← AppChannel（branding）
├── bridge-router.ts      ← dmb:* + simulator:* 推送（重头戏，见 §4.3）
├── popover.ts            ← PopoverChannel
├── project-fs.ts         ← ProjectFsChannel（Monaco 文件系统沙箱）
├── projects.ts           ← ProjectsChannel
├── session.ts            ← ProjectChannel（open / close / status / compile 等）
├── settings.ts           ← SettingsChannel + WorkbenchSettingsChannel
├── simulator.ts          ← SimulatorChannel + ServiceHostChannel + SimulatorCustomApiChannel
├── simulator-module.ts   ← simulator 内置模块：fan-out 到 simulator.ts + views.ts + bridge-router
├── views.ts              ← ViewChannel（DevTools / host-toolbar overlay bounds）
└── index.ts              ← 重导出各 register*/​*Module
```

`index.ts` 只聚合 `registerAppIpc` / `registerSimulatorIpc` / `popoverModule` / `projectsModule` / `sessionModule` / `settingsModule` / `simulatorModule`。`BUILTIN_MODULES`（`src/main/app/app.ts`）= `{ projects, session, simulator, popover, settings }` 五个模块；`registerBuiltinModules` 遍历它们调 `BUILTIN_MODULES[id].setup(context)` 一次性挂载（`simulator` 模块再 fan-out 到 simulator.ts + views.ts + bridge-router）。`registerAppIpc(context)` 与 `registerProjectFsIpc(context)` 不走模块表，由 app.ts 单独注册。

### 2.4 renderer 侧 façade

`window.devtools.ipc` 由 `src/preload/windows/main.ts` 用 `contextBridge.exposeInMainWorld('devtools', { ipc: { invoke, send, on, once, removeListener } })` 暴露。一切 channel 名称都走这层 — preload **不**做白名单（注释在 `windows/main.ts` 解释了原因），授权全交给 main 端的 `sender-policy.ts` + zod schema。

## 3. Session 与 preload 注入

> 一句话：partition 是 Chromium 存储/preload 隔离单位；dimina-kit 给**每个项目**按其 `appId` 派生一个稳定的 `persist:miniapp-<key>` partition（`miniappPartitionKey` / `miniappPartition`，`services/views/miniapp-partition.ts`），把同一项目的 mini-program 上下文（simulator WCV + render-host guests + service-host）锁在一起、跨项目互相隔离。
>
> 共享 `persist:simulator`（`SHARED_MINIAPP_PARTITION`，`miniapp-partition.ts`）只有两个用途：**预热池**（池窗在项目未知时预热，故意不做隔离，见 `service-host-window/create.ts` 的 KNOWN BLOCKER 注释）和 **appId 无法派生时的 fallback**。

### 3.1 partition 表

| partition | 创建位置 | 用途 | 注入的 preload |
|---|---|---|---|
| 默认（main window）| BrowserWindow 默认 session | workbench UI、settings 独立窗、settings/popover overlay | `mainPreloadPath`（`utils/paths.ts`）|
| `persist:miniapp-<key>`（per-project）| `miniappPartition(appId)`（`miniapp-partition.ts`）派生；simulator WCV 在 `attachNativeSimulator` 从 simulator URL 的 `?appId=` 解析，service-host 在 `createServiceHostWindow` 传项目 appId（`service-host-window/create.ts`），render-host 子 `<webview>` 不带静态 partition、由宿主 WCV 的 `will-attach-webview` 钉成同一 partition | 该项目的 simulator DeviceShell WebContentsView + 每页 render-host 子 `<webview>` + service-host BrowserWindow（三者共享存储，与其他项目隔离） | simulator WebContentsView 用 `webPreferences.preload = cjsSiblingPreloadPath(ctx.preloadPath)`（`attachNativeSimulator`）；render-host 子 `<webview>` 用 `device-shell.tsx` 的 `preload` 属性；service-host 用 `webPreferences.preload`。session 级配置（Referer/CORS 策略、`difile://`、`dmb-resource://`）经 partition configurator 注册表（`registerMiniappSessionConfigurator` / `configureMiniappSession`，`miniapp-partition.ts`）在每个 partition 首次使用前应用一次：`setupSimulatorSessionPolicy()`（`app/app.ts`）+ `setupSimulatorTempFiles`（`app/app.ts`）+ `installResourceProtocolHandlers`（`bridge-router.ts`）。不再注册 frame preload，`main-window/create.ts` 也不再碰 simulator session |
| `persist:simulator`（shared fallback）| `SHARED_MINIAPP_PARTITION`（`miniapp-partition.ts`）| 两个用途：① 服务宿主预热池的默认 spec（无 appId，故意不做隔离）；② appId 无法派生时的 fallback。作为 fallback session 同样装上与 per-project partition 相同的协议/策略 | 同上（service-host preload）|

### 3.2 preload 一览

| 文件（源）| 输出（dist）| 注入方式 |
|---|---|---|
| `src/preload/windows/main.ts` | `dist/preload/windows/main.cjs` | 通过 `webPreferences.preload` 显式挂在 main window / settings window / overlay view 上 |
| `src/preload/windows/simulator.ts` | `dist/preload/windows/simulator.js`（取其 `.cjs` sibling）| 通过 `webPreferences.preload = cjsSiblingPreloadPath(ctx.preloadPath)` 显式挂在 simulator WebContentsView 上（`view-manager.ts` `attachNativeSimulator`）|
| `src/service-host/preload.cjs` | （直接以 cjs 提供）| `webPreferences.preload` 挂在 service-host BrowserWindow |
| `src/render-host/preload.cjs` | （直接以 cjs 提供）| 作为每页 render-host 子 `<webview>` 的 `preload` 属性传入（`getRenderPreloadUrl()`），见 `device-shell.tsx` |

### 3.3 webPreferences 差异

| 窗口/View | `contextIsolation` | `nodeIntegration` | `sandbox` | `webviewTag` | 备注 |
|---|---|---|---|---|---|
| main window | `true` | `false` | `false` | —（未启用）| `main-window/create.ts`；`sandbox: false` 是给 preload `require('electron')` 用的。主 renderer 自身**没有** `<webview>`（simulator 是顶层 WCV，不在 renderer 里），故不开 `webviewTag` |
| settings window | `true` | `false` | `false` | — | `settings-window/create.ts` |
| settings overlay view | `true` | `false` | `false` | — | `view-manager.ts` |
| popover overlay view | `true` | `false` | `false` | — | `view-manager.ts` |
| simulator DeviceShell WebContentsView | **`false`** | `false` | `false` | `true` | `view-manager.ts`（`attachNativeSimulator`）；`webviewTag:true` 落在这个**顶层 WCV**（不是主 window）上——才能托管每页 render-host 子 `<webview>` guest；isolation 关掉因为 dimina runtime 与 user 代码共享同一 JS realm |
| 每页 render-host `<webview>` | **`false`** | `false` | — | — | `device-shell.tsx`；contextIsolation/sandbox 由主进程 `will-attach-webview`（`view-manager.ts`）钉成 false；跑 `@dimina/render` bundle，与 render bridge 共享 realm |
| service-host BrowserWindow | `false` | `false` | `false` | — | `service-host-window/create.ts`，需要直接挂全局的 jsbridge |

### 3.4 expose 的 fallback 模式

`src/preload/shared/expose.ts` 的 `exposeOnMainWorld(key, value)`：

1. 优先 `contextBridge.exposeInMainWorld(key, value)`；
2. 失败（即 `contextIsolation: false` 的环境）退化为 `(window as any)[key] = value`；
3. 返回一个 disposer，只能撤销 fallback 路径下的 `window[key]`，且只有 `window[key] === value` 时才删，避免清掉别人的句柄。

native-host preload (`preload/runtime/native-host.ts`) 与 custom-apis bridge 都用这条工具，统一处理 isolation on/off 两种宿主。

## 4. 关键服务

> 一句话：WorkspaceService 管 project 生命周期，ViewManager 管 overlay view，BridgeRouter 管 mini-program runtime 的消息总线，AutomationService 把 ws 接进来。

### 4.1 WorkspaceService — `src/main/services/workspace/workspace-service.ts`

| 责任 | 入口 |
|---|---|
| 列出 / 添加 / 移除 project | `listProjects` / `addProject` / `removeProject`（`workspace-service.ts`）|
| 当前 session 打开 / 关闭 | `openProject` / `closeProject`（`workspace-service.ts`）。两者经一个 FIFO 互斥锁**串行化**：teardown→commit 段不交错，避免一个并发 close 在 open 等待编译时 `disposeAll()` 拆掉 open 正在建的 view、或让 `currentSession` 与 bridge `appSessions` 两套状态 desync |
| 编译配置读写 | `getCompileConfig` / `saveCompileConfig`（`workspace-service.ts`）|
| 缩略图（含远程 host 路径）| `captureThumbnail` / `getThumbnail`（`workspace-service.ts`）。native-host 下截活跃 render-host guest（手机框内的 mini-program 内容）；guest 不可用时返回 null（不拿外壳充当内容），capturePage 前查 `isDestroyed`、capture 后复核目标仍是活跃 guest（防中途换页存错帧）。非 native-host 截外层 simulator WCV |

provider 注入：远程 host（如下游宿主的云 workspace）通过 `ProjectsProvider` 接管 fs，默认走 `LocalProjectsProvider`，把 `<userData>/dimina-projects.json` 当后端（`shared/types.ts`、`services/projects/project-repository.ts`）。

### 4.2 ViewManager — `src/main/services/views/view-manager.ts`

唯一被允许 `new WebContentsView` / `addChildView` / `removeChildView` 的组件。状态都在闭包里，对外只暴露动作。

```
attachNativeSimulator(simulatorUrl, _simWidth) ← simulator mount 入口：把 simulator 本身建成顶层 WebContentsView
attachNativeSimulatorDevtoolsHost()            ← 建右栏 DevTools 面板 WCV，绑到活跃 service-host wc
pointNativeDevtoolsAtServiceWc(wc)             ← 把 DevTools 前端重指向给定 service-host wc
pointNativeDevtoolsAtActiveServiceHost(appId)  ← 解析活跃 service-host 并重指向（页面切换时跟随）
attachNativeCustomApiBridge(simWc)             ← 给 simulator WCV 装 custom-apis 桥的 ipcMain.on 派发器
setNativeSimulatorViewBounds(...)              ← 设备外框 rect + zoom 下发到嵌套 guest
showSettings / hideSettings                    ← settings overlay 显隐
showPopover / hidePopover                       ← popover overlay 显隐
detachSimulator()                              ← 关 / 切换 project 时统一销毁（含同步清桥 session）
```

simulator 的 mount 入口是 `attachNativeSimulator`（renderer 经 `SimulatorChannel.AttachNative` 触发，`main/ipc/simulator.ts`）。注意：ViewManager **没有** 一个独立的 `attachSimulator(simWcId, simWidth)` 方法——native-host 是唯一 runtime，右栏 DevTools 面板由 `attachNativeSimulatorDevtoolsHost` 建立，并通过 `pointNativeDevtoolsAtServiceWc` / `pointNativeDevtoolsAtActiveServiceHost` 在页面切换时跟随活跃 service-host wc（详见 §5.2）。（代码里另有一个 `networkForward.attachSimulator(simWc)` 是 network-forward 服务挂 CDP 调试器，跟 view 生命周期无关，不要混淆。）

`attachNativeSimulator`（`view-manager.ts`）把 simulator 自己建成一个顶层 `WebContentsView`（不是 renderer 的 `<webview>` guest），用 `cjsSiblingPreloadPath` 的 `.cjs` preload + `webviewTag:true / contextIsolation:false / sandbox:false` + 该项目的 `persist:miniapp-<key>` partition（从 simulator URL 的 `?appId=` 派生并先 `configureMiniappSession`）——顶层 WebContentsView 不是 guest，能托管 DeviceShell 的每页 render-host `<webview>`（见 §5）。它还顺手装上 custom-apis 桥的 `ipcMain.on` 派发器（`attachNativeCustomApiBridge`）。`setNativeSimulatorViewBounds`（`view-manager.ts`）把 renderer 量出来的设备外框内屏 rect + zoom 应用上去，并把 `zoomFactor` 传播到已挂载的嵌套 render-host guest。

`detachSimulator`（`view-manager.ts`）销毁 simulator view，同时顺手销毁 native simulator view、hide popover、销毁 settings view、摘除 custom-apis 桥派发器。在对 WCV 发起异步 `close()` **之前**，它先 `ctx.bridge.disposeSessionsForSimulator(simWcId)` **同步**清掉该 simulator 名下的 bridge app session、关闭其 render-host guest 与 service-host 窗——否则旧 session 的 `renderWc` 会残活到下个项目，`resolveCurrentApp` / `captureThumbnail` 仍能解析到它、共享的 `persist:miniapp-<appId>` partition 又让新项目复用旧 guest，导致重开后渲染上一个项目。除 `closeProject` 外，`openProject` 在已有 session 时的切换分支也会调 `detachSimulator`（回项目列表的返回按钮不走 closeProject，切换是唯一拆除时机）。`disposeSessionsForSimulator` 返回可 await 的 `Promise`：同步前缀清 map + close guest/service 窗后，其异步尾部（pool.release / resourceServer.close）的完成与失败可被观测——同步拆除站点（`detachSimulator`）只 `.catch` 记录尾部失败，map 已即时干净;`resolveCurrentApp` 在无 appId、无 workspace session 时仅当所有存活 session 同属一个 appId 才回退到最新 spawn（同 app respawn），多个不同 appId 残留则返 null,不再无条件取最后一个。另外 `closeProject` 拆除期间 `workspace.isClosing()` 为 true（`disposeSession` 先把 currentSession 置 null、bridge app session 要到之后的 `disposeAll` 才清,中间有窗口）,`resolveCurrentApp` 见到 isClosing 直接返 undefined,避免把濒死项目的 guest 解析出去。

### 4.3 BridgeRouter — `src/main/ipc/bridge-router.ts` (重头戏)

这是 main 进程承担 mini-program runtime 编排的核心。建议把它当成一个状态机：

**两级 session 模型**

| 实体 | 内容 |
|---|---|
| `AppSession`（`bridge-router.ts`）| `appSessionId` / `appId` / `pkgRoot` / `root` / `scene` / `serviceWindow` / `serviceWc` / `simulatorWc` / `serviceLoaded` / `resourceBaseUrl`（资源 fetch 的统一 base，通常是 dev server origin）/ `resourceServer`（nullable，仅当 caller 没给 `resourceBaseUrl` 时起的本地降级 server）/ `hostEnv` / `appConfig` / `manifest` / `pages: Map<string, PageSession>` / `activeBridgeId`（DeviceShell 上报的可见 top-of-stack bridgeId，首个信号前 null）/ `poolEntryId`（service 窗来自预热池时的 entry id）/ `onServiceClosed` / `onServiceBoot`（dispose 前要摘掉的两个 service 窗监听器）|
| `PageSession`（`bridge-router.ts`）| `bridgeId` / `appSessionId` / `pagePath` / `query` / `isRoot` / `isTab` / `renderWc` / `renderLoaded` / `resourceLoadedSent` / `windowConfig` |

**关键 channel 入口**

| Channel | 注册位置 | 行为 |
|---|---|---|
| `dmb:spawn` | `bridge-router.ts`（`handleSpawn`）| 创建 AppSession + service-host window，返回 `serviceWcId / resourceBaseUrl / manifest / rootWindowConfig`。预热池的 acquire/release 也在 `handleSpawn` 里（由 `DIMINA_PREWARM_POOL_SIZE` 开关，见 [`./prewarm-webview.md`](./prewarm-webview.md)，本文不复述池内部）|
| `dmb:page:open` | `bridge-router.ts` | 在已有 AppSession 上新建 PageSession，返回 bridgeId/windowConfig |
| `dmb:page:close` | `bridge-router.ts` | 关闭非 root 页，root 走 dispose |
| `dmb:page:lifecycle` | `bridge-router.ts` | simulator → service 转发 pageShow/pageHide/... |
| `dmb:nav:callback` | `bridge-router.ts` | simulator 完成路由后，让 service 端的 success/fail 回调 fire |
| `dmb:dispose` | `bridge-router.ts` | 销毁 AppSession（含 sender 合法性校验）|
| `dmb:service:invoke/publish` | `bridge-router.ts` | service → container/render 的消息 |
| `dmb:render:invoke/publish` | `bridge-router.ts` | render-host `<webview>` → service/container 的消息 |
| `dmb:simulator-api` | `bridge-router.ts` | bridge-router raw handler，调 `ctx.simulatorApis.invoke`；renderer 直接调 custom API 走 `simulator:custom-apis:invoke`（`main/ipc/simulator.ts`）|
| `dmb:api:response` | `bridge-router.ts` | simulator 回 `API_CALL` 的 ack，main 据此调原始 service 端 success/fail |
| `dmb:active-page` | `bridge-router.ts`（`ACTIVE_PAGE`）| DeviceShell → main，记录可见 top-of-stack 页的 bridgeId（main 自己没有 z-order 概念）；panel / automation 据此解析「当前页」的 render webContents |

`bridge-router` 还把一个 `BridgeRouterHandle`（`bridge-router.ts` 定义，`install` 里挂到 `ctx.bridge`）暴露给其它 main 服务（simulator-storage / automation / appdata），用 `isNativeHost()` / `getServiceWc()` / `getActiveRenderWc()` / `getActiveBridgeId()` / `resolveRenderWc(bridgeId)` / `onRenderEvent(...)` 解析当前活的 service/render WebContents——getter 每次都重新解析（预热池可能在 respawn 时换窗，缓存句柄会过期）。

**simulator-resident API 派发优先级**（`bridge-router.ts` 的 `handleSimulatorApi`）：

```
service-invokeAPI(name, params)
        ▼
NAV_BAR_API_NAMES   ───►  E.NAV_BAR     → simulator 自己改 navigation-bar
NAV_ACTION_NAMES    ───►  E.NAV_ACTION  → simulator 自己 push/pop 页面栈
TAB_ACTION_NAMES    ───►  E.TAB_ACTION  → simulator 自己改 tab-bar
ctx.storageApi && STORAGE_API_NAMES.has(name)
                    ───►  把异步 wx.setStorage/getStorage/… 路由到 service-host 窗的 file:// store
                          （同步/异步两条写入路径落到同一 store，见 simulator-storage）
ctx.simulatorApis.has(name)  ───► main 进程直接执行（registerSimulatorApi 注册的）
其他                ───►  forwardApiCallToSimulator → E.API_CALL（5s 超时 timer）
                                              ▲
                          simulator 完成 wx.xxx 后回 dmb:api:response
```

**资源协议 `dmb-resource://`**

- 在 `installResourceProtocolHandlers`（`bridge-router.ts`）里 `protocol.handle('dmb-resource', handler)`，挂到默认 protocol + shared fallback session（`persist:simulator`），并经 partition configurator（`registerMiniappSessionConfigurator`，`bridge-router.ts`）装到**每个** per-project `persist:miniapp-<key>` session（现有 + 未来）。
- handler 从 url.hostname 解析 `bridgeId`，回查 AppSession，把请求重定向到 `ap.resourceBaseUrl`——通常是 spawn 传入的 dev-server origin（可能是 localhost、127.0.0.1 或其它 host；`handleSpawn` 接受任意 `opts.resourceBaseUrl` 并补尾斜杠）；只有当 spawn 没带 `resourceBaseUrl` 时才会降级到本地 `DiminaResourceServer`（nullable fallback，见 `dimina-resource-server.ts`）。
- 这条协议让 render/simulator 侧既能保持 CSP / fetch 限制，又能从 mini-program 包内取资源；同一项目的 simulator/render/service 共用一个 per-project session = 共享 storage（跨项目隔离）。

### 4.4 AutomationService — `src/main/services/automation/index.ts`

- `startAutomationServer(ctx, port)`（`automation/index.ts`）起一个 `ws` server，遵循 miniprogram-automator 的 JSON-RPC 协议。
- 端口通过 `AutomationChannel.GetPort`（`automation/index.ts`）暴露给 main renderer；这个 IPC 走 workbench sender policy，**simulator webview 拿不到**（注释在 `automation/index.ts`）。
- `App.callWxMethod` 实现在 `automation/handlers/app.ts`：权威的 `wx.*` 跑在隐藏的 service-host 窗里（simulator / render-guest 上下文里没有 `wx`），所以**每个方法都在那儿跑**：
  - 路由方法（navigateTo / redirectTo / reLaunch / switchTab / navigateBack）：`ctx.bridge.getServiceWc().executeJavaScript('wx.<method>(...)')`（`app.ts`），让导航走运行中 mini-app 同一条路径，再由 DeviceShell 驱动页面栈；
  - 非路由方法（setNavigationBarTitle / getSystemInfoSync / tabBar API / …）：同样在 service-host `wx` 上调用并取其（同步）返回值（`app.ts`）。

延伸阅读：tab-bar 与 page-stack 这两块的下层细节见 [`./tab-bar.md`](./tab-bar.md) 与 [`./page-stack.md`](./page-stack.md)（相关源码 `simulator/device-shell/tab-bar-state.ts`、`simulator/device-shell/page-stack-controller.ts`）。

## 5. native-host 运行时

> 一句话：devtools 只有一套 simulator 运行时——Electron BrowserWindow 接管 service、顶层 `WebContentsView` 跑 React DeviceShell、每页子 `<webview>` 接管 render。

### 5.1 拓扑

```
service-host BrowserWindow（独立 top-level window，hidden）
  ← handleSpawn → createServiceHostWindow（service-host-window/create.ts）
  ← partition 是该项目的 persist:miniapp-<key>（miniappPartition(opts.appId)；
    预热池 / 无 appId 时回落 legacy persist:simulator）
  ← 通过 file:// 加载 dist/service-host/service.html
  ← logic.js 不走协议：从 resourceBaseUrl 用 HTTP fetch 下来，再
    injectLogicBundle → serviceWc.executeJavaScript 注入（bridge-router.ts）

simulator WebContentsView（主进程顶层，跑 React DeviceShell）
  ← view-manager.ts:attachNativeSimulator
  └── DeviceShell（device-shell.tsx）
       └── pages: <webview> ×N，preload=renderHostPreload；partition 由宿主 WCV 的
            will-attach-webview 钉成同一 per-project persist:miniapp-<key>
            ← device-shell.tsx
```

挂载点：`src/simulator/main.tsx` 解析 `location.search` 拿到 entry route 后，`new SimulatorMiniApp(...)` → `spawn()` → 渲染 `DeviceShell`（**lazy `import()` code-split**，让 simulator 入口 bundle 保持小）。DeviceShell 不直接 `import 'electron'`（主世界 nodeIntegration:false）—— 经 simulator preload 暴露的桥接收 `SIMULATOR_EVENTS`。

（`dmb-resource://` 是 render/simulator 侧的资源代理协议，service-host 不用它取 logic.js。）

**simulator 为什么是主进程的 `WebContentsView`**：Electron **不支持 webview 套 webview**（`webviewTag` 在 webview guest 里被强制 false），所以若 simulator 本身是个 `<webview>`，DeviceShell 的每页 render-host `<webview>` 挂在里面永远 attach 不上。因此 simulator 是主进程的顶层 `WebContentsView`（`view-manager.ts:attachNativeSimulator`，`webviewTag:true / contextIsolation:false / sandbox:false` + `cjsSiblingPreloadPath` 的 `.cjs` preload + per-project `persist:miniapp-<key>` partition）——顶层 WebContentsView 不是 guest，能托管子 `<webview>`。资源不由 main 起 `DiminaResourceServer`，而是 render/service 宿主从 dev server 同源取（spawn 传 `resourceBaseUrl`，本地 server 仅作 nullable fallback）。

### 5.2 各子系统落点

| 维度 | 落点 |
|---|---|
| service runtime | 隐藏的 Electron BrowserWindow（`constructServiceHostWindow`，`service-host-window/create.ts`）跑 `@dimina/service` bundle |
| page render | DeviceShell 渲染 `<webview>`（由 `will-attach-webview` 钉到该项目的 `persist:miniapp-<key>` partition），挂在 simulator 的顶层 `WebContentsView` 里（可托管子 webview；见 §5.1） |
| 生命周期信号源 | bridge-router 的 `dmb:page:lifecycle` |
| 路由 / tabBar | React `DeviceShell` + `page-stack-controller.ts` |
| `wx.*` 来源 | `simulator-mini-app.ts` 的 `SimulatorMiniApp` shim（service-host 窗里的权威 `wx`） |
| 调试器 | 右栏 Chrome DevTools 前端**附在逻辑层 service-host wc** 上（`pointNativeDevtoolsAtServiceWc` / `pointNativeDevtoolsAtActiveServiceHost`，`view-manager.ts`——顶层 wc 才能托管 DevTools 前端，`<webview>` guest 不行）；Console/Network/Sources 都在那跑，Elements 面板的 DOM 另经 elements-forward 路由到活跃 render-host guest（见 §1.3）。service-host 另开 detached DevTools（`navigateServiceHost`，`service-host-window/create.ts`，仅 `!app.isPackaged`） |
| 已知不足 | 设备外框布局保真（圆角 / zoom / 滚动对齐）尚不完整 |

> bridge 协议与拓扑细节见 [`./native-bridge-protocol.md`](./native-bridge-protocol.md)。

## 6. 安全与稳健性

> 一句话：sender 白名单 + 路径白名单 + 资源协议黑盒，三层把 simulator 内容隔在 trusted 之外。

### 6.1 SenderPolicy — `src/main/utils/sender-policy.ts`

`createWorkbenchSenderPolicy(ctx)`（`sender-policy.ts`）返回一个 `(sender) => boolean`，被每个 `IpcRegistry` 在 handler 入口先调一次：

允许：
- main window renderer（`isMainSender`）
- settings 独立窗 renderer（`isSettingsWindowSender`）
- settings overlay view / popover overlay view 的 webContents（按 id 查）
- host 通过 `instance.registerTrustedWindow(win)` 报备的 BrowserWindow（`app.ts`，引用计数）

拒绝：
- simulator 侧 frame（DeviceShell WebContentsView + 每页 render-host `<webview>`）—— 故意不进白名单。它们要 main 做事，走 native-host 的精确 sender-id 闸（如 custom-apis 桥：`ipcRenderer.send` → 绑定该 simWc 的 `ipcMain.on` 派发器，`attachNativeCustomApiBridge`），不靠这张表，见 `sender-policy.ts` 的注释。
- 任何 destroyed sender 或未知 iframe。

### 6.2 Navigation hardening — `src/main/windows/navigation-hardening.ts`

`applyNavigationHardening(wc, rendererDir)` 装两层：

1. `setWindowOpenHandler` → 全部 `{ action: 'deny' }`；http(s) 用 `shell.openExternal` 走系统浏览器（`navigation-hardening.ts`）。
2. `will-navigate` → 只允许 file:// URL 且必须在 `rendererDir` 前缀下；越界直接 preventDefault；http(s) 同样转给系统浏览器（`navigation-hardening.ts`）。

被这个 hardening 包住的 webContents：main window renderer（`main-window/create.ts`）、settings overlay（`view-manager.ts`）、popover overlay（`view-manager.ts`）、settings 独立窗（`settings-window/create.ts`）。

native-host simulator 走另一套，且不在 renderer 里——它是顶层 `WebContentsView`（DeviceShell）外加每页嵌套的 render-host `<webview>` guests，navigation hardening 直接装在主进程的 `attachNativeSimulator`（`will-attach-webview` 钉 guest 的 partition / contextIsolation、guest 与 WCV 自身各自的 `setWindowOpenHandler` / `will-navigate`，均在 `view-manager.ts`）—— 允许 about:blank + localhost + file://，其他外链 shell.openExternal、其余直接 preventDefault。这条路径不经过 `main-window/create.ts`，因为没有 renderer `<webview>` simulator 可挂。

### 6.3 资源协议 `dmb-resource://`

- 注册位置：`installResourceProtocolHandlers`（`bridge-router.ts`），注册到默认 protocol + shared fallback session，并经 partition configurator 注册到每个 per-project `persist:miniapp-<key>` session。
- 拒绝条件：URL hostname 对不上任何 AppSession 的 bridgeId → 404。
- 路径来源：所有 fetch 最后都 redirect 到 AppSession 的 `resourceBaseUrl`——正常是 dev server origin，无 dev server 时降级到本地 `DiminaResourceServer`；两种情况下 mini-program 都只能读 base 暴露的资源，读不到任意 fs。

### 6.4 数据目录隔离（e2e 场景）

只在 e2e 测试侧落地：`e2e/fixtures.ts` 把 `DIMINA_DEVTOOLS_DATA_DIR`（默认 `/Volumes/jdisk/electron-data/dimina-devtools-e2e`）拼出 per-worker 的 `userDataDir`，通过 `--user-data-dir=...` 传给 Electron。

> 生产 main 进程里**没有**对应的 `setupDataPaths()` — 重复启动测试时的 Chromium cache 是靠 playwright 的 `args` 注入而不是 app 自己 setPath 的。

### 6.5 privileged scheme

`difile://` 在 `bootstrap.ts` 通过 `protocol.registerSchemesAsPrivileged` 提前注册（标准 + 安全 + supportFetchAPI + stream + bypassCSP + corsEnabled），用于 `setupSimulatorTempFiles` 把临时文件以 URL 暴露给 simulator。注册必须在 `app.whenReady` 之前。

## 7. 启动与生命周期序列

### 7.1 冷启动

```mermaid
sequenceDiagram
  participant Entry as entry (electron-entry.js)
  participant App as workbench/launch
  participant Boot as bootstrap.ts
  participant Win as createMainWindow
  participant Ctx as workbench-context
  participant Ipc as ipc/* modules
  participant R as main renderer
  participant U as user

  Entry->>App: launch(config)
  App->>Boot: setupCdpPort() + registerDifileScheme()
  App->>App: app.whenReady()
  App->>App: applyTheme(loadWorkbenchSettings().theme)
  App->>Win: createMainWindow({ indexHtml, ... })
  Win->>Win: new BrowserWindow(preload=mainPreload)
  Win->>Win: applyNavigationHardening(mainWC)
  Win->>Win: mainWindow.loadFile(index.html)
  App->>Ctx: createWorkbenchContext({ mainWindow, ... })
  App->>Ipc: registerAppIpc + builtin modules
  App->>App: setupSimulatorSessionPolicy()（Referer/CORS：shared fallback + 每个 per-project partition，经 configurator）
  App->>App: setupSimulatorTempFiles(simSession)（difile://，同样 shared + per-partition）
  App->>App: setupSimulatorStorage(...)
  App->>App: setupAutomation(instance)（--auto 时）
  App->>App: setupMcp()（settings.mcp.enabled 时）
  R->>R: window.devtools.ipc 就绪
  R->>App: invoke project:status / projects:list
  U->>R: 选 project
  R->>App: invoke project:open(projectPath)
  App->>Ctx: workspace.openProject() → 读 manifest、起 provider
  R->>App: simulator:attach-native(simulatorUrl, simWidth)
  App->>App: views.attachNativeSimulator → 顶层 WebContentsView 跑 DeviceShell（partition: persist:miniapp-<key>，从 simulatorUrl 的 appId 派生）
  App->>App: attachNativeSimulatorDevtoolsHost → 主进程内把 DevTools 绑到 bridge 报告的可见 render-host <webview> guest（无 renderer IPC——没有可按 id attach 的 renderer <webview>）
```

### 7.2 关闭项目（保留 workbench）

```
user 点 close project
   ▼
renderer invoke project:close
   ▼
WorkspaceService.closeProject()
   ▼
detachSimulator() (view-manager.ts)
   ├─ hidePopover
   ├─ 销毁 settingsView
   └─ 销毁 simulatorView + 重置 simulatorWebContentsId
   ▼
BridgeRouter dispose 链路：ctx.registry.add(() => disposeAppSession(...))
   ├─ ap.serviceWindow.close()（关 service-host 窗）
   ├─ ap.resourceServer.close()
   └─ pending API_CALL timer 全部 clearTimeout
```

`App.exit`（automation 命令）：`automation/handlers/app.ts` 直接 await `ctx.workspace.closeProject()`，复用上面这条路径。

### 7.3 关闭窗口（带活跃 session）

`wireAppWindowEvents` 的 `onClose`（`app.ts`）：
- 有活跃 session 时 `e.preventDefault()`，先 await `config.onBeforeClose(instance)`、再 `closeProject()`、再 `notify.windowNavigateBack()` — 回到 project 列表页，**不** dispose `context.registry`，否则 renderer 还活着但所有 IPC handler 都没了。

## 8. 测试覆盖

- 单元测试随各模块 `*.test.ts`（如 `view-manager.test.ts` / `workspace-*.test.ts` / `close-with-active-session.test.ts`）。
- 端到端测试见 `e2e/`：`native-host-render.spec.ts`、`native-host-device.spec.ts`、`native-host-page-stack.spec.ts`、`native-host-wx-method.spec.ts`、`native-host-current-page.spec.ts`、`prewarm-pool.spec.ts` 等。

## 9. 延伸阅读

| 文档 | 关注点 |
|---|---|
| [`docs/native-bridge-protocol.md`](./native-bridge-protocol.md) | Native Bridge 协议契约 + native-host 拓扑 |
| [`docs/native-host-abstractions.md`](./native-host-abstractions.md) | native-host 四个关键抽象（per-page 握手 / custom-api 派发器 / 就绪等待 / keep 语义）|
| [`docs/workbench-model.md`](./workbench-model.md) | host 集成模型（electron-deck `DeckConfig` / Runtime / 不变量）|
| `docs/file-system.md` | 资源协议、temp-files、difile:// 细节 |
| `docs/miniapp-snapshot.md` | AppData / WXML 通用 snapshot 框架 |
| `docs/theme-background-sync.md` | 跨窗口主题色同步 |
| `docs/project-page-layers.html` | 项目页层级可视图 |
| [`docs/tab-bar.md`](./tab-bar.md) / [`docs/page-stack.md`](./page-stack.md) | simulator 路由 / TabBar 细节 |
| [`docs/prewarm-webview.md`](./prewarm-webview.md) | 服务宿主预热池（service 侧 opt-in 已实现；render 侧受 `<webview>` 限制未做） |
