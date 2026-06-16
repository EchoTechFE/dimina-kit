# 宿主迁移指南（0.3.x → 0.4.0，含 breaking）

适用对象：通过 `launch()` 集成 `@dimina-kit/devtools` 的下游宿主。

## 版本对照

| 版本 | 变更 |
|---|---|
| **0.4.0（breaking，已删/收紧）** | 删除 `instance.toolbar`（按钮注入机制整体下线）；删除 `MiniappRuntime` 契约上的 `windows` / `rendererDir`（由 `openSettings()` 与 `/paths` 导出取代）；`CompilationAdapter` 的 `session.appInfo` 类型收紧为结构化 `AppInfo`（`appId: string` 必填），`openProject` 在适配器返回边界做运行时校验 |
| **0.4.0（废弃，保留编译兼容）→ 0.5.0（删除）** | `headerHeight` 配置（运行时忽略，恒 40px）；`panels` 配置（运行时忽略，恒显示全部内置面板）；preload 导出 `createWxmlSource`、`createMiniappSnapshotHost`（miniappSnapshot push/pull 传输在 devtools 内已无收端，面板数据改走主进程专用通道） |

## Breaking

| 移除项 | 迁移到 |
|---|---|
| `instance.toolbar`（`toolbar.set` 按钮注入机制整体下线） | host toolbar WCV：`ctx.views.hostToolbar.loadFile/loadURL`，内容/样式/高度完全宿主自控 |
| `MiniappRuntime.windows`（不透明句柄，从未能通过类型检查传给 `openSettingsWindow`） | `runtime.openSettings()`（一等成员，见下文） |
| `MiniappRuntime.rendererDir` | `@dimina-kit/devtools/paths` 导出（`rendererDir` / `getRendererDir`） |
| `CompilationAdapter` 返回的 `session.appInfo: unknown` | 收紧为结构化 `AppInfo`：`appId: string` 必填，`name?/path?/appName?` 可选。`openProject` 在适配器 resolve 的瞬间做运行时校验：缺少 string `appId` 的 session 会被 `close()` 并以 `{ success: false, error }` 报告（error 文案含 `appId`），不会成为活动 session |
| `panel:eval` / `panel:list` / `panel:select` 等 panel 扩展 IPC | 无（从未有真实消费者；将来需要自定义面板时另行设计） |
| 公共导出 `getDefaultTab` / `hasBuiltinPanel` | 无（运行时消费者为零） |

## Deprecated（字段保留、编译不破坏，运行时忽略；0.5.0 删除）

- `headerHeight` 配置：忽略，devtools 工具栏恒 40px。宿主侧的 `headerHeight: 72` 之类可删。
- `panels` 配置：忽略，调试区恒为全部内置面板（WXML / AppData / Storage / Console / 编译）。

## 新能力（取代宿主侧的手搓 workaround）

### 1. 高度广播器常驻化 —— 删掉自己实现的 advertiser

框架的高度广播器现在以 session 级 preload 常驻于 toolbar WebContents，**宿主 `setPreloadPath` 换自己的 preload 不会再丢掉它**。宿主侧可删除：

- 硬编码的 `'view:host-toolbar:advertise-height'` 通道字符串与 `{axis, extent}` payload 复刻；
- 自己写的 ResizeObserver 测高逻辑。

要求：toolbar 页面保留一个 shrink-to-fit 的 `[data-host-toolbar-root]` 根节点（自动高度）。固定高度场景改用 `hostToolbar.setHeightMode({ fixed: n })`，恢复自动用 `setHeightMode('auto')`。

主进程会保留最后一次下发给渲染层的高度（新 getter `views.getHostToolbarHeight()`），项目视图的占位条挂载时主动拉取并回放——广播器去重不重发，宿主无需为「冷启动在项目列表期间上报 / 关闭项目再打开」自行补发高度。

`setHeightMode({ fixed })` 现在做参数校验：非有限数（`NaN`/`±Infinity`）或负数会同步抛 `TypeError`，且**不污染既有模式**（之前的 `'auto'` 或合法 fixed 钉继续生效）——污染值不会到达渲染层 placeholder。

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
- 页面侧握手完成前的 `send` 最多缓存 128 条（FIFO，超限丢弃最新并 console.warn 一次）；
- 页面侧 `send`/`onMessage` 与主进程同语义校验 `channel`：空串或非 string 同步抛 `TypeError`（不占队列槽、不留注册残留）。

