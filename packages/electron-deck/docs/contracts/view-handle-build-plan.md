# ViewHandle keystone — 分解建造计划（建前设计）

> 状态：**✅ as-built（本建造计划已全部实施落地于 main，见 architecture.md §5）**。下文 §0 表的「真未建」一行（line 20）与 §3.1「ControlBus 已建未接 deck-app...休眠」描述是**施工前快照、已失实**，保留作历史。
> 由 Plan 子代理从 architecture.md + layout-architecture-demo.md +
> compositor-and-teardown.md(C) + capability-and-lifecycle.md(D) + as-built 原语推导。
> ViewHandle 是把已建的 4 原语装配成干净 host API（`runtime.view({...}).placeIn(win,{zone,anchor}).moveTo(win2).dispose()`）的 per-view 编排器（keystone）。

## 0. As-built 真相（doc 标「待建」但其实已建，材料性改变计划）

| 项 | doc 状态 | **as-built** | 证据 |
|---|---|---|---|
| InvokeCtx + senderId 横切 (A5-1) | 待建 | **已建** | wire-transport.ts:61/251/255/259 |
| ControlBus grant 闸 (A5-1.4) | 待建 | **已建** | control-bus.ts:139/147 |
| CapabilityPolicy/grant 注册表 | 未建 | **已建** | host/capability.ts 全文 |
| per-wc Scope（D「最大前置」） | 不存在 | **已建** | deck-app.ts:161 wcRecords / :366 |
| runtime.grants.issue | 待建 | **已建** | deck-app.ts:1154 / types.ts:235 |
| 同步 grant 撤销(P1b/P4) | — | **已建** | deck-app.ts:856-868 |
| CommitError 事务化(A1.2.1) | 待建 | **已建** | compositor.ts:59/326-369 |
| view-anchor follow*/pulse(契约 B) | 待建 | **已建** | view-anchor.ts (增量1+2) |

**订正（as-built）**：以上均已实现并接线（见 architecture.md §5）——`ViewHandle`/`placeIn`/`moveTo`/`runtime.view`/`slotToken`/`migrationLock`/`Compositor.detachAll`/`keepAlive` LRU 均已建（view-handle.ts、deck-app.ts:1905-2335、types.ts:281-336），ControlBus 已在 deck-app 实例化并接线（deck-app.ts:1185/1206）。`Compositor.setBounds` 见 §3.2 gap#1 裁决：由 ViewHandle 自调 setBounds、Compositor 纯 z-order，故 Compositor.setBounds 不存在是设计裁决而非缺漏。
> ~~原文（已失实，保留作历史）：**真未建（grep 零）**：`ViewHandle`/`placeIn`/`moveTo`/`runtime.view`/`slotToken`/`migrationLock`/`Compositor.detachAll`/`Compositor.setBounds`/`keepAlive` LRU，且 ControlBus 从未在 deck-app 实例化/接线（wire `invokeHost` 只走 InMemoryTypedIpcRegistry，deck-app.ts:751）。~~
→ ~~能力/安全 spine 已完，缺的是 per-view 编排壳 + 两个 Compositor 方法 + slot-grant 传输 + ControlBus 消费接线。~~ **（已失实：这些后续全部建成。）**

## 1. ViewHandle 类型 + 硬边界
持有恰好三样（architecture.md:174-186）：native ref（NativeViewRef + WebContentsView）、scope-lease（某 windowScope/wcScope 下的 viewScope，own native view + anchor sink + slot-token 条目）、compositor token（当前所在窗口的 (compositor,host,windowScope)）。
公共面：`placeIn(win,{zone,anchor?,anchorRect?})→this` / `moveTo(win,{zone,anchor?,rehomeTo?})→Promise<void>` / `dispose()→Promise<void>`。
**硬边界（review 钉死，是正确性非风格）**：不算布局（几何来自 view-anchor publish，handle 只转发 Placement→setBounds/detach）；不持全局树（slot-token 私表/LRU 组归 runtime）；不决定淘汰策略（B3 LRU 是 runtime helper 调 handle.dispose）；不直碰 contentView（addChildView 经 Compositor；但 per-view setBounds 见 gap#1）。

## 2. 子增量（DAG：a→b→c, a→d；e 与 a 后并行；f 依赖 a+b。c 先于 d）
🟢=纯 electron-deck 单测可验；🧪=真需真机 e2e。

