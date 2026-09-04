# 页面栈（Page Stack）

> 页面栈承载 simulator 当前的导航语义。唯一实现是 native-host 的 `packages/dimina-electron-runtime/src/simulator-ui/page-stack-controller.ts`（纯 reducer）；生命周期、自动化读取和降级行为统一记录在本页。
>
> tab-bar 的视觉 / 配置细节由 [`./tab-bar.md`](./tab-bar.md) 承载；本文聚焦 `navigateTo` / `navigateBack` / `redirectTo` / `reLaunch` 这 4 个 API 与多 tab 子栈的交互。

## 0. 一图速览

```
   ┌──────────────────────────────────────────────────────────┐
   │                native-host 页面栈                    │
   ├──────────────────────────────────────────────────────────┤
   │   ShellState.stack[]            ← 单条可见栈（顶端是当前页）       │
   │                                                          │
   │   tabStacks: Record<path, PageEntry[]>                   │
   │                                 ← 每 tab 一条完整子栈           │
   │                                                          │
   │   switchTab → snapshot 旧 tab 子栈 + 还原 / 懒建目标 tab 子栈     │
   └──────────────────────────────────────────────────────────┘
```

## 1. 当前路由行为

### 1.1 5 个路由 API（含 switchTab 概述）

| API            | 当前页面栈语义                                                   |
|----------------|------------------------------------------------------------------|
| `navigateTo`   | 在当前页之上 push 一个新页，保留当前页                             |
| `navigateBack` | 从栈顶弹出 `delta` 个页；reducer 会把范围限制在 1 到栈底之间       |
| `redirectTo`   | 用新页替换栈顶，销毁旧栈顶                                         |
| `reLaunch`     | 销毁全部存活页，以新页作为新的根                                   |
| `switchTab`    | 快照当前 tab 子栈，并恢复或创建目标 tab 子栈                       |

> `switchTab` 在 tab-bar 文档中详述（tab bar 渲染、badge、reddot、动态 API），本文只关心它对页面栈的副作用。

## 2. native-host 实现

### 2.1 reducer

文件：`packages/dimina-electron-runtime/src/simulator-ui/page-stack-controller.ts`。这是一个**纯 reducer**：所有路由变换都接收 `ShellState` 返回 `{ next, effects }`，没有副作用，方便单测。

```ts
export interface ShellState {
  stack: PageEntry[]                       // 当前可见栈（顶端是当前页）
  tabStacks: Record<string, PageEntry[]>   // 每 tab 一条完整子栈
  currentTabPath: string | null            // 当前激活 tab；非 tab 则 null
}
```

五个 reducer 全部 export，覆盖：

| Reducer                | 说明                                                |
|------------------------|----------------------------------------------------|
| `reduceNavigateTo`     | push 新页，同时镜像到 `tabStacks[currentTabPath]`     |
| `reduceNavigateBack`   | clamp `delta` 到 `stack.length - 1`，发 `pageUnload + closePage` |
| `reduceRedirectTo`     | 替换栈顶，旧顶发 `pageUnload + closePage`             |
| `reduceReLaunch`       | 全员 `pageUnload + closePage`，重置 `tabStacks`        |
| `reduceSwitchTab`      | snapshot 当前 stack → 还原 / 懒建目标 tab；子栈里的页面一律不销毁，迁移后不属于任何子栈的页面发 `pageUnload + closePage` |

副作用通过 `SideEffect` 联合表达，host 层负责执行：

```ts
type SideEffect =
  | { kind: 'lifecycle'; bridgeId: string; event: 'pageShow' | 'pageHide' | 'pageUnload' }
  | { kind: 'closePage'; bridgeId: string }
```

## 3. 生命周期触发详表

### 3.1 一页表（native-host reducer）

下表「事件」列只列页面栈相关生命周期 effect（reducer 产出的 `pageShow` / `pageHide` / `pageUnload`，配套 `closePage`）；时机均为 reducer 同步产出。

