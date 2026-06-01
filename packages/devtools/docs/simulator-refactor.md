# Native Bridge 协议契约与 native-host 运行时

> 本文是 native-host 运行时（`DIMINA_NATIVE_HOST=1`）的协议与契约参考：Electron 把自己当成 iOS/Android 的同类 native 宿主，复用 `@dimina/service` + `@dimina/render` 两个 bundle，让它们在 Electron 里走 dimina-fe 为真机预留的 Native 分支（`globalThis.DiminaServiceBridge.*` / `window.DiminaRenderBridge.*`）。
>
> 容器拓扑、Session/preload、安全模型见 [`./electron-container.md`](./electron-container.md)；页面栈与 TabBar 细节见 [`./page-stack.md`](./page-stack.md) 与 [`./tab-bar.md`](./tab-bar.md)；panel / toolbar 抽象见 [`./workbench-model.md`](./workbench-model.md)。

## 1. dimina 各端 Native 双线程模型

dimina 在每个平台上都把 service 跑在一个**与 render 物理隔离、不带 DOM 的 JS 上下文**里，render ↔ service 通过 native 注入的 bridge 中转。native-host 运行时复刻的就是这条同一份代码路径。

| 维度 | iOS | Android | HarmonyOS | Web/H5（默认架构） |
|---|---|---|---|---|
| Render 容器 | WKWebView | Android WebView | ArkWeb | iframe（`pageFrame.html`） |
| Service 引擎 | JavaScriptCore（`JSContext`） | QuickJS | ArkTS `ThreadWorker` | Web Worker |
| 通信通道 | `WKScriptMessageHandler` + `evaluateScript` | `evaluateJavaScript` + 回调 | `ThreadWorker.postMessage` | `Worker.postMessage` + iframe window 引用 |
| Bridge 注入 | Native 注入 `global.DiminaServiceBridge` | Native 注入 `global.DiminaServiceBridge` | Worker 内置 + main 注入 | JS polyfill |

关键 file:line（`dimina/` submodule，只读）：

- iOS Service 引擎：`dimina/iOS/dimina/DiminaKit/Service/DMPEngine.swift` `JSContext()`；Bridge 注入 `Service/DMPEngineInvoke.swift`（`DiminaServiceBridge.invoke`）、`Service/DMPEnginePublish.swift`（`publish`）
- Android Service：`engine_qjs/.../QuickJSEngine.kt` + `JsCore.kt` `setInvokeCallback`
- Web Worker：`dimina/fe/packages/container/src/core/jscore.js` `new Worker(...)`
- Service 端 `wx` 注册：`dimina/fe/packages/service/src/core/env.js:31-32` `globalThis[name] = globalApi`（`['dd','wx',...]`，globalApi 是 Proxy）
- 环境检测：`dimina/fe/packages/common/src/core/utils.js` `isWebWorker`

## 2. Native bridge 协议契约

native-host 运行时在 Electron 里实现的等价物必须满足这套契约，`@dimina/service` / `@dimina/render` bundle 才能跑通。来源：`dimina/fe/packages/{service,render}` + iOS/Android native 实现。

### 2.1 Service 端 `DiminaServiceBridge` 接口

```typescript
interface DiminaServiceBridge {
  // Service → Native：发起 invoke（target='container' 时调 native API；target='render' 时由 native 转发）
  invoke(msg: MessageEnvelope): unknown   // iOS/QuickJS 可同步返回

  // Service → Render：透过 native 中转，第一参 bridgeId 用于多 mini-app 实例路由
  publish(bridgeId: string, msg: MessageEnvelope): void

  // Native → Service：native 主动给 service 发消息时调用的回调（service 在初始化时赋值）
  set onMessage(handler: (msg: MessageEnvelope) => void): void
  get onMessage(): ((msg: MessageEnvelope) => void) | null
}

interface MessageEnvelope {
  type: string                              // 见 §2.3 type 一览
  target: 'service' | 'render' | 'container'
  body: Record<string, unknown>
}
```

关键调用点（`dimina/fe/packages/service/src/core/message.js`）：

