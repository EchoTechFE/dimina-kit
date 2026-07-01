# electron-deck 架构总览：布局 / 多窗口

> 本文面向第一次接触本包的工程师，解释这套布局与多窗口原语、每个原语的职责边界、host 怎么用。配套阅读：
> - `docs/foundation.md` —— 连接层 / Disposable / Scope 的地基。
> - `docs/layout-architecture-demo.md` —— 「最简 devtools」host-facing 调用形态（与本文第 4 节互为正反面）。
> - `packages/view-anchor/README.md` —— Layout/Placement 原语的独立包文档。

---

## 0. 一句话定位 + 与 dockview 的关系

**electron-deck 是一个领域中立的 Electron「host shell」框架**：它不替你做窗口内的 DOM 分栏，
而是把**跨窗口编排、原生 `WebContentsView` 的 z 叠放与几何跟随、以及嵌套寿命管理**抽成四个
正交原语，让业务（devtools / simulator / 任意 Electron 多窗口工具）用极少的 host 代码拼出
「窗口 + 原生 view + 浮层 + popout」。

**与 dockview 不是替代关系，是分工关系。** dockview（或任意 CSS / React 分栏库）是
**窗口内 DOM 布局**的权威：split / grid / tab 的真相源在 renderer 控制层。dockview 内部有个
`OverlayRenderContainer`，做的正是 `getBoundingClientRect → RAF → reposition` 把一个 follower
贴到面板上——但它的 follower 是 **DOM 节点**。electron-deck 的 `view-anchor` 是同一个机制的
**跨进程版本**：follower 是主进程的原生 `WebContentsView`（见 `packages/view-anchor/src/types.ts`
的注释——「dockview 故意不提供的那道跨进程桥」）。

> 一句话：**dockview 管 DOM 怎么分；electron-deck 管原生 view 怎么跟着 DOM 走、跨窗口怎么搬、寿命归谁。**

> **关于「窗口内 DOM 怎么分」**：上面说 electron-deck「不替你做窗口内的 DOM 分栏」是指
> §1–§5 的 host-shell 原语（Scope / Compositor / ControlBus / ViewHandle / Window facade）。
> 但本包现在另外提供一个**独立的、领域中立的窗口内布局面**——layout-as-data 引擎
> （`/layout`）+ `<DockView>`（`/dock-react`），见下面 §0.5。它和 host-shell 原语是
> **两个正交的 surface**：host-shell 不依赖布局引擎，布局引擎也不 import electron。devtools 是
> 布局引擎的**首消费者**（IDE-dockable 布局），但仍以 `ownsWindows:true` 旁路集成、**不**采纳
> §4 的高层 host-shell API（见 `../../devtools/docs/deck-adoption-decision.md`）。

---

## 0.5. layout-as-data 引擎 + DockView（窗口内 docking 布局）

这是与 §1–§5 host-shell 原语**正交**的第二个公开面：一套**领域中立**的「窗口内 docking 布局」
能力，供任何 Electron 工具把面板拼成可拖拽 re-dock / tab / 分屏 / 序列化恢复的 IDE 式布局。

### 0.5.1 layout-as-data 引擎（`@dimina-kit/electron-deck/layout`）

**纯 TS**——`src/layout/` 下严禁 import `electron` / `react`（`boundary.test.ts` 钉死这条边界）。
原生面板只引用一个 electron-free 的不透明句柄 `NativeHandleRef`，由 host 自己映射回真 view。

- **数据模型**：布局是一棵不可变树 `LayoutTree`，节点是 `SplitNode`（`row`/`column` 容器，带
  每子一份 `sizes` 权重 + 可选 `constraints`：`{fixedPx}` 锁死 / `{minPx}` 柔性下限）或 `TabGroupNode`
  （一组 panelId + 当前 `active`）。
- **面板登记**：`PanelDescriptor` 分 `dom`（renderer 内 React 内容）/ `native`（带
  `NativeHandleRef` 的主进程 view）两类；`createPanelRegistry()` 维护 panelId → descriptor。
- **mutation（纯函数，树→树）**：`movePanel` / `splitPanel` / `closePanel` / `setActive` /
  `setSizes` / `setConstraint` / `extractPanel` / `insertPanel`。
