# ProjectWindowLayout — 项目窗口布局抽象层

> 入口目录：`packages/devtools/src/renderer/modules/main/features/project-runtime/layout/`。
> `compileProjectWindowLayout` → `FrameTree` 两段纯函数管线接管三宫格区域（simulator / editor / debug）的拓扑构造与渲染；唯一仍是主进程 overlay 的 cell 是 debug 区的 Chromium DevTools，它的 bounds 由 `useViewAnchor`（`@dimina-kit/view-anchor`）单锚点同步。

> **editor 是 renderer 内组件，不是 overlay。** editor cell 渲染为普通 React flex 子节点 `<MonacoEditor/>`（根 div 带 `data-area="editor"`），由 React 自行挂载/卸载，**不发 bounds、不经 view-manager**。simulator 是 `<webview>`，也不是 overlay。**整套 layout 里唯一的主进程 overlay 是 debug 区的 Console DevTools**（`view:simulator:devtools-bounds` + `setSimulatorDevtoolsBounds`），由 `project-runtime.tsx` 里**一个** `useViewAnchor` 锚点驱动。编辑器细节见 [`editor-integration.md`](./editor-integration.md)；bounds 同步原语见 `packages/view-anchor/README.md`。

## 摘要（TL;DR）

**词汇**：

- **cell** — 业务区域。当前三个：`simulator` / `editor` / `debug`。命名由 `CellId` 联合类型定义。
- **frame** — 布局树节点。`row` / `column` 是容器，`leaf` 持有一个 `cellId`。
- **slot** — 父子之间的边。每个 `FrameChild` 描述一条 slot，带 `outerSize`（父对子的 sizing 契约）和 `slotId`（位置标识，给 react-resizable-panels 当 Panel id 用）。
- **overlay bounds** — 主进程 WebContentsView 在 main window 内的像素矩形。当前唯一的 cell overlay 是 debug 区的 Console DevTools（`view:simulator:devtools-bounds`），其 bounds 由 `useViewAnchor` 把 debug 占位 div 的 rect 发到主进程。
- **anchor** — `useViewAnchor`/`createViewAnchor` 维护的"DOM 元素 ↔ 一个主进程 view bounds"绑定。一个锚点只盯一个元素、驱动一个 view。
- **mode** — `LayoutState` 的 `devtoolsPosition` × `simulatorAlignment` 组合，共 6 个基础形态。

**两段管线 + 一个锚点**：

1. **compile**（`compile.ts`）：`LayoutState`（5 个字段）→ `ProjectWindowLayout`（frame 树 + cells 注册表 + 签名）。所有 `devtoolsPosition / simulatorAlignment / visibility` 的拓扑决策都在这里，是纯函数。
2. **render**（`frame-tree.tsx`）：递归渲染 frame，按子节点的 `outerSize.kind` 派发到 `react-resizable-panels Group` / 纯 flex / 纯 flex + 手写 splitter 三条路径之一。`FrameTree` 自己不做任何 bounds wiring——它原样渲染 caller 给的 `cellNodes[cellId]`。
3. **bounds sync**（`@dimina-kit/view-anchor` 的 `useViewAnchor`）：`project-runtime.tsx` 用**一个**锚点把 debug overlay 的 bounds 绑到 debug 占位 div。`present` 直读 `cells.debug.present`——`present=false` 立即发零 bounds 收起 view，与 DOM lifecycle 解耦。

**最重要的规则**：sizing 是 **parent-edge 性质**，写在 `FrameChild.outerSize`，不在 `Frame` 自身。Container 溶解时上层 slot 的 outerSize 保留，溶解的容器内层 outerSize 丢弃。这条性质让 collapse 逻辑可以纯 local。

**加新 layout mode**（用现有 cell + sizing）只改 2 个点：`LayoutState.devtoolsPosition` 联合扩 + `buildModeFrame` 加分支。

**加新 overlay cell**（首次接入新主进程 view）改：`CellId` 联合 / `LayoutState` 字段 / `buildModeFrame` 放进 frame / `project-runtime.tsx` 里给该 cell 加一个 `useViewAnchor` 锚点 + `cellNodes` 节点 / 主进程 IPC 链。renderer 内 cell（无 overlay，如 editor）则连锚点都不用加。

**只有新增 sizing 语义才动 renderer。**

## 1. 数据模型

完整类型在 `layout/types.ts`。核心 shape：

