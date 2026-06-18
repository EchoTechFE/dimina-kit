# ProjectWindowLayout — 项目窗口布局（IDE-dockable）

> 入口目录：`packages/devtools/src/renderer/modules/main/features/project-runtime/`。
> 项目窗口的内容区是**单一可拖拽 docking 布局**：`<DockView>`（`@dimina-kit/electron-deck/dock-react`）
> 渲染一棵领域中立的 **layout-as-data** 树（`@dimina-kit/electron-deck/layout`）。用户可自由拖拽
> re-dock 面板、切 tab、分屏、**关闭面板**（tab 上的 close 控件，守卫整树最后一个面板），并把布局
> 序列化持久化、下次恢复。
>
> 配套文档：[`editor-integration.md`](./editor-integration.md)（editor 面板）、
> [`simulator-render-architecture.md`](./simulator-render-architecture.md)（simulator WCV / DeviceShell）、
> [`deck-adoption-decision.md`](./deck-adoption-decision.md)（为何只采纳 deck 的布局引擎、不采纳其高层 host API）、
> `packages/electron-deck/docs/architecture.md §0.5`（布局引擎本体）、
> `packages/view-anchor/README.md`（原生 overlay 的 bounds 同步原语）。

## 摘要（TL;DR）

- **布局是数据**。一棵不可变 `LayoutTree`（`SplitNode` 容器 + `TabGroupNode` 标签组）描述整个项目
  窗口内容区。引擎是领域中立的 `@dimina-kit/electron-deck/layout`，devtools 侧只提供 **panel
  registry + 默认树种子 + fallback-safe 恢复**（`layout/dock-layout.ts`）。
- **`<DockView>` 是唯一布局渲染器**。它读 `LayoutModel`（单写者可观察模型）渲染 docking UI，处理
  拖拽 re-dock / tab / 分隔条 resize。没有第二条布局路径、没有 mode、没有 preset 工具栏。
- **七个 dock 面板**：`simulator` / `editor` / `wxml` / `appdata` / `storage` / `console` /
  `compile`。其中 `wxml`/`appdata`/`storage`/`compile` 是各自独立的 dock 面板，每个经
  `DebugTabContent` 渲染单 tab 内容。
- **面板分两类**：
  - **DOM 面板**（editor / wxml / appdata / storage / compile，以及 **simulator**）——经
    `renderDomPanel(panelId)` 渲染 React 内容。
  - **原生面板**（**console**）——主进程 `WebContentsView`，经 `<DockView>` 的 NativeSlot 暴露一个
    空 DOM 槽，再由一个 `view-anchor` 锚点把 WCV 贴到该槽。
  - **simulator 比较特殊**：它在引擎里登记为 **DOM 面板**（这样 `SimulatorPanel` 能渲染设备/缩放
    chrome——裸 NativeSlot 不画 chrome），但 `SimulatorPanel` **自己**持有 simulator WCV 的
    `view-anchor` 锚点，把设备区 WCV 贴到它内部的空占位 div。所以实际仍有**两个**主进程 overlay
    （simulator + console），各自的 bounds 由一个 anchor 跟随各自的空 DOM 槽。
- **editor 不是 overlay**：renderer 内 `<MonacoEditor/>`，由 React 自挂载/卸载，不发 bounds、不经
  view-manager。
- **simulator 列宽 minPx 下限**：引擎的 **per-child `minPx` `constraint`** 把 simulator leaf 下限设到设备
  像素宽，分隔条拖拽与权重缩放都不改它；切设备时在模型里 `setConstraint` 重新 pin。
- **序列化 / 恢复**：DockView 的每次布局 mutation 经 `serializeLayout` 持久化成不透明字符串
  （`useLayoutStore` 的 `dockTree`）；下次开项目 `parseLayout` + `validateTree` 通过才原样恢复，
  否则 fallback 到默认树。

## 1. 数据模型（来自布局引擎）

