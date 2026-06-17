# Capability 授权 + 生命周期契约

本文约定三件安全 / 寿命攸关的接口、数据形状、握手协议与不变量：**senderId 横切 + grant 闸（A5-1）**、**anchor slotToken 原子下发（A5-2）**、**tab 保活归属（B3）**。实现全部落在 `packages/electron-deck`（wire / ControlBus / scope）。安全攸关的不变量用 🔒 标注，需真机 / e2e 才能验的点用 🧪 标注。

---

## 0. 相关原语

本契约涉及的原语：

- `src/internal/wire-transport.ts`
  - `handleInvoke(senderId, senderFrame, mainFrame, rawReq)`（:210）**持有** senderId +
    frame，做了 trust 闸（:222）+ main-frame 闸（:227）。
  - 但派发到 host/simulator 时只调 `invokeHost(req.name, req.args)`（:233）/
    `invokeSimulator(...)`（:237）——**senderId 在这一步被丢弃**。🔒 这是 A5-1 的根因。
  - `WireTransportDeps.invokeHost/invokeSimulator` 签名都是 `(name, args) => Promise<JsonValue>`（:79-81）。
- `src/host/control-bus.ts`
  - `dispatch(name, args)`（:124）查 command 表后 `handler(...args)`，**无 senderWc / 无 policy 闸**。
  - 生产接线：deck-app 把 `invokeHost = (name,args) => controlBus.dispatch(name,args)`
    （见 control-bus.ts 头注 “Real wiring (Bug C)”，及 deck-app.ts:554）。
- `src/internal/trust-set.ts`
  - refcount 成员集；`isTrusted(id)` 线性扫 `wc.id`；`add(wc)` 返回一次性 Disposable。
  - 是 trust 的单一权威（默认路径），但**只回答「可不可信」，不回答「可不可调某 command」**。
- `src/main/scope.ts`
  - 嵌套寿命 + 完成栅栏；`on('reset'|'closed', cb)`（:358）= generation 边界。
  - reset = 软复用（导航/关项目），closed = 终结（关窗/销毁）。**grant 撤销要挂这两个事件。**
- `src/internal/deck-app.ts`
  - 每个受信 wc 有一个 per-wc Scope（`wcRecords`）：grant 绑它的 `on('reset'|'closed')`
    自动撤销，wc.id 复用安全。trust 成员仍由 `trustSet`（refcount）查询。
- `packages/view-anchor/src/view-anchor.ts`
  - `createPlacementAnchor(target, { visible, publish })`：renderer 侧测量 +
    `publish(Placement)`。**publish 里没有任何 slot 身份**——主进程只能靠「哪个 wc 发来的」
    认领，无法区分同一 wc 上的多个 slot，也无法防越权报别的 slot。🔒 A5-2 根因。
  - bounds 的 x/y 允许负（clampRect 只 clamp width/height ≥0，view-anchor.ts:18-28）——
    滚动跟随合法，A5-2 校验**不得**把负 x/y 当非法丢弃。

---

## A5-1：senderId 横切改造 + grant 强制闸

### A5-1.1 签名改造方案

把 wire 已持有的 sender 身份**贯穿**到 dispatch，新增一个 `InvokeCtx`：

```ts
// 新增（建议放 wire-transport.ts，host/index.ts 再导出）
export interface InvokeCtx {
  /** 发起 invoke 的 webContents id（wire 已做 trust + main-frame 闸后才到这）。 */
  readonly senderId: number
  /** 发起的帧引用，main-frame 已校验；保留给未来按 frame 细分用，可为 null。 */
  readonly senderFrame: FrameRef | null
}
```

签名改为：

```ts
// WireTransportDeps
invokeHost:      (name: string, args: readonly JsonValue[], ctx: InvokeCtx) => Promise<JsonValue>
invokeSimulator: (name: string, args: readonly JsonValue[], ctx: InvokeCtx) => Promise<JsonValue>

// ControlBus
dispatch(name: string, args: readonly JsonValue[], ctx: InvokeCtx): Promise<JsonValue>
```

`handleInvoke` 在 trust + main-frame 闸**通过之后**构造 ctx 下传（senderId 此时**必为
number**、frame 已是 main-frame，构造点天然 fail-closed）：