- **(a) ViewHandle 类型 + runtime.view() + placeIn** 🟢/🧪：建 handle + 工厂 + placeIn 接 Compositor(mount→commit)+Scope(viewScope under windowScope)+view-anchor(placement→bounds via 注入 publish)。**前置**：加 `Compositor.detachAll()`（折叠 intent 到空 + commit，靠 removals-only 静默）；setBounds 见 gap#1。**最大风险=「per-window Compositor 不存在」+ 无 view 的 WebContentsView 创建处（只有 toolbar）→ (a) 实为「立起 per-window 原生 view 底座」非薄壳**〔订正：该底座已建成，每窗口 deck-app.ts:833 各 createCompositor〕。文件：新 src/main/view-handle.ts、compositor.ts(detachAll)、deck-app.ts(buildRuntime:1096 加 view: + 每 windowScope own createCompositor(win.contentView))、types.ts。🧪=真 setBounds 在真机随 DOM anchor 跟随。
- **(b) dispose()=close viewScope（单 view A4 序）** 🟢：viewScope.own 顺序（A4.4 LIFO 子集）= own(detach via unmount+commit) 先（跑最后）、own(anchorSink.dispose) 后（跑最先=STEP0 停 publish）。**风险=sink 迟到 IPC 幂等（A5.5）**：renderer 可能已发 in-flight place，handle sink 必须对 disposed handle 丢 bounds（view-anchor 只守自己的 emit 不守跨进程 sink）。
- **(c) per-window teardown coordinator（A4 LIFO STEP0-4）** 🟢/🧪：closeWindow≡windowScope.close 跑 A4.2 序。**现状 deck-app.ts:801 已 own(win.destroy) 最先=STEP4 跑最后✓**；(c) 在其后追加 own：detachAll(STEP1)、wire(STEP2,见 gap#4)、其余(STEP3)；STEP0 由子 viewScope 处理（children-first LIFO，scope.ts:133-145）。验证：2 子 viewScope 各 own sink+detach，await close 断言全局序 [sink0,detach0,sink1,detach1,detachAll,wire,other,win.destroy]。🧪=STEP1/STEP4 destroy race + STEP0 后迟到 IPC。
- **(d) moveTo 跨窗（A1.3 状态机 + A1.5 migrationLock + Scope.adopt）** 🟢/🧪：per-view 异步互斥锁（Map<viewId,Promise> 链）；状态机 AT_SRC→DETACHED→AT_DEST|ROLLBACK→AT_SRC|CLOSED 消费 CommitError，回滚动作恒=「src 重挂」（与 dest 失败种类解耦）；rehome=srcWindowScope.adopt(viewScope,destWindowScope) 移寿命（默认仅移显示）。**风险=adopt↔同步撤销交互（gap#2）**。无死锁=每临界区只持一把 per-view 锁不取第二把。🧪=live-migrate 不重载（已 spike gate2）+ CLOSED 分支频率。
- **(e) slotToken 握手（A5-2）** 🟢/🧪：placeIn 生成 crypto nonce token，私表 token→{viewId,authorizedWcId}，controlWc.send('__deck:slot-grant')；per-control-wc replay buffer（仿 pendingWindowCreated splice(0) 首订阅 drain）；inbound place handler 在 wire trust+main-frame 闸上加 token 查表 + `sender.id===authorizedWcId` 否则 drop + bounds 形状(visible:false→detach / visible:true→w/h≥0，x/y 可负不拒)；token 寿命=viewScope own 删表。🧪=订阅/send replay 时序 + 真 spoof + 负 xy 跟随。
- **(f) keepAlive（B3）** 🟢：寿命正确性已由 (a)/(b) 的 viewScope own WebContents 兜底；opt-in LRU helper（B3.2 只 lru+max，省略=不淘汰）runtime 级，超 max 调最久未显示 hidden handle.dispose。**风险=保持薄，拒绝扩成策略框架**。

## 3. INFRA-AHEAD-OF-CONSUMER + 设计 gap（建前/建中解决）

### 3.1 infra-ahead（单测可验，真消费需迁移）
- **ControlBus 已接线（订正）**：~~已建未接 deck-app...休眠~~ 现已落地——deck-app 实例化 createControlBus 并注入 capability.policy（deck-app.ts:1185-1189），wire invokeHost 按 `layout.*` 分叉到 controlBus.dispatch（deck-app.ts:1206-1211），grant 闸常开 default-deny。下文「make it real」描述即为已完成的工作。
- **per-window Compositor（订正）**：~~不存在~~ 已建——每窗口在 deck-app.ts:833 各 `createCompositor`，ViewHandle 是其消费者。
- **slot-token renderer 端 createDeckLayoutClient（订正）**：~~未建~~ 已建——client/layout-client.ts:51（订阅 grant→建 anchor→发 place），端到端由 examples/layout-demo 自证。

### 3.2 设计 gap（建前裁决）
1. **Compositor.setBounds 不存在 + 边界含糊**：裁决=**ViewHandle 持 WebContentsView 自调 .setBounds（同 deck-app.ts:546,635），Compositor 纯 z-order 不动**（「不直碰 contentView」指 child 挂载非 per-view bounds）。**(a) 前定。**
2. **adopt↔同步 trust/grant 撤销在 moveTo(rehome) 的 race**（最微妙）：grant 按 control-wc senderId 键（Grant.senderScope），adopt 移 viewScope 资源所有权但**不移 grant**；src 窗关→revokeBySenderId(srcControlWc.id) 杀 grant。裁决倾向=**dest 窗有自己的 control shell→发自己的 grant**（demo popout 建新窗有自己 control），故 **moveTo 不该搬 grant**，src grant 撤销正确/无关→gap 是文档非代码。**+ adopt fence-wait 对 src-side reject**：src 关闭中 adopt 拒绝须当「src 走 CLOSED/AT_DEST-without-rehome」非未捕获 throw。**(d) 前确认。**
3. **slot-token replay 消费信号未定义**：需明确「grant 已消费可移出 buffer」信号 + **per-control-wc 分桶**（否则窗 A grant 漏到窗 B）。**(e) 中定。**
4. **STEP2(解绑 wire) per-window 今为 no-op**：deck-app 单 app 级 wire（:741，rootScope own），非 per-window。裁决=文档化 STEP2 收敛进 app 级「窗口先于 registry」先例，别造 per-window wire。
5. **legacy createViewAnchor(present/Bounds) vs createPlacementAnchor(visible/Placement)**：slot-grant/place 帧载 Placement→ViewHandle sink 用 **createPlacementAnchor**，renderer client 亦然。

## 4. 关键文件
deck-app.ts（runtime 工厂:1096、per-window scope/compositor:787-808、wire 分叉:741-757、同步撤销:856-868）；compositor.ts（加 detachAll；CommitError:59）；scope.ts（viewScope lease、adopt:371、完成栅栏:36）；view-anchor.ts（createPlacementAnchor:250 几何源）；control-bus.ts（grant 闸:147，已接线 deck-app.ts:1185/1206）+ capability.ts。
新文件：src/main/view-handle.ts（handle+工厂+moveTo 状态机）、slot-token 注册表、keepAlive-LRU。
