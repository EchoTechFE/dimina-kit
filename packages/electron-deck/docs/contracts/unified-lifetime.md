# 统一生命周期 / 信任地基契约

本文钉死寿命与信任的统一地基：Scope 树形状、wcScope/viewScope 兄弟拓扑、wcScope 创建时机、trust 写入收敛进 Scope、Connection 与 wcScope 的并存关系、grant 绑 generation、`WindowRecord`/`WcRecord` 数据结构、control-loss 裁决。它是一切壳（ViewHandle / capability grant / tab 保活）的地基——它们都假设「每个 control wc 有一个会随其销毁而 `closed` 的 Scope」。

关键文件：`deck-app.ts`（窗口创建 / trust / shutdown / runtime 工厂）、`trust-set.ts`（信任成员集）、`connection.ts`（per-wc `Connection` / `ConnectionRegistry`）、`scope.ts`（嵌套寿命 + 完成栅栏 + LIFO）、`control-bus.ts`（`command/event/trust` facade）。配套契约：`compositor-and-teardown.md`（per-window teardown 顺序 + `own()` LIFO）、`capability-and-lifecycle.md`（grant 闸 + slotToken + keep-alive）。

---

## 0. 一套寿命语义

寿命与信任收敛成**一套 `Scope` 语义**（嵌套 + 完成栅栏 + LIFO，唯一够表达「窗口 ⊃ wc ⊃ view ⊃ session」嵌套关系的）。否则散落成多套并行来源（窗口寿命 / 信任集 / 连接段寿命各自维护），「关一个窗 / 导航 / quit」要同时正确触动多套，漏一套 = 泄漏或 use-after-free。

总裁决：

- **统一记录 = 一窗多 wc 的两层结构**：每窗口一条 `WindowRecord{ windowScope }`；窗口可关联**多个 wc**（主控制 renderer + 可能的 toolbar/overlay renderer），每个 wc 一条 `WcRecord{ wcScope, leases: Set<Lease> }`，**都挂在该窗口的 windowScope 之下**（互为兄弟）。全局 `Map<WebContents, WcRecord>` 以 **wc 对象身份**为键（§9）。一个窗口可 trust 多个 wc（主 renderer + toolbar wc 同窗），故 `WcRecord.leases` 是 Set。
- **trustSet 保留**为 `isTrusted` / fanout 的底层成员表，但**写入它的寿命**（何时 admit、何时移除）由 wcScope `own()` 托管，不再手工增删。
- **Connection 与 wcScope 并存**：`Connection`（connection.ts）是 `@dimina-kit/electron-deck/main` 的已发布 API，是扁平的 per-wc registry（`acquire(wc)` 返回绑了 webContents 的段寿命门面），被 devtools **14 个 `.acquire()` 调用点（9 文件）**消费（复核：`rg '\.acquire\(' packages/devtools/src/main --glob '!*.test.ts'`）。wcScope 是框架的嵌套寿命原语（§1 树）。二者是并存的两套 per-wc 寿命机制：Connection 扁平、按 `wc.id` 索引、`wc.once('destroyed')` 自动 close；wcScope 嵌套、随 windowScope 级联（§5）。

---

## 1. 统一 Scope 树形状

### 1.1 ASCII 树

