# electron-deck 架构总览：布局 / 多窗口

> 本文是经过多轮对抗收敛后的**布局与多窗口架构**沉淀，面向第一次接触本包的工程师。
> 它解释「为什么是这套原语」「每个原语的职责边界在哪」「host 怎么用」，并标清楚
> **已建 / 待建** 与待闭合契约。配套阅读：
> - `docs/foundation.md` —— 连接层 / Disposable / Scope 的地基推导。
> - `docs/framework-extraction-v2.md` —— `@dimina-kit/electron-deck`（原 workbench）抽框架的 v2 设计。
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
**跨进程版本**：follower 是主进程的原生 `WebContentsView`（见 `packages/view-anchor/src/types.ts:13`
的注释——「dockview 故意不提供的那道跨进程桥」）。

> 一句话：**dockview 管 DOM 怎么分；electron-deck 管原生 view 怎么跟着 DOM 走、跨窗口怎么搬、寿命归谁。**

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
且必须有**权限边界**（一个窗口的控制层不能动别的窗口）。→ **ControlBus**（+ 待建的 capability）。

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

### 2.1 Scope —— 嵌套寿命（✅ 已建）
**职责**：一段「寿命片段」。`own()` 绑资源、`child()` 开子寿命；`reset()`（软复用：拆掉当前片段、
开新片段、自己活着）和 `close()`（终结：全拆、死掉）统一释放，LIFO，跨层（孙→子→父）。

**关键性质（与 `connection.ts` 的差别）**：`reset()/close()` 是**完成栅栏（completion fence）**——
它的 Promise 只在底层 async `disposeAll` **真正跑完**之后才 resolve、才 fire 监听器；不是
「触发即忘」。这让父的 `await child.close()` 是一次真等待（单飞 in-flight，重入合流）。

**adopt**：把一个 child 从当前父的片段**重挂**到另一个父的片段上，**不 reset / 不 close**——
child 的 `own()` 资源原封不动，只换「从此谁负责拆它」。若任一端有 teardown 在飞，adopt **等栅栏**
（不抛），等完后对新鲜片段重新校验。这是 popout「迁寿命」的底层（见决定 5）。

- 文件：`src/main/scope.ts`（接口 `Scope` 在 `scope.ts:23`；adopt 在 `scope.ts:371`；完成栅栏的
  单飞状态机在 `scope.ts:159-234`）。

### 2.2 Layout/Placement —— DOM rect ↔ native bounds（✅ primitive 已建，独立包 `@dimina-kit/view-anchor`；跟随硬化契约 B 待闭合，见 §5.2）
**职责**：让一块主进程原生 view 始终贴住某个 DOM 元素的屏幕矩形。测 `getBoundingClientRect()`，
把矩形交给注入的 `publish`（host 接 IPC → `setBounds`），并在 `ResizeObserver` / window `resize`
时**同步**重发（不走 RAF——原生 setBounds 本就慢一帧，再叠一帧会在拖 splitter 时拖尾，见
`view-anchor/src/view-anchor.ts:30-58` 的长注释）。

**显式 `Placement{visible}`**：可见性是**判别式（discriminant）**，绝不从几何推断。一个
真正 0×0 但在屏（有几何盒、被排版成 0 面积）的 view 是 `{ visible:true, bounds:{...width:0} }`，
一个隐藏 / **无几何盒**（`display:none`、未 mount）的是 `{ visible:false }`（**不带 bounds**）。
这替换了旧的 magic-`{0,0,0,0}` = 隐藏 的约定（旧约定下两者无法区分）。

> ⚠️ 已按 codex 第3轮统一：`display:none` / 无几何盒 一律发 `{ visible:false }`（detach），
> **不是** 0 尺寸的 `visible:true`；`{ visible:true, bounds:0×0 }` 只保留给「有盒但被排成
> 0×0」的合法罕见情形。`visible:false` = 「不显示这个 view」，由**调用方意图 hide** **OR**
> **锚测出无几何盒**两路得出（锚报客观事实，不篡改意图）。判别口诀：**有盒但 0 面积 →
> visible:true+0×0；无盒 → visible:false**。详见 `contracts/view-anchor-following.md` §3。

**反向（size-advertiser）**：正向让原生 view 跟 DOM；反向让 DOM 占位跟内容尺寸（在下游 view
自己的渲染进程里量 border-box 回流给宿主）。单轴所有权（block=高 / inline=宽），保证跨进程环是
单向 DAG。

- 文件：`packages/view-anchor/src/`（`Placement` 类型 `types.ts:39`；正向核心
  `view-anchor.ts:59`；显式 Placement 核心 `view-anchor.ts:210`；反向 `size-advertiser.ts`）。

