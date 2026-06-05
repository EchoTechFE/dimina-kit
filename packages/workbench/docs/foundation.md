# workbench 地基设计：Connection 连接层

> 状态：经对抗评审 + 验真收敛（v2）。本文描述 `@dimina-kit/workbench` 作为 devtools 平台地基的终态全景 + 分期路线，本轮聚焦**连接层**详到可动工。
>
> 设计原则：从问题域第一性出发，不引外部框架做权威背书。
>
> 评审结论：核心承重原语 `Connection` 成立（"每受信 webContents 一个连接、持 registry、确定性拆除"未被打穿）。本版主要收敛了 §4/§6/§8/§10 与真实 runtime 语义的偏差，并把 P1/P2 验收门、reset 触发契约钉死。文末 §11 列出 3 个需人拍板的决策。

## 0. 背景与目标

- devtools 要长成一个**可扩展的开发者工具平台**；`@dimina-kit/workbench` 是它的地基层。
- 下游只有一个、且是我们自己的（qdmp），可随框架协同演进，**无向后兼容包袱**。
- 既有重资产是 devtools 主进程的真 runtime（`ViewManager` / `bridge-router` / 富 `WorkbenchContext`），它编码了大量真机踩坑经验。地基**不重写它**，而是给它一个干净的底座，让它（和 qdmp）作为消费者坐上去。
- 本轮地基 = **连接层**。`MiniappRuntime`（小程序内核契约）、统一 RPC envelope、lazy 激活等是连接层之上的后续期。

## 1. 现状事实基线

主进程跟渲染端今天有两套不搭界的机制：

**devtools 侧**（`packages/devtools/src/main/utils/ipc-registry.ts`）：
- `IpcRegistry`：`handle`(invoke) / `handleSync`(sendSync, 阻塞渲染) / `on`(fire-and-forget)，每个直接落 `ipcMain.*`，handler 拿到原始 `IpcMainInvokeEvent`（含 `event.sender` **对象**）。约 15 处实例化，是 devtools 活 runtime。
- 约 72 个离散 channel 名。
- 信任：集中式 `SenderPolicy = (sender: WebContents) => boolean`（`utils/sender-policy.ts`），按 main window / settings window / overlay view / `registerTrustedWindow` 的 id 白名单判定。**simulator/service-host/render-guest 故意不在白名单**（炸裂半径控制）。

**workbench 侧**（`packages/workbench/src/internal/wire-transport.ts` + `shared/protocol.ts`）：
- `WireTransport`：2 个统一 channel（`__workbench:invoke` / `:event` / `:probe`）+ 帧内 `kind`(host/simulator) 派发 + JSON envelope + `senderPolicy.isTrusted(id:number)` + declared-events allowlist + 一次性生命周期。
- **没有任何 host 真的用它**（全 packages 零 `import @dimina-kit/workbench`）；`runtime.ipc` 没接跨进程。这是 #33 合入后零集成的脚手架。

还有第三、四类**不是 async 请求/响应**的通信，结构上进不了统一 envelope：
- **跨 wc 桥帧**：`bridge-router` 的 `SERVICE_INVOKE` / `RENDER_INVOKE` / `API_RESPONSE` / `PUBLISH` 等约 12 个 `ipcMain.on`，按 `AppSession` 在多个 webContents 之间路由（render guest ↔ service host）。
- **CDP/debugger 事件流** + `executeJavaScript` 注入 DevTools 前端 realm（`services/elements-forward` / `network-forward` / `safe-area` / `simulator-storage`）。
- **同步写**：`handleSync`（`WriteFileSync`、`NATIVE_HOST_ENABLED` 透传）。

## 2. 第一性诊断：缺的是"连接"这个一等概念

今天"我在跟谁说话"是**每次调用**拿 `event.sender` 去全局白名单查一个 bool。但**没有对象**代表"这是跟 webContents X 的连接，以及它名下拥有的、随它寿命的资源"。

后果是清理各子系统各自为政，散落在 `view-manager.ts`（10+ 处 `removeChildView`/`once('destroyed')`）与 `bridge-router`（~20 处 `ctx.registry.add`）。补上 Connection 原语，把"webContents 死亡 → 级联拆除它名下资源"从各处祈祷变成**框架不变量**。

> **射程边界（诚实声明）**：连接层只消除"wc 死亡后清理各自为政"这一类洞。它**不**负责"活跃判定的 staleness"（如 stale active-wc）——那是 CDP 响应回查 + 跨连接 active 信号的问题，权威在 bridge-router（见 §4.4）。不要把 P2 验收误当成"连接层独立保证无 stale active-wc"。

