# devtools 是否采纳 electron-deck 高层 host API — 决策记录

> **结论**：devtools 维持 `ownsWindows:true` 旁路集成，**不**采纳 electron-deck 的高层
> host-shell API（`runtime.view` / `runtime.windows` / `runtime.grants` / Window facade /
> Compositor）。本文固化这个决策的依据与重启条件。

## 范围

本决策只针对 deck 的**高层 host-shell API**——`runtime.view` / `runtime.windows` /
`runtime.grants` / Window facade / Compositor 那一面。

deck 另起的 **layout-as-data 引擎（`@dimina-kit/electron-deck/layout`）+ `<DockView>`
（`/dock-react`）是一个正交 surface**——它不 import electron、不碰 Scope / Compositor /
ControlBus。这个 surface **已被 devtools 采纳**：项目窗口布局是单一 `<DockView>`（IDE-dockable
拖拽 re-dock / tab / 分屏 / 序列化）。两件事针对 deck 的两个不同对外面，结论不矛盾。详见
[`project-window-layout.md`](./project-window-layout.md) 与
`../../electron-deck/docs/architecture.md §0.5`。

## 集成现状

devtools 与下游宿主都经 `RuntimeBackend` 生命周期路径、以 `ownsWindows:true` 集成，不触碰高层面：

- `devtools-backend.ts` 设 `ownsWindows:true`。
- `view-manager.ts` 全程裸 `addChildView` / `setBounds` 管理原生 overlay。
- `workbench-context.ts` 只用 `/main` 低层原语。

deck 的高层 host API 全部已建并接线，但唯一消费者是 `examples/layout-demo` 与 `spike/popout`。

## NO-GO 矩阵（每项 + 依据）

| 候选采纳 | 判决 | 依据 |
|---|---|---|
| 弃 ownsWindows → Window facade（windows.main + DeckWindow.onClose + newSession） | **NO-GO** | 零用户可见收益。`ownsWindows:true` 下 `runtime.windows.main === null`，DeckSession 只能管 `runtime.view` 创建的视图，替代不了 devtools 的 IPC registry 与 workspace teardown。close→back 已硬化（仅 teardown session、绝不 dispose registry）。 |
| ViewManager → runtime.view + Compositor | **NO-GO** | ViewManager 是最 load-bearing 子系统，成本极高。Compositor 只折叠 mount/unmount/z，`applyPlacement` 仍逐 view `setBounds`，**无跨 view 原子 bounds commit**。`runtime.view` 只接 URL/file，**无法表达 simulator 的 preload/partition/webviewTag，也接不了 `setDevToolsWebContents` 装载的 Chromium DevTools**。 |
| slot-token / createDeckLayoutClient 取代 view-anchor 直连 | **NO-GO** | 横向平移。anchor 同步发布 + rect 去重已可用；anti-spoof token 只在 untrusted renderer 驱动布局时有意义，devtools renderer 受信。 |
| grants / ControlBus 取代 senderPolicy + wc.id trust | **NO-GO** | 解决 devtools 没有的问题。grants 只保护 `layout.*` ControlBus 命令，替代不了领域 IPC；devtools 无委托布局控制需求。 |
| DeckSession.reset 用于 close→back | **NO-GO** | DeckSession 无注册任意 devtools 资源的入口。 |
| popout（新功能）via windows.create + moveTo({rehome}) | **NO-GO** | renderer 零 popout 需求信号。`spike/popout` 证明 deck **自建**的普通 WCV 可 live-migrate（同一 `WebContents` 跨窗迁移、不 reload），但 simulator / DevTools WCV 的构造方式 `runtime.view` 表达不了——要先把 overlay 所有权迁到 `runtime.view` handle 才谈得上 moveTo。封存为未来产品想法。 |

## 已固化的事实（防止基于错误前提重提）

- **simulator bar 不被原生 WCV 盖**：simulator WCV 只覆盖两个 toolbar 之间的 placeholder
  区域（simulator-panel.tsx 的 `useViewAnchor` 锚到 placeholder rect）。这不是未解痛点。
- **renderer DOM 可提顶**：约束是 renderer 内 DOM 不能与兄弟原生 View 做元素级 z 交错；但主
  renderer 本身是 container 第一个子 View，Electron 允许 re-add View 提顶。
- **Compositor 不批量提交 bounds**：它不解决拖 splitter 掉帧——那是结构性存在但 Compositor 之外的问题。
- **settings/popover 用原生 WCV overlay 是 UX 取舍**：改真模态是更简单的非-deck 方案，但模态会盖住
  下方的原生 DevTools。要求 overlay 下方的原生 DevTools 继续可见可交互时，原生 overlay 才是正解
  （透明背景不给命中穿透；`setIgnoreMouseEvents` 只在 BrowserWindow 上、View 没有）。这是产品 UX
  决定，与 deck 无关。

## 重启条件（满足任一才重新评估对应项）

- 出现**第二个真实外部消费者**需要 Window facade / runtime.view（框架面经真实负载验证后，可作独立
  评估）。
- 产品确认接受 settings **模态化** UX（下方 DevTools 不再可见）→ 在 devtools 侧实现纯 DOM 弹层路径，
  不碰任何 deck 高层 API。
- devtools 出现真实 **popout** 需求，且届时面板已是独立 `runtime.view` WebContents（先决条件）。

## 对 electron-deck 侧的连带结论

高层 host 面在 `types.ts` 标 `@experimental`（无生产消费者、未 API 稳定）；`grants.issue` 的
`targetScope` 标为 **INERT**（dispatch 不读取）。在第二个真实消费者出现前不再继续加高层糖。
