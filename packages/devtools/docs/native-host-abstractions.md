# Native-host 修复的抽象层设计

> 状态：**设计稿（待 codex 充分讨论 + 落地）**。本文为 native-host 成为唯一 runtime 后一次审计中确诊的 3 个真 bug + 1 个时序债的**架构级修复设计**。原则：从整体架构与抽象复用出发，不打散点补丁。所有 file:line 均已实读核验（commit 基线 `40077f88`）。

## 背景

native-host 三进程拓扑：顶层 `WebContentsView`（DeviceShell，加载 `simulator.html`）+ 每页一个嵌套 render-host `<webview>` guest（`pageFrame.html`）+ 隐藏 service-host `BrowserWindow`（`service.html`），主进程 `bridge-router` 路由三者。原默认 dimina-fe runtime（container 同步桥 + iframe）已删除。

审计发现的问题大多是**同一类架构缺陷的不同表现**，归并为 3 个共享抽象：

| 抽象 | 修复的问题 | 严重度 |
|---|---|---|
| ① 对称的 per-page resource 握手 | Bug-3：navigateTo 的非 root 页 service 实例从不 mount | **高** |
| ② simulator-WCV host-IPC 派发器 | B-2：custom API 在 native 下整链断 | 高 |
| ③ 跨进程就绪等待原语 | D：automation 盲超时 / 轮询 | 中 |

---

## 抽象 ① — 对称的 per-page resource 握手（修 Bug-3）

### 问题

native 下用 `App.callWxMethod` navigateTo 打开**非 root（非 tab）页**后，该页 service 实例从不 mount：`Page.getData` 返回 `{}`、AppData 面板 / WXML 面板对该页全空。**root/tab 入口页正常。**回归测试：`e2e/native-host-navigate-data.spec.ts`（RED：detail 页 `Page.getData={}`，首页对照正常，路由正常）。

### 根因：render 与 service 的 per-page 握手不对称

dimina service runtime 协议（`dimina/fe/packages/service/src/`，submodule，**只读不可改**）——每页需**两步**：

1. `loadResource(pagePath)`（`index.js:23-29` → `loader.loadResource` `loader.js:17-40`）：`modRequire(pagePath)` 执行该页模块工厂 → 注册进 `staticModules[pagePath]`；并回 `serviceResourceLoaded{bridgeId}`。
2. `resourceLoaded(pagePath)`（`index.js:64-90`）：`getModuleByPath(pagePath)`（`loader.js:108`）→ 找到则 `runtime.createInstance` + `firstRender`；**找不到则 `index.js:70` 打印 "module not found" 并 return**（页不 mount）。

bridge-router 现状（`src/main/ipc/bridge-router.ts`）：

- **render 侧**：每页 `renderHostReady` 时发 `loadResource(render, page)`（`routeFromRender:805-808`）→ 每页对称。
- **service 侧**：**只在 boot 给 root 发一次** `loadResource(service, root)`（`bootServiceHost:739`，硬取 `ap.pages.get(ap.appSessionId)`）。非 root 页只收到 `maybeSendResourceLoaded` 发出的**精简 `resourceLoaded`**（`:759-773`，body 仅 `{bridgeId,scene,pagePath,query,stackId}`，**不含模块注册**）。

→ 非 root 页：service 从未 `modRequire(pagePath)` → `getModuleByPath` 落空 → "module not found" → 不 createInstance → 无 onLoad / 无 `page_*` init → `ctx.appData` 永远不含该 bridge。

`Page.getData` native 分支（`automation/handlers/page.ts:66-69` 读 `ctx.appData.getPageData(getActiveBridgeId())`）与累加器 tap（`bridge-router.ts:427-434` SERVICE_PUBLISH 无条件喂入）本身没问题——空值的**唯一**成因是 service 从未为该 bridge publish `page_*`。

### 设计：让 service 侧 per-page 也发 loadResource，与 render 对称

核心 = 在 `maybeSendResourceLoaded`（每页将要发 `resourceLoaded` 的唯一收口处）里，**对非 root 页先补发 `loadResource(service, page)`，再发 `resourceLoaded`**。两条消息 FIFO 入队，service 同步处理：先 `modRequire(pagePath)` 注册模块，再 `getModuleByPath` 命中 → createInstance。

