# 视图 Placement 对账

## 当前模型

renderer 不再分别向主进程发送“挂载/卸载”边沿命令。所有 anchor 把期望状态写进同一个
窗口级 placement publisher；publisher 在一批更新后发送完整
`PlacementSnapshot`。主进程以快照为输入，把 native view tree 收敛到期望状态。

renderer 侧入口在 `packages/devtools/src/renderer/shared/api/view-api.ts`，
主进程入口是 `ViewManager.setPlacementSnapshot`
（`packages/devtools/src/main/services/views/view-manager.ts:252-253`、
`packages/devtools/src/main/services/views/view-manager.ts:439`）。

`Placement` 保留显式判别：

```ts
type Placement =
  | { visible: true; bounds: Bounds }
  | { visible: false }
```

隐藏不再依赖把状态拍平成 0×0。`generation` 区分 renderer 文档代次，
`epoch` 区分同一代内的快照；旧代和倒退 epoch 会被拒绝
（`packages/devtools/src/main/services/views/placement-reconciler.ts:190-218`）。

## 受控视图

当前窗口级快照覆盖：

- simulator；
- simulator DevTools / Console；
- VS Code workbench；
- host toolbar；
- host sidebar；
- host dialog；
- settings；
- popover。

view id 与 layer 的权威定义在
`packages/devtools/src/shared/view-ids.ts:1-40`。simulator、editor 与 console
各自的 DOM anchor 都向同一个 publisher 写入；editor 的 anchor 在
`packages/devtools/src/renderer/modules/main/features/project-runtime/components/editor-panel.tsx:7-95`，
simulator 的 anchor 在
`packages/devtools/src/renderer/modules/main/features/project-runtime/components/simulator-panel.tsx:183-235`，
console 的 native slot 绑定在
`packages/devtools/src/renderer/modules/main/features/project-runtime/project-runtime.tsx:382-455`。

## 主进程分层

`createPlacementReconciler` 分三层工作：

1. deck layout 内核根据旧状态和完整快照产生 `ViewOp[]`。
2. `applyViewOps` 按 op 顺序执行 attach、hide、bounds、show、reorder。
3. `createNativeViewTreeHost` 是 native child tree 的唯一运行时写入口。

依据：
`packages/devtools/src/main/services/views/placement-reconciler.ts:93-172`、
`packages/devtools/src/main/services/views/apply-view-ops.ts:7-47`、
`packages/devtools/src/main/services/views/native-view-tree.ts:20-80`。

view 创建和销毁仍归各自 owner。reconciler ledger 只跟踪注册过的 native WCV；
`destroyView` 会先从 native tree 移除，再调用对应 view 的销毁逻辑
（`packages/devtools/src/main/services/views/placement-reconciler.ts:20-86`）。

## native child tree 的 owner 边界

对 devtools 主窗口：

1. `main-window/create.ts` 在构造期创建容器，把主 renderer 放成 child #0
   （`packages/devtools/src/main/windows/main-window/create.ts:68-72`）。
2. 此后所有受控 WCV 的 add/remove/reorder 都走
   `native-view-tree.ts`
   （`packages/devtools/src/main/services/views/native-view-tree.ts:20-80`）。

工作台 renderer child #0 不在 reconciler ledger。reorder 时，受控 WCV 会按目标顺序重新
append，因此自然位于 child #0 之上。

`internal-devtools-window/index.ts` 的 `contentView` 包装作用于另一个窗口，
不写主窗口的树
（`packages/devtools/src/main/windows/internal-devtools-window/index.ts:128-131`）。

## 全量 reorder 为什么正确

`placement-reconciler.ts` 在两个及以上受控 view 需要排序时，按目标顺序逐个调用
`addChildView`
（`packages/devtools/src/main/services/views/placement-reconciler.ts:152-156`）。

对已挂载 child 再调用 `addChildView` 只会把它提顶，不会 reload。因而同 tick 的
全量重贴能得到确定 z-order 且保持零重载；这是当前正确性策略，不是缺陷。

不要把它描述成 deck compositor 的 LIS 优化。deck 的 `computeKeepIds` 计算最长有序
**前缀**，遇到第一个乱序元素即停止，不保证最少 host churn
（`packages/electron-deck/src/main/compositor.ts:142-171`）。

## owner 替换与迟到状态

view 被销毁或替换时，owner 必须同时：

- 从 reconciler 注销或 forget 实际挂载状态；
- 清除对应 desired entry；
- 触发一次 reconcile。

native simulator 重建会调用 `forgetActual(VIEW_ID.simulator)`，防止新 WCV 被旧
“已挂载”状态吞掉
（`packages/devtools/src/main/services/views/native-simulator-view.ts:101-144`）。
workbench 销毁则走 `destroyView`、`deleteBaseDesired` 和
`reconcileNow`
（`packages/devtools/src/main/services/views/workbench-view.ts:184-192`）。

## 与 electron-deck 高层 compositor 的边界

不要在 devtools 主窗口上再调用 `runtime.windows.adopt()`。adopt 会创建另一套私有
window substrate / compositor，并直接写同一棵 `mainWindow.contentView`
（`packages/electron-deck/src/internal/deck-app.ts:889-936`、
`packages/electron-deck/src/internal/deck-app.ts:1502`）。

两套 owner 都只知道自己的顺序，无法维护全局 z-order。完整决策见
[`deck-adoption-decision.md`](./deck-adoption-decision.md)。
