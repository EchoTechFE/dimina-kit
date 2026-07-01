# Capability 授权 + 生命周期契约

本文约定三件安全/寿命攸关的接口、数据形状与不变量：**senderId 横切 + grant 闸**、**anchor slotToken 原子下发**、**tab 保活归属**。实现落在 `packages/electron-deck`（wire / ControlBus / scope）。安全攸关的不变量用 🔒 标注，需真机 / e2e 实证的点用 🧪 标注。

---

## 0. 相关原语

涉及的原语与它们各自的职责：

- `src/internal/wire-transport.ts`
  - `handleInvoke` 持有 senderId + frame，做 trust 闸 + main-frame 闸；通过后构造
    `InvokeCtx` 携 senderId 下传到 `invokeHost(name, args, ctx)` /
    `invokeSimulator(name, args, ctx)`。
- `src/host/control-bus.ts`
  - `dispatch(name, args, ctx)` 查 command 表后判 grant 闸，再 `handler(...args)`。
    生产接线：deck-app 把 `invokeHost = (name, args, ctx) => controlBus.dispatch(name, args, ctx)`。
- `src/internal/trust-set.ts`
  - refcount 成员集；`isTrusted(id)` 扫 `wc.id`。它**只回答「可不可信」，不回答「可不可调某 command」**——后者是 grant 闸的事。
- `src/main/scope.ts`
  - 嵌套寿命 + 完成栅栏；`on('reset'|'closed', cb)` = generation 边界。
    reset = 软复用（导航/关项目），closed = 终结（关窗/销毁）。**grant 撤销挂这两个事件。**
- `src/internal/deck-app.ts`
  - 每个受信 wc 有一个 per-wc Scope（wcScope），随该 wc 销毁而 `closed`。grant 默认挂这个 wcScope。
- `packages/view-anchor/src/view-anchor.ts`
  - `createPlacementAnchor(target, { visible, publish })`：renderer 侧测量 + `publish(Placement)`。
    `publish` 本身不带 slot 身份——slot 身份由 control-layer 的 IPC 适配层（`createDeckLayoutClient`）在 sink 闭包里拼上 slotToken（见「anchor slotToken 原子下发」）。
  - bounds 的 x/y 允许负（`clampRect` 只 clamp width/height ≥0）——滚动跟随合法，slot 上报校验**不得**把负 x/y 当非法丢弃。

---

## senderId 横切 + grant 强制闸

### senderId 经 `InvokeCtx` 贯穿 dispatch

wire 已持有的 sender 身份经 `InvokeCtx` 贯穿到 dispatch：

```ts
// InvokeCtx（host/index.ts 导出）
export interface InvokeCtx {
  /** 发起 invoke 的 webContents id（wire 已做 trust + main-frame 闸后才到这）。 */
  readonly senderId: number
  /** 发起的帧引用，main-frame 已校验；保留给未来按 frame 细分用，可为 null。 */
  readonly senderFrame: FrameRef | null
}
```

签名：

```ts
// WireTransportDeps
invokeHost:      (name: string, args: readonly JsonValue[], ctx: InvokeCtx) => Promise<JsonValue>
invokeSimulator: (name: string, args: readonly JsonValue[], ctx: InvokeCtx) => Promise<JsonValue>

// ControlBus
dispatch(name: string, args: readonly JsonValue[], ctx: InvokeCtx): Promise<JsonValue>
```

`handleInvoke` 在 trust + main-frame 闸**通过之后**构造 ctx 下传（senderId 此时必为
number、frame 已是 main-frame，构造点天然 fail-closed）：

```ts
// wire-transport.ts handleInvoke 内，闸之后：
const ctx: InvokeCtx = { senderId, senderFrame: senderFrame ?? null }
const result = await this.deps.invokeHost(req.name, req.args, ctx)   // simulator 同理
```

