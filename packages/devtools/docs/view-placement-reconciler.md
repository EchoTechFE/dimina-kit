# 视图 Placement 对账（View Placement Reconciler）设计

## 背景：要根治的一类 bug

native-host 模式下，工作台里若干"内容视图"是主进程的 `WebContentsView`，绘制在 renderer（React）里的占位 `<div>` 之上：模拟器、代码编辑器、host-toolbar、console 覆盖层，另有 settings / popover 两个 top-tier overlay。

已上报 bug：反复快速切换模拟器设备/横竖屏十几次后**整窗白屏且稳定保持**——三个内容视图被 `removeChildView` 后没挂回。根因是 relayout 瞬态把锚点槽位测成 0×0、几何哨兵发了一次虚假 detach，主进程照单卸载后无人再挂回。

这不是孤例：同一项目历史上还有 `switchTab` 切回空壳、host-toolbar 高度链两个同类现象。它们共享同一个**架构病根**。

## 病根：命令式、边沿触发、无对账

主进程的视图挂载态 = renderer 发来的一串**边沿触发（edge-triggered）命令**累加出来的结果。现状实测：

- **4 条各自独立的发布链**，各走各的 IPC 通道、各自 dedup、各自触发 RAF：
  - simulator → `simulator:set-native-bounds`（payload 带 `zoom`）→ `setNativeSimulatorViewBounds`
  - editor → `view:workbench-bounds` → `setWorkbenchBounds`
  - host-toolbar → `view:host-toolbar:bounds`（另有 `advertise-height` 反向尺寸链）→ `setHostToolbarBounds`
  - console → `view:simulator:devtools-bounds` → `setSimulatorDevtoolsBounds`
- 主进程**纯命令式即时 apply，无 reconcile/diff**：`isHidden(b) = b.width<=0||b.height<=0`（view-manager.ts:540）为真就 `removeChildView`，非零就 `addChildView` + `setBounds` + `raiseTopOverlays`。
- renderer 侧把判别式 `{visible:false}` **拍平成 0×0 bounds** 过 IPC（simulator-panel.tsx:79、editor-panel.tsx:40、project-runtime.tsx:428），main 再从宽高重新推导隐藏——`{visible:false}` 与"真的 0 面积但可见"在协议里不可区分。
- z-order 靠散落的 `raiseTopOverlays()`（在 base 视图每次重新 attach 后重新 `addChildView` 把 settings/popover 提回顶层）。

后果：**任何一次丢失或虚假的边沿事件 = 永久性状态损坏。** 没有单一真相源、没有从期望态重算实际态的对账，坏事件不会被后续正确事件纠正。

现状里唯一接近"期望态"的是两处被动缓存（`simulatorBoundsOverride`:471、`lastRendererRect`:429），用于容错"上报早于 view 创建"的竞速——本设计把这个雏形正式化为统一的 desired store。

## 目标架构：单一真相源 + 窗口级快照 + 主进程 reconciler

把原生视图挂载纳入**声明式对账（Controller / Reconciler 模式，level-triggered）**。renderer 声明"每块视图应该长什么样"，主进程持续把实际视图树收敛到期望态。

```
 renderer                                     main
 ┌────────────────────────────┐              ┌──────────────────────────────┐
 │ 各 anchor.set(viewId, ...)  │              │ ViewReconciler (纯函数内核)   │
 │        ↓ 写入               │   窗口级快照  │  reconcile(state, snapshot)   │
 │ PlacementStore (单一真相源) │  ──────────▶ │    → { state', ops[] }        │
 │        ↓ dirty              │  epoch/gen   │        ↓                       │
 │ CommitScheduler (中央 RAF)  │   单通道      │ applyOps (薄副作用 executor)   │
 │  同 tick 读整张 Map 发一次   │              │  attach/detach/setBounds/     │
 └────────────────────────────┘              │  setVisible/reorder            │
                                              └──────────────────────────────┘
```

### 协议：窗口级 Placement 快照