完整类型在 `@dimina-kit/electron-deck/layout`（`src/layout/types.ts`，纯 TS、不 import electron/react）。
核心 shape：

```ts
type Orientation = 'row' | 'column'

interface SizeConstraint { readonly fixedPx?: number; readonly minPx?: number } // 二选一:fixedPx=锁死/minPx=柔性下限

interface SplitNode {
  readonly kind: 'split'
  readonly id: string
  readonly orientation: Orientation
  readonly children: readonly LayoutNode[]
  readonly sizes: readonly number[]                       // 每子一份权重
  readonly constraints?: readonly (SizeConstraint | null)[] // 可选；null=权重，{fixedPx}=锁死，{minPx}=柔性下限
}

interface TabGroupNode {
  readonly kind: 'tabs'
  readonly id: string
  readonly panels: readonly string[]                      // panelId，顺序=tab 顺序
  readonly active: string                                 // ∈ panels
}

type LayoutNode = SplitNode | TabGroupNode
interface LayoutTree { readonly version: 1; readonly root: LayoutNode }
```

**面板登记**（`PanelRegistry`，`createPanelRegistry()`）：每个 panelId 映射一个 `PanelDescriptor`：

- `{ kind: 'dom', id, title? }` — renderer 内 React 内容。
- `{ kind: 'native', id, title?, nativeRef: { id } }` — 主进程 view；`nativeRef` 是 electron-free
  的不透明句柄，由 host 自己映射回真 WCV。

**可观察模型**（`LayoutModel`，`createLayoutModel(tree)`）：单写者。

- `get()` — 当前树。
- `apply(mut)` — 用一个纯函数 mutation（树→树）更新，广播订阅者。
- `subscribe(snap)` — 订阅 `{ tree, revision }` 快照。

**mutation 纯函数**（树→树，引擎提供）：`movePanel` / `splitPanel` / `closePanel` / `setActive` /
`setSizes` / `setConstraint` / `extractPanel` / `insertPanel`。

**序列化 / 校验**：`serializeLayout(tree)` → 不透明字符串；`parseLayout(str)` 往返；
`validateTree(tree, knownPanelIds)` 返回违规列表（结构非法 / 引用未知 panelId）。

## 2. devtools 侧装配（`layout/dock-layout.ts` + `project-runtime.tsx`）

devtools 不实现任何分栏/resize/拖拽逻辑——那些全在引擎与 `<DockView>` 里。devtools 只做三件事：

### 2.1 panel registry（`buildDockRegistry()`）

登记七个面板。除 `console` 是 `native`（`nativeRef: { id: 'console' }`）外，其余六个
（simulator / editor / wxml / appdata / storage / compile）都是 `dom`。

每个 descriptor 还带引擎的 `PanelCapabilities` 约束拖拽：

- `simulator` / `editor` 是结构面板，`draggable: false`——tab 不可被拖起，且不可作落点锚（别的面板
  不能 join/split 到它们上面）；并 `hideTab: true`——它们自带 chrome（设备选择器 / 文件路径条），
  引擎 tab 冗余，故这两个组**不渲染 tab 条**（组里全是 hideTab 面板时整条 tab strip 省掉，body 占满）。
- 五个 debug 面板（wxml / appdata / storage / console / compile）`dropPolicy: 'reorder-only'`——可拖，
  但只能在自己的标签组内**重排**，永远拖不出去到 simulator / editor 区域。

约束的**判定与执行全在引擎 / DockView**（见 §5）；devtools 只在 registry 声明能力。

### 2.2 默认树种子（`buildDefaultDockTree(simPanelWidth)`）

新装/无持久化时的初始布局：一个 `row` split——

- 前缘是 simulator 标签组，用 `constraints[0] = { minPx: simPanelWidth }` + 小权重，初始 clamp 到设备宽、可拖大；
- 其余是一个 flex 列：editor 在上、一个标签组在下，该标签组按微信开发者工具的固定顺序并排
  `wxml` / `appdata` / `storage` / `console` / `compile` 五个 debug 面板，默认 active `wxml`。