## 3. 终态全景架构

自底向上分层，每层只依赖下层：

```
┌─────────────────────────────────────────────────────────┐
│ host shell        (qdmp / dimina 自身的集成入口配置)        │
├─────────────────────────────────────────────────────────┤
│ MiniappRuntime    (小程序内核契约：views/bridge/workspace/   │
│  契约              simulatorApis/storage/...，下游复用面)    │  ← 后续期
├─────────────────────────────────────────────────────────┤
│ domain consumers  (bridge-router / ViewManager / CDP        │
│                    forwards / Monaco —— own 资源进 connection,│
│                    observe 其 reset/closed；连接层不 import 它们)│
├─────────────────────────────────────────────────────────┤
│ typed RPC         (common/ 方法契约 + 边界校验，无 Proxy；      │
│                    ctx:{connection, sender} 作 per-call 上下文)│
├─────────────────────────────────────────────────────────┤
│ Connection 原语   (每个受信 webContents 一个，持单段 registry,  │  ← 本轮
│                    destroyed 级联拆除 / reset 换段)           │
├─────────────────────────────────────────────────────────┤
│ wire             (分层：①async invoke/event envelope ②同步    │
│                   sync channel ③跨 wc 桥帧/CDP 永久裸路径)     │
└─────────────────────────────────────────────────────────┘
```

代码物理分层：`packages/workbench/{common,main}`，renderer 侧 client 单列。lint 规则强制 renderer 不得 import main。

## 4. 核心原语：Connection（本轮详设）

### 4.1 概念与所有权

一个 `Connection` = 一个受信 webContents（keyed by 不可伪造的 `wc.id`）。它持一个 **`DisposableRegistry`，作为"单次寿命段"的容器**——注册到它的 RPC handler 派生资源、event 订阅、CDP service 的"自己那份 detach 决策"、bridge-router 的 page 条目，在该段结束时 LIFO 确定性 dispose。

```ts
// packages/workbench/main
export interface Connection {
  readonly id: number            // webContents.id，不可伪造身份
  readonly webContents: WebContents
  /** 注册随当前寿命段清理的资源；返回 Disposable 可提前撤销 */
  own(d: Disposable | (() => void)): Disposable
  /** 连接级生命周期事件 */
  on(ev: 'reset' | 'closed', cb: () => void): Disposable
  readonly alive: boolean
}

export interface ConnectionRegistry {
  /** webContents 通过 SenderPolicy 准入后建/取连接；幂等 */
  acquire(wc: WebContents): Connection
  get(id: number): Connection | undefined
  all(): readonly Connection[]
  /** 软复用：dispose 旧寿命段、换新 registry（见 §4.3）。先 disposeAll 再开放注册 */
  reset(id: number): void
}
```

**registry 实现选用 `devtools 的 disposable.ts`**（见 §11 决策①）。注意它 `disposeAll` 后 `_disposed` 永久置真、再 `add` 抛错——因此 **reset 不在同一实例上清空续用，而是整体替换为 `new DisposableRegistry()`**（仓内先例：`workbench-context.ts:244` `ctx.registry = new DisposableRegistry()`）。换段后旧 `own()` 句柄因校验旧 entry 天然 no-op，不会误删新段资源。

### 4.2 dispatch 携带 WebContents 对象（非裸 id）

分发 RPC 时把 **WebContents 句柄**（而非 `senderId:number`）连同 `ctx:{ connection, sender }` 穿到 handler。原因：bridge-router 大量用**对象身份**做归属——`ensureRenderBound` 比较 `page.renderWc !== sender`、存长寿命引用、`sender.once('destroyed', ...)`；`appByWc` / `bindWc` 用 `wc.isDestroyed()`；`resolveSimulatorWebContents` 返回 sender 对象。仅传 number id 这些全断。

> 这要求修正 workbench 现有 `SenderPolicy.isTrusted(senderId:number)` 占位 + `invokeHost/invokeSimulator(name,args)` 占位，使其兑现 §4.2 的 object-based 契约。

### 4.3 两种拆除触发（关键）