```
rootScope                       ← 进程级（app 寿命）；deck-app 持有；quit 时 close()
│  own: app-级 wire / ipcMain handler、app-级 registry 残留、trustSet 成员的
│       「框架自持」那一份（见 §4）
│
├── windowScope (主窗口)          ← 每个 BrowserWindow 一条 WindowRecord.windowScope
│   │  own: () => win.destroy()  （teardown 契约：最先 own ⇒ LIFO 最后跑 = STEP4）
│   │
│   ├── wcScope (主控制 renderer)─┐  ← win.webContents 的寿命；WcRecord{ wcScope, leases }
│   │   │                        │    与 toolbar wcScope / viewScope 都是**兄弟**
│   │   │  own: leases (Set)      │    （不同 webContents；§2 论证 sibling）
│   │   │  own: () => wire.dispose()（teardown 契约：STEP2）
│   │   │  on('reset'|'closed')   │  ← capability 契约的 grant 挂这里自动撤（§7）
│   │   │
│   │   └── (导航软复用 = wcScope.reset()：换段，wcScope 对象存活，generation++)
│   │
│   ├── wcScope (toolbar renderer)    ← toolbar WebContentsView.webContents 的寿命
│   │   │                              （deck-app.ts trust 点）；另一条 WcRecord
│   │   │  own: leases (Set)          它也是控制面 renderer，与主控制 wcScope **兄弟**
│   │   └──                           （同窗、同挂 windowScope，彼此独立销毁）
│   │
│   ├── viewScope*  ────────────────  ← 每个原生 WebContentsView 一条（可多个）
│   │   │                              与各 wcScope **兄弟**（独立 webContents、
│   │   │  own: () => compositor.detach(viewId)（teardown 契约：STEP1）
│   │   │  own: () => anchorSink.dispose()（teardown 契约：STEP0，最后 own ⇒ 最先跑）
│   │   │  own: nativeView 持有 / keep-alive 的 WebContents（capability 契约「保活寿命归 Scope、淘汰策略归 host」）
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

windowScope 下挂**多个 wcScope 兄弟**（主控制 renderer + toolbar/overlay renderer 各一条 WcRecord）；viewScope* 与各 wcScope 平级兄弟。

**注**：`viewScope` 画成 windowScope 的直接子、与各 wcScope 平级；当一个 view 属于
某个会话时，可改挂 `sessionScope` 之下（`windowScope.child()` vs
`sessionScope.child()` 由 host 装配决定）。树的**结构由 host 装配时选择父 Scope**，
框架只保证「父 close → 子级联」。

### 1.2 与兄弟契约的对齐

- teardown 契约（compositor-and-teardown.md）的 **window-scope = 本文 windowScope**；其
  `own()` LIFO 编码（`win.destroy()` 最先 own、anchor sink dispose 最后 own）落在
  windowScope + viewScope 上，本文不重述、直接复用。
- capability 契约（capability-and-lifecycle.md）要的 **「control wc 的 Scope」= 本文
  wcScope**；grant 绑 wcScope 的 `on('reset'|'closed')`（§7）。它点名的「per-wc Scope
  与 trustSet+trackedWindows 两套并行打架」问题，由本文 §3/§4 的收敛消解。

---

## 2. wcScope 与 viewScope 为何是**兄弟**而非父子

wcScope（控制 renderer 的寿命）与 viewScope（原生 view 的寿命）是**兄弟**——同属 windowScope，彼此不是父子。论证：

1. **不同 webContents、独立销毁**：控制 renderer 是一个 webContents（主窗的
   `win.webContents`）；每个原生 view 是另一个 webContents
   （`WebContentsView.webContents`）。一个销毁不蕴含另一个销毁——可以关掉某个原生
   view 而控制 renderer 还活着（compositor-and-teardown.md 的 `unmount`），也可以控制
   renderer 导航（wcScope.reset）而原生 view 不动。若做成父子（viewScope =
   wcScope.child），**wcScope.reset() 会级联把所有 view 也拆掉**（reset 是「dispose
   当前段，含子 scope」，scope.ts 经 disposeSegment children-first），这与「导航不重建
   原生 view」相悖。

2. **都随窗口死，但通过共同父 windowScope**：两者确实都随窗口关闭而销毁——但这是
   因为它们**共享父 windowScope**，windowScope.close() 级联拆两个兄弟（LIFO，
   scope.ts），**不是**因为一个是另一个的父。共同父表达「同生共死于窗口」，
   兄弟表达「彼此独立」——正是需要的语义。

3. **生命周期事件互不串扰**：grant 绑 wcScope（控制 renderer 的 generation）；原生
   view 的 anchor sink 绑 viewScope。若父子，wcScope 的 reset 会误触 viewScope 的
   teardown（或反之），导致「导航时 grant 撤了、连带把 view 也拆了」这类越级联动。
   兄弟拓扑让两条 generation 线**正交**。

> **反例校验**：是否存在「view 必须先于 wc 死」的依赖，逼成父子？没有。view 的
> 原生 detach（teardown 契约 STEP1）需要 `win.contentView` 活，而 win 由 windowScope
> 持有、在两个兄弟都拆完后才 destroy（STEP4）——所以「先拆 view 再 destroy win」由
> **windowScope 内的 LIFO 注册序**保证（teardown 契约），不需要 viewScope 当 wcScope 的
> 子来强加顺序。兄弟拓扑 + windowScope LIFO 已足够。

---

## 3. per-wc Scope（wcScope）的**创建时机**

wcScope **在 wc 被窗口系统接纳 / 信任时建，不在 view 创建时建**。论证 + 确切创建点：

### 3.1 为什么不能等 view

控制 renderer 可以**没有任何原生 view**仍持有 grant / 能调特权 command（它是布局
controller，view 是它要摆的东西，不是它存在的前提）。若等到第一个 view 创建才建
wcScope，则「无 view 的控制 renderer」这段时间没有 wcScope 可挂——grant 无处绑、
关窗时无 Scope 可 close、trust 无 Scope 托管。**安全洞**：capability 契约的 grant
wc.id-复用安全依赖「grant 挂的 Scope 随 wc 销毁而 closed」，没 wcScope 就没这个保证。

### 3.2 确切创建点：**trust 时**（= 框架接纳该 wc 进信任集的那一刻）

把 wcScope 的创建**钉在「框架决定信任这个 wc」的同一处**——现有代码里就是
`_trustWebContents(wc)` 被调用的每个点：

| 现有 trust 点 | 位置 | 同点建 wcScope |
|---|---|---|
| 主窗 auto-trust | `deck-app.ts` `_trustWebContentsLike(main.webContents)` | 建主窗 windowScope.child() = wcScope；trustLease = wcScope.own(trustSet.add(wc)) |
| toolbar view trust | `deck-app.ts` | toolbar 的 webContents 也建 wcScope（它也是控制面 renderer） |
| declared / runtime window trust | `deck-app.ts` `constructWindow(...autoTrust)` | 每个 declared/runtime 窗建 windowScope + wcScope |
| `runtime.windows.trust(win)` | `deck-app.ts` / control-bus `trust(wc)` | host 显式 trust 一个 wc 时建/取其 wcScope |

**裁决：「trust ⟺ 有 wcScope」是不变量**。一个 wc 进信任集**当且仅当**它有一个
活的 wcScope；trustLease 由该 wcScope `own()`。这把「信任成员资格」与「寿命」绑成
一件事，消灭 trustSet 与寿命两套并行（§4）。

> **副作用**：control-bus 的 `trust(wc)`（control-bus.ts）当前直接
> `trustSet.add`。收敛后它要么 (a) 经 deck-app 取该 wc 的 wcScope 并 `own` lease，
> 要么 (b) 对「没有 windowScope 上下文的裸 wc」退化为旧 refcount 行为（兼容路径，§8）。
> 见 §4 的两条写入路径。

---

## 4. trust 写入收敛进 Scope

### 4.1 trust 写入的两个来源

- **框架 auto-trust**：装配窗口时框架信任其 control wc（主窗 / toolbar / declared / runtime 窗）。
- **host 显式 trust**：经 `runtime.windows.trust` / `ControlBus.trust(wc)`。

两者都经唯一写入门 `trustSet.admit(wc, owner)`（§4.5），同一 wc 可被多份 lease 叠加 refcount。

### 4.2 trustLease 由 wcScope `own()`，关窗只需 `wcScope.close()`

```ts
// 建 wcScope 时（§3.2 的每个 trust 点）：
const trustLease = trustSet.admit(wc, wcScope)   // refcount++，lease refcount-- 由 wcScope own
```

- **写入**：`admit` 让 trustSet refcount++（trustSet 仍是 `isTrusted`/fanout 的成员表），它返回的 refcount-- Disposable 由 wcScope `own()` 托管。
- **移除**：无手工删除门。`wcScope.close()`（关窗级联，§6）LIFO 跑所有 own，包含这条 lease → `refcount--` → 归零 → trustSet 内部 `refs.delete(wc)`。

### 4.3 窗死清理为何等价 + 更强

trust 在窗死时必须被抹掉（窗口已关，残留 trust 不再需要，且 wc.id 复用安全要求关窗后 `isTrusted` 转假）。这由 `wcScope.close()` 的 LIFO 实现，无需「无视 refcount 直接抹」的特例——因为不存在「不被 wcScope own 的游离 lease」：框架自持的 lease 与 host `windows.trust` 加的 lease 都 own 到**同一个 wcScope**（§3.2 + §8）。

- `wcScope.close()` 一次 LIFO dispose 掉该 wc 的全部 lease → refcount 归零 → `refs.delete`。
- **更强**：保证所有 lease 的 Disposable 真跑（不只 map 删 key），避免 lease 持有者以为自己还信任。
- **wc.id 复用安全**：close 后 refs 无该 wc，新窗口拿到同 wc.id 时 `isTrusted` 返回 false（trust-set 按 `.id` 扫 live keys）；且新窗口建**新 wcScope**（新 generation，§7），grant 也不继承。

### 4.4 `senderPolicy.isTrusted` 怎么从 Scope 树读

`isTrusted(id)` 读 `trustSet`（成员真相表）。Scope 树只管**写入这张表的寿命**：

- `wireSenderPolicy.isTrusted(id)` → `trustSet.isTrusted(id)`，读路径不变。
- 「Scope 树」与 `isTrusted` 的关系是**间接**的：wcScope 活着 ⟺ 它 own 的 trustLease 活着 ⟺ trustSet 里有该 wc ⟺ `isTrusted` 为真。wcScope.close ⟹ lease dispose ⟹ trustSet 删 ⟹ `isTrusted` 转假。**Scope 树是 trust 的寿命权威，trustSet 是 trust 的查询索引**——读写分离，互不替代。

闸层次（trust → main-frame → grant，见 `capability-and-lifecycle.md`）的第一道 `isTrusted` 读法不变；「何时不再 trusted」由 wcScope 寿命驱动。

### 4.5 trust writer 封口：读写分离 `TrustIndex` + `admit`-only writer

trust 集做读写分离，封住「漏走 wcScope.own 直接写一条游离 lease」这条单靠 code review 防不住的洞（游离 lease = 无 Scope 托管的永生 refcount → §4.3 等价性崩、安全洞）：

```ts
/** 只读查询索引。无任何写入门。 */
export interface TrustIndex {
  isTrusted(id: number): boolean
  snapshot(): readonly MinimalWebContents[]
}

