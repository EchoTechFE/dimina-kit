# devtools 扩展模型

> 状态：**已定稿（2026-05-22），实施中。** 经 3 轮设计评审（含一轮对抗性评审）收敛。
> 配套：[`miniapp-snapshot.md`](./miniapp-snapshot.md)。`miniappSnapshot` 统一面板**数据**同步；本文统一下游 host 对 devtools 的**扩展**。

## 摘要（TL;DR）

devtools 不是独立 app，而是供下游 host 集成、定制的开发者工具平台。host 注入编译适配器、品牌、工具栏、simulator 自定义 API、自定义 IPC ——这些注入点就是**扩展点**，是 devtools 作为平台的对外契约。

当前唯一下游是 `qdmp`（同团队自有项目）。本文按「满足 qdmp 实际使用」定范围，不为假想消费者过度设计。

问题：扩展点散在三种范式（配置 Provider / 模块组装 / 裸 IPC），安全网关、生命周期、可发现性各行其是。本文统一为一句话：

> **`WorkbenchContext` 是唯一扩展容器。** 扩展按基数分两类，共守三条硬规则。

**clean break**：qdmp 与 devtools 同团队、可协调，迁移 lockstep —— 旧路径随重构一并删除，不留 `@deprecated`、不留双轨。

## 1. 什么是扩展点

host 用 `createWorkbenchApp(config)` 集成 devtools，注入自己的实现：

| 扩展需求 | 例子 |
|---|---|
| 编译适配器 `adapter` | 用 host 自己的编译器替换内置 devkit |
| 品牌 / 工具栏 / 菜单 | 换 logo、改工具栏按钮、改应用菜单 |
| simulator 自定义 API | 让模拟器里的小程序能调 `wx.<hostApi>()` |
| 自定义 IPC | host 专属的主进程能力（登录、上传、绑定应用…） |

## 2. 现状的三个病灶（为什么要改）

经代码核实，现有扩展点散在三种范式，要改的是三个病灶：

1. **范式分裂**：工具栏按钮的**列表**走配置项 `toolbarActions`，按钮的**行为**走裸 `ipcMain.handle('toolbar:action:*')` —— 同一功能的两半、分属两种范式、不在一处声明。

2. **安全边界不齐**：`register*Ipc` 都经 `IpcRegistry`（`senderPolicy` 白名单 + zod 校验）；但裸 IPC 完全绕过 `senderPolicy`，且 `IpcRegistry` 根本没对外导出 —— host 想走安全路也拿不到。`UpdateManager` 装配时漏传 `senderPolicy`，是个应直接修的 bug。

3. **生命周期混乱**：`register*Ipc` 返回 `Disposable` 进 `ctx.registry`、随 context 销毁（健康）；`registerSimulatorApi` 写**进程级单例**（多 context 串味、disposer 被同名注册覆盖成 no-op）；裸 IPC handler 完全无主，host 必须自己 `removeHandler` 否则泄漏。

附带两笔卫生债：`setHeaderHeight()` 是进程级可变量，且只改主进程的 `HEADER_H`，renderer 另有硬编码 `HEADER_H = 40` 够不着 —— host 设非 40 的高度时 renderer 实际渲染错位。`extraModules` 是幽灵字段：`WorkbenchModule` 的 JSDoc 承诺它，`WorkbenchAppConfig` 无此字段、代码无处理。

## 3. 目标模型

### 3.1 两类扩展

切分维度是**基数**：host 提供「一个」，还是添加「多个」。

**配置 Provider（构造期 · 一对一）** —— host 提供一个实现，替换或定制 devtools 的某个内置能力。

涵盖：`adapter`、`brandingProvider`、`preloadPath`、`rendererDir`、`apiNamespaces`、`icon`、`appName`、`updateChecker`、`menuBuilder`、`headerHeight`。

→ 留在 `createWorkbenchApp` 配置项，构造期确定。这一范式本身健康，只需收尾。

**Contribution（onSetup 期 · 一对多）** —— host 添加多个同类条目，或注册行为。

涵盖：simulator 自定义 API、工具栏、自定义 IPC。

→ 通过 `onSetup(instance)` 拿到的 `instance` 上的 typed 方法注册，setup 期确定，全部 per-context。这一范式是当前最乱的（进程全局、裸 IPC 都在这里），是本文重构的主体。

