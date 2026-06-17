# electron-deck 架构总览

`@dimina-kit/electron-deck` 是一个**领域中立的 Electron host-shell 框架**。本文面向第一次接触本包的工程师与要做 host 集成的人，讲清楚：框架做什么、由哪些原语组成、每个原语的职责边界、host 怎么用，以及必须守住的关键不变量。

配套阅读：
- `docs/foundation.md` —— 连接层 / Disposable / Scope 地基。
- `docs/layout-architecture-demo.md` —— 「最简 devtools」host-facing 调用形态。
- `docs/contracts/` —— capability / compositor-teardown / 统一寿命 / view-anchor 跟随 / ViewHandle 的契约与不变量。
- `packages/view-anchor/README.md` —— Layout/Placement 原语的独立包文档。

---

## 0. 定位

electron-deck 不替你做窗口内的 DOM 分栏，而是把**跨窗口编排、原生 `WebContentsView` 的 z 叠放与几何跟随、嵌套寿命管理、跨进程 IPC 与信任边界**抽成一组正交原语，让业务（devtools / simulator / 任意 Electron 多窗口工具）用极少的 host 代码拼出「窗口 + 原生 view + 浮层 + popout」。

host 写一份 `DeckConfig`，框架接管 Electron 装配；领域逻辑经注入式 `RuntimeBackend` 接入（见 §3）。

### 与 dockview 的关系：分工而非替代

dockview（或任意 CSS / React 分栏库）是**窗口内 DOM 布局**的权威：split / grid / tab 的真相源在 renderer 控制层。dockview 内部的 `OverlayRenderContainer` 做 `getBoundingClientRect → RAF → reposition`，把一个 follower 贴到面板上——但它的 follower 是 **DOM 节点**。electron-deck 的 `view-anchor` 是同一机制的**跨进程版本**：follower 是主进程的原生 `WebContentsView`。

一句话：**dockview 管 DOM 怎么分；electron-deck 管原生 view 怎么跟着 DOM 走、跨窗口怎么搬、寿命归谁。**

### 两个正交的公开面

本包有两个互不依赖的 surface：

- **host-shell 原语**（§1–§5）：Scope / Compositor / ControlBus / view-anchor / ViewHandle / Window facade。
- **layout-as-data 引擎**（§6）：`/layout` 纯 TS 布局树 + `/dock-react` 的 `<DockView>` 渲染器。

host-shell 不依赖布局引擎，布局引擎也不 import electron。一个 host 可以只用其中一面，也可以两面都用、走两条独立的 seam（devtools 即如此：窗口装配走 host-shell，项目窗口内的分栏走布局引擎）。

---

## 1. 框架的六条能力

electron-deck 覆盖的是「没有单一现成框架能一站式提供」的组合能力：

1. **配置驱动 host-shell 装配**：app 生命周期 + 多窗口 / `WebContentsView`。
2. **声明式 + typed 双向 IPC**：含「必须先声明才能 publish」的事件总线。
3. **信任边界 / sender policy**：沙箱 untrusted vs trusted host 分级 + frame 级校验。
4. **确定性资源生命周期**：LIFO dispose + 连接 / 窗口寿命绑定。
5. **原生 `WebContentsView` 编排**：z 叠放 + 几何跟随 + 跨窗 popout。
6. **领域无关**：可被任意 Electron 应用复用。

其中 typed IPC（②）与 LIFO dispose（④）已有成熟生态（electron-trpc / 原生 `DisposableStack`），框架按需复用其思想；真正的空白在 ①③⑤ 的组合，这也是框架原语的核心。

---

## 2. 物理约束：为什么需要主进程原生 z 层

**Electron 的原生 `WebContentsView` 永远合成在 DOM 之上，且原生 view 之间不能与 DOM 在 z 轴上穿插。** 这条硬约束决定了整套架构形态：

- 「浮在原生 DevTools 之上的下拉 / 设置面板」**本身必须是一块原生 view**（放进更高的 z 层），不可能是 DOM 元素——DOM 永远在原生 view 之下。
- 同一窗口里多块原生 view 的前后关系，需要一个**主进程侧的原生 z 层规划器**来管。纯 DOM 库（dockview）给不了这个。→ **Compositor**。
- 「窗口被 splitter 拖动时原生 view 跟着 DOM 占位走」是 → **Layout/Placement（view-anchor）**。

