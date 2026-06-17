# 正确性契约：Compositor 事务化 commit + per-window teardown 顺序

> 范围：`@dimina-kit/electron-deck` 主进程视图编排层的两个正确性契约。本文定义
> commit 失败语义、`moveTo` 跨窗迁移事务状态机、`migrationLock` 无死锁论证、单窗口
> teardown 的确切顺序及其用 `Scope.own()` LIFO 的编码方式。
>
> 关键文件：
> - `src/main/compositor.ts` — `mount/unmount/reorder/commit/detachAll` + LIS diff + `CommitError`
> - `src/main/view-handle.ts` — `moveTo` 状态机 + `migrationLock`
> - `src/main/scope.ts` — `own/close/adopt` + 完成栅栏（completion fence）+ LIFO
> - `src/main/disposable.ts` — `DisposableRegistry.disposeAll()` LIFO + AggregateError
> - `src/internal/deck-app.ts` — **app 级** teardown：「窗口先于 registry」
>
> 基线：
> - `commit()` 是**单同步 pass**：先 `removeChildView`（removals），再按 target index
>   升序 `addChildView`（additions）。host 已毁且**有待应用工作**时抛 `CommitError`；
>   **no-op commit 不抛、不碰 host**（`compositor.ts`，pin 见 `compositor.test.ts`）。
> - app 级 teardown 的顺序先例：**先 `win.destroy()` 全部窗口，再
>   `registry.disposeAll()`**，理由是 WireTransport 在 registry 里，若窗口还活着
>   时 registry 先拆，renderer 端 teardown handler 会对已移除的 `ipcMain` handler
>   发 `__electron-deck:*`。per-window teardown 顺序是这条先例在**单窗口粒度**上的细化。

---

## 0. 术语与不变量

- **host**：一个窗口的原生 `contentView`（`ContentViewHost`）。`addChildView` /
  `removeChildView` / `isDestroyed` / `children()`（LAST = 最顶）。
- **commit pass**：一次 `commit()` 调用内对 host 的那串同步 add/remove。
- **native 顺序**：`host.children()` 的真实顺序，**唯一的物理真相**。Compositor
  的 `views: Map` 只是 **intent（target）**，commit 把 intent 投影到 native。
- **view 实例 identity**：`unmount(id)` 后 `mount(id)` 是**新实例**（新 mountSeq，
  落在 zone 顶）——不是同一个 view 续命（`compositor.ts`）。
- **window-scope**：每窗口一个 `Scope`（见 §5），`own()` 它的 anchor sink /
  wire / session / native-view-detach；`close()` 时 LIFO 释放。

不变量（贯穿全文，违反即 bug）：

- **I1（native 真相）**：任何 commit 路径结束后，`host.children()` 必须等于
  「某个一致的 target」——要么完整 new target，要么完整回滚到 pre-commit
  snapshot，**绝不停在半改状态**。
- **I2（view 单宿主）**：一个 view 实例在任一时刻只挂在 0 或 1 个 host 上，
  **绝不同时挂两个、也绝不悬空**（migration 期间是受 `migrationLock` 保护的瞬态）。
- **I3（teardown 无 use-after-free）**：window-scope 拆解期间，任何还在跑的
  publisher / observer / sink 都不得对**已开始销毁**的 host 或 win 发起调用。

---

# Compositor commit 事务化

## 问题

`commit()` 在**一个同步 pass** 里逐个 `removeChildView` / `addChildView`。
Electron **没有 contentView 事务 API**——只能逐个调。若 pass 中途某个
`addChildView` 抛（典型：目标窗口在 pass 中途被毁、或被并发 teardown 摘空），
host 的 `contentView` 已被改了一半：removals 全做了、additions 做了一部分，
**原生顺序无法靠「再抛一次」恢复**。上层拿到异常，但 native 已经是非法中间态
（违反 I1）。

现实约束：在**单个同步 pass 内**，host 调用之间没有 await，唯一能让它抛的是
**调用本身**（`addChildView` 进已毁 contentView 同步抛，spike 实证）。即 commit
内部的失败是「逐个原生调用抛」，不是「await 期间被并发改」。这把问题收窄成：
**怎样让一串可能逐个抛的同步原生调用，对外表现为 all-or-nothing（或可干净回滚的
best-effort）**。

