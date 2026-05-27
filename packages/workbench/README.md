# @dimina-kit/workbench

Dimina devtools 的 host 集成框架。host 写一份 `WorkbenchConfig` 交给 `workbench(config)`，framework 接管 Electron 装配、IPC、生命周期。dimina-devtools 自身与下游 host（qdmp 等）走同一条入口。

```ts
import { workbench, defineEvent } from '@dimina-kit/workbench'

const authChanged = defineEvent<{ user: { id: string } | null }>('authChanged')

await workbench({
  app: { name: 'My DevTools' },
  hostServices: { getUser: async () => ({ user: null }) },
  events: [authChanged],
})
```

三个 import 路径：

- `@dimina-kit/workbench` — main 进程入口、`defineEvent`、类型
- `@dimina-kit/workbench/preload` — webview preload 用 `exposeWorkbenchBridge()`
- `@dimina-kit/workbench/client` — webview renderer 用 `createWorkbenchClient<HS, EV>()`

完整字段说明、Runtime 接口、生命周期、host 集成代码示例见 [`packages/devtools/docs/workbench-model.md`](../devtools/docs/workbench-model.md)。
