# 服务宿主预热池（Service Host Pre-warm Pool）

> 服务宿主预热池是复用 service-host `BrowserWindow` 的 opt-in warm pool。
> 配套：[`simulator-refactor.md`](./simulator-refactor.md)、[`workbench-model.md`](./workbench-model.md)、[`miniapp-snapshot.md`](./miniapp-snapshot.md)。

## 摘要（TL;DR）

打开一个 dimina mini-program 项目时，"点击 → 首屏可见" 这段延迟里有一大块是**进程 fork + preload 注入 + page-frame 解析**的固定开销 — 跟你的小程序本身的代码量几乎无关。三家 Native 端（iOS / Android / Harmony）都把这块固定开销砍掉了，做法是**预先 new 出 webview 实例放进池子里**。

dimina-kit Electron 容器里对等的实现是 `ServiceHostPool`（`src/main/services/service-host-pool/pool.ts`）：pool 在 Electron `ready` 之后空闲时预热出 service-host `BrowserWindow`，在用户点"打开项目"时 `acquire()` 出已 warm 的 `WebContents`，省掉同步 `new BrowserWindow`。pool **默认 OFF，opt-in**（`DIMINA_PREWARM_POOL_SIZE`，见 §6）。

适用范围与边界：

1. pool 服务的是 **service 侧**的 service-host `BrowserWindow`（`createServiceHostWindow`）——它替代 `bridge-router.handleSpawn` 里同步 `new BrowserWindow`，收益直接、可度量。
2. **render 侧不在 pool 范围**：mini-app 页面用 `<webview>` tag 承载，pool 给出的 `WebContents` **无法 reparent 到 `<webview>` 元素** — Electron 没有"先 new wc 再 attach 到 webview tag"的 API（见 [§5 已知限制](#5-已知限制)）。
3. 复用 `WebContents` 跨 mini-app 时，**导航回 `about:blank` 销毁旧 JS realm** 是状态隔离的核心手段；service-host 跑在共享 `persist:simulator` session 上，reset **不**清该 session 的 storage（`clearStorageOnReset: false`），见 [§3.4](#34-reset-契约release--ready) / [§4.2](#42-重置完备性)。
4. **预热页面 vs preload 契约**：service-host preload（`src/service-host/preload.cjs`）在 URL query 缺 `bridgeId` 时直接 `return`（暖机 idle），所以 pool 用 `about:blank` 预热的窗口能存活到真正 spawn 导航（`service.html?bridgeId=…`）再重跑 preload 完成初始化。真实 spawn 永远带 bridgeId，故 spawn 路径行为不变。

## 1. 问题陈述

### 1.1 总览

打开一个 dimina mini-program 项目，从 renderer IPC 发起到首屏 paint，至少跨四个阶段：

| 阶段 | 主要消耗 | 类型 | 量级估算 |
|---|---|---|---|
| A. 进程/内核 | `BrowserWindow` / `WebContentsView` / `<webview>` 创建（renderer process fork、IPC 通道建立） | 系统调用 | 60–150 ms（冷） |
| B. preload 注入 | preload bundle 在每个 frame attach 时同步执行（service-host preload / render-host preload） | JS parse + execute | 30–80 ms |
| C. 页面骨架 | 加载 service.html / pageFrame.html、CSS 解析、runtime 初始化 | 网络/磁盘 + parse | 50–120 ms |
| D. service 业务 | service-host boot：`injectLogicBundle` → `loadResource` → 创建 App + Page 实例 | 业务路径 | 100–400 ms（取决于 app） |

> 上面是按 Electron 41 在 M1 / 16GB 上的典型量级估算，不是 e2e 实测。

### 1.2 具体路径

#### 1.2.1 service-host 创建（`createServiceHostWindow`）

```
renderer SPAWN IPC
  → bridge-router.handleSpawn   // src/main/ipc/bridge-router.ts:451
    → createServiceHostWindow   // src/main/windows/service-host-window/create.ts:124
      → new BrowserWindow({ partition:'persist:simulator', preload:serviceHostPreloadPath, ... })
      → loadURL(file://.../service.html?bridgeId=...)
    → did-finish-load → bootServiceHost
      → injectLogicBundle (fetch + executeJavaScript)
      → forwardToService(loadResource{...})
```

这条路径里 `createServiceHostWindow` 是同步 `new BrowserWindow`，每次开项目都跑一次。**这是预热最直接的目标**：window 启动 + preload (`dist/service-host/preload.cjs`) 注入 + service.html load 全部可以摊到空闲期。

#### 1.2.2 dmb:page:open 多页打开

`PAGE_OPEN`（`handlePageOpen`, bridge-router.ts:611）不创建新 `BrowserWindow`，它只在 router state 里 push 一个 `PageSession`，等 simulator 端 render-host `<webview>` 子 frame 自己上线（`ensureRenderBound`, bridge-router.ts:1109 在 `RENDER_INVOKE` 第一次到达时 bind sender）。所以**多页打开本身不开新进程**，预热对二次开页**收益接近零**。这是本设计区别于"Web 浏览器 tab 预热"的关键事实。

### 1.3 当前已经是热路径的部分

| 子系统 | 来源 | 备注 |
|---|---|---|
| `persist:simulator` session | `main-window/create.ts:32`、`bridge-router.ts:1314` 共享同一 partition | session 单例已存在，preload 只注册一次；pool 不会改这里 |
| `dimina-resource-server` | `bridge-router.ts:477`（`startDiminaResourceServer`） 每个 fallback appSession 起一个 fastify 端口 | 不在固定开销里，跟 app 强相关 |
| 每页 render-host `<webview>` | DeviceShell 渲染（`device-shell.tsx`） | 同 simulator session 内同 frame tree；不在 pool 影响域（见 §5） |

### 1.4 目标 / 非目标

**目标**：

- 把 §1.1 表里的 A + B 阶段在用户感知到的"打开项目"那一刻**降到 < 10 ms**（直接 `acquire` 已 ready 的 wc）。
- 给下游 host（qdmp）一个可选项：用户机器是高端机的 host 可以把池开到 ≥ 2，启动延迟接近 0。

**非目标**：

- 不优化 §1.1 D — 那是 app 自己的代码量，不在容器责任内（预热在物理上也省不掉 service 业务初始化）。
- 不做"跨进程 service worker 缓存"或 page-frame 资源 prefetch。
- 不在生产用户机器跑 N=10 的池 — 这里是开发者工具，不是浏览器（池大小 clamp 到 ≤ 4，见 §4.1 / §6）。

## 2. Native 端的参考实现

三端在工程模型上高度一致：都是"预创建空 webview → acquire 命中 → release 前清理 → 超容量销毁 → 内存压力收缩"。下面三张表逐端记录关键参数与设计取舍，便于跟 §3 的 Electron 实现对照。

### 2.1 iOS：`DMPWebViewPool.swift`

来源：`dimina/iOS/dimina/DiminaKit/Render/DMPWebViewPool.swift`

| 属性 | 取值 | 行号 |
|---|---|---|
| 单例 | `DMPWebViewPool.shared` | :17 |
| 池容量 | `maxPoolSize = 4`, `minPoolSize = 1` | :21-22 |
| 共享 `WKProcessPool` | `static let sharedProcessPool` — 所有 WebView 共享 cookie 进程 | :25-31 |
| 预热触发 | `init()` 里 `Task { await preloadWebViews() }`，首次启动同步预创建 1 个 | :34-40 |
| 复用进入前清理 | `prepareForReuse()`：removeAllUserScripts、removeAllScriptMessageHandlers、`loadHTMLString` 到空 HTML、清除 `DiminaRenderBridge`/`DiminaServiceBridge` 全局符号 | :407-488 |
| 释放路径 | `releaseWebView(wc)` 异步置 `.reseting` → 100ms delay → 检查池容量，超容量直接销毁 | :139-185 |
| 内存预警 | `applicationDidReceiveMemoryWarning` → 只保留 `minPoolSize` 个可用，多出全部销毁 | :373-391 |
| 前/后台 | `applicationWillEnterForeground` → `warmUp()` 重新填充；后台不主动清理 | :367-371 |

**关键工程点**：

1. **共享 WKProcessPool**（:25）— iOS 上多个 `WKWebView` 共享一个进程池，cookies / NSURLCache 一份。Electron 没有完全对应物，但 `session.fromPartition('persist:simulator')` 已达成同等"共享 cookie + cache"语义。
2. **预热和复用都在主线程**（assert `Thread.isMainThread`）— webview 创建本身是 UI thread bound，Electron 一样（main process 同步）。
3. **释放后 navigate 到 inline 空 HTML** 比 navigate to `about:blank` 多走一步：iOS 在 `<script>` 里显式 `delete window.DiminaRenderBridge / DiminaServiceBridge`（:461-487）。dimina-kit 没照搬这一步 — 它只导航回 `about:blank`，靠跨 document 导航销毁整个 JS realm 来达成同等隔离（见 §3.4）。

### 2.2 Android：`WebViewCacheManager.kt`

来源：`dimina/android/dimina/src/main/kotlin/com/didi/dimina/ui/view/WebViewCacheManager.kt`

| 属性 | 取值 | 行号 |
|---|---|---|
| 单例 | `object WebViewCacheManager` | :56 |
| 最大缓存 | `MAX_CACHE_SIZE = 3` | :58 |
| 预创建 | `PRE_CREATE_SIZE = 1` | :59 |
| 过期 | `CACHE_EXPIRE_TIME = 5 * 60 * 1000L`（5 min） | :60 |
| 三池模型 | `activeWebViews`（in-use）、`idleWebViews`（LRU 队列）、`preCreatedWebViews`（预热队列） | :63-69 |
| 预热触发 | `initialize(context)` 注册 `ComponentCallbacks2` + 启动定时清理（每 60s） + 同步预创建 1 个 | :105-123 |
| 复用进入前清理 | `resetWebView`：`stopLoading()` + `clearHistory()` + `clearCache(true)` + 替换 `WebViewClient` | :267-284 |
| 释放清理 | `cleanWebView`：`stopLoading()` + `loadUrl("about:blank")` + `clearHistory()` + `removeJavascriptInterface("DiminaRenderBridge")` + `removeJavascriptInterface("DiminaNativeComponentBridge")` | :289-298 |
| 内存压力分级 | `onTrimMemory()` 4 级响应：UI_HIDDEN/BACKGROUND → clearIdle；MODERATE → clearExpiredAndIdle/2；COMPLETE → clearAllNonActive | :403-420 |
| 后台清理 | `TRIM_MEMORY_UI_HIDDEN` 触发 `clearIdleWebViews()` | :406-409 |

**关键工程点**：

1. **三池而不是两池**：`preCreatedWebViews`（从未被用过）和 `idleWebViews`（用过被释放）严格分开 — 前者状态更干净。dimina-kit 不延续这个区分，但要明确"全新 wc"和"复用 wc"内存生命周期不同 — 后者承载过 cookies / localStorage。
2. **`ComponentCallbacks2` 内存压力响应**有四级 — 这是 Android 的事实，Electron 没有对等 API；`app.on('render-process-gone')` 和 `process.getProcessMemoryInfo()` 可以做手动版本。
3. **定时 cleanup**（每 60s）— 这是 long-running 应用的策略；devtools 的开发者会话相对短，dimina-kit 按事件触发（不定时）。

### 2.3 Harmony：`DMPWebViewCachePool.ets`

来源：`dimina/harmony/dimina/src/main/ets/HybridContainer/DMPWebViewCachePool.ets`

| 属性 | 取值 | 行号 |
|---|---|---|
| 类 | `class DMPWebViewCachePool`（owned by `DMPApp` 实例，不是全局单例） | :14 |
| 三池模型 | `generalCachePool: Array`（通用空 wc）、`lightCachePool: Map<pagePath,...>`（轻量缓存）、`fullCachePool: Map<pagePath,...>`（带页面已加载的预测命中缓存） | :17-21 |
| 初始大小 | `cacheCount = 1` | :23 |
| 扩容增量 | `increaseCount = 2`（每次扩 2 个） | :25 |
| 预热触发 | `DMPApp` 启动序列 `init()` 阶段调用 `webViewCachePool.init()` | `DMPApp.ets:416-418` |
| 命中策略 | `getWebViewNodeController(pagePath, query)`：先查 fullCachePool（带 query 比对），再 pop generalCachePool；池空则同步扩容（`preLoadWebView`） + 1.5s setTimeout 再补 `increaseCount - 1` 个 | :37-77 |
| 全量预加载 | `preLoadFullWebView(pagePath, query)`：连页面 resource 都先加载好，等用户真打开就直接命中 | :91-111 |

**关键工程点 / 跟 iOS Android 的差异**：

1. **owned by app instance**：Harmony 没用全局单例，而是每个 mini-program app 一个 pool — 因为 Harmony container model 里同时只有一个 mini-program 实例。dimina-kit 同理（一次只开一个项目）。
2. **`fullCachePool` — 预测命中**：用户即将打开的 page 路径如果提前知道（比如 tab pages），可以提前 load resource 进 pool。这是三端里最激进的 — iOS/Android 都只预创建空 wc。dimina-kit service-host 启动时不知道 appId / pagePath，未做预测命中。
3. **没有内存压力监听** — Harmony 设备一般内存充裕，这块缺失是合理的；Electron 实现也省略。

### 2.4 三端 pool 对照表

| 维度 | iOS | Android | Harmony | dimina-kit `ServiceHostPool` |
|---|---|---|---|---|
| 池容量上限 | 4 | 3 | 无显式 max（动态扩容） | 默认 3，硬上限 4（`HARD_MAX_POOL_SIZE`） |
| 预热数 | 1（min） | 1（preCreate） | 1 | `DIMINA_PREWARM_POOL_SIZE`（opt-in，默认 0=OFF） |
| 预热时机 | `DMPWebViewPool.init()` (singleton init) | `WebViewCacheManager.initialize()` (DiminaWebView 首次实例化时) | `DMPApp.launch()` 流程内 | install 后延迟 500ms 才 `pool.init`（不抢冷启动，bridge-router.ts:234） |
| 复用前重置 | `prepareForReuse`：removeAllUserScripts + loadHTMLString 空 HTML + delete 全局桥 | `resetWebView`：stopLoading + clearHistory + clearCache + 新 WebViewClient | 文件中未见显式 reset — 通用池里的 wc 由 `DMPWebViewNodeController.initWeb` 重新初始化 | navigate 回 `about:blank` 销毁 JS realm；共享 session 下不清 storage（见 §3.4） |
| 内存压力响应 | `applicationDidReceiveMemoryWarning` 收缩到 min | `ComponentCallbacks2.onTrimMemory` 4 级响应 | 无显式 | 无内存压力监听；崩溃恢复订阅 `render-process-gone` |
| 多页预测命中 | 无 | 无 | `fullCachePool` 按 pagePath + query 命中 | 无（多页通过 PAGE_OPEN 复用 simulator wc，见 §1.2.3） |
| 进程/session 共享 | `sharedProcessPool: WKProcessPool` | 隐式（同一 Application） | 隐式 | `session.fromPartition('persist:simulator')` 共享单例 |
| 失败兜底 | acquire 时若池空，同步创建新 wc | acquire 时若池空，同步创建 | acquire 时若池空，先 push 一个再 pop（同步） | acquire 池空 → 同步 fallback `new BrowserWindow`，绝不阻塞 acquire（`entryId === null`） |

## 3. Electron container 的预启动设计

`ServiceHostPool`（`src/main/services/service-host-pool/pool.ts`）是 main 进程内的单例 pool。导出 surface：`ServiceHostPool` 类 + 类型 `ServiceHostSpec` / `ServiceHostPoolStats` / `ServiceHostPoolInitOptions` / `EntryState`。bridge-router 在 `installBridgeRouter`（bridge-router.ts:212）里 opt-in 构造它（opt-in 检查在 :226），在 `handleSpawn`（:499）`acquire`，在 `disposeAppSession`（:1213 / :1223）`release` 或 `releaseDestroyed`。

### 3.1 不变量

- **acquire 路径 < 10 ms**：有 ready entry 时直接 pop（`acquire`, pool.ts:161 同步命中 ready 分支）；用户点"打开项目"瞬间拿到的 `WebContents` 已 `did-finish-load`。
- **不抢冷启动**：install 后 `setTimeout(…, 500)` 才 `pool.init`（bridge-router.ts:234）— workbench 主窗口先就位（曾因 eager warm 与主窗 firstWindow 竞争导致 e2e flake）。
- **降级安全**：池空 / spec 不匹配 → 同步 fallback `new BrowserWindow`（`acquire` 末尾，pool.ts:183），返回 `entryId === null`，**绝不阻塞 acquire**。
- **状态泄漏零容忍**：每次 release → reset（pool.ts:411）navigate 回 `about:blank` 销毁旧 JS realm；带独立 session 的 spec 还会清 storage（见 §3.4）。

### 3.2 类型与状态机

pool entry 的状态机（`EntryState`, pool.ts:44）：

```ts
type EntryState = 'warming' | 'ready' | 'in-use' | 'resetting' | 'disposing'
//   warming   — 已 new BrowserWindow，about:blank 加载中
//   ready      — 加载 settled，可立即 acquire
//   in-use     — 已 acquire 给调用方（调用方持有窗口直到 release）
//   resetting  — release 中，正导航回 about:blank（然后按 spec 决定是否清 storage）
//   disposing  — 不再回池，正被销毁并移出 pool
```

`ServiceHostSpec`（pool.ts:57）— 一个 spec 完整决定一个 warm 窗口能否服务某调用方；复用 key 是 `preloadPath`：

```ts
interface ServiceHostSpec {
  partition: string            // 会话 partition（对 pool 不透明）
  preloadPath: string          // preload bundle 绝对路径；复用 key
  size?: { width: number; height: number }
  devTools?: boolean
  contextIsolation?: boolean    // default false（service-host 契约）
  sandbox?: boolean             // default false
  nodeIntegration?: boolean     // default false
  clearStorageOnReset?: boolean // default true；共享 session 的调用方设 false（见 §3.4）
}
```

进程模型三 flag 默认对齐 service-host（`createServiceHostWindow`，create.ts:38-43 的 `false / false / false`）：service-host preload 在 page realm 里 `require('electron')` 并写 globals，必须 `contextIsolation:false` 等。pool 不写死这三项，留给需要不同 runtime 的调用方覆盖。

`ServiceHostPoolStats`（pool.ts:85）：`{ total, ready, inUse, warming, resetting, spec }` 占用快照。

`ServiceHostPoolInitOptions`（pool.ts:94）：`{ defaultPoolSize, defaultSpec, maxPoolSize? }`，`maxPoolSize` clamp 到 ≤ 4（`HARD_MAX_POOL_SIZE`, pool.ts:116），默认 3。

### 3.3 公开方法

| 方法 | 行号 | 行为 |
|---|---|---|
| `init(opts)` | :143 | 用 `defaultSpec` 预热到 `defaultPoolSize` 个 ready entry。`warmUpToTarget` 带迭代守护，持续 warm 崩溃下 best-effort（可能 under-filled）而非死循环 — init 后 `getStats().ready` 是建议值不是硬不变量 |
| `acquire(spec)` | :161 | 命中匹配 spec 的 ready entry → 置 in-use 返回 `{ win, entryId }`；spec 变更（preloadPath 不同）→ tear down 所有 pooled entry 并 re-target；池空 → 同步 fallback create，返回 `entryId === null` |
| `release(entryId, win)` | :195 | `entryId === null`（fallback 窗）或 spec 不再匹配 → 销毁；否则 reset（先导航 about:blank 后按 spec 清 storage）后重置 `ready`，超 `maxPoolSize` 则丢弃 |
| `releaseDestroyed(entryId)` | :243 | 调用方报告 acquire 来的窗口已**外部死亡**（优雅关闭 / 崩溃），回收其 in-use slot。对未知 id no-op；幂等；不触碰已消失的窗口。bridge-router 在 `serviceAlreadyClosed` 路径调用（该路径故意跳过 `release`） |
| `resize(target)` | :255 | re-target 到 `[0, maxPoolSize]`；超出 target 的 pooled entry 按**最旧优先**销毁；in-use 不动；不主动 warm 新 entry |
| `getStats()` | :268 | 返回 `ServiceHostPoolStats` 占用快照 |
| `dispose()` | :293 | tear down 所有 entry 并停止接活 |

### 3.4 reset 契约（release → ready）

reset（`reset`, pool.ts:411）顺序固定（先导航后清存储）：先 navigate 到 `about:blank` 让旧 document 停止运行、in-flight 请求 abort，**然后**按 spec 决定是否清 storage — 这样还在跑的旧页面不会在清空后又写回 storage。

下表是 **`clearStorageOnReset === true` 时**的 storage 清理契约（`RESET_STORAGES`, pool.ts:119 + `clearCache()`）：

| 子系统 | 清理 API | 备注 |
|---|---|---|
| HTTP cookies | `session.clearStorageData({ storages: ['cookies'] })` | `RESET_STORAGES` |
| localStorage | `session.clearStorageData({ storages: ['localstorage'] })` | `RESET_STORAGES` |
| IndexedDB | `session.clearStorageData({ storages: ['indexdb'] })` | `RESET_STORAGES` |
| Service Worker | `session.clearStorageData({ storages: ['serviceworkers'] })` | `RESET_STORAGES` |
| Cache Storage (Caches API) | `session.clearStorageData({ storages: ['cachestorage'] })` | `RESET_STORAGES` |
| HTTP cache | `session.clearCache()` | reset 末尾调用 |
| 全局 JS 符号（`DiminaServiceBridge`、`DiminaRenderBridge`、`__diminaSpawnContext`、`wx`） | 由 navigate-to-`about:blank` 跨 document 导航销毁整个 realm | reset 不 `executeJavaScript` 删 global |
| 等待时序 | navigate 先于 storage clear（见上） | `loadBlank` await did-finish-load |

> **共享 session 下的实际行为**：service-host 跑在共享 `persist:simulator` partition（main-window 的 simulator `<webview>` 也用它）。`serviceHostSpec()`（create.ts:108）把 `clearStorageOnReset` 设为 **`false`**，所以 `reset()` 在导航回 `about:blank` 之后**直接 early-return**（pool.ts:416），**不**调用 `clearStorageData` / `clearCache` — 否则会炸掉所有当前活项目的 storage。跨 spawn 的隔离由"导航销毁 JS realm" + storage 在 persist 分区上按 appId 命名空间持久化共同保证，与今天 simulator `<webview>` 共享、从不清空的行为等价。

### 3.5 与现有架构的接入点

#### 3.5.1 render 侧 `<webview>` 为何不能接

mini-app 页面用 `<webview>` 标签承载，pool 给出 `WebContents` 后**无法把它 attach 到一个 `<webview>` 元素** — Electron 不提供把外部 `WebContents` reparent 进 `<webview>` 的 API；`<webview>` 元素必须自己 new 自己的 guest wc。所以 pool **不工作于 render 侧 `<webview>` tag**（这是物理限制，详见 §5）。

simulator session 自身的预热（session 单例 + preload registration）已经默认完成（`configureSimulatorSession`，main-window/create.ts:28 在首次 `createMainWindow` 时 register），不在本 pool 的优化范围。

#### 3.5.2 service 侧（`createServiceHostWindow`）

这是 pool 的主要价值实现处。`handleSpawn`（bridge-router.ts:498-511）的两条分支：

```
bridge-router.handleSpawn
  state.pool 非空（pool ON）：
    → pool.acquire(serviceHostSpec())   // bridge-router.ts:499
        → 池中有 ready entry → 立即返回 { win, entryId }
        → 池空 → fallback new BrowserWindow，返回 { win, entryId: null }
    → navigateServiceHost(win, buildServiceHostSpawnUrl({...}))  // bridge-router.ts:581
        ↑ spawn URL 携带 bridgeId/appId/pkgRoot — 池预热时不可能预知，
          所以 pool entry 是 "wc + preload 已就绪 + loaded about:blank" 状态
  state.pool 为空（pool OFF，默认）：
    → createServiceHostWindow(opts)     // 同步 new + navigate
```

pool 给出的 wc 仍要 `loadURL` 一次（spawn 的 query string 是动态的），但**进程 fork + preload 注入 + V8 isolate 就绪**这部分已完成。

did-finish-load → boot 的接入要点（bridge-router.ts:561-598）：

- **pool 路径**：注册一个 **URL 过滤**的 `did-finish-load` 监听（`bootOnServiceLoad`, :566），只在真正的 `service.html` 导航上 `bootServiceHost` — 过滤暖机 / fallback 的 `about:blank` did-finish-load。监听 ref 存到 `AppSession.onServiceBoot`，dispose 时先摘除（否则被回收的窗口会带着 stale 监听把已 dispose 的 session boot 进下一个 spawn）。
- **fresh 路径**：唯一导航就是 service.html（在 `createServiceHostWindow` 内发起），所以用自摘除的 `once('did-finish-load')`（:595）。
- **liveness guard**：`bootServiceHost`（bridge-router.ts:694）开头校验 `state.appSessions.get(ap.appSessionId) !== ap → return`，杜绝早 dispose 后暖窗复用时把上一个 app 的 `logic.js` 注入下一个窗口。

dispose 接入（`disposeAppSession`, bridge-router.ts:1185）：

- 池窗、非外部关闭：先摘 `onServiceClosed`（:1207）+ `onServiceBoot`（:1210）两个 per-spawn 监听，再 `pool.release(entryId, win)`（:1213）。
- 池窗、`serviceAlreadyClosed`（窗口已外部 closed/crash，由 `onServiceClosed`, bridge-router.ts:555-559 进入此路径）：跳过 `release`，改 `pool.releaseDestroyed(entryId)`（:1223）回收 in-use slot — 否则该 entry 永久泄漏在 pool 里、永久缩小容量。
- 非池窗：走原 `serviceWindow.close()`（:1225）。

#### 3.5.3 状态机与 acquire / release 流转

```
状态机：

   warming ──load settled──> ready
      │                        │
      │                        │ acquire()
      │                        ↓
      │                     in-use
      │                        │
      │                        │ release()
      │                        ↓
      │                    resetting
      │                        │ reset 完成 + 未超 maxPoolSize
      └─ disposeEntry()        ↓
         (spec mismatch /    ready
          maxPoolSize 超 /     │
          render crash /       │
          dispose)             ↓
                            disposing
                               │
                               ↓
                            (gone)
```

```
acquire(spec):  // pool.ts:161
   1. spec.preloadPath 跟 currentSpec 不同 → onSpecChange（tear down 所有 pooled + re-target）
   2. 扫 entries：state==='ready' && preloadPath 匹配
        2a. win.isDestroyed() → reclaim（丢弃，不外发死窗）继续扫
        2b. 活窗 → state := 'in-use' → return { win, entryId }
   3. 全空 → fallback createWindow + void loadBlank（不 await）→ return { win, entryId: null }

release(entryId, win):  // pool.ts:195
   1. entryId === null 或 entry 不存在 → destroyWindow
   2. disposed / spec 不再匹配 → disposeEntry
   3. else → state := 'resetting' → await reset(entry)
        3a. reset 期间被销毁/崩溃/spec 变 → destroyWindow + delete
        3b. 超 maxPoolSize → disposeEntry
        3c. 否则 → state := 'ready'
```

### 3.6 错误恢复

所有窗口死亡（render 崩溃 / 优雅关闭 / 调用方报告的外部销毁）都汇入 `reclaim`（pool.ts:449）：

| 场景 | 处理 |
|---|---|
| `render-process-gone`（pooled 窗 ready 时崩溃） | `onGone`（pool.ts:467）→ `reclaim({ destroyIfPooled: true, refill: true })` → 销毁残骸 + 补 1 个新 entry |
| `'closed'`（pooled 窗优雅关闭） | `reclaim({ refill: false })`（warmOne 注册的 once，pool.ts:397）→ 仅清 entry 表，**不 refill** |
| `release` 后 ready 窗发现 `isDestroyed()` | acquire 扫描时 `reclaim({ refill: false })` 丢弃（pool.ts:173），绝不外发死窗 |
| 调用方报告 in-use 窗已外部死亡 | `releaseDestroyed`（pool.ts:243）→ `reclaim`，不触碰已消失窗口、不 refill |
| `loadURL` 失败（warm / fallback / reset） | `loadBlank`（pool.ts:370）把 reject 和同步 throw 都吞成 settled，单个坏 warm 不 wedge 整个 pool |
| 并发 acquire 抢空 ready 池 | 第二个 acquire 扫不到 ready → 走 fallback create |

> **关键不变量**：refill 只在**崩溃恢复**（`render-process-gone → onGone`）发生，**不在优雅关闭**。pooled 窗的 `'closed'` 只在 app/项目 teardown 时出现（窗口隐藏，没别的东西会关它）— 此时若 refill 会在 Electron 退出途中 `new BrowserWindow`，造窗比关窗还快，挂死 shutdown。所以 `refill` 是 `reclaim` 的逐调用方 opt-in（pool.ts:460 注释）。

## 4. 风险与权衡

### 4.1 内存占用

| 状态 | 估算 RSS / wc | 备注 |
|---|---|---|
| 刚 `new BrowserWindow({show:false})`，未 loadURL | 30–50 MB | 进程已 fork，V8 isolate 初始化 |
| `loadURL('about:blank')` 完成 | 50–80 MB | preload 已注入并执行 |
| `loadURL(spawnUrl)` 完成（service.html + service.js） | 100–150 MB | dimina service runtime 完整加载 |
| 复用前 reset / `loadURL('about:blank')` | 60–100 MB | V8 内部 retain |

> 量级估算，不是 e2e 实测；准确值取决于 service.js bundle 大小（约 800KB minified）。

**取舍**：

- `poolSize=1` 在 8 GB 机器上代价 < 2% — 完全可接受。
- `poolSize=3` 在 8 GB 机器上代价约 5%，仍可接受；硬上限 4（`HARD_MAX_POOL_SIZE`），> 4 的请求被 clamp。
- **预热时机要避开冷启动峰值** — Electron 启动头 500 ms 内还在跑 main-window v8 init，加 pool 会把 cold start P95 拉长一截。所以 warm-up 延迟 500ms（§3.1）。

### 4.2 重置完备性

**JS 全局符号残留**：`DiminaServiceBridge`、`DiminaRenderBridge`、`__diminaSpawnContext` 是 preload 写入的全局符号。`reset()`（pool.ts:411）**不** `executeJavaScript` 删 globals — 它单靠 navigate 回 `about:blank` 的跨 document 导航销毁整个 JS realm。（iOS 的 `prepareForReuse` 额外显式 `delete` 全局桥，dimina-kit 不照搬，因为跨 document 导航本身就重建了 realm。）

**共享 session storage**：service-host 跑在共享 `persist:simulator` session 上，`serviceHostSpec().clearStorageOnReset === false`（create.ts:116），所以 reset **不**清这个共享 session 的 storage — 跨项目 cookies / storage 沿用与今天 simulator `<webview>` 一致的共享语义，不存在"per-entry 专属 partition"的隔离（详 §3.4）。带独立 session 的调用方（`clearStorageOnReset` 默认 true）才会触发 §3.4 的 storage 清理。

### 4.3 preload 注入路径

| 调用方 | preload 注入方式 | 注入位置 |
|---|---|---|
| native simulator WebContentsView（唯一 simulator 宿主） | window-level (`webPreferences.preload`，cjs sibling) | `views/view-manager.ts:561`（`attachNativeSimulator`） |
| `persist:simulator` session 内的 render-host 页面 `<webview>` guests | session-level (`registerPreloadScript({type:'frame'})`) | `main-window/create.ts:36` |
| service-host BrowserWindow | window-level (`webPreferences.preload`) | `service-host-window/create.ts:42` |
| settings / popover WebContentsView | window-level (`webPreferences.preload`) | `views/view-manager.ts:447`、`:480` |
| main window | window-level (`webPreferences.preload`) | `main-window/create.ts:77` |

pool 在 `acquire(spec)` 时按 `preloadPath` 校验 entry 是否匹配（`matches`, pool.ts:303）— 不匹配就 tear down pooled entries 重建。当前只有单一 spec（service-host）进池。

## 5. 已知限制

**render 侧 `<webview>` 无法预热**：mini-app 页面用 `<webview>` tag 承载（`src/simulator/device-shell/device-shell.tsx:255` `<webview … partition="persist:simulator">`）。Electron **没有把预热 `WebContents` reparent 到 `<webview>` 元素的 API**，所以 render 侧 pool 受此硬限制阻塞。当前 service 侧已做成 BrowserWindow（已 pool），render 侧仍是 `<webview>`，该限制未解除。render 侧 pool 只有在 render 也改成 BrowserWindow / WebContentsView 之后才可能。

**预热省不掉 service 业务初始化**：预热只能省 §1.1 的 A + B（fork + preload + parse）一次。service 的业务初始化（§1.1 D）跟 V8 isolate 绑定，每个新 spawn 都得跑一遍 — 这是物理上限，pool 不能省。

## 6. 配置与开关

pool **默认 OFF**，仅当 `DIMINA_PREWARM_POOL_SIZE` 为正整数且 `DIMINA_PREWARM_DISABLE !== '1'` 时开启（`resolvePrewarmPoolSize`, bridge-router.ts:54 + `installBridgeRouter`, :212，opt-in 检查在 :226）。这是当前唯一的配置契约（没有 settings.json 字段）。

| 变量 | 默认 | 作用 |
|---|---|---|
| `DIMINA_PREWARM_DISABLE` | unset | 设为 `1` 强制关闭 pool（即便设了 POOL_SIZE）；`handleSpawn` 全走 `createServiceHostWindow`，与未开池时一致 |
| `DIMINA_PREWARM_POOL_SIZE` | 未设置（=0=OFF） | 正整数开启 pool 并设池大小，clamp 到 ≤ 4（`PREWARM_MAX_POOL_SIZE`, bridge-router.ts:46）；暖机延迟 500ms（避开冷启动） |

## 7. 文件清单

| 文件 | 角色 |
|---|---|
| `src/main/services/service-host-pool/pool.ts` | `ServiceHostPool` 单例 + `EntryState` 状态机 + acquire/release/reset/reclaim |
| `src/main/ipc/bridge-router.ts` | opt-in 构造 pool（`installBridgeRouter`）+ `handleSpawn` acquire + `disposeAppSession` release/releaseDestroyed + `DIMINA_PREWARM_*` 解析 |
| `src/main/windows/service-host-window/create.ts` | `createServiceHostWindow` fallback 路径 + `serviceHostSpec()`（`clearStorageOnReset:false`，共享 `persist:simulator`） |

## 8. 延伸阅读

- [`simulator-refactor.md`](./simulator-refactor.md) — native-host Bridge 协议；service-host BrowserWindow 拓扑（pool 复用的目标窗口）。
- [`electron-container.md`](./electron-container.md) — simulator 顶层 WebContentsView + 每页 render-host `<webview>` 拓扑；render 侧 pool 生效的前提。
- [`workbench-model.md`](./workbench-model.md) — `WorkbenchContext` 的扩展点（pool 经 bridge-router 接入）。
- [`miniapp-snapshot.md`](./miniapp-snapshot.md) — preload 作为唯一真相源；pool 不能破坏这套契约。
- `dimina/docs/Architecture-Details.md` — dimina 官方设计文档；"页面跳转优化"一节把 webview 预加载列为关键优化之一。
- Electron 官方文档：`BrowserWindow`、`WebContents`、`Session.clearStorageData`、`session.registerPreloadScript`。