simulator 子是 minPx 柔性下限（也算柔性）、sibling 是权重（`null`）——引擎只拒绝「全 fixedPx」的 split（`validateTree`），
所以必须留至少一个权重子。

### 2.3 fallback-safe 恢复（`buildDockModel` / `restoreTreeOrDefault`）

从持久化的不透明序列化树建 `LayoutModel`。只有「`parseLayout` 往返成功 **且** `validateTree`
对已知 panelId 集合零违规」的树才原样恢复；`null` / 坏 JSON / 结构非法 / 引用了未知面板的树**全部**
fallback 到 `buildDefaultDockTree(simPanelWidth)`。

### 2.4 串联点（`project-runtime.tsx`）

- 模型与 registry 由 `ProjectRuntime` 在 `useState`/`useMemo` 初始化器里**同步**建（种子读一次；之后
  持久化变更不重建模型——否则会丢用户的实时拖拽）。`ProjectRuntime` 在挂载点（`main.tsx`）已
  `key={project.path}`，故切项目时整体 remount、模型按新项目的持久化树干净重新种子。模型上提到
  `ProjectRuntime`（而非 `<DockableLayout>` 内部）是为了让**工具栏的「面板」菜单**与 `<DockView>`
  共用同一个 `LayoutModel`。
- `<DockableLayout>` 收到 `dockModel` / `dockRegistry` 作为 prop，渲染
  `<DockView model registry renderDomPanel bindNativeSlot/>`。
- `renderDomPanel(panelId, { active })`：`simulator` → `<SimulatorPanel/>`（设备/缩放 chrome +
  自有 WCV anchor）；`editor` → `<MonacoEditor/>`；四个 React debug tab → `<DockDebugTab active=…/>`
  （包一层 `DebugTabContent`，在 `active` 的 false→true 边沿触发该 tab 的数据 refresh）；`console`
  不走这里（由 DockView 路由到 NativeSlot）。所有 DOM 面板由 DockView **keepalive**（切 tab 不
  卸载、非 active 用 `display:none` 隐藏），故 refresh 改由 `active` 边沿驱动而非挂载——切走再
  切回仍会重新 refresh，且滚动 / 展开态得以保留。
- `bindNativeSlot(panelId, el)`：只对 `console` 生效——用 `view-anchor` 的
  `createPlacementAnchor` 把 Console DevTools WCV 贴到 DockView 给的空槽。
- DOM 面板 body 容器（`[data-deck-panel-body]`）是 **flex column**（active 时 `display:flex`），故面板根
  用 `flex-1`/`height:100%` 就能撑满 body 高度——少了这个 flex 容器，`flex-1` 的根会塌成内容高、下方
  留空（#51 引入、`dock-tab-reorder.spec.ts` 钉死）。
- 订阅模型，每次 mutation `serializeLayout` 回写 `useLayoutStore` 持久化（`onPersistTree`）。

### 2.5 面板显隐开关（`<LayoutVisibilityToggles>` + `reopenPanel` / `listPanelVisibility`）

dock 模型里「隐藏」一个面板就是 `closePanel`（tab 上的 ×，或工具栏开关关掉）——它从树里整个移除。
工具栏恢复了 dockable 重写前那套**内联图标开关**（`components/layout-controls.tsx`）：模拟器 / 编辑器 /
调试器三个图标按钮，active=实心图标 + 高亮 chip，与历史一致。

- `listPanelVisibility(tree, registry)`（`dock-layout.ts` 纯函数）枚举每个已登记面板 + 它当前是否在树里，
  组件据此算三个区域的显隐态；订阅模型，实时反映 ×/拖拽/另一处开关造成的变化。