```ts
type CellId = 'simulator' | 'editor' | 'debug'

interface Cell { id: CellId; present: boolean }

type Frame = FrameRow | FrameColumn | FrameLeaf
interface FrameRow    { kind: 'row';    children: FrameChild[] }
interface FrameColumn { kind: 'column'; children: FrameChild[] }
interface FrameLeaf   { kind: 'leaf';   cellId: CellId }

interface FrameChild {
  frame: Frame
  outerSize: OuterSize       // 父对子的 sizing 契约
  slotId: PanelSlotId        // 位置标识；resizable Group 里当 Panel id 用
}

type OuterSize =
  | { kind: 'fixed-px-with-splitter'; key: 'simPanelWidth'; splitterSide: 'leading' | 'trailing' }
  | { kind: 'flex' }
  | { kind: 'resizable'; defaultSize: number; minSize: number }

interface ProjectWindowLayout {
  root: Frame
  cells: Record<CellId, Cell>
  signature: string          // 拓扑等价类代表元
}
```

**CellId vs slotId 的区分**：

- `CellId` — 业务身份。跨 mode 稳定。`cells` 注册表的 key、`cellNodes` 的 key。
- `slotId` — 父子边的标识。命名约定 `'in-editor-column'` / `'below-sim-column'` / `'right-of-sim-row'`。只在一次 compile 输出内稳定。`<Panel id={slotId}>` 串号不可能（slot 命名空间天然不冲突）。

**总览管线**：

```
LayoutState (持久化, localStorage 'dimina-devtools.layout.v1')
   │  compileProjectWindowLayout()
   ▼
ProjectWindowLayout { signature, cells, root }
   │  FrameTree.render (按 outerSize.kind 派发)
   ▼
React tree (panels Group | plain flex | plain flex + splitter)
   │    ├─ simulator leaf → <SimulatorPanel> (<webview>，非 overlay)
   │    ├─ editor leaf    → <MonacoEditor/>  (renderer 内组件，非 overlay)
   │    └─ debug leaf     → <BottomDebugPanel ref={devtoolsAnchorRef}>
   │                        └─ ref 转给内部 [data-area="simulator-devtools"] 占位
   ▼
useViewAnchor({ present: cells.debug.present, publish: publishSimulatorDevtoolsBounds, deps })
   │  publish → IPC view:simulator:devtools-bounds
   ▼
view-manager.setSimulatorDevtoolsBounds
   │
   ▼  零面积 ⇒ removeChildView（保活）；非零 ⇒ addChildView + view.setBounds
mainWindow.contentView
```

## 2. 不变量与它们禁掉的 bug

| Bug 类 | 不变量 | 执行点 |
|---|---|---|
| sim 列右侧 dead zone | collapse 后没有"fixed-px 但只剩自己"的中间状态 | `compile.ts` `collapseRoot` + `demoteOrphanFixedPx`（`compile.test.ts` 覆盖） |
| overlay cell 消失后 view 不收起（当前命中者：debug） | `cells.debug.present=false` ⇒ 锚点发零 bounds；占位 div detach/unmount ⇒ 锚点发零后 dispose | `useViewAnchor` 的 `present` + ref→null 路径（`@dimina-kit/view-anchor`） |
| iPhone shell 被 panels 百分比缩放 | fixed-px 走 plain flex + 手写 splitter，与 panels 解耦 | `frame-tree.tsx` `renderPlainFlexRow`（`frame-tree.test.tsx` 覆盖） |
| `layoutKey` 字符串 deps 漏维度 | `signature` 是 effect 的唯一 topology dep | `compile.ts` `signatureOf` |
| Panel id 跨 mode 复用 | Group key 由 children slotId 拼成，mode 切 → key 变 → remount | `frame-tree.tsx` `renderResizableGroup`（`frame-tree.test.tsx` 覆盖） |

每一条详解（含旧成因）见 §8 设计决策。

## 3. compile 详解

`compileProjectWindowLayout(state)` 分四步：

1. 构造 `cells` 注册表（`present` 直读 `state.*Visible`）。
2. 全 false 兜底——返回 editor leaf 且 `cells.editor.present=true`，保持「`present=true` ⇒ frame 必含该 leaf」的内部一致性（§5.1），让兜底帧能正常渲染 `<MonacoEditor/>`，不留空 flex 行。（editor 是 renderer 组件，无 overlay，这个 flag 只影响 collapse helper 读到的拓扑，不动主进程。）
3. `buildModeFrame` 假设三 cell 全 visible，按 `devtoolsPosition × simulatorAlignment` 产出基础 frame。
4. `collapseInvisibleCells` → `demoteOrphanFixedPx` → `collapseRoot` 三步压缩。

### 3.1 基础 frame（三 cell 全 visible）