### 3. `onReady` —— 删掉轮询 `send()` 的 retry loop

握手完成现在是可观察事件：

```ts
const sub = ctx.views.hostToolbar.onReady(() => {
  // 此刻 send() 必然返回 true —— 推送初始状态的正确时机
  ctx.views.hostToolbar.send('my:init', initialState)
}) // { dispose(): void }
```

- 每个 load generation（每次握手完成）fire 一次；页面 reload 后会对新文档再 fire；
- 已就绪后注册：在微任务上异步补发一次（绝不在 `onReady()` 内同步重入宿主代码），且补发前复查订阅仍存活、generation 未变——同帧 `dispose()` 或同帧 `loadFile` 都会抑制补发；
- 宿主发起的 `loadURL`/`loadFile` 在发起瞬间使就绪失效，期间注册的 handler 等新文档握手。

### 4. toolbar 页面桥类型 —— 删掉手搓的 `window.diminaHostToolbar` 声明

```ts
import type { DiminaHostToolbarPageBridge } from '@dimina-kit/devtools'
```

- `send` 返回 `void`；`onMessage` 返回**裸退订函数**（与主进程侧的 `{ dispose }` 不同——以 preload 实际注入为准）；
- 随类型一并发布 `Window` 增强：`window.diminaHostToolbar?: DiminaHostToolbarPageBridge`（optional——桥只存在于通过守卫的 toolbar WCV 主 frame）；
- 演进规则：成员只增不改，语义变更开新名字（安全修复/合规修正例外，需版本说明）。

### 5. `MiniappRuntime` 公共契约 —— 删掉对 `WorkbenchContext` 的宽依赖

```ts
import { asMiniappRuntime, type MiniappRuntime } from '@dimina-kit/devtools'

onSetup(instance) {
  const runtime = asMiniappRuntime(instance.context)
}
```

- 契约覆盖：`workspace`（含 `openProject`/`getSession` 等）、`views.hostToolbar`（含 `onReady`）、`notify.projectStatus`、`registry.add`、`openSettings`；语义化版本承诺：加字段 = minor，移除/收窄 = major；
- `workspace.openProject` 仍保持可写自有属性（旧的 monkey-patch 权限门控不会被破坏），但权限门控**推荐改用声明式 `onBeforeOpenProject`**（见下方「新能力 §7」）——不必再重写方法引用；
- `getSession().appInfo` 已结构化且类型已兑现：`MiniappSessionAppInfo`（`appId: string` 必有——`openProject` 在适配器边界强制；`name?/path?/appName?` 可选），无需再 cast；
- `registry.add` 接受两种 disposal 习语：`{ dispose() }` 对象（`onMessage`/`onReady` 的返回值可直接注册）或裸 `() => void`，与运行时一致——`registry.add(() => sub.dispose())` 包装可删；
- `openSettings(): Promise<void>` 打开（或复用聚焦）独立设置窗口——取代旧的「把 `windows` 透传给 `openSettingsWindow`」（该透传从未能通过类型检查）。

宿主 `menuBuilder` 收到的 `MenuContext` 同步改为手写窄契约：`appName` + workspace 窄集（`hasActiveSession`/`getProjectPath`/`openProject`/`closeProject`/`getSession`）+ `openSettings` + `notify.{projectStatus, windowNavigateBack}`。透传整个 ctx 的宿主不受影响（结构子类型仍可赋值）；此前经 `Omit` 投影可达的内部管线字段（`adapter`/`windows`/`bridge`/`connections`/`storageApi`/…）不再在菜单面上。

### 6. ⌘Q 退出不再被活动会话吞掉 —— 框架内部修复，宿主无需改代码

此前：主窗口 `close` 事件的处理器只要 `hasActiveSession()` 为真就无条件 `preventDefault()`，把关闭转成「关项目、留 workbench」。它**不区分**「用户点红绿灯关窗」与「用户按 ⌘Q / 菜单退出整个应用」——于是开着项目时 ⌘Q 退不掉应用，只关掉了项目。

现在：框架在 `before-quit` 置一个进程级退出标志（`isAppQuitting()`），主窗口 onClose 先读它——**真正的应用退出（⌘Q / 菜单 Quit / `app.quit()`）一律放行**，窗口照常关闭、应用正常退出；只有「会话活跃时的普通关窗」才仍留在 workbench。`before-quit` 在每个窗口 `close` 之前触发，标志一定先就位。