### 2.3 Compositor —— per-window 原生 z 叠放（✅ 已建）
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

- 文件：`src/main/compositor.ts`（接口 `Compositor` 在 `compositor.ts:61`；reorder/fractional key
  在 `compositor.ts:203` + `keyBefore` `compositor.ts:152`；LIS commit 在 `compositor.ts:236`）。
  host 观察到的 Electron z 语义（spike 实证）记在 `compositor.ts:10-17` 的头注释。

### 2.4 ControlBus —— IPC + trust 薄 facade（✅ primitive 已建；capability/grant 闸**未建**，见 §2.4 硬约束 + §5.2 契约 D）
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

> 🔒 **硬约束（建 capability 时强制的不变量）—— 布局/特权 command 必须唯一经 ControlBus**：
> ⚠️ 已按 codex 第3轮统一。grant 闸（capability default-deny）的**唯一插点**是
> `ControlBus.dispatch`（见 `contracts/capability-and-lifecycle.md` §A5-1.4）。因此：
> - 任何**布局 / 特权 command**（`layout.resize` / `layout.reorder` / `layout.popout` /
>   `layout.overlay` 等会驱动原生 view / 寿命 / 跨窗的动作）**必须**经 ControlBus 注册并 dispatch，
>   grant 闸才能拦它。
> - **禁止**把这类特权名注册进普通 `hostServices` / `InMemoryTypedIpcRegistry`。注意生产 deck-app
>   有**两条独立 invoke 路由**：默认路由 `invokeHost = (name,args) => ipc.invoke(HOST_PREFIX+name)`
>   走 `InMemoryTypedIpcRegistry`（`deck-app.ts:296-303` 注册 + `:554-557` 接线），这条**没有
>   grant 闸**，只做 trust 闸——它承载普通领域 API（`hostServices`），「trusted 即可调」。特权名
>   若误进这条路由 = **grant 授权闸被完全绕过**。
> - 故不变量：**特权 command 只走 ControlBus 路由，普通领域 API 走 `InMemoryTypedIpcRegistry`
>   路由；两条路由的边界必须在接线处（`deck-app.ts:554`）写死，特权名永不落进普通 hostServices。**
>   这条在 capability 层尚未建（见 §5.2 契约 D），是建它时要强制守住的边界。

- 文件：`src/host/control-bus.ts`（接口 `ControlBus` 在 `control-bus.ts:50`；`dispatch` 真接 wire
  在 `control-bus.ts:124`）。真 wire 桥接 `src/internal/wire-transport.ts`（trust + main-frame
  gate 在 `wire-transport.ts:210-245`）。trust 原语 `src/internal/trust-set.ts`（refcount
  `add`/`isTrusted`/`snapshot` 在 `trust-set.ts:46`）。

### 2.5 ViewHandle —— 薄 per-view 编排（📐 设计完成，待建）
**职责**：把上面四个原语缝成「一块 view」的最小编排单元。它**持有**：原生 view 句柄、一个
scope-lease（绑哪个寿命）、一个 compositor token（在哪个窗口的 z 栈里）。

**硬边界（ViewHandle 不做什么）**：
- **不算布局**——几何来自 Layout/Placement（view-anchor），ViewHandle 只转发。
- **不定释放策略**——寿命归 Scope，ViewHandle 只持一个 lease。
- **不持全局树**——它只知道自己这一块，跨窗口/全局编排在 runtime。
- **不直碰 contentView**——所有 `addChildView`/`removeChildView` 经 Compositor。

API 形态（见第 4 节）：`runtime.view(...)` → `ViewHandle`，带 `placeIn(window, {zone, anchor})`
/ `moveTo(window, ...)` / `dispose()`。

---

## 3. 六个关键架构决定