```
function maybeSendResourceLoaded(ap, page):
  if page.resourceLoadedSent || !ap.serviceLoaded || !page.renderLoaded: return
  page.resourceLoadedSent = true
  if page 不是 root:                       // root 的模块已在 bootServiceHost 注册
    forwardToService(ap, makeLoadResource(ap, page, 'service'))   // 注册该页模块
  forwardToService(ap, { type:'resourceLoaded', target:'service', body:{...} })  // createInstance
```

关键不变式 / 安全性论证（**待 codex 复核**）：

1. **顺序正确**：`forwardToService` 同信道 FIFO；service `loadResource` 的 `modRequire` 是同步注册（非 fetch——`isWebWorker` 为 false，logic.js 已由 `injectLogicBundle` `bridge-router.ts:735` 整包注入，`importScripts` 分支 `loader.js:20-27` 跳过）。故紧随的 `resourceLoaded` 的 `getModuleByPath` 必命中。
2. **`modRequire('app')` 幂等**：非 root 的 `loadResource` 也会 `modRequire('app')`（`loader.js:30`），但 modRequire 缓存已加载模块 → 不重复执行 app 工厂；`createApp` 在 `resourceLoaded` 分支（`index.js:66`）而非 `loadResource`，不受影响。
3. **`serviceResourceLoaded` 回声无害**：非 root 的 `loadResource` 会回一个 `serviceResourceLoaded{bridgeId}` → `handleContainerMsg:834` 置 `ap.serviceLoaded=true`（已 true）+ 对所有页 `maybeSendResourceLoaded`；但当前页 `resourceLoadedSent` 已 true → 被 `:760` guard 挡住，其它未就绪页 `renderLoaded=false` → no-op。无循环、无重复 mount。
4. **root 判定**：root page 在 `ap.pages` 里以 `ap.appSessionId` 为 key（`bootServiceHost:739`）。判据 `page === ap.pages.get(ap.appSessionId)`（按引用）或等价 bridgeId 比对。**待定**：是否干脆对所有页（含 root）统一补发、靠 `modRequire`/`createApp` 幂等吃掉重复，以彻底消除 root 特例（更对称，但需确认 root 二次 `loadResource` 不会二次 `firstRender`）。

### 影响面 / 风险

- 修复后：所有 navigateTo/redirectTo/reLaunch 的非 root 页，AppData / WXML 面板 + `Page.getData` 正常。
- **高 blast radius**：动核心 render/service 握手，绝不能回归已正常的入口页渲染。
- 验证：`native-host-navigate-data.spec.ts`（Bug-3 专项）+ `native-host-audio.spec.ts`（同源，canplay 端到端）+ 全量 e2e（入口页 / page-stack / tabbar / 三面板零回归）+ `vitest`。

---

## 抽象 ② — simulator-WCV host-IPC 派发器（修 B-2）

### 问题

custom simulator API（host 经 `createWorkbenchApp` 的 `onSetup`/`registerSimulatorApi` 注册的 `wx.<customApi>`）在 native 下整链断。回归测试：`e2e/native-host-custom-api.spec.ts`（RED：`__diminaCustomApis.list()` reject `"got no response from the host renderer"`）。

### 根因

simulator 文档内 `window.__diminaCustomApis`（`installCustomApisBridge` `src/preload/runtime/custom-apis.ts:133-135`）的 `list()/invoke()` 全走 `ipcRenderer.sendToHost(SimulatorCustomApiBridgeChannel.Request)`（`:68,114`），**依赖一个 host renderer 的 `useCustomApiProxy` 代理回 Response**（注释 `custom-apis.ts:26-32` 自陈）。该 proxy 监听**renderer `<webview>` 标签**的 `ipc-message`。但 native 下 simulator 是**顶层主进程 WebContentsView、无 embedder renderer**，主进程也**没有**任何 `SimulatorCustomApiBridgeChannel.Request` 的 listener（grep `src/main` 仅 console 在 `automation/index.ts:169` 裸挂 `ipc-message-host`）→ `list()` 撞 ceiling（`custom-apis.ts:121`）reject → `custom-api-boot.ts` 降级"无 custom API"。`resolveCustomApisBridge`（`src/simulator/resolve-custom-apis-bridge.ts:38`）无 native 分支。