- **硬销毁**：真终态钩子用 `webContents.once('destroyed')`（**不是** `render-process-gone`）。`render-process-gone` 触发时 `webContents.isDestroyed()` 仍为 `false`；devtools 唯一的 `render-process-gone` 处理器是 `pool.onGone`（`pool.ts:392`），它走 reclaim = 销毁 husk + 暖一个**全新 BrowserWindow（新 wc.id = 新连接）**，不存在"同 wc.id crash 后 reload"路径。所以 render-process-gone 间接映射成 closed 是对的，但**拆连接的时刻锚在 `destroyed`**，避开 `isDestroyed()` 仍 false 的不一致窗口。`view-manager.ts:454/652/754` 已用 `once('destroyed')` 作真终态先例。
- **软复用**：`ServiceHostPool` 预热窗口 navigate-blank 后复用同一 webContents 跑新 app 会话（`pool.release`/`reset` 复用同一 `BrowserWindow`）。此时 wc.id 不变但语义换人——连接收 `reset`：dispose 旧段 + 换新 registry，连接对象保留。

  **排序契约（实现已验证）**：`reset(id)` **同步**换入新段（`segment = new DisposableRegistry()`）后才返回，旧段 `disposeAll()` 是**异步拖尾**。因此 reset 返回后任何 `acquire`/`own` 立刻看到开放的新段；旧段清理与新段注册时间上重叠，但旧 `own()` 句柄因指向旧段已 released 的 entry 天然 no-op，不会误删新段。close 同理：同步置 `alive=false` + 从 registry 摘除，再异步 `disposeAll` 旧段。

  **事件在拆除起点 emit**：`'reset'` / `'closed'` 在 `disposeAll` **开始时**（非完成时）同步触发——监听者（domain service）据此 prune 自己的图，**不应假设**该连接名下资源此刻已拆净（异步 disposer 可能仍在跑）。

  **B1 守卫**：`acquire(wc)` 在 `wc.isDestroyed()` 时返回一个**非 alive、不入 registry** 的死连接（其 `own()` 立即 dispose 不泄漏）——否则给已销毁 wc 重新 acquire 会挂一个永不触发的 `once('destroyed')`、造出永久 alive 的僵尸连接。

  **reset 触发权归 bridge-router**（pool 对连接层零暴露，`pool.ts` 全文无 emit/callback）：`disposeAppSession` 在 `pool.release` **之前**同步调 `ConnectionRegistry.reset(serviceWc.id)`；pool 保持对连接层无知（符合 §3 分层）。normal teardown 与 `serviceAlreadyClosed` 两条路径都要打 reset/closed，不能只一条。

### 4.4 粒度：per-webContents，扁平不嵌套

- simulator 顶层 `WebContentsView` 是一个 webContents = 一条连接。
- 它内部 host 的每个 per-page render-host `<webview>` 各自是**独立 webContents** = **各自独立连接**。
- 跨连接的状态（session、page stack、**active render target**）**不进连接层**。"哪个连接活跃"由 `bridge-router` 作权威（`getActiveRenderWc` + `onRenderEvent('activePage')`，CDP forward 每事件实时回查 `isActiveWcId`）。连接层只提供 `connection.on('reset'|'closed')` 供各 domain service prune，**不复制不替代** active 判定。

### 4.5 信任分两层（不要把"路由归属"当"信任 bool"）

- **第一层 — SenderPolicy 全局白名单**（main / settings / overlay / `registerTrustedWindow`）：作 `acquire` 的**准入条件**。`runtime.windows.trust(externalWin)` 必须走 `acquire` 路径，从而强制挂上 §4.3 的 `destroyed` 级联拆除（不允许只返回一个需 host 记得调的 Disposable，否则 wc.id 复用静默继承授权）。
- **第二层 — bridge-router 的 per-AppSession 归属**（`appByWc`：这个 sender 是不是本会话的 service/simulator/render wc）：这是**路由归属**不是受信 bool，**留在 domain 层、连接层不吸收**。

  simulator / service-host / render-guest **故意不在 SenderPolicy 白名单**（炸裂半径）。它们可 `acquire` 一个**受限连接**（= 资源寿命容器 + capability-scoped 受信），但 `ConnectionRegistry.get(id)` 命中 **≠ 全 72 通道受信**。嵌套 render-guest 的信任根是 **embedder 关系**（attach 到 simulator WCV）+ 其 render 消息走 **bridgeId 关联**（`ensureRenderBound` 惰性绑定）；顶层 simWc 的 custom-api 走**精确 sender-id 门禁**（`view-manager.ts:743`）。两者不是一回事，连接层都不替它们做决策。

  受限连接的具体信任形态见 §11 决策②。

## 5. 类型化 RPC（连接之上）

- 方法契约声明在 `common/`：`interface FooService { bar(a: A): Promise<R> }`，编译期 `tsc` 卡两端。
- 运行时边界做 JSON 校验（沿用 `ipc-schema` / zod 风格），**不做运行时 Proxy**（栈可读、不吞类型）。
- handler 形态保留 `ctx:{ connection, sender }` 作 per-call 上下文（§4.2）——路由/信任承重墙，不抽象掉。
- 承载在 async invoke envelope 上（`WireTransport` 的 `__workbench:invoke` 演进版，从写死 host/simulator kind 泛化为 "connection + service + method"）。