```ts
type ViewId =
  | 'simulator' | 'simulator-devtools' | 'workbench'
  | 'host-toolbar' | 'settings' | 'popover'

// 判别式端到端保留，绝不拍平成 0×0
type Placement =
  | { visible: true; bounds: { x: number; y: number; width: number; height: number } }
  | { visible: false }

interface DesiredView {
  viewId: ViewId
  placement: Placement
  layer: number          // z-order：大者在上（base < settings < popover）
  extra?: { zoom?: number } // 视图特有字段（simulator 的 zoom）
}

interface PlacementSnapshot {
  generation: number     // renderer 生命周期号；renderer 重启递增，main 见新号重置全表
  epoch: number          // 窗口级单调；同一 commit tick 内所有 view 同一个 epoch
  views: DesiredView[]   // 该 tick 的整张期望表（level，不是 delta）
}
```

单一新通道 `view:placement-snapshot` 取代 4 条旧 bounds 通道。`advertise-height` 反向尺寸链（size-advertiser）与本设计正交，保留。

### 主进程 reconciler（纯函数内核）

内核与协议类型落在 `@dimina-kit/electron-deck` 的 layout-as-data 引擎
（`packages/electron-deck/src/layout/placement-reconcile.ts`），**领域中立**：`viewId`
是不透明 `string`，视图特有字段（如 simulator 的 zoom）走 `Extra` 泛型，同一内核既服务
devtools 也服务 deck 的 layout-client。boundary 门禁只禁 electron/react，`import type`
view-anchor 的 `Placement` 合法。

```ts
type ViewOp<Extra = unknown> =
  | { kind: 'setBounds'; viewId: string; bounds: Bounds; extra?: Extra }
  | { kind: 'attach'; viewId: string }
  | { kind: 'setVisible'; viewId: string; visible: boolean }
  | { kind: 'detach'; viewId: string }        // 仅生命周期销毁，隐藏不用
  | { kind: 'reorder'; order: string[] }      // 按 layer 全量重排

interface ReconcilerState<Extra = unknown> {
  generation: number
  lastEpoch: number
  desired: Map<string, DesiredView<Extra>>
  actual: Map<string, { attached: boolean; visible: boolean; bounds?: Bounds; extra?: Extra }>
}

function reconcile<Extra = unknown>(
  prev: ReconcilerState<Extra>,
  snapshot: PlacementSnapshot<Extra>,
): { state: ReconcilerState<Extra>; ops: ViewOp<Extra>[] }
```

devtools 侧把 `Extra` 固定为 `{ zoom?: number }`；`ViewId` 那个 union 作为 devtools 自己的
viewId 常量集合保留（simulator / simulator-devtools / workbench / host-toolbar / settings /
popover），传给内核时就是普通 string。

**纯函数**：只算 ops，不碰 Electron。副作用由薄 `applyViewOps(ops)` executor 执行，便于对内核做穷尽单测。

reconcile 行为契约：

1. **拒 stale**：`snapshot.generation === prev.generation && snapshot.epoch <= prev.lastEpoch` → 返回 `ops:[]`，state 不变。
2. **generation 重置**：`snapshot.generation > prev.generation` → 清空 desired/actual，按快照全量重建。
3. **diff-only**：对每个 viewId 比较 desired vs actual，只对**变化字段**产出 op（bounds 先整数化再比较，消除 subpixel 抖动 → 稳定态零 op）。
4. **固定 op 序**（避免 attach 后 resize / toolbar 被压下等闪烁）：
   - 先对"要隐藏"的视图 `setVisible(false)`（**不** removeChildView）；
   - 再对"要显示且未 attach"的先 `setBounds` 再 `attach`；
   - 再对已 attach 的仅在 bounds 变化时 `setBounds`；
   - 最后**仅当 attach 集合变化**时按 layer 产出一次 `reorder`（z-order 成为快照字段，取代散落的 raiseTopOverlays）。
5. 更新 actual cache + `lastEpoch`。

隐藏用 `setVisible(false)` 而非 `removeChildView`：视图保持在树里、保住 z-order 槽位与 webContents，恢复只需 `setVisible(true)`，无 re-add / raiseTopOverlays 抖动。真正的 `detach`（removeChildView + close）只在视图生命周期销毁时走。