### 设计：统一的 WCV host-message 派发器，custom-api 作为一条 route

观察：simulator WCV 的 `ipc-message-host` 信道上有**多条** host→main 流（console 抓取、custom-api Request、未来更多），现状是各自裸挂。架构修法 = 一个**单一 owner** 持有该 WCV 的 `ipc-message-host`，按 channel 分发：

- `console` → 转发给 automation（沿用现 `automation/index.ts` 行为）。
- `SimulatorCustomApiBridgeChannel.Request` → 调同一注册表（`SimulatorCustomApiChannel.List/Invoke` 背后的 `ctx.simulatorApis`，`src/main/ipc/simulator.ts:77-81`）→ `simWc.send(SimulatorCustomApiBridgeChannel.Response, …)` 回桥。

落点：`view-manager.attachNativeSimulator`（`view-manager.ts:526+` 拿到 `simWc` 处）注册该派发器——它是 native simulator mount 时**必然**装上的、与 simulator 同生命周期，优于"automation WS 连上才装"。然后**删除孤儿** renderer proxy：`use-custom-api-proxy.ts`（native 下 `simulatorRef` 永不绑定、必空转 50 次）+ `use-project-runtime-controller.ts` 的接线 + 更新 `sender-policy` 注释。

**顺序铁律**：先加 main-side 派发器（custom API 接通）→ 再删 renderer proxy。反序会让中间态 custom API 彻底断。

### 风险 / 验证

中。`native-host-custom-api.spec.ts`（`__diminaCustomApis.invoke` 真往返）+ `extension-host.spec.ts`（main handler 仍工作）+ 全量 e2e。

---

## 抽象 ③ — 跨进程就绪等待原语（修 D）

### 问题

automation 导航后**盲等** `setTimeout(navigateBack?1500:2000)`（`automation/handlers/app.ts:109/185/193`）；automation 发现 simulator 用 `1s 轮询 + 30s 超时`（`automation/index.ts:139-181`）。纯时间猜测——慢机竞态、快机白等。框架其实已有 `bridge.onRenderEvent` 的 `activePage` 信号。

### 设计（已落地基座）

`waitForActivePage(bridge, {since, timeoutMs, match?})`（`src/main/services/automation/wait-active-page.ts`，**已实现 + 8/8 单测绿** `wait-active-page.test.ts`）：订阅 `onRenderEvent`，首个匹配的 `activePage`（`match(bridgeId,pagePath)`，否则 `bridgeId!==since`）→ resolve；**超时兜底 resolve（绝不 reject/挂死）**；竞态闭合（订阅后查一次 `getActiveBridgeId`，无 match 且已 `!==since` 立即 resolve）；幂等只 resolve 一次。

复用点：
- `handlers/app.ts` 导航 handler：把盲等换成 `await waitForActivePage(ctx.bridge, { since, timeoutMs })`（兜底上限 = 原盲等时长，保留默认 arch 旧行为分支若需要）。
- automation simulator 发现：同类"等就绪 + 超时"可复用同一原语思路（视实现再决定是否抽更泛的 `awaitBridgeSignal`）。

### 风险 / 验证

低。`wait-active-page.test.ts`（8 case）+ 现成 `native-host-current-page.spec.ts` / `native-host-page-stack.spec.ts`（导航后即时反映新页，证明等的是真信号而非定时）。

---

## 落地顺序

1. ③ `waitForActivePage` 基座（**已完成**）。
2. ① Bug-3 service 握手（最大、最高风险）→ 跑 `native-host-navigate-data` + 全量 e2e。
3. ② B-2 host-IPC 派发器 + 删 proxy（先 main 后 renderer）→ 跑 `native-host-custom-api`。
4. ③ 接线进 automation；audio 测试转回归守卫。
5. 对抗评审（codex）+ 全量验证（typecheck / vitest / lint / build / 真启 electron e2e）。

> 子模块约束：修复全部落在 `packages/devtools/`，**不动 `dimina/`**——service runtime 协议只读，靠 bridge-router 侧补齐对称握手。

---

## Codex 评审结论（已并入设计）

codex 独立实读 submodule 协议 + bridge-router 后的把关结果（2026-06-02）：

