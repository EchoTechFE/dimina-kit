# 统一生命周期 / 信任地基契约（B-foundation）

> 本文钉死统一寿命语义的数据结构、Scope 树形状与收敛方案。它是 ViewHandle / capability
> grant / B3 tab 保活共用的地基：每个受信 control wc 有一个会随其销毁而 `closed` 的 Scope。
>
> **当前约束**：Scope 树 / windowScope / wcScope / 同步 trust 撤销 / grant 已落地；
> **Connection 适配器化未做**——`Connection`（`connection.ts`）仍持有独立的
> `DisposableRegistry`，尚未改写成 wcScope 的适配器。下文凡描述「Connection = wcScope
> 适配器 / Connection 寿命由 wcScope 级联」的段落是**目标设计，非现状**，引用前核对
> `connection.ts`。
>
> 相关文件：`src/internal/deck-app.ts`（窗口创建 / trust / shutdown）、
> `src/internal/trust-set.ts`、`src/main/connection.ts`、`src/main/scope.ts`、
> `src/host/control-bus.ts`；契约 C = `compositor-and-teardown.md`（per-window teardown
> `STEP0→STEP4` 序 + `own()` LIFO），契约 D = `capability-and-lifecycle.md`（grant 闸）。

---

## 0. 设计目标

deck-app 现在有**三套并行寿命来源**，新 `Scope` 是第四套。四套各自维护、互不知情，
任何「关一个窗 / 导航 / quit」要同时正确触动多套，是 bug 温床（漏一套 = 泄漏或
use-after-free）。必须收敛成**一套**：

| # | 寿命来源 | 维护方式 | 位置 |
|---|---|---|---|
| 1 | `trackedWindows`（Set，窗口寿命） | `add` on 创建 / `win.on('closed')` 删 | `deck-app.ts:128, 344, 591, 617-618, 739-748` |
| 2 | `trustSet` refcount（信任集） | `_trustWebContents`(add) / `deleteEntry`(窗死直抹) | `trust-set.ts` + `deck-app.ts:279-281, 427-429, 629` |
| 3 | `Connection`（per-wc 段寿命） | `wc.once('destroyed')`→close / `reset(id)` / `own` | `connection.ts:103-194` |
| 4 | `Scope`（嵌套寿命，**新**） | `own/child/reset/close/adopt` + 完成栅栏 | `scope.ts` |

**收敛的总裁决（先给结论，后逐条论证）**：

- **一套寿命语义 = `Scope`**（嵌套 + 完成栅栏 + LIFO，是四者里唯一够表达
  「窗口 ⊃ wc ⊃ view ⊃ session」嵌套关系的）。
- **统一记录 = 一窗多 wc 的两层结构**：每窗口一条 `WindowRecord{ windowScope }`，吞掉
  `trackedWindows`；窗口可关联**多个 wc**（主控制 renderer + 可能的 toolbar/overlay
  renderer），每个 wc 一条 `WcRecord{ wcScope, leases: Set<Lease> }`，**都挂在该窗口的
  windowScope 之下**（互为兄弟）。全局 `Map<WebContents, WcRecord>` 以 **wc 对象身份**为键（§9）。
  > 原「每窗一条 record + 单数 `trustLease`」表达不了
  > 「一个窗口 trust 多个 wc」（主 renderer `deck-app.ts:353` + toolbar wc `:446` 同窗）。
  > 改成「窗口记录 + 多条 WcRecord（每 wc 一条，含 `leases: Set<Lease>`）」。
- **trustSet 不删**（仍是 `isTrusted` / fanout 的底层成员表），但**写入它的寿命**
  （何时 add、何时移除）从「手工 `add`/`deleteEntry`」改成「由 wcScope `own()` 托管」。
- **Connection 不删**（它是 `@dimina-kit/electron-deck/main` 的已发布 API，被 devtools
  **14 个 `.acquire()` 真实调用点（9 文件）**消费）：裁决为**「Connection 是 per-wc Scope
  的 wc-keyed 适配器」**——per-wc Scope 是泛化，Connection 是它的扁平 registry 门面，
  内部委托给 Scope，**对外签名一字不动**（§5）。
  > 消费点数由 21 改为 **14 处（9 文件）**。复核命令：
  > `rg '\.acquire\(' packages/devtools/src/main --glob '!*.test.ts'`。

---

## 1. 统一 Scope 树形状

### 1.1 ASCII 树

```
rootScope                       ← 进程级（app 寿命）；deck-app 持有；quit 时 close()
│  own: app-级 wire / ipcMain handler、app-级 registry 残留、trustSet 成员的
│       「框架自持」那一份（见 §4）
│
├── windowScope (主窗口)          ← 每个 BrowserWindow 一条 WindowRecord.windowScope
│   │  own: () => win.destroy()  （C/§A4.4：最先 own ⇒ LIFO 最后跑 = STEP4）
│   │
│   ├── wcScope (主控制 renderer)─┐  ← win.webContents 的寿命；WcRecord{ wcScope, leases }
│   │   │                        │    与 toolbar wcScope / viewScope 都是**兄弟**
│   │   │  own: leases (Set)      │    （不同 webContents；§2 论证 sibling）
│   │   │  own: () => wire.dispose()（C/§A4：STEP2）
│   │   │  on('reset'|'closed')   │  ← D 的 grant 挂这里自动撤（§7）
│   │   │  ── 适配为 Connection ──┘    （Connection.acquire(wc) ≡ 取此 wcScope 的门面，§5）
│   │   │
│   │   └── (导航软复用 = wcScope.reset()：换段，wcScope 对象存活，generation++)
│   │
│   ├── wcScope (toolbar renderer)    ← toolbar WebContentsView.webContents 的寿命
│   │   │                              （`deck-app.ts:446` trust 点）；另一条 WcRecord
│   │   │  own: leases (Set)          它也是控制面 renderer，与主控制 wcScope **兄弟**
│   │   └──                           （同窗、同挂 windowScope，彼此独立销毁）
│   │
│   ├── viewScope*  ────────────────  ← 每个原生 WebContentsView 一条（可多个）
│   │   │                              与各 wcScope **兄弟**（独立 webContents、
│   │   │  own: () => compositor.detach(viewId)（C/§A4：STEP1）
│   │   │  own: () => anchorSink.dispose()（C/§A4：STEP0，最后 own ⇒ 最先跑）
│   │   │  own: nativeView 持有 / B3 keep-alive 的 WebContents（D/§B3.1）
│   │   └── 随窗口死（windowScope.close 级联），也可单独 close（关一个 view）
│   │
│   └── sessionScope*  ─────────────  ← 项目会话（= 现 layout demo 的 main.scope.child）
│       │  own: 会话寿命资源（per-app-session 绑定）
│       └── 关项目 = sessionScope.close()；切项目 = reset()
│
├── windowScope (popout 窗口)      ← popout / declared window，同结构
│   └── wcScope* / viewScope* / sessionScope*  …（与主窗同形，独立子树）
│
└── windowScope (toolbar 视图所属窗) …
```

