# ViewHandle 契约

ViewHandle 把四个底层原语（Scope / Layout·Placement / Compositor / ControlBus）装配成「一块 view」的 per-view 编排单元。配套阅读：`architecture.md`（原语与 host-facing API）、`compositor-and-teardown.md`（compositor 与 teardown 契约）、`capability-and-lifecycle.md`（capability 与 lifecycle 契约）。

## ViewHandle 类型与硬边界

持有恰好三样：native ref（`NativeViewRef` + `WebContentsView`）、scope-lease（某 windowScope/wcScope 下的 viewScope，own native view + anchor sink + slot-token 条目）、compositor token（当前所在窗口的 `(compositor, host, windowScope)`）。

**公共面分两层，签名不同——`anchor` 只在高层存在**：

```ts
// 底层 ViewHandle（src/main/view-handle.ts）—— 无 anchor，target 是裸 { compositor, windowScope }
interface ViewHandle {
  placeIn(target: PlaceTarget, opts: { zone?: number }): ViewHandle
  applyPlacement(p: Placement): void
  moveTo(dest: PlaceTarget, opts: { zone?: number; rehome?: boolean }): Promise<void>
  dispose(): Promise<void>
  readonly webContents: unknown
  bounds(): Bounds | null
  capturePage(): Promise<unknown>
}

// 高层 DeckViewHandle（src/types.ts，`runtime.view(...)` 的返回类型）—— 带 anchor
interface DeckViewHandle {
  placeIn(window: BrowserWindow, opts: { zone?: number; anchor?: string }): DeckViewHandle
  applyPlacement(placement: ViewPlacement): DeckViewHandle
  moveTo(win: BrowserWindow, opts: { zone?: number; anchor?: string; rehome?: boolean }): Promise<void>
  dispose(): Promise<void>
  readonly webContents: WebContents
  bounds(): ViewBounds | null
  capturePage(): Promise<NativeImage>
}
```

两层都**没有** `anchorRect` 这个字段——它不是本包的 API；一次性坐标放置走 `applyPlacement({visible, bounds})`。两层的 `applyPlacement` / `webContents` / `bounds()` / `capturePage()` 形态一致，差别只在 `placeIn`/`moveTo` 是否接受 `anchor`。

**硬边界（正确性约束，非风格）**：
- 不算布局——几何来自 view-anchor publish，handle 只转发 `Placement`→`setBounds`/detach。
- 不持全局树——slot-token 私表 / LRU 组归 runtime。
- 不决定淘汰策略——keepAlive LRU 是 runtime helper 调 `handle.dispose`（见『keepAlive 保活』）。
- 不直碰 contentView——`addChildView` 经 Compositor 挂载/卸载；per-view `setBounds` 不算——Compositor 不持 `setBounds`，是 ViewHandle 直接持 `WebContentsView` 自调 `.setBounds`，Compositor 纯 z-order、不摸 per-view bounds。

## 组成

### placeIn 与挂载

handle + 工厂 + `placeIn` 接 Compositor（mount→commit）+ Scope（viewScope under windowScope）+ view-anchor（placement→bounds via 注入 publish）。每个窗口各持一个 `createCompositor(win.contentView)`，ViewHandle 是其消费者。`Compositor.detachAll()` 把 intent 折叠到空 + commit（removals-only 静默）。

### dispose（viewScope LIFO 序）

`dispose()` = close viewScope（单 view LIFO 序）。viewScope.own 顺序 = own(detach via unmount+commit) 先注册（跑最后）、own(anchorSink.dispose) 后注册（跑最先 = 停 publish）。sink 必须对 disposed handle 丢迟到的 in-flight bounds（view-anchor 只守自己的 emit，不守跨进程 sink 的幂等）。

### per-window teardown 协调

`closeWindow` ≡ windowScope.close 跑 teardown 序（LIFO）。windowScope 最先 own `win.destroy`（跑最后）；其后追加 own：detachAll、wire dispose（deck-app 是单 app 级 wire，由 rootScope own、非 per-window，收敛进 app 级「窗口先于 registry」先例，不造 per-window wire）、其余；子 viewScope 的 own 由 children-first LIFO 处理，先于这些窗口级 own 跑。

### moveTo 跨窗迁移

状态机 + migrationLock + `Scope.adopt`：per-view 异步互斥锁（`Map<viewId,Promise>` 链）；状态机 `AT_SRC→DETACHED→AT_DEST|ROLLBACK→AT_SRC|CLOSED` 消费 `CommitError`，回滚动作恒为「src 重挂」（与 dest 失败种类解耦）；`rehome:true` 以 viewScope 当前实际的 lifetime owner 为 donor，调用 `adopt(viewScope, destWindowScope)` 移寿命（默认仅移显示）。每个临界区只持一把 per-view 锁、不取第二把，故无死锁。

**迁的是显示，不是授权。** grant 按 control-wc 的 `senderId` 键（`Grant.senderId`，`src/host/capability.ts:22-34`），存在 capability registry 自己的表里，与 scope 的所有权图无关；`Scope.adopt` 只移 viewScope 的资源所有权，不碰 grant。dest 窗有自己的 control shell、发自己的 grant（popout 建新窗自带 control），所以 `moveTo` 不需要搬 grant，src 窗关闭时 `capability.revokeBySenderId(srcControlWc.id)`（`src/internal/deck-app.ts:622`）撤掉 src 的 grant 是正确且互不影响的。若 `adopt` 失败，`moveTo` 会撤销 dest 挂载并把 native view 恢复到 src；只有 src 恢复也失败时才进入 `CLOSED`。

### slot-token 握手

`placeIn` 生成 crypto nonce token，私表 `token→{viewId,authorizedWcId}`，`controlWc.send('__deck:slot-grant')`；per-control-wc replay buffer（首订阅 drain）；inbound place handler 在 wire 的 trust + main-frame 闸上再加 token 查表 + `sender.id===authorizedWcId` 否则 drop + bounds 形状校验（`visible:false`→detach / `visible:true`→w/h≥0，x/y 可负不拒）；token 寿命 = viewScope own 删表。

### keepAlive 保活

寿命正确性由『placeIn 与挂载』/『dispose（viewScope LIFO 序）』的 viewScope own WebContents 兜底；opt-in LRU helper（只 `lru`+`max`，省略 = 不淘汰）在 runtime 级，超 max 时对最久未显示的 hidden handle 调 `dispose`。保持薄，不扩成策略框架。

## 关键文件

- `src/main/view-handle.ts` —— handle + 工厂 + moveTo 状态机、slot-token 注册表、keepAlive-LRU。
- `src/types.ts` —— 高层 `DeckViewHandle` 类型（`runtime.view(...)` 返回）。
- `src/main/compositor.ts` —— `detachAll` + `CommitError`。
- `src/main/scope.ts` —— viewScope lease、`adopt`、完成栅栏。
- `packages/view-anchor/src/view-anchor.ts` —— `createPlacementAnchor` 几何源。
- `src/host/control-bus.ts` + `src/host/capability.ts` —— grant 闸（在 deck-app 实例化并接线）。
- `src/internal/deck-app.ts` —— runtime 工厂、per-window scope/compositor、wire 分叉、同步撤销。