ASCII 图统一格式：`child slot=<id> outer=<size> -> frame=<kind>`。

**inEditor + left**

```
root: row
├─ child slot=simulator        outer=fixed-px-with-splitter(trailing) -> leaf=simulator
└─ child slot=in-editor-column outer=flex                             -> column
   ├─ child slot=editor        outer=resizable(70, 20) -> leaf=editor
   └─ child slot=debug         outer=resizable(30, 10) -> leaf=debug
```

**inEditor + right** — sim 在 row 末尾，splitter 改 leading：

```
root: row
├─ child slot=in-editor-column outer=flex                            -> column (同上)
└─ child slot=simulator        outer=fixed-px-with-splitter(leading) -> leaf=simulator
```

注意 alignment=right 时 sim 是 row 的**末元素**：`alignedRow` 直接重建 children 数组，不依赖渲染时 `children.reverse()`，下游 collapse 看到的就是最终顺序。

**belowSimulator + left**

```
root: row
├─ child slot=below-sim-column outer=fixed-px-with-splitter(trailing) -> column
│  ├─ child slot=below-sim-top    outer=resizable(70, 20) -> leaf=simulator
│  └─ child slot=below-sim-bottom outer=resizable(30, 10) -> leaf=debug
└─ child slot=editor           outer=flex                             -> leaf=editor
```

**rightOfSimulator + left**

```
root: row
├─ child slot=simulator        outer=fixed-px-with-splitter(trailing) -> leaf=simulator
└─ child slot=right-of-sim-row outer=flex                             -> row
   ├─ child slot=debug         outer=resizable(40, 15) -> leaf=debug
   └─ child slot=editor        outer=resizable(60, 20) -> leaf=editor
```

### 3.2 部分可见的塌缩

`collapseInvisibleCells` 是通用 recursive pass：

- leaf `present=false` → 整 leaf 剪掉返回 null。
- 容器所有 child 都被剪 → 容器 null。
- 容器只剩 1 个 child → 容器**溶解**，sibling 升级到上一级，**parent slot 的 outerSize 保持不变**。

示例：`belowSimulator + debug 隐藏`（cells: simulator/editor=present, debug=NOT present）

```
原始 root: row
├─ child slot=below-sim-column outer=fixed-px-with-splitter(trailing) -> column
│  ├─ child slot=below-sim-top    outer=resizable(70, 20) -> leaf=simulator
│  └─ child slot=below-sim-bottom outer=resizable(30, 10) -> leaf=debug
└─ child slot=editor           outer=flex                             -> leaf=editor

      ↓ debug leaf 剪掉 → column 只剩 simulator → column 溶解
      ↓ row 第 0 个 child 的 outer 保留

结果 root: row
├─ child slot=below-sim-column outer=fixed-px-with-splitter(trailing) -> leaf=simulator
└─ child slot=editor           outer=flex                             -> leaf=editor
```

sim 列依然 fixed-px 列宽；debug overlay 自动收到零 bounds（`cells.debug.present=false` 驱动锚点）。

示例：`inEditor + editor 隐藏 + debug 显示`（cells: simulator/debug=present, editor=NOT present）

```
原始 root: row
├─ child slot=simulator        outer=fixed-px-with-splitter(trailing) -> leaf=simulator
└─ child slot=in-editor-column outer=flex                             -> column
   ├─ child slot=editor        outer=resizable(70, 20) -> leaf=editor
   └─ child slot=debug         outer=resizable(30, 10) -> leaf=debug

      ↓ editor leaf 剪掉 → column 只剩 debug → column 溶解
      ↓ row 第 1 个 child 的 outer=flex 保留

结果 root: row
├─ child slot=simulator        outer=fixed-px-with-splitter(trailing) -> leaf=simulator
└─ child slot=in-editor-column outer=flex                             -> leaf=debug
```

debug 升级成 flex 填满右侧。sim 旁边不会露空白。

极端情形 `inEditor + sim 隐藏 + editor 隐藏`：sim 剪掉、column 内 editor 剪掉 → column 溶解 → row 只剩 debug → `collapseRoot` 见 row 单 child → unwrap 成 `FrameLeaf { cellId: 'debug' }`。渲染器走 `renderLeaf`，debug 占满整个项目区。

### 3.3 demoteOrphanFixedPx——sim 列存在理由检查

`fixed-px-with-splitter` 存在的唯一理由是 **iPhone shell 需要稳定列宽**。collapse 后若该 slot 内已经没有 simulator leaf（例如 `belowSimulator + sim 隐藏`，column 溶解后留下 debug 在 slot=below-sim-column 里），理由消失——把 outerSize 降到 `flex`。`subtreeHasSimulator` 递归检查。