- `:19` `DiminaServiceBridge.onMessage = this.handleMsg.bind(this)`（service 初始化时注册）
- `:48` `DiminaServiceBridge.publish(msg.body.bridgeId || '', msg)`（service → render）
- `:64` `DiminaServiceBridge.invoke(msg)`（service → container）

native-host 侧实现见 `src/service-host/preload.cjs`（`Object.defineProperty(globalThis, 'DiminaServiceBridge', …)`，`preload.cjs:84-103`）。

### 2.2 Render 端 `DiminaRenderBridge` 接口

```typescript
interface DiminaRenderBridge {
  // Render → Native：iOS/Android 必须传 JSON.stringify 后的字符串；Web 可以传 object
  invoke(msg: string | MessageEnvelope): void

  // Render → Service：透过 native 中转，msg 是 JSON 字符串
  publish(msg: string): void

  // Native → Render：native 给 render 发消息时的回调
  set onMessage(handler: (msg: MessageEnvelope) => void): void
}
```

关键调用点（`dimina/fe/packages/render/src/core/message.js`）：`:29` `window.DiminaRenderBridge.publish(JSON.stringify(msg))`、`:37` `window.DiminaRenderBridge.invoke(JSON.stringify(msg))`。native-host 侧实现见 `src/render-host/preload.cjs`。

### 2.3 消息 envelope 与 type 一览

`BridgeMessageType`（`src/shared/bridge-channels.ts:58-89`）以具名字面量列出主要 type，并以 `| string` 收尾——是开放联合，留给路由型扩展消息（`consoleLog` 即属此类：未具名于 `BridgeMessageType`，但由 `handleContainerMsg` 路由、由 preload 发出）。下表按发送方/接收方分类（含未具名的扩展消息）：

| Type | 方向 | 含义 | container 角色 |
|---|---|---|---|
| `loadResource` | Container → Service / Render | 通知加载小程序资源（service js / render css+js） | 发起 |
| `serviceResourceLoaded` | Service → Container | service 加载完上报 | 接收+聚合 |
| `renderResourceLoaded` | Render → Container | render 加载完上报 | 接收+聚合 |
| `resourceLoaded` | Container → Service | 两端都加载完，通知 service 创建实例 | 发起 |
| `firstRender` | Service → Render | 首屏数据 + 组件初始 props | 透明转发 |
| `appShow` / `appHide` | Container → Service | App 前后台生命周期 | 声明保留（`PageLifecycleEvent` / `BridgeMessageType` 含此二项，当前 main / DeviceShell 均未触发） |
| `stackShow` / `stackHide` | Container → Service | 页面栈进出生命周期 | 声明保留（同上，当前未触发） |
| `pageShow` / `pageHide` / `pageReady` / `pageUnload` / `pageScroll` / `pageResize` / `pageRouteDone` | Render → Service | 页面生命周期与交互 | 透明转发 |
| `mC` / `mR` / `mU` | Render → Service | Component create / ready / unmount | 透明转发 |
| `t` | Render → Service | 用户事件触发自定义 method | 透明转发 |
| `u` / `ub` | Service → Render | 单条 / 批量 setData 更新 | 透明转发 |
| `triggerCallback` | 双向 | 异步回调结果 | 透明转发 |
| `invokeAPI` | Service → Container | 能力调用（wx.* / navigation / route / tabBar / host API） | 处理（见 §6） |
| `h5SdkAction` | Render → Service | 内嵌 web-view 的 SDK 行为 | 透明转发 |
| `componentError` | Render → Service | 组件错误上报 | 透明转发 |
| `domReady` | Render → Container | DOM 初始化完成，container 可隐藏 loading | 接收 |
| `print` | Container → Render | 调试日志注入（dev only） | 发起 |
| `renderHostReady` | Render → Container | render-host webview preload 就绪，container 回发 `loadResource` | 接收 |
| `serviceHostError` | Service → Container | service-host boot 阶段错误上报 | 接收 |
| `consoleLog`（扩展消息，未具名于 `BridgeMessageType`） | Service / Render → Container | guest console 捕获转发（见 §3） | 接收 |

容器（bridge-router）只需要参与以下角色：