- 关 = `closePanel`；开 = `reopenPanel(tree, id, simPanelWidth)`（`dock-layout.ts` 纯函数）把已关面板**按
  默认布局的结构位**重新插回：debug 面板并入仍在场的默认同组伙伴（无伙伴则在 editor 下 / simulator 旁
  重建调试区）；`editor` 重 split 到调试区上方；`simulator` 重 split 成前缘列并**重置 `minPx` 下限**。
  对已显示的面板幂等（原样返回，不抛错 / 不重复）。
- 「调试器」开关把五个 debug 面板当一个区域整体显隐。整树最后一个可见区域的开关禁用（引擎对「关掉
  唯一面板」no-op，禁用以免 UI 失同步）。

同一文件还原了**布局预设**两组控件（也来自 dockable 重写前的工具栏）：

- `LayoutAlignmentToggle`——模拟器左/右对齐；`LayoutDevtoolsPositionToggles`——调试器位置三选一
  （编辑器内 / 模拟器下 / 模拟器右）。
- 点击任一预设按钮 = `model.apply(() => buildPresetDockTree(simPanelWidth, alignment, position))`，**整树重排**
  成该预设布局（dock 世界里的「重置成此布局」，等同旧 FrameTree 预设；会覆盖用户的自由拖拽）。
  `buildPresetDockTree`（`dock-layout.ts`）按 (对齐 × 位置) 产出 6 种树，模拟器列恒定宽 pin。`inEditor`+`left`
  即等于 `buildDefaultDockTree`。
- 当前 alignment / position 存在 `useLayoutStore`（`simulatorAlignment` / `devtoolsPosition`，持久化），只用于
  按钮高亮 + 预设重建的输入轴；自由拖拽**不**更新它们（故高亮反映「上次选的预设」）。

## 3. 原生 overlay 的 bounds 同步（view-anchor）

bounds 同步由引擎无关原语 `@dimina-kit/view-anchor` 提供（core 零 React / 零 Electron，把「DOM rect
→ 主进程 view bounds」的跨进程桥独立出来；DOM 布局库——含 dockview——刻意不提供这道桥）。两个原生
overlay 各注册一个锚点。

**simulator overlay**（在 `<SimulatorPanel>` 自身）：panel 只画 toolbar + 一个空 flex:1 占位 div
（`data-area="native-simulator"`）+ 路径 bar，**不画手机框、不渲染 `<webview>`**。占位 rect（带
`zoom`）经 anchor 发到 `setNativeSimulatorViewBounds`。设备框 / 圆角 / 刘海 / 页面 `<webview>` 全在
那个 WCV 内部的 DeviceShell 里画（见 `simulator-render-architecture.md`）。anchor 选项与 console
同形：`guardDisplayNone: true`（A3 keepalive 下 simulator tab 失活时占位是 `display:none`、面板**不
卸载**，必须据此 detach WCV，否则它会悬在新激活面板之上）+ `followGeometry: true`（minPx 列可拖宽，拖
相邻 splitter 只平移不 resize，几何哨兵重发 rect）。

**console overlay**（在 `<DockableLayout>` 的 `bindNativeSlot`）：Console DevTools 是另一个 WCV。
DockView 把 console 渲染成一个空 DOM 槽（NativeSlot），`bindNativeSlot('console', el)` 用
`createPlacementAnchor` 把 WCV 贴到该槽，bounds 经 `publishSimulatorDevtoolsBounds` →
`setSimulatorDevtoolsBounds`。anchor 选项：

- `guardDisplayNone: true` — console tab 非激活时槽是 `display:none`，必须**detach**（发 hidden
  收起 WCV），而不是在活内容上盖一个 0×0 rect。
- `followScroll: true` — 跟随祖先滚动。
- `followGeometry: true` — 拖拽 re-dock 可能**平移**槽而不改尺寸（ResizeObserver 看不到纯 translate），
  几何哨兵据此重发 rect。

**editor** 是 renderer 内 Monaco，不是 overlay，无锚点。整套 layout 共两个锚点（simulator + console）。

### 3.1 Placement / detach 语义

原生 overlay 的 lifecycle 由「槽是否可见 + 槽 rect」单一驱动（语义来自 view-anchor 的 `Placement`）：