- **序列化 / 校验**：`serializeLayout` / `parseLayout`（不透明字符串往返持久化）+ `validateTree`
  （结构合法性 + panelId 是否都在已知集合内，给 fallback-safe 恢复用）。
- **可观察模型**：`createLayoutModel(tree)` 是一个**单写者**的 `LayoutModel`（`get` /
  `apply(mut)` / `subscribe(snap)`），把树变更广播给渲染层。

### 0.5.2 `<DockView>`（`@dimina-kit/electron-deck/dock-react`）

`<DockView model registry renderDomPanel bindNativeSlot>` 是把 `LayoutModel` 渲染成 docking UI
的 React 渲染器：

- DOM 面板经 `renderDomPanel(panelId, { active })` 渲染 React 内容；原生面板经
  `bindNativeSlot(panelId, el)` 把一个**空 DOM 槽**交给 host——host 用 `view-anchor` 把主进程
  view 贴到该槽（与 §2.2 同一跨进程桥）。
- **DOM 面板 keepalive**：同一 tab group 内的 DOM 面板**全部常驻挂载**，非 active 的用
  `display:none` 隐藏（不卸载），切 tab 来回不 remount——滚动位置 / 展开态得以保留。`active`
  标志让面板能在 false→true 边沿跑「激活时副作用」（如数据 refresh）而无需依赖挂载。
  **原生面板例外**：仍 active-only 挂载（隐藏一个已 bind 的 WebContentsView 槽会塌缩其 rect），
  失活即卸载并触发 `bindNativeSlot(panelId, null)` 清理。
- 交互：用户**拖拽 tab → drop 区**做 split / tab re-dock（HTML5 DnD），拖分隔条 resize，切 tab，
  **关闭面板**（tab 上的 close 控件 → `closePanel`，守卫整树最后一个面板）；
  纯几何的 drop-zone 计算与 descriptor 层（`computeDropZone` / `dropZoneToMutation` /
  `isNoopRedock`）也从本 entry 导出，host 不必深 import。
- `constraints` 让某个 leaf 受像素约束：`{fixedPx}` 锁死，`{minPx}` 柔性下限（如 simulator 列可拖宽但不小于设备宽）。
- **model 是可视分屏的事实源（双向同步）**：react-resizable-panels（rrp）的 `defaultSize` 只在挂载时读取，
  所以 `SplitView` 持有 rrp `Group` 的命令式 handle，两个方向各走一条路：model→view 时，程序化 `setSizes`
  经 `setLayout` 推动**已挂载的分隔条**真正移动（不必 remount）；view→model 时，用户拖分隔条 / 键盘 resize
  经 `onLayoutChanged` 写回 model。
  写回前要去重，判据是**flexible 比例比较**——把 rrp 报的容器百分比和 model 里的权重，各自只按可伸缩
  （非 fixed-px）的子项归一化后再比，差异超过 0.1 个百分点才写回。这单一判据就能区分「真用户 resize（写回）」
  与「自身 `setLayout` 造成的回声 / 比例守恒下的自发重测（跳过）」，不需要额外的指针门控或回声 token。
  fixed-px 子项的权重在写回时保持不变（其尺寸由约束而非权重决定）。

### 0.5.3 与 §1–§5 的关系

布局引擎**不碰** Scope / Compositor / ControlBus / Window facade，也不要求 host 采纳它们；
host-shell 原语同样不依赖布局引擎。devtools 同时用两者，但走的是**不同的 seam**：项目窗口内的
分栏用 `/layout` + `/dock-react`，而窗口装配 / 原生 view 寿命仍走 `ownsWindows:true` 旁路。

---

## 1. 为什么（三个真实需求 + 一个物理约束）

这套架构不是凭空设计的，是被三个具体需求 + Electron 的一条硬约束逼出来的。

### 需求 A：点 close 退回 main，而不是关掉窗口
devtools 里「关闭当前项目」应当**销毁项目相关的全部资源（simulator、CDP、DevTools view……）
但留住窗口**，退回项目列表。这要求一种**嵌套寿命**：窗口寿命 ⊃ 会话寿命；关项目 = `reset`
会话寿命，窗口活着。→ **Scope**。