### 3.2 三条硬规则

无论配置 Provider 还是 Contribution，都受同一组规则约束。

| 规则 | 含义 |
|---|---|
| **I1 容器归属** | 注册物挂在 `WorkbenchContext` 上，绝不进程全局、绝不模块级可变量。 |
| **I2 IPC 经网关** | host 注册的 IPC 一律经 `IpcRegistry`（`senderPolicy` + zod）。`instance.ipc` 是唯一受支持路径。 |
| **I3 生命周期** | 注册返回 `Disposable`，进 `ctx.registry`，随 context 销毁级联清理。 |

> **I2 的诚实表述**：host 在技术上永远能 `import { ipcMain } from 'electron'` 裸调 —— 框架无法物理阻止。I2 的保证是「`instance.ipc` 是唯一**受支持**路径，文档与示例只给这一条、`IpcRegistry` 之外不开任何裸 IPC 入口」，不号称「裸 IPC 物理不可能」。

类型单一来源、自定义 preload 漏装 `installCustomApisBridge` 时 warn —— 降为实现要求，不单列为不变量。

### 3.3 接口

```ts
// onSetup 的入参类型为 WorkbenchHostInstance；运行时实际传入其超集 WorkbenchAppInstance
interface WorkbenchHostInstance {
  readonly context: WorkbenchContext

  // ── Contribution：全部 per-context、自动进 ctx.registry ──
  registerSimulatorApi(name: string, handler: SimulatorApiHandler): Disposable
  readonly toolbar: { set(actions: ToolbarAction[]): void }   // 原子整表替换
  readonly ipc: IpcRegistry                                    // gated 自定义 IPC
  registerTrustedWindow(win: BrowserWindow): Disposable        // host 弹窗加入受信 sender 集
}

interface ToolbarAction {
  id: string                              // 全表唯一，重复则 set() 抛错
  label: string
  handler: () => void | Promise<void>
}
```

设计要点：

- **`toolbar.set(actions[])` 整表替换**：工具栏天然是「按 host 当前状态算出的一张表」（如 qdmp 按登录态显示「登录」或「注销」、`label` 含真实用户名）。host 状态变化时构造新表、整体 `set()` —— 框架原子替换 label + handler、dispose 被移除项的 handler、校验 id 唯一、通知 renderer。这比「一次性 `registerToolbarAction` + 额外的 change 事件」更贴合实际：后者把「重算一张表」拆成了两件事。
- **`instance.ipc`**：host 注册自定义 IPC 的唯一受支持入口，已绑定 `ctx.senderPolicy`，注册物自动进 `ctx.registry`。
- **`registerTrustedWindow`**：默认 `senderPolicy` 只信主窗口 + settings 窗口 + 两个 overlay。host 自己的弹窗（加载 host 自有 HTML、可信）需经此显式加入受信集，否则其发起的 `instance.ipc` 调用会被拒。返回 `Disposable`，窗口关闭即移除。

## 4. 各扩展点归位

| 扩展点 | 现状 | 目标 |
|---|---|---|
| `adapter` / `brandingProvider` / `preloadPath` / `rendererDir` / `apiNamespaces` / `icon` / `appName` / `updateChecker` | 配置 Provider | 不变（范式正确） |
| `menuBuilder` | 配置 Provider，收裸 `WorkbenchContext` | 保留；签名收窄为 menu-only context（不交出 `registry` 等内部状态） |
| `setHeaderHeight` | 进程级可变量，够不着 renderer | 收为 `headerHeight` config，下发 main + renderer |
| `updateChecker` → `UpdateManager` | 装配漏传 `senderPolicy` | 补传（修 bug） |
| `IpcRegistry` | 未导出 | 对外导出（host 写自定义 IPC 的基类） |
| `registerSimulatorApi` | 进程级单例 | `instance.registerSimulatorApi`，删进程全局导出与 `simulatorApiRegistry` |
| toolbar：`toolbarActions` + 裸 `toolbar:action:*` | provider（列表）+ 裸 IPC（行为）分裂 | `instance.toolbar.set()` 合一，删两者 |
| `onSetup` 内裸 `ipcMain.handle` | 绕过 senderPolicy、无主 | `instance.ipc`（host 弹窗经 `registerTrustedWindow`） |
| 模块组装 `register*Ipc` 公共导出 | 对外导出 | 撤公共导出（devtools 内部继续用 `WorkbenchModule` 组织内置模块） |
| `extraModules`（幽灵） | JSDoc 承诺、无实现 | 删误导的 JSDoc |