/** admit-capable 写集：唯一写入门 admit 强制传 owner Scope——返回的 lease
 *  refcount-- 由 owner own，写入与寿命托管同一处发生，无法产出游离 lease。 */
export interface TrustSet extends TrustIndex {
  admit(wc: MinimalWebContents, owner: Scope): Disposable
}
```

- **唯一写入门是 `admit(wc, owner)`**（trust-set.ts），强制传 owner Scope；lease 的 refcount-- 由 `owner` 托管，调用方拿不到「不被 own 的裸 lease」。§3.2 的每个 trust 点经 `admit(wc, wcScope)`；`ControlBus.trust(wc)` 经 deck-app 取该 wc 的 wcScope 再 `admit`（§8 兼容路径处理「无 windowScope 上下文的裸 wc」）。
- **无 `add` / `deleteEntry` 公开写入门**：lease 全被 wcScope `own`，`wcScope.close()` 一次 LIFO 让 refcount 归零（§4.3），既等价旧的「窗死直抹」又**更强**（保证 lease disposer 真跑），无需无视 refcount 的逃生口。

---

## 5. Connection 与 wcScope

### 5.1 Connection 是已发布 API、被 14 处真实消费

`@dimina-kit/electron-deck/main` 导出 `createConnectionRegistry` /
`Connection` / `ConnectionRegistry`（`src/main/index.ts`）。devtools 主进程
**14 个 `.acquire(...)` 调用点（9 文件）**消费它，关键消费者：

- `services/safe-area/index.ts` `connections.acquire(wc).own(...)`
- `services/network-forward/index.ts` `reg.acquire(wc).own(...)`
- `ipc/bridge-router.ts` `acquire(...).own(...)` + `connections.reset(serviceWc.id)`（软复用，pool 归还前）
- `services/elements-forward` / `simulator-storage` / `render-inspect` /
  `automation` / `workbench-context` / `views/view-manager` 等。

它有**精心设计的 `own()` vs `on('reset'|'closed')` 语义**（foundation.md §3）：
会话寿命资源 → `own()`（reset+close 都清）；wc 寿命资源 → `on('closed')`（跨会话存
活，仅 wc 真销毁才撤，如 open-in-editor）。这套语义被生产依赖。

### 5.2 Connection 与 Scope 的关系

Connection 是扁平的 per-wc registry，wcScope 是嵌套寿命原语。对照：

| 维度 | Connection | Scope | 谁更一般 |
|---|---|---|---|
| 嵌套 | ❌ 扁平（foundation.md「不嵌套」） | ✅ child/adopt | **Scope** |
| 段寿命 own | ✅ | ✅ | 平 |
| reset/close | ✅（同步换段，事件在 disposeAll **开始**时 emit，connection.ts） | ✅（**完成栅栏**：事件在 disposeAll **完成**后 emit，scope.ts） | **Scope**（更强：真等拆完） |
| 键 | `wc.id`（registry 维护 Map） | 无键（裸寿命段） | Connection 多一层 wc-keying |
| 终端钩子 | `wc.once('destroyed')` 自动 close | 无（由持有者显式 close） | Connection 多一层 wc-绑定 |

Connection ≈ 绑了 webContents 的扁平 registry（「绑了 webContents 的段寿命」+「按
id 索引的 registry」）；wcScope 是嵌套寿命原语。二者并存：Connection 按 `wc.id` 索引、
`wc.once('destroyed')` 自动 close；wcScope 随 windowScope 级联（§6），事件走完成栅栏。

---

## 6. 三种 teardown 共用一套

popout 窗口关 / 主窗口关 / 进程 quit，**都走 `Scope.close()` 级联**：

```
关 popout 窗：     该 popout 的 windowScope.close()
                   → LIFO: viewScope*.close → wcScope.close（trustLease 释放 §4）
                           → sessionScope*.close → 最后 win.destroy()（teardown 契约）
                   （rootScope 不动；其它窗不动）

