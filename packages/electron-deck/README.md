# @dimina-kit/electron-deck

领域中立的 Electron host-shell 框架。它把跨窗口编排、原生 `WebContentsView` 的 z 叠放与几何跟随、嵌套寿命管理抽成一组正交原语，让任意 Electron 多窗口应用用极少的 host 代码拼出「窗口 + 原生 view + 浮层 + popout」。同时提供 host-shell 的跨进程 transport（声明式 + typed 双向 IPC）、信任边界、确定性资源生命周期，以及 webview 侧的 preload / client。

## 入口

框架入口 `electronDeck(config, options?)` 与 `startElectronDeck(...)` 都从本包根导出。host 写一份 `DeckConfig`，framework 接管 Electron 装配、IPC、生命周期：

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

`startElectronDeck()` 内部已对 `app.whenReady()` 做 gating，可在 main 模块顶层直接调用。`electronDeck()` 是其 await 版本——若直接用它，不要在 main 模块顶层 `await`（electron 在 main 模块求值完成前不触发 `whenReady`，顶层 await 会死锁），改用 `startElectronDeck()` 或 `electronDeck(...).catch(...)`。

`@dimina-kit/devtools` 的 `launch(config)` 是预注入 devtools backend 的薄封装——集成 devtools 时用它，见 [`../devtools/docs/workbench-model.md`](../devtools/docs/workbench-model.md)。

## 导出

| 你要的 | 从哪导入 |
|---|---|
| `electronDeck` / `startElectronDeck` 入口、`defineEvent`、`DeckConfig` / `RuntimeBackend` 等类型 | `@dimina-kit/electron-deck` |
| 主进程装配工具 | `@dimina-kit/electron-deck/main` |
| host 侧 control-bus / capability / trust 原语 | `@dimina-kit/electron-deck/host` |
| preload bridge `exposeDeckBridge()` | `@dimina-kit/electron-deck/preload` |
| renderer client `createDeckClient<HS, EV>()` | `@dimina-kit/electron-deck/client`（浏览器构建：`/client/browser`） |
| layout-as-data 引擎（`SplitNode`/`TabGroupNode` 树、`movePanel`/`splitPanel`/`closePanel`/`insertPanel`/`setActive`/`setSizes`/`setConstraint` mutation、`serializeLayout`/`parseLayout`/`validateTree`、`createLayoutModel` 单写者可观察模型、panel registry，descriptor 可带 `PanelCapabilities`：`draggable`/`dropPolicy`/`hideTab`；split 子可带 `SizeConstraint`：`fixedPx` 锁死 / `minPx` 柔性下限） | `@dimina-kit/electron-deck/layout` |
| `<DockView>` React 渲染器（把 layout 树渲染成可拖拽 re-dock / tab / 分屏的 docking UI；按 descriptor 的 `PanelCapabilities` 约束拖拽——`draggable:false` 锁定为不可拖且不可作落点锚，`dropPolicy:'reorder-only'` 只允许组内重排）+ `computeReorderIndex` 纯几何 | `@dimina-kit/electron-deck/dock-react` |

## 文档

- 架构总览（四个布局/多窗口原语、注入式 `RuntimeBackend`、信任边界、生命周期）：[`docs/architecture.md`](./docs/architecture.md)
- 连接层（`Connection` / 资源归属 / debugTap）：[`docs/foundation.md`](./docs/foundation.md)
- 横切契约：[`docs/contracts/`](./docs/contracts/)
- host 集成（以 devtools 为例）：[`../devtools/docs/workbench-model.md`](../devtools/docs/workbench-model.md)