| 路由动作         | 当前页 (top before)   | 目标页 (top after)                  | 被弹 / 被替换页                  | 旧 tab 页（仅 switchTab）          |
|------------------|-----------------------|-------------------------------------|---------------------------------|-----------------------------------|
| `navigateTo`     | `pageHide`            | `pageShow`（新页）                   | —                               | —                                 |
| `navigateBack(1)`| —                     | `pageShow`                          | `pageUnload` + `closePage`      | —                                 |
| `navigateBack(δ>1)`| —                   | `pageShow`                          | 每个被弹页一次 `pageUnload` + `closePage` | —                       |
| `redirectTo`     | —                     | `pageShow`（新页）                   | 旧 top：`pageUnload` + `closePage` | —                              |
| `reLaunch`       | —                     | `pageShow`（新页）                   | 当前可见栈 + 全部 tab 子栈全员 `pageUnload` + `closePage` | 同左            |
| `switchTab` (restore) | `pageHide`       | `pageShow`（还原子栈栈顶）           | 迁移后不属于任何子栈的页面：`pageUnload` + `closePage` | 子栈整段快照保留，其中的页面不销毁 |
| `switchTab` (lazy)| `pageHide`           | `pageShow`（新页）                   | 迁移后不属于任何子栈的页面：`pageUnload` + `closePage` | 子栈整段快照保留，其中的页面不销毁 |

### 3.2 容易踩坑的点

- **`navigateBack(delta)` 越界**：`reduceNavigateBack` 显式 clamp：`Math.min(Math.max(1, Number.isFinite(delta) ? delta : 1), stack.length - 1)`（`page-stack-controller.ts:177-180`）。`delta` 超过深度直接弹到栈底，非有限数（`NaN` / `±Infinity`）按 1 处理，都不抛错。栈深已是 1 时另有一条前置拒绝（`no page to back`，:174）。
- **`reLaunch` 对栈底 entry 也发 `pageUnload`**：是——`reduceReLaunch` 把当前可见栈 + 全部 tab 子栈全员 unload + closePage。
- **`switchTab` 对子栈页只切显隐、不发 closePage**：离开的 tab 子栈整段快照进 `tabStacks`，页面 `<webview>` 不卸载；切回时整段还原。但**不属于任何子栈的页面例外**：没有活动 tab 时的可见页（深链启动到非 tab 页，或 `redirectTo` 把某 tab 根页换成非 tab 页之后的那一页）在切 tab 后既不在可见栈也不在任何子栈里，必须 `pageUnload + closePage`，否则它的 render host 会留在 main 的页面账本里。
- **同名 bridgeId 在 reLaunch 中的防御**：`reduceReLaunch` 显式从 unload 集合里删去 `newEntry.bridgeId`（`page-stack-controller.ts`），防止"新页面和旧页面 ID 撞车导致新页被错卸"。

## 4. 自动化读取

native-host 不把完整页面栈写入窗口 URL：页面栈是 DeviceShell 的内部状态。自动化的当前页读 active render guest 的 `location.search`，完整栈优先读 DeviceShell 经 bridge 上报的 `PAGE_STACK`。

### App.getCurrentPage / App.getPageStack

实现：`packages/devtools/src/main/services/automation/handlers/app.ts`。native-host 下
`App.getCurrentPage` 读 render guest；`App.getPageStack` 优先读 bridge 保存的完整栈，
仅在完整栈尚未上报时回退到 guest：

```ts
appHandlers['App.getCurrentPage'] = async (ctx) => {
  // 读 active render guest 的 location.search，
  // render-host preload 把 pagePath（+ per-page query）编码在那里。
  const page = await readNativeActivePage(ctx)
  return { pageId: 1, path: page?.pagePath ?? '', query: page?.query ?? {} }
}
```

- `readNativeActivePage` 拿 `getActivePageWc(ctx)`，读该 render guest 自己的 `location.search`，从 `pagePath` 参数里 `decodePageSpec` 解出 `{ pagePath, query }`，固定返回 `pageId: 1`。automator 是远程协议、需要 OOP-safe 的"事实"信道，所以读 guest URL 而不是直接读 reducer 的 `ShellState`。

`App.getPageStack` 优先用 `ctx.bridge.getPageStack?.()`——DeviceShell 经 `PAGE_STACK` 上报的完整有序栈（bottom→top）；首个信号前（或不带该 accessor 的 mock 里）降级返回**单条目栈**，即当前可见页。

`App.callWxMethod` 的导航不是 DOM 点击，而是把真正的 `wx.<method>` 跑在隐藏的 service 窗口里（`serviceWc.executeJavaScript('wx.<method>(...)')`），让导航走与运行中小程序相同的路径，再由 DeviceShell 驱动页面栈。

## 5. native-host 的 per-tab 子栈

### 5.1 当前语义

每个 tab 是一根独立的导航栈，`switchTab` 不抹平另一个 tab 内的 `navigateTo` 堆积。Native Bridge 协议与窗口拓扑见 [`./native-bridge-protocol.md`](./native-bridge-protocol.md)。

### 5.2 数据结构与几何关系

```ts
ShellState = {
  stack:           PageEntry[],                     // 当前 active 子栈（可见）
  tabStacks:       Record<pagePath, PageEntry[]>,   // 全部 tab 的快照子栈
  currentTabPath:  string | null,
}
```