```ts
// wire-transport.ts handleInvoke 内，闸之后：
const ctx: InvokeCtx = { senderId, senderFrame: senderFrame ?? null }
const result = await this.deps.invokeHost(req.name, req.args, ctx)   // simulator 同理
```

### A5-1.2 确切破坏面（这是经多轮对抗加固的安全门——逐处列清）

| # | 位置 | 现状 | 改动 | 风险 |
|---|---|---|---|---|
| 1 | `wire-transport.ts:79-81` `WireTransportDeps.invokeHost/invokeSimulator` | `(name,args)` | 加第 3 参 `ctx: InvokeCtx`（**必填**） | 类型破坏，编译期全暴露 |
| 2 | `wire-transport.ts:233/237` 两条调用点 | 丢 senderId | 传 `ctx` | 低；闸已在上方，ctx 字段非空 |
| 3 | `control-bus.ts:63` `ControlBus.dispatch` 接口 | `(name,args)` | 加 `ctx` | 类型破坏 |
| 4 | `control-bus.ts:124` `dispatch` 实现 | 直接 `handler(...args)` | 闸 + 透传，见 A5-1.3 | 🔒 闸的插点 |
| 5 | `deck-app.ts:554-557` `bindWireTransport` 接线 | `invokeHost:(name,args)=>ipc.invoke(...)` | 透传 `ctx`（即使 deck-app 默认路径走 `ipc.invoke` 不用 ctx，也要把签名补齐）| 中；deck-app 用的是 `InMemoryTypedIpcRegistry` 而非 ControlBus，**两条 invoke 路由要分别改** |
| 6 | `control-bus.test.ts` / `wire-transport*.test.ts` / `round2-fix-cross-check.test.ts` 所有 fake | 调用/实现 `(name,args)` | 全部补 `ctx` 参 | 大面积但机械；见迁移策略 |
| 7 | `host/index.ts` 导出面 | 不导 `InvokeCtx` | 新增导出 | 无 |

> ⚠️ **两条 invoke 路由不是一条**：
> - **deck-app 默认路由**（deck-app.ts:554）：`invokeHost = (name,args) => this.ipc.invoke(HOST_PREFIX+name, ...args)`，走 `InMemoryTypedIpcRegistry`。
> - **ControlBus 路由**（control-bus.ts 头注的生产接线）：`invokeHost = (name,args) => controlBus.dispatch(name,args)`。
>
> grant 闸**只在 ControlBus.dispatch 里**（command 表是布局/特权 command 的唯一权威）。
> deck-app 的 `InMemoryTypedIpcRegistry` 路由（声明式 hostServices/simulatorApis）保持
> 「trusted 即可调」语义不变——它承载的是普通领域 API，不是布局特权动作。但**两条路由的
> 签名都要带 ctx**（否则编译不过 / 类型分叉），deck-app 路由只是把 ctx 收下不用。
>
> 🔒 **硬约束（建 capability 时强制的不变量）—— 布局/特权 command 必须唯一经 ControlBus**：
> grant 闸**只存在于 ControlBus.dispatch**，所以任何**布局 / 特权
> command**（`layout.*` 等驱动原生 view / 寿命 / 跨窗的动作）**必须**经 ControlBus 注册并 dispatch，
> **禁止**注册进普通 `hostServices` / `InMemoryTypedIpcRegistry`（`deck-app.ts:296-303` 注册 +
> `:554-557` 接线那条路由**没有 grant 闸**，只做 trust 闸）。特权名若误进 `InMemoryTypedIpcRegistry`
> 路由 = **grant 授权闸被完全绕过**（trusted 即可调 = 任何受信 control 层都能调，越权）。
> 这不是「需确认」，而是**建 capability 时要在接线处（`deck-app.ts:554`）写死的边界**——
> 特权名只走 ControlBus，普通领域 API 走 `InMemoryTypedIpcRegistry`，两条永不混。
> 与 `architecture.md` §4.4 的同名硬约束一致。

### A5-1.3 迁移策略：一次性改全，ctx 必填（不做可选默认）

裁决：**ctx 设为必填、一次性改全 + 改测试**，不做 `ctx?` 渐进。理由（🔒 安全门）：

- 这是安全边界。`ctx?` 可选会让**忘传 ctx 的调用点静默退化成「无 sender 上下文」**——
  正是 A5-1 要消灭的「丢 senderId」类 bug，可选默认会把它从编译错误降级成运行时漏判。
