# @dimina-kit/electron-deck

Dimina devtools 的 host 集成地基。提供：连接层（per-webContents 的 `Connection` + 资源归属）、host-shell 的跨进程 transport、`DeckConfig` 配置类型与 `defineEvent`，以及 webview 侧的 preload / client。

下游 host（如 qdmp）写一份 `DeckConfig` 交给 `launch(config)`，framework 接管 Electron 装配、IPC、生命周期。

## 入口包归属

`launch()` 入口函数住在 `@dimina-kit/devtools`（它要驱动 devtools 真运行时，而 devtools 已依赖本包——入口放本包会形成循环依赖）。本包提供配置类型、`defineEvent` 和 webview 侧工具：

| 你要的 | 从哪导入 |
|---|---|
| `launch(config)` 入口函数 | `@dimina-kit/devtools` |
| `defineEvent` / `DeckConfig` 等类型 | `@dimina-kit/electron-deck` |
| preload bridge `exposeDeckBridge()` | `@dimina-kit/electron-deck/preload` |
| renderer client `createDeckClient<HS, EV>()` | `@dimina-kit/electron-deck/client` |
| layout-as-data 引擎（`SplitNode`/`TabGroupNode` 树、`movePanel`/`splitPanel`/`closePanel`/`setActive`/`setSizes` 等 mutation、`serializeLayout`/`parseLayout`/`validateTree`、`createLayoutModel` 单写者可观察模型、panel registry） | `@dimina-kit/electron-deck/layout` |
| `<DockView>` React 渲染器（把 layout 树渲染成可拖拽 re-dock / tab / 分屏的 docking UI） | `@dimina-kit/electron-deck/dock-react` |

## 最小例子

```ts
// main.ts
import { launch } from '@dimina-kit/devtools'
import { defineEvent } from '@dimina-kit/electron-deck'

const authChanged = defineEvent<{ user: { id: string } | null }>('authChanged')

// 不要顶层 `await launch(...)`：electron 在 main 模块求值完成前不触发
// app.whenReady()，而 launch() 内部要 await whenReady，顶层 await 会死锁。
launch({
  app: { name: 'My DevTools' },
  hostServices: { getUser: async () => ({ user: null }) },
  events: [authChanged],
}).catch((err) => { console.error('launch() failed:', err) })
```

## 文档

- 连接层（Connection / 资源归属 / debugTap）参考：[`docs/foundation.md`](./docs/foundation.md)
- host 集成（config 字段 / Runtime / preload / client / 必知约束）参考：[`../devtools/docs/workbench-model.md`](../devtools/docs/workbench-model.md)