## 6. 显式旁路（不进 async envelope）

### 6.1 同步通道（sendSync）

beforeunload 落盘等数据完整性场景。连接层提供独立的 `connection.handleSync(method, fn)`（main 端 `ipcMain.on` + 设 `event.returnValue`，**强制同步、不 promise 化**），adapter 把 `IpcRegistry.handleSync` 映射到它而**非** async envelope。同步消费者盘点：`WriteFileSync`（`ipc/project-fs.ts`，hard close 时 async round-trip 来不及，sendSync 阻塞 page teardown 直到落盘是其唯一存在理由）、`NATIVE_HOST_ENABLED`（`custom-apis.ts` / `native-host.ts` 透传）。错误回传形态保持 `IpcRegistry` 现有的扁平 `{ ok, code, message }`，不走 envelope 的嵌套 `InvokeFailure`。

### 6.2 CDP / debugger（连接层绝不持有"the session"）

`wc.debugger` 是 **per-wc 单 owner**，被 `safe-area` / `elements-forward` / `network-forward` / `simulator-storage` **协商共享**：各自维护 `attached`/`selfAttached` 集合、**只 detach 自己 attach 的**、`Emulation.setSafeAreaInsetsOverride` 是不可被他人路由/拆除的红线。

连接层**不持有 debugger session、也不自行统一 detach**。它只提供 `connection.own(disposer)`，让每个 CDP service 把"**自己那份** detach 决策"登记进连接寿命。`executeJavaScript` 注入的前端 realm hook 同理（own 自己的拆除）。

> 反模式警告：**绝不可**把它实现成"连接持有 the debugger session、closed 时统一 `debugger.detach()`"——那会在 safe-area 仍需 Emulation override 时拆掉会话、或替他人拆掉在用会话。

## 7. debugTap

- flag（env / 设置）开关的环形缓冲，挂在 async envelope 的 dispatch 唯一咽喉点。
- 记录：connection id / service / method / 请求或通知 / 耗时 / 错误。
- 后续可在一个隐藏面板里看。调试 bridge-router 跨 wc 状态机时这是最值钱的可观测性。

## 8. wire 分层与迁移策略（诚实版）

终态**不是**"72 channel 全收进一个统一 envelope、adapter 迁完即删"。结构上有四类通信进不了 async per-connection envelope，它们是**受支持的永久路径**（与"不重写 runtime、让它当消费者"一致）：

| 类别 | 永久路径 | 说明 |
|---|---|---|
| 声明式 RPC / events | async invoke/event envelope | 连接层主路径，可逐步类型化 |
| 同步写 | 独立 sync channel（§6.1） | sendSync 不可 promise 化 |
| fire-and-forget 单向 | 单向 channel（见下） | 12 个高频桥 `ipcMain.on` 无应答 |
| 跨 wc 桥帧 / CDP 流 | `rawIpcMain` / 裸 `ipcMain.on` / `wc.debugger` | bridge-router 跨连接路由、CDP，按 AppSession/对象身份 |

**adapter 的准确语义**：通道 handler 仍是 **cross-wc 单例**、随 workbench registry 走（`IpcRegistry.handle` 是 `ipcMain.handle` 单点全局注册）。adapter 的作用是在**分发阶段**用 `event.sender.id → ConnectionRegistry.get(id)` 做准入 + 把**本次调用产生的有寿命资源** `own()` 到该连接——**不是**把 handler 本身注册进某连接的 registry。

**单向通道**（P3 加法）：async envelope 唯一请求通道必产应答帧；12 个高频桥（`SERVICE_INVOKE`/`RENDER_INVOKE`/`PUBLISH`/`API_RESPONSE`）是无应答的。需补一条 `ipcRenderer.send` + `ipcMain.on` 的无应答语义（或 req 上加 `oneWay:true` 让 main short-circuit），adapter 把 `IpcRegistry.on` 映射到它而非 invoke，否则背压与错误传播被改变。

迁移**不 big-bang**：adapter 期间双向兼容，声明式 RPC/events 逐个迁到 `common/` 契约 + envelope；同步写 / 单向 / 跨 wc / CDP 长期留在各自路径。

## 9. 分期路线图（每期可二分、可证伪验收）

