# devtools 是否采纳 electron-deck 高层 host API — 决策记录

> 状态：**已决（2026-06-13）**。结论 = devtools 维持 `ownsWindows:true` 旁路集成，**不**迁移到
> electron-deck 的高层 host API。本文是「止血」记录——这个判断已被反复重提多次，这里固化论据
> 与重启条件，避免再次空耗。评审过程：两路调研 subagent 对账 main 真实代码 + codex 对抗评审。

## 背景

electron-deck 是从 devtools 抽出的领域中立 Electron host-shell 框架。在抽取过程中，框架侧
**超前于消费者（infra-ahead）** 建造了一整套高层 host API 并全部接线：

- Window facade：`runtime.windows.create/.main/.adopt` → `DeckWindow{onClose,newSession}`
- `runtime.view` → `DeckViewHandle`（placeIn/moveTo/applyPlacement/keepAlive LRU）
- `runtime.scopes.create` → 密封 `DeckSession`（reset）
- `runtime.grants.issue` + capability 闸 + `runtime.layout.command`（ControlBus）
- Compositor（per-window z 事务化 commit）
- slot-token 通道 + `createDeckLayoutClient`

**这些全部已建并接线**（见 `packages/electron-deck/docs/architecture.md §5`），但**唯一的消费者
是 `examples/layout-demo` 与 `spike/popout`**。devtools 与 qdmp 都经 `RuntimeBackend` 生命周期
路径、以 `ownsWindows:true` 集成，从不触碰这套高层面（证据：`devtools-backend.ts` 的 `ownsWindows:true`、
`view-manager.ts` 全程裸 `addChildView/setBounds`、`workbench-context.ts` 只用 `/main` 低层原语）。

## ROI 决策矩阵（每项 NO-GO + 论据）

| # | 候选采纳 | 判决 | 核心论据 |
|---|---|---|---|
| F1 | 弃 ownsWindows → Window facade（windows.main + DeckWindow.onClose + newSession） | **NO-GO** | 零用户可见收益；成本/风险高。`ownsWindows:true` 下 `runtime.windows.main===null`，DeckSession 只能管 `runtime.view` 创建的视图、**替代不了** devtools 的 IPC registry 与 workspace teardown。close→back 已硬化（app.ts:280-302，仅 teardown session、绝不 dispose registry）。 |
| F2 | ViewManager → runtime.view + Compositor | **NO-GO** | 成本极高（ViewManager 是最 load-bearing 子系统）。**且解决不了它名义要解决的痛点**：Compositor 只折叠 mount/unmount/z，`applyPlacement` 仍逐 view `setBounds`（view-handle.ts:372），**无跨 view 原子 bounds commit**。更致命：`runtime.view` 只接 URL/file，**无法表达 simulator 的 preload/partition/webviewTag，也接不了 `setDevToolsWebContents` 装载的 Chromium DevTools**（view-manager.ts:816,1078）。 |
| F3 | slot-token / createDeckLayoutClient 取代 view-anchor 直连 | **NO-GO** | 横向平移。devtools 路径可用，anchor 同步发布 + rect 去重（view-anchor.ts）。anti-spoof token 只在 untrusted renderer 驱动布局时有意义——devtools renderer 受信。前提还得先做 F2。 |
| F4 | grants/ControlBus 取代 senderPolicy+wc.id trust | **NO-GO** | 解决 devtools 没有的问题。grants 只保护 `layout.*` ControlBus 命令，替代不了领域 IPC。devtools 无委托布局控制需求。 |
| F5 | DeckSession.reset 用于 close→back | **NO-GO** | F1 子集；DeckSession 无注册任意 devtools 资源的入口。 |
| F6 | popout（新功能）via windows.create + moveTo({rehome}) | **NO-GO（现在）** | renderer 零 popout 需求信号；依赖先做 F2 才能 moveTo。spike 只证明 deck **自建**的普通 WCV 可 live-migrate——simulator/DevTools WCV 的构造方式 `runtime.view` 无法表达。封存为未来产品想法。 |

## 已纠正的事实（防止再次基于错误前提重提）

- **痛点 A（simulator bar 被原生 WCV 盖）已经解决**：simulator WCV 现在只覆盖两个 toolbar 之间的
  placeholder 区域（simulator-panel.tsx 的 `useViewAnchor` 锚到 placeholder rect，约 :69）。不要再把它当未解痛点。
- **"DOM 永远无法浮到原生之上 = Electron 物理"是过度断言**：真正的约束是 renderer 内 DOM 不能与
  兄弟原生 View 做**元素级 z 交错**；但主 renderer 本身是 container 第一个子 View，Electron 允许
  re-add View 提顶。
- **痛点 B（settings/popover 做成原生 WCV overlay）有一个更简单的非-deck 方案**：把 settings 改成
  真模态（打开时隐藏原生 views 或临时把全屏 mainWebView 提顶）。**但有 UX 代价**：模态会盖住下方的
  原生 DevTools。**若要求 overlay 下方的原生 DevTools 继续可见可交互，现在的原生 overlay 才是正解**
  （透明背景不给命中穿透；`setIgnoreMouseEvents` 只在 BrowserWindow 上、View 没有）。这是一个**产品
  UX 取舍，与 deck 无关**——需要产品决定，不该伪装成基础设施迁移。
- **F2 的"Compositor 批量 commit 改善拖 splitter 掉帧"是错误的 pro 论据**：Compositor 不批量提交
  bounds（见上）。痛点 E 结构上存在但 Compositor 不解决它。

## 重启条件（满足任一才重新评估对应项）

- 出现**第二个真实外部消费者**需要 Window facade / runtime.view（届时框架面经真实负载验证，F1 可作
  独立 PR + 全量真机 e2e 评估）。
- 产品确认接受 settings **模态化** UX（下方 DevTools 不再可见）→ 在 devtools 侧实现纯 DOM 弹层路径，
  **不碰任何 deck 高层 API**。
- devtools 出现真实 **popout** 需求，且届时面板已是独立 `runtime.view` WebContents（先决条件）。

## 对 electron-deck 侧的连带结论（Q5 反转）

与其等 devtools 来"证明这套基础设施存在的合理性"，不如**收敛框架对外承诺**：高层 host 面已在
`types.ts` 标注 `@experimental`（无生产消费者、未 API 稳定），`grants.issue` 的 `targetScope`
标注为**当前 INERT**（dispatch 不读取）。在第二个真实消费者出现前不再继续加高层糖
（`deck.resize/popout/overlay` 暂缓）。

## 本轮实际落地（实现 = 卫生级，无迁移）

1. deck 文档 drift 修正（`view-handle-build-plan.md` 等声称"未建/休眠"实则已建的状态断言）。
2. 高层 deck API + `targetScope` 标 `@experimental`（types.ts）。
3. 清 devtools 陈旧注释（project-toolbar.tsx 把 dropdown 被弃归因于已不存在的 editor WCV）。
4. 本决策记录 + `devtools-backend.ts` 注释指向它。