ctx **必填**（无 `ctx?` 可选默认）：🔒 这是安全边界，可选默认会让忘传 ctx 的调用点静默退化成「无 sender 上下文」——把丢 senderId 的漏判从编译错误降级成运行时漏判。`ControlBus.dispatch` 的闸必须拿到真 senderId 才能判 grant。

### 两条 invoke 路由的硬边界

deck-app 有**两条 invoke 路由**：

- **默认路由**：`invokeHost = (name, args, ctx) => ipc.invoke(HOST_PREFIX+name, ...args)`，走 `InMemoryTypedIpcRegistry`，承载声明式 `hostServices` / `simulatorApis`。**只做 trust 闸，没有 grant 闸**——「trusted 即可调」。
- **ControlBus 路由**：`invokeHost = (name, args, ctx) => controlBus.dispatch(name, args, ctx)`，承载布局/特权 command。grant 闸**只在这条**。

两条路由签名都带 ctx（默认路由把 ctx 收下不用）。

> 🔒 **硬不变量—— 布局/特权 command 必须唯一经 ControlBus**：grant 闸**只存在于 `ControlBus.dispatch`**。任何**布局/特权 command**（`layout.*` 等驱动原生 view / 寿命 / 跨窗的动作）**必须**经 ControlBus 注册并 dispatch，**禁止**注册进普通 `hostServices` / `InMemoryTypedIpcRegistry`（那条路由没有 grant 闸）。特权名若误进默认路由 = **grant 授权闸被完全绕过**（任何受信 control 层都能调，越权）。两条路由的边界在接线处写死，特权名永不落进普通 hostServices。与 `architecture.md` 中 ControlBus 必经路由的硬约束一致。

### grant 强制闸（数据形状 + 插点）

**grant 数据形状**（`host/capability.ts`，挂在 sender wcScope 上）：

```ts
export interface Grant {
  /** 被授权的 sender：control-layer renderer 的 webContents id。 */
  readonly senderId: number
  /** grant 寿命：随这棵 Scope 的 reset/closed 自动撤（= sender 的 wcScope）。 */
  readonly senderScope: Scope
  /** 可选授权边界，保留给未来 per-target view-command 检查；当前 grant 闸只按
   *  (senderId, command-name) 判，targetScope 不参与 dispatch。 */
  readonly targetScope?: Scope
  /** 白名单 command 名集合（精确匹配，default-deny）。 */
  readonly commands: ReadonlySet<string>
}

// runtime 面：
runtime.grants.issue(controlWc, { commands: ['layout.resize', ...], targetScope? }): Disposable
//   senderScope 由框架从 controlWc 的 wcScope 自动填（host 不传）。
```

**policy 接口**（ControlBus 注入，default-deny）：

```ts
export interface CapabilityPolicy {
  /** true 仅当存在一条 live grant：senderId 命中 且 name ∈ commands。 */
  allows(senderId: number, name: string): boolean
}
```

**确切插点**（control-bus.ts `dispatch`）——在 command 表解析**之后**、
handler 调用**之前**：

```ts
async dispatch(name, args, ctx): Promise<JsonValue> {
  const handler = commandRegistry.get(name)
  if (!handler) throw new Error(`no command registered: ${name}`)
  // 🔒 grant 闸：trust 已由 wire 在上游判过（senderId 必可信）；这里判「这个可信
  // sender 是否被授权调用这个 command」。default-deny。
  if (policy && !policy.allows(ctx.senderId, name)) {
    throw new DeckRemoteError(name, `forbidden: ${name}`, DECK_CODE.Forbidden)
  }
  return handler(...args)
}
```

闸的层次（**不可换序**）：`wire trust 闸（senderId 可信？）→ wire main-frame 闸 →
ControlBus grant 闸（可信 sender 被授权调此 command？）→ handler`。grant 闸**永不替代**
trust 闸，是叠在其上的第二道。