- **发起**：`loadResource`、`resourceLoaded`、`triggerCallback`、（可选）`print`；`pageShow/Hide/Unload` 由 DeviceShell reducer 经 `PAGE_LIFECYCLE` 转发（`appShow/Hide`、`stackShow/Hide` 当前未触发）
- **接收 + 聚合**：`serviceResourceLoaded` + `renderResourceLoaded` → `resourceLoaded`
- **接收**：`domReady`（隐藏 loading）、`renderHostReady`、`serviceHostError`、`consoleLog`
- **透明转发**：所有 `target: 'service' | 'render'` 的消息按 bridgeId 路由到对应 webContents

### 2.4 启动序列

```
T0  container 创建 AppSession（一个小程序一个 root bridgeId）
T1  container → service: loadResource (body: appId/pagePath/root/baseUrl/resourceBaseUrl/hostEnv)
T1  render-host webview preload 就绪 → container: renderHostReady → container 回 render: loadResource
T1a service 加载完 → container: serviceResourceLoaded
T1b render 加载完 → container: renderResourceLoaded
T2  container 聚合后（serviceLoaded && renderLoaded）→ service: resourceLoaded
T2  service 创建 App + Page 实例 → render: firstRender
T3  render 完成首屏 → container: domReady → container 隐藏 loading
T3  render → service: pageReady
T4  用户交互 → render → service：t / pageScroll / mC / mU / ...
    service → render：u / ub / triggerCallback
    service → container：invokeAPI（target=container 部分）
Tn  container → service: pageShow / pageHide / pageUnload（DeviceShell reducer 产出的唯一生命周期 effect）
```

`resourceLoaded` 的聚合实现见 `bridge-router.ts` `maybeSendResourceLoaded`（要求 `ap.serviceLoaded && page.renderLoaded`）。

### 2.5 同步 API

dimina-fe **没有 `invokeSync` 方法**——真机端同步 API 依赖宿主 JS 引擎本身的同步执行模型（iOS `JSContext.evaluateScript` / Android QuickJS handler 同步返回）。native-host 在 service window 里没有这种"原生同步"语义，所以所有 `*Sync` 在 service 窗口本地实现：

- `sync-api-patch.ts` 在 service.js 之后加载，把 `wx` / `dd` / `qd` 三个 namespace 上的 `getStorageSync` / `setStorageSync` / `removeStorageSync` / `clearStorageSync` / `getStorageInfoSync` / `getSystemInfoSync` / `getAccountInfoSync` / `getMenuButtonBoundingClientRect` patch 成本地实现（`sync-impls/`）。
- `sync-impls/storage.ts` 用 service 窗口的 `localStorage`（key 前缀 `${appId}_`）做同步存储。注意 storage 的**异步**侧（`wx.setStorage` 等）并不走这里：它们被 bridge-router 路由到主进程的 simulator-storage 服务（`STORAGE_API_NAMES`，见 §6），写入的是 service-host 窗口的 `file://` store。同步与异步两侧落到同一个 store。

> 仅 native-host 用这套"service 窗口本地实现"。默认 / legacy 的 Web Worker simulator 路径仍走 `SharedArrayBuffer` 同步 invoke：`simulator.html`（`:13-42` SAB infra + sync patch，`:105-119` 注入 Worker）拦截 Worker 创建，`_syncInvoke` 用 `Atomics.wait` 阻塞 Worker、等容器写回结果。native-host 不用 SAB，而是在 service-host 窗口内用 `sync-api-patch.ts`（`:20-40`）把 `*Sync` patch 成 `sync-impls/` 本地实现。

### 2.6 Native 注入对照表（iOS / Android → Electron）