> windowScope 下挂**多个 wcScope 兄弟**（主控制 renderer +
> toolbar/overlay renderer 各一条 WcRecord），不再是「一窗一个 wcScope」。viewScope* 与
> 各 wcScope 平级兄弟。

**注**：`viewScope` 画成 windowScope 的直接子、与各 wcScope 平级；当一个 view 属于
某个会话时，可改挂 `sessionScope` 之下（`windowScope.child()` vs
`sessionScope.child()` 由 host 装配决定）。树的**结构由 host 装配时选择父 Scope**，
框架只保证「父 close → 子级联」。

### 1.2 与 C/D 的对齐

- C（§A4）的 **window-scope = 本文 windowScope**；C 的 `own()` LIFO 编码
  （`win.destroy()` 最先 own、anchor sink dispose 最后 own）落在 windowScope +
  viewScope 上，本文不重述、直接复用。
- D（§A5-1.5 方案 P）要的 **「control wc 的 Scope」= 本文 wcScope**；grant 绑
  wcScope 的 `on('reset'|'closed')`（§7）。D 附「最不确定的点 #1」点名的「per-wc Scope
  与 trustSet+trackedWindows 两套并行打架」问题，由本文 §3/§4 的收敛消解。

---

## 2. wcScope 与 viewScope 为何是**兄弟**而非父子

约定：wcScope（控制 renderer 的寿命）与 viewScope（原生 view 的寿命）是
**兄弟**——同属 windowScope，彼此不是父子。论证：

1. **不同 webContents、独立销毁**：控制 renderer 是一个 webContents（主窗的
   `win.webContents`）；每个原生 view 是另一个 webContents
   （`WebContentsView.webContents`）。一个销毁不蕴含另一个销毁——可以关掉某个原生
   view 而控制 renderer 还活着（C/§A1 的 `unmount`），也可以控制 renderer 导航
   （wcScope.reset）而原生 view 不动。若做成父子（viewScope = wcScope.child），
   **wcScope.reset() 会级联把所有 view 也拆掉**（reset 是「dispose 当前段，含子
   scope」，scope.ts:199-215 经 disposeSegment children-first），这与「导航不重建
   原生 view」相悖。

2. **都随窗口死，但通过共同父 windowScope**：两者确实都随窗口关闭而销毁——但这是
   因为它们**共享父 windowScope**，windowScope.close() 级联拆两个兄弟（LIFO，
   scope.ts:133-148），**不是**因为一个是另一个的父。共同父表达「同生共死于窗口」，
   兄弟表达「彼此独立」——正是需要的语义。

3. **生命周期事件互不串扰**：grant 绑 wcScope（控制 renderer 的 generation）；原生
   view 的 anchor sink 绑 viewScope。若父子，wcScope 的 reset 会误触 viewScope 的
   teardown（或反之），导致「导航时 grant 撤了、连带把 view 也拆了」这类越级联动。
   兄弟拓扑让两条 generation 线**正交**。

> **反例校验**：是否存在「view 必须先于 wc 死」的依赖，逼成父子？没有。view 的
> 原生 detach（C/§A4 STEP1）需要 `win.contentView` 活，而 win 由 windowScope 持有、
> 在两个兄弟都拆完后才 destroy（STEP4）——所以「先拆 view 再 destroy win」由
> **windowScope 内的 LIFO 注册序**保证（C/§A4.4），不需要 viewScope 当 wcScope 的
> 子来强加顺序。兄弟拓扑 + windowScope LIFO 已足够。

---

## 3. per-wc Scope（wcScope）的**创建时机**

裁决：**必须在 wc 被窗口系统接纳 / 信任时建，不能等 view 创建**。论证 +
确切创建点：

### 3.1 为什么不能等 view

控制 renderer 可以**没有任何原生 view**仍持有 grant / 能调特权 command（它是布局
controller，view 是它要摆的东西，不是它存在的前提）。若等到第一个 view 创建才建
wcScope，则「无 view 的控制 renderer」这段时间没有 wcScope 可挂——grant 无处绑、
关窗时无 Scope 可 close、trust 无 Scope 托管。**安全洞**：D/§A5-1.5 的 grant
wc.id-复用安全依赖「grant 挂的 Scope 随 wc 销毁而 closed」，没 wcScope 就没这个保证。

### 3.2 确切创建点：**trust 时**（= 框架接纳该 wc 进信任集的那一刻）

把 wcScope 的创建**钉在「框架决定信任这个 wc」的同一处**——现有代码里就是
`_trustWebContents(wc)` 被调用的每个点：

| 现有 trust 点 | 位置 | 新增：同点建 wcScope |
|---|---|---|
| 主窗 auto-trust | `deck-app.ts:353` `_trustWebContentsLike(main.webContents)` | 建主窗 windowScope.child() = wcScope；trustLease = wcScope.own(trustSet.add(wc)) |
| toolbar view trust | `deck-app.ts:446` | toolbar 的 webContents 也建 wcScope（它也是控制面 renderer） |
| declared / runtime window trust | `deck-app.ts:592-593` `constructWindow(...autoTrust)` | 每个 declared/runtime 窗建 windowScope + wcScope |
| `runtime.windows.trust(win)` | `deck-app.ts:865` / control-bus `trust(wc)` | host 显式 trust 一个 wc 时建/取其 wcScope |

**裁决：「trust ⟺ 有 wcScope」是不变量**。一个 wc 进信任集**当且仅当**它有一个
活的 wcScope；trustLease 由该 wcScope `own()`。这把「信任成员资格」与「寿命」绑成
一件事，消灭 trustSet 与寿命两套并行（§4）。

> **副作用**：control-bus 的 `trust(wc)`（control-bus.ts:120）当前直接
> `trustSet.add`。收敛后它要么 (a) 经 deck-app 取该 wc 的 wcScope 并 `own` lease，
> 要么 (b) 对「没有 windowScope 上下文的裸 wc」退化为旧 refcount 行为（兼容路径，§8）。
> 见 §4 的两条写入路径。