- **可见 + 槽挂载**：发真实 `getBoundingClientRect()`，并挂 ResizeObserver / scroll / 几何哨兵，后续
  几何变化经合帧重发。
- **不可见 / 槽 `display:none` / 槽卸载**：发一次 ZERO `{0,0,0,0}` 收起 WCV——主进程
  `setSimulatorDevtoolsBounds` / `setNativeSimulatorViewBounds` 见零面积 ⇒ `removeChildView`，**保留
  WebContents 存活**（detach-but-keep-alive），下次 re-attach 即秒变。

## 4. simulator 列宽：minPx 下限（可拖、保设备宽）

simulator 列**可被分隔条拖宽**（像微信开发者工具），但**永远不小于设备逻辑宽**。这由引擎的
per-child **`minPx`** 约束表达（区别于 `fixedPx` 锁死）：默认树把 simulator 子 pin 成
`{ minPx: simPanelWidth }` + 一个**小权重**——DockView 把它当柔性子（参与权重）但给 rrp `Panel` 一个
`minSize=${minPx}px` 下限，小权重让它**初始 clamp 到设备宽**，用户拖分隔条可加宽。手机始终按设备宽在
WCV 内由 DeviceShell 居中（列变宽 = 灰边变多，WCV 经 `followGeometry` 跟随 rect 变化重发，phone 不拉伸）。

切设备（picker 改 `simPanelWidth`、不 remount）时，`<DockableLayout>` 的 effect 在模型里
`setConstraint(t, splitId, childIndex, { minPx: simPanelWidth })` **重新 pin 下限**：

- `findSimulatorConstraintSite` 走整棵树，找「带 constraint 且子树含 `simulator` 面板」的第一个子
  （按「子树含 simulator」而非「就是 simulator 标签组」匹配——edge-drop 到 simulator 后嵌套 split，
  constraint 仍留在该子树上，重 pin 依然正确）。
- 下限已等于目标宽则跳过（不冗余 emit）。
- 找不到（simulator 被 re-dock 进某个无约束组）则跳过，不瞎猜。

真机指针拖拽（拖宽 + 拖到下限不塌）由 `e2e/dock-separator-drag.spec.ts` 覆盖。

## 5. 拖拽 re-dock / tab / 分屏 / 序列化（DockView）

这些交互全在 `<DockView>`（`@dimina-kit/electron-deck/dock-react`）里，devtools 不实现：

- **拖拽 re-dock**：HTML5 DnD，抓 tab → drop 到目标区，引擎据此做 `split`（分屏）或 `tab`
  （并入标签组）mutation。纯几何的 drop-zone 计算（`computeDropZone` / `dropZoneToMutation` /
  `isNoopRedock`）从 `/dock-react` entry 导出。
- **能力约束**（§2.1 的 `PanelCapabilities`，DockView 在 `handleRedock` 单点执行）：`draggable:false`
  的面板 tab 不渲染 `draggable` 标记、且作为落点锚时拒绝一切 drop；`dropPolicy:'reorder-only'` 的面板
  只能在自己组内重排，跨组 / 任何 edge-split 一律 no-op。**重排落点是 tab 条本身**：tab 条在组顶，直接
  落在组上会被 `computeDropZone` 判成 `top` 边而 no-op，故 DockView 给 tab 条单独挂 drop——
  `computeReorderIndex(指针 x → 插入位)` 提交一次组内 move。真机手势由 `e2e/dock-tab-reorder.spec.ts`
  覆盖（jsdom 几何为 0 测不了）。
- **tab**：同一标签组内切 active（`setActive`），或拖出/拖入面板。
- **分屏 resize**：拖分隔条 → `setSizes` 改权重（fixed-px 子不受影响）。分隔条（rrp `Separator`，
  `[data-deck-resize-handle]`）和 tab 一样是**引擎无样式**的，宿主必须给它尺寸/抓取区——`design.css`
  补了 10px 命中区 + 1px 线 + ring 高亮；缺这套皮肤时分隔条塌成 0px、根本抓不动（只有程序化
  `__deckApplyLayout` seam 能改，故旧 e2e 没暴露）。真机指针拖拽由 `e2e/dock-separator-drag.spec.ts` 覆盖。