| 操作 | iOS（Swift） | Android（Kotlin） | native-host（Electron） |
|---|---|---|---|
| `DiminaServiceBridge.invoke` 注入 | `JSContext.setObject(..., "invoke")` | `QuickJSEngine.setInvokeCallback` | `preload.cjs`: `invoke(msg) => ipcRenderer.send('dmb:service:invoke', { bridgeId, msg })` |
| `DiminaServiceBridge.publish` 注入 | `JSContext.setObject(..., "publish")` | `QuickJSEngine.setPublishCallback` | `preload.cjs`: `publish(targetBridgeId, msg) => ipcRenderer.send('dmb:service:publish', { bridgeId, targetBridgeId, msg })` |
| Native → Service onMessage | `evaluateScript("DiminaServiceBridge.onMessage(...)")` | `evaluateJavaScript("...")` | `preload.cjs`: `ipcRenderer.on('dmb:to-service', (_e, { msg }) => onMessageFn?.(msg))` |
| `DiminaRenderBridge.invoke` 注入 | `WKScriptMessageHandler` | `JavascriptInterface` | `render-host/preload.cjs`: `invoke(s) => ipcRenderer.send('dmb:render:invoke', …)` |
| `DiminaRenderBridge.publish` 注入 | — | — | `render-host/preload.cjs`: `publish(s) => ipcRenderer.send('dmb:render:publish', …)` |
| Service → Render publish | `DMPChannelProxy.serviceToRender` → `webview.evaluateJavaScript(...)` | `Bridge.messagePublish` | bridge-router 按 bridgeId 查到 renderWc，`webContents.send('dmb:to-render', { msg })`，render preload 调 `DiminaRenderBridge.onMessage(msg)` |

## 3. Guest console 捕获

service-host preload（`src/service-host/preload.cjs:155-214`）在真实 spawn（带 bridgeId）后 monkeypatch `console.{log,warn,error,info,debug}`、`error` / `unhandledrejection` 事件，把每条记录序列化（`safeSerializeArg`）后经 `DiminaServiceBridge.invoke` 发一条 `consoleLog` container 消息（`source: 'service'`）。

bridge-router 的 `handleContainerMsg` 在 `consoleLog` 分支调 `ctx.guestConsole?.emit(msg.body)`（`bridge-router.ts:822-829`）。`guestConsole` 仅在 native-host 模式下由 automation 服务设置（`automation/index.ts:88-98`），把它重广播为 `App.logAdded` 事件——与默认架构 `setupConsoleForwarding` 同形。render-host preload 走同一条 `consoleLog` 通道（`source: 'render'`）。

## 4. 进程拓扑

```
Workbench BrowserWindow (workbench renderer + main process)
  │
  ├── Simulator（native-host 下为主进程 WebContentsView，承载 DeviceShell）
  │     ├─ DeviceShell (React)：设备 chrome / NavigationBar / TabBar / 状态栏
  │     └─ Page Stack：每页一个 <webview>（partition=persist:simulator,
  │          preload=render-host/preload.cjs），加载 render-host/pageFrame.html
  │          → @dimina/render bundle；可独立 attach DevTools
  │
  └── ServiceHost BrowserWindow (hidden, show:false)
        加载 service.html → @dimina/service bundle
        preload 注入 globalThis.DiminaServiceBridge + sync-impls 本地实现
        开发期自动 openDevTools({ mode: 'detach' })
        ← Chrome DevTools console 可直调 wx.*，Sources 可 step into

Main Process
  └── BridgeRouter (src/main/ipc/bridge-router.ts)
        两级 AppSession / PageSession，按 bridgeId 路由 service ↔ render
        聚合 resourceLoaded、处理 invokeAPI、转发生命周期
```

> native-host 下 simulator 改成主进程 `WebContentsView`（顶层，可托管子 `<webview>`，解决 Electron 不支持 webview 套 webview 的限制）的细节，以及两级 session 模型的完整 channel 入口表，见 [`./electron-container.md`](./electron-container.md) §4.3 与 §5。

bridge-router 的 session 数据结构（`bridge-router.ts:68-123`，以下为字段全集）：