---

## 4. trust 收敛进 Scope（trustSet refcount / deleteEntry 怎么被吞掉）

### 4.1 现状两条 trust 写入 + 一条窗死清理

- **写入 A**：`_trustWebContents(wc)` → `trustSet.add(wc)`，返回一次性 Disposable
  （refcount--）。框架自持的那份「永不 dispose」（deck-app.ts:352 注释）。
- **写入 B**：host 经 `runtime.windows.trust` / control-bus `trust(wc)` 再 add 一份
  （refcount 叠加）。
- **窗死清理**：`win.on('closed')` → `trustSet.deleteEntry(wc)`（deck-app.ts:427/629）
  ——**无视 refcount 直接抹**，理由是 wc.id 复用安全 + 泄漏防护（trust-set.ts:40-44）。

### 4.2 收敛：trustLease 由 wcScope `own()`，关窗只需 `wcScope.close()`

**统一后**：

```ts
// 建 wcScope 时（§3.2 的每个 trust 点）一次性写：
const trustLease = wcScope.own(trustSet.add(wc))
//                 └ wcScope 托管这条 add 的 Disposable（refcount--）
```

- **写入**：`trustSet.add(wc)` 仍发生（trustSet 仍是 `isTrusted`/fanout 的成员表），
  但它返回的 refcount-- Disposable **交给 wcScope `own()`**。
- **移除**：不再手工 `deleteEntry`。`wcScope.close()`（关窗级联，§6）LIFO 跑所有
  own，包含这条 lease → 自动 `refcount--` → 归零 → `trustSet` 内部 `refs.delete(wc)`
  （trust-set.ts:59）。**行为等价于旧 `deleteEntry`**，但走的是正常 refcount 归零，
  不需要「无视 refcount 直接抹」的特例。

### 4.3 `deleteEntry`（无视 refcount 直抹）怎么被吞掉、为何等价

旧 `deleteEntry` 存在的唯一理由（trust-set.ts:16-23, 40-44）：窗死时**无论还剩几个
refcount**，都要把该 wc 抹掉——因为「窗口已关，残留的 add 句柄不再需要」。

收敛后这个特例**消失**，因为 refcount 的**所有持有者都被 wcScope `own()` 托管**：

- 框架自持的 lease：wcScope.own（§4.2）。
- host 经 `windows.trust` 加的 lease：也 own 到**同一个 wcScope**（§3.2 表末行 +
  §8 兼容路径）。

所以 `wcScope.close()` 一次 LIFO 就 dispose 掉**该 wc 的全部 lease**，refcount 自然
归零、自然 `refs.delete`。**没有「还剩 refcount 但要强抹」的情形**——因为不存在
「不被 wcScope own 的游离 lease」。

> **等价性证明要点**：
> 1. 旧路径：`deleteEntry` 在 `win.on('closed')` 触发，把 wc 从 `refs` 删（无视
>    count）。
> 2. 新路径：`wcScope.close()`（由窗死触发，§6）LIFO dispose 全部 lease →
>    refcount 逐个减到 0 → `refs.delete`。
> 3. 两者终态相同（`refs` 里没有该 wc）；新路径**更强**：它保证所有 lease 的
>    Disposable 也真跑了（不只是 map 删 key），避免 lease 持有者以为自己还信任。
> 4. wc.id 复用安全（trust-set.ts:21 关注点）同样满足：close 后 refs 无该 wc，
>    新窗口拿到同 wc.id 时 `isTrusted` 返回 false（trust-set.ts:64-68 按 `.id` 扫
>    live keys），不会误继承。**且** 新窗口建**新 wcScope**（新 generation，§7），
>    grant 也不继承（D/§A5-1.5）。

### 4.4 `senderPolicy.isTrusted` 怎么从 Scope 树读

**不改 `isTrusted` 的读路径**。`isTrusted(id)` 仍读 `trustSet`（trust-set.ts:64 /
deck-app.ts:543），因为 trustSet 仍是成员真相表。改变的只是**写入这张表的寿命**
（由 wcScope own 托管，§4.2）。所以：

- `wireSenderPolicy.isTrusted(id)`（deck-app.ts:543）→ `trustSet.isTrusted(id)`
  **不变**。
- 「Scope 树」与 `isTrusted` 的关系是**间接**的：wcScope 活着 ⟺ 它 own 的 trustLease
  活着 ⟺ trustSet 里有该 wc ⟺ `isTrusted` 为真。wcScope.close ⟹ lease dispose ⟹
  trustSet 删 ⟹ `isTrusted` 转假。**Scope 树是 trust 的寿命权威，trustSet 是 trust
  的查询索引**——读写分离，互不替代。

> 这样 D 的闸层次（trust → main-frame → grant，D/§A5-1.4）的第一道 `isTrusted`
> 读法**零改动**；只是「何时不再 trusted」从手工 deleteEntry 变成 wcScope 寿命驱动。

### 4.5 trust writer 封口：读写分离 `TrustIndex`（公开只读）+ 内部 writer


**问题**：`TrustSet.add` 是**公开 API**——`host/index.ts:37` 导出 `createTrustSet` /
`TrustSet`，`ControlBus.trust(wc)`（control-bus.ts:120）直接 `trustSet.add`。只要写入
门是公开的，「某处漏走 wcScope.own 直接 add 一条游离 lease」就**单靠 code review 防不住**
（违反 §3.2「trust ⟺ 有 wcScope」不变量，制造无 Scope 托管的永生 refcount → §4.3 等价性
崩、安全洞）。

**修：拆成只读索引 + 内部 writer**：

```ts
/** 公开（host/index.ts 导出）：只读查询索引。无任何写入门。 */
export interface TrustIndex {
  isTrusted(id: number): boolean
  snapshot(): readonly MinimalWebContents[]
}

/** 内部（NOT exported from /host）：唯一写入门，且只接受 owner Scope——
 *  add 必须把返回的 lease 交给传入的 wcScope own，写入与寿命托管同一处发生，
 *  无法产出游离 lease。 */
interface TrustWriter extends TrustIndex {
  /** 由 owner wcScope 调用：refcount++ 并把 lease own 进该 wcScope（§4.2）。 */
  admit(wc: MinimalWebContents, owner: Scope): Lease
}
```