### 需求 B：业务（renderer）经 IPC 自助控制布局
分栏比例、把面板拽出去、弹下拉……这些是业务交互，不该写死在主进程。renderer 控制层需要一条
受信的 IPC 通道把布局意图（resize / reorder / popout）发回主进程，主进程据此驱动原生 view，
且必须有**权限边界**（一个窗口的控制层不能动别的窗口）。→ **ControlBus** + capability。

### 需求 C：浮层要浮在原生 view 之上
「设置」面板、被 DevTools 盖住的下拉菜单……这些要浮在**原生 DevTools view 之上**。

### 物理约束（决定了整套架构形态）
**Electron 的原生 `WebContentsView` 永远合成在 DOM 之上，且原生 view 之间不能与 DOM 在 z 轴上
穿插。** 这意味着：
- 需求 C 的「浮在原生 DevTools 之上的下拉」**本身必须是一块原生 view**（放进更高的 z 层），
  不可能是一个 DOM 元素——DOM 永远在原生 view 之下。
- 同一窗口里多块原生 view 的前后关系，需要一个**主进程侧的原生 z 层规划器**来管。dockview 这类
  纯 DOM 库给不了这个。→ **Compositor**。

而「窗口被 splitter 拖动时原生 view 跟着 DOM 占位走」这件事，是 → **Layout/Placement（view-anchor）**。

---

## 2. 四个正交原语 + 薄 ViewHandle

整套架构 = **4 个正交 primitive** + 一层**薄 ViewHandle** 编排壳。正交 = 互不依赖、可独立测试、
各自只管一件事。

```
                       ┌─────────────────────────────────────────┐
   host backend  ──►   │            ViewHandle (薄编排壳)          │
   runtime.view()      │  持: native view + scope-lease + compositor token │
                       └───┬───────────┬──────────────┬──────────┘
                           │           │              │
                  ┌────────▼──┐  ┌─────▼──────┐  ┌────▼─────────┐   ┌──────────────┐
                  │   Scope   │  │ Compositor │  │Layout/Placement│  │  ControlBus  │
                  │ 嵌套寿命  │  │ per-window │  │  view-anchor  │  │ IPC+trust 薄  │
                  │ own/child │  │  z 叠放    │  │ DOM rect ↔   │  │ command/event│
                  │reset/close│  │mount/commit│  │ native bounds │  │ /trust       │
                  │ +栅栏+adopt│  │ +LIS diff  │  │ Placement{vis}│  │ →WireTransport│
                  └───────────┘  └────────────┘  └──────────────┘   └──────────────┘
```

### 2.1 Scope —— 嵌套寿命
**职责**：一段「寿命片段」。`own()` 绑资源、`child()` 开子寿命；`reset()`（软复用：拆掉当前片段、
开新片段、自己活着）和 `close()`（终结：全拆、死掉）统一释放，LIFO，跨层（孙→子→父）。

**关键性质（与 `connection.ts` 的差别）**：`reset()/close()` 是**完成栅栏（completion fence）**——
它的 Promise 只在底层 async `disposeAll` **真正跑完**之后才 resolve、才 fire 监听器；不是
「触发即忘」。这让父的 `await child.close()` 是一次真等待（单飞 in-flight，重入合流）。

**adopt**：把一个 child 从当前父的片段**重挂**到另一个父的片段上，**不 reset / 不 close**——
child 的 `own()` 资源原封不动，只换「从此谁负责拆它」。若任一端有 teardown 在飞，adopt **等栅栏**
（不抛），等完后对新鲜片段重新校验。这是 popout「迁寿命」的底层（见决定 5）。

- 文件：`src/main/scope.ts`（接口 `Scope`；`adopt`；完成栅栏的单飞状态机均在此）。

### 2.2 Layout/Placement —— DOM rect ↔ native bounds（独立包 `@dimina-kit/view-anchor`）
**职责**：让一块主进程原生 view 始终贴住某个 DOM 元素的屏幕矩形。测 `getBoundingClientRect()`，
把矩形交给注入的 `publish`（host 接 IPC → `setBounds`），并在 `ResizeObserver` / window `resize`
时**同步**重发（不走 RAF——原生 setBounds 本就慢一帧，再叠一帧会在拖 splitter 时拖尾，见
`view-anchor/src/view-anchor.ts` 的长注释）。