## 5. 实施步骤

clean break，一次推完；6 步是可 review 的 PR 切分。每个 breaking 步与 qdmp 的对应改动 lockstep 同落（本期先做 devtools 侧，qdmp 迁移随后）。

1. **地基**：导出 `IpcRegistry`；新增 `headerHeight` config（下发 main + renderer）、删 `setHeaderHeight`；修 `UpdateManager` 漏传 `senderPolicy`。
2. **instance contribution 面**：`WorkbenchHostInstance` / `WorkbenchAppInstance` 加 `registerSimulatorApi` / `toolbar` / `ipc` / `registerTrustedWindow`，全部 per-context、自动进 `ctx.registry`。纯新增。
3. **simulator-api per-context**：删进程全局 `registerSimulatorApi` 与 `simulatorApiRegistry` 单例。
4. **toolbar 合一**：`instance.toolbar.set()` 上线；删 `toolbarActions` config 字段与裸 `toolbar:action:*` 路径。
5. **裸 IPC 收口**：自定义 IPC 改走 `instance.ipc`；README 删裸 `ipcMain.handle` 示例。
6. **收尾**：撤模块组装公共导出；删 `extraModules` JSDoc；类型收敛（`WorkbenchConfig` / `WorkbenchAppConfig` / `CreateContextOptions`）；`menuBuilder` 签名收窄；preload 加 `installCustomApisBridge` 漏装 warn。

## 6. 取舍

- **为什么不强行并成一种范式**：「一对一 provider」与「一对多 contribution」基数不同，强行同签名会损害易用性。统一的是**规则**（容器、网关、生命周期），不是签名。
- **为什么 clean break**：唯一下游 qdmp 与 devtools 同团队、可协调。`@deprecated` 没有强制删除机制，只会在一份「消灭扩展面卫生债」的重构里又新造卫生债。
- **为什么 toolbar 用整表 `set` 而非逐个 `registerToolbarAction`**：工具栏内容随 host 状态（登录态等）变化，本质是「算出来的一张表」。整表替换是这种语义的自然形态；逐个 register + 额外的 change 事件，是把一件事拆成两件。
- **不在本文范围**：模块组装路线（devtools 内部组织内置模块用）保留，仅撤对外导出；custom panel —— qdmp 不用（它用独立 `BrowserWindow` 弹窗），本期不做。

## 7. 与 miniappSnapshot 的关系

| | miniappSnapshot | 本文（扩展模型） |
|---|---|---|
| 统一对象 | 面板**数据**同步 | host 对 devtools 的**扩展** |
| 收敛到 | 一个 Host + 全量快照投影 | 一个 Context 容器 + 两类扩展 + 三规则 |
| 核心句 | preload 是唯一真相源 | `WorkbenchContext` 是唯一扩展容器 |

## 附录：迁移后，host 集成代码长什么样

```ts
import { createWorkbenchApp } from '@dimina-kit/devtools/app'

createWorkbenchApp({
  // ── 配置 Provider（构造期，一对一）──
  appName: 'My DevTools',
  adapter: myAdapter,
  headerHeight: 72,
  brandingProvider: () => ({ appName: 'My DevTools' }),
  menuBuilder: (mainWindow, menuCtx) => buildMenu(mainWindow, menuCtx),

  // ── Contribution（onSetup 期，一对多）──
  onSetup(instance) {
    // simulator 自定义 API：per-context，随 context 销毁
    instance.registerSimulatorApi('login', (params) => myLogin(params))

    // 工具栏：整表，随登录态重算
    const refreshToolbar = () => instance.toolbar.set(buildActions())
    refreshToolbar()

    // 自定义 IPC：经 gated 的 IpcRegistry，不再裸 ipcMain.handle
    instance.ipc.handle('my:stats', () => collectStats())

    // host 自己的弹窗：注册为受信 sender 后才能调 instance.ipc
    const win = createDialogWindow(/* ... */)
    instance.registerTrustedWindow(win)

    // 以上每一项都已自动进 ctx.registry，host 无需手写任何 cleanup
  },
})
```