- **公开面只剩 `TrustIndex`**（`isTrusted`/`snapshot`）——`host/index.ts` 导出它，
  `ControlBus` 拿它读、**不再拿 writer**。
- **`admit(wc, owner)` 不公开导出**，且签名强制传 owner Scope（lease 在内部即被
  `owner.own(...)`，调用方拿不到「不被 own 的裸 lease」）。§3.2 的每个 trust 点改调
  `admit(wc, wcScope)`；`ControlBus.trust(wc)` 改为经 deck-app 取该 wc 的 wcScope 再
  `admit`（§8 兼容路径处理「无 windowScope 上下文的裸 wc」）。
- **删公开 `deleteEntry`**：lease 全被 wcScope `own`，`wcScope.close()` 一次 LIFO 归零
  （§4.3）即等价且**更强**（保证 lease disposer 真跑），无需「无视 refcount 直抹」的
  公开逃生口。`InternalTrustSet.deleteEntry`（trust-set.ts:42-44）整个删除。

> **CI 断言（封口验收）**：旧的直接写入模式必须零命中——
> `rg 'trustSet\.add\(' packages/ --glob '!*.test.ts'` 与
> `rg '\.deleteEntry\(' packages/` 均应**无结果**（除测试 fixture）。把这两条 grep
> 接进 devtools/electron-deck 的 `verify` 门禁，防回归引入新的游离写入。

---

## 5. Connection 怎么办——**收敛裁决**

### 5.1 事实：Connection 是已发布 API、被 14 处真实消费

`@dimina-kit/electron-deck/main` 导出 `createConnectionRegistry` /
`Connection` / `ConnectionRegistry`（`src/main/index.ts`）。devtools 主进程
**14 个 `.acquire(...)` 调用点（9 文件）**（实测 grep）消费它，关键消费者：

- `services/safe-area/index.ts:83` `connections.acquire(wc).own(...)`
- `services/network-forward/index.ts:780/860` `reg.acquire(wc).own(...)`
- `ipc/bridge-router.ts:723/1358` `acquire(...).own(...)` + `:1460`
  `connections.reset(serviceWc.id)`（软复用，pool 归还前）
- `services/elements-forward` / `simulator-storage` / `render-inspect` /
  `automation` / `workbench-context` / `views/view-manager` 等。

且它有**精心设计的 `own()` vs `on('reset'|'closed')` 语义**（foundation.md §3）：
会话寿命资源 → `own()`（reset+close 都清）；wc 寿命资源 → `on('closed')`（跨会话存
活，仅 wc 真销毁才撤，如 open-in-editor）。**这套语义被生产依赖，不能丢。**

→ **不能粗暴删 Connection。**

### 5.2 裁决：**per-wc Scope 是泛化，Connection 是它的 wc-keyed 适配器**

问题：「Connection 是 Scope 的特例（per-wc Scope = Connection 泛化）还是反过来？」
——**裁决：per-wc Scope 是泛化，Connection 是特例/适配器**。论证：

| 维度 | Connection | Scope | 谁更一般 |
|---|---|---|---|
| 嵌套 | ❌ 扁平（foundation.md:26「不嵌套」） | ✅ child/adopt | **Scope** |
| 段寿命 own | ✅ | ✅ | 平 |
| reset/close | ✅（同步换段，事件在 disposeAll **开始**时 emit，connection.ts:155-173） | ✅（**完成栅栏**：事件在 disposeAll **完成**后 emit，scope.ts:199-234） | **Scope**（更强：真等拆完） |
| 键 | `wc.id`（registry 维护 Map） | 无键（裸寿命段） | Connection 多一层 wc-keying |
| 终端钩子 | `wc.once('destroyed')` 自动 close | 无（由持有者显式 close） | Connection 多一层 wc-绑定 |

Connection = **Scope + wc.id keying + `wc.once('destroyed')` 自动 close**。即
Connection 是「绑了 webContents 的 Scope」+「按 id 索引的 registry」。所以：

> **per-wc Scope（wcScope）是底层泛化；`Connection` 重新实现为它的适配器**：
> `ConnectionRegistry.acquire(wc)` 内部对每个 `wc.id` 持有一个 wcScope（即 §1 树里
> 那个 wcScope），并在其上挂 `wc.once('destroyed') → wcScope.close()` 钩子；
> `Connection.own/on/reset/close` **委托**给该 wcScope。**对外签名一字不动。**

### 5.3 语义对齐的**两个必须保**（否则破坏 14 处消费）

1. **事件 emit 时机**：Connection 现在 `'reset'`/`'closed'` 在 disposeAll **开始**时
   emit（connection.ts:164/172，foundation.md:100 明确「监听者不应假设此刻已拆净」）；
   Scope 在 disposeAll **完成**后 emit（完成栅栏，scope.ts:199-234）。**这是行为差异。**
   - **裁决**：适配层保留 **Connection 的「开始时 emit」语义**（向后兼容 devtools
     现有监听者的假设）。实现上适配器**不直接转发 wcScope 的 reset/closed 事件**，
     而是用 wcScope 做寿命载体、自己 emit（保持 Connection 旧时机）。**不强迫 devtools
     改成等栅栏**——那是 C 的 teardown 才需要的强保证，Connection 消费者按旧契约写的。
   - > emit 的**确切时序**必须是「**先同步更新适配器
     > 状态 → 再调 Scope → 立即 emit**」，对齐旧 `connection.ts:161-172` 的
     > 「**先换段 / 标死 / 注销 registry，再 emit**」（reset：`segment = newSegment()`
     > 换段后 emit；close：`alive=false` + `byId.delete(id)` 后 emit）。**不是**在
     > reset/close 的「入口」一进来就 emit——那会让监听者在适配器状态尚未更新（旧段未
     > 换、`alive` 未翻、registry 未注销）时收到事件，看到不一致的中间态。正确序：
     > ① 同步翻适配器状态（换段/标死/de-register）→ ② 调 `wcScope.reset()/close()`
     > 启动异步 disposeAll（不 await）→ ③ 立即 emit。三步同步连续，emit 落在状态已更新
     > 之后、disposeAll 完成之前（= 旧「开始时 emit」时机）。
   - 框架内部（C 的 per-window teardown）若需要「真等拆完」，用 wcScope 自己的
     `close()` Promise（完成栅栏），**不经 Connection 门面**。两套时机各取所需：
     Connection 门面 = 旧「开始时 emit」（兼容），wcScope 直用 = 新「完成时 emit」（C 用）。