> **policy 是否注入**：`createControlBus` 加可选 `policy?: CapabilityPolicy` dep。
> **不注入 policy ⇒ 闸不存在 ⇒ 维持当前「trusted 即可 dispatch」行为**（向后兼容：
> 现有只用 `command()` 注册普通 RPC 的 host 不受影响）。只有声明了 grants 的 host 才注入。
> ⚠️ 取舍：default 不注入=不闸，是为兼容；但一旦 host 用 `runtime.grants`，未被任何
> grant 覆盖的 command 必须 default-deny（policy 内部 default-deny，不是「没 policy 就放行」）。

**错误码** `DECK_FORBIDDEN`（`wire-transport.ts` 的 `DECK_CODE.Forbidden`）：抛
`new DeckRemoteError(name, 'forbidden: …', 'DECK_FORBIDDEN')` → `serializeError` 保
remoteName + code → 客户端拿到 `{ ok:false, error:{ code:'DECK_FORBIDDEN' } }`。🔒 这条
fail-closed 序列化复用 `DeckRemoteError` 的保真路径，无新增帧逻辑。

### grant 绑 Scope generation（自动撤销）

`runtime.grants.issue(controlWc, { commands, targetScope? })` 内部：

1. 把 grant 加进 policy 的活跃集合（按 senderId 索引）；senderScope = controlWc 的 wcScope。
2. **订阅 senderScope 的两个事件**自动撤：
   ```ts
   const off1 = senderScope.on('reset',  () => revoke(grant))   // 导航/关项目 → 旧授权失效
   const off2 = senderScope.on('closed', () => revoke(grant))   // 关窗/销毁 → 失效
   ```
   `revoke` = 从 policy 活跃集移除 + dispose 这两个订阅。`issue` 返回的 Disposable 也调
   `revoke`（host 手动提前撤）。
3. **wc.id 复用安全** 🔒：grant 按 `senderId` 命中。closed 后若 wc.id 被新窗口复用而 grant
   未撤，新窗口会继承旧授权。grant 挂在随该 wc 销毁而 `closed` 的 wcScope 上、`on('closed')`
   自动撤，是关掉这个洞的方式。

每个受信 wc 有一个 per-wc Scope（wcScope）：window/view 装配时为其 control wc 建，`win.on('closed')`
里 `void wcScope.close()`，导航软复用（同 wc 重新 load）时 `wcScope.reset()`。`runtime.grants.issue`
默认把 grant 挂这个 wcScope；grant 与 view 寿命统一在同一棵 Scope 树。wc.id-复用安全是框架级
安全属性，由框架保证、不外包给 host。

🧪 需实证：navigate（reset）/ 关窗（closed）后，旧 grant 的 command 被 `DECK_FORBIDDEN`
拒；wc.id 复用场景（关一个窗再开一个拿到同 id）下新窗口**不**继承旧 grant。

---

## anchor slotToken 原子下发

slotToken 解决两件事：(a) 区分同一 control wc 上的多个原生 view 占位（#simulator / #devtools
各一个 slot）；(b) 防一个 renderer 谎报另一个 slot 的 bounds 把别人的 view 挪走。`publish(Placement)`
本身不带 slot 身份，所以靠下发握手补上身份，并消除「view 已建、renderer 还没拿到身份就 measure」
的一帧空窗。

### 原子下发握手协议

**核心不变量** 🔒：renderer 在**拿到该 slot 的 slotToken 之前，绝不上报 bounds**。
靠「先订阅、后由主进程 push token、再开始 measure」的握手，而非「renderer 主动猜 id」。

数据：

```ts
// 主进程为每个原生 view 创建时生成
interface SlotGrant {
  readonly viewId: string      // Compositor 的 NativeViewRef.id
  readonly slotId: string      // DOM 占位 id（'#simulator'），renderer 用来定位 target
  readonly slotToken: string   // 不可猜 nonce（crypto 随机），主进程私存 token→(viewId, 授权 wc, zone)
  readonly generation: number  // 主进程分配、per-wc 单调；stamp 进每帧 snapshot，reload 时更高 generation 重置主进程 reconciler
}
```