关主窗：           主窗 windowScope.close()（同上序）
                   → 触发 deck-app 的 app-级 shutdown（若主窗死 = app 退，配置驱动）

进程 quit：        rootScope.close()
                   → LIFO 级联所有 windowScope（每个走上面单窗序）
                   → 最后 own 的 app-级 wire/registry（rootScope 直接 own 的）
```

### 6.1 「窗口先于 registry」由 rootScope 的 own 注册序自动成立

shutdown 走 `rootScope.close()`：WireTransport / app-级 registry 在 registry 里，若窗还活着时先拆 registry，renderer teardown handler 会打到已移除的 ipcMain handler。所以「窗口先于 registry」必须成立，由 **rootScope 的 own 注册序**编码：

```ts
// rootScope 装配（注册序 = LIFO 运行序的逆序）：
rootScope.own(() => appLevelRegistry.disposeAll())   // 最先 own ⇒ 最后跑（app registry 殿后）
// 每个 windowScope = rootScope.child()，作为 child 在 rootScope 段里，
// 按「children 先于 resources」LIFO ⇒ 所有 windowScope 先拆，app-级 registry 后拆。
```

- `compositor-and-teardown.md` 规定**单窗口内**的序（STEP0 anchor→STEP1 detach→STEP2 wire→STEP4 destroy）由 windowScope 的 own LIFO 编码。本文补的是**跨窗口 + app 级**的序：rootScope 的「children（所有 windowScope）先于 resources（app registry）」复刻「窗口先于 registry」，且每窗内部还有单窗 STEP 序。
- `beforeClose` 必须在**任何**拆除前跑（host 的「我要存盘」钩子），所以它不进 rootScope.own（那是 LIFO 拆除项），而是在 `await rootScope.close()` **之前** await：`doShutdown = await beforeClose(timeout) → await rootScope.close() → app.quit()`。

> **`beforeClose` 的位置细节**：beforeClose 必须在**任何**拆除前跑（它是 host 的
> 「我要存盘」钩子）。所以它不进 rootScope.own（那是 LIFO 拆除项），而是
> `rootScope.close()` 的**调用方**在 `await rootScope.close()` **之前** await 它。
> 即 `doShutdown = await beforeClose(timeout) → await rootScope.close() → app.quit()`。
> 这保持 deck-app.ts 的「beforeClose 先于一切」语义。

### 6.2 quit 与 will-quit 再入（保留现有防护）

deck-app.ts 的 `quitInitiated` 防再入（will-quit 驱动的
shutdown 不得再 `app.quit()`）**不变**——它是 app/进程层的事，与 Scope 收敛正交。
rootScope.close() 完成后，`if (!quitInitiated) app.quit()` 逻辑照旧。

### 6.3 close-decision 机（keep/close）保留

deck-app.ts 的主窗 `close` 决策机（preventDefault → 问 backend keep/close
→ 只有 close 才 destroy）**不进 Scope**——它是「**要不要**关」的策略，Scope 管的是
「关**的时候怎么拆**」。决策为 'close' 后才触发 `windowScope.close()`。两者分层：
决策机在上（是否关），Scope 级联在下（怎么拆）。

---

## 7. grant 绑 generation

capability 契约要：grant 订阅 sender 寿命 Scope 的 `on('reset'|'closed')` 自动撤；
wc.id 复用不继承。本文把「sender 寿命 Scope」**钉死为 wcScope**：

- `runtime.grants.issue(controlWc, {scope: targetScope, commands})` 内部：
  - 取 `controlWc` 的 **wcScope**（§3 保证它存在 ⟺ controlWc 被 trust）。
  - `off1 = wcScope.on('reset',  () => revoke(grant))`  ← 导航软复用 → 旧授权失效。
  - `off2 = wcScope.on('closed', () => revoke(grant))`  ← 关窗销毁 → 失效。
- **generation 不继承**：wc 销毁 → wcScope.close（§6）→ off2 触发 → revoke。新窗口
  拿到同 wc.id → 建**新 wcScope**（§3.2 新 trust 点）→ **新 generation**，旧 grant
  早已 revoke，新 wcScope 上没有旧 grant。✔ 关掉 capability 契约点名的 wc.id 复用洞。

> 注意 wcScope 的 reset/close 事件时机：grant 订阅的是 **wcScope 本体**的事件
> （完成栅栏语义，scope.ts），**不是** Connection 门面的「开始时 emit」（§5）。
> capability 契约的 grant 要的是「拆干净了再认为撤销完成」吗？——revoke 只是从 policy
> 活跃集移除（同步），不依赖资源拆净，所以两种时机都安全；但绑 wcScope 本体事件更直接
> （grant 是寿命概念，不是 Connection 的会话段概念）。

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

**触发点**：connection.ts 现在只听 `wc.once('destroyed')`（硬销毁）。
control-loss 还需覆盖**崩溃**——监听 `render-process-gone`（控制 wc 的 webContents）
→ 触发该 wc 所属窗口的 `windowScope.close()`（与正常关窗同一条级联，§6）。
> **注意区分**：`destroyed` 是 wcScope 自己的终端钩子；`render-process-gone`
> 是**控制层崩溃**，要上抛到 **windowScope.close**（拆整窗），不是只 close 该 wcScope
> （只 close wcScope 会留下被冻结的兄弟 viewScope —— 正是 (A) 的僵尸态，已被否决）。

> **范围**：此裁决针对**主控制 wc**（驱动该窗布局的那个 renderer）崩溃。toolbar/overlay
> 等**非主控制** wc 崩溃不连带关窗——它们的 wcScope 各自 close，窗口与主控制层不受影响。

---

## 8. 拆 `targetScope` vs `senderScope`

grant 的 scope 边界拆成两个字段，因为「能动谁」与「grant 绑谁的命」是两件不同的事：

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
- **撤销绑 senderScope**（§7 的 off1/off2 挂 senderScope）；**边界判 targetScope**（dispatch 时判「command 要动的 view 是否在 targetScope 子树内」）。
- `issue(controlWc, { targetScope, commands })` 的 senderScope 由框架从 controlWc 的 wcScope 自动填（host 不传，避免传错）。

> 当前 `runtime.grants.issue` 的 `targetScope` 可选且未被 dispatch 闸消费（无 command 解析 target view），grant 按 (senderId, command-name) 授权；targetScope 是为未来 per-target view-command 检查保留的边界。详见 `capability-and-lifecycle.md`。

---

## 9. 统一 `WindowRecord`（吞掉 `trackedWindows`）

### 9.1 TS 数据结构

两层结构：`WindowRecord{ windowScope }`（每窗一条）+ `WcRecord{ wcScope, leases: Set<Lease> }`（每受信 wc 一条，含多条 lease），全局 `Map<WebContents, WcRecord>`（对象身份键）索引所有受信 wc。一个窗口可 trust 多个 wc（主 renderer + toolbar wc 同窗）。

```ts
/** 一条 trust lease：wc 进信任集的一份 refcount-- Disposable，由其 WcRecord 的
 *  wcScope own（§4.2）。一个 wc 可被多次 trust（框架 auto-trust + host
 *  windows.trust），故 leases 是 Set。 */