**显式 `Placement{visible}`**：可见性是**判别式（discriminant）**，绝不从几何推断。一个
真正 0×0 但在屏（有几何盒、被排版成 0 面积）的 view 是 `{ visible:true, bounds:{...width:0} }`，
一个隐藏 / **无几何盒**（`display:none`、未 mount）的是 `{ visible:false }`（**不带 bounds**）。
这替换了旧的 magic-`{0,0,0,0}` = 隐藏 的约定（旧约定下两者无法区分）。

> `display:none` / 无几何盒 一律发 `{ visible:false }`（detach），**不是** 0 尺寸的
> `visible:true`；`{ visible:true, bounds:0×0 }` 只保留给「有盒但被排成
> 0×0」的合法罕见情形。`visible:false` = 「不显示这个 view」，由**调用方意图 hide** **OR**
> **锚测出无几何盒**两路得出（锚报客观事实，不篡改意图）。判别口诀：**有盒但 0 面积 →
> visible:true+0×0；无盒 → visible:false**。详见 `contracts/view-anchor-following.md` §3。

**反向（size-advertiser）**：正向让原生 view 跟 DOM；反向让 DOM 占位跟内容尺寸（在下游 view
自己的渲染进程里量 border-box 回流给宿主）。单轴所有权（block=高 / inline=宽），保证跨进程环是
单向 DAG。

- 文件：`packages/view-anchor/src/`（`Placement` 类型 `types.ts`；正向核心 + 显式 Placement 核心
  `view-anchor.ts`；反向 `size-advertiser.ts`）。

### 2.3 Compositor —— per-window 原生 z 叠放
**职责**：规划一个窗口内原生子 view 的 z 顺序。把**意图**（`mount` / `unmount` / `reorder` 到某
zone 的某相对位置）与**应用**（`commit()` 算出把 host 当前子序变成目标序的**最小** add/remove
序列）分开。

**全序 `(zone, orderKey, viewId)`**：低 zone 渲染在下、高 zone 在上（zone 之间堆叠）；zone 内按
`orderKey` 排；`viewId` 纯兜底保证确定性。`orderKey` 用 **fractional indexing**：reorder-before(X)
取 X 与其前驱的中点，O(1) 且不扰动其他 view 的 key；中点精度耗尽时**整 zone 重编号**（rebalance，
对可见顺序无感）。

**LIS commit**：把一批意图折叠成**最终目标态**（last-state，不是写日志回放），再 diff host 当前
子序与目标。host 只能 `addChildView` 到顶（append/raise），所以保留「当前∩目标里已就位的最长前缀」
（LIS），其余共享 view + 全部新 view 在一个同步 pass 里 remove+add 重排——**最小 host churn、
零 renderer reload**。

> 为什么需要它而 dockview 没有：见决定 1。原生 view 的 z 是 Electron 物理约束下主进程独有的一层，
> DOM 库管不到。

- 文件：`src/main/compositor.ts`（接口 `Compositor`；reorder/fractional key（含 `keyBefore`）；
  LIS commit 均在此）。host 观察到的 Electron z 语义（spike 实证）记在 `compositor.ts` 的头注释。

### 2.4 ControlBus —— IPC + trust 薄 facade
**职责**：三个动词的薄门面，**自己不加任何新 gating**：
- `command(name, handler)`：webview → main 的 RPC。门面持唯一命令表，`dispatch(name, args)` 被真
  `WireTransport` 的 `invokeHost`/`invokeSimulator` seam 调到（在 wire 的 sender + main-frame
  gate 之后）。trust / main-frame 校验**全在 wire**，不是 facade。
- `event(name)`：main → webview 推送，**默认拒绝**。`name` 加进 wire 读的 declared-event allowlist；
  未声明的 name 被 wire 丢弃。
- `trust(wc)`：委托给可注入的 refcount `TrustSet`。

**关键**：命令表是**唯一命令权威**——生产侧用 `invokeHost = (n,a) => controlBus.dispatch(n,a)`
建 `WireTransport`，所以真 IPC invoke 是经 wire 落到 handler，而不是测试专用私缝；config 声明的
host service 也注册进**同一张表**（一个命名空间，永不两张会撞的注册表）。