## commit 失败语义：三个选项与裁决

| 选项 | 机制 | 优点 | 缺点 |
|---|---|---|---|
| (a) snapshot 回滚 | commit 前存 `children()` 顺序，任一步抛 → 反向重排回到 snapshot | 真 all-or-nothing 语义 | 回滚自身也调原生 add/remove，**回滚也可能抛**（host 此刻多半已毁），回滚不可靠；且把「host 已毁」当可恢复错误处理，徒增复杂度 |
| (b) 预校验后执行（preflight） | 执行任何原生调用前，先判定**这次 commit 会不会抛**，把「会抛」提前到「执行前」 | 执行阶段一旦开始就**不会因 host 已毁而中途抛**——把唯一已知失败因移到 pass 之前 | 不能防 pass 进行中**并发**把 host 毁掉（但见『问题』节：单同步 pass 内无 await，无并发窗口；跨 commit 的并发由 `migrationLock`（见『per-view migrationLock：串行化迁移 vs close』）串行化） |
| (c) best-effort + 报告 | commit 返回 `{applied, failed}`，上层（`moveTo`）决策回滚 | 灵活 | 把 native 半改态暴露给上层，每个调用点都要会处理 partial；违反「Compositor 自守 I1」 |

**裁决：以 (b) preflight 为主契约，对「单纯 host 已毁」给 all-or-nothing；
保留 (a) snapshot 回滚作为「非预期原生抛」的兜底，但仅在 pass 已动过 host 后触发，
且回滚失败只记录不再抛。** 理由：

1. commit 内**唯一可预测的失败因**是 host 已毁（spike 实证）。host 已毁是
   **commit 前就能查的状态**（`host.isDestroyed`），把它提到 pass 之前，就把「中途
   抛、半改态」这个最危险的场景**从存在变成不存在**——执行阶段不再因 host 已毁而抛。
2. 实现先 plan（算出 removals/additions），**再**检查 `isDestroyed` 才执行
   （`compositor.ts`）。即「会抛 → 在动 host 之前就抛」对**整窗已毁**这个情形成立；
   再补上「动过 host 之后才发现抛」的 snapshot 兜底。
3. (a) 作为唯一手段不可靠（回滚自身也调原生、也会抛、且回滚发生在 host 多半已毁
   之后）；(c) 把 I1 的责任甩给每个调用点，不可接受。

### commit 精确失败语义

`commit()` 的失败语义：

1. **Plan 阶段**（纯计算，不碰 host）：fold intent → target，diff 出
   `removals` / `additions`（`compositor.ts`）。
2. **空检查**：`removals` 与 `additions` 都空 → **直接 return**（no-op 不抛、不碰
   host）。**teardown 期的 no-op commit 必须静默**（与『与 commit-to-destroyed-host 防护的配合』配合）。
3. **Preflight 阶段**：有工作但 `host.isDestroyed` → **在动任何 host 之前**抛
   `CommitError{ kind:'host-destroyed', applied:false }`。`applied:false` 是**强
   保证**：native 顺序 = pre-commit snapshot（一字未动）。
4. **Apply 阶段**：先 `removeChildView` 全部 removals，再按 target index 升序
   `addChildView`。**进入此阶段前先存 `snapshot = host.children()`**。
5. **兜底回滚**（仅当 Apply 阶段某原生调用**非预期**抛——host 在 plan 后、apply 中
   被毁的窄窗口）：捕获异常 → 尝试用 snapshot 反向重排恢复 → 无论回滚成败，抛
   `CommitError{ kind:'apply-failed', applied:'partial', recovered:boolean }`。
   `recovered:true` ⇒ native = snapshot；`recovered:false` ⇒ native 半改态
   **且不可信，上层必须视该 host 为已死**（见『「源也毁」与 view 销毁归属』moveTo 状态机的「源也毁」分支）。

```
CommitError =
  | { kind: 'host-destroyed'; applied: false }                         // preflight 拦截，native 未动
  | { kind: 'apply-failed'; applied: 'partial'; recovered: true }      // 兜底回滚成功，native = snapshot
  | { kind: 'apply-failed'; applied: 'partial'; recovered: false }     // 回滚也失败，native 不可信 → host 视为死
```