- 破坏面（上表 #1-#7）全在编译期暴露，TS 会逐处点名，无隐藏调用点。改测试是机械工作。
- ControlBus.dispatch 的闸**必须**拿到真 senderId 才能判 grant；给个 `ctx = {senderId:-1}`
  之类的兜底默认等于「默认放行/默认拒绝」二选一，两者都比「编译失败逼你传」差。

迁移顺序（一个 PR 内）：(1) 加 `InvokeCtx` 类型 + 改三处接口签名 → (2) 改两条调用点
+ 两条 deck-app 路由接线 → (3) 改全部 fake/测试补 ctx → (4) 在 ControlBus 插闸 + 加闸的
专门测试。typecheck 全绿即破坏面闭合。🧪 仍需真启 electron + e2e 验一条真实 invoke 端到端带对 senderId。

### A5-1.4 grant 强制闸（数据形状 + 确切插点）

**grant 数据形状**（per-issue，挂在窗口/会话 Scope 上）：

```ts
export interface Grant {
  /** 被授权的 sender：control-layer renderer 的 webContents。 */
  readonly senderId: number
  /** 授权边界：只能驱动这棵 Scope 子树下的 view（B3/popout 的 rehome 也以此判）。 */
  readonly scope: Scope
  /** 白名单 command 名集合（精确匹配，default-deny）。 */
  readonly commands: ReadonlySet<string>
}

// runtime 面（layout demo 已示意）：
runtime.grants.issue(controlWc, { scope, commands: ['layout.resize', ...] }): Disposable
```

**policy 接口**（ControlBus 注入，default-deny）：

```ts
export interface CapabilityPolicy {
  /** true 仅当存在一条 live grant：senderId 命中 且 name ∈ commands。 */
  allows(senderId: number, name: string): boolean
}
```

**确切插点**（control-bus.ts `dispatch`，:124-130）——在 command 表解析**之后**、
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

**新错误码**（errors / DECK_CODE 各加一处，fail-closed 序列化走现有
`serializeError` 对 `DeckRemoteError` 的保真路径，wire-transport.ts:321）：

```ts
// wire-transport.ts DECK_CODE 追加：
Forbidden: 'DECK_FORBIDDEN',
```

抛 `new DeckRemoteError(name, 'forbidden: …', 'DECK_FORBIDDEN')` → `serializeError`
保 remoteName + code → 客户端拿到 `{ ok:false, error:{ code:'DECK_FORBIDDEN' } }`。
🔒 这条路径已是现成的 fail-closed 序列化，无需新增帧逻辑。

### A5-1.5 grant 绑 Scope generation（自动撤销）

`runtime.grants.issue(wc, {scope, commands})` 内部：

1. 把 grant 加进 policy 的活跃集合（按 senderId 索引）。
2. **订阅 sender 寿命 Scope 的两个事件**自动撤：
   ```ts
   const off1 = scope.on('reset',  () => revoke(grant))   // 导航/关项目 → 旧授权失效
   const off2 = scope.on('closed', () => revoke(grant))   // 关窗/销毁 → 失效
   ```
   `revoke` = 从 policy 活跃集移除 + dispose 这两个订阅。`issue` 返回的 Disposable 也调
   `revoke`（host 手动提前撤）。
3. **wc.id 复用安全** 🔒：grant 按 `senderId` 命中。若 closed 后 wc.id 被新窗口复用，
   而 grant 未撤，新窗口会**继承旧授权**——这正是 deck-app.ts:629 `trustSet.deleteEntry`
   注释里点名的同类风险。绑 `on('closed')` 自动撤是**唯一**关掉这个洞的方式；因此
   **grant 必须挂在一个会随该 wc 销毁而 `closed` 的 Scope 上**。

**缺口（A5-1 第 3 点）**：sender 的寿命 Scope 现在**不存在**。deck-app 每个 wc 没有
per-wc Scope（寿命走 trackedWindows + `win.on('closed')`，trust 走 refcount trustSet）。
要补：

- **方案 P（推荐）**：window/view 装配时为其 control wc 建一个 Scope（即 layout demo 里
  `main.scope`），并在 `win.on('closed')`（deck-app.ts:611 `handleSubWindowClosed` /
  :426 main 'closed'）里 `void scope.close()`。导航软复用（同 wc 重新 load）时
  `scope.reset()`。`runtime.grants.issue` 默认就把 grant 挂这个 wc 的 Scope。
  - 这同时让 layout demo 的 `main.scope` / `session = main.scope.child()` 落地——
    grant 与 view 寿命统一在同一棵 Scope 树，B3 的 `scope` 也复用它。