> 🔒 **硬约束 —— 布局/特权 command 必须唯一经 ControlBus**：
> grant 闸（capability default-deny）的**唯一插点**是 `ControlBus.dispatch`。因此任何**布局 / 特权
> command**（`layout.resize` / `layout.reorder` / `layout.popout` / `layout.overlay` 等会驱动
> 原生 view / 寿命 / 跨窗的动作）**必须**经 ControlBus 注册并 dispatch，**禁止**落进普通 `hostServices` /
> `InMemoryTypedIpcRegistry` 路由（那条路由只做 trust 闸、没有 grant 闸，特权名误入即等于授权闸被绕过）。
> 这条边界由 capability 层强制守住，两条 invoke 路由如何分流、在哪写死的细节见
> `contracts/capability-and-lifecycle.md`。

- 文件：`src/host/control-bus.ts`（接口 `ControlBus`；`dispatch` 真接 wire）。真 wire 桥接
  `src/internal/wire-transport.ts`（trust + main-frame gate）。trust 原语 `src/internal/trust-set.ts`
  （refcount `add`/`isTrusted`/`snapshot`）。

### 2.5 ViewHandle —— 薄 per-view 编排
**职责**：把上面四个原语缝成「一块 view」的最小编排单元。它**持有**：原生 view 句柄、一个
scope-lease（绑哪个寿命）、一个 compositor token（在哪个窗口的 z 栈里）。

**硬边界（ViewHandle 不做什么）**：
- **不算布局**——几何来自 Layout/Placement（view-anchor），ViewHandle 只转发。
- **不定释放策略**——寿命归 Scope，ViewHandle 只持一个 lease。
- **不持全局树**——它只知道自己这一块，跨窗口/全局编排在 runtime。
- **不直碰 contentView**——所有 `addChildView`/`removeChildView` 经 Compositor。

API 形态（见第 4 节）：`runtime.view(...)` → `DeckViewHandle`，带 `placeIn(window, {zone, anchor})`
/ `applyPlacement({visible, bounds})` / `moveTo(window, {rehome})` / `dispose()`，并暴露只读访问器
`webContents` / `bounds()` / `capturePage()`（host 取原生 view 无需 diff `contentView.children`）。
`placeIn`/`moveTo` 的 window 参数接受 `DeckWindow` 或裸 `BrowserWindow`。

---

## 3. 六个关键架构决定

| # | 决定 | 理由 |
|---|---|---|
| 1 | **混合合成需要一个主进程原生 z 层（Compositor）** | Electron 物理约束：原生 `WebContentsView` 永远盖在 DOM 之上、原生 view 之间不能与 DOM z 穿插。所以「同一区域多块原生 view 谁前谁后」「浮层浮在原生 DevTools 上」只能在主进程排——dockview 这类纯 DOM 库结构上做不到。Compositor 就是这层（基于 spike 实证的 Electron z 语义，见 `compositor.ts` 头注释）。 |
| 2 | **权威分层** | **窗口内 DOM 布局**（split/grid/tab）真相源在 **renderer 控制层**（可以直接用真 dockview / CSS）；**跨窗口 + 原生 view 编排 + 生命周期** 真相源在**主进程**。两边各自是各自领域的唯一权威，不互相镜像状态。 |
| 3 | **split 分工裁决：host 主进程零布局原语** | DOM 分栏整套交给 renderer。框架只做两件事：① 原生 view 经 view-anchor 跟随任意 slot 的几何；② Compositor 管同区多原生 view 的 z。所以「支持 split」对框架而言**就等于**「拖 splitter 时原生 view 跟随」——这正是 view-anchor 的本职，框架不需要任何 split/grid 原语。与 dockview **分工不替代**（view-anchor = dockview `OverlayRenderContainer` 的跨进程版，见 `view-anchor/src/types.ts`）。 |
| 4 | **placement ≠ lifetime** | 「view 显示在哪个窗口」（placement）与「归哪个 scope 管寿命」（lifetime）**正交**。`moveTo` 默认只移**显示**（Compositor 跨窗 mount），寿命不动；要让 view 比原 session 活得久，必须显式 `rehomeTo` 才走 `Scope.adopt` 迁寿命。混淆这两者会导致「搬个面板顺手改了它的释放归属」之类的 bug。 |
| 5 | **popout = live-migrate** | 跨窗口移动**同一块** `WebContentsView` **不重载、不丢 CDP**（真机 spike 实测：`.repro/electron-deck-spikes/gate2.js` 跨双窗口迁移含 setInterval tick + 嵌套 webview guest；`gate2b.js` 钉死 setInterval 连续性 + 关窗后 view 寿命）。底层 = `Scope.adopt`（迁寿命）+ Compositor 跨窗 mount（迁显示），全程**原子单父**（view 任一时刻只挂在一个父片段上）。 |
| 6 | **host-facing 干净 API** | 对 host 暴露的是领域中立的少量动词：`runtime.windows.create → Window`、`runtime.view().placeIn / moveTo`、`window.onClose`、`runtime.grants.issue`、以及受限的 `window.compositor`（reorder/commit/batch）。目标是「最简 devtools ~30 行」（见 `docs/layout-architecture-demo.md`）。 |

