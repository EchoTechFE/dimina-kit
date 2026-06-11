# @dimina-kit/electron-deck：抽成独立 Electron host-shell 框架（v2 设计）

> 状态：**原始设计蓝本（已实施，多处已落地修订）**。本文是把 `@dimina-kit/electron-deck` 从「小程序 devtools 专用 host-shell」抽成**独立、领域中立的 Electron host-shell 框架**、并删除老 `createDeckApp` 的实施蓝本。核心已落地（抽取 + 改名 electron-deck + 框架 wire frame 信任 + 领域中立化 + 窗口建窗 seam + 生命周期 opt-in 绑定），标 ⚠️ 处为已落地修订。**当前真相以代码 + 测试为准**；§1/§9 的旧文件名/旧路径属实施前历史背景（`internal/deck-app.ts` 旧称 `workbench-app.ts`；`createDeckApp`、四个 `workbench-{entry,config-adapter,wire-bridge,bindings}` 适配文件、`build-runtime.ts` 均已删；`MinimalApp` 已加；root 入口现为 `electronDeck()`）。

---

## 0. 决定与动机

**锁定的决定**：把 `@dimina-kit/electron-deck` 抽成独立、领域中立的 Electron host-shell 框架；**删掉老 `createDeckApp`**，不接受新旧并存的半迁移态。

**不是重复造轮子**（现成生态调研结论）：没有任何单一现成框架覆盖我们要的 ≥4 条能力且能独立采用。真空白 = **#1 main 进程配置驱动装配 + #3 沙箱信任边界 + #5 WebContentsView overlay 编排** 的组合。Theia 绑死 InversifyJS DI + frontend/backend 双进程 WebSocket、且不碰 #3/#5；工具库只解单点。但 **#2 typed IPC / #4 LIFO dispose 已商品化**（electron-trpc / 原生 `DisposableStack`），不作为框架卖点再投资。

**框架的六条能力**：①配置驱动 host-shell 装配 + app 生命周期 + 多窗口/WebContentsView；②声明式 + typed 双向 IPC（含「必须先声明才能 publish」的事件总线）；③信任边界 / sender policy（沙箱 untrusted vs trusted host 分级）；④确定性资源生命周期（LIFO dispose + 连接/窗口寿命绑定）；⑤WebContentsView overlay / 布局编排；⑥领域无关、可被任意 Electron 应用复用。

---

## 1. 现状与根因（实施前必须理解）

1. **两个平行 orchestrator**：包里 `DeckApp`(`internal/workbench-app.ts`) + 根 `workbench()` **devtools 没在用**；devtools 走自己的 `workbench-entry.ts`（delegate 到 `createDeckApp`/`app.ts`）。两者**不是 1:1 重复**：`DeckApp` 独有 declared-windows + framework-event replay，devtools entry 委托 `app.ts` 再叠 wire/runtime。devtools entry 故意住 devtools「避免 `workbench→devtools` cycle」。

2. **最深根因（v2 P0 必修）**：`DeckApp.start()` 现在 bind 阶段**同步 `new BrowserWindow`、无 `whenReady` gating**。vitest fake ctor 不崩，但真 Electron main 进程会抛——「现在能跑」纯粹因为这条线从没在真 main 进程跑过 `start()`。

3. **信任两份割裂 refcount**：框架 wire-trust（`trustedWcRefs`）与 devtools 领域 `trustedWindowSenderIds` 各自独立；`_senderPolicy` 投影**恒返 true**（`workbench-app.ts:550`），是领域鉴权旁路漏洞。两条链都**只校验 webContents.id、无 frame 校验**（子 frame 可伪冒）。

4. **session 真身在 devtools**：workbench 公共 runtime 的 workspace/session 是桩（`workbench-app.ts:540`）；devtools `workspace-service` 才是活的（被 close/bridge/storage/IPC 消费）。

5. **off-wire CDP 是 devtools 领域**：bridge-router / elements-forward / network-forward / render-inspect 走 `wc.debugger` 直连、在 wire 协议之外，sender-policy 故意排除 simulator/toolbar guest。留 devtools，不上框架。

---

## 2. 目标架构

### 2.1 中心 seam：注入式 `RuntimeBackend`

框架是唯一 orchestrator，但通过注入的 `RuntimeBackend` 拿领域装配。框架不知道 projects/simulator/wx/difile 存在。