| # | 决定 | 理由 |
|---|---|---|
| 1 | **混合合成需要一个主进程原生 z 层（Compositor）** | Electron 物理约束：原生 `WebContentsView` 永远盖在 DOM 之上、原生 view 之间不能与 DOM z 穿插。所以「同一区域多块原生 view 谁前谁后」「浮层浮在原生 DevTools 上」只能在主进程排——dockview 这类纯 DOM 库结构上做不到。Compositor 就是这层（基于 spike 实证的 Electron z 语义，`compositor.ts:10-17`）。 |
| 2 | **权威分层** | **窗口内 DOM 布局**（split/grid/tab）真相源在 **renderer 控制层**（可以直接用真 dockview / CSS）；**跨窗口 + 原生 view 编排 + 生命周期** 真相源在**主进程**。两边各自是各自领域的唯一权威，不互相镜像状态。 |
| 3 | **split 分工裁决：host 主进程零布局原语** | DOM 分栏整套交给 renderer。框架只做两件事：① 原生 view 经 view-anchor 跟随任意 slot 的几何；② Compositor 管同区多原生 view 的 z。所以「支持 split」对框架而言**就等于**「拖 splitter 时原生 view 跟随」——这正是 view-anchor 的本职，框架不需要任何 split/grid 原语。与 dockview **分工不替代**（view-anchor = dockview `OverlayRenderContainer` 的跨进程版，见 `view-anchor/src/types.ts:13`）。 |
| 4 | **placement ≠ lifetime** | 「view 显示在哪个窗口」（placement）与「归哪个 scope 管寿命」（lifetime）**正交**。`moveTo` 默认只移**显示**（Compositor 跨窗 mount），寿命不动；要让 view 比原 session 活得久，必须显式 `rehomeTo` 才走 `Scope.adopt` 迁寿命。混淆这两者会导致「搬个面板顺手改了它的释放归属」之类的 bug。 |
| 5 | **popout = live-migrate** | 跨窗口移动**同一块** `WebContentsView` **不重载、不丢 CDP**（真机 spike 实测：`.repro/electron-deck-spikes/gate2.js` 跨双窗口迁移含 setInterval tick + 嵌套 webview guest；`gate2b.js` 钉死 setInterval 连续性 + 关窗后 view 寿命）。底层 = `Scope.adopt`（迁寿命）+ Compositor 跨窗 mount（迁显示），全程**原子单父**（view 任一时刻只挂在一个父片段上）。 |
| 6 | **host-facing 干净 API** | 对 host 暴露的是领域中立的少量动词：`runtime.windows.create → Window`、`runtime.view().placeIn / moveTo`、`window.onClose`、`runtime.grants.issue`、以及受限的 `window.compositor`（reorder/commit/batch）。目标是「最简 devtools ~30 行」（见 `docs/layout-architecture-demo.md`）。 |

---

## 4. host-facing API + 最简 devtools 调用示例

> 完整版见 `docs/layout-architecture-demo.md`。这里给精炼骨架，呼应第 2/3 节的原语与决定。

```ts
import { electronDeck } from '@dimina-kit/electron-deck'

const Z = { CONTENT: 0, PANEL: 10, OVERLAY: 100 }   // Compositor z 分层

electronDeck({}, {
  backend: {
    async assemble(runtime) {
      // 窗口 = 寿命 Scope + z 栈 Compositor + control-layer renderer(DOM 分栏)
      const main = runtime.windows.create({ control: { url: 'app://project-shell' } })

      let session = null
      function openProject(path) {
        session = main.scope.child()                       // 关项目只 reset 它，窗口活着 (决定 A/4)

        runtime.view({ source: simulatorSource(path), scope: session })
               .placeIn(main, { zone: Z.CONTENT, anchor: '#simulator' })   // view-anchor 缝几何
        runtime.view({ source: { devtoolsFor: '#simulator' }, scope: session })
               .placeIn(main, { zone: Z.PANEL, anchor: '#devtools' })
      }

      main.onClose(async () => {                            // 需求 A：close 退回 main
        if (session) {
          await session.reset()                            // 完成栅栏：资源真拆完才继续
          main.bus.event('navigate').publish('project-list')
          session = null
          return 'keep'                                    // 留住窗口
        }
        return 'close'
      })

      function showOverlay(src, rect) {                     // 需求 C：浮在原生之上 = 顶层 zone
        return runtime.view({ source: src, scope: main.scope })
                      .placeIn(main, { zone: Z.OVERLAY, anchorRect: rect })
      }

      function popout(view, win) {                          // 决定 5：live-migrate
        view.moveTo(win, { zone: Z.PANEL, anchor: '#devtools', rehomeTo: win.scope })
      }                                                     // rehomeTo 才迁寿命 (决定 4)

      runtime.grants.issue(main.controlWc, {                // 需求 B：授权 control 层自助布局
        scope: main.scope,
        commands: ['layout.resize', 'layout.reorder', 'layout.popout', 'layout.overlay'],
      })
    },
  },
})
```

控制层 renderer 只画 DOM 分栏 + 原生 view 的占位「洞」，经 IPC client 发布局意图：

```tsx
const deck = await createDeckLayoutClient()   // 自动拿主进程下发的 grant
// <div id="simulator"/> / <div id="devtools"/> 是占位洞，原生 view 由主进程盖上来
// deck.resize('#simulator', rect) / deck.popout('view:devtools') / deck.overlay(...)
```

---

## 5. 已建 vs 待建状态表 + 待闭合契约