由此推出三类 host 需求各落到一个原语：

| host 需求 | 落到 |
|---|---|
| 点 close 退回 main 而非关窗（销毁项目资源、留住窗口） | **Scope** 嵌套寿命：窗口寿命 ⊃ 会话寿命，关项目 = `reset` 会话 |
| renderer 经 IPC 自助控制布局（resize / reorder / popout），且有权限边界 | **ControlBus** + **capability** |
| 浮层浮在原生 view 之上 | **Compositor** 顶层 zone |

---

## 3. 注入式 `RuntimeBackend`

框架是唯一 orchestrator，但通过注入的 `RuntimeBackend` 拿领域装配——框架不知道 projects / simulator / wx 这些领域概念存在。`RuntimeBackend` 是 `DeckConfig.backend` 字段，除 `assemble` 外所有 hook 都可选（缺省走框架默认）：

```ts
interface RuntimeBackend {
  /** pre-ready：lazy-import electron 之后、app.whenReady 之前跑领域 pre-ready 副作用
   *  （difile scheme / cdp port / CSP / setName）。拿框架已 resolve 的 MinimalApp。 */
  beforeReady?(app: MinimalApp): MaybePromise<void>
  /** true：backend 在 assemble 内自建主窗口，框架跳过 main/toolbar/declared 装配。 */
  readonly ownsWindows?: boolean
  /** 领域装配：真 context / mainWindow 内容加载 / projects / views / IPC 模块。 */
  assemble(runtime: Runtime): MaybePromise<void>
  /** 框架建主窗口前同步取 webPreferences（与 config 合并，backend 键优先）。
   *  仅 ownsWindows falsy 路径触发。 */
  mainWindowWebPreferences?(): Record<string, unknown> | undefined
  /** 框架建完主窗口、load 内容前同步回调（attach view / listener）。
   *  仅 ownsWindows falsy 路径触发。 */
  onMainWindowCreated?(win: BrowserWindow, electron: typeof import('electron')): void
  /** 框架 edge-trust 一个**自建**窗口时通知 backend 同步领域 trust；返回 Disposable 供 untrust。
   *  主窗口受 ownsWindows 门控（ownsWindows:true 不触发）；declared / runtime.windows.create()
   *  窗口与 ownsWindows 正交，总触发。 */
  onWindowTrusted?(wc: MinimalWebContents): Disposable
  /** 主窗 close（可否决）：'keep' → 框架 preventDefault 留窗；'close' → 放行析构→shutdown。 */
  onMainWindowClose?(): MaybePromise<'keep' | 'close'>
  /** 框架 resize 时回调，backend 用发出 resize 的主窗口重定位 overlay。
   *  仅 ownsWindows falsy 路径触发。 */
  repositionOverlays?(win: BrowserWindow): void
}
```

### 框架边界

- **框架做**：app 生命周期 + 主窗口 + 多窗口创建 + wire（typed IPC + 声明式事件）+ 信任边界 + 连接 / 资源 LIFO dispose + 布局编排原语。
- **领域 backend 做**：toolbar / overlay 内容、off-wire CDP、session / workspace、projects / templates、difile / cdp / csp 等领域副作用。

### 入口与 app 生命周期

框架不许 value-import electron 主进程面，`app` 经 lazy `await import('electron')` 注入。类型面 `MinimalApp` 暴露 `whenReady()` / `quit()` / `setName()` / 生命周期 `on(...)` / 可选 `requestSingleInstanceLock()`；`electronDeck()` 在生产路径用真 `app` 实例，测试路径注入桩。

执行序列（生产路径，无环）：lazy `import('electron')` → 拿真 app → single-instance 门控（仅 `config.app.singleInstance`：`whenReady` 之前调 `requestSingleInstanceLock()`，没拿到锁即 `quit()`）→ `backend.beforeReady(app)`（pre-ready 窗口确凿存在：import 后 / whenReady 前）→ `await app.whenReady()` → 绑定 app 生命周期 → 装配窗口（此刻 `new BrowserWindow` 合法）→ `backend.assemble(runtime)`。