```ts
interface RuntimeBackend {
  /** pre-ready：在 lazy-import electron 后、app.whenReady 前跑领域 pre-ready 副作用
   *  （difile scheme / cdp port / CSP / setName）。拿框架已 resolve 的 MinimalApp。 */
  beforeReady?(app: MinimalApp): MaybePromise<void>
  /** 当 true：backend 在 assemble 内自建主窗口，框架跳过 main/toolbar/declared 装配。 */
  readonly ownsWindows?: boolean
  /** 领域装配：真 context / mainWindow 内容加载 / projects / simulator / views / IPC 模块。 */
  assemble(runtime: Runtime): MaybePromise<void>
  /** main-window-assembly seam：框架建主窗口前同步取 webPreferences（与 config 合并，
   *  backend 键优先）。仅 ownsWindows falsy 路径触发。 */
  mainWindowWebPreferences?(): Record<string, unknown> | undefined
  /** main-window-assembly seam：框架建完主窗口、load 内容前同步回调（attach view/listener）。
   *  仅 ownsWindows falsy 路径触发。 */
  onMainWindowCreated?(win: BrowserWindow, electron: typeof import('electron')): void
  /** 框架 edge-trust 一个**自建**窗口时通知 backend 同步领域 trust；返回 Disposable 供 untrust。
   *  **不是** main-window-assembly seam：主窗口那次 trust 受 ownsWindows 门控（ownsWindows:true
   *  不触发），但框架自建的 declared / runtime.windows.create() 窗口**与 ownsWindows 正交**，
   *  总触发（backend 显式让框架建+信任了它）。 */
  onWindowTrusted?(wc: MinimalWebContents): Disposable
  /** 主窗 close（可否决）：'keep' → 框架 preventDefault 留窗；'close' → 放行析构→shutdown。 */
  onMainWindowClose?(): MaybePromise<'keep' | 'close'>
  /** main-window-assembly seam：框架 resize 时回调，backend 用发出 resize 的主窗口重定位 overlay。
   *  仅 ownsWindows falsy 路径触发。 */
  repositionOverlays?(win: BrowserWindow): void
}
```

### 2.2 `MinimalElectron` 扩 `app` 面

框架不许 value-import electron 主进程面；`app` 经注入。新增 `MinimalApp`（type-only）：`whenReady()` / `on('will-quit'|'before-quit'|'window-all-closed'|'second-instance')` / `quit()` / `setName(name)` / `requestSingleInstanceLock?()`。生产路径 `electronDeck()` 的 lazy `await import('electron')` 补 `app: m.app`。**CdpPort / CSP / difile scheme 不进 `MinimalApp`**——它们是领域副作用，backend 在 `beforeReady` 里用自己的 electron 引用调。

### 2.3 框架边界画薄

