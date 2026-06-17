# 连接层（Connection layer）参考

`@dimina-kit/electron-deck/main` 的连接层为主进程提供一组承重原语：`Connection` / `ConnectionRegistry`、随连接寿命确定性拆除的资源归属、以及一个观测用的 `debugTap`。它是 devtools 主进程（以及下游 host）做"按 webContents 归属资源、按 webContents 死亡级联清理"的底座。

本文面向要理解或使用这一层的工程师，回答：它是什么、解决什么、怎么用、有哪些必须知道的语义与红线。

实现位置：
- `packages/electron-deck/src/main/connection.ts` — `Connection` / `ConnectionRegistry`
- `packages/electron-deck/src/main/disposable.ts` — `DisposableRegistry`
- `packages/electron-deck/src/main/debug-tap.ts` — `debugTap`

---

## 1. 它解决的问题

主进程的资源（IPC handler 派生状态、event 订阅、CDP service 的 detach 决策、bridge-router 的 page 条目）天然挂在某个 webContents 上：那个 webContents 死了，这些资源就该一起消失。若散落在各子系统里各自为政——`view-manager` 里一堆 `once('destroyed')` / `removeChildView`、bridge-router 里一堆手写 teardown——很容易漏。

连接层把"**webContents 死亡 → 级联拆除它名下资源**"做成框架级不变量：资源 `own()` 到连接上，连接负责在正确时机确定性拆除。

---

## 2. 核心模型

### Connection = per-webContents 一等概念

一个 `Connection` 对应一个 webContents，键是 **`wc.id`**——一个不可伪造的身份。连接是**扁平的，不嵌套**：

- simulator 顶层 `WebContentsView` 是一个 webContents = 一条连接。
- 它内部每个 per-page render-host `<webview>` 是独立 webContents = 各自独立的连接。

跨连接的状态（会话、page stack、哪个连接是 active render target）**不进连接层**——那是 bridge-router 等 domain 层的权威。连接层只提供"这个 webContents 名下的资源容器 + 它的生命周期事件"，不复制也不替代 active 判定。

每个连接内部持一个 **`DisposableRegistry`** 作为"单次寿命段"（lifetime segment）的容器。注册进去的资源在该段结束时按 **LIFO** 确定性 dispose。

### 接口

```ts
interface Connection {
  readonly id: number            // webContents.id，不可伪造身份
  readonly webContents: WebContents
  readonly alive: boolean
  /** 注册随当前寿命段清理的资源；返回的 Disposable 可提前撤销 */
  own(d: Disposable | (() => void)): Disposable
  /** 连接级生命周期事件；返回的 Disposable 用于退订 */
  on(ev: 'reset' | 'closed', cb: () => void): Disposable
}

interface ConnectionRegistry {
  /** 为一个 webContents 建/取连接；幂等 */
  acquire(wc: WebContents): Connection
  get(id: number): Connection | undefined
  all(): readonly Connection[]
  /** 软复用：dispose 当前段，换入一段全新的 registry */
  reset(id: number): void
}
```

`createConnectionRegistry()` 产出一个 registry。devtools 把它作为 `DeckContext.connections` 字段，由真实接线点（app 启动、view-manager、bridge-router、各 CDP service）按需 `acquire`。

---

## 3. 关键语义：`own()` vs `on('closed')` —— 最容易踩错的点

连接有两条拆除路径（见 §4）。`own()` 和 `on('reset'|'closed')` 在这两条路径上的行为**不同**，选错会导致资源在复用后残留或被过早拆掉。

| | 触发于 reset（软复用） | 触发于 close（硬销毁） | dispose / 退订时 |
|---|---|---|---|
| `own(d)` | ✅ 触发 | ✅ 触发 | 调 `dispose()` 摘除该条目并**立即运行**它的 disposer；reset/close 不会再运行第二次 |
| `on('reset', cb)` | ✅ 触发 | ✗ | 返回的 Disposable 调 `dispose()` = removeListener，**不** fire |
| `on('closed', cb)` | ✗ | ✅ 触发 | 同上，removeListener 语义，移除即不 fire |

由此得出资源该挂在哪：

- **会话寿命资源 → `own(d)`**。资源只对"这一次 app 会话"有效，会话换人（reset）时就该清掉。例：bridge-router 把"本会话的 `serviceWc → appSessionId` 绑定"`own()` 到 service-host 连接上——pool 复用同一 webContents 跑新会话时 reset 会把它清掉，新会话从干净状态重新绑定。CDP forward / render-inspect 等也走 `own()`。