- `will-quit` → `shutdown()`（LIFO dispose，带 `quitInitiated` 闸防再入）。
- `window-all-closed` → **opt-in**：仅 `config.app.quitOnAllWindowsClosed` 显式给值时框架才绑该 listener；省略则不绑，由 Electron 默认 / consumer 自理。

> ⚠️ `electronDeck()` 是 `async` 且内部 `await app.whenReady()`。ESM main 顶层 `await electronDeck(...)` 会挂死（Electron `ready` 要等模块求值完才 fire）。顶层入口用 `startElectronDeck()`——同步返回 `{ ready, dispose }`，装配仍严格在 whenReady 之后跑，启动失败经 `ready` 暴露。

---

## 4. 四个正交原语 + 薄 ViewHandle

整套 host-shell = **4 个正交 primitive** + 一层**薄 ViewHandle** 编排壳。正交 = 互不依赖、可独立测试、各自只管一件事。

```
                       ┌─────────────────────────────────────────┐
   runtime.view()  ──► │            ViewHandle (薄编排壳)          │
                       │  持: native view + scope-lease + compositor token │
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

### 4.1 Scope —— 嵌套寿命

一段「寿命片段」。`own()` 绑资源、`child()` 开子寿命；`reset()`（软复用：拆掉当前片段、开新片段、自己活着）和 `close()`（终结：全拆、死掉）统一释放，LIFO，跨层（孙→子→父）。

**完成栅栏（completion fence）**：`reset()/close()` 的 Promise 只在底层 async `disposeAll` 真正跑完之后才 resolve、才 fire 监听器；不是「触发即忘」。这让父的 `await child.close()` 是一次真等待（单飞 in-flight，重入合流）。

**adopt**：把一个 child 从当前父的片段重挂到另一个父的片段上，**不 reset / 不 close**——child 的 `own()` 资源原封不动，只换「从此谁负责拆它」。若任一端有 teardown 在飞，adopt 等栅栏（不抛），等完后对新鲜片段重新校验。这是 popout 迁寿命的底层。

实现：`src/main/scope.ts`。

### 4.2 Layout/Placement —— DOM rect ↔ native bounds

独立包 `@dimina-kit/view-anchor`。让一块主进程原生 view 始终贴住某个 DOM 元素的屏幕矩形：测 `getBoundingClientRect()`，把矩形交给注入的 `publish`（host 接 IPC → `setBounds`），并在 `ResizeObserver` / window `resize` 时**同步**重发（不走 RAF——原生 setBounds 本就慢一帧，再叠一帧会在拖 splitter 时拖尾）。

**显式 `Placement{visible}`**：可见性是**判别式**，绝不从几何推断。

- `{ visible:true, bounds }`：有几何盒。「有盒但被排成 0×0」是合法罕见情形 `{ visible:true, bounds:{...width:0} }`。
- `{ visible:false }`（**不带 bounds**）：隐藏 / 无几何盒（`display:none`、未 mount）。

判别口诀：**有盒但 0 面积 → visible:true+0×0；无盒 → visible:false**。`visible:false` = 「不显示这个 view」，由**调用方意图 hide** **或** **锚测出无几何盒**两路 OR 得出（锚报客观事实，不篡改意图）。详见 `contracts/view-anchor-following.md`。

**跟随硬化**（opt-in，`followScroll` / `followGeometry` / `guardDisplayNone` / `pulse()`）：在嵌套 split / scroll / 祖先 transform / `display:none` / 首帧 / 动画期下让原生 view 跟住 DOM slot。事件能精确通告的信号（自身尺寸 / 整窗 resize / 祖先 scroll）走同步发布；无事件的位移（transform / 祖先重排）走**窗口化** RAF 几何哨兵（静止零成本）。详见 `contracts/view-anchor-following.md`。

**反向（size-advertiser）**：正向让原生 view 跟 DOM；反向让 DOM 占位跟内容尺寸（在下游 view 自己的渲染进程里量 border-box 回流给宿主）。单轴所有权（block=高 / inline=宽），保证跨进程环是单向 DAG。

实现：`packages/view-anchor/src/`。

### 4.3 Compositor —— per-window 原生 z 叠放

规划一个窗口内原生子 view 的 z 顺序。把**意图**（`mount` / `unmount` / `reorder` 到某 zone 的某相对位置）与**应用**（`commit()` 算出把 host 当前子序变成目标序的**最小** add/remove 序列）分开。

**全序 `(zone, orderKey, viewId)`**：低 zone 渲染在下、高 zone 在上；zone 内按 `orderKey` 排；`viewId` 兜底保证确定性。`orderKey` 用 **fractional indexing**：reorder-before(X) 取 X 与其前驱的中点，O(1) 且不扰动其他 key；中点精度耗尽时整 zone 重编号（rebalance，对可见顺序无感）。

**LIS commit**：把一批意图折叠成**最终目标态**（last-state，不是写日志回放），再 diff host 当前子序与目标。host 只能 `addChildView` 到顶，所以保留「当前∩目标里已就位的最长前缀」（LIS），其余共享 view + 全部新 view 在一个同步 pass 里 remove+add 重排——最小 host churn、零 renderer reload。

**事务化 commit**：no-op（无 add/无 remove）静默 return；有工作但 host 已毁 → preflight 在动 host 之前抛 `CommitError{kind:'host-destroyed', applied:false}`（native 未动）；apply 中途非预期抛 → snapshot 兜底回滚 → 抛 `apply-failed{recovered}`。**teardown 例外**：工作仅 removals 且 host 已毁时视为已 detach、静默 return（detach 路径在销毁竞态下保证不抛）。详见 `contracts/compositor-and-teardown.md`。

实现：`src/main/compositor.ts`。

### 4.4 ControlBus —— IPC + trust 薄 facade

三个动词的薄门面，自己不加新 gating：

- `command(name, handler)`：webview → main 的 RPC。门面持唯一命令表，`dispatch(name, args, ctx)` 被真 `WireTransport` 的 `invokeHost`/`invokeSimulator` seam 调到（在 wire 的 sender + main-frame gate 之后）。
- `event(name)`：main → webview 推送，默认拒绝；`name` 加进 wire 读的 declared-event allowlist，未声明的被丢弃。
- `trust(wc)`：委托给可注入的 refcount `TrustSet`。

命令表是**唯一命令权威**：生产侧用 `invokeHost = (n,a,ctx) => controlBus.dispatch(n,a,ctx)` 建 `WireTransport`，config 声明的 host service 也注册进同一张表（一个命名空间，永不两张会撞的注册表）。

**capability 闸**（`ControlBus.dispatch` 内，trust 之上）：注入 `CapabilityPolicy` 后，`dispatch` 在 command 表解析之后、handler 调用之前判 grant——`policy.allows(senderId, name)` 为假即抛 `DECK_FORBIDDEN`。闸层次不可换序：`wire trust → wire main-frame → ControlBus grant → handler`。不注入 policy ⇒ 闸不存在 ⇒ 维持「trusted 即可 dispatch」（向后兼容）。

> 🔒 **硬不变量——布局 / 特权 command 必须唯一经 ControlBus**：grant 闸**只存在于 `ControlBus.dispatch`**。生产 deck-app 有**两条 invoke 路由**：默认路由 `invokeHost = (name,args) => ipc.invoke(HOST_PREFIX+name)` 走 `InMemoryTypedIpcRegistry`，**只做 trust 闸、没有 grant 闸**，承载普通领域 API（`hostServices`，「trusted 即可调」）；`layout.*` 等驱动原生 view / 寿命 / 跨窗的特权 command **必须**经 ControlBus 注册并 dispatch。**禁止**把特权名注册进普通 `hostServices`——否则 grant 授权闸被完全绕过。两条路由的边界在接线处写死，特权名永不落进普通 hostServices。

实现：`src/host/control-bus.ts` + `src/internal/wire-transport.ts`（trust + main-frame gate）+ `src/internal/trust-set.ts` + `src/host/capability.ts`。

### 4.5 ViewHandle —— 薄 per-view 编排

把上面四个原语缝成「一块 view」的最小编排单元。它持有：原生 view 句柄、一个 scope-lease（绑哪个寿命）、一个 compositor token（在哪个窗口的 z 栈里）。

**硬边界（ViewHandle 不做什么）**：
- **不算布局**——几何来自 view-anchor，ViewHandle 只转发 `Placement → setBounds/detach`。
- **不定释放策略**——寿命归 Scope，ViewHandle 只持一个 lease。
- **不持全局树**——它只知道自己这一块，slot-token 私表 / LRU 组归 runtime。
- **不直碰 contentView 做 z 挂载**——`addChildView`/`removeChildView` 经 Compositor（per-view `setBounds` 由 ViewHandle 自调，Compositor 纯 z-order）。

API 形态（见 §5）：`runtime.view(...)` → `DeckViewHandle`，带 `placeIn(window, {zone, anchor})` / `applyPlacement({visible, bounds})` / `moveTo(window, {zone, anchor, rehome})` / `dispose()`，并暴露只读访问器 `webContents` / `bounds()` / `capturePage()`。

**`moveTo` 跨窗迁移**：受 per-view `migrationLock` 串行化，物理终态恒在 `{AT_SRC, AT_DEST, CLOSED}` 之一（绝不悬空 / 双挂）；回滚动作与 dest 失败种类解耦（恒为「src 重挂」）。`rehome:true` 经 `Scope.adopt` 把 view 寿命重挂到 dest 窗口。详见 `contracts/compositor-and-teardown.md` 与 `contracts/view-handle-build-plan.md`。

实现：`src/main/view-handle.ts`。

---

## 5. host-facing API + 最简调用示例

> 完整可跑版见 `examples/layout-demo/`。`runtime.windows.create()` / `runtime.windows.main` 返回 **`DeckWindow`** 句柄 `{ window, controlWc, newSession(), onClose() }`——把寿命树 / compositor / trust 接线吸收进框架，host 不碰裸 primitive。`newSession()` 铸 window-rooted `DeckSession`（窗口寿命 ⊃ session 寿命）；`runtime.view({ scope })` 只接受它（provenance 校验，裸 Scope 被拒）。

```ts
import { startElectronDeck } from '@dimina-kit/electron-deck'