握手时序（与 view 创建**原子**）：

```
主进程 runtime.view({...}).placeIn(controlWc, { anchor:'#simulator' })
  1. Compositor 分配 viewId；生成 slotToken（nonce）
  2. 主进程私表登记： token → { viewId, authorizedWcId: controlWc.id, zone }
  3. 主进程 controlWc.send('__deck:slot-grant', { viewId, slotId, slotToken, generation })   ← push，不等 renderer 问
  ──────────────────────────────────────────────────────────────────────────
renderer（control-layer, createDeckLayoutClient）
  4. 启动即订阅 '__deck:slot-grant'（在任何 measure 之前）
  5. 收到 grant → 用 slotId 定位 DOM target → createPlacementAnchor(target, { ... })
     anchor 的 publish 写进一个 **中央 placement publisher**（不是每 view 直接 IPC）
  6. publisher 每帧把所有 anchor 的最新测量合并成 **一个窗口级 snapshot**，
     每 view 带上自己 slot 的 token 作为 extra：
       send('__deck:snapshot', { generation, epoch, views:[{ viewId, placement, layer, extra:{ slotToken } }] })
```

合并成窗口级 level（而非每 view 边沿）是白屏根治：某帧 relayout 把某 slot 瞬时测成 0×0
再恢复，会在下一帧被合并覆盖、永不发布；即便一帧坏值漏出，主进程按整张表 reconcile 会在
≤1 帧内自愈，而不会像旧的每 view 边沿流那样把一个 view 永久卡在 detach。

**保证「拿到 token 前不上报」的两条**：

- renderer 的 anchor **由 slot-grant 事件驱动创建**（步骤 4→5），不是页面 load 即创建。
  没收到 grant 就没有 anchor，自然无从 publish。
- 主进程**先 send grant、不依赖 renderer 的 ack**——若 renderer 订阅晚于 send（一帧
  竞态），靠 **replay** 兜底：主进程对「已发出但未被消费」的 slot-grant 做缓冲，renderer 首次
  订阅时 drain（同 deck-app 的 `pendingWindowCreated` / `pendingLoadFailed` 的「late listener
  replay」模式）。无论订阅先后都不丢 grant，renderer 永远是「先有 grant 才有 anchor」。

> slotToken 由 control-layer 的 IPC 适配层（`createDeckLayoutClient`）在 sink 闭包里**闭包捕获**
> 后拼进帧——**放在 view-anchor 包之外**：view-anchor 仍是 engine-agnostic 的纯测量器（publish
> 是注入的 sink，它不认识 token），保住「不认识 Electron / 不认识协议」的契约。

### slot 上报校验（clean → reconcile → dispatch）

主进程收到 `{ generation, epoch, views:[...] }` 的 snapshot IPC handler（trusted + main-frame
闸之上，复用 wire 那套）后走三步纯函数（`src/layout/snapshot-reconcile.ts` + `placement-reconcile.ts`）：

```
1. cleanSnapshot(raw, authorize)：逐 view 授权 + 清洗成可信 CleanSnapshot——
   a. 查私表 token → { viewId, authorizedWcId, zone }；查不到 → 丢弃该 view。
   b. 🔒 sender wc 匹配： senderId === authorizedWcId ？否则丢弃该 view（越权：B 谎报 A 的 slot）。
   c. viewId / layer(zone) **取自私表，绝不取 renderer 上报的字段**（有效 token 不能拼到伪 viewId 上毒化 key）。
   d. placement.bounds 形状校验： visible:false 合法无 bounds；visible:true 要求 width/height ≥0，
      x/y 允许负（滚动跟随，view-anchor `clampRect` 只 clamp width/height）。**不得把负 x/y 当非法**。
   e. viewId 去重（保留第一个）。
   ⚠️ raw.views 非空但**全部授权失败 → 整个 snapshot 拒绝**（返回 null），绝不解释成「detach 全部」——
      否则一次 token 瞬时失效会把仍活着的 view 全撤掉。views 本就为空（renderer 主动移除全部）则正常 reconcile→detach。
2. reconcile(perWcState, cleanSnapshot)：按整张 desired 表 diff 上次 actual → 有序 op 列表。
   stale 规则：generation < 上次 → 拒；generation===上次 && epoch<=lastEpoch → 拒；generation>上次 → 重置重建。
   （level-triggered：丢/伪一帧自愈；单调 generation 让 reload 的低 generation 在途旧帧被拒。）
3. dispatchOps → 每个受影响 view 调 ViewHandle.applyPlacement（visible:true setBounds / visible:false detach；
   Compositor 纯 z-order 按 zone，reorder op 在 deck 侧忽略）。
```

