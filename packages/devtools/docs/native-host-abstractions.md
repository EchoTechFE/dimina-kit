# Native-host 抽象层

native-host 是 devtools 唯一的 simulator 运行时：顶层 `WebContentsView`（DeviceShell，加载 `simulator.html`）+ 每页一个嵌套 render-host `<webview>` guest + 隐藏 service-host `BrowserWindow`，主进程 `bridge-router` 路由三者。容器拓扑见 [`electron-container.md`](./electron-container.md)，bridge 协议见 [`native-bridge-protocol.md`](./native-bridge-protocol.md)。

本文描述跨这套拓扑的四个关键抽象、各自职责与不变量。service runtime 协议（`dimina/fe/packages/service`）是只读 submodule，下面所有机制都落在 `packages/devtools` 一侧、靠 bridge-router 补齐。

## ① 对称的 per-page resource 握手

每个页面在 service 与 render 两侧都按对称的两步握手 mount，bridge-router 是收口处。

service runtime 协议每页需两步：

1. `loadResource(pagePath)` — `modRequire(pagePath)` 执行该页模块工厂，注册进 `staticModules[pagePath]`，回 `serviceResourceLoaded{bridgeId}`。
2. `resourceLoaded(pagePath)` — `getModuleByPath(pagePath)` 命中后 `createInstance` + `firstRender`；找不到模块则打印 "module not found" 并 return（页不 mount）。

`bridge-router` 对 **render 侧**每页 `renderHostReady` 时发 `loadResource(render, page)`；对 **service 侧**在 `maybeSendResourceLoaded`（每页将发 `resourceLoaded` 的唯一收口）里**对所有非 root 页先补发 `loadResource(service, page)`、再发 `resourceLoaded`**。root 页的模块已在 `bootServiceHost` 注册，由 `page.isRoot` 守门跳过补发。

两条消息经 `serviceWc.send` 同信道 FIFO 入队，service 同步处理：`loadResource` 的 `modRequire` 是同步注册（logic.js 已由 `injectLogicBundle` 整包注入，不走 fetch），故紧随的 `resourceLoaded` 的 `getModuleByPath` 必命中。

**不变量**：

- **顺序**：同信道 FIFO + `modRequire` 同步 ⇒ `loadResource` 先于 `resourceLoaded` 生效。
- **幂等**：`modRequire('app')` 只在 UNLOAD 态跑 factory，`createApp` 自带单例 guard ⇒ App 不重复创建；`resourceLoadedSent` 先置位再发 ⇒ `serviceResourceLoaded` 回声被 guard 挡住，无循环、无重复 mount。
- **多实例不串扰**：栈/实例按 `bridgeId`，模块缓存按 path 仅存定义。

覆盖面：`navigateTo` / `redirectTo` / `reLaunch` / `switchTab`（非缓存）的所有非 root 页都汇聚到 `maybeSendResourceLoaded`，统一受益；cached `switchTab`（切回栈内 tab）不走 `openPage`，不涉及握手。

这条握手保证非 root 页的 AppData / WXML 面板 + automation `Page.getData` 都有数据——它们读 `ctx.appData.getPageData(activeBridgeId)`，唯一数据源是 service 为该 bridge publish 的 `page_*`。

## ② simulator-WCV host-IPC 派发器（custom API）

host 经 `onSetup` / `registerSimulatorApi` 注册的 `wx.<customApi>` 在 native 下经一条精确网关的 IPC 派发器接通。

simulator 文档内 `window.__diminaCustomApis`（`installCustomApisBridge`，`src/preload/runtime/custom-apis.ts`）的 `list()` / `invoke()` 用 `ipcRenderer.send(SimulatorCustomApiBridgeChannel.Request)`，Response 落在 `ipcRenderer.on(Response)` 按 id 关联。

