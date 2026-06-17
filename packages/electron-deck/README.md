# @dimina-kit/electron-deck

领域中立的 Electron host-shell 框架。一个 host 写一份 `DeckConfig`，框架接管 Electron 装配、IPC、信任边界、生命周期、多窗口与原生 `WebContentsView` 编排。

本包提供两个正交的公开面：

- **host-shell**：`electronDeck()` 入口、注入式 `RuntimeBackend`、跨进程 wire transport（typed IPC + 声明式事件）、信任边界、嵌套寿命、`ViewHandle` 原生 view 编排。
- **layout-as-data**：纯 TS 的窗口内 docking 布局引擎（`LayoutTree` / mutation / 序列化 / 可观察模型）+ React `<DockView>` 渲染器。

两面互不依赖：host-shell 不 import 布局引擎，布局引擎不 import electron。

## 入口与导出

| 你要的 | 从哪导入 |
|---|---|
| `electronDeck(config)` / `startElectronDeck(config)` 入口 | `@dimina-kit/electron-deck` |
| `defineEvent` / `DeckConfig` / `RuntimeBackend` 等类型 | `@dimina-kit/electron-deck` |
| wire transport（`WireTransport` / `ControlBus` / `EventBus` / capability / trust） | `@dimina-kit/electron-deck/host` |
| 连接层（`createConnectionRegistry` / `Connection` / `Scope` / `Compositor` / `ViewHandle`） | `@dimina-kit/electron-deck/main` |
| preload bridge（`exposeDeckBridge()` / `exposeDeckLayoutBridge()`） | `@dimina-kit/electron-deck/preload` |
| renderer client（`createDeckClient()` / `createDeckLayoutClient()`） | `@dimina-kit/electron-deck/client` |
| layout-as-data 引擎（`LayoutTree`、`movePanel`/`splitPanel`/`closePanel`/`setActive`/`setSizes` 等 mutation、`serializeLayout`/`parseLayout`/`validateTree`、`createLayoutModel` 单写者可观察模型、`createPanelRegistry`） | `@dimina-kit/electron-deck/layout` |
| `<DockView>` React 渲染器（把 layout 树渲染成可拖拽 re-dock / tab / 分屏的 docking UI） | `@dimina-kit/electron-deck/dock-react` |

`electronDeck()` 是 `async` 且内部 `await app.whenReady()`。ESM main 顶层 `await electronDeck(...)` 会在 whenReady 闸上挂死（Electron `ready` 要等模块求值完才 fire），所以顶层入口用 `startElectronDeck()`——它**同步**返回 `{ ready, dispose }`，装配仍严格在 `app.whenReady()` 之后跑。

## 最小例子

```ts
// main.ts
import { startElectronDeck, defineEvent } from '@dimina-kit/electron-deck'

const authChanged = defineEvent<{ user: { id: string } | null }>('authChanged')

const { ready } = startElectronDeck({
  app: { name: 'My DevTools' },
  hostServices: { getUser: async () => ({ user: null }) },
  events: [authChanged],
  backend: {
    async assemble(runtime) { /* 领域装配 */ },
  },
})

ready.catch((err) => { console.error('electron-deck startup failed:', err) })
```

devtools host 用 `@dimina-kit/devtools` 的 `launch(config)`——它是预注入 devtools backend 的 `electronDeck()` 薄封装。

## 文档

- [`docs/architecture.md`](./docs/architecture.md) —— 布局 / 多窗口 / 框架机制总览（host 集成入口）。
- [`docs/foundation.md`](./docs/foundation.md) —— 连接层（Connection / 资源归属 / debugTap）。
- [`docs/layout-architecture-demo.md`](./docs/layout-architecture-demo.md) —— 「最简 devtools」host-facing 调用形态。
- [`docs/contracts/`](./docs/contracts/) —— capability / compositor-teardown / 统一寿命 / view-anchor 跟随 / ViewHandle 的契约与不变量。
