# ViewHandle keystone — 设计与契约

`ViewHandle` 把 4 个原语（Scope / Compositor / view-anchor / ControlBus）装配成干净的 host API：`runtime.view({...}).placeIn(win,{zone,anchor}).moveTo(win2).dispose()`。它是「一块 native view」的 per-view 编排器。本文定义它持有什么、硬边界、各动作的语义，以及与 compositor-and-teardown / capability-and-lifecycle 契约的接缝。

实现：`src/main/view-handle.ts`（handle + 工厂 + moveTo 状态机）+ `src/internal/deck-app.ts`（runtime 工厂、per-window scope/compositor、wire 分叉、同步撤销）。

## 1. ViewHandle 持有什么 + 硬边界

ViewHandle 恰好持有三样：

- **native ref**：`NativeViewRef` + `WebContentsView`。
- **scope-lease**：某 windowScope / wcScope 下的 viewScope，`own` native view + anchor sink + slot-token 条目。
- **compositor token**：当前所在窗口的 `(compositor, host, windowScope)`。

公共面：

```ts
placeIn(win, { zone, anchor?, anchorRect? }): DeckViewHandle           // 链式
applyPlacement({ visible, bounds } | { visible:false }): DeckViewHandle // 链式
moveTo(win, { zone, anchor?, rehome? }): Promise<void>                 // 唯一 re-placement 路径
dispose(): Promise<void>
readonly webContents: WebContents
bounds(): ViewBounds | null     // placed 且 visible 时返回 live rect，否则 null
capturePage(): Promise<NativeImage>
```

**硬边界（正确性，非风格）**：

- **不算布局**：几何来自 view-anchor 的 publish，handle 只转发 `Placement → setBounds / detach`。
- **不持全局树**：slot-token 私表 / LRU 组归 runtime。
- **不决定淘汰策略**：keep-alive LRU 是 runtime helper，调 `handle.dispose`。
- **不直碰 contentView 做 z 挂载**：`addChildView` / `removeChildView` 经 Compositor。**per-view `setBounds` 例外**：由 ViewHandle 持 `WebContentsView` 自调（Compositor 纯 z-order，不动 per-view bounds）。

## 2. 各动作的语义

handle 的能力依以下依赖关系装配（`→` 表「依赖」）：placeIn 是底座，dispose / slotToken / keepAlive 建其上，moveTo 依赖 placeIn + dispose。

### placeIn — 立起 per-window 原生 view 底座

`placeIn` 接 Compositor（mount → commit）+ Scope（viewScope under windowScope）+ view-anchor（placement → bounds via 注入 publish）。每个窗口在装配时各 `createCompositor(win.contentView)`、由其 windowScope `own`。`Compositor.detachAll()`（折叠 intent 到空 + commit，靠 removals-only 静默）供 teardown 用。

### dispose — close viewScope（单 view A4 序）

`dispose` = close viewScope，按 A4 的 own() LIFO 子序：`own(detach via unmount+commit)` 先注册（跑最后）、`own(anchorSink.dispose)` 后注册（跑最先 = STEP0 停 publish）。

🔒 **sink 迟到 IPC 幂等**：renderer 可能已发 in-flight place，handle 的 sink 必须对 disposed handle 丢 bounds（view-anchor 只守自己的 emit，不守跨进程 sink）。

### moveTo — 跨窗迁移（A1.3 状态机 + A1.5 migrationLock + Scope.adopt）

`moveTo` 是唯一 re-placement 路径（`placeIn` 两次抛）。per-view 异步互斥锁（`Map<viewId, Promise>` 链）串行化；状态机 `AT_SRC → DETACHED → AT_DEST | ROLLBACK → AT_SRC | CLOSED` 消费 `CommitError`，回滚动作恒为「src 重挂」（与 dest 失败种类解耦）。`rehome:true` = `srcWindowScope.adopt(viewScope, destWindowScope)` 移寿命（默认仅移显示）。无死锁 = 每临界区只持一把 per-view 锁、不取第二把。详见 `compositor-and-teardown.md` §A1。