### 抽象①（Bug-3）— 4 条不变式全部【可落地】
- **不变式 1**（FIFO + modRequire 同步）✓：`serviceWc.send` 同通道单线（`bridge-router.ts:1155-1158`）；service 收 `loadResource` 同步 `modRequire`（`loader.js:28-39`）→ `resourceLoaded` 查模块 mount（`index.js:64-90`）。
- **不变式 2**（`modRequire('app')` 幂等）✓：`modRequire` 仅在 `UNLOAD` 态跑 factory（`dimina/fe/packages/common/src/core/amd.js:27-35`）；`createApp` 自带单例 guard（`runtime.js:49-54`）→ App 不重复创建。
- **不变式 3**（回声被 guard 挡）✓：`resourceLoadedSent` 先置位再发（`:759-772`）；回声仅置 app 级 `serviceLoaded` flag + 遍历（`:834-837`），无循环、无重复 mount。
- **不变式 4**（root 判定）✓ + **改用 `page.isRoot`（`:570-585`）守门**：对**所有非 root 页**统一补发 `loadResource`（只注册模块定义、不触发 firstRender，回声代价可接受）。
- **同路径多实例**✓ 无冲突：栈/实例按 `bridgeId`（`:676-677`/`runtime.js:105-135`），模块缓存按 path 仅存定义（`loader.js:58-72`）→ 互不串扰。
- **⚠️ 范围扩大【需改】**：`redirectTo`/`reLaunch`/`switchTab`（非缓存）新页都走 `openPage` 落非 root（`device-shell.tsx:370,398,435`；`bridge-router.ts:664-674`），**同受 Bug-3 影响、一并覆盖**。但因修复点在 `maybeSendResourceLoaded`（所有非 root 页的唯一收口），天然覆盖它们，无需逐 API 特判。cached `switchTab`（切回栈内 tab，`page-stack-controller.ts:231-261`）不走 `openPage`，不受影响也不受益。

### 抽象②（B-2）— 【需改】dispatcher 唯一 owner
- **dispatcher 必须是 `ipc-message-host` 的唯一 owner**：automation 现自挂 console 监听（`automation/index.ts:147-154,169`），新 dispatcher 若也处理 console 会**双路广播**。落地 = dispatcher 持有该信道，automation 的 console 改为从 dispatcher 的转发 sink 接收（先盘清 console 所有消费方）。
- **不动 sender-policy 白名单**：simulator 当前被明确排除（`sender-policy.ts:15-21,52-54`）；dispatcher 绑定 `attachNativeSimulator` 拿到的精确 `simWc` 引用（`view-manager.ts:526-567`），List/Invoke 仍走 `ctx.simulatorApis`（`simulator.ts:77-82`），靠精确引用校验发送方即可。
- **顺序**：先加 main response path 验往返、再删 renderer proxy（`use-custom-api-proxy.ts` + 接线 `use-project-runtime-controller.ts:167-172`）；过渡期两路都能回 Response 不丢包，仅幂等 API 注意双回。

### 抽象③（D）— 【需改】
- **超时可见性**：`Promise<void>` 无法区分"真就绪 vs 超时兜底"→ 加 `onTimeout` 回调（或返回 `{timedOut}`）让调用方可 warn，避免掩盖信号丢失。**实现取 `onTimeout?` 可选回调**（保持现有 8 单测 `resolves.toBeUndefined()` 契约不破）。
- **switchTab 切回缓存 tab 坑**：top bridgeId 不变 → 默认 `bridgeId!==since` 不满足 → 白等超时（不误判但有延迟）。调用方对 cached switchTab 应短路/短超时。
- **泛原语**（automation 1s/30s 轮询抽 `waitUntil(probe,timeout)`）：可落地但**优先级低、不混入本批 PR**。

### 落地顺序（codex 推荐）
1. Bug-3 service 握手 → `native-host-navigate-data` + page-stack/tabbar e2e + typecheck0 + lint0 ✅**已落地+验证**
2. B-2 main dispatcher（`attachNativeSimulator`）+ 删 proxy → custom-api 往返 e2e + console 不双广播 + sender-policy 单测 + main vitest `vi.mock('electron')` ✅**已落地+验证**（一处纠正见下）
3. D 接线 `waitForActivePage`→`App.callWxMethod` → fake-timer 单测 + current-page/page-stack e2e + 超时 warn 可见 ✅**已落地+验证**
4. 全门禁：typecheck + vitest + `eslint . --max-warnings 0` + 真启 Electron e2e（**抽象④后做**）