2. **`reset(id)` 的 registry 入口**：bridge-router 调 `connections.reset(serviceWc.id)`
   （:1460，pool 软复用）。适配后 = registry 按 id 找 wcScope → `wcScope.reset()`。
   wcScope.reset 的完成栅栏不影响 bridge-router（它调完即把窗还 pool，不 await）——但
   适配层要保证 `reset` 的**同步换段**语义（foundation.md:96「返回后新段就绪」）。
   scope.ts 的 reset **同步换段**（scope.ts:200-201 先 `segment = newSegment()` 再
   async dispose 旧段），✅ 满足。

### 5.3.3 外部级联缺口（致命）——`wcScope.close()` 必须经 `own` 接回 Connection


**问题**：wcScope 不止被 Connection 门面驱动（`wc.once('destroyed')` / registry
`close`），还会被**外部**驱动——`windowScope.close()` 级联调子 `wcScope.close()`
（scope.ts:133-147 disposeSegment children-first）。若 Connection 适配器只在「自己的
入口」同步 emit、而**不转发 wcScope 自身的事件**（§5.3.1 的兼容方案正是「不直接转发
wcScope 事件」），那么这条**外部级联**路径**不会**注销 Connection / 翻 `alive` /
fire `'closed'`——Connection 变成挂在已拆 wcScope 上的僵尸，registry 仍持其条目，
监听者收不到 `'closed'`。

**修**：适配器必须把注销逻辑**经 `wcScope.own()` 接到 wcScope 的拆除链**上——

```
wcScope.own(() => {
  // wcScope 拆除时（无论谁触发：destroyed / registry.close / windowScope 级联）
  // 同步跑 Connection 自己的注销：alive=false、byId.delete(id)、emit('closed')。
  // 这是「让 wcScope.close 一定带动 Connection 注销」的唯一可靠接缝。
})
```

这样**任意**触发 wcScope.close 的路径（含 windowScope 级联）都经其 own 的 disposer
跑 Connection 注销——级联接上，不再有「外部 close 绕过门面」的僵尸。

> **纪律**：禁止绕过控制器直接对 wcScope 关联的资源 close（只能 close wcScope 本体，
> 让 own 的 disposer 统一注销）。若实现侧需要「拆前」介入，给 wcScope 一个显式
> `beforeClose` 钩子，**不要**让消费者直接拆 Connection 内部段。

### 5.4 收敛映射：Connection 内部从「自管段」改「委托 wcScope」

```
旧 connection.ts build(wc)：自持 `let segment = new DisposableRegistry()` + 自管
  reset/close + wc.once('destroyed')。

新（适配器）：
  acquire(wc):
    existing? → 返回门面
    wc.isDestroyed()? → dead connection（不变，connection.ts:86-101 逻辑保留）
    否则：
      wcScope = <取/建该 wc 的 wcScope>          // §1 树里那个，由 deck-app 装配持有
      wc.once('destroyed') → wcScope.close()      // 终端钩子不变（硬销毁触发）
      // ⚠️ 外部级联接缝（§5.3.3）：让 ANY wcScope.close（含 windowScope 级联）
      //    都带动 Connection 注销 + emit，而非只在门面入口同步 emit。
      wcScope.own(() => { alive = false; byId.delete(id); emit('closed') })
      门面.own(d)   = wcScope.own(d)
      门面.on(ev,cb)= <适配层自己的 reset/closed 监听集，旧 emit 时机>（见 §5.3.1）
      门面.reset/close（registry 驱动）= wcScope.reset()/close() + 同步 emit
```

> **去重**：registry 驱动的 `close`（门面入口）已同步 emit `'closed'`（保旧时机，
> §5.3.1）；wcScope.own 的 disposer 也会 emit。两条路径用 `alive` 守卫**幂等**
> （第二次 emit 被 `if (!alive) return` 吞掉，与 connection.ts:169 现有 `alive` 守卫
> 同构）——「门面入口先 emit、own disposer 再跑时已 dead 故 no-op」与「外部级联先跑
> own disposer emit、门面入口后到时已 dead 故 no-op」两序都恰好 emit 一次。

> **谁持有 wcScope**：树里 wcScope 由 **deck-app 装配**（§3.2）持有（windowScope.child）。
> ConnectionRegistry 在「框架已建 wcScope」时**取**它做门面；在「裸 wc、无 windowScope
> 上下文」（devtools 当前独立 new 一个 registry、不经 deck-app）时**自建**一个孤儿
> wcScope 当寿命载体——这是 §8 兼容路径的核心：**Connection 在有/无 deck-app 装配
> 两种场景都能工作**。

### 5.5 迁移影响（不破坏 14 处消费）

- devtools 的 `acquire/own/on/reset/get/all` 调用**全部不改**（签名保持）。
- 唯一可观察差异：`reset`/`closed` 事件时机——**裁决保旧时机**（§5.3.1），故无差异。
- **deck-app 与 ConnectionRegistry 的关系**：当 deck-app 装配 wcScope 后，理想终态是
  ConnectionRegistry 复用 deck-app 的 wcScope（一个 wc 一个 Scope，不是两个）。过渡期
  允许 devtools 继续 `new ConnectionRegistry()`（孤儿 wcScope），后续再把
  `DeckContext.connections` 接到 deck-app 的 wcScope 池（§8 渐进路径 P3）。

---

## 6. 三种 teardown 共用一套（接 C）

popout 窗口关 / 主窗口关 / 进程 quit，**都走 `Scope.close()` 级联**：

```
关 popout 窗：     该 popout 的 windowScope.close()
                   → LIFO: viewScope*.close → wcScope.close（trustLease 释放 §4）
                           → sessionScope*.close → 最后 win.destroy()（C/§A4.4）
                   （rootScope 不动；其它窗不动）

关主窗：           主窗 windowScope.close()（同上序）
                   → 触发 deck-app 的 app-级 shutdown（若主窗死 = app 退，配置驱动）

进程 quit：        rootScope.close()
                   → LIFO 级联所有 windowScope（每个走上面单窗序）
                   → 最后 own 的 app-级 wire/registry（rootScope 直接 own 的）
```

### 6.1 与现有 `doShutdown`「窗口先于 registry」（deck-app.ts:733）的统一