> 设计取舍：**不**引入返回值 `{applied, failed}`（选项 c）。commit 成功 ⇒ `void`
> 且 native = new target；commit 失败 ⇒ **抛** `CommitError`，且异常自带「native
> 处于哪个一致态」。这让调用点（`moveTo`）只需 try/catch，不必逐调用核对 partial。

## moveTo 跨窗迁移

`moveTo` 把一个 view 从 `src` 窗口迁到 `dest` 窗口。物理上必然是**两个独立
Compositor 上的两段 commit**（每窗口一个 host）：

```
src.unmount(viewId);  src.commit();      // 从源摘下
dest.mount(viewRef);  dest.commit();     // 挂到目标
```

危险点：**`dest.commit()` 抛**（dest 窗口在两段之间被毁）。此时 view 已从 src
摘下、又没挂上 dest——**悬空**（违反 I2）。必须能**干净回滚：重挂源**。

### commit 的可回滚保证

moveTo 的回滚依赖 commit 的失败语义（『commit 精确失败语义』）兑现两点：

- `dest.commit()` 抛 `host-destroyed`（`applied:false`）：dest **native 一字未动**
  ——回滚只需在 src 上重挂，无需清理 dest。这是 preflight (b) 的直接红利：**dest
  毁 ⇒ 在动 dest host 前就抛 ⇒ dest 干净**。
- `dest.commit()` 抛 `apply-failed; recovered:true`：dest native 已回到它自己的
  pre-commit snapshot（不含本次迁入的 view）——同样**等价于 dest 干净**，回滚照常
  在 src 重挂。
- `dest.commit()` 抛 `apply-failed; recovered:false`：dest native 不可信 → 视
  dest host 已死 → 回滚时**不能也不必管 dest**（它要么会被 teardown 收走，要么本就
  在销毁）；仍在 src 重挂。

> 关键：三种 dest 失败，**对 src 回滚的动作完全一致——「在 src 重挂」**。差异只在
> 「dest 那边要不要清理」，而 (b) preflight + (a) 兜底回滚已保证「dest 那边无需
> moveTo 清理」。这就是选 (b) 而非 (c) 的回报：moveTo 的回滚逻辑**与 dest 的具体
> 失败种类解耦**。

### moveTo 事务状态机

view 实例在迁移全程的**物理位置**只可能落在三者之一：**`AT_SRC` / `AT_DEST` /
`CLOSED`**（I2 的具象）。状态机：

```
                          moveTo(viewId, src → dest)
                                    │
                           [state: AT_SRC]   ← 起点：view 挂在 src
                                    │
                  acquire migrationLock(viewId)         (见 migrationLock 节)
                                    │
            ┌───────────────────────┴───────────────────────┐
            │ STEP 1: src.unmount(viewId); src.commit()      │
            └───────────────────────┬───────────────────────┘
              src.commit() 抛?                  src.commit() ok
              ──────────────                    ──────────────
                    │                                  │
         [state: AT_SRC]  ← 源都没摘下来        [state: DETACHED]  ← 受锁保护的瞬态
         release lock; rethrow                  view 不在任何 host 上（I2 瞬态豁免）
         （迁移整体失败，幂等无副作用）                 │
                                          ┌────────────┴────────────┐
                                          │ STEP 2: dest.mount(ref); │
                                          │         dest.commit()    │
                                          └────────────┬────────────┘
                                  dest.commit() 抛?            dest.commit() ok
                                  ──────────────              ──────────────
                                        │                            │
                            ┌───────────┴──────────┐          [state: AT_DEST]
                            │ ROLLBACK: 重挂源       │          release lock
                            │ src.mount(ref)         │          ✔ 迁移成功
                            │ src.commit()           │
                            └───────────┬──────────┘
                          src 重挂 ok?            src 重挂也抛?
                          ──────────            ──────────────
                                │                      │
                        [state: AT_SRC]        [state: CLOSED]
                        release lock           src 也毁了 → close view
                        rethrow dest 的错       （dispose view 实例 + 释放其资源）
                        （干净回滚成功）          release lock; rethrow
                                               （view 无家可归，按销毁处理）
```