type Lease = Disposable

/** 每个**受信 webContents** 一条。一个窗口可有多条（主控制 renderer + toolbar/overlay
 *  renderer），它们的 wcScope 都挂在同一窗口的 windowScope 下、互为兄弟（§2）。 */
interface WcRecord {
  /** 该 wc 的寿命：windowScope.child()。与同窗其它 wcScope / viewScope 兄弟（§2）。
   *  own: leases（§4）+ wire dispose（teardown 契约 STEP2）。导航软复用 = wcScope.reset()。
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
   *  viewScope，§6）。own: () => win.destroy()（最先 own ⇒ 最后跑，teardown 契约）。 */
  readonly windowScope: Scope
  // 注：wcScope / viewScope* / sessionScope* 不进 WindowRecord 字段——
  //   · wcScope：每受信 wc 一条 WcRecord，由 WcRegistry（下）按 wc 索引；
  //   · viewScope* / sessionScope*：windowScope.child()/sessionScope，各创建处持句柄。
  // WindowRecord 只钉「每窗唯一」的一件：窗寿命 windowScope。
}

/** 受信 wc → WcRecord 的全局索引。键用 wc（对象身份）而非 wc.id——deck-app/devtools
 *  大量靠对象身份归属（foundation.md 明确「传 WebContents 句柄而非 number」）。
 *  一个窗口的多个受信 wc 都在此表，各自的 wcScope 都挂该窗 windowScope。 */