- **方案 Q（最小）**：不引入 per-wc Scope，`issue` 接受调用方显式传入的任意 Scope
  （host 自己管 `win.on('closed')→scope.close()`）。框架不保证 wc.id 复用安全，**把这条
  安全责任甩给 host**——不推荐，因为它把 🔒 风险留在了框架外。

裁决：**采方案 P**。grant 的 wc.id-复用安全是框架级安全属性，不该外包。落地依赖
「per-wc Scope」这块地基，与 ViewHandle/B3 共用，应一并建。

🧪 需实证：navigate（reset）/ 关窗（closed）后，旧 grant 的 command 被 `DECK_FORBIDDEN`
拒；wc.id 复用场景（关一个窗再开一个拿到同 id）下新窗口**不**继承旧 grant。

---

## A5-2：anchor slotToken 原子下发

### 问题

现 `createPlacementAnchor` 的 `publish(Placement)`（view-anchor.ts:210）**不带任何 slot
身份**。主进程收到 bounds 只能靠「哪个 wc 发的」认领，无法：(a) 区分同一 control wc 上的
多个原生 view 占位（#simulator / #devtools 各一个 slot）；(b) 防一个 renderer 谎报另一个
slot 的 bounds 把别人的 view 挪走。且**无下发协议**——renderer 不知道自己该报哪个 slotId；
存在「view 已建、renderer 还没拿到身份就开始 measure」的一帧空窗。

### A5-2.1 原子下发握手协议

**核心不变量** 🔒：renderer 在**拿到该 slot 的 slotToken 之前，绝不上报 bounds**。
靠「先订阅、后由主进程 push token、再开始 measure」的握手，而非「renderer 主动猜 id」。

数据：

```ts
// 主进程为每个原生 view 创建时生成
interface SlotGrant {
  readonly viewId: string      // Compositor 的 NativeViewRef.id
  readonly slotId: string      // DOM 占位 id（'#simulator'），renderer 用来定位 target
  readonly slotToken: string   // 不可猜 nonce（crypto 随机），主进程私存 token→(viewId, 授权 wc)
}
```

握手时序（与 view 创建**原子**）：

```
主进程 runtime.view({...}).placeIn(controlWc, { anchor:'#simulator' })
  1. Compositor 分配 viewId；生成 slotToken（nonce）
  2. 主进程私表登记： token → { viewId, authorizedWcId: controlWc.id }
  3. 主进程 controlWc.send('__deck:slot-grant', { viewId, slotId, slotToken })   ← push，不等 renderer 问
  ──────────────────────────────────────────────────────────────────────────
renderer（control-layer）
  4. 启动即订阅 '__deck:slot-grant'（在任何 measure 之前）
  5. 收到 grant → 用 slotId 定位 DOM target → createPlacementAnchor(target, { ... })
  6. publish 时把 slotToken 一并带上： send('__deck:place', { slotToken, placement })
```

**保证「拿到 token 前不上报」的两条**：

- renderer 的 anchor **由 slot-grant 事件驱动创建**（步骤 4→5），不是页面 load 即创建。
  没收到 grant 就没有 anchor，自然无从 publish。
- 主进程**先 send grant、再不依赖 renderer 的 ack**——但若 renderer 订阅晚于 send（一帧
  竞态），需要 **replay**：主进程对「已发出但未被消费」的 slot-grant 做缓冲，renderer 首次
  订阅时 drain（同 deck-app 现有 `pendingWindowCreated` / `pendingLoadFailed` 的
  「late listener replay」模式，deck-app.ts:800-821）。这样无论订阅先后都不丢 grant，
  且 renderer 永远是「先有 grant 才有 anchor」。

> 因此 `createPlacementAnchor` 的 `publish` 签名要从 `(placement) => void` 演进为携带
> slotToken 的形态——**但放在 view-anchor 包之外**：view-anchor 仍是 engine-agnostic 的
> 纯测量器（publish 是注入的 sink，它不认识 token）。token 由 control-layer 的 IPC 适配层
> （`createDeckLayoutClient`，layout demo 待建）在 sink 闭包里**闭包捕获**后拼进帧。
> ✅ 这保住了 view-anchor 的「不认识 Electron / 不认识协议」契约（view-anchor.ts 头注）。

