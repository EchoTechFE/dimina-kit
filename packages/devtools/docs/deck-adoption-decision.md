# devtools 是否采纳 electron-deck 高层 host API — 当前决策

> 当前结论：保留 `ownsWindows:true` 和既有低层集成；不要在 devtools 主窗口上叠加
> deck 自己的 window substrate / compositor。理由见下文各节。

## 范围

本文只讨论 `runtime.view`、`runtime.windows`、`runtime.grants`、
Window facade 与 Compositor 这一组高层 host API。

devtools 已使用 deck 的低层原语和 layout-as-data：
`@dimina-kit/electron-deck/main`、`/layout`、`/dock-react` 与
`/client`。项目布局由 `<DockView>` 渲染，见
[`project-window-layout.md`](./project-window-layout.md)。

## 当前阻断：主窗口存在两个 native child-tree owner

`runtime.windows.adopt()` 有完整实现，也明确支持观察或接管外部窗口；
`ownsWindows:true` 本身不会让这组 API 结构性不可用
（`packages/electron-deck/src/internal/deck-app.ts:1462-1566`）。

问题发生在 adopt 的下一层：

- `adoptWindow` 无条件创建 window substrate
  （`packages/electron-deck/src/internal/deck-app.ts:1502`）。
- substrate 维护私有 `order`，创建自己的 compositor，并直接调用
  `win.contentView.addChildView/removeChildView`
  （`packages/electron-deck/src/internal/deck-app.ts:889-936`）。
- devtools 的 `createNativeViewTreeHost` 也维护自己的 `order` /
  `mounted`，写同一个 `mainWindow.contentView`
  （`packages/devtools/src/main/services/views/native-view-tree.ts:20-80`）。

两边的私有顺序都看不到对方的写入，因此没有组件拥有全局 z-order。这个阻断是
**按窗口**的：devtools 主窗口不能同时接两套 owner；没有 devtools reconciler 的独立窗口
仍可单独评估 `runtime.windows.adopt()`。

## 次级契约缺口

`ViewCreateOptions` 仍只有 `source`、`scope?`、`keepAlive?`，
表达不了 simulator 所需的 `preload`、`partition`、`webviewTag`，
也不能接管通过 `setDevToolsWebContents` 装载的 Chromium DevTools
（`packages/electron-deck/src/types.ts:330-350`）。

这会阻止 devtools 把现有 WCV 直接改写成 `runtime.view`，但不是采用
`adopt()` 的根本阻断；根本阻断仍是同一 native 子树有两个 owner。

## devtools 主窗口的 owner 边界

生产代码对 `mainWindow.contentView` 的写入分两段：

1. 创建窗口时，把工作台 renderer 包进新 `View`，作为 child #0
   （`packages/devtools/src/main/windows/main-window/create.ts:68-72`）。
2. 此后由 `createNativeViewTreeHost` 独占 add/remove/reorder
   （`packages/devtools/src/main/services/views/native-view-tree.ts:20-80`）。

child #0 不在 reconciler ledger 中。reconciler 的全量重贴会把受控 WCV 抬到工作台
renderer 之上，这是预期层级
（`packages/devtools/src/main/services/views/placement-reconciler.ts:152-156`）。
`internal-devtools-window` 的包装作用于另一个窗口，不属于主窗口 owner
（`packages/devtools/src/main/windows/internal-devtools-window/index.ts:128-131`）。

## 已确认仍有效的取舍

- simulator WCV 只覆盖 renderer 的设备占位区，顶部工具条不会被原生 WCV 盖住
  （`packages/devtools/src/renderer/modules/main/features/project-runtime/components/simulator-panel.tsx:183-235`）。
- renderer 本身是 child #0；原生 WCV 与 renderer DOM 不能做元素级 z 交错，但整块 renderer
  可以通过重加 child 改层级（`packages/devtools/src/main/windows/main-window/create.ts:68-72`）。
- deck compositor 不批量提交 bounds；`applyPlacement` 仍逐 view 调
  `setBounds`（`packages/electron-deck/src/main/view-handle.ts:371-380`）。
- settings / popover 保持原生 overlay 是 UX 选择：需要覆盖其它原生 WCV 时，纯 DOM 弹层不够。

## 重新评估条件

只有满足对应前提才重开：

- 采用 `adopt() + runtime.view`：先给出一套同时接管 z-order 和 bounds 的单 owner
  方案；只注入 compositor 不够。
- 把 devtools 的 MessagePort 插槽机制移进 deck：先出现第二个不经过 devtools、
  直接需要同一 document-scoped port 协议的生产消费者。
- 删除 deck 实验性高层面：先完成仓库外消费者审计和版本兼容决策。
- devtools 出现 popout：可对不受主窗口 reconciler 管理的目标窗口单独评估 adopt。

## 不要据此误判 compositor

devtools 的 reorder 会按目标顺序把已挂载 view 全量重新 `addChildView`
（`packages/devtools/src/main/services/views/placement-reconciler.ts:152-156`）。
Electron 对已挂载 child 的再次添加只会提顶，不会 reload；同一 tick 的批处理因此是零重载的正确实现。

deck 的 `computeKeepIds` 算最长有序**前缀**，遇到第一个乱序元素即停止，
不是 LIS，也不保证最少 host churn
（`packages/electron-deck/src/main/compositor.ts:142-171`）。