const Z = { CONTENT: 0, PANEL: 10, OVERLAY: 100 }   // Compositor z 分层

startElectronDeck({
  app: { source: { url: 'app://project-shell' } },   // 框架建 + 自动加载主窗口
  backend: {
    async assemble(runtime) {
      const main = runtime.windows.main               // DeckWindow（框架建的主窗口）

      let session = null
      function openProject(path) {
        session = main.newSession()                    // window-rooted session：关项目只拆它，窗口活着

        runtime.view({ source: simulatorSource(path), scope: session })
               .placeIn(main.window, { zone: Z.CONTENT, anchor: '#simulator' })   // view-anchor 缝几何
        runtime.view({ source: { devtoolsFor: '#simulator' }, scope: session })
               .placeIn(main.window, { zone: Z.PANEL, anchor: '#devtools' })
      }

      main.onClose(async () => {                       // close 退回 main（per-window 可取消决策）
        if (session) {
          await session.dispose()                      // 完成栅栏：资源真拆完才继续
          session = null
          return 'keep'                                // 留住窗口（host 自发 navigate 回 project-list）
        }
        return 'close'
      })

      function showOverlay(src, anchor) {              // 浮在原生之上 = 顶层 zone
        return runtime.view({ source: src, scope: main.newSession() })
                      .placeIn(main.window, { zone: Z.OVERLAY, anchor })
      }

      runtime.grants.issue(main.controlWc, {           // 授权 control 层自助布局
        commands: ['layout.resize', 'layout.reorder', 'layout.overlay'],
      })
    },
  },
})
```

控制层 renderer 只画 DOM 分栏 + 原生 view 的占位「洞」，经 layout client 发布局意图：

```tsx
import { createDeckLayoutClient } from '@dimina-kit/electron-deck/client'