- `AppSession`（`bridge-router.ts:68-110`）：`appSessionId` / `appId` / `pkgRoot` / `root` / `scene` / `serviceWindow` / `serviceWc` / `simulatorWc` / `serviceLoaded` / `resourceBaseUrl` / `resourceServer`（nullable fallback）/ `hostEnv` / `appConfig` / `manifest` / `pages: Map<bridgeId, PageSession>` / `activeBridgeId` / `poolEntryId`（预热池来源 entry id，fresh/fallback 窗口为 null）/ `onServiceClosed` / `onServiceBoot`（保存的窗口监听器，dispose 前解绑，避免 stale listener 把已 dispose 的 session boot 进下一次 spawn）。
- `PageSession`（`bridge-router.ts:112-123`）：`bridgeId` / `appSessionId` / `pagePath` / `query` / `isRoot` / `isTab` / `renderWc` / `renderLoaded` / `resourceLoadedSent` / `windowConfig`。

> 两级 session 的完整语义（含预热池、活跃页镜像）见 [`./electron-container.md`](./electron-container.md) §4.3。

## 5. 资源加载与 logic.js 注入

所有资源（render bundle、service `logic.js`、`app-config.json`、页面样式）都 resolve against `resourceBaseUrl`：默认是 simulator 页面的 dev-server origin（`http://localhost:<port>/`，静态服务 `<appId>/<root>/…` 编译产物），与默认架构 `<webview>` 取的是同一份。当调用方未提供 `resourceBaseUrl`（legacy / 单测）时，bridge-router 起一个本地 `DiminaResourceServer`（rooted at `pkgRoot/root`）作为 nullable fallback，其 baseUrl 写入 `resourceBaseUrl`（`handleSpawn` 的 resource base resolution）。

`dmb-resource://` 协议（`installResourceProtocolHandlers`，双重注册到默认 protocol 与 `persist:simulator` session）把 `dmb-resource://<bridgeId>/<path>` 的请求按 hostname 解析出 AppSession，再 `fetch` 到该 session 的 `resourceBaseUrl`。

`logic.js` 在 native-host 下走两条互补路径：

- **service loader 自身的 importScripts**：`@dimina/service` 的 Worker-style 运行时检测到自己处于 worker 形态时，loader（`dimina/fe/packages/service/src/core/loader.js:20-26`）调 `globalThis.importScripts(\`${baseUrl}${appId}/${root}/logic.js\`)`。BrowserWindow 没有 `importScripts`，所以 `service-host/preload.cjs:135-149` 给 `globalThis.importScripts` 装了一个 shim：同步 XHR 取脚本 + 间接 `eval`（`(0, eval)(...)`）在 global scope 执行，使脚本里的 `modDefine(...)` 注册进 service loader `modRequire` 读取的同一份 AMD 注册表。
- **bridge-router 主进程预注入**：`bootServiceHost` → `injectLogicBundle`（`bridge-router.ts:707-722`）在 service window `did-finish-load` 后，HTTP fetch logic.js 并 `serviceWc.executeJavaScript(content, true)`，随后才发 `loadResource`。fetch URL 视模式而定（`bridge-router.ts:711-713`）：本地 fallback `DiminaResourceServer`（`ap.resourceServer` 非空）取 `new URL('logic.js', resourceBaseUrl)` = `<base>logic.js`（其 root 已是 `pkgRoot/root`）；dev-server 模式取 `new URL('<appId>/<root>/logic.js', resourceBaseUrl)` = `<base><appId>/<root>/logic.js`。

service.html 本体只有两条 script：`@dimina/service` bundle + `sync-api-patch.js`（`src/service-host/service.html`）。

## 6. invokeAPI 路由参考

service → container 的能力调用 envelope：

```ts
{ type: 'invokeAPI', target: 'container', body: { name, params: { ...userParams, success, fail, complete } } }
```

`bridge-router.ts` 的 `handleSimulatorApi` 按 `name` 分流到五类目标：