现状（deck-app.ts:721-762 `runShutdownCleanup`）：**先**遍历 `trackedWindows` 全部
`win.destroy()`，**再** `registry.disposeAll()`。理由（:733-738）：WireTransport 在
registry 里，若窗还活着时先拆 registry，renderer teardown handler 会打到已移除的
ipcMain handler。

**统一后**：`trackedWindows` 被 `Map<…, WindowRecord>` 吞掉（§2 of this doc 的
WindowRecord），「窗口先于 registry」由 **rootScope 的 own 注册序**自动成立：

```ts
// rootScope 装配（注册序 = LIFO 运行序的逆序）：
rootScope.own(() => appLevelRegistry.disposeAll())   // 最先 own ⇒ 最后跑（app registry 殿后）
// 每个 windowScope = rootScope.child()，作为 child 在 rootScope 段里，
// 按 scope.ts:133-145「children 先于 resources」LIFO ⇒ 所有 windowScope 先拆，
//                                            app-级 registry 后拆。✔
```

- C/§A4.4 已规定**单窗口内**的序（STEP0 anchor→STEP1 detach→STEP2 wire→STEP4
  destroy）由 windowScope 的 own LIFO 编码。本文补的是**跨窗口 + app 级**的序：
  rootScope 的「children（所有 windowScope）先于 resources（app registry）」天然
  复刻「窗口先于 registry」先例，**且更细**（每窗内部还有 C 的 STEP 序）。
- **裁决**：`doShutdown`/`runShutdownCleanup` 的「先 destroy 全部窗、再 disposeAll」
  重构为 **`rootScope.close()`**。`beforeClose` await + timeout（deck-app.ts:721-731）
  挂成 rootScope 最先 own 的一项（最后跑？否——beforeClose 要**先**跑）。

> **`beforeClose` 的位置细节**：beforeClose 必须在**任何**拆除前跑（它是 host 的
> 「我要存盘」钩子）。所以它不进 rootScope.own（那是 LIFO 拆除项），而是
> `rootScope.close()` 的**调用方**在 `await rootScope.close()` **之前** await 它。
> 即 `doShutdown = await beforeClose(timeout) → await rootScope.close() → app.quit()`。
> 这保持 deck-app.ts:722-731 的「beforeClose 先于一切」语义。

### 6.2 quit 与 will-quit 再入（保留现有防护）

deck-app.ts:134-136/249-253/715-718 的 `quitInitiated` 防再入（will-quit 驱动的
shutdown 不得再 `app.quit()`）**不变**——它是 app/进程层的事，与 Scope 收敛正交。
rootScope.close() 完成后，`if (!quitInitiated) app.quit()` 逻辑照旧。

### 6.3 close-decision 机（keep/close）保留

deck-app.ts:386-422 的主窗 `close` 决策机（preventDefault → 问 backend keep/close
→ 只有 close 才 destroy）**不进 Scope**——它是「**要不要**关」的策略，Scope 管的是
「关**的时候怎么拆**」。决策为 'close' 后才触发 `windowScope.close()`。两者分层：
决策机在上（是否关），Scope 级联在下（怎么拆）。

---

## 7. grant 绑 generation（接 D）

D/§A5-1.5 要：grant 订阅 sender 寿命 Scope 的 `on('reset'|'closed')` 自动撤；
wc.id 复用不继承。本文把「sender 寿命 Scope」**钉死为 wcScope**：

- `runtime.grants.issue(controlWc, {scope: targetScope, commands})` 内部：
  - 取 `controlWc` 的 **wcScope**（§3 保证它存在 ⟺ controlWc 被 trust）。
  - `off1 = wcScope.on('reset',  () => revoke(grant))`  ← 导航软复用 → 旧授权失效。
  - `off2 = wcScope.on('closed', () => revoke(grant))`  ← 关窗销毁 → 失效。
- **generation 不继承**：wc 销毁 → wcScope.close（§6）→ off2 触发 → revoke。新窗口
  拿到同 wc.id → 建**新 wcScope**（§3.2 新 trust 点）→ **新 generation**，旧 grant
  早已 revoke，新 wcScope 上没有旧 grant。✔ 关掉 D/§A5-1.5 点名的 wc.id 复用洞。

> 注意 wcScope 的 reset/close 事件时机：grant 订阅的是 **wcScope 本体**的事件
> （完成栅栏语义，scope.ts:199-234），**不是** Connection 门面的「开始时 emit」
> （§5.3.1）。D 的 grant 要的是「拆干净了再认为撤销完成」吗？——revoke 只是从 policy
> 活跃集移除（同步，D/§A5-1.5 步骤），不依赖资源拆净，所以两种时机都安全；但绑
> wcScope 本体事件更直接（grant 是寿命概念，不是 Connection 的会话段概念）。

### 7.1 control-loss 策略（裁决：连带关闭 windowScope）


**问题**：控制 wc 被销毁（崩溃 / `render-process-gone`，**非**正常导航/关窗）时——
其**兄弟** viewScope（同窗的原生 view，§2 兄弟拓扑）该怎么办？两条路：

- **(A) 冻结 viewScope**：保留最后一次 bounds、拒绝新布局命令、等控制层重建（新
  generation 重放）后恢复。
- **(B) 连带关闭 windowScope**：控制层没了，整窗 windowScope.close 级联拆掉 viewScope。

**裁决：(B) 连带关闭 windowScope。** 论证：

1. **本契约的兄弟拓扑只表达「彼此独立销毁」，不表达「一方死另一方续命」**——
   viewScope 没有自己的控制源，它的 bounds/layout **全部**来自控制 renderer 下发的
   命令。控制 wc 一死，viewScope 进入「无人驾驶」：(A) 的「冻结+重放」需要一套
   **generation 重放协议**（谁存最后命令、新控制层如何认领旧 view、bounds 漂移如何
   对账），这套协议本契约**没有**、也不在地基范围内。无协议的「冻结」= 一个挂在死控制
   层上、永远拒新命令的僵尸 view。
2. **与 §3.1「控制 renderer 是 view 存在的前提」一致**：view 是控制层要摆的东西，
   控制层是 view 的存在前提。前提没了，被摆的东西随之拆，语义自洽。
3. **崩溃恢复 = 重建窗口（新 windowScope + 新 wcScope + 新 generation）**，而非
   原地复活旧 view——这与 §7「wc.id 复用建新 wcScope、不继承旧 generation」同构，
   实现上只有「整窗重建」一条路径，没有「半死窗口续命」的特例。