main 侧 `attachNativeCustomApiBridge`（`view-manager.ts`，由 `attachNativeSimulator` 在拿到 `simWc` 后调用）装一个 `ipcMain.on(Request)` 派发器：按 `event.sender.id === simWcId` 精确网关，调 `ctx.simulatorApis` 注册表，再 `simWc.send(Response, …)` 回桥。它与 simulator 同生命周期，`detachSimulator` / 重 attach 时由 `detachNativeCustomApiBridge` 摘除。

**关键约束**：simulator 是主进程顶层 `WebContentsView`、**无 embedder renderer**，preload 的 `sendToHost` 不会在它自己身上回弹成 `ipc-message-host`。因此 custom-api 不能走 `ipc-message-host`，必须走 `ipcRenderer.send` + `ipcMain.on` 这条精确 sender-id 网关。simulator 也不进 `sender-policy` 白名单（它被明确排除），靠 `attachNativeSimulator` 拿到的精确 `simWc` 引用校验发送方。

**console 是独立路径**：render / service-host preload 把 `console.*` 打成 `consoleLog` container 消息（`DiminaRenderBridge.invoke({ type: 'consoleLog', target: 'container' })`）直达 main → bridge-router → `ctx.guestConsole`，由 `services/console-forward` 的 ConsoleForwarder 独占该 sink 并扇出（render→service 转发 + automation 订阅）。console 与 custom-api 是两条独立路径，避免双路广播。

## ③ 跨进程就绪等待原语 `waitForActivePage`

automation 导航后等待新页就绪用信号驱动的 `waitForActivePage`，而非定时猜测。

`waitForActivePage(bridge, { since, timeoutMs, match?, onTimeout? })`（`src/main/services/automation/wait-active-page.ts`）：订阅 `bridge.onRenderEvent`，首个匹配的 `activePage`（`match(bridgeId, pagePath)`，否则 `bridgeId !== since`）resolve。

**不变量**：

- **绝不挂死**：超时兜底也 resolve（不 reject）；`onTimeout?` 回调让调用方区分"真就绪 vs 超时兜底"、可 warn，但 resolve 契约不破。
- **竞态闭合**：订阅后立即查一次 `getActiveBridgeId`，已满足则即刻 resolve。
- **幂等**：只 resolve 一次。

automation 导航 handler（`automation/handlers/app.ts`）用它替代盲等。**cached `switchTab`**（切回缓存 tab，top bridgeId 不变）应短路或用短超时——默认 `bridgeId !== since` 不满足会白等到超时。

## ④ 订阅类 API 的 keep 语义（subscription-by-name）

`keep: true` 的订阅类 API（如 `audioListen` 的 9 个 audio DOM 事件）的持久订阅语义由**容器/router 侧按 API 名内在识别**，不依赖 params 里的 `keep`。

service runtime 故意把 `keep` / `evtId` 留在 service-local（`callback.store`，keep 重入全程 service 内），剥离后不出 service；bridge-router 再剥一次 `success/fail/complete`。到 simulator 的订阅类 API 因此会丢失 keep 语义、被当 one-shot 立即 settle，真事件（如 canplay）到达时已无 pending 可派发。

修法落在 `packages/devtools`、不动 submodule：

- `src/shared/simulator-api-metadata.ts` — `PERSISTENT_SIMULATOR_APIS`（当前仅 `audioListen`）+ `isPersistentSimulatorApi(name)`。单一事实源，新增订阅 API 加一行。
- `bridge-router`：`keep = params.keep === true || isPersistentSimulatorApi(name)`；订阅类不装 5s one-shot timer，并在 forwardedParams 注入 `keep = true` 让容器侧也认得。
- `src/simulator/run-api-async.ts`：`keep = params.keep || isPersistentSimulatorApi(name)`；订阅类跳过同步空 settle（否则会先发一次空 keep success），每次事件按 keep 重发。

**不变量**：keep-alive 分支 only-fire-success、不 delete pending、不 fire complete ⇒ 无 double-complete。这是"补触达"而非改语义。

> 已知有界泄漏：页面卸载但 app 未销毁期间，`audioListen` 的 pending 残留到 app dispose（每 app session 有界，app dispose 时全清）。收敛需新增 `audioDestroy → drain` 消息路径。