### 3.4 signature

`signatureOf(frame)` 把拓扑序列化成稳定字符串：

```
Row[ sim(fixed-px+trailing), right(flex) → Column[ editor(R:70:20), debug(R:30:10) ] ]
↓
r[P:t:simulator(L:simulator)|F:in-editor-column(c[R:70:20:editor(L:editor)|R:30:10:debug(L:debug)])]
```

符号图例：

- `r[...]` / `c[...]` — row / column 容器
- `L:<cellId>` — leaf
- `F` — outerSize=flex
- `P:l` / `P:t` — fixed-px-with-splitter，splitter 在 leading / trailing
- `R:<defaultSize>:<minSize>` — resizable

不含 `simPanelWidth` / `rightPane.selected` / 设备尺寸 / `projectPath`——这些拓扑无关项通过别的渠道传给下游（`useViewAnchor` 的 `deps` / 显式 prop / ResizeObserver 自己捕捉 rect 变化）。

## 4. 渲染器（FrameTree）

`renderFrame` 按 frame 类型 + 子节点 outerSize 派发：

| frame.kind | 任意 child `fixed-px` | 全部 `resizable` | 其它（flex/混合） |
|---|---|---|---|
| `leaf` | `renderLeaf(cellId)` | — | — |
| `row` / `column` | `renderPlainFlexRow` | `renderResizableGroup` | `renderPlainFlex` |

### 4.1 leaf 渲染

`renderLeaf(cellId, ctx)` 对所有 cell 一律返回 caller 提供的 `ctx.cellNodes[cellId]`（不再按 cellId 分支）。`FrameTree` 不持有任何 ref、不挂 bounds——bounds wiring 全在 `project-runtime.tsx` 的锚点里。三个 cellNode 由 `project-runtime.tsx` 提供：

- `simulator` — `<SimulatorPanel>`，渲染设备框 + `<webview>`。非 overlay，无锚点。
- `editor` — `<MonacoEditor projectPath={...} />`，renderer 内组件，根 div 带 `data-area="editor"`。非 overlay，无 ref、无 bounds。
- `debug` — `<BottomDebugPanel ref={devtoolsAnchorRef} ...>`。`BottomDebugPanel` 把这个 ref forward 给内部 `[data-area="simulator-devtools"]` 占位 div——那是 Console DevTools overlay 的 bounds target。ref 来自 `project-runtime.tsx` 的 `useViewAnchor`，不是 FrameTree。

### 4.2 resizable group（react-resizable-panels）

`renderResizableGroup` 走 panels Group：

- orientation：`row → 'horizontal'`，`column → 'vertical'`。
- **Group key = children.slotId.join('|')**：拓扑变 → key 变 → Group remount → `defaultSize` 重新应用。这是 v1 不引入 `autoSaveId` 持久化 size 的原因——故意走"切 mode 重置"路线，避免旧 mode 的 size 串到新 mode。
- 每个 child 渲染成 `<Panel id={child.slotId} defaultSize={...} minSize={...}>`，child 之间塞 `<ResizeHandle>`。
- 守卫：dev mode 下若 resizable group 里混入非 resizable child 直接抛错（compile 不应该产出这种组合）。

### 4.3 plain flex（无 splitter）

`renderPlainFlex` 用于所有 child 都是 `flex`、或 flex/resizable 混合、且没有 `fixed-px-with-splitter` 的情形。例：`belowSimulator + sim 隐藏 + editor + debug` 留下 `row[ debug(flex), editor(flex) ]`，panels 不能处理，走这里。每个 child 包一层 `flex-1 min-w-0 min-h-0 overflow-hidden`。

### 4.4 plain flex + 手写 splitter

`renderPlainFlexRow` 专用于"有 fixed-px child"的 Row。强制要求 row：column 上 fixed-px 是 fixed-height，**不支持**，dev mode 抛错。

```
for each child:
  if fixed-px-with-splitter:
    draw splitter + fixedDiv (style.width = ctx.simPanelWidth)
    splitterSide=trailing → splitter 在 fixedDiv 后
    splitterSide=leading  → splitter 在 fixedDiv 前
  if flex:
    div className="flex-1 min-w-0 h-full overflow-hidden"
  if resizable (混入异常 fallback):
    当 flex 处理
```

alignment 反转的实现不在渲染时 `reverse()` children，而是在 `compile.alignedRow` 里直接构造好正确顺序的 children 数组，加上 `splitterSide: 'leading' | 'trailing'` 编码——渲染器只读 sum type，不做位置推断。