**触发点**：connection.ts:175-179 现在只听 `wc.once('destroyed')`（硬销毁）。
control-loss 还需覆盖**崩溃**——监听 `render-process-gone`（控制 wc 的 webContents）
→ 触发该 wc 所属窗口的 `windowScope.close()`（与正常关窗同一条级联，§6）。
> **注意区分**：`destroyed` 是 wcScope 自己的终端钩子（§5.4）；`render-process-gone`
> 是**控制层崩溃**，要上抛到 **windowScope.close**（拆整窗），不是只 close 该 wcScope
> （只 close wcScope 会留下被冻结的兄弟 viewScope —— 正是 (A) 的僵尸态，已被否决）。

> **范围**：此裁决针对**主控制 wc**（驱动该窗布局的那个 renderer）崩溃。toolbar/overlay
> 等**非主控制** wc 崩溃不连带关窗——它们的 wcScope 各自 close（§5.3.3 级联注销其
> Connection），窗口与主控制层不受影响。

---

## 8. 拆 `targetScope` vs `senderScope`（接 D）

D/§A5-1.4 的 `Grant.scope` 一个字段同时承担**两件不同的事**，必须拆成两个字段：

```ts
export interface Grant {
  readonly senderId: number
  /** ① 授权目标：grant 能驱动哪棵 Scope 子树下的 view（B3/popout rehome 以此判边界）。
   *  这是「能动谁」——通常是某 windowScope / sessionScope / viewScope 子树。 */
  readonly targetScope: Scope
  /** ② sender 寿命：grant 绑谁的命、随谁的 reset/closed 自动撤（§7）。
   *  这是 control wc 的 wcScope——「grant 活多久」。 */
  readonly senderScope: Scope          // = controlWc 的 wcScope
  readonly commands: ReadonlySet<string>
}
```

- **targetScope**（「能动哪棵子树」）≠ **senderScope**（「grant 绑谁的命」）。典型：
  一个主窗控制 renderer（senderScope = 主窗 wcScope）被授权驱动 **某个 popout 的
  viewScope 子树**（targetScope = popout 的 viewScope）。两者是**不同 webContents、
  不同子树**——用同名字段会让人误以为 grant 撤销跟随 target 寿命（错：应跟随
  sender 寿命）。
- **撤销绑 senderScope**（§7 的 off1/off2 挂 senderScope）；**边界判 targetScope**
  （dispatch 时判「command 要动的 view 是否在 targetScope 子树内」）。
- D 实现时把 §A5-1.4 的 `scope` 字段一拆为二，`issue` 签名相应变
  `issue(controlWc, { targetScope, commands })`，senderScope 由框架从 controlWc 的
  wcScope 自动填（host 不传，避免传错）。

---

## 9. 统一 `WindowRecord`（吞掉 `trackedWindows`）

### 9.1 TS 数据结构

> 原版用「每窗一条 record + 单数 `wcScope`/`trustLease`」，
> 表达不了「一个窗口 trust 多个 wc」（主 renderer `deck-app.ts:353` + toolbar wc `:446`
> 同窗）。改成**两层**：`WindowRecord{ windowScope }`（每窗一条）+ `WcRecord{ wcScope,
> leases: Set<Lease> }`（每 wc 一条，含**多条** lease），并用全局
> `Map<WebContents, WcRecord>`（**对象身份**键）索引所有受信 wc。

```ts
/** 一条 trust lease：wc 进信任集的一份 refcount-- Disposable，由其 WcRecord 的
 *  wcScope own（§4.2）。一个 wc 可被多次 trust（框架 auto-trust + host
 *  windows.trust），故 leases 是 Set。 */
type Lease = Disposable

/** 每个**受信 webContents** 一条。一个窗口可有多条（主控制 renderer + toolbar/overlay
 *  renderer），它们的 wcScope 都挂在同一窗口的 windowScope 下、互为兄弟（§2）。 */
interface WcRecord {
  /** 该 wc 的寿命：windowScope.child()。与同窗其它 wcScope / viewScope 兄弟（§2）。
   *  own: leases（§4）+ wire dispose（C/STEP2）。导航软复用 = wcScope.reset()。
   *  grant 绑其 on('reset'|'closed')（§7）。 */
  readonly wcScope: Scope
  /** 该 wc 进信任集的全部 lease（≥1）；都由 wcScope own（§4.2）。窗死 =
   *  wcScope.close → LIFO dispose 全部 lease → trustSet refcount 归零删除
   *  （等价旧 deleteEntry，§4.3）。Set 而非单数：支持「框架 auto-trust + host
   *  windows.trust 同一 wc」多份 refcount。 */
  readonly leases: Set<Lease>
}

/** 每个窗口一条。吞掉 deck-app 的 `trackedWindows: Set<MinimalBrowserWindow>`。
 *  它**不直接持** wcScope——窗口的各 wc 是 WcRegistry 里挂在 windowScope 下的兄弟。 */
interface WindowRecord {
  /** 该窗口的根寿命：rootScope.child()。close() 级联拆整窗（含其下全部 wcScope /
   *  viewScope，§6）。own: () => win.destroy()（最先 own ⇒ 最后跑，C/§A4.4）。 */
  readonly windowScope: Scope
  // 注：wcScope / viewScope* / sessionScope* 不进 WindowRecord 字段——
  //   · wcScope：每受信 wc 一条 WcRecord，由 WcRegistry（下）按 wc 索引；
  //   · viewScope* / sessionScope*：windowScope.child()/sessionScope，各创建处持句柄。
  // WindowRecord 只钉「每窗唯一」的一件：窗寿命 windowScope。
}

/** 受信 wc → WcRecord 的全局索引。键用 wc（对象身份）而非 wc.id——deck-app/devtools
 *  大量靠对象身份归属（foundation.md:129 明确「传 WebContents 句柄而非 number」）。
 *  一个窗口的多个受信 wc 都在此表，各自的 wcScope 都挂该窗 windowScope。 */
type WcRegistry = Map<MinimalWebContents, WcRecord>

/** 窗口 → WindowRecord。键同样用 wc 对象身份（该窗的「主控制 wc」是天然键）。 */
type WindowRegistry = Map<MinimalWebContents, WindowRecord>
//   ↑ 吞掉 `trackedWindows: Set<MinimalBrowserWindow>`（deck-app.ts:128）
```