### A5-2.2 校验（哪个 wc 能报哪个 slot）

主进程收到 `{ slotToken, placement }` 的 IPC handler（trusted + main-frame 闸之上，
复用 wire 那套）再加：

```
1. 查私表： token → { viewId, authorizedWcId }；查不到 → drop（伪造/过期 token）。
2. 🔒 sender wc 匹配： event.sender.id === authorizedWcId ？否则 drop（越权：
   B 谎报 A 的 slot）。
3. placement.bounds 形状校验：
   - visible:false → 直接 detach（合法，无 bounds）。
   - visible:true → bounds.width/height 必须 ≥0；x/y 允许负（滚动跟随，
     view-anchor.ts:18-28 已说明）。**不得把负 x/y 当非法**。
4. 通过 → Compositor.setBounds(viewId, bounds) / detach。
```

token 寿命：view dispose（Scope 撤）时从私表删 token，之后该 token 报的 bounds 全 drop。

🧪 需实证：(a) 同一 control wc 两个 slot 各自只能驱动自己的 view；(b) 构造一个 trusted
wc 用别人的 slotToken 上报 → 被 drop（不挪动目标 view）；(c) 负 x/y（向上滚动）正常跟随
不被丢。

---

## B3：tab 保活归属（detach-keep-alive 的资源上界）

### 问题

tab 切换用 `Placement{ visible:false }` 的 detach-but-keep-alive 保活（不重载，保 CDP/
滚动位/JS 堆）。N 个隐藏 tab = N 个常驻 `WebContents`，**无上界**——长会话内存无限涨。

### B3.1 归属裁决：寿命策略不属于 4-primitive，归 Scope（host 显式），框架只给薄 helper

逐 primitive 论证「保活上界该不该进框架的哪一层」：

| primitive | 职责 | 能管 keep-alive 上界吗 |
|---|---|---|
| **Layout / Placement (view-anchor)** | DOM↔native 几何缝合（measure→bounds） | ❌ 只懂位置，不懂「这个 view 活了多久、多久没显示」。`visible:false` 它只发一帧 detach，不持有 WebContents 寿命。 |
| **Compositor** | z-order / mount-unmount 计划 | ❌ 只懂渲染顺序。`unmount` 已经是「这是新实例」语义（compositor.ts 头注），它不持有也不该决定 WebContents 该不该销毁。 |
| **Scope** | 嵌套寿命 + 完成栅栏 | ⚠️ **懂寿命，但不懂「久未显示」**。Scope 的 close/reset 是**结构性**触发（关窗/导航/host 调用），它没有「最近使用时间」「可见性」这类**策略**输入。 |
| **ControlBus** | RPC + event + trust | ❌ 与寿命正交。 |

结论：**「N 个隐藏 tab 的上界」是一条策略（LRU / max-N / TTL），不是任何 primitive 的固有
职责**。geometry 和 compositor 在设计上就不该碰寿命；Scope 管寿命但只认结构事件、不认
「久未显示」这种带时间/可见性输入的淘汰策略。

裁决：**保活寿命归 Scope（结构性），淘汰策略归 host（默认）**。即：

- **每个 keep-alive 的 tab view = 一个 Scope 子节点**（其 WebContents 由该 Scope `own()`）。
  关窗/关项目时随父 Scope `close`/`reset` 连带销毁——这部分**框架保证**（寿命正确性）。
- **「太多隐藏 tab 该淘汰谁」是 host 的产品决策**，框架**默认不内建 LRU**。host 在切 tab 时
  自己决定 dispose 久未用的 ViewHandle（dispose = 关掉那个 Scope 子节点 = 销毁 WebContents）。

理由：LRU 的「最近使用」「上界 N」是产品语义（哪些 tab 算「重要到要保活」因 app 而异），
塞进框架会让框架猜业务意图；而**寿命正确性**（关了就一定销毁、不泄漏）必须框架保证——
所以把寿命交 Scope、策略留 host。

### B3.2 可选 helper：`runtime.view({ keepAlive })`——取舍

给一个**opt-in、瘦**的 helper，承载「最常见的 LRU 上界」这一种策略，避免每个 host 重写：

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