per-wc 状态：`reconcileStates`（reconcile 表）+ `perWcGeneration`（单调计数）。
`__deck:layout-subscribe`（renderer 重订阅 / reload）→ bump 该 wc generation + 重置其 reconcile state + resend 其所有 grant（带新 generation）。
token 寿命：view dispose（Scope 撤）/ 关窗时从私表删 token，并连带删该 wc 的 reconcile / generation 状态，之后该 token 报的 bounds 全 drop。

🧪 需实证：(a) 同一 control wc 两个 slot 各自只能驱动自己的 view；(b) 构造一个 trusted
wc 用别人的 slotToken 上报 → 被 drop（不挪动目标 view）；(c) 负 x/y（向上滚动）正常跟随
不被丢。

---

## tab 保活归属

tab 切换用 `Placement{ visible:false }` 的 detach-but-keep-alive 保活（不重载，保 CDP/
滚动位/JS 堆）。N 个隐藏 tab = N 个常驻 `WebContents`，无上界则长会话内存无限涨——本节约定
保活寿命与淘汰策略的归属。

### 保活寿命归 Scope、淘汰策略归 host

逐 primitive 看「保活上界该进框架的哪一层」：

| primitive | 职责 | 能管 keep-alive 上界吗 |
|---|---|---|
| **Layout / Placement (view-anchor)** | DOM↔native 几何缝合（measure→bounds） | ❌ 只懂位置，不懂「这个 view 活了多久、多久没显示」。`visible:false` 它只发一帧 detach，不持有 WebContents 寿命。 |
| **Compositor** | z-order / mount-unmount 计划 | ❌ 只懂渲染顺序。`unmount` 已经是「这是新实例」语义（compositor.ts 头注），它不持有也不该决定 WebContents 该不该销毁。 |
| **Scope** | 嵌套寿命 + 完成栅栏 | ⚠️ **懂寿命，但不懂「久未显示」**。Scope 的 close/reset 是**结构性**触发（关窗/导航/host 调用），它没有「最近使用时间」「可见性」这类**策略**输入。 |
| **ControlBus** | RPC + event + trust | ❌ 与寿命正交。 |

结论：**「N 个隐藏 tab 的上界」是一条策略（LRU / max-N / TTL），不是任何 primitive 的固有
职责**。geometry 和 compositor 在设计上就不该碰寿命；Scope 管寿命但只认结构事件、不认
「久未显示」这种带时间/可见性输入的淘汰策略。

**保活寿命归 Scope（结构性），淘汰策略默认归 host**。即：

- **每个 keep-alive 的 tab view = 一个 Scope 子节点**（其 WebContents 由该 Scope `own()`）。
  关窗/关项目时随父 Scope `close`/`reset` 连带销毁——这部分**框架保证**（寿命正确性）。
- **「太多隐藏 tab 该淘汰谁」是 host 的产品决策**，框架**默认不内建 LRU**。host 在切 tab 时
  自己决定 dispose 久未用的 ViewHandle（dispose = 关掉那个 Scope 子节点 = 销毁 WebContents）。