**publisher 生命期契约（真相源死亡即空电平）**：`createPlacementPublisher` 的 `dispose()` 在取消待发帧后，**同步 flush 恰好一次空快照**（`views: []`，epoch 继续单调）。level-triggered 的 main 侧只会应用收到的最新电平——若真相源静默消失，最后一帧非空快照会永久冻结在 main，publisher 放置过的视图全部越过其所有者存活（曾表现为：关闭项目后 host-toolbar 条带残留覆盖项目列表页）。空电平让 reconciler 对所有 renderer 放置的视图统一走 detach（removeChildView，不销毁 WCV；宿主级的 host-toolbar WCV 与保留高度跨项目存活，下次 open 由新 generation 快照重新挂载）。与后继 publisher 的竞态由 generation 护栏兜住：旧 generation 的迟到 flush 被整体拒绝。

## Codex 对抗提出的 9 条前置条件 → 逐条如何被吸收

| # | 漏洞 | 本设计的吸收方式 |
|---|---|---|
| 1 | 多生产者 epoch 非天然一致 | **中央 CommitScheduler 同一 RAF tick 读整张 Map，发一个窗口级 epoch**；anchor 不各自带 epoch |
| 2 | reconciler 不修复"真相源卡死" | 生产者语义硬约束：anchor 只跟随可见几何，瞬态 0×0 **绝不写 `{visible:false}`**（已在几何哨兵修复）；判别式端到端保留，store 存判别式而非 0×0 |
| 3 | apply 非原子事务 | **固定 op 序** + **layer 字段** 取代散落 raiseTopOverlays；隐藏用 setVisible 不 detach |
| 4 | 每帧无 diff 制造抖动 | actual cache + 仅变化字段产 op + bounds 整数化 → 稳定态零 op |
| 5 | 全量快照需 coalesce | CommitScheduler 每帧最多一发（dirty 才发）；main 只应用最新 epoch；**不做 100ms 级节流**（会把恢复电平延后成可感白屏） |
| 6 | generation 归零漏判 | `generation` 字段；main 见新 generation 重置 desired/actual；窗口销毁后 pending 快照 no-op |
| 7 | 三链塌缩暴露所有权 | typed `DesiredView`（owner=viewId 枚举 / layer / placement），谁能删、谁拥有 visible、谁管 z-index 全部显式 |
| 8 | 可观测性下降 | snapshot / actual dump / epoch trace / 每个 op 带原因，落结构化日志 |
| 9 | 0×0 产品语义未定义 | 可见性与几何**分离**：0×0 bounds = 可见但无可绘区，**≠ detach**；隐藏只由 `{visible:false}` 表达 |

## 兼容性与边界

- **electron-deck 也消费 `createPlacementAnchor`**（layout-client.ts）。view-anchor 包的 anchor API **保持不变**——anchor 仍产出 `Placement`，改的是"Placement 交给中央 store 而非各自 invoke IPC"。electron-deck 侧按需同步适配或维持旁路。
- **simulator 的 zoom** 经 `DesiredView.extra.zoom` 承载，reconciler 在 setBounds op 附带。
- **settings / popover** 纳入 layer 模型（base < settings < popover），z-order 交给 reconciler 的 reorder，删掉散落的 raiseTopOverlays 调用点。
- **host-toolbar 的 `advertise-height`** 反向尺寸链（size-advertiser）与本设计正交，不动。
- **teardown**：窗口销毁 / detachSimulator / detachWorkbench 时，reconciler state 清空，后续 pending 快照 no-op。

## 落地顺序（实现分解，非分期交付）

一次性做完整架构，内部按依赖有序推进：

