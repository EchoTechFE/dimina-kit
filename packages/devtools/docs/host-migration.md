# 宿主集成能力参考

适用对象：通过 `launch()` 集成 `@dimina-kit/devtools` 的下游宿主。本文描述若干 host 集成能力的当前契约与语义（host toolbar 通道、`MiniappRuntime`、`onBeforeOpenProject`、`autoShow`、e2e 选窗）。基础接入入口见 [`README`](../README.md)。

下列字段为兼容保留、运行时忽略：

- `headerHeight` 配置：忽略，devtools 工具栏恒 40px。
- `panels` 配置：忽略，调试区恒为全部内置面板（WXML / AppData / Storage / Console / 编译）。
- preload 导出 `createWxmlSource` / `createMiniappSnapshotHost`：miniappSnapshot push/pull 传输在 devtools 内无收端，内置面板数据走主进程专用通道（仍为外部/组合式 preload 保留导出，见 `miniapp-snapshot.md`）。

`CompilationAdapter` 返回的 `session.appInfo` 是结构化 `AppInfo`（`appId: string` 必填，`name?/path?/appName?` 可选）。`openProject` 在适配器 resolve 边界做运行时校验：缺少 string `appId` 的 session 会被 `close()` 并以 `{ success: false, error }` 报告（error 文案含 `appId`），不会成为活动 session。

## 能力

### 1. 高度广播器常驻

框架的高度广播器以 session 级 preload 常驻于 toolbar WebContents，**宿主 `setPreloadPath` 换自己的 preload 不会丢掉它**。宿主无需自己实现 advertiser（硬编码 `'view:host-toolbar:advertise-height'` 通道 + `{axis, extent}` payload + ResizeObserver 测高）。

要求：toolbar 页面保留一个 shrink-to-fit 的 `[data-host-toolbar-root]` 根节点（自动高度）。固定高度场景用 `hostToolbar.setHeightMode({ fixed: n })`，恢复自动用 `setHeightMode('auto')`。

主进程会保留最后一次下发给渲染层的高度（新 getter `views.getHostToolbarHeight()`），项目视图的占位条挂载时主动拉取并回放——广播器去重不重发，宿主无需为「冷启动在项目列表期间上报 / 关闭项目再打开」自行补发高度。

`setHeightMode({ fixed })` 做参数校验：非有限数（`NaN`/`±Infinity`）或负数同步抛 `TypeError`，且**不污染既有模式**（既有的 `'auto'` 或合法 fixed 钉继续生效）——污染值不会到达渲染层 placeholder。

`setPreloadPath(null)` 表示「无宿主 preload」（内置广播器始终常驻，不受 host preload 影响）。

### 2. `onMessage` / `send` 门控窄通道

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

### 3. `onReady` 就绪事件

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

### 4. toolbar 页面桥类型

```ts
import type { DiminaHostToolbarPageBridge } from '@dimina-kit/devtools'
```

- `send` 返回 `void`；`onMessage` 返回**裸退订函数**（与主进程侧的 `{ dispose }` 不同——以 preload 实际注入为准）；
- 随类型一并发布 `Window` 增强：`window.diminaHostToolbar?: DiminaHostToolbarPageBridge`（optional——桥只存在于通过守卫的 toolbar WCV 主 frame）；
- 演进规则：成员只增不改，语义变更开新名字（安全修复/合规修正例外，需版本说明）。

### 5. `MiniappRuntime` 公共契约

```ts
import { asMiniappRuntime, type MiniappRuntime } from '@dimina-kit/devtools'

onSetup(instance) {
  const runtime = asMiniappRuntime(instance.context)
}
```

- 契约覆盖：`workspace`（含 `openProject`/`getSession` 等）、`views.hostToolbar`（含 `onReady`）、`notify.projectStatus`、`registry.add`、`openSettings`；语义化版本承诺：加字段 = minor，移除/收窄 = major；
- `workspace.openProject` 仍保持可写自有属性（monkey-patch 写法不会被破坏），但权限门控**推荐声明式 `onBeforeOpenProject`**（见 §7）——不必重写方法引用；
- `getSession().appInfo` 已结构化且类型已兑现：`MiniappSessionAppInfo`（`appId: string` 必有——`openProject` 在适配器边界强制；`name?/path?/appName?` 可选），无需再 cast；
- `registry.add` 接受两种 disposal 习语：`{ dispose() }` 对象（`onMessage`/`onReady` 的返回值可直接注册）或裸 `() => void`，与运行时一致——`registry.add(() => sub.dispose())` 包装可删；
- `openSettings(): Promise<void>` 打开（或复用聚焦）独立设置窗口——取代旧的「把 `windows` 透传给 `openSettingsWindow`」（该透传从未能通过类型检查）。

宿主 `menuBuilder` 收到的 `MenuContext` 是手写窄契约：`appName` + workspace 窄集（`hasActiveSession`/`getProjectPath`/`openProject`/`closeProject`/`getSession`）+ `openSettings` + `notify.{projectStatus, windowNavigateBack}`。透传整个 ctx 的宿主不受影响（结构子类型仍可赋值）；内部管线字段（`adapter`/`windows`/`bridge`/`connections`/`storageApi`/…）不在菜单面上。

### 6. ⌘Q 退出与活动会话

框架在 `before-quit` 置一个进程级退出标志（`isAppQuitting()`），主窗口 onClose 先读它——**真正的应用退出（⌘Q / 菜单 Quit / `app.quit()`）一律放行**，窗口照常关闭、应用正常退出；只有「会话活跃时的普通关窗」才留在 workbench（转成关项目）。`before-quit` 在每个窗口 `close` 之前触发，标志一定先就位。