不变量（由 reducer 共同维护）：

1. 若 `currentTabPath ≠ null`，则 `tabStacks[currentTabPath]` **始终等于** `stack`——也就是 active tab 的子栈和可见栈是同一份引用快照（`page-stack-controller.ts`、`page-stack-controller.ts`）。
2. 非 active tab 的子栈被 `switchTab` 离开时定格（`snapshotCurrentTabStack`，`page-stack-controller.ts`）。
3. `reLaunch` 后 `tabStacks` 重建——只剩新 entry 一项（若它是 tab）（`page-stack-controller.ts`）。

### 5.3 enumerateMounted

把"DOM 中必须保留 mount 的页面"穷举出来：

```ts
enumerateMounted(state) = uniqueByBridgeId(
  state.stack ∪ Object.values(state.tabStacks).flat()
)
// 只有 state.stack 的栈顶 visible:true，其余 visible:false
```

实现 `page-stack-controller.ts`。Renderer 据此决定每页 `<webview>` 的显隐。

### 5.4 switchTab 流程图

```
switchTab(targetTab):
    ┌─────────────────────────────────────────────────────────┐
    │ 1. snapshotCurrentTabStack(state):                       │
    │      tabStacks[prevTabPath] = [...stack]                 │
    │      ↑ 即使 prev tab 上面叠了 navigateTo 页，也整条快照下来    │
    ├─────────────────────────────────────────────────────────┤
    │ 2. cached = tabStacks[targetTab]                         │
    │    if cached?.length > 0: nextStack = cached  (restore)  │
    │    elif freshlyOpenedEntry:  nextStack = [fresh] (lazy)  │
    │    else: throw                                            │
    ├─────────────────────────────────────────────────────────┤
    │ 3. effects:                                               │
    │      prevTop ≠ newTop  → pageHide(prevTop)                │
    │      cached restore / lazy create → pageShow(newTop)      │
    │      ❗ 子栈里的页面永不 closePage；不属于任何子栈的页面才销毁 │
    └─────────────────────────────────────────────────────────┘
```

实现：`page-stack-controller.ts`。

## 6. 错误与降级

### 6.1 拒绝条件（native-host reducer）

| API           | 拒绝条件                                         | 拒绝表现                                         |
|---------------|--------------------------------------------------|-------------------------------------------------|
| `navigateTo`  | 目标是 tabBar 页                                 | `fail({ errMsg: 'navigateTo:fail can not navigateTo a tabbar page' })` |
| `redirectTo`  | 目标是 tabBar 页                                 | `fail({ errMsg: 'redirectTo:fail can not redirectTo a tabbar page' })` |
| `switchTab`   | 目标不是 tabBar 页                              | `fail({ errMsg: 'switchTab:fail not a tabBar page: <path>' })` |
| `navigateBack`| 栈深度 < 2                                       | `reduceNavigateBack` 返回 `{ error }`，host adapter 译成 `errMsg` |
| 任何 reducer  | 目标 path 非法 / 不在 modules                    | `fail({ errMsg: '<api>:fail <msg>' })`     |

### 6.2 共性约定

- 所有拒绝走 `fail` 回调 + `complete` 回调，**不抛异常**到调用方。
- `errMsg` 格式为 `${api}:fail <reason>`。
- native-host 的 `reduceNavigateBack` 拒绝返回 `{ error: string }` 而非抛错（`page-stack-controller.ts`）；host adapter 翻译成 `errMsg`。

## 7. 测试入口

- 单测：`packages/dimina-electron-runtime/src/simulator-ui/page-stack-controller.test.ts`，46 个 case 覆盖 reducer 与相关纯函数行为（含 lifecycle effects 顺序、tabStacks 同步、reLaunch 全清等）。
- e2e：`packages/dimina-electron-runtime/e2e/native-host-page-stack.spec.ts`（5 API + 生命周期 + 深度限制）、`packages/devtools/e2e/native-host-current-page.spec.ts`（`App.getCurrentPage` / `getPageStack` 上报）。

## 8. 延伸阅读

- `packages/devtools/docs/native-bridge-protocol.md` —— Native Bridge 协议 / native-host 窗口拓扑。
- `packages/devtools/docs/workbench-model.md` —— Workspace / Project 与 simulator 的上下层关系。
- [`./tab-bar.md`](./tab-bar.md) —— tab 渲染、badge / reddot、动态 API。
- [`./electron-container.md`](./electron-container.md) —— host process 与 renderer 的进程边界、`<webview>` 载体。