const deck = createDeckLayoutClient({ bridge: window.__electronDeckLayoutBridge })
// <div id="simulator"/> / <div id="devtools"/> 是占位洞，原生 view 由主进程盖上来；
// view-anchor 在 client 内 ResizeObserver 重测 → 原生块跟随 DOM slot，host 写 0 行 resize 代码。
```

### 关键架构决定

| # | 决定 | 理由 |
|---|---|---|
| 1 | **混合合成需要一个主进程原生 z 层（Compositor）** | Electron 物理约束：原生 view 永远盖在 DOM 之上、原生 view 之间不能与 DOM z 穿插。纯 DOM 库结构上做不到。 |
| 2 | **权威分层** | 窗口内 DOM 布局（split/grid/tab）真相源在 renderer 控制层；跨窗口 + 原生 view 编排 + 生命周期真相源在主进程。两边各是各自领域的唯一权威，不互相镜像状态。 |
| 3 | **host 主进程零布局原语** | DOM 分栏整套交给 renderer。框架只做：① 原生 view 经 view-anchor 跟随任意 slot 几何；② Compositor 管同区多原生 view 的 z。「支持 split」对框架 = 「拖 splitter 时原生 view 跟随」，不需要任何 split/grid 原语。 |
| 4 | **placement ≠ lifetime** | 「view 显示在哪个窗口」（placement）与「归哪个 scope 管寿命」（lifetime）正交。`moveTo` 默认只移显示，寿命不动；要让 view 比原 session 活得久，必须显式 `rehome` 才走 `Scope.adopt`。 |
| 5 | **popout = live-migrate** | 跨窗口移动**同一块** `WebContentsView` 不重载、不丢 CDP。底层 = `Scope.adopt`（迁寿命）+ Compositor 跨窗 mount（迁显示），全程原子单父。 |
| 6 | **host-facing 干净 API** | 对 host 暴露领域中立的少量动词：`runtime.windows.create → DeckWindow`、`runtime.view().placeIn / moveTo`、`window.onClose`、`runtime.grants.issue`。 |

### 安全：控制 wc 导航撤权

控制 wc 做主帧跨文档导航时，框架**同步撤销**它的 grant + slot token（`did-start-navigation` → 撤权），新文档不会继承旧页面的 `layout.*` 特权；trust 保留（仍是控制面）。晚信任（`windows.trust()` / `windows.adopt()`）的窗口同样在其 `'closed'` 上同步撤权（`prependListener`，跑在 host 的 `'closed'` 监听之前），防 wc.id 复用继承旧授权。

> host-view surface（`runtime.view` / `windows.create` / `grants` / `scopes` / `layout` / `DeckViewHandle`）当前标 `@experimental`——原语与接线均已就位、有测试与 demo 自证，但生产 devtools 仍以 `ownsWindows:true` 旁路集成、未采纳这套高层 API（见 `../devtools/docs/deck-adoption-decision.md`）。

---

## 6. layout-as-data 引擎 + DockView（窗口内 docking 布局）

与 §1–§5 host-shell 原语**正交**的第二个公开面：一套领域中立的「窗口内 docking 布局」能力，供任何 Electron 工具把面板拼成可拖拽 re-dock / tab / 分屏 / 序列化恢复的 IDE 式布局。

### 6.1 layout-as-data 引擎（`@dimina-kit/electron-deck/layout`）

**纯 TS**——`src/layout/` 下严禁 import `electron` / `react`（`boundary.test.ts` 钉死这条边界）。原生面板只引用一个 electron-free 的不透明句柄 `NativeHandleRef`，由 host 自己映射回真 view。

- **数据模型**：布局是一棵不可变树 `LayoutTree`，节点是 `SplitNode`（`row`/`column` 容器，带每子一份 `sizes` 权重 + 可选 `constraints` 做 per-child fixed-px 锁宽）或 `TabGroupNode`（一组 panelId + 当前 `active`）。
- **面板登记**：`PanelDescriptor` 分 `dom`（renderer 内 React 内容）/ `native`（带 `NativeHandleRef` 的主进程 view）两类；`createPanelRegistry()` 维护 panelId → descriptor。
- **mutation（纯函数，树→树）**：`movePanel` / `splitPanel` / `closePanel` / `setActive` / `setSizes` / `setConstraint` / `extractPanel` / `insertPanel`。
- **序列化 / 校验**：`serializeLayout` / `parseLayout`（不透明字符串往返持久化）+ `validateTree`（结构合法性 + panelId 是否都在已知集合内，给 fallback-safe 恢复用）。
- **可观察模型**：`createLayoutModel(tree)` 是一个**单写者** `LayoutModel`（`get` / `apply(mut)` / `subscribe(snap)`），把树变更广播给渲染层。

### 6.2 `<DockView>`（`@dimina-kit/electron-deck/dock-react`）

`<DockView model registry renderDomPanel bindNativeSlot>` 把 `LayoutModel` 渲染成 docking UI：

- DOM 面板经 `renderDomPanel(panelId, { active })` 渲染 React 内容；原生面板经 `bindNativeSlot(panelId, el)` 把一个空 DOM 槽交给 host——host 用 view-anchor 把主进程 view 贴到该槽。
- **DOM 面板 keepalive**：同一 tab group 内的 DOM 面板全部常驻挂载，非 active 的用 `display:none` 隐藏（不卸载），切 tab 来回不 remount——滚动位置 / 展开态保留。`active` 标志让面板能在 false→true 边沿跑「激活时副作用」。**原生面板例外**：仍 active-only 挂载（隐藏一个已 bind 的 WebContentsView 槽会塌缩其 rect），失活即卸载并触发 `bindNativeSlot(panelId, null)` 清理。
- **交互**：拖拽 tab → drop 区做 split / tab re-dock（HTML5 DnD），拖分隔条 resize，切 tab，关闭面板（守卫整树最后一个面板）；纯几何的 drop-zone 计算（`computeDropZone` / `dropZoneToMutation` / `isNoopRedock`）从本 entry 导出。
- **fixed-px `constraints`** 让某个 leaf（如 simulator 的设备宽）保真不被权重缩放。
- **可视分屏双向同步**：react-resizable-panels 的 `defaultSize` 只在挂载读取，所以 `SplitView` 持 rrp `Group` 的命令式 handle：程序化 `setSizes`（model→view）经 `setLayout` 推动已挂载的分隔条真正移动（不必 remount）；用户拖分隔条 / 键盘 resize（view→model）经 `onLayoutChanged` 写回 model。写回去重靠**基准归一化的 flexible 比例比较**（>0.1pp 才写），单一判据即可区分「真用户 resize（写回）」与「自身 `setLayout` 回声 / 比例守恒的自发重测（跳过）」，无需指针门控或 echo-token。fixed-px 子项的权重在写回时保持不变。

### 6.3 与 host-shell 原语的关系

布局引擎不碰 Scope / Compositor / ControlBus / Window facade，也不要求 host 采纳它们；host-shell 原语同样不依赖布局引擎。devtools 同时用两者，但走不同的 seam：项目窗口内的分栏用 `/layout` + `/dock-react`，窗口装配 / 原生 view 寿命走 `ownsWindows:true` 旁路。

---

## 7. 关键文件索引

| 路径 | 内容 |
|---|---|
| `src/electron-deck.ts` | `electronDeck()` / `startElectronDeck()` 入口 + config 校验 |
| `src/internal/deck-app.ts` | `DeckApp` orchestrator：whenReady gating、窗口装配、close 决策机、shutdown 顺序、runtime 工厂 |
| `src/internal/electron-types.ts` | `MinimalElectron` + `MinimalApp`（type-only 注入面） |
| `src/internal/wire-transport.ts` | 真 Electron wire：`ipcMain.handle` 路由 + trust / main-frame gate + event fanout + `InvokeCtx` |
| `src/internal/trust-set.ts` | refcount 信任成员集 |
| `src/host/control-bus.ts` | ControlBus 薄 facade：`command/event/trust/dispatch` |
| `src/host/capability.ts` | capability 授权层：grant 注册表 + policy（grant 闸） |
| `src/main/scope.ts` | Scope 嵌套寿命：`own/child/reset/close/adopt` + 完成栅栏 |
| `src/main/compositor.ts` | Compositor：`(zone,orderKey,viewId)` 全序、fractional indexing、LIS commit、事务化 `CommitError` |
| `src/main/view-handle.ts` | ViewHandle per-view 编排 + `placeIn/applyPlacement/moveTo/dispose` + moveTo 状态机 |
| `src/main/connection.ts` | 连接层原语（见 `docs/foundation.md`） |
| `src/layout/` | layout-as-data 引擎（纯 TS）；公开面在 `index.ts` |
| `src/dock-react/` | `<DockView>` React 渲染器 + 纯几何 drag-to-redock；公开面在 `index.ts` |
| `src/client/` | renderer client：`createDeckClient` / `createDeckLayoutClient` |
| `src/preload/` | preload bridge：`exposeDeckBridge` / `exposeDeckLayoutBridge` |
| `packages/view-anchor/src/` | view-anchor 正反向几何（`Placement` 类型 / 正向核心 / size-advertiser） |