> **B-2 落地纠正**：codex 原方案"给 simWc 装 `ipc-message-host` 监听"**不成立**——顶层 WebContentsView 无 embedder，preload 的 `sendToHost` 不会触发它（console 也因此另走 `guestConsole`）。正解：native 下 preload 改用 `ipcRenderer.send`，main 用 `ipcMain.on(Request)` 按 `event.sender.id === simWcId` 精确网关 → `simWc.send(Response)`（与 `installNativeHostBridge` 发 SPAWN 同信任模型，不动 sender-policy 白名单）。

---

## 抽象 ④ — 订阅类 API 的 keep 语义（修 audio keep:true，待 codex 讨论）

### 问题

修好 Bug-3 后，`native-host-audio.spec.ts` 失败点收窄到 `canplayFired===false`：`createInnerAudioContext` 的 DOM 事件（canplay/play/timeUpdate/ended）在 native 下到不了页面回调。**影响所有 `keep:true` 订阅类 API**（音频事件、各种 `onXxxChange` 监听），非仅 audio。

### 根因（已 live e2e 诊断坐实）

audio 元素本身健康（诊断到 `fire -> canplay rs=4`）。断点在 **keep 语义在到达容器前就被 service 侧吃掉**：

1. submodule `dimina/fe/packages/service/src/api/common/index.js:151` 的 `invokeAPI` 解构剥离 `{success, fail, complete, keep, evtId, ...rest}`，只转发 `rest` + 把 `success` 存进 service-local 的 `callback.store(success, keep, evtId)`——**keep/evtId 不出 service**。
2. bridge-router 再剥一次 success/fail/complete（`bridge-router.ts:1058-1062`）。→ `audioListen` 到 simulator 只剩 `{audioId}`、**keep=false、无 success**。
3. `src/simulator/run-api-async.ts`：无 success → `hadSuccess=false` → 走同步返回路径（`:153`）**立即 settle 一个空响应**。
4. router 收到这个首个空响应 → 走 one-shot 路径删 pending、发 complete（`bridge-router.ts:1114+`）。200ms 后真 canplay 触发时，run-api-async 见 `settled=true,keep=false` → **丢弃**（`:92`）；即便发出，pending 已删。→ `_dispatch` 永不跑，`onCanplay` 永不触发。

native-host 的 keep 机器（`run-api-async` keep 重发、`handleApiResponse` 的 `payload.keep` re-fire `bridge-router.ts:1107`）**形同虚设**——因为没有任何东西在这条路径上把 keep 置回 true。

### 设计（待 codex 讨论 + 定稿）

submodule 故意把 keep 留在 service-local（`callback.store`），容器无法从 params 恢复。修法 = **容器/router 侧按 API 名内在地知道哪些是持久订阅**（subscription-by-name），落在 `packages/devtools`、不动 submodule：

- 在 `src/simulator/run-api-async.ts` 维护一组订阅类 API 名（`audioListen`，及其它 `on*` 监听类），对它们：**不走同步一次性 settle**（不发首个空响应）、每次 `fire` 都带 `{keep:true}`、由 `handleApiResponse` 保持 pending 存活、不发 complete。router 既有 keep-alive 逻辑（`bridge-router.ts:1107-1126`）已具备，只是这条路径没触达。
- 待 codex 复核的点：(1) 订阅类 API 名清单怎么维护最不易漏（硬编码 set vs 注册表标注）；(2) 与现有 keep 机器（之前修过一次的 keep 重发）会不会重复 fire / complete；(3) `dispose`/取消订阅（`offCanplay`/页面卸载）路径怎么收尾、pending 何时删；(4) 是否影响非 native 默认路径（已下线，但 preload 仍导出）。

### 验证

`native-host-audio.spec.ts`（canplay/duration/无 error）转 GREEN；+ 不回归其它 async API（`run-api-async` 单测 + 全量 e2e）。