1. ✅ 协议与类型：`Placement`（复用 view-anchor）/ `DesiredView` / `PlacementSnapshot` / `ViewOp` / `ActualView` / `ReconcilerState`，落 `electron-deck/src/layout/placement-reconcile.ts`。
2. ✅ **reconciler 纯函数内核 + 穷尽单测**（TDD，测试由独立 subagent 先写，20/20 绿）：拒 stale、generation 重置、diff-only 稳定态零 op、瞬态 0×0 自愈、固定 op 序、layer reorder、extra 透传、幂等。
3. ✅ renderer 中央 `createPlacementPublisher`（窗口级 epoch、dirty coalesce），落 `electron-deck/src/client/placement-publisher.ts`，独立 subagent TDD 18/18 绿。electron-deck 整包 942 测试无回归。
4. ✅ `applyViewOps` 薄 executor（`devtools/src/main/services/views/apply-view-ops.ts`）+ view-manager 内 `ViewTarget`（viewId→WCV + lazy-create + simulator zoom 传播）+ `reconcileNow`（单调 epoch）+ `gateReadiness`（simulator/console WCV 未创建时降级 hidden，取代早上报缓存）。
5. ✅ 4 个 anchor 消费方（simulator / editor / host-toolbar / console）的 publish 回调改为写 `createPlacementPublisher`；`project-runtime` 建 publisher（generation-per-mount）经 React context 下发；判别式端到端保留（不再拍平 0×0）。
6. ✅ 新通道 `view:placement-snapshot` 接线，main handler → `setPlacementSnapshot` → reconcile → applyViewOps。settings/popover 由 main 维护 `overlayDesired` 并入 reconcile（layer 恒高于 base），删 `raiseTopOverlays`。
7. ✅ 删旧路径：4 条 bounds 通道 + handler、4 个 `setXxxBounds` adapter、`isHidden`、散落 raiseTopOverlays、两处竞速缓存（`lastRendererRect`/`simulatorBoundsOverride`），受影响单测重写到 `setPlacementSnapshot`。
8. ✅ 全门禁（tsc 0 / eslint 0 / gate 全绿，type-coverage 反升 99.68→99.69 / vitest devtools 1755 + electron-deck 942）+ 真机 e2e（反复切设备 16 次 `visibilityState` 保持 visible 不白屏；切 tab；切项目；host-toolbar；settings）。

9. ✅ **electron-deck 自己的 `createDeckLayoutClient`（slot-token 布局握手）也收敛到共享内核**（不再是 follow-up）。它原是 per-view edge-triggered（同病），现改为：renderer 侧每个 anchor 的测量写进中央 `createPlacementPublisher` → 窗口级 snapshot；main 侧 `handleSnapshot` 走 `cleanSnapshot`（按 slotToken 授权 + viewId 从 registry 派生，防投毒）→ per-wc `reconcile` → `dispatchOps` 塌缩进 ViewHandle 两态 sink（`electron-deck/src/layout/snapshot-reconcile.ts`）。capability 模型保全（token 仍是唯一凭证、anti-spoof 不变）。Codex 对抗评审 5 FLAW 全吸收：Q1 全无效 snapshot 整体拒绝（不 detach-all）/ Q2 ViewHandle setBounds 前置消首挂闪 / Q3+Q4 main 分配单调 generation（`SlotGrant.generation`）+ reconcile `generation<prev` 护栏，reload 不靠 IPC 保序 / Q5 旧 `place` 通道全删无 compat shim（消费者全在包内）。`examples/layout-demo` 加 hide/restore + 40 轮 stress 场景真机证 level-triggered 自愈。

**收敛完成**：共享内核（reconcile/publisher）与 electron-deck 自身的 layout-client 现共用同一 level-triggered 底座；devtools 与 deck 两条 native-view 挂载链路不再有"一条对账、一条边沿触发"的分裂。deck-adoption NO-GO 不撞（不接管 view 创建 / 不迁 runtime.view / Compositor 仍裸挂）。

## 失败模式的根本改写

对账把最坏结果从**永久白屏**降级为**≤1 帧闪一下、自动愈合**：丢消息 → 下一拍从 desired 重算纠正；虚假瞬态 → 电平恢复时纠正。生产者正确性（几何哨兵不发虚假 detach）仍是必需前置——它保证 store 里不会被写入持续错误的电平；reconciler 不替代它，两者互补。