宿主无需任何代码改动即获得正确的 ⌘Q 行为。e2e 收尾可直接 `electronApp.close()`，不必先 `project:close`（请在自己的 e2e 上验证收尾时序）。

### 7. `onBeforeOpenProject` 权限门控 hook

`WorkbenchAppConfig` 的声明式 hook，做登录态 / 权限校验的首选，取代对 `workspace.openProject` 的 monkey-patch：

```ts
launch({
  onBeforeOpenProject: async (projectPath) => {
    if (!(await hasPermission(projectPath))) {
      throw new Error('请先登录') // 抛错即否决本次打开
    }
  },
})
```

语义保证（单测钉死）：

- hook 在 `openProject` 的**任何副作用之前**运行——抢在 referer 重置 / 旧会话 `disposeSession()` / 编译·dev-server 启动之前；
- hook **抛错 = 否决**：`openProject` 返回 `{ success: false, error }`（`error` 为 hook 抛出的 message），**当前活动会话保持原样不被拆**，适配器**不会**被调用（无权限旁路）；
- **veto 时框架自动把 error 透到状态条**：与框架自身的 `validateProjectDir` 拒绝路径对称，框架在否决路径上会 `notify.projectStatus({ status: 'error', message })`（`message` 为 hook 抛出的 message）。所以宿主**无需**再为「显示被拒原因」反手摸 `asMiniappRuntime(getHostInstance().context).notify` —— 状态条由框架兜底，宿主只在需要时叠加更丰富的 UX（如 `dialog.showErrorBox`，它是无窗 Electron 全局 API，本就不依赖框架）；
- hook 正常 resolve 或省略 = 放行，行为不变；
- 覆盖全部三个打开入口（IPC / 菜单 / 内部直调）——它们都汇聚到同一个 `openProject`。

`openProject` 仍是可写属性，monkey-patch 写法不会被破坏，但声明式 hook 是推荐路径。

### 8. `window.autoShow` 开关

`WorkbenchAppConfig.window` 的 `autoShow?: boolean`（默认 `true`）控制 `ready-to-show` 是否自动显示主窗口。要先过登录门再显示窗口的宿主设 `autoShow: false`，自己在登录通过后 show：

```ts
launch({
  window: { autoShow: false }, // 框架不自动 show；宿主自己在登录通过后 show
  onSetup(instance) {
    afterLoginGate(() => instance.mainWindow.show())
  },
})
```

语义（可见性由 `autoShow` 在 test / 非 test 两个环境统一决定；环境只决定**怎么**显示，不决定**要不要**显示）：

- `autoShow: false` 时，`ready-to-show` **既不 `show()` 也不 `showInactive()`**——窗口创建即隐藏（`show: false`），由宿主决定何时显示，**test 环境同样如此**，框架不强制显示未鉴权窗口；
- 省略或 `true` 时显示窗口，环境只挑显示方式：非 test → `show()`，test → `showInactive()`（e2e 避免抢焦点）。

宿主在 test 下独占 reveal，无需写防御性 `on('show', hide)` re-hide——窗口按宿主自己的节奏 show 后常规 `waitForFunction` 即可。

### 9. e2e 识别主窗口（用 `window.devtools` 标识）

写 Playwright e2e 选主窗口用框架已注入的 `window.devtools`（主窗口 preload 暴露的 IPC bridge，见 `preload/windows/main.ts`）作稳定选择契约——它是**主窗口独有**的（host-toolbar 暴露的是 `window.diminaHostToolbar`），与展示名解耦、抗时序、抗 WCV 增多。不要用 `electronApp.firstWindow()`（依赖创建顺序，`autoShow:false` 下会抢到 host-toolbar WCV）或 `url().endsWith('index.html')` / title（依赖 renderer 入口路径、会被 `appName` / `brandingProvider` 改写）。e2e 选主窗口：

```ts
async function findMainWindow(electronApp: ElectronApplication, timeout = 30_000): Promise<Page> {
  const deadline = Date.now() + timeout
  for (;;) {
    for (const p of electronApp.windows()) {
      // 主窗口独有的 IPC bridge；host-toolbar 没有它。
      const isMain = await p.evaluate(() => Boolean((window as any).devtools?.ipc)).catch(() => false)
      if (isMain) return p
    }
    if (Date.now() > deadline) throw new Error('main workbench window not found within timeout')
    await new Promise((r) => setTimeout(r, 100))
  }
}
```

框架不导出该 helper（避免把 Playwright 依赖拖进运行时包），但 `window.devtools` 的存在性是稳定契约，宿主据此自维护一份即可，无需再赌 `firstWindow()` 或匹配 URL/title。

## CI / 发布

npm `dev` dist-tag 仅接受 main 分支的 workflow dispatch；其它分支发布到隔离的 `dev-<branch>` dist-tag，不再可能误拨共享 `dev`。

每次发布的 `name@version` 清单（含 npmmirror 手动同步链接）输出在该次 workflow run 的 Step Summary 页面——镜像滞后时可按清单逐包触发同步。

镜像滞后的绕过：可选地在 CI / 本地用 scope registry override（`npm config set @dimina-kit:registry https://registry.npmjs.org`）直连 npmjs。注意：企业内网若拦截 npmjs 出站，**不要**用该 override——应保留内部代理 registry，并按上面的清单为滞后包申请镜像同步。