| 类别 | 名字示例 | 路由 |
|---|---|---|
| Navigation Bar API（`NAV_BAR_API_NAMES`，5 个） | setNavigationBarTitle / setNavigationBarColor / show\|hideNavigationBarLoading / hideHomeButton | `simulatorWc.send(E.NAV_BAR)` → fire-and-forget `:ok` 回调（UI 异步更新） |
| Route Action API（`NAV_ACTION_NAMES`，5 个） | navigateTo / navigateBack / redirectTo / reLaunch / switchTab | `simulatorWc.send(E.NAV_ACTION)` → DeviceShell 调 reducer + ack via `NAV_CALLBACK` |
| TabBar Action API（`TAB_ACTION_NAMES`，8 个） | setTabBarStyle / setTabBarItem / show\|hideTabBar / set\|removeTabBarBadge / show\|hideTabBarRedDot | `simulatorWc.send(E.TAB_ACTION)` → applyTabAction + ack via `NAV_CALLBACK` |
| Storage 异步 API（`STORAGE_API_NAMES`，5 个） | setStorage / getStorage / removeStorage / clearStorage / getStorageInfo | `ctx.storageApi.invoke(appId, name, params)` → service-host 窗口 `file://` store（与 `*Sync` 同一 store），ack success/complete |
| Host registry / Simulator window forward（其余） | getSystemInfo / chooseImage / login / fs.* / chooseMedia / … | 优先 `ctx.simulatorApis.invoke`；落空走 `forwardApiCallToSimulator`（`E.API_CALL` request/response，`API_CALL_TIMEOUT_MS` 超时） |

container → service 的 lifecycle 消息（`PAGE_LIFECYCLE` channel → `handlePageLifecycle` → `forwardToService`，service `onMessage` 收）。`handlePageLifecycle`（`bridge-router.ts:664-674`）只是把它收到的 `payload.event` 原样透传给 service，事件本身由 DeviceShell reducer 产出；reducer 的 `SideEffect` lifecycle 只覆盖 `pageShow | pageHide | pageUnload`（`page-stack-controller.ts:37-39`）：

| event | 触发点 |
|---|---|
| pageShow | navigateBack 完成 / switchTab cache 命中 |
| pageHide | navigateTo 完成 / switchTab 离开当前 tab |
| pageUnload | navigateBack 弹栈 / redirectTo / reLaunch / switchTab 丢弃非 tab 上层 |
| stackShow / stackHide | 声明保留（`PageLifecycleEvent` / `BridgeMessageType` 含此二项；当前 reducer 与 main 均未触发） |
| appShow / appHide | 声明保留（同上；main 与 DeviceShell 当前都不发；仅出现在类型声明与一处无关测试 fixture 中） |

main ↔ simulator 的 `SIMULATOR_EVENTS`（`src/shared/bridge-channels.ts:32-39`）：

```ts
SIMULATOR_EVENTS = {
  DOM_READY,        // main → sim : renderHost domReady 转发，用于 mount 顺序协调
  NAV_BAR,          // main → sim : 5 个 nav-bar 动态 API
  NAV_ACTION,       // main → sim : 5 个路由 API
  TAB_ACTION,       // main → sim : 8 个 tabBar 动态 API
  API_CALL,         // main → sim : 兜底的 simulator-window-resident API call（带 requestId / timeout）
}
```

`API_CALL` 的响应走 `BRIDGE_CHANNELS.API_RESPONSE`（`dmb:api:response`，sim → main，`handleApiResponse` 据 requestId 回原始 service 端 success/fail/complete）。

## 7. NavigationBar 微信对齐

simulator 的 NavigationBar 完全按微信 MiniProgram 规范实现（仅在 devtools 对齐，不参照各端 native）。

**视觉**（`src/simulator/device-shell/navigation-bar.tsx`、`menu-capsule.tsx`、`navigation-bar.css`、`menu-capsule.css`）：

- status bar 高度：iOS 44、Android 24。DeviceShell 的视觉布局直接取平台常量 `STATUS_BAR_HEIGHT_IOS = 44` / `STATUS_BAR_HEIGHT_ANDROID = 24`（`device-shell.tsx:52-53`，按 `platform` 选用，`:68`）；同一组值另由 `hostEnvSnapshot`（`simulator-mini-app.ts:182-205`，`statusBarHeight = ios?44:24`）在 spawn 时下发给 service-host 的 sync 实现（getSystemInfo / 胶囊 geometry）。nav bar 高度 44（`NavigationBarProps.navBarHeight`，`navigation-bar.tsx:33`）
- 标题对齐：iOS center / Android left（`navigation-bar.tsx:73` `titleAlign`）
- 返回箭头（`stackDepth > 1`）/ 返回首页按钮（`homeButtonVisible`）（`navigation-bar.tsx:70-72`）
- loading 转圈（show/hideNavigationBarLoading → `state.loading`）
- 颜色动画（`wx.setNavigationBarColor.animation` → CSS transition，`TIMING_FUNC_MAP` 4 种 timingFunc，`navigation-bar.tsx:38-43`）
- `navigationStyle: custom`：整条 bar 隐藏，胶囊保留（`navigation-bar.tsx:70` `isCustom`）