---

## 4. host-facing API + 最简 devtools 调用示例（Window facade）

> 完整可跑版见 `examples/layout-demo/`（真机离屏自证）。这里给精炼骨架，呼应第 2/3 节的原语与决定。
> `runtime.windows.create()` / `runtime.windows.main` 返回 **`DeckWindow`** 句柄
> `{ window, controlWc, newSession(), onClose() }`——把寿命树/compositor/trust 接线吸收进框架，
> host 不碰裸 primitive。`newSession()` 铸 **window-rooted** `DeckSession`（窗口寿命 > session 寿命，
> 决定 A/4），`runtime.view({ scope })` 只接受它（provenance 校验，裸 Scope 被拒）。

```ts
import { electronDeck } from '@dimina-kit/electron-deck'

const Z = { CONTENT: 0, PANEL: 10, OVERLAY: 100 }   // Compositor z 分层

electronDeck({
  app: { source: { url: 'app://project-shell' } },   // 框架建 + 自动加载主窗口
  backend: {
    async assemble(runtime) {
      const main = runtime.windows.main               // DeckWindow（框架建的主窗口）

      let session = null
      function openProject(path) {
        session = main.newSession()                    // window-rooted session：关项目只 reset 它，窗口活着

        runtime.view({ source: simulatorSource(path), scope: session })
               .placeIn(main, { zone: Z.CONTENT, anchor: '#simulator' })   // view-anchor 缝几何（接受 DeckWindow）
        runtime.view({ source: { devtoolsFor: '#simulator' }, scope: session })
               .placeIn(main, { zone: Z.PANEL, anchor: '#devtools' })
      }

      main.onClose(async () => {                       // 需求 A：close 退回 main（per-window 可取消决策）
        if (session) {
          await session.reset()                        // 完成栅栏：资源真拆完才继续
          session = null
          return 'keep'                                // 留住窗口（host 自己发 navigate 事件回 project-list）
        }
        return 'close'
      })

      function showOverlay(src, rect) {                // 需求 C：浮在原生之上 = 顶层 zone
        return runtime.view({ source: src, scope: main.newSession() })
                      .placeIn(main, { zone: Z.OVERLAY, anchorRect: rect })
      }

      runtime.grants.issue(main.controlWc, {           // 需求 B：授权 control 层自助布局
        targetScope: session ?? undefined,             // 可选：把授权边界绑到某个 session
        commands: ['layout.resize', 'layout.reorder', 'layout.overlay'],
      })
    },
  },
})
```

> **安全（C3）**：控制 wc 做主帧跨文档导航时，框架**同步撤销**它的 grant + slot token
> （`did-start-navigation` → `capability.revokeBySenderId`），新文档不会继承旧页面的 `layout.*` 特权；
> trust 保留（仍是控制面）。`autoTrust:false` 后经 `windows.trust()` 晚信任的窗口同样受保护。

控制层 renderer 只画 DOM 分栏 + 原生 view 的占位「洞」，经 IPC client 发布局意图：