> **键选 `MinimalWebContents` 还是 `windowId`**：选 **wc 对象身份**。理由：(1)
> deck-app/devtools 已大量用对象身份比较（`page.renderWc !== sender`、
> foundation.md:129）；(2) wc.id 会复用（trust-set.ts:21 关注点），对象身份不会；
> (3) Connection registry 也按 wc 索引（acquire(wc)）。WcRegistry 以**每个受信 wc**
> 的对象身份为键（主控制 wc + toolbar wc 各一条）；WindowRegistry 以该窗「主控制 wc」
> 为键。多 view 的窗口里，viewScope 的原生 view wc **不进** WcRegistry（它们不是受信
> 控制面 renderer，是 viewScope 句柄持有的被摆放对象）。

### 9.2 `trackedWindows` 的所有现用法迁移

| 现 `trackedWindows` 用法 | 位置 | 迁移到 WindowRegistry |
|---|---|---|
| `add(main)` / `add(win)` | deck-app.ts:344, 591 | 建 WindowRecord（windowScope）并 `windowRegistry.set(wc, record)`；同时为该窗每个受信 wc 建 WcRecord 入 WcRegistry（主 wc 此处；toolbar wc 在 `:446` trust 点） |
| `delete(win)`（子窗关） | deck-app.ts:618 | `registry.delete(wc)`（在 windowScope.close 的 own 里，或 closed 钩子） |
| 遍历 destroy（shutdown） | deck-app.ts:739-748 | 不再遍历 destroy；`rootScope.close()` 级联各 windowScope（每个 own 了 win.destroy） |
| `clear()` | deck-app.ts:748 | rootScope.close 后 registry 自然空（或 closed 钩子逐条 delete） |
| `runtime.windows.all()` 遍历 | deck-app.ts:858-863 | 遍历 `registry.values()` 取 windowScope 对应的 win（live 过滤同旧） |

---

## 10. 三套 → 一套：收敛映射表

| 现状寿命来源 | 现状机制 | 新归属 | 行为等价性 |
|---|---|---|---|
| **trackedWindows**（Set，窗口寿命） | `add`/`win.on('closed')→delete`/遍历 destroy | **`WindowRegistry: Map<wc, WindowRecord{windowScope}>`** + 每受信 wc 一条 **`WcRegistry: Map<wc, WcRecord{wcScope, leases}>`**（§9） | windowScope.close 级联拆其下全部 wcScope/viewScope + destroy（own 了 win.destroy）；registry.delete 在 closed 钩子。等价：每窗仍精确建/销毁一次 |
| **trustSet refcount**（成员集） | `_trustWebContents`→add / 框架自持永不 dispose | **trustSet 保留**（仍是 isTrusted/fanout 索引）；写入寿命改由各 wc 的 `wcScope.own(lease)`（lease 入 `WcRecord.leases`，§4.2） | `isTrusted` 读路径不变（§4.4）；何时不再 trusted 改由 wcScope 寿命驱动 |
| **trustSet.deleteEntry**（窗死无视 refcount 直抹） | `win.on('closed')→deleteEntry` | **删除该特例**；由 `wcScope.close()` LIFO dispose 全部 lease → refcount 归零 → refs.delete（§4.3） | 终态相同（refs 无该 wc）+ 更强（lease 持有者也被通知）；wc.id 复用安全保持 |
| **Connection**（per-wc 段寿命） | 自管 `segment` + `wc.once('destroyed')` + `reset(id)` | **改造为 wcScope 适配器**（§5）：Connection = wcScope 的 wc-keyed 门面；own/reset/close 委托 wcScope；emit 时机保旧（§5.3.1） | 14 处 `.acquire/own/on/reset` 签名不变；事件时机保「开始时 emit」兼容 |
| **Scope**（新，第四套） | own/child/reset/close/adopt + 完成栅栏 | **成为唯一寿命语义**；rootScope→windowScope→{wcScope, viewScope*, sessionScope*}（§1） | —（这是收敛目标本身） |

---

## 11. 落地状态

- **已落地**：Scope 树 / rootScope→windowScope→{wcScope, viewScope*, sessionScope*}；
  windowScope 接管 `win.destroy`、shutdown 走 `rootScope.close()`（children-first LIFO
  保证「窗口先于 registry/wire」，§6.1）；每受信 wc 建 `WcRecord{wcScope, leases}`，
  trust lease 由 wcScope `own`，trust 撤销在 `'closed'` 同步 `revokeWindowTrust`（贴合
  旧 deleteEntry 同步时机，根除 wc.id 复用提权竞态）；grant 绑 wcScope generation。
- **未落地**：**Connection 适配器化**——`connection.ts` 的 `build(wc)` 仍自管独立
  `DisposableRegistry`，尚未委托 wcScope（§5.4）。改造时需保 Connection 对外签名与
  emit 旧时机（§5.3.1）+ 经 `wcScope.own` 接回外部级联（§5.3.3），并经 14 处 `.acquire`
  消费者的 devtools 全量 e2e 验证。

## 与 C / D 的接口

- **接 C**：windowScope / viewScope 就是 C/§A4 的 window-scope，C 的 STEP0→STEP4
  `own()` LIFO 编码落在它们上；本文补「跨窗 + app 级」序 = rootScope children-first
  （§6.1），与 C 的单窗序复合。
- **接 D**：wcScope = D 要的「control wc 的 Scope」；grant 绑其 `on('reset'|'closed')`
  （§7）；`Grant` 拆 targetScope / senderScope（§8）；D 的 isTrusted 闸读 trustSet
  不变（§4.4）。

## 装配纪律（实现时守住）

1. 🔒 **trust 不留游离 lease**：trustSet 的写入门只走内部 `admit(wc, wcScope)`（§4.5），
   lease 一律由 wcScope `own`。任一处绕过 wcScope 直接写 = 永不 dispose 的 lease →
   wcScope.close 后 trustSet 仍有该 wc → isTrusted 误判真（已关窗的 wc 仍 trusted）。
2. 🔒 **wcScope / viewScope 兄弟拓扑**：viewScope 必须挂 windowScope（或 sessionScope）
   而**非** wcScope（§2）。误把 viewScope = `wcScope.child()` 会让导航（wcScope.reset）
   连带拆掉原生 view，违反「导航不重建 view」。
3. **键用对象身份**：WindowRegistry / WcRegistry 键用 wc 对象身份（§9.1），不可用 wc.id
   （会复用串台）；isTrusted / grant 按 wc.id 命中，新窗建新 wcScope/record 不继承旧
   generation（§4.3 + §7）。