框架 = **app 生命周期 + 主窗口 + 多窗口创建 + wire（typed IPC + 声明式事件） + 信任边界原语 + 连接/资源 LIFO dispose + 布局引擎(#5)**。
留 devtools（backend）：toolbar/overlay 内容、off-wire CDP、session/workspace、projects/templates、wx 投影、difile/cdp/csp。

### 2.4 compat shim（删 `createDeckApp` 的安全网）

**不能**用 `createDeckApp = (c) => workbench(c, {backend})`——签名（`Promise<void>` vs `Promise<DeckAppInstance>`）+ 胖/瘦 context 对不上，一眼被击穿。**正解**：抽 `createDevtoolsRuntime`（= 今天 `app.ts` setup() 主体）作为**共享实现本体**，`createDeckApp`（薄壳 shim，warn once）与 `createDevtoolsBackend` **复用同一本体**——等价性来自同源，非行为复刻。

---

## 3. 设计裁决（四切片）

### 3.1 app 面 + pre-ready bootstrap
- 执行序列（生产路径，无环）：lazy `import('electron')` → 拿真 app（属性，0 调用）→ **single-instance 门控**（仅 `config.app.singleInstance` 时：`whenReady` **之前**调 `app.requestSingleInstanceLock()`，没拿到锁即 `app.quit()` + abort，phase 停在 `init`、不跑 beforeReady/whenReady/装配）→ `backend.beforeReady(app)`（difile/cdp/csp/setName，**pre-ready 窗口确凿存在**：import 后 / whenReady 前）→ `await app.whenReady()` → `bindAppLifecycle(app)` → `assembleElectron()`（`new BrowserWindow` 此刻合法）→ `backend.assemble(runtime)`。
- 纯净性不破：框架真 electron 触点仍只有那一个 lazy import；`MinimalApp` 是类型，实例由 lazy-import 或测试注入。
- will-quit → `shutdown()`（LIFO dispose；该 handler 先置 `quitInitiated=true`，使 `doShutdown()` 末尾的 `app.quit()` 被守卫跳过，避免「will-quit→shutdown→app.quit() 再次进入 quit」重入）；window-all-closed → **opt-in**：仅 `config.app.quitOnAllWindowsClosed` 显式给值时框架才绑该 listener（`true` 则 emit 时 `app.quit()`、`false` 则注册 listener 但抑制 quit）；**省略则框架不绑、由 Electron 默认行为 / consumer 自理**；globalShortcut 等领域清理进 `runtime.add`，由 shutdown 自动级联（backend 不挂生命周期事件）。

### 3.2 信任边界（安全攸关）
- **非对称统一**：框架 wire-trust（`trustedWcRefs`）是唯一权威 set；领域 trust 经 `onWindowTrusted` 喂回同一份 refcount——backend 在该回调里调 `runtime.windows.trust()`，框架 auto-trust 与领域 trust 共享同一 refcount，无需第二份 set。返回的 Disposable 进 `backendTrustDisposables` map（按 wc 追踪），在**该窗口关闭时**（`handleSubWindowClosed`）就 dispose、不再等整体 teardown（registry 仍兜底主窗口等随 app 死的窗口）。wire senderPolicy 直接查这份统一 refcount（`isTrusted(id)`），不再分 wire/domain 两路。
- **修 `_senderPolicy` 恒真**：改为转发活的 wire senderPolicy（存 `this.wireSenderPolicy` 供 `buildRuntime` 复用，无 wire 时 fail-closed `() => false`）；删 `workbench-wire-bridge.ts` 手写 union + `build-runtime.ts` 第二投影（消 split-brain）。**无独立的领域-trust 判定字段**——领域 trust 经 `onWindowTrusted`→统一 refcount 表达，无需第二判定面。
- **frame 级校验**：引入 `TrustedSenderRef { webContentsId, frame: { url, isMainFrame, processId, routingId } | null }`；`MinimalIpcMain.handle` 扩 `senderFrame`；invoke/send 路径 fail-closed（frame===null 或非 mainFrame→拒）。**⚠️ sendSync 路径 `senderFrame` 可能 undefined，必须 fallback 到 `event.sender`、绝不 fail-closed**（否则误杀线上 sendSync，含 beforeunload 同步写）。
- **豁免**（⚠️ 已落地修订）：原设计「main auto-trust 不回调 backend」已改——主窗口 auto-trust **会**调 `onWindowTrusted`，但受 `ownsWindows` 门控（`ownsWindows:true` 时框架不建主窗口故不触发；`ownsWindows:false` 框架建了主窗口才触发，让 backend 同步领域 trust）。`onWindowTrusted` **不是** main-window-assembly seam：框架自建的 declared / `runtime.windows.create()` 窗口**与 ownsWindows 正交**总触发。

### 3.3 close 语义 + toolbar 归属
- **close 从 `closed` 改 `close`**：`close` handler 先无条件 `preventDefault()` → await `backend.onMainWindowClose()` → `'keep'` 留窗（backend 内部已拆 session + navigateBack）/ `'close'` 设 `shuttingDown` 后 `main.destroy()`→`closed`→`shutdown()`。`'keep'` 路径永不到 `closed`，框架 shutdown 永不抢跑。**须加 in-flight 闸**（codex 条件，防 await 期间二次 close 夹击）。
- **`lifecycle.beforeClose`（app 退出前，cleanup phase）与领域「close 但留下」（ready phase）拆开**——当前 config-adapter 把 `beforeClose` 错映射成「拆 session 时调」，迁移须分离。host 的「会话被关」通知走 `runtime.on('session-changed')`。
- **toolbar 归属**（⚠️ 已落地修订）：**无独立的 toolbar 挂载 hook**。框架按 `config.toolbar` **自建 toolbar WCV**（`assembleElectron`：addChildView + setBounds + auto-trust，load 推迟到 wire 起后），`runtime.toolbarView` 返回该 view（无 toolbar 时 null）。原「toolbar 交 backend 命令式挂载」方案未采纳。
- **layout authority 单一化**：框架只对「main webview 铺满窗口」有权威；toolbar/WCV 内容/overlay 的 bounds 在 renderer 坐标系，由 ViewManager 执行 renderer 报的 rect；框架 resize 回调 `backend.repositionOverlays(win)`（带发出 resize 的主窗口），不直接动 overlay。

### 3.4 时序 + compat shim + 测试（见 §5、§6）

---

## 4. #5 视图编排：layout-as-data（dockview / VS Code 取经）

研究确认 #5 是框架真价值/现成生态真空白。从 dockview / VS Code `grid.ts` / Lumino 吸收（**只借思想，不当依赖**——它们执行端绑死 DOM）：

**吸收**：
- **布局即数据**：可序列化 grid 树（几何拓扑）+ views 表（内容）**分离**，leaf 只存「viewId + 尺寸」。蓝本 = VS Code `grid.ts` 的 branch/leaf 结构（MIT）。
- **按 string-id 注册 view component + 框架装配**：与 `electronDeck(config)` 同构；布局 JSON 纯数据靠它复活。
- **dispose 沿 layout 树级联 + 幂等**（Lumino）：把多 teardown 站点收敛成「dispose 根节点」。
- **floating/popout 二分**：floating→settings/popover overlay（grid 外节点）；popout→多窗口（view 弹独立窗仍属同一 layout、可 `moveBack`，所有权不游离；实现 = `removeChildView`→`addChildView` **同一 WCV 实例**，不是 DOM 搬迁）。
- **core + adapter 分包**：佐证 electron-deck core 领域中立 + devtools 适配。

**数据模型草案**：
```ts
type DeckLayout = { root: LayoutNode; orientation: 'horizontal' | 'vertical' }
type LayoutNode =
  | { type: 'branch'; orientation; children: LayoutNode[]; size: number }
  | { type: 'leaf'; viewId: string; size: number; visible?: boolean
      anchor?: 'dom-tracked' }   // ★ ViewAnchor#38 收编为「尺寸来源=renderer」的一种 leaf
type DeckState = {
  layout: DeckLayout
  views: Record<string, { component: string; params: unknown }>
  overlays?: OverlayState[]       // popover/settings 旁路
}
```
框架的 box-layout 求解器（照抄 Lumino BoxLayout / VS Code GridView 算法）把 size 比例树 + 容器 px → 每 leaf 绝对矩形 → `WebContentsView.setBounds`。

**不照搬**（原生 WebContentsView 语境失效）：拖拽 drop-overlay（WCV 事件不冒泡）/ floating z-index（原生靠 addChildView 顺序、永远遮挡 DOM = simulator bar 被盖坑根）/ popout DOM 搬迁 / 内容 CSS 自适应（setBounds 不重排内部）/ fromJSON 免费 reset（原生销毁重建有真实异步成本）。

**MVP**：只做静态声明 + 序列化 + box 求解器；**保留 `useViewAnchor`#38 作为 `anchor:'dom-tracked'` leaf**（不否定刚做完的 #38，收编进统一模型）；拖拽/popout 缓做。

**排序**：layout-as-data 是**独立于 orchestrator 抽取（§5）的新工作流**，不是杀 `createDeckApp` 的阻塞项，跟在 orchestrator 抽取之后分阶段上。

---

## 5. parity-first 迁移时序

门禁统一含：`tsc --noEmit` + `eslint . --max-warnings 0` + `vitest run`（main 进程 `vi.mock('electron')`）+ **真启 electron**（ESM dynamic-require 崩溃只有真启暴露）。

| 阶段 | 动作 | 门 |
|---|---|---|
| **P0** | 框架补 `whenReady` gate + `MinimalApp` 面 + `RuntimeBackend` seam（纯加法，桩路径不破）；close 改 `close`+in-flight 闸；信任 union + frame 校验骨架 | electron-deck 包 vitest 全绿 + 边界单测 |
| **P1** | 抽 `createDevtoolsRuntime`（从 `app.ts` setup 主体），`createDeckApp` 改薄壳调它（**纯重构、零行为变化**） | 80+1 e2e 全绿 + bootstrap e2e |
| **P2** | 实现 `createDevtoolsBackend` + `api.ts` 的 `workbench` wrapper 默认注入 backend（`workbench()` 走 backend，`launch()` 仍走旧路径并存） | **5 条边界测试全绿（关键门）** |
| **P3** | `launch()` 重写到 backend（80 条 e2e 切到新路径 = 最强 parity 网） | 80+1 e2e 全绿 + 真启 electron；任一红回退补 backend，**不动测试** |
| **P4** | qdmp `pnpm override link` 本地 worktree → qdmp 全量 e2e（基线 10/10，仍用 createDeckApp 靠 shim） | qdmp e2e 10/10 + 真启 |
| **P5 / v0.5.0** | 删 `createDeckApp` / `./app` export / 四适配文件（前置：qdmp 已迁 `workbench()`、deprecation 周期过、grep 确认零外部 importer） | 全量 e2e + qdmp e2e + 真启 |

`api.ts` 的 `workbench` re-export **必须默认注入 devtools backend**（否则裸框架无 projects/simulator → 白屏）。

---

## 6. 五条边界的真行为测试矩阵

冒烟 e2e 证明不了行为等价，须针对性测试：

| # | 边界 | vitest(mock) | 真启 e2e | 反向探针 |
|---|---|---|---|---|
| 1 | pre-ready bootstrap | 装配调用序 | difile fetch + setName + cdp port 在 whenReady 前生效 | 挪到 ready 后 → crash/fetch 红 |
| 2 | 信任边界 | `_senderPolicy` 非恒真 + wire∪域 | declared-window 过域 / untrusted 被拒 | 改回 `()=>true` 红 |
| 3 | close 语义 | — | preventDefault + 留窗 + 拆 session | 去 preventDefault → 窗关红 |
| 4 | toolbar/overlay 布局权威 | resize 回调注册 | bounds 由 ViewManager 权威（**非框架**，修正 SA4） | — |
| 5 | 进程 lifecycle | 幂等 + quit/unregister | 靠 80 条 + workbench-config spec | 双 start → 双注册红 |
| ★ | **native-host 装配 golden-order** | 装配 trace 断言调用序（MCP→renderInspect→storage→networkForward→WXML→AppData→close） | — | 乱序 → 红 |

---

## 7. codex 终判：CONDITIONAL-GO 的 3 个硬条件

v1 是 NO-GO；v2 补齐 5 条边界后 = **CONDITIONAL-GO**，落实以下 3 条即可推进：

1. **close**：`closingDecisionPromise` in-flight 闸防二次关闭夹击；决策在 `close`、`closed` 只清理。
2. **sendSync**：`senderFrame` 缺失 fallback 到 `event.sender`，**绝不 fail-closed**。
3. **native-host**：golden-order parity 断言（该段不在 5 边界里，搬入 backend 最易丢序）。

P3 切 backend 前三门全绿：①whenReady gate；②装配 trace 单测；③Electron smoke（beforeReady 先于任何 BrowserWindow / active-session close 留窗 / sendSync 不被 frame 升级误杀）。

---

## 8. 待实测 spike（不可凭接口形状判定）

- **Spike-1**：框架改 `await import('electron')`（动态 Promise）后，`app.commandLine.appendSwitch`(cdp) / `protocol.registerSchemesAsPrivileged`(difile) 是否仍在 commandLine 截止点之前生效——真 Electron main spike 验证。
- **Spike-2**：`IpcMainEvent.senderFrame`（sendSync 路径，含 beforeunload 同步写）在本仓 Electron 版本是否 undefined——决定条件 2 的 fallback 是否必需。

---

## 9. 关键文件索引（worktree `.claude/worktrees/workbench-landing`）

- 框架：`packages/electron-deck/src/internal/deck-app.ts`（orchestrator，旧称 workbench-app.ts）、`electron-deck.ts`（lazy import 入口 + `electronDeck()`）、`internal/electron-types.ts`（MinimalElectron + MinimalApp）、`internal/wire-transport.ts`（senderFrame / frame 信任 / DECK_* 错误码）、`types.ts`（RuntimeBackend / Runtime / FrameworkEvents）、`src/main/connection.ts`（连接层原语）。
- ~~要杀的老路径~~（**已完成**）：老 `createDeckApp`、四个 `app/workbench-{entry,config-adapter,wire-bridge,bindings}.ts` 适配文件、`runtime/build-runtime.ts` 均已删；devtools 现经注入式 `RuntimeBackend`（`packages/devtools/src/main/runtime/devtools-backend.ts`）接入框架，`launch.ts`/`api.ts` 已收口到 `electronDeck()`。
- 领域（留 devtools / backend 实现）：`services/workspace/workspace-service.ts`、`services/views/view-manager.ts`、`ipc/bridge-router.ts`、`services/{elements,network}-forward`、`services/render-inspect`、`utils/{sender-policy,ipc-registry}.ts`、`app/bootstrap.ts`（difile/cdp/csp）、`app/lifecycle.ts`。