## 5. bounds 同步（useViewAnchor）

bounds 同步由原语 `@dimina-kit/view-anchor` 提供（核心 `createViewAnchor` 零 React / 零 Electron，React 适配在 `react.ts`，可独立开源——见该目录的 `README.md`）。`project-runtime.tsx` 只用 React 适配器 `useViewAnchor`，且**只为唯一的 overlay（debug 的 Console DevTools）注册一个锚点**：

```ts
// project-runtime.tsx
const devtoolsAnchorRef = useViewAnchor({
  present: compiled.cells.debug.present,         // 唯一 detach 语义来源
  publish: publishSimulatorDevtoolsBounds,       // 拥有 IPC view:simulator:devtools-bounds
  deps: [compiled.signature, project.path, rightPane.rightPane.selected],
})
// devtoolsAnchorRef 挂到 <BottomDebugPanel>，再 forward 给内部
// [data-area="simulator-devtools"] 占位。
```

editor 是 renderer 内 Monaco、simulator 是 `<webview>`，都不是主进程 overlay，所以都不需要锚点。整套 layout 只有这一个锚点。

### 5.1 present / ZERO / detach 语义

锚点的语义来自 view-anchor 原语：

**`present === false`**：同步发 `{ x:0, y:0, width:0, height:0 }` 并停止观测。`publishSimulatorDevtoolsBounds` IPC 到主进程 → `setSimulatorDevtoolsBounds` 见零面积 → `removeChildView`，**保留 WebContents 存活**（detach-but-keep-alive）。不读 DOM、不挂 ResizeObserver。

**`present === true` 且占位 div 已挂载**：同步发一次 `getBoundingClientRect()`（每个字段 `Math.max(0, Math.round(...))`），然后挂 `ResizeObserver(el)` + `window 'resize'`，后续几何变化经 RAF 节流合帧后重发。

**占位 div detach / 组件 unmount**：ref 走到 `null` 或 hook 卸载——适配器先经 `update({ present:false })` 发**一次** ZERO 收起 native view，再 `dispose()`。这是适配器（不是 core）的职责：core `dispose()` 故意永不再 publish，但主进程只在收到 `{0,0,0,0}` 时才收起 view，否则 native DevTools 会冻在最后的 bounds 上浮在内容上方。这条 dispose-ZERO 路径在 debug cell 被整体隐藏（`debugVisible=false` ⇒ leaf 剪掉 ⇒ `<BottomDebugPanel>` 连同占位 div 真 unmount）时兜底；不过该场景里 `present=false` 路径已经先发过零 bounds，dispose-ZERO 只是冗余保险。日常切 tab 时占位 div **不** unmount——Console 占位始终挂载，切走时用 `display:none` 收成零面积 rect（`bottom-debug-panel.tsx` 注释「Always mounted … hide via display:none」），由 §5.3 的 `rightPane.selected` dep 触发重发零 bounds 来收起 overlay。

`present=true ⇒ compiled frame 必须含该 leaf`——这是 compile 阶段的内部一致性要求；hidden cell 应该是 `present=false`，而不是 `present=true` 但不出现在 frame 里。

### 5.2 stale-RAF 守卫

一批 ResizeObserver/resize tick 在同一帧内合成一次 publish（RAF 节流）。每次 `update`/`dispose` 都先 `cancelAnimationFrame` 取消在途 RAF，RAF body 自身也在 `disposed`/`!present` 时 bail——所以一个在状态切换前排好的帧，绝不会迟到落地、把旧 rect 盖到新的活值上。`dispose` 后锚点永不再 publish。

### 5.3 deps —— ResizeObserver 看不见的几何变化

`ResizeObserver` 只覆盖纯几何尺寸变化。`deps` 覆盖它看不见的、但会移动占位 rect 的状态，每变一次就强制重发：

- `compiled.signature` — 布局拓扑翻转（切 mode / 显隐 cell）。
- `project.path` — 切项目。
- `rightPane.rightPane.selected` — 当前 debug tab。切到非 Console tab 时 Console 占位被 `display:none`，rect 变了但拓扑没变，ResizeObserver 看不到——靠这个 dep 触发重发。

deps 数组长度需跨 render 稳定（React effect-deps 规则）。

## 6. 扩展指南

### 6.1 加一个新 overlay cell（例：未来的 settings panel，且是主进程 view）

**前提：**新 cell 用现有 sizing policy（fixed-px / flex / resizable 之一），不引入新的 sizing 语义。

