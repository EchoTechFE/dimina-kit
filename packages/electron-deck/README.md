# @dimina-kit/electron-deck

领域中立的 Electron host-shell 框架。它把跨窗口编排、原生 `WebContentsView` 的 z 叠放与几何跟随、嵌套寿命管理抽成一组正交原语，让任意 Electron 多窗口应用用极少的 host 代码拼出「窗口 + 原生 view + 浮层 + popout」。同时提供 host-shell 的跨进程 transport（声明式 + typed 双向 IPC）、信任边界、确定性资源生命周期，以及 webview 侧的 preload / client。

本包有两个**生产消费面**：

1. **`backend` 装配**（下面「入口」一节）——领域方实现 `RuntimeBackend`，把 `electronDeck({ backend })` 当唯一入口，自己建窗口、自己接线 IPC。`@dimina-kit/devtools` 就是这样接入的。
2. **`/layout` + `/dock-react`**（下面「浏览器消费面」一节）——纯窗口内 docking 布局引擎，Electron devtools 和纯浏览器 web 项目都在用。

框架自身的声明式装配面（`startElectronDeck` 顶层配置 `hostServices` / `simulatorApis` / `events` / `toolbar`，`runtime.windows` / `runtime.view` 等 host-shell 高层 API）目前**没有生产消费者**，见文末「实验性面」一节。

## 入口：`backend` 装配（生产路径）

领域方实现一份 `RuntimeBackend`（`assemble(runtime)` 建窗口、接域内 IPC；`ownsWindows: true` 让框架把主窗口装配完全让给 backend），把它交给 `electronDeck`：

```ts
// main.ts
import { electronDeck } from '@dimina-kit/electron-deck'
import { myBackend } from './my-backend.js'

electronDeck({ backend: myBackend }).catch((err) => {
  console.error(err)
  process.exit(1)
})
```

框架接管 process 生命周期 gate（`app.whenReady()`）、wire transport、信任边界；backend 只负责领域装配（真实 context、主窗口内容、projects/simulator/views、IPC 模块）。`@dimina-kit/devtools` 的 `launch(config)` 就是「预置 devtools backend + 调 `electronDeck({ backend })`」的薄封装——集成 devtools 时直接用它，见 [`../devtools/docs/workbench-model.md`](../devtools/docs/workbench-model.md)。

`electronDeck()` 不要在 main 模块顶层 `await`（electron 在 main 模块求值完成前不触发 `whenReady`，顶层 await 会死锁）——用 `.catch(...)` 收尾，或改用 `startElectronDeck()`（见「实验性面」一节，内部已对 `whenReady` 做 gating，可在顶层直接调用）。

## 浏览器消费面：`/layout` + `/dock-react`

`@dimina-kit/electron-deck/layout`（纯 TS 的 layout-as-data 引擎：`SplitNode`/`TabGroupNode` 树、`movePanel`/`splitPanel`/`closePanel`/`insertPanel`/`setActive`/`setSizes`/`setConstraint` mutation、`serializeLayout`/`parseLayout`/`validateTree`、`createLayoutModel` 单写者可观察模型、panel registry）和 `@dimina-kit/electron-deck/dock-react`（`<DockView>` React 渲染器）是**双端消费面**：Electron devtools（IDE-dockable 布局）和纯浏览器的 web 项目都直接消费。

因此这两个子路径（及其传递依赖）**禁止引入 `electron` / `node` 依赖**——`/layout` 连 `react` 都不许 import（`src/layout/boundary.test.ts` 钉死这条边界），`/dock-react` 的运行时依赖仅限 `react` / `react-dom` / `react-resizable-panels`（`src/dock-react/boundary.test.ts` 钉死）。split 子节点可带 `SizeConstraint`：`fixedPx` 锁死到 N px；`minPx` 同样是 px-sized（有最小像素下限、不参与弹性权重池），但用户仍可把它拖宽。descriptor 可带 `PanelCapabilities`：`draggable`/`dropPolicy`/`closable`/`hideTab`，`<DockView>` 按它约束拖拽/关闭交互；`computeReorderIndex` 是配套的纯几何函数。

## 导出

| 你要的 | 从哪导入 |
|---|---|
| `electronDeck` 入口、`DeckConfig` / `RuntimeBackend` 等类型 | `@dimina-kit/electron-deck` |
| 主进程装配工具 | `@dimina-kit/electron-deck/main` |
| host 侧 control-bus / capability / trust 原语 | `@dimina-kit/electron-deck/host` |
| preload bridge `exposeDeckBridge()` | `@dimina-kit/electron-deck/preload` |
| renderer client `createDeckClient<HS, EV>()` | `@dimina-kit/electron-deck/client`（`/client/browser` 是同一产物的别名） |
| layout-as-data 引擎 + panel registry（见上「浏览器消费面」） | `@dimina-kit/electron-deck/layout` |
| `<DockView>` React 渲染器 + `computeReorderIndex`（见上「浏览器消费面」） | `@dimina-kit/electron-deck/dock-react` |

## 实验性面（无生产消费者）

以下声明式装配教程和 host-shell 高层 API 目前只有本包自己的 `examples/` / `spike/` 在用——devtools 等下游都走上面的 `backend` 装配路径，从不触达这套面。在第二个真实消费者采纳之前，把它们当 `@experimental`：签名可能变化，未经非 demo 工作负载验证。

```ts
// main.ts
import { startElectronDeck, defineEvent } from '@dimina-kit/electron-deck'

const authChanged = defineEvent<{ user: { id: string } | null }>('authChanged')

startElectronDeck({
  app: { name: 'My DevTools' },
  hostServices: { getUser: async () => ({ user: null }) },
  events: [authChanged],
})
```

`startElectronDeck()` 内部已对 `app.whenReady()` 做 gating，可在 main 模块顶层直接调用——这是它相对 `electronDeck()` 的唯一优势；装配面本身（`hostServices`/`simulatorApis`/`events`/`toolbar`、`runtime.windows`/`runtime.view`/`runtime.scopes`/`runtime.grants`/`runtime.layout` 等 host-shell 高层 API）仍是实验性的。判定「实现是否已上生产」以谁在调 `assemble`/`backend` 为准，不是这份教程。

## 文档

- 架构总览（四个布局/多窗口原语、注入式 `RuntimeBackend`、信任边界、生命周期）：[`docs/architecture.md`](./docs/architecture.md)
- 连接层（`Connection` / 资源归属 / debugTap）：[`docs/foundation.md`](./docs/foundation.md)
- 横切契约：[`docs/contracts/`](./docs/contracts/)
- host 集成（以 devtools 为例）：[`../devtools/docs/workbench-model.md`](../devtools/docs/workbench-model.md)