- **序列化 / 恢复**：每次 mutation 触发模型订阅 → `serializeLayout` 回写持久化；下次开项目按 §2.3
  恢复。

## 6. 与现有架构的契约

### 6.1 与 `useLayoutStore` 的接口

布局持久化以**不透明字段** `dockTree`（序列化布局树字符串）为主。`useLayoutStore` 提供
`state.dockTree` + `setDockTree(serialized)`。面板的显隐 / 排布全在 dock 树里——「显」= 在树里、「隐」
= 不在树里，没有独立的可见性字段；工具栏的显隐开关（§2.5）也只是对这棵树做 `closePanel` / `reopenPanel`。
另有两个**布局预设轴** `simulatorAlignment` / `devtoolsPosition`（§2.5）持久化在同一 store，仅作预设按钮的
高亮 + `buildPresetDockTree` 重建的输入——它们不是 dock 树的旁路真相（自由拖拽不更新它们）。

### 6.2 与主进程 view-manager 的接口

只有原生面板走这条接口，当前两个：**simulator**（native-host WebContentsView，bounds 带 `zoom`，
经 `setNativeSimulatorViewBounds`）和 **console**（Console DevTools，经 `setSimulatorDevtoolsBounds`）。
两者都按「零面积 ⇒ `removeChildView` 保活、非零 ⇒ `addChildView` + `setBounds`」处理；simulator 额外
把 `zoom/100` 当 WCV 的 `zoomFactor`。**editor 不在这条接口上**——renderer 内 `<MonacoEditor/>`，
React 自挂载/卸载，不发 bounds。

**原生 overlay 的 z 叠放**：`addChildView` 按插入序叠放（后插者在上），simulator / console 属「基层」、
settings / popover 属「顶层」。基层 overlay 因 tab 切换 / 几何重发而**重新 `addChildView`** 时会跳到栈顶、
盖住已打开的设置/popover——故 view-manager 在每次基层 add 后调 `raiseTopOverlays()` 把仍打开的
settings / popover 重新 append 回顶层（两者都没开时是 no-op）。这样设置面板始终压在 simulator 之上。

### 6.3 与布局引擎 / DockView 的边界

devtools 只提供 panel registry + 默认树 + 恢复策略 + 两个原生 overlay 的 anchor wiring。所有
**分栏 / 嵌套 / resize / 拖拽 re-dock / tab / 序列化**逻辑都是引擎与 DockView 的职责，devtools 不
碰。引擎不 import electron/react（`boundary.test.ts` 钉死），原生面板只引用不透明 `NativeHandleRef`。

## 7. 扩展指南

### 7.1 加一个新 DOM 面板（renderer 内 React 内容）

1. `layout/dock-layout.ts` — `buildDockRegistry()` 加 `registry.register({ kind: 'dom', id, title })`。
2. `project-runtime.tsx` — `DOCK_PANEL_IDS` 加新 id；`renderDomPanel` 加一个分支返回它的 React 节点。
3. （可选）`buildDefaultDockTree` — 若想让新面板默认出现，把它放进某个标签组。否则用户可拖进来 /
   从命令入口加（取决于上层 UI）。

无需碰 view-manager、无需 anchor——DOM 面板由 React 自挂载/卸载。

### 7.2 加一个新原生面板（主进程 WebContentsView overlay）

1. `buildDockRegistry()` 加 `registry.register({ kind: 'native', id, title, nativeRef: { id } })`。
2. `project-runtime.tsx` — `DOCK_PANEL_IDS` 加 id；`bindNativeSlot(panelId, el)` 加分支，用
   `createPlacementAnchor` 把该 view 的 bounds 发到一条新 IPC（参考 console 分支的 `guardDisplayNone`
   / `followScroll` / `followGeometry` 选项）。