```tsx
const deck = createDeckLayoutClient({ bridge: window.__electronDeckLayoutBridge })
// <div id="simulator"/> / <div id="devtools"/> 是占位洞，原生 view 由主进程盖上来
// view-anchor 在 client 内 ResizeObserver 重测 → 原生块跟随，host 写 0 行 resize 代码
```

---

## 5. 原语速查

| 原语 / 壳 | 职责 | 文件 |
|---|---|---|
| **Scope** | 嵌套寿命 + 完成栅栏 + adopt | `src/main/scope.ts` |
| **Layout/Placement** | DOM rect ↔ native bounds，显式 `Placement{visible}` 判别式 | `packages/view-anchor/src/` |
| **Compositor** | per-window 原生 z 叠放，fractional indexing + LIS commit | `src/main/compositor.ts` |
| **ControlBus** | IPC + trust 薄 facade，真接 WireTransport | `src/host/control-bus.ts` + `src/internal/wire-transport.ts` + `src/internal/trust-set.ts` |
| **ViewHandle / `runtime.view`** | 薄 per-view 编排：`placeIn/applyPlacement/moveTo` + `bounds()/capturePage()/webContents` | `src/main/view-handle.ts` + `src/internal/deck-app.ts` |
| **capability / grants** | 授权层：grant 闸 + senderId 横切 + per-wc Scope + 导航撤权 | `src/host/capability.ts` + `src/internal/deck-app.ts` |
| **layout client** | `createDeckLayoutClient({bridge})` — 中央 publisher 合并成窗口级 snapshot/subscribe（slot-token 授权 + 主进程 reconcile） | `src/client/layout-client.ts` + `src/layout/snapshot-reconcile.ts` + `src/preload/` |
| **Window facade** | `runtime.windows.create()/.main` → `DeckWindow{window,controlWc,newSession(),onClose()}` | `src/internal/deck-app.ts` |

横切契约的细化规范见 `contracts/`：view-anchor 跟随硬化（`view-anchor-following.md`）、Compositor 事务化 commit 与 teardown 顺序（`compositor-and-teardown.md`）、capability 与生命周期（`capability-and-lifecycle.md`）、统一寿命（`unified-lifetime.md`）。

---

## 6. 关键文件索引

| 路径 | 内容 |
|---|---|
| `src/layout/` | layout-as-data 引擎（纯 TS）：`types.ts` 树/节点/registry/model 类型、`mutations.ts` 树→树纯函数、`serialize.ts` 往返+`validateTree`、`model.ts` 单写者可观察模型、`registry.ts` panel registry；公开面在 `index.ts` |
| `src/dock-react/` | `<DockView>` React 渲染器（`dock-view.tsx`）+ 纯几何 drag-to-redock（`drag-redock.ts`）；公开面在 `index.ts` |
| `src/main/scope.ts` | Scope 嵌套寿命原语：`own/child/reset/close/on/adopt`，完成栅栏单飞状态机 |
| `src/main/compositor.ts` | Compositor：`(zone,orderKey,viewId)` 全序、fractional indexing、LIS commit |
| `src/host/control-bus.ts` | ControlBus 薄 facade：`command/event/trust/dispatch/declaredEvents` |
| `src/internal/wire-transport.ts` | 真 Electron wire：`ipcMain.handle` 路由 + trust/main-frame gate + event fanout |
| `src/internal/trust-set.ts` | TrustSet：refcount 信任成员（`add/isTrusted/snapshot/deleteEntry`） |
| `src/internal/deck-app.ts` | `electronDeck()` 顶层 app：whenReady gating、窗口装配、close 决策机、shutdown 顺序 |
| `packages/view-anchor/src/types.ts` | `Bounds` / `Placement` / 正反向 anchor 的类型契约 |
| `packages/view-anchor/src/view-anchor.ts` | view-anchor 正向核心 + 显式 Placement 核心 |
| `packages/view-anchor/src/size-advertiser.ts` | 反向尺寸回流（下游内容尺寸 → 宿主占位） |
| `docs/layout-architecture-demo.md` | 最简 devtools host-facing 调用形态（第 4 节完整版） |
| `docs/foundation.md` | 连接层 / Disposable / Scope 地基 |
| `docs/contracts/` | 跟随硬化 / commit·teardown 顺序 / capability / 统一寿命的细化契约 |
