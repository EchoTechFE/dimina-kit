# 宿主迁移指南（0.3.x → 下一版本，含 breaking）

适用对象：通过 `launch()` 集成 `@dimina-kit/devtools` 的下游宿主。

## Breaking

| 移除项 | 迁移到 |
|---|---|
| `instance.toolbar`（`toolbar.set` 按钮注入机制整体下线） | host toolbar WCV：`ctx.views.hostToolbar.loadFile/loadURL`，内容/样式/高度完全宿主自控 |
| `panel:eval` / `panel:list` / `panel:select` 等 panel 扩展 IPC | 无（从未有真实消费者；将来需要自定义面板时另行设计） |
| 公共导出 `getDefaultTab` / `hasBuiltinPanel` | 无（运行时消费者为零） |

## Deprecated（字段保留、编译不破坏，运行时忽略）

- `headerHeight` 配置：忽略，devtools 工具栏恒 40px。宿主侧的 `headerHeight: 72` 之类可删。
- `panels` 配置：忽略，调试区恒为全部四个面板。

## 新能力（取代宿主侧的手搓 workaround）

### 1. 高度广播器常驻化 —— 删掉自己实现的 advertiser

框架的高度广播器现在以 session 级 preload 常驻于 toolbar WebContents，**宿主 `setPreloadPath` 换自己的 preload 不会再丢掉它**。宿主侧可删除：

- 硬编码的 `'view:host-toolbar:advertise-height'` 通道字符串与 `{axis, extent}` payload 复刻；
- 自己写的 ResizeObserver 测高逻辑。

要求：toolbar 页面保留一个 shrink-to-fit 的 `[data-host-toolbar-root]` 根节点（自动高度）。固定高度场景改用 `hostToolbar.setHeightMode({ fixed: n })`，恢复自动用 `setHeightMode('auto')`。

`setPreloadPath(null)` 语义变化：现在表示「无宿主 preload」（旧语义「恢复内置广播器」已无意义——内置运行时永远在）。

### 2. `onMessage` / `send` 门控窄通道 —— 删掉裸 `ipcMain.on` + sender 比对

主进程侧：

```ts
const sub = ctx.views.hostToolbar.onMessage('my:channel', (payload) => { ... }) // Disposable
const ok = ctx.views.hostToolbar.send('my:channel', payload) // boolean
```

toolbar 页面侧（框架自动注入，无需任何 preload 配合）：

```js
window.diminaHostToolbar.send('my:channel', payload)
const off = window.diminaHostToolbar.onMessage('my:channel', handler)
```

语义要点：

- 底层是点对点 MessagePort，**无需也无法被其它窗口伪造 sender**——`getHostToolbarWebContentsId()` + `event.sender.id` 比对的手工门控可整体删除；
- `send` 返回 `false` 表示未投递（无 toolbar / 导航进行中 / 握手未完成），**不排队**；
- `onMessage` 注册跨页面 reload 存活，无需重挂；
- 页面侧握手完成前的 `send` 最多缓存 128 条（FIFO，超限丢弃最新并 console.warn 一次）。

### 3. `MiniappRuntime` 公共契约 —— 删掉对 `WorkbenchContext` 的宽依赖

```ts
import { asMiniappRuntime, type MiniappRuntime } from '@dimina-kit/devtools'

onSetup(instance) {
  const runtime = asMiniappRuntime(instance.context)
}
```

- 契约覆盖：`workspace`（含 `openProject`/`getSession` 等）、`views.hostToolbar`、`notify.projectStatus`、`registry.add`、`rendererDir`；语义化版本承诺：加字段 = minor，移除/收窄 = major；
- `workspace.openProject` 保持可写自有属性——宿主对它的包装（如权限门控）不受影响；
- `getSession().appInfo` 已结构化（`appId`/`name`/`path`），无需再 cast。

## CI / 发布

npm `dev` dist-tag 仅接受 main 分支的 workflow dispatch；其它分支发布到隔离的 `dev-<branch>` dist-tag，不再可能误拨共享 `dev`。