1. **`layout/types.ts`** — `'settings'` 加进 `CellId` 联合。
2. **`layout/compile.ts`** — 决定每个 mode 下 settings 放哪。`buildModeFrame` 里加 slot，写出该 child 的 `FrameChild`：

   ```ts
   // 例：belowSimulator mode 把 settings 钉在 left column 底部
   { frame: settings, outerSize: { kind: 'resizable', defaultSize: 20, minSize: 10 }, slotId: 'below-sim-settings' }
   ```

   `cells` 注册表新增 `settings: { id, present: state.settingsVisible }`。注意 `present=true ⇒ compiled frame 必须含该 leaf`（§5.1）——用户不想看 settings 就让 `settingsVisible=false`（→ `present=false`），而不是 `present=true` 但 frame 里不列出。
3. **`controllers/use-layout-store.ts`** — state 加 `settingsVisible`，sanitize 路径加默认，`toggleVisible` 加 case。
4. **`project-runtime.tsx`** — 加一个 `useViewAnchor` 锚点：

   ```ts
   const settingsAnchorRef = useViewAnchor({
     present: compiled.cells.settings.present,
     publish: publishSettingsBounds,
     deps: [compiled.signature, project.path /*, 任何移动 rect 的额外状态 */],
   })
   ```

   `cellNodes.settings` 提供渲染节点，把 `settingsAnchorRef` 挂到占位 div（或 forward 给内部占位，参考 `BottomDebugPanel`）。
5. **主进程** — 按顺序：
   - `shared/ipc-channels.ts` — `ViewChannel` 加 `SettingsBounds` 枚举值。
   - `main/ipc/views.ts` — 加 IPC handler 转调 `viewManager.setSettingsBounds(bounds)`。
   - `main/services/views/view-manager.ts` — 加 `settingsView` 字段 + `setSettingsBounds(bounds)`（参考 `setSimulatorDevtoolsBounds`：零面积 ⇒ removeChildView 但保活）。
   - `renderer/shared/api/view-api.ts` — 加 `publishSettingsBounds(bounds)` IPC wrapper（参考 `publishSimulatorDevtoolsBounds`）。
   - 单测：compile 单测加新 mode 用例；如果 `setSettingsBounds` 有逻辑分支（零面积 detach 等），补 view-manager 单测。

步骤 1 / 2 / 3 接入布局拓扑，4 / 5 接入 bounds 同步与 IPC。**若新 cell 是 renderer 内组件（像 editor 那样无 overlay），跳过步骤 4 的锚点与步骤 5——它只是 `cellNodes` 里多一个普通 React 节点。**

### 6.2 加一个新 layout mode（例：editor 在底部）

**前提**：新 mode 只用现有 cells 和现有 sizing policy。满足时 `frame-tree.tsx` 和 bounds 同步一行不动。

1. **`controllers/use-layout-store.ts`** — `DevtoolsPosition` 加 `'editorBelow'`，sanitize 路径放行新值。
2. **`layout/compile.ts`** — `buildModeFrame` 加 `if (state.devtoolsPosition === 'editorBelow')` 分支，返回对应 frame 树（例如 `column[ row[sim(fixed-px), debug(flex)], editor(resizable) ]`）。给新模式独有的容器一组 slot id 命名（如 `editor-below-top`、`editor-below-bottom`），不要复用既有命名。
3. **`components/layout-controls.tsx`** — `LayoutDevtoolsPositionToggles` 加按钮 + 图标。

完。只要 compile 产出合法 frame，渲染器和锚点会自动跑。

### 6.3 加一个新 sizing 策略

例如未来需要"百分比但带最大 px 上限"：

1. **`OuterSize`** sum type 加新 variant。
2. **`signatureOf.outerSigOf`** 加新 case——拓扑变化要影响签名。
3. **`frame-tree.tsx`** 加新的派发分支，或在现有 `renderPlainFlex` 里加 case。
4. **`collapseInvisibleCells`** 不动（slot 的 outerSize 是 caller 给的，pass 不解释它）。

## 7. 与现有架构的契约

### 7.1 与 `use-layout-store` 的接口

输入端：compile 只读 5 个字段 `simulatorVisible / editorVisible / debugVisible / simulatorAlignment / devtoolsPosition`。

输出端：`useLayoutStore` 提供 `state`、`visibleCount`、setter + toggle。

**三层 guard**（保证渲染器永远不会看到"零可见 cell"输入）：