理由：LRU 的「最近使用」「上界 N」是产品语义（哪些 tab 算「重要到要保活」因 app 而异），
塞进框架会让框架猜业务意图；而**寿命正确性**（关了就一定销毁、不泄漏）必须框架保证——
所以把寿命交 Scope、策略留 host。

### opt-in helper：`runtime.view({ keepAlive })`

一个 opt-in、瘦的 helper，承载「最常见的 LRU 上界」这一种策略，避免每个 host 重写：

```ts
runtime.view({
  source,
  scope: session,
  keepAlive: { policy: 'lru', max: 6 },   // 可选；省略 = 框架不淘汰，纯 host 管
})
```

语义（若提供 `keepAlive`）：

- 框架维护一个 per-policy-group 的 LRU 链；`visible:true` 的 view 标记为「最近使用」。
- 当**同组**保活（`visible:false`）的 view 数超过 `max`，框架对**最久未显示**的那个调用其
  ViewHandle 的 dispose（关其 Scope 子节点 → 销毁 WebContents）。
- 当前 `visible:true` 的 view **永不**被淘汰（只淘汰隐藏的）。

框架只内建 `lru`+`max` 一种策略。`keepAlive` 省略时框架完全不管淘汰（纯 host 管）。这样：
寿命正确性永远是框架的（Scope own WebContents）；淘汰策略默认是 host 的，但给一个最常用的
LRU 作为一行 opt-in。不内建 TTL / 其它策略，避免 helper 变策略框架。

🧪 需实证（真机）：(a) 切到第 N+1 个 tab 时，最久未显示的隐藏 tab 的 WebContents 确被
销毁（内存回落 / `webContents.isDestroyed()`）；(b) 关窗/关项目时所有保活 tab 随 Scope
连带销毁、无泄漏；(c) 不传 `keepAlive` 时框架不主动销毁任何隐藏 tab（纯 host 管）。

---

## 附：安全攸关 / 待实证清单

🔒 **安全攸关（设计/实现必须守的不变量）**
- grant 闸：ctx 必填、闸层次 `trust → main-frame → grant` 不可换序、grant 闸 default-deny。
- grant 寿命：grant 必挂会随 wc 销毁而 `closed` 的 Scope；wc.id 复用不得继承旧 grant。
- slotToken：renderer 拿到 slotToken 前不上报；token→(viewId, 授权 wc) 私表 + sender wc 匹配；
  负 x/y 合法不得丢。
- tab 保活：keep-alive WebContents 必由 Scope `own()`，关窗/关项目连带销毁。

🧪 **需真机 / e2e 实证（不能只看 typecheck/单测）**
- grant 闸：一条真实 webview→main invoke 端到端带对 senderId；navigate/关窗后旧 grant 被
  `DECK_FORBIDDEN`；wc.id 复用不继承。
- slotToken：多 slot 各自驱动；伪 token 越权被 drop；负 x/y 滚动跟随。
- tab 保活：LRU 淘汰真销毁 WebContents；Scope 连带销毁无泄漏；无 keepAlive 时不淘汰。

## 附：实现时易错点
1. **per-wc Scope 地基**：grant 绑定依赖「每个 control wc 有一个会随其销毁而 closed 的 wcScope」。
   这块地基与 ViewHandle / B3 共用，统一寿命见 `unified-lifetime.md`。
2. **两条 invoke 路由的边界**：grant 闸只在 `ControlBus.dispatch`。布局/特权 command 必须走
   ControlBus，禁止注册进默认路由的 `InMemoryTypedIpcRegistry`（声明式 hostServices），否则闸被
   绕过（见「两条 invoke 路由的硬边界」+ `architecture.md` 中 ControlBus 必经路由的硬约束）。边界在接线处写死。
3. **slot-grant replay 的 drain 时机**：renderer 订阅 vs 主进程 send 的竞态由 replay 兜底（仿
   pendingWindowCreated）。grant 在 renderer 首订阅时 drain 全队列（splice(0) 模式），按 control wc
   维度分桶，不串台到别的 wc。