### slotToken 握手（A5-2）

`placeIn` 生成 crypto nonce token，私表 `token → { viewId, authorizedWcId }`，`controlWc.send('__deck:slot-grant')`；per-control-wc replay buffer（首订阅 drain），防订阅与 send 的竞态。inbound place handler 在 wire trust + main-frame 闸之上加：token 查表 + `sender.id === authorizedWcId` 否则 drop + bounds 形状校验（`visible:false` → detach；`visible:true` → w/h≥0，x/y 可负不拒）。token 寿命 = viewScope own 删表。详见 `capability-and-lifecycle.md` §A5-2。

### keepAlive（B3）

寿命正确性由 viewScope own WebContents 兜底（关窗 / 关项目连带销毁）。`runtime.view({ keepAlive:{ policy:'lru', max } })` 是 opt-in LRU helper（runtime 级）：同组隐藏 view 超 `max` 时，对最久未显示的 hidden handle 调 `dispose`（销毁其 WebContents）；当前 visible 的永不淘汰；省略 `keepAlive` = 不淘汰（纯 host 管）。只内建 `lru` + `max` 一种，不扩成策略框架。详见 `capability-and-lifecycle.md` §B3。

## 3. 接线与设计裁决

### ControlBus 接线

deck-app 实例化 `createControlBus` 并注入 `capability.policy`；wire `invokeHost` 按 `layout.*` 分叉到 `controlBus.dispatch`（grant 闸常开 default-deny），普通领域 API 走 `InMemoryTypedIpcRegistry`（只 trust 闸）。per-window Compositor 各窗口一个；ViewHandle 是其消费者。slot-token renderer 端 `createDeckLayoutClient`（订阅 grant → 建 anchor → 发 place）端到端由 `examples/layout-demo` 自证。

### 设计裁决

1. **`Compositor.setBounds` 不存在是裁决而非缺漏**：ViewHandle 持 `WebContentsView` 自调 `.setBounds`，Compositor 纯 z-order 不动。「不直碰 contentView」指 child 挂载（经 Compositor），非 per-view bounds。
2. **moveTo(rehome) 不搬 grant**：grant 按 control-wc senderId 键（`Grant.senderScope`），adopt 移 viewScope 资源所有权但不移 grant；dest 窗有自己的 control shell、发自己的 grant，src 窗关 → `revokeBySenderId(srcControlWc.id)` 杀 src grant，正确且无关。adopt 的 fence-wait 对 src-side reject 当「src 走 CLOSED / AT_DEST-without-rehome」处理，非未捕获 throw。
3. **slot-token replay per-control-wc 分桶**：「grant 已消费可移出 buffer」信号按 control wc 分桶（否则窗 A grant 漏到窗 B）。
4. **per-window 解绑 wire 收敛进 app 级先例**：deck-app 是单 app 级 wire（rootScope own），非 per-window；A4 的 STEP2（解绑 wire）文档化为收敛进 app 级「窗口先于 registry」先例，不造 per-window wire。
5. **slot-grant / place 帧载 `Placement`**：ViewHandle sink 与 renderer client 均用 `createPlacementAnchor`（visible/Placement），非 legacy `createViewAnchor`（present/Bounds）。

## 4. 关键文件

- `src/main/view-handle.ts` — handle + 工厂 + moveTo 状态机。
- `src/internal/deck-app.ts` — runtime 工厂、per-window scope/compositor、wire `layout.*` 分叉、同步撤销、slot-token 注册表、keepAlive-LRU。
- `src/main/compositor.ts` — `detachAll` / `CommitError`。
- `src/main/scope.ts` — viewScope lease、`adopt`、完成栅栏。
- `src/host/control-bus.ts` + `src/host/capability.ts` — grant 闸接线。
- `packages/view-anchor/src/view-anchor.ts` — `createPlacementAnchor` 几何源。