取舍（**保留还是不保留这个 helper**）：

| 选项 | 优点 | 缺点 |
|---|---|---|
| **A. 不进框架，纯 host 策略** | 框架最薄，零产品语义；KISS | 每个多 tab host 重复写 LRU；易写错（漏 dispose = 泄漏） |
| **B. opt-in helper `keepAlive:{policy:'lru',max}`**（推荐） | 覆盖 90% 场景一行；寿命仍由 Scope 兜底正确；不提供则零影响 | 框架多一处「策略」代码，须克制不扩张成策略大杂烩 |
| C. 框架内建默认上界（强制） | 防泄漏最强 | ❌ 框架替 host 决定产品行为；违背「策略归 host」裁决 |

裁决：**采 B（opt-in helper），但只内建 `lru`+`max` 一种**。`keepAlive` 省略时框架**完全
不管**淘汰（回到 A 的纯 host）。这样：寿命正确性永远是框架的（Scope own WebContents）；
淘汰策略默认是 host 的，但给一个最常用的 LRU 作为一行 opt-in。不内建 TTL/其它策略——
真有需求再 host 自管或后续扩，避免 helper 变策略框架。

🧪 需实证（真机）：(a) 切到第 N+1 个 tab 时，最久未显示的隐藏 tab 的 WebContents 确被
销毁（内存回落 / `webContents.isDestroyed()`）；(b) 关窗/关项目时所有保活 tab 随 Scope
连带销毁、无泄漏；(c) 不传 `keepAlive` 时框架不主动销毁任何隐藏 tab（纯 host 管）。

---

## 附：安全攸关 / 待实证清单

🔒 **安全攸关（设计/实现必须守的不变量）**
- A5-1：ctx 必填、闸层次 `trust → main-frame → grant` 不可换序、grant 闸 default-deny。
- A5-1.5：grant 必挂会随 wc 销毁而 `closed` 的 Scope；wc.id 复用不得继承旧 grant。
- A5-2：renderer 拿到 slotToken 前不上报；token→(viewId, 授权 wc) 私表 + sender wc 匹配；
  负 x/y 合法不得丢。
- B3：keep-alive WebContents 必由 Scope `own()`，关窗/关项目连带销毁。

🧪 **需真机 / e2e 实证（不能只看 typecheck/单测）**
- A5-1：一条真实 webview→main invoke 端到端带对 senderId；navigate/关窗后旧 grant 被
  `DECK_FORBIDDEN`；wc.id 复用不继承。
- A5-2：多 slot 各自驱动；伪 token 越权被 drop；负 x/y 滚动跟随。
- B3：LRU 淘汰真销毁 WebContents；Scope 连带销毁无泄漏；无 keepAlive 时不淘汰。

## 附：最不确定的点（实现前需拍板）
1. **per-wc Scope 地基**（A5-1.5 方案 P）：grant 绑定依赖「每个 control wc 有一个会随其
   销毁而 closed 的 Scope」，而 deck-app 现在没有。这块地基与 ViewHandle/B3 共用，需先建——
   是本设计最大的前置依赖，且改动落在 deck-app 装配路径（trust/寿命当前是 refcount+trackedWindows
   两套并行，引入 per-wc Scope 要想清与它们的关系，避免三套寿命来源打架）。
2. **deck-app 默认 invoke 路由 vs ControlBus 路由**（硬约束）：
   grant 闸只在 ControlBus.dispatch。**布局/特权 command 必须走 ControlBus，禁止注册进 deck-app 的
   `InMemoryTypedIpcRegistry`（声明式 hostServices）**——否则闸被绕过（见 §A5-1.2 的 🔒 硬约束 +
   `architecture.md` §4.4）。两条路由的边界**在接线处（deck-app.ts:554）写死**：特权名只走
   ControlBus，普通领域 API 走 `InMemoryTypedIpcRegistry`。这是建 capability 时要强制守住的不变量。
3. **slot-grant replay 的 drain 时机**：renderer 订阅 vs 主进程 send 的竞态用 replay 兜底
   （仿 pendingWindowCreated），但「何时认为 grant 已被消费、可从缓冲移除」需要一个明确的
   消费信号（renderer 首订阅 drain 全队列，同现有 splice(0) 模式），实现时按 control wc
   维度分桶，别串台到别的 wc。