文字版（确切步骤）：

1. **acquire** `migrationLock(viewId)`（见『per-view migrationLock：串行化迁移 vs close』）。进入即处于 `AT_SRC`。
2. **STEP 1** `src.unmount(viewId); src.commit()`。
   - 抛 → 仍 `AT_SRC`（unmount 只改 intent，commit 没动 host 或被 preflight 拦在
     动 host 前；view 还在 src native 上）。**release lock，rethrow**。迁移整体
     无副作用失败（幂等）。
   - ok → 进入 `DETACHED`（view 不在任何 host；I2 的受锁瞬态）。
3. **STEP 2** `dest.mount(viewRef); dest.commit()`。
   - ok → `AT_DEST`。**release lock**，成功返回。
   - 抛 → 进入 **ROLLBACK**。
4. **ROLLBACK** `src.mount(viewRef); src.commit()`（把同一 ref 重挂回源；按
   `compositor.ts` 语义这是 src 上的**新实例**，落在 src 该 zone 顶——可接受，因为
   迁移失败本就不保证恢复原 z 序，只保证 view 不悬空/不丢）。
   - ok → `AT_SRC`。**release lock**，rethrow dest 的 `CommitError`（调用者知道
     迁移失败但 view 安全回家）。
   - 抛（src 此刻也毁了）→ 进入 `CLOSED`：**close 该 view 实例**（dispose 其 view
     handle / 释放它在任一 window-scope 里 own 的资源）。**release lock**，rethrow。
     view 无家可归，按销毁处理——这是物理上唯一诚实的终态。

**终态完备性**：任何路径结束时，view 物理上恰在 `AT_SRC` / `AT_DEST` / `CLOSED`
**三者之一**，绝不悬空、绝不双挂（I2）。`migrationLock` 保证全程串行，
`DETACHED` 这个「不在任何 host」的瞬态**只在持锁期间存在**，外部观察不到。

> 🧪 **需真机验证**：STEP 2 `dest.commit()` 抛后、ROLLBACK `src.commit()` 之前的
> 极窄时间内，src host 是否仍活，取决于真实销毁时序（见『待实测点』）。状态机对
> 「src 也毁」给了 `CLOSED` 兜底；这条分支的触发频率需真机压测。

## 「源也毁」与 view 销毁归属

`CLOSED` 终态要 close view 实例。本契约规定：**view 实例的资源所有权挂在它当前
所在窗口的 window-scope 上**（见 per-window teardown 顺序 + window-scope 术语）。迁移期间，view 的 own()ed 资源（它的
anchor sink、wire、native ref 持有）随 `AT_SRC→AT_DEST` 用 `Scope.adopt()`
**从 src window-scope 改宿到 dest window-scope**（`scope.ts`：adopt 不
reset/close child、资源不动、只换 cascade 归属）。这样：

- 迁移成功（`AT_DEST`）：view 的资源已 adopt 到 dest window-scope，dest 关窗时
  随之 LIFO 释放。
- 迁移失败回滚到 `AT_SRC`：view 资源仍属 src window-scope（adopt 未发生或已
  adopt-back）。
- `CLOSED`：直接 close view 子 scope，LIFO 释放其资源。

> adopt 的「等栅栏不抛」语义（`scope.ts`）天然兼容：若 src 或 dest
> window-scope 此刻正在 teardown（in-flight 栅栏），adopt 会**等栅栏完成再重校验**，
> 失败则 reject——moveTo 把该 reject 当作「目标窗口正在消失」，并入上面的 dest 抛
> 分支处理。

## per-view migrationLock：串行化迁移 vs close

### 为何需要锁

并发危险对：

- `moveTo(v, A→B)` 与 `moveTo(v, B→A)` 同时跑：两段式 unmount/mount 交错 ⇒
  view 可能双挂（B 的 mount 和 A 的 mount 都生效）或双摘悬空——违反 I2。
- `moveTo(v, A→B)` 与 `closeWindow(A)`（per-window teardown）同时跑：teardown 在摘 view
  时 moveTo 正在 STEP 1，native 顺序竞争。