宿主侧影响：

- 无需任何代码改动即获得正确的 ⌘Q 行为。
- 如果你的 e2e 收尾里有「必须先 `project:close` 再 `electronApp.close()`，否则 worker 永挂」这类祖传 workaround（针对裸 close 被吞的旧行为），**可以重新评估能否简化为直接 close**——请在你自己的 e2e 上验证后再删，本仓库未代你验证你的收尾时序。

### 7. `onBeforeOpenProject` 权限门控 hook —— 删掉对 `workspace.openProject` 的 monkey-patch

此前：框架没有「打开项目前」的声明式 hook，宿主要做登录态 / 权限校验只能重写 `ctx.workspace.openProject` 方法引用（文档曾把这条 monkey-patch 写成契约）。重写方法引用是脆弱的——上游若新增不走该引用的打开入口，门控会静默失效。

现在：`WorkbenchAppConfig` 新增声明式 hook：

```ts
launch({
  onBeforeOpenProject: async (projectPath) => {
    if (!(await hasPermission(projectPath))) {
      throw new Error('请先登录') // 抛错即否决本次打开
    }
  },
})
```

语义保证（已被单测钉死）：

- hook 在 `openProject` 的**任何副作用之前**运行——抢在 referer 重置 / 旧会话 `disposeSession()` / 编译·dev-server 启动之前；
- hook **抛错 = 否决**：`openProject` 返回 `{ success: false, error }`（`error` 为 hook 抛出的 message），**当前活动会话保持原样不被拆**，适配器**不会**被调用（无权限旁路）；
- hook 正常 resolve 或省略 = 放行，行为不变；
- 覆盖全部三个打开入口（IPC / 菜单 / 内部直调）——它们都汇聚到同一个 `openProject`。

宿主侧可删除整段重写 `openProject` 闭包的 monkey-patch，改为传 `onBeforeOpenProject`。`openProject` 仍是可写属性，旧 monkey-patch 不会被破坏，可平滑迁移。

### 8. `window.autoShow` 开关 —— 删掉 `removeAllListeners('ready-to-show')`

此前：框架在主窗口 `ready-to-show` 上硬挂自动 `show()`，没有开关。要先过登录门再显示窗口的宿主，只能在 `onSetup` 里 `instance.mainWindow.removeAllListeners('ready-to-show')` 再自己重挂——霰弹枪式，会连带干掉框架将来挂在同一事件上的其它逻辑，宿主无从知情。

现在：`WorkbenchAppConfig.window` 新增 `autoShow?: boolean`（默认 `true`）：

```ts
launch({
  window: { autoShow: false }, // 框架不自动 show；宿主自己在登录通过后 show
  onSetup(instance) {
    afterLoginGate(() => instance.mainWindow.show())
  },
})
```

语义：

- `autoShow: false` 时，非 test 环境的 `ready-to-show` **不再** `show()`——窗口创建即隐藏（`show: false`），由宿主决定何时显示，不会闪现未鉴权窗口；
- 省略或 `true` 时行为不变（非 test → `show()`）；
- **不影响 test 环境**：`NODE_ENV==='test'` 仍走 `showInactive()`（e2e 依赖），`autoShow` 不会压制它。

宿主侧可删除 `removeAllListeners('ready-to-show')`，以及为「隐藏窗口里 rAF 轮询 stall」而改用的 `evaluate` 死循环轮询（窗口按宿主自己的节奏 show 后，常规 `waitForFunction` 即可）。

## CI / 发布

npm `dev` dist-tag 仅接受 main 分支的 workflow dispatch；其它分支发布到隔离的 `dev-<branch>` dist-tag，不再可能误拨共享 `dev`。

每次发布的 `name@version` 清单（含 npmmirror 手动同步链接）输出在该次 workflow run 的 Step Summary 页面——镜像滞后时可按清单逐包触发同步。

镜像滞后的绕过：可选地在 CI / 本地用 scope registry override（`npm config set @dimina-kit:registry https://registry.npmjs.org`）直连 npmjs。注意：企业内网若拦截 npmjs 出站，**不要**用该 override——应保留内部代理 registry，并按上面的清单为滞后包申请镜像同步。