- **webContents 寿命资源 → `on('closed', cb)`**。资源是对"这个 webContents 本身"的接线，要**跨会话存活**，只在 webContents 真正销毁时才该撤。典型例子是 **open-in-editor**：它在 service-host webContents 上挂 `devtools-open-url` 监听 + 一个去重集合条目，这套接线在 pool 复用（reset）后仍然有效（且 reset 后重新指向同 `wc.id` 会因去重而早退、不会重新接线）。因此它注册在 `on('closed')` 上而**不是** `own()`——若用 `own()`，reset 会把它拆掉、复用后该 webContents 就不再接线了。

> 简记：问"这资源属于**这次会话**还是**这个 webContents**？"会话 → `own`；webContents → `on('closed')`。

`acquire()` 幂等，所以同一个 service-host 连接上可以同时有 bridge-router 的会话寿命 `own()` 与 open-in-editor 的 `on('closed')`，互不干扰。

---

## 4. 两条拆除路径

### 硬销毁（close）：webContents 真死

连接的终态钩子是 **`wc.once('destroyed')`**，**不是** `render-process-gone`。`render-process-gone` 触发时 `wc.isDestroyed()` 仍可能为 `false`，存在不一致窗口；终态锚定在 `destroyed` 上即可避开。

close 时同步：置 `alive=false`、从 registry 摘除（`get(id)` 之后命中不到），随后异步 `disposeAll()` 当前段并 fire `'closed'`。

### 软复用（reset）：换 disposable 段，连接对象保留

`ServiceHostPool` 会把预热窗口 navigate-blank 后复用同一 webContents 跑新 app 会话——此时 `wc.id` 不变但"住进来的人"换了。连接收到 `reset`：dispose 旧段、换入一段全新的 `DisposableRegistry`、fire `'reset'`，**连接对象本身保留存活**。

reset 是同步换段：返回前就把新段（`new DisposableRegistry()`）装好，旧段的 `disposeAll()` 是异步拖尾。所以 reset 返回后任何 `acquire`/`own` 立刻看到开放的新段。旧 `own()` 句柄指向的是已被替换的旧段，**不会影响新段**；它的 disposer 至多运行一次——若在旧段被异步排空标记 released 之前提前 `dispose()`，仍会立即运行那次，之后即 no-op。

> **为什么 reset 必须换实例而不是清空续用**：`DisposableRegistry.disposeAll()` 后会把 `_disposed` 永久置真，再 `add()` 会抛错。所以软复用通过**整体替换**实现，永不在已 disposed 的实例上继续注册。

**事件在拆除起点 emit**：`'reset'` / `'closed'` 在 `disposeAll()` **开始时**触发，不是完成时。监听者（domain service）据此 prune 自己的图，**不应假设**此刻该连接名下资源已拆净——异步 disposer 可能仍在跑。

### reset 的触发权

pool 对连接层零暴露（pool 内没有任何 emit/callback）。reset 由 **bridge-router** 触发：`disposeAppSession` 在把窗口归还 pool **之前**同步调 `connections.reset(serviceWc.id)`。这保证旧会话名下 `own()` 的资源在窗口被下一个会话接手前清掉。真正的销毁仍由连接自己的 `'destroyed'` 钩子走 close 路径。

### 已销毁 webContents 的守卫

对一个已经 `isDestroyed()` 的 webContents 调 `acquire`，会返回一个**非 alive、不入 registry** 的死连接：它的 `own()` 立即 dispose 交进来的资源（不泄漏）、`on()` 返回 no-op。这避免给已销毁 wc 挂一个永不触发的 `'destroyed'` 钩子、造出永久 alive 的僵尸连接。

`own()` 在连接 close 之后被调用时同样安全：不再委托给已 disposed 的旧段（那会抛错），而是立即 dispose 传入资源并返回无害 no-op。无论传入的 disposer 同步抛还是异步 reject，都被捕获并记日志，late teardown 不会逃逸成 Electron 主进程的 unhandledRejection。

---

## 5. 信任分两层

连接的存在与"调用是否受信"是两件事，不要混淆。

- **第一层 — 准入（谁来 acquire）**：由发起 `acquire` 的那一层决定，没有单一全局门。公共 IPC 的 sender 走全局 sender 白名单（main / settings / overlay / 显式 trust 的窗口）；service-host / 原生 simulator / render-guest 这些受限连接则由各自的 domain 层（bridge-router、view-manager）按领域归属**直接 `acquire`**，不经全局白名单。
- **第二层 — 路由归属**：bridge-router 的 per-AppSession 归属（"这个 sender 是不是本会话的 service / simulator / render wc"）。这是**路由归属，不是受信 bool**，留在 domain 层，连接层不吸收。

simulator / service-host / render-guest **故意不在全局信任白名单**里（控制炸裂半径）。它们可以拥有一个**受限连接**（= 资源寿命容器），但 `connections.get(id)` 命中**不等于**对所有面受信。它们各自的信任根（embedder 关系、bridgeId 关联、精确 sender-id 门禁）由 domain 层裁决，连接层不替它们做这个决策。