- `moveTo(v, A→B)` 与 `closeWindow(B)` 并发：STEP 2 `dest.commit()` 与 dest
  teardown 的 detach 竞争 host。

锁粒度：**per-view（按 `viewId`）**。一个 view 同一时刻只能有一个迁移在途；
该 view 所涉的 close 路径也要尝试取同一把锁（见『无死锁论证』）。

### 锁的语义

`migrationLock(viewId)` 是一把 **per-view 异步互斥**（async mutex）：

- `acquire(viewId): Promise<release>`——FIFO 排队，拿到才进临界区。
- 临界区内做整段 moveTo（或整段 close 对该 view 的处理）。
- `release()` 后队列下一个进入。

实现复用 `Scope` 的单飞栅栏思路（`scope.ts` `inFlight` 串行）或一个极小的
`Map<viewId, Promise>` 链式排队。**不需要可重入**（moveTo 不会自递归取同 view 锁）。

### 无死锁论证

死锁需要**环形等待**：线程 T1 持锁 L1 等 L2，T2 持锁 L2 等 L1。论证本设计无环：

**关键设计约束（无环的根因）**：**moveTo 与 close 的临界区内，只持有「自己那一把
per-view 锁」，期间不再去 acquire 第二把 per-view 锁。** 即：

- `moveTo(v, …)` 的整个状态机（STEP1/STEP2/ROLLBACK）只操作 **view `v`** ——
  src/dest commit 动的是 host 的 z 序，不需要也不去取**别的 view 的** migrationLock。
- `closeWindow(W)` 的 teardown（见 per-window teardown 顺序）对窗口内每个 view `vᵢ` **逐个**取
  `migrationLock(vᵢ)`、处理完**立即 release**，**绝不同时持有两把**。即 close
  对一窗口多 view 是「取-放-取-放」的**串行**，不是「全取齐再处理」。

由此：

1. **任一时刻，任一执行流最多持有一把 per-view 锁**（持锁期间不取第二把）。
   ⇒ 不存在「持 L1 等 L2」的前提 ⇒ **等待图无边** ⇒ **不可能成环** ⇒ 无死锁。
   （这是「一次最多一把锁」的标准无死锁结论，根因是**每个临界区单锁**。）
2. 退一步，即便将来需要同时锁多 view（本契约**不允许**，但为稳健性给出全局序锁
   方案）：所有 per-view 锁按 **`viewId` 字典序**统一获取（`A < B` 永远先取 A 再
   取 B）。`moveTo(v, A→B)` 与 `moveTo(v, B→A)` 都只锁 `v` 这一把，本就不涉及多锁
   顺序；真要跨 view 锁时强制 `viewId` 升序获取 ⇒ 全序 ⇒ 无环 ⇒ 无死锁。**首选
   方案 1（每临界区单锁），方案 2 仅作未来扩展的护栏。**
3. `A→B` 与 `B→A` 同 view 并发的具体化：二者 acquire **同一把** `migrationLock(v)`
   （锁键是 viewId，与方向无关），FIFO 串行——一个跑完（落到 `AT_SRC`/`AT_DEST`/
   `CLOSED` 之一并 release），另一个才从**当时的实际物理位置**重新开始。不会交错，
   不会双挂。

> 🧪 **需真机验证**：async mutex 在 Electron 主进程事件循环里的 FIFO 公平性、以及
> 「close 逐 view 取锁」与「正在途中的 moveTo」的真实交错顺序（谁先抢到锁），需
> 真机 / 集成测验证；本文只证逻辑上无死锁、无双挂，不证调度公平性。

## 待实测点（🧪 需真机验证）

- **partial-failure 行为**：『commit 精确失败语义』STEP 5 兜底回滚（apply 中途非预期抛 → 反向
  重排）在真 Electron `contentView` 上能否真把顺序排回去，取决于「host 已部分毁」
  时 `add/removeChildView` 的真实行为（可能回滚自身也抛）。`recovered` 标志的真值
  只能真机定。
- **destroy 时序竞态**：moveTo STEP2 抛 → ROLLBACK 之间 src host 是否仍活
  （『moveTo 事务状态机』`CLOSED` 分支触发频率），是真实销毁时序问题。
