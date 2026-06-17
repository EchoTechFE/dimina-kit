# ViewHandle 契约

ViewHandle 把四个底层原语（Scope / Layout·Placement / Compositor / ControlBus）装配成「一块 view」的 per-view 编排单元，对 host 暴露 `runtime.view({...}).placeIn(win,{zone,anchor}).moveTo(win2).dispose()`。配套阅读：`architecture.md`（原语与 host-facing API）、`compositor-and-teardown.md`（compositor 与 teardown 契约）、`capability-and-lifecycle.md`（capability 与 lifecycle 契约）。

## ViewHandle 类型与硬边界

持有恰好三样：native ref（`NativeViewRef` + `WebContentsView`）、scope-lease（某 windowScope/wcScope 下的 viewScope，own native view + anchor sink + slot-token 条目）、compositor token（当前所在窗口的 `(compositor, host, windowScope)`）。

公共面：`placeIn(win,{zone,anchor?,anchorRect?})→this` / `moveTo(win,{zone,anchor?,rehome?})→Promise<void>` / `dispose()→Promise<void>`。

**硬边界（正确性约束，非风格）**：
- 不算布局——几何来自 view-anchor publish，handle 只转发 `Placement`→`setBounds`/detach。
- 不持全局树——slot-token 私表 / LRU 组归 runtime。
- 不决定淘汰策略——keepAlive LRU 是 runtime helper 调 `handle.dispose`（见『keepAlive 保活』）。
- 不直碰 contentView——`addChildView` 经 Compositor（但 per-view `setBounds` 见『handle 直接驱动 bounds』）。

## 组成

### placeIn 与挂载

handle + 工厂 + `placeIn` 接 Compositor（mount→commit）+ Scope（viewScope under windowScope）+ view-anchor（placement→bounds via 注入 publish）。每个窗口各持一个 `createCompositor(win.contentView)`，ViewHandle 是其消费者。`Compositor.detachAll()` 把 intent 折叠到空 + commit（removals-only 静默）。

### dispose（viewScope LIFO 序）

`dispose()` = close viewScope（单 view LIFO 序）。viewScope.own 顺序 = own(detach via unmount+commit) 先注册（跑最后）、own(anchorSink.dispose) 后注册（跑最先 = 停 publish）。sink 必须对 disposed handle 丢迟到的 in-flight bounds（view-anchor 只守自己的 emit，不守跨进程 sink 的幂等）。

### per-window teardown 协调

`closeWindow` ≡ windowScope.close 跑 teardown 序（LIFO STEP0-4）。windowScope 最先 own `win.destroy`（STEP4，跑最后）；其后追加 own：detachAll（STEP1）、wire（STEP2，见『STEP2 解绑 wire 为 app 级』）、其余（STEP3）；STEP0 由子 viewScope 处理（children-first LIFO）。

### moveTo 跨窗迁移

状态机 + migrationLock + `Scope.adopt`：per-view 异步互斥锁（`Map<viewId,Promise>` 链）；状态机 `AT_SRC→DETACHED→AT_DEST|ROLLBACK→AT_SRC|CLOSED` 消费 `CommitError`，回滚动作恒为「src 重挂」（与 dest 失败种类解耦）；`rehome:true` 经 `srcWindowScope.adopt(viewScope,destWindowScope)` 移寿命（默认仅移显示）。每个临界区只持一把 per-view 锁、不取第二把，故无死锁。adopt↔同步撤销的交互见『moveTo 迁移显示而非寿命』。

### slot-token 握手

`placeIn` 生成 crypto nonce token，私表 `token→{viewId,authorizedWcId}`，`controlWc.send('__deck:slot-grant')`；per-control-wc replay buffer（首订阅 drain）；inbound place handler 在 wire 的 trust + main-frame 闸上再加 token 查表 + `sender.id===authorizedWcId` 否则 drop + bounds 形状校验（`visible:false`→detach / `visible:true`→w/h≥0，x/y 可负不拒）；token 寿命 = viewScope own 删表。

### keepAlive 保活

寿命正确性由『placeIn 与挂载』/『dispose（viewScope LIFO 序）』的 viewScope own WebContents 兜底；opt-in LRU helper（只 `lru`+`max`，省略 = 不淘汰）在 runtime 级，超 max 时对最久未显示的 hidden handle 调 `dispose`。保持薄，不扩成策略框架。

## 设计裁决

### handle 直接驱动 bounds

Compositor 不持 `setBounds`：ViewHandle 持 `WebContentsView` 自调 `.setBounds`，Compositor 纯 z-order 不动 per-view bounds（「不直碰 contentView」指 child 挂载、非 per-view bounds）。

### moveTo 迁移显示而非寿命

`moveTo(rehome)` 不搬 grant：grant 按 control-wc senderId 键（`Grant.senderScope`）；adopt 移 viewScope 资源所有权但**不移 grant**。dest 窗有自己的 control shell、发自己的 grant（popout 建新窗自带 control），故 moveTo 不搬 grant，src 窗关闭时 `revokeBySenderId(srcControlWc.id)` 撤 src grant 是正确且无关的。`adopt` fence-wait 对 src-side reject：src 关闭中 adopt 拒绝须当作「src 走 CLOSED / AT_DEST-without-rehome」，非未捕获 throw。

### slot-token replay 分桶

明确「grant 已消费可移出 buffer」的消费信号，并按 control-wc 分桶（否则窗 A 的 grant 漏到窗 B）。

### STEP2 解绑 wire 为 app 级

deck-app 是单 app 级 wire（rootScope own），非 per-window。STEP2 收敛进 app 级「窗口先于 registry」先例，不造 per-window wire。

### slot-grant/place 帧用 createPlacementAnchor

帧载 `Placement`（visible/Placement 判别式），ViewHandle sink 与 renderer client 均用 `createPlacementAnchor`（非 legacy `createViewAnchor` 的 present/Bounds）。

## 关键文件

- `src/main/view-handle.ts` —— handle + 工厂 + moveTo 状态机、slot-token 注册表、keepAlive-LRU。
- `src/main/compositor.ts` —— `detachAll` + `CommitError`。
- `src/main/scope.ts` —— viewScope lease、`adopt`、完成栅栏。
- `packages/view-anchor/src/view-anchor.ts` —— `createPlacementAnchor` 几何源。
- `src/host/control-bus.ts` + `src/host/capability.ts` —— grant 闸（在 deck-app 实例化并接线）。
- `src/internal/deck-app.ts` —— runtime 工厂、per-window scope/compositor、wire 分叉、同步撤销。