3. **主进程** — 加 IPC channel + handler + view-manager 的 `set<Name>Bounds`（零面积 ⇒
   removeChildView 保活）+ `view-api.ts` 的 publish wrapper（参考 `setSimulatorDevtoolsBounds`）。

### 7.3 加一个 fixed-px 保真约束（像 simulator 那样锁某个 leaf 的尺寸）

在默认树相应 split 的 `constraints[i]` 写 `{ fixedPx }`，并保证同 split 至少留一个权重子
（`validateTree` 拒绝全 fixed）。若该尺寸会动态变（像设备宽），在串联组件里加一个 effect 用
`setConstraint` 重新 pin（参考 §4 的 simulator re-pin）。

## 8. 已知限制 + Backlog

| # | 限制 | 说明 |
|---|---|---|
| 1 | reload project 后原生 overlay 不重新 attach | 属 view-manager 的 reload-state 管理；本层只在切项目时（remount）重新种子 + 重新发 bounds，若主进程把 view destroy 了再发 bounds 也无效。editor 由 `<MonacoEditor/>` 自己重读文件列表处理。 |
| 2 | 序列化树是不透明字符串 | 只作持久化 round-trip，不当 diff key、不在外部解读结构。 |

## 9. 文件清单

| 文件 | 角色 |
|---|---|
| `packages/electron-deck/src/layout/` | layout-as-data 引擎（纯 TS）：树/registry/model 类型、mutation 纯函数、`serialize`/`validateTree`、`createLayoutModel` |
| `packages/electron-deck/src/dock-react/` | `<DockView>` 渲染器 + 纯几何 drag-to-redock |
| `packages/view-anchor/` | 引擎无关 bounds 同步原语（`createPlacementAnchor` / `useViewAnchor`；见其 `README.md`） |
| `src/renderer/modules/main/features/project-runtime/layout/dock-layout.ts` | devtools 侧：panel registry + 默认树种子 + fallback-safe 恢复（`buildDockRegistry` / `buildDefaultDockTree` / `buildDockModel`） |
| `src/renderer/modules/main/features/project-runtime/project-runtime.tsx` | 串联点：`<DockableLayout>` 建模型 + 渲染 `<DockView>` + console anchor + simulator fixed-px re-pin + 持久化订阅 |
| `src/renderer/modules/main/features/project-runtime/controllers/use-layout-store.ts` | `dockTree` 不透明持久化（`state.dockTree` + `setDockTree`） |
| `src/renderer/modules/main/features/project-runtime/components/simulator-panel.tsx` | simulator DOM 面板：toolbar + flex:1 占位 + 路径 bar，自带 anchor 把占位 rect（带 zoom）发给 simulator WCV |
| `src/renderer/modules/main/features/bottom-debug-panel/bottom-debug-panel.tsx` | `DebugTabContent`（单 tab 内容渲染器，被四个 DOM debug 面板 wxml/appdata/storage/compile 复用；console 是原生 WCV 不走它）+ `BottomDebugPanelProps` / `DebugTabContentId` 类型 |
| `src/renderer/modules/main/features/monaco-editor/` | editor DOM 面板的 renderer 内 Monaco 实现（细节见 `editor-integration.md`） |
| `src/main/services/views/view-manager.ts` | `setNativeSimulatorViewBounds`（simulator WCV）+ `setSimulatorDevtoolsBounds`（Console DevTools），均零面积 ⇒ removeChildView 保活 |
| `src/main/ipc/views.ts` | IPC handler → view-manager |
| `src/renderer/shared/api/view-api.ts` | `setNativeSimulatorBounds` + `publishSimulatorDevtoolsBounds` IPC wrapper |
| `src/main/ipc/project-fs.ts` | editor 文件读写的沙盒 IPC（`project:fs:*`） |
