# @dimina-kit/electron-deck

> 给 Electron 应用用的窗口与视图编排框架：把「多窗口、原生 `WebContentsView` 的层叠与几何跟随、浮层与 popout、跨进程 IPC」做成一组正交原语，让宿主用很少的代码拼出一套 host-shell。

它和小程序无关，是领域中立的。`@dimina-kit/devtools` 是它目前最大的使用者。

## 安装

```bash
pnpm add @dimina-kit/electron-deck
```

`electron`（`^43.2.0`）是可选 peer——只用 `/layout` + `/dock-react` 的纯浏览器项目不需要它。React 面（`/dock-react`）需要 React ≥ 18。

## 你多半是这两种用法之一

### 一、接管整个 Electron 应用的装配

实现一份 `RuntimeBackend`（在 `assemble(runtime)` 里建窗口、接自己的 IPC），把它交给 `electronDeck()`：

```ts
// main.ts
import { electronDeck } from '@dimina-kit/electron-deck'
import { myBackend } from './my-backend.js'

electronDeck({ backend: myBackend }).catch((err) => {
  console.error(err)
  process.exit(1)
})
```

框架负责等 `app.whenReady()`、接线 transport、划信任边界；你只负责领域内的装配（真实 context、主窗口内容、各种 view、IPC 模块）。设 `ownsWindows: true` 表示主窗口完全由 backend 自己建。

`@dimina-kit/devtools` 的 `launch(config)` 就是「预置一个 devtools backend + 调 `electronDeck({ backend })`」的薄封装，集成 devtools 时直接用它就行，见 [`../devtools/docs/workbench-model.md`](../devtools/docs/workbench-model.md)。

> **别在 main 模块顶层 `await electronDeck()`**。Electron 要等 main 模块求值完成才触发 `whenReady`，顶层 await 会死锁。用 `.catch(...)` 收尾，或改用 `startElectronDeck()`（它内部已对 `whenReady` 做了 gating）。

### 二、只要窗口内的 docking 布局

`@dimina-kit/electron-deck/layout` 是纯 TypeScript 的 layout-as-data 引擎，`@dimina-kit/electron-deck/dock-react` 是配套的 `<DockView>` React 渲染器。Electron devtools 的 IDE 式可停靠布局和纯浏览器的 web 项目都直接用这两个子路径。

- 布局是一棵可序列化的 `SplitNode` / `TabGroupNode` 树；`movePanel` / `splitPanel` / `closePanel` / `insertPanel` / `setActive` / `setSizes` / `setConstraint` 是它的 mutation，`serializeLayout` / `parseLayout` / `validateTree` 负责持久化与校验，`createLayoutModel` 是单写者的可观察模型。
- split 子节点可以带 `SizeConstraint`：`fixedPx` 锁死到 N px；`minPx` 同样按像素定尺（有下限、不参与弹性权重分配），但用户仍可拖宽。
- panel descriptor 可以带 `PanelCapabilities`（`draggable` / `dropPolicy` / `closable` / `hideTab`），`<DockView>` 据此约束拖拽和关闭；`computeReorderIndex` 是配套的纯几何函数。

这两个子路径（含其传递依赖）**不允许引入 `electron` 或 `node` 依赖**：`/layout` 连 `react` 都不能 import，`/dock-react` 的运行时依赖只有 `react` / `react-dom` / `react-resizable-panels`。两条边界分别由 `src/layout/boundary.test.ts` 和 `src/dock-react/boundary.test.ts` 钉死。

## 导出

| 你要的 | 从哪导入 |
|---|---|
| `electronDeck` 入口、`DeckConfig` / `RuntimeBackend` 等类型 | `@dimina-kit/electron-deck` |
| 主进程装配工具 | `@dimina-kit/electron-deck/main` |
| host 侧 control-bus / capability / trust 原语 | `@dimina-kit/electron-deck/host` |
| preload bridge `exposeDeckBridge()` | `@dimina-kit/electron-deck/preload` |
| renderer client `createDeckClient<HS, EV>()` | `@dimina-kit/electron-deck/client`（`/client/browser` 是同一产物的别名） |
| layout-as-data 引擎 + panel registry | `@dimina-kit/electron-deck/layout` |
| `<DockView>` + `computeReorderIndex` | `@dimina-kit/electron-deck/dock-react` |

## 实验性：声明式装配面

除上面两条路径外，本包还有一套声明式装配面——`startElectronDeck()` 的顶层配置（`hostServices` / `simulatorApis` / `events` / `toolbar`）和 `runtime.windows` / `runtime.view` / `runtime.scopes` / `runtime.grants` 等高层 API：

```ts
import { startElectronDeck, defineEvent } from '@dimina-kit/electron-deck'

const authChanged = defineEvent<{ user: { id: string } | null }>('authChanged')

startElectronDeck({
  app: { name: 'My DevTools' },
  hostServices: { getUser: async () => ({ user: null }) },
  events: [authChanged],
})
```

目前的调用者只有本包的 [`examples/layout-demo`](./examples/layout-demo)、[`examples/dockable-demo`](./examples/dockable-demo) 和 devtools 的 popout spike（`../devtools/spike/popout/harness.mjs`），没有生产消费者，请当作 `@experimental`：签名可能变化，也没有经过非 demo 的工作负载验证。判断某个实现是否已上生产，看谁在调 `assemble` / `backend`，不要以这段教程为准。

值得说明的是 devtools 为什么没用这套面：它不是「还没排上」，而是有一处结构性冲突——`runtime.windows.adopt()` 会无条件给被接管的窗口建一套自己的原生子视图 owner（私有顺序表 + 自己的 compositor，直接写 `win.contentView`），而 devtools 的主窗口已经有一个独占 owner 在写同一棵树。冲突是**按窗口**发生的，不是某个 API 的问题。详见 [`../devtools/docs/deck-adoption-decision.md`](../devtools/docs/deck-adoption-decision.md)。

`startElectronDeck()` 相对 `electronDeck()` 唯一确定的好处是它内部已对 `app.whenReady()` 做了 gating，可以在 main 模块顶层直接调用。

## 文档

- [架构总览](./docs/architecture.md)——四个布局 / 多窗口原语、注入式 `RuntimeBackend`、信任边界、生命周期
- [连接层](./docs/foundation.md)——`Connection`、资源归属、debugTap
- [横切契约](./docs/contracts/)
- [宿主集成实例（devtools）](../devtools/docs/workbench-model.md)

## License

[MIT](../../LICENSE) © EchoTechFE