- **commit 内单 pass 无并发** 这个前提（『问题』节）依赖「commit 全同步、无 await」——
  实现成立（`compositor.ts` 纯同步）。若将来 commit 引入 await（如异步 host），
  preflight (b) 不再够，需回到 snapshot 回滚 (a) 为主。**契约假设 commit 保持同步**。

---

# per-window teardown 顺序

## 单窗口关闭的三件事 + 与生产相反的风险

关闭**单个**窗口要做三件事：

1. **Compositor detach**：把该窗口所有原生 view 从其 `host.contentView` 摘下
   （`removeChildView`）。
2. **scope.close()**：LIFO 释放该 window-scope `own()` 的 view-scope / session /
   anchor sink / wire（`scope.ts` + `disposable.ts` LIFO）。
3. **`win.destroy()`**：销毁 Electron 窗口。

三个约束：

- **(a) anchor use-after-free**：renderer 端 anchor（`view-anchor.ts`）持续
  `publish(bounds)` 到正被拆的 view 的 sink。若 sink（主进程侧，对某 native view
  调 `setBounds`）在 view 已摘 / 已毁后仍被调用 ⇒ use-after-free / 抛。anchor 是
  同步 publish，主进程 sink 必须在 native view 还活着时才接受 bounds。
- **(b) scope.own 的 anchor/wire 是否需 `win` 还活着才能优雅 unsubscribe**：分两类。
  - **wire / ipcMain handler**：unsubscribe = `ipcMain.removeHandler` / 解绑
    listener，是**主进程侧操作，不依赖 win 存活**（app 级先例正是因为反过来——
    win 还活着时 registry 先拆才出问题，见 `deck-app.ts`）。所以 wire 的优雅解绑
    **不要求 win 活**，反而要求**在 win 死之前**完成（否则 renderer 还会发消息给
    已移除的 handler）。
  - **anchor sink**：sink 的「优雅」= **停止接受 publish**（dispose sink），这也
    是主进程侧操作，**不需要 win 活**；但**需要 native view 尚未被 detach/毁**
    若 sink 实现里还会去读/写该 view。结论：sink 必须**先于** native view detach
    被 dispose（停 publish），见『无 use-after-free 顺序』序。
- **(c) Compositor unmount 操作 `win.contentView`，win 毁了就抛**：
  `removeChildView` 进已毁 contentView 抛（与 commit 同源）。所以 **Compositor
  detach 必须在 `win.destroy()` 之前**。

## 无 use-after-free 顺序

```
closeWindow(W):                              依据
─────────────────────────────────────────   ─────────────────────────────────
STEP 0  停 anchor publish（dispose sinks）   约束(a)+(b-anchor)：先掐 publish 源头，
        — 让正被拆的 view 不再被写 bounds        之后任何 RO/resize tick 同步 bail
                                                 (view-anchor.ts `if(disposed) return`)
                                              ── 注：renderer 端 anchor 同步检查
                                                 disposed/present，无排队帧，掐 sink
                                                 后主进程不再收到新 bounds（I3）
─────────────────────────────────────────
STEP 1  Compositor detach 所有原生 view       约束(c)：必须在 win.destroy 之前——
        （逐个 removeChildView；win 还活着）       win 死后 contentView 操作抛
                                              ── 用 commit 的 host-destroyed preflight：
                                                 若 host 已毁则 commit 静默 no-op
                                                 （见防护配合节），不抛
─────────────────────────────────────────
STEP 2  解绑 wire / ipcMain handler           约束(b-wire)：必须在 win.destroy 之前，
        （registry/scope 内的 wire 资源）          否则 renderer teardown handler 打到
                                                 已移除的 handler（deck-app.ts
                                                 app 级先例，此处单窗口细化）
─────────────────────────────────────────
STEP 3  释放该 view 在 scope 里的其余资源       LIFO，承 scope.close 语义
        （session / 子 view-scope / 其他）
─────────────────────────────────────────
STEP 4  win.destroy()                         最后——前面所有「需要 win 活 / 需要
                                                 native view 在」的操作都已完成
─────────────────────────────────────────
```

**合并表述**：`停 anchor publish → Compositor detach 所有原生 view → 解绑 wire →
scope LIFO 释放其余 → 最后 win.destroy()`。