**一句话**：连接存在即受信不覆盖这些受限面。连接层提供归属与寿命，不提供授权。

---

## 6. dispatch 携带 WebContents 对象，而非裸 id

分发时把 **WebContents 句柄**（而非 `senderId: number`）穿到下游。原因是 bridge-router 大量依赖**对象身份**做归属：比较 `page.renderWc !== sender`、`wc.isDestroyed()` 检查、持长寿命引用、把终态拆除交给连接层（`connections.acquire(sender).own(...)`，destroyed 钩子在连接层而非各处手挂）。只传 number id 这些全断。

连接层也据此设计：`acquire(wc)` 收 WebContents 对象，`connection.webContents` 暴露对象，`connection.id` 才是那个不可伪造的 number 身份。

---

## 7. in-flight / reset 竞态

复用同一 webContents 时，最危险的是**旧会话的迟到响应串扰进新会话**。连接层与 bridge-router 一起保证它不会发生，且判据是**会话代身份，不是 wc 存活态**：

- in-flight invoke 撞上销毁：close 后即拒绝新分发，已在途的让它自然结束；其结果在 `send` 时若 wc 已亡则吞掉（egress 防护）。
- 迟到响应按 **`appSessionId`（会话代身份，每次 spawn 唯一）** 解析路由并校验 sender。reset 后旧在途响应因找不到对应 pending 或 sender 不匹配而被丢弃——**不是**靠"wc 还活不活"判断，因为 reset 后 wc 仍然活着、`wc.id` 仍然相同。
- 配合 reset 换段：旧会话 `own()` 的资源在 reset 时清掉，新会话从干净段开始。

---

## 8. debugTap

`debugTap` 是一个 flag-gated 的环形缓冲，用于观测一条 IPC / 跨 wc 桥消息流。它挂在 dispatch 咽喉点（当前真实消费者：bridge-router 的桥帧分发），调试跨 wc 状态机时这是最值钱的可观测性。

约束：

- **默认 OFF**：通过 `DIMINA_DEBUG_TAP=1` 开启；关闭时 `record()` 是近乎零成本的 no-op，生产热路径不付代价。
- **caller 供 `ts`**：每条 entry 的时间戳由调用方打。electron-deck 包内**禁用 `Date.now()`**（determinism / resumability），所以时间由 caller 传入。
- **有界**：固定容量环（默认 **1000**），超出按最旧优先逐出，永不无界增长。

记录的元数据（`DebugTapEntry`）：`ts` / `channel` / `direction`（in/out）/ `connectionId` / `appSessionId` / `durationMs` / `error` / `summary`（payload 短摘要，不放大 blob）。`entries()` 返回快照副本，调用方持有/改动不影响活环。

```ts
const tap = createDebugTap({ enabled: process.env.DIMINA_DEBUG_TAP === '1' })
tap.record({ ts: Date.now(), channel: 'SERVICE_INVOKE', direction: 'in', connectionId })
const recent = tap.entries() // oldest → newest
```

---

## 9. 最小用法示例

```ts
import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'

const connections = createConnectionRegistry()

// 会话寿命资源：reset + close 都清掉
const conn = connections.acquire(serviceWindow.webContents)
conn.own(() => {
  if (wcIdToAppSessionId.get(conn.id) === appSessionId) {
    wcIdToAppSessionId.delete(conn.id)
  }
})

// webContents 寿命资源：只在真正销毁时撤（跨会话存活）
const conn2 = connections.acquire(serviceWc)
conn2.on('closed', () => {
  serviceWc.removeListener('devtools-open-url', onOpenUrl)
})

// 软复用：会话切换前由 bridge-router 触发
connections.reset(serviceWc.id)
```

---

## 10. 红线速查

- 连接层**不持有** debugger session、也**不自行统一 detach**。`wc.debugger` 是 per-wc 单 owner，被多个 CDP service 协商共享，每个 service 只 detach 自己 attach 的那份，并把"自己那份 detach 决策"`own()` 进连接寿命。绝不可实现成"连接 closed 时统一 `debugger.detach()`"——那会拆掉别人仍在用的会话（如 safe-area 的 `Emulation.setSafeAreaInsetsOverride` override）。
- 跨连接状态（active render target 等）不进连接层；active 判定权威在 bridge-router。
- 软复用必须 reset（换段）而非清空续用——`DisposableRegistry` disposed 后 `add` 抛错。
- 迟到响应的丢弃判据是 `appSessionId`，不是 wc 存活态。
- debugTap 包内不读时钟，时间由 caller 供。