**胶囊** geometry（`src/simulator/device-shell/menu-button-geometry.ts` `getMenuCapsuleRect`）：

- iOS 87×32，top = statusBarHeight + 4，right = 7；Android 95×32，top = statusBarHeight + 6，right = 10（`menu-button-geometry.ts:22-26`）
- 纯函数 geometry，service-host sync impl 与 React 组件共享

**API 路由**（`NAV_BAR_API_NAMES`，见 §6）：

- 5 个 navigation-bar API 走 `E.NAV_BAR`，路径 `service.invokeAPI → handleSimulatorApi → simulatorWc.send → DeviceShell → setState`
- callback fire-and-forget 立即返回 `{ errMsg: '<name>:ok' }`（UI 更新异步，与微信行为对齐）
- `wx.getMenuButtonBoundingClientRect()` 走 sync 本地实现（`src/service-host/sync-impls/menu-button.ts`），从 spawn-time `hostEnvSnapshot` 派生

**约束**：

- `setNavigationBarColor.frontColor` 严格限 `#ffffff | #000000`：`applyColorMutation`（`page-stack-controller.ts:359-364`）把 `#ffffff`→`textStyle: 'white'`、`#000000`→`'black'`，其他值忽略（保留旧 `textStyle`）；`backgroundColor` 仍按字符串透传
- `navigationBarTextStyle: white|black` 同时影响标题颜色 + status bar 字体颜色（通过 NavigationBar `nav-bar--white|--black` modifier 类，`navigation-bar.tsx:85`）

## 8. PageStack 与 TabBar

native-host 的页面栈跑在 DeviceShell：`page-stack-controller.ts` 是纯 reducer（`ShellState.stack` 单条可见栈 + `tabStacks` 按 tab 缓存子栈 + `currentTabPath`），每个 `PageEntry` 对应一个 `<webview>`，按 bridgeId 复用 mount。`navigateTo` / `navigateBack` / `redirectTo` / `reLaunch` / `switchTab` 五个 reducer 产出 `{ next, effects }`，effect 含 lifecycle / closePage 两类，由 DeviceShell 翻译成 `PAGE_LIFECYCLE` / `PAGE_CLOSE` / 新 page 的 `PAGE_OPEN`。完整 reducer 契约（含两套架构对照、URL 同步、降级行为）见 [`./page-stack.md`](./page-stack.md)。

TabBar 同样由 DeviceShell 渲染（`tab-bar.tsx` + `tab-bar-state.ts`），配置来自 `app-config.json` 的 `app.tabBar`（`TabBarConfig`，`bridge-channels.ts:140-148`）。8 个动态 API 走 `applyTabAction` reducer（颜色经 `sanitizeColor` 过滤），图标路径在 `tab-bar.tsx` `resolveIcon`（`:80-101`）内解析：`http(s):` / `data:` / `blob:` / `//` 前缀原值返回；无 base 时返回 null；否则去掉 `/`、`./` 前缀，若剩余路径以 `${appId}/` 开头则先剥掉该前缀再 `joinUrl(resourceBaseUrl, …)`，普通本地路径直接 `joinUrl`。完整 TabBar API 与样式 gap 见 [`./tab-bar.md`](./tab-bar.md)。

## 9. 已知缺口

- `@dimina/service` dist 不带 sourcemap（`dimina/fe/packages/service/dist/service.js` 无 `sourceMappingURL`）。service window 自动打开 detached DevTools，console 里可直接调 `wx.*`、可在 bundle 上下断点 step into，但 Sources 面板看到的是已 bundle 的代码。