要点：

- **STEP 0–3 全部在 `win` 仍存活时做**，`win.destroy()` 是**最后一步**。这与 app
  级「窗口先于 registry」**并不矛盾**：app 级先例的本质是「**wire/registry 必须在
  renderer 还能发消息的窗口存在期内、但要在窗口被销毁前解绑好**」。app 级因为是
  一把梭销毁所有窗口，写成「先 destroy 窗口再 disposeAll registry」——但那条之所以
  安全，是因为 `win.destroy()` 让 renderer 先消失、**之后**才拆 registry。单窗口
  粒度下我们做得更细：**先停 publish（STEP0）→ 摘 native（STEP1）→ 解绑 wire
  （STEP2）→ 最后才 destroy（STEP4）**。等价的安全性来源相同：**renderer 不会对
  已移除的 wire handler 发消息**——因为 STEP4 destroy 让 renderer 消失，发生在
  STEP2 解绑 wire 之后；而 anchor 已在 STEP0 掐死，不会在 STEP1 摘 native 后还写
  bounds。
- **为什么 STEP1 detach 先于 STEP2 解绑 wire**：detach 需要 `win.contentView`
  活（约束 c），与 wire 解绑互不依赖；把 detach 排在 wire 之前还是之后都安全，
  本契约选 detach→wire，使「需要 native view 在场」的操作集中在最前、尽早完成。

## 与 commit-to-destroyed-host 防护的配合

teardown 路径里调的 Compositor commit/detach（STEP1）**绝不能抛**，否则 teardown
半途崩、win 漏销毁、scope 漏释放。契约约束：

- **STEP1 的 detach 走 commit 的 preflight 语义**：teardown 时若 host 已毁
  （`host.isDestroyed`）且本来要 removeChildView ⇒ 『commit 精确失败语义』第 2 步「**no-op commit
  不抛、不碰 host**」覆盖此情形——但前提是 detach 后的 target 为空时 diff 算出
  「无 add、有 remove」。这里要**特别处理**：host 已毁时，removals 也无意义
  （view 随 contentView 一起没了），应**在 preflight 把「host 已毁 + 仅 removals」
  判为 no-op 静默返回**，而非抛 `host-destroyed`。

  > 即：『commit 精确失败语义』第 3 步「有工作 + host 已毁 → 抛 host-destroyed」要**例外**：当
  > 工作**只有 removals 且 host 已毁**时，物理上 view 已不存在，**视为已 detach 完成
  > → 静默 return**，不抛。仅当工作含 additions（要往已毁 host 加 view）时才抛。
  > 这条例外**专为 teardown 设计**：teardown 只 detach（remove），永不 add，所以
  > teardown 路径的 commit 在 host 先毁的竞态下**保证不抛**。

- **STEP4 `win.destroy()` 在 STEP1 之后**：正常路径 host 在 STEP1 时仍活，detach
  正常成功、不触发上面的例外。例外只兜底「win 在 closeWindow 启动前已被外力
  （崩溃 / OS）销毁」的竞态。

## 用 Scope.own() LIFO 编码语义序

`Scope` 的释放是 **LIFO**：`own()` **最先注册的最后跑**（`disposable.ts`
`entries.slice().reverse()`；`scope.ts` children 先于 resources，均 LIFO）。
要让运行序为 `STEP0 → STEP1 → STEP2 → STEP3`，**注册序必须反过来**：

```
创建 window-scope（每窗口一个 Scope）后，按此顺序 own()（= 释放时逆序跑）：

  ws.own(() => win.destroy())                    // 最先 own ⇒ 最后跑 = STEP4 ✔
  ws.own(disposeOtherResources)                  //                    STEP3
  ws.own(() => wire.dispose())                   //                    STEP2
  ws.own(() => compositor.detachAll(W))          //                    STEP1
  ws.own(() => anchorSink.dispose())             // 最后 own ⇒ 最先跑 = STEP0 ✔
```