- `load()` — localStorage 全 false → 返回 `DEFAULT_LAYOUT_STATE`。
- `compile()` — 兜底再判一次全 false → 返回 editor leaf 且 `cells.editor.present=true`。
- `toggleVisible` — 禁止把最后一个 true toggle 掉。

### 7.2 与主进程 view-manager 的接口

只有仍是 overlay 的 cell 走这条接口。当前唯一一个是 **debug 区的 Console DevTools**：锚点 `publish` 调 `publishSimulatorDevtoolsBounds`（`view-api.ts`）发 `{ x, y, width, height }`，主进程 `setSimulatorDevtoolsBounds`（`view-manager.ts`）：

- 零面积 → `removeChildView`，**保留 WebContents**（下次重新 add 即可秒变）。
- 非零 → 未 attached 则 `addChildView`，然后 `view.setBounds()`。

含义（以 debug overlay 为例）：

- 切 tab / 拖拽改变 debug 占位区：bounds 只是位置/尺寸变，WebContents 不动。
- debug cell 被隐藏（`cells.debug.present=false`）：锚点发零 → 主进程 detach 但 WebContents 不销毁。
- 再显示：锚点重新发真实 rect → 主进程 re-attach 并 setBounds。

该 overlay 的 lifecycle 由 `cells.debug.present` + 占位区 rect 单一驱动。

> **editor / simulator 不在这条接口上**：editor 是 renderer 内 `<MonacoEditor/>`，由 React 自己挂载/卸载；simulator 是 `<webview>`。两者都不发 bounds、不经 view-manager。

### 7.3 与 react-resizable-panels 的边界

走 `<Panel>` 的条件：parent frame 的**全部** children 都是 `resizable`。任何一个不是 → 整个 group 走 plain flex 路径。panels 不接受非 Panel 的 child（runtime 会抛 `Children of must be Panel...`）。

不走 `autoSaveId`：v1 故意不持久化 size。每次 mode 切换 Group remount，`defaultSize` 重新生效。后续若用户反馈"切回去 size 应该记住"，那是引入 `autoSaveId` + 持久化 key 的契机，而不是把 Group key 拿掉。

## 8. 已知限制 + Backlog

| # | 限制 | 说明 |
|---|---|---|
| 1 | simulator visible toggle off → on 后 useSimulator 不重新 attach | simulator webview lifecycle 不在本层管。defer 到 simulator 重构 backlog（参考 memory `project_simulator_module_rewrite`） |
| 2 | reload project 后 debug overlay 不重新 attach | 属于 view-manager 的 reload-state 管理。本层只在每次 `project.path` 变化时（锚点 `deps`）触发一次 re-publish；若主进程把 view destroy 了，再发 bounds 也无效。（editor 不再是 overlay，reload 由 `<MonacoEditor/>` 自己重读文件列表处理） |
| 3 | `autoSaveId` 未启用 | 切 mode 总会丢失上一次的 resizable group 拖拽 size。目前有意取舍（详见 §7.3） |
| 4 | column 上 fixed-px-with-splitter 不支持 | dev mode 抛错。若未来需要"上下两栏 + 上栏固定高度 + 拖拽分隔条"，要扩 `OuterSize` 和 `renderPlainFlex` 系列 |

## 9. 历史决策与旧 bug 成因

§2 的不变量表给了新结构，本节补旧成因——只在需要理解"为什么不变量长这样"时读。

### 9.1 sim 列右侧 dead zone

旧 `LayoutTree` 的 Row 容器永远把 sim 列以 `width: ${simPanelWidth}px` 渲染；兄弟节点全消失时没有机制升级它为 `flex: 1 1 0`。新结构由 `collapseRoot` + `demoteOrphanFixedPx` 在 compile 阶段消掉中间状态，渲染器看到的就是已 flex 化的 leaf。

### 9.2 overlay cell 消失时不收起 view

旧路径绑在"DOM 卸载 → 不再发 bounds"——被动信号，且和"占位 div 还在但 visible 改变"语义混在一起。新结构以 `cells[id].present` 为单一 detach 语义来源（`present=false` 主动同步发零），DOM 消失则由 `useViewAnchor` 适配器在 dispose 前补**一次** ZERO 主动收起。两条路径都收敛到同一个原语，不再有"DOM 卸载但 view 不 detach"的窗口。

> 这条不变量当年是为 editor overlay 设计的；editor 此后整体迁到 renderer 内 Monaco 组件、退出 overlay 模型，现在唯一受这条规则约束的 cell 是 debug 区的 Console DevTools。机制本身（present 驱动 detach + 消失补 ZERO）未变，只是从早期的多 cell `useCellBounds` 收敛成单锚点 `useViewAnchor`。