> ⚠️ 已按 codex 第3轮统一——**「已建」收窄为「primitive 本身已建（有测试）」，不等于
> 「整个布局系统 ready」**。四个底层 primitive（Scope / Compositor / ControlBus /
> Layout·Placement）确已建且各有单测；但**围绕它们的 host-facing 壳**（ViewHandle /
> `runtime.view` / `runtime.grants` / layout client）**和几条横切契约**（§5.2 的 B/C/D +
> 统一寿命）**尚未闭合**。读这张表时按「primitive 已建、契约/壳待闭合」理解，别把单个
> primitive 的 ✅ 读成「布局/授权能力可直接用」。

### 5.1 状态（按「primitive 本身」 vs 「围绕它的壳/契约」分列）

| 原语 / 壳 | primitive 本身 | 围绕它的壳 / 契约（待闭合） | 文件 |
|---|---|---|---|
| **Scope**（嵌套寿命 + 完成栅栏 + adopt） | ✅ 已建（有测试） | per-wc Scope 地基（与 grant/ViewHandle 共用）、统一寿命契约 | `src/main/scope.ts` |
| **Layout/Placement**（view-anchor，显式 `Placement{visible}`） | ✅ 已建（有测试） | 跟随硬化（契约 B：scroll/transform/display:none/首帧/终止 detach）、ViewHandle 持 anchor 的更新·dispose 归属、slotToken 原子下发 | `packages/view-anchor/src/` |
| **Compositor**（per-window z，fractional indexing + LIS commit） | ✅ 已建（有测试） | 事务化 `commit` + per-window teardown 顺序（契约 C） | `src/main/compositor.ts` |
| **ControlBus**（IPC + trust 薄 facade，真接 WireTransport） | ✅ 已建（有测试） | capability/grant 闸（契约 D；ControlBus 自身只有 trust 闸，**授权层未建**）、senderId 横切 | `src/host/control-bus.ts` + `src/internal/wire-transport.ts` + `src/internal/trust-set.ts` |
| **ViewHandle**（薄 per-view 编排） | 📐 设计完成，**未建** | 整壳待建 | — |
| **capability / grants**（授权层 = grant 闸 + senderId 横切 + per-wc Scope） | 📐 **未建** | 契约 D 全部 | — |
| **layout client**（`createDeckLayoutClient` + `deck.resize/popout/overlay`） | 📐 **未建** | 整壳待建 | — |

> 一句话收窄：**底层 4 primitive 已闭合（建好+有测试）；上层 host-facing 壳（ViewHandle /
> runtime.view / grants / layout client）+ 横切契约（B 跟随硬化 / C commit 事务 / D capability /
> 统一寿命）尚未闭合**。当前能用的是「裸 primitive」，不是「拼好的布局/授权系统」。

### 5.2 待闭合契约（open）

以下是已识别、设计上已收敛但仍需在实现 ViewHandle / 编排层时正式闭合的横切契约，链到 B/C/D
三份契约文档（待补；当前为占位，实现该壳时落地）：

- **契约 B —— view-anchor 跟随硬化**：在 splitter 高频拖动、zoom 变化、target 滚出可视区
  （x/y 允许负）等边界下，原生 view 跟随的确定性与去抖（dedup）保证。当前正向核心已落到
  `view-anchor.ts`，但「ViewHandle 持有 anchor 的更新/dispose 归属」尚未成文。**[open → 契约文档 B]**
- **契约 C —— Compositor 事务化 commit + per-window teardown 顺序**：`commit()` 的原子性、
  与窗口销毁时「先拆 view 再拆 contentView」的顺序保证（呼应 `deck-app.ts:733` 的「destroy
  windows BEFORE registry.disposeAll()」）需要在 ViewHandle ↔ Compositor ↔ Scope 三者间正式
  约定。**[open → 契约文档 C]**
- **契约 D —— capability + senderId 横切**：grant 的 scope 边界（一个窗口的控制层只能动自己
  子树）、senderId 与 capability 的绑定、撤销时机。当前 trust 是 refcount（`trust-set.ts`），
  但 capability 层（`runtime.grants.issue`）尚未建。**[open → 契约文档 D]**
- **tab 保活归属**：tab 切换时「非活动 tab 的原生 view 保活但收起」（`Placement{visible:false}`
  保 WebContents 存活）归 ViewHandle 还是控制层，需要随 ViewHandle 一并定。**[open]**

---

## 6. 关键文件索引

| 路径 | 内容 |
|---|---|
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
| `docs/foundation.md` | 连接层 / Disposable / Scope 地基推导 |
| `docs/framework-extraction-v2.md` | 抽框架 v2 设计（host-shell + 注入式 RuntimeBackend） |
| `.repro/electron-deck-spikes/gate2.js` `gate2b.js` | popout live-migrate 的真机 spike 实证 |