即**注册顺序 = 目标运行序的逆序**。最先 `own()` 的 `win.destroy()` 因 LIFO 最后
执行；最后 `own()` 的 anchor sink dispose 最先执行。`closeWindow(W)` ≡
`ws.close()`——一次 `close()` 就按上面**确切序**跑完 STEP0→STEP4，并通过
`scope.ts` 的完成栅栏保证「`close()` 的 Promise resolve 时 teardown 真已跑完」
（`scope.ts`）。

要点与校验：

- **`win.destroy()` 必须最先 own()**，确保它最后跑。若漏了/顺序错，会在 native
  view 还没 detach（STEP1 未跑）时就 destroy，触发约束 (c) 的抛——所以这条注册
  顺序是**正确性关键**，不是风格。
- **anchor sink dispose 必须最后 own()**，确保最先跑（STEP0），先掐 publish。
- view 子作用域用 `ws.child()`：跨层 LIFO 保证「子 view-scope 整个 teardown 先于
  父 ws 直接 own 的资源」（`scope.ts`）——若 view 实例自己 own 了
  native ref / 它自己的 anchor，会在父 ws 跑到 `win.destroy()` 前先被释放，
  天然满足「STEP4 最后」。
- **与 app 级 teardown 的关系**：app 级（`deck-app.ts`）是「遍历所有窗口
  `win.destroy()` → 再 `registry.disposeAll()`」。契约规定：**per-window teardown 用上面的
  own() LIFO 编码，且 app 级 shutdown 调它**——使「窗口先于 app-registry」这条
  生产先例在该结构下自动成立（每个 ws.close() 内部 STEP2 已解绑该窗口的 wire，
  app registry 里只剩 app 级共享资源）。

## 待实测点（🧪 需真机验证）

- **STEP0 掐 sink 后是否真的再无 bounds 写入**：renderer anchor 同步检查
  `disposed`（`view-anchor.ts`），逻辑上掐 sink 即止；但**跨进程在途的 IPC
  消息**（renderer 已发、主进程未收）能否在 STEP1 detach 后才到达并打到已摘 view
  的 sink，是真机时序问题——契约要求 sink 自身在 dispose 后对迟到 bounds **幂等
  丢弃**（不依赖「不会有迟到消息」）。
- **STEP4 `win.destroy()` 与 STEP1 detach 的真实竞态**：约束 (c) 抛的精确触发
  （contentView 在 destroy 进行中、未完成时 removeChildView 的行为）只能真机定；
  防护配合节的例外是兜底。
- **完成栅栏的真异步性**：`ws.close()` 的 Promise 在所有 STEP（含可能 async 的
  sink/wire dispose）真完成后才 resolve（`scope.ts` 设计如此），但若某 STEP 的
  dispose 在真 Electron 里挂起（如 `win.destroy()` 同步但其副作用异步），栅栏的
  「真完成」边界需真机确认。

---

## 附录：契约速查

**commit 失败语义**
- no-op（无 add/无 remove）→ 静默 return，不碰 host。
- 有工作 + host 已毁 → preflight 抛 `host-destroyed{applied:false}`（native 未动）；
  **例外**：工作仅 removals 时静默 return（teardown 友好，见防护配合节）。
- apply 中途非预期抛 → snapshot 兜底回滚 → 抛 `apply-failed{recovered:bool}`。
- commit 成功 ⇒ `void` 且 native = new target。

**moveTo 状态机**：物理终态 ∈ `{AT_SRC, AT_DEST, CLOSED}`；
`DETACHED` 仅持锁瞬态；回滚动作与 dest 失败种类解耦（恒为「src 重挂」）。

**migrationLock 无死锁**：per-view 锁；每临界区**只持一把、不取
第二把** ⇒ 等待图无边 ⇒ 无环 ⇒ 无死锁。`A→B`/`B→A` 同 view 共用一把锁 FIFO 串行。

**teardown 确切序**：`停 anchor publish → Compositor detach 原生
view → 解绑 wire → scope LIFO 释放其余 → win.destroy()`。

**own() 编码**：注册序 = 运行序逆序；`win.destroy()` **最先 own**
（最后跑），anchor sink dispose **最后 own**（最先跑）。

**use-after-free 防护**：STEP0 先掐 publish；detach 在
destroy 前；teardown 路径 commit 对「host 已毁 + 仅 removals」静默不抛。