type WcRegistry = Map<MinimalWebContents, WcRecord>

/** 窗口 → WindowRecord。键同样用 wc 对象身份（该窗的「主控制 wc」是天然键）。 */
type WindowRegistry = Map<MinimalWebContents, WindowRecord>
//   ↑ 吞掉 `trackedWindows: Set<MinimalBrowserWindow>`（deck-app.ts）
```

> **键选 `MinimalWebContents` 还是 `windowId`**：选 **wc 对象身份**。理由：(1)
> deck-app/devtools 已大量用对象身份比较（`page.renderWc !== sender`、
> foundation.md）；(2) wc.id 会复用（trust-set.ts 关注点），对象身份不会；
> (3) Connection registry 也按 wc 索引（acquire(wc)）。WcRegistry 以**每个受信 wc**
> 的对象身份为键（主控制 wc + toolbar wc 各一条）；WindowRegistry 以该窗「主控制 wc」
> 为键。多 view 的窗口里，viewScope 的原生 view wc **不进** WcRegistry（它们不是受信
> 控制面 renderer，是 viewScope 句柄持有的被摆放对象）。

### 9.2 WindowRegistry 用法

- 建窗：建 `WindowRecord{ windowScope }` 入 WindowRegistry；为该窗每个受信 wc 建 `WcRecord` 入 WcRegistry（主 wc 在建窗处，toolbar wc 在其 trust 点）。
- 子窗关：`registry.delete(wc)`（在 windowScope.close 的 own 里 / closed 钩子）。
- shutdown：`rootScope.close()` 级联各 windowScope（每个 own 了 win.destroy），不遍历 destroy。
- `runtime.windows.all()`：遍历 `registry.values()` 取 live win。

---

## 10. 寿命与信任的权威映射

| 关注点 | 寿命权威 | 查询索引 |
|---|---|---|
| **窗口寿命** | `WindowRegistry: Map<wc, WindowRecord{windowScope}>`；windowScope.close 级联拆其下全部 wcScope/viewScope，最后 win.destroy | — |
| **trust** | 各 wc 的 `wcScope.own(lease)`（lease 入 `WcRecord.leases`）；wcScope.close → lease dispose → refcount 归零 | trustSet（`isTrusted`/fanout，读路径见 §4.4） |
| **per-wc 段寿命** | Connection 自管 `DisposableRegistry`（§5） | ConnectionRegistry 按 wc 索引 |
| **嵌套寿命语义** | `Scope`：rootScope→windowScope→{wcScope, viewScope*, sessionScope*}（§1） | — |

---

## 11. 装配纪律（实现时守住）

- 🔒 **viewScope 必须挂 windowScope（或 sessionScope），不是 wcScope**（§2）。误把 `viewScope = wcScope.child()` 会让导航（wcScope.reset）连带拆掉原生 view，违反「导航不重建 view」。
- 🔒 **trust lease 不留游离**：写入只经 `admit(wc, wcScope)`（§4.5），lease 必由 wcScope own；漏改残留一份永不 dispose 的 lease → wcScope.close 后 trustSet 仍有该 wc → `isTrusted` 误判真 → 已关窗的 wc 仍 trusted。
- **键不可混用 wc.id 与对象身份**：WindowRegistry / WcRegistry 键用 wc 对象身份（§9.1，wc.id 会复用、对象身份不会）；`isTrusted` / grant 按 wc.id 命中。两者在 wc.id 复用时分叉（新窗建新 wcScope / 新 record 不继承，§4.3 + §7），但 record 键混用 wc.id 会被复用串台。

### 与兄弟契约的接口

- **compositor-and-teardown.md**：windowScope / viewScope 就是其 window-scope，其 STEP0→STEP4 own() LIFO 编码落在它们上；本文补「跨窗 + app 级」序 = rootScope children-first（§6.1）。
- **capability-and-lifecycle.md**：wcScope = 其「control wc 的 Scope」；grant 绑其 `on('reset'|'closed')`（§7）；`Grant` 的 targetScope/senderScope 拆分（§8）；isTrusted 闸读 trustSet（§4.4）。