### 9.3 react-resizable-panels 接管 sim 列宽 → iPhone shell 不居中

旧 `LayoutTree` 为了少写代码把所有列塞进 panels Group；sim 列的"固定 px + 设备框居中"与 panels 的"百分比"模型从根上冲突。新结构 `outerSize` 是 sum type，命中 `fixed-px` 就走 plain flex + 手写 splitter，不沾 panels。react-resizable-panels 在此被降格为工具而非权威：能解决的用它，不能解决的自己写。

### 9.4 `layoutKey` 字符串拼接 deps 漏维度

旧代码每个监听者各自拼 `layoutKey` 字符串作为 useEffect dep，每加新维度都得改多处，漏一处就出 bug。新结构 `signature` 是唯一 topology dep；新增 mode 只要 compile 出的 frame 不同，签名自动不同。

### 9.5 Panel id 跟 layout 位置耦合

旧代码把 `<Panel id="editor">` 当业务身份用，但 panels 库把它当布局位置——两个语义被一个标识符覆盖，切 mode 后 size 应用错位。新结构 `CellId` 与 `PanelSlotId` 刻意分离（见 §1 词汇）。

### 9.6 其他设计点

- **outerSize 是 parent-edge 性质**——见 TL;DR。这条性质让 collapse 逻辑可以纯 local。
- **alignment 由 compile 重排 children 而非渲染时 reverse**——`alignedRow(simSide, restSide, alignment)` 直接决定 children 顺序。splitter 方向通过 `splitterSide: 'leading' | 'trailing'` 编码在 outerSize 里，渲染器读 sum type 不做位置推断。
- **bounds 同步抽成引擎无关原语**——`view-anchor` core 零 React / 零 Electron，把"DOM rect → 主进程 view bounds"的跨进程桥独立出来，DOM 布局库（含 dockview）刻意不提供这一桥。本层只用它的 React 适配器，且收敛成单锚点。
- **signature 不透明**——仅用作 effect dep（锚点 `deps`），不要当 diff key（结构不暴露）。

## 10. 文件清单

| 文件 | 角色 |
|---|---|
| `src/renderer/modules/main/features/project-runtime/layout/types.ts` | 类型定义（CellId / Frame / OuterSize / ProjectWindowLayout 等） |
| `src/renderer/modules/main/features/project-runtime/layout/compile.ts` | `compileProjectWindowLayout` 纯函数 + buildModeFrame + collapse passes + signature |
| `src/renderer/modules/main/features/project-runtime/layout/frame-tree.tsx` | `FrameTree` 渲染器 + 三条 dispatch 路径 + `<Splitter>`（不持有 bounds wiring） |
| `src/renderer/modules/main/features/project-runtime/layout/compile.test.ts` | compile 单测（所有 mode × alignment × visibility 组合） |
| `src/renderer/modules/main/features/project-runtime/layout/frame-tree.test.tsx` | 渲染器单测（dispatch 选择、slot key、Splitter 方向） |
| `src/renderer/modules/main/features/project-runtime/project-runtime.tsx` | 管线串联点（compile → FrameTree）+ 唯一的 `useViewAnchor` 锚点（debug overlay） |
| `src/renderer/modules/main/features/project-runtime/controllers/use-layout-store.ts` | `LayoutState` 持久化 + sanitize + at-least-one guard |
| `src/renderer/modules/main/features/project-runtime/components/layout-controls.tsx` | toolbar 上的可见性 / 对齐 / devtools 位置 toggle 按钮 |
| `packages/view-anchor/` | 引擎无关 bounds 同步原语（`createViewAnchor` core + `useViewAnchor` React 适配；见其 `README.md`） |
| `src/renderer/modules/main/features/bottom-debug-panel/bottom-debug-panel.tsx` | debug cell；forward 锚点 ref 给内部 `[data-area="simulator-devtools"]` 占位 |
| `src/renderer/modules/main/features/monaco-editor/` | editor cell 的 renderer 内 Monaco 实现（非 overlay；细节见 `editor-integration.md`） |
| `src/main/services/views/view-manager.ts` | `setSimulatorDevtoolsBounds`（零面积 ⇒ removeChildView 保活）；无 editor overlay 方法 |
| `src/main/ipc/views.ts` | IPC handler → view-manager |
| `src/renderer/shared/api/view-api.ts` | `publishSimulatorDevtoolsBounds` IPC wrapper |
| `src/main/ipc/project-fs.ts` | editor 文件读写的沙盒 IPC（`project:fs:*`） |