> 原则：每期独立交付、可回滚。连接层这种"无用户可见变化"的底层重构，验收门必须是**可证伪的 unit 探针**（不把全量 e2e 当 cleanup 正确性的承重探针——e2e 观测不到 registry 归零/removeHandler/CDP detach），e2e 作回归网/冒烟。

- **P1 连接层落地（本轮）**
  - 内容：`Connection` + `ConnectionRegistry`（`acquire/get/all/reset`）+ `own/reset/closed` 生命周期；`IpcRegistry` 改为在连接之上做准入 + 资源归属（adapter，行为对调用方 1:1）；dispatch 兑现 §4.2 object-based ctx。
  - **DoD（强制，防 #33 孤岛搁置）**：
    1. `packages/devtools` 新增对 `@dimina-kit/workbench` 的 `package.json` 依赖边；
    2. 至少一条 devtools 主进程真实路径（`IpcRegistry` 即此点，约 15 处实例化）已切换为 Connection 消费者，**真启 Electron + 全量 e2e 零回归**；
    3. **价值锚点（可计数，替代纯"1:1"）**：把 `view-manager`/`bridge-router` 现有逐个 `removeChildView`/`once('destroyed')`/`removeListener` 的 teardown 散点收口到单一 `Connection` 拆除，单测断言 `registry.size === 0`；
    4. 连接生命周期单测：destroy / reset / in-flight invoke 撞 destroy / reset 后旧在途响应不串扰进新会话（见 §10）。
- **P2 资源归属收口**
  - 把 CDP service 的 `destroyed` 绑定、bridge-router page 条目、event 订阅改挂到 `connection.own(...)`，删各子系统手写 teardown 散点。**引用计数 / 谁-attach-谁-detach / Emulation 红线仍由各 service 自管**（§6.2），不得实现成全局 detach。
  - 验收（可证伪探针）：`Connection.destroy()/reset()` 后断言 (a) `registry.size===0`、(b) 关联 ipcMain channel 全部 `removeHandler`、(c) 各 CDP forward 的 self-attached session 全部 detach 且 `wc.debugger` 无残留 listener。全量 e2e 零回归。
- **P3 统一 envelope + 类型化 RPC + 单向通道 + debugTap**：高频声明式 channel 迁到 `common/` 契约 + envelope；补单向通道（§8）；debugTap 上线（能抓 bridge-router 消息流）。
- **P4 MiniappRuntime 契约**：小程序内核字段从富 context 显式命名为稳定契约面。验收：最小 qdmp-stub host 跑通。
- **P5 host shell + 收尾**：qdmp 扩展点补齐；决定 `WireTransport` 旧 host/simulator kind 路径去留。

每期之间任何 e2e 回归或探针不过即停在该期。

## 10. in-flight / reset 竞态语义

- in-flight invoke 撞 destroy：closed 即拒新分发，in-flight 让其自然结束；其结果 `send` 时 wc 已亡则吞（egress 防护，`bridge-router.ts:1243` `isDestroyed` 即此用途）。
- **迟到响应的丢弃判据是"会话代身份"，不是 wc 存活态**：响应按 `pending.appSessionId` 解析路由（`appSessionId = bridgeId` 每 spawn 唯一，`handleApiResponse` 按它解析 + sender 校验，`disposeAppSession` 按它排空 pending）。reset 后旧在途响应因 `!pending` 或 sender mismatch 被丢，不会串扰进新会话。
- P1 必测：reset 后旧在途响应不得落到新会话（`registry.size===0` + 旧响应被丢）。

## 11. 需人拍板的决策

1. **Connection 持哪份 registry**：`devtools 的 disposable.ts`（disposed 后 add 抛错）vs `#33 的 resource-registry.ts`（disposed 后 add 立即 dispose 不泄漏）。二者 disposed 语义互斥。**本文倾向 disposable.ts**（配 §4.1 的"reset=换实例"方案，永不在 disposed 实例上 add，故抛错语义无害），并废弃 #33 `ResourceRegistryImpl`。— 待确认。
2. **受限连接（simulator/service-host/render-guest）的信任形态**：(a) 引入显式 capability 集（连接携带能力、分发时按通道所需能力裁决，更干净但增本轮范围）vs (b) 维持现状双轨（不进 senderPolicy 白名单 + per-AppSession 归属留在 bridge-router）。**本文倾向 (b)**，§4.5 已按此写"存在即受信不覆盖这些面"。— 待确认。
3. **`audience` 定向**：公开类型 `TypedIpcRegistry.handle` 的 `audience` 当前是 no-op 假保证。本轮不做按受众定向的话，**倾向先从公开类型移除**（避免 host 写 `audience:['toolbar']` 得到静默无效保证），待能实现再加回。— 待确认。
