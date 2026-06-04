# 页面栈（Page Stack）

> 页面栈承载小程序的导航语义。devtools simulator 只有一套实现——native-host 的 `src/simulator/device-shell/page-stack-controller.ts`（纯 reducer），规范、生命周期、URL 同步、降级行为统一收敛在本页。upstream dimina-fe 的 `MiniApp`（`miniApp.js`）是 WeChat 语义的参考实现，本文在对照"规范期望 vs native-host 行为"时引用它，但它不是 devtools 的运行时。
>
> tab-bar 的视觉 / 配置细节由 [`./tab-bar.md`](./tab-bar.md) 承载；本文聚焦 `navigateTo` / `navigateBack` / `redirectTo` / `reLaunch` 这 4 个 API 与多 tab 子栈的交互。

## 0. 一图速览

```
   ┌──────────────────────────────────────────────────────────┐
   │        native-host 页面栈（iOS / Harmony 每-tab 子栈语义）      │
   ├──────────────────────────────────────────────────────────┤
   │   ShellState.stack[]            ← 单条可见栈（顶端是当前页）       │
   │                                                          │
   │   tabStacks: Record<path, PageEntry[]>                   │
   │                                 ← 每 tab 一条完整子栈           │
   │                                                          │
   │   switchTab → snapshot 旧 tab 子栈 + 还原 / 懒建目标 tab 子栈     │
   └──────────────────────────────────────────────────────────┘

   参考：upstream dimina-fe MiniApp（WeChat 语义，单条 bridgeList +
   tabBarBridges 缓存，switchTab 弹掉非 tab 页）——对照见 §2.2，详见 §3。
```

## 1. WeChat 规范回顾

### 1.1 5 个路由 API（含 switchTab 概述）

| API            | 语义                                                                  | 失败条件                                          |
|----------------|-----------------------------------------------------------------------|---------------------------------------------------|
| `navigateTo`   | 在当前页之上 push 一个新页（保留当前页）                                  | 目标是 tabBar 页 / 栈深达上限                       |
| `navigateBack` | 从栈顶弹出 `delta` 个页（默认 1）                                       | 当前栈深 < 2 时不动                                |
| `redirectTo`   | 用新页替换栈顶（销毁当前页，不入栈一层）                                   | 目标是 tabBar 页                                  |
| `reLaunch`     | 销毁全部存活页，以新页作为新的根                                          | （仅参数错误）                                   |
| `switchTab`    | 切换到指定 tabBar 页；同时按规范丢弃所有非 tab 页（详见 tab-bar 文档）       | 目标不是 tabBar 页                              |

> `switchTab` 在 tab-bar 文档中详述（tab bar 渲染、badge、reddot、动态 API），本文只关心它对页面栈的副作用。

### 1.2 Page 生命周期

WeChat 定义的 5 个回调：

| 回调            | 触发时机                                                            |
|-----------------|-----------------------------------------------------------------|
| `onLoad(options)` | 页面首次实例化（拿到 query 参数）                                  |
| `onShow()`        | 页面被显示到屏幕上（首次进入 / 后退回来 / switchTab 命中 / reLaunch 等）  |
| `onReady()`       | 页面首次渲染完成，DOM 可用                                          |
| `onHide()`        | 页面被切走但实例仍存活（被 `navigateTo` 覆盖 / `switchTab` 离开）        |
| `onUnload()`      | 页面实例被销毁（被 `navigateBack` 弹出 / `redirectTo` 替换 / `reLaunch` 清栈）|

### 1.3 路由 API × 生命周期 矩阵

下表只看「页面栈」域的生命周期；`onLoad` / `onReady` 仅在新建 bridge 时触发一次。

| 路由动作          | 当前页 (top before)        | 目标页 (top after)            | 被弹页 / 被替换页                | tab 池 / 其他子栈             |
|------------------|---------------------------|------------------------------|---------------------------------|------------------------------|
| `navigateTo`     | `onHide`                  | `onLoad` → `onReady` → `onShow` | —                              | 不动                         |
| `navigateBack(δ)`| —                         | `onShow`                       | 每个被弹页：`onUnload`           | 不动                         |
| `redirectTo`     | —                         | `onLoad` → `onReady` → `onShow` | 旧栈顶：`onUnload`               | 旧栈顶若是 tab 页，从池中移除  |
| `reLaunch`       | —                         | `onLoad` → `onReady` → `onShow` | 当前可见栈所有页：`onUnload`      | 全部 tab 池子页：`onUnload`   |
| `switchTab`      | `onHide`                  | `onShow`（cache 命中）/ `onLoad` 全套（首次） | 沿途非 tab 页：`onUnload`        | 旧 tab 进入 `hidden`（不卸载）|

栈深限制：WeChat 规范为 10。`getCurrentPages()` 数组下标 0 是栈底（entry），`length - 1` 是栈顶。

### 1.4 native-host 跟随哪套语义

| 维度                          | upstream dimina-fe（WeChat 参考）  | native-host（devtools 运行时） |
|-------------------------------|-----------------------------------|--------------------------------|
| 跟随平台                       | WeChat（无每-tab 子栈）            | iOS / Harmony（每-tab 子栈）     |
| switchTab 后是否保留旧 tab 上的 navigateTo 页 | 否（被弹掉）            | 是（保留在 `tabStacks[prevTab]`）|
| 实现入口                      | `dimina/fe/.../miniApp.js`        | `page-stack-controller.ts`       |

## 2. native-host 实现

### 2.1 reducer

文件：`packages/devtools/src/simulator/device-shell/page-stack-controller.ts`。这是一个**纯 reducer**：所有路由变换都接收 `ShellState` 返回 `{ next, effects }`，没有副作用，方便单测。

```ts
export interface ShellState {
  stack: PageEntry[]                       // 当前可见栈（顶端是当前页）
  tabStacks: Record<string, PageEntry[]>   // 每 tab 一条完整子栈
  currentTabPath: string | null            // 当前激活 tab；非 tab 则 null
}
```

五个 reducer 全部 export，覆盖：

| Reducer                | 行号                                | 说明                                                |
|------------------------|-------------------------------------|----------------------------------------------------|
| `reduceNavigateTo`     | `page-stack-controller.ts:97-118`   | push 新页，同时镜像到 `tabStacks[currentTabPath]`     |
| `reduceNavigateBack`   | `page-stack-controller.ts:120-154`  | clamp `delta` 到 `stack.length - 1`，发 `pageUnload + closePage` |
| `reduceRedirectTo`     | `page-stack-controller.ts:156-175`  | 替换栈顶，旧顶发 `pageUnload + closePage`             |
| `reduceReLaunch`       | `page-stack-controller.ts:177-208`  | 全员 `pageUnload + closePage`，重置 `tabStacks`        |
| `reduceSwitchTab`      | `page-stack-controller.ts:220-264`  | snapshot 当前 stack → 还原 / 懒建目标 tab，**不发 closePage** |

副作用通过 `SideEffect` 联合表达，host 层负责执行：

```ts
type SideEffect =
  | { kind: 'lifecycle'; bridgeId: string; event: 'pageShow' | 'pageHide' | 'pageUnload' }
  | { kind: 'closePage'; bridgeId: string }
```

### 2.2 与 WeChat 参考实现的对照

| 维度                          | upstream dimina-fe（WeChat 参考）            | native-host（devtools 运行时）                     |
|-------------------------------|----------------------------------------------|---------------------------------------------------|
| 每页页面载体                  | 1 `<iframe>` / page                          | 1 `<webview partition="persist:simulator">` / page（`device-shell.tsx:254-267`） |
| Tab 子栈语义                  | 无（switchTab 弹掉非 tab 页）                | 有（switchTab snapshot + restore）                |
| URL 同步                      | `HashRouter.syncStack` 写 `location.search`  | 无 URL 同步（host 内部状态）                       |
| 路由回调路径                  | `success` / `fail` / `complete` 透传到 jscore | host 派发 `SideEffect`，由 IPC adapter 回 ack       |
| 单测覆盖                       | 间接通过 e2e                                  | 43 case 单测（纯函数）                             |

## 3. WeChat 参考语义：bridgeList 与 bridge 缓存（upstream dimina-fe）

> 本节描述 upstream dimina-fe `MiniApp` 的 WeChat 语义，作为与 native-host per-tab 子栈对照的参考——它不是 devtools 的运行时。

### 3.1 数据结构

- `bridgeList: Bridge[]`：当前可见的页面栈。`bridgeList[0]` 是栈底（root），`bridgeList[length - 1]` 是栈顶（当前可见页）。
- `tabBarBridges: Map<pagePath, Bridge>`：tab 页持久池。一旦某个 tab 页首次显示，它的 bridge / iframe 就放进这个 Map，下次 `switchTab` 命中直接复用（`miniApp.js:839`），不重建 iframe。
- `currentTabPath: string | null`：当前激活的 tab 路径；非 tab 页时为 null（`miniApp.js:48`、`miniApp.js:687-696`、`miniApp.js:877`）。

### 3.2 一个典型流程的栈变化

```
启动（entry = home，home 是 tab 页）

    bridgeList:        [home]
    tabBarBridges:     { home -> Bridge_home }
    currentTabPath:    'pages/home/home'


navigateTo /pages/detail/detail（detail 不是 tab 页）

    bridgeList:        [home, detail]                ← detail push 上去
    tabBarBridges:     { home -> Bridge_home }        ← 不变
    currentTabPath:    'pages/home/home'              ← 不变（switchTab 才更新）


switchTab /pages/cart/cart（cart 是 tab 页，未在池中）

    1) 把 detail 从栈顶 pop 并 destroy（非 tab，丢弃）  [miniApp.js:810-819]
    2) 把旧 tab home 的 iframe 设 display:none（保留在池）[miniApp.js:822-836]
    3) 懒建 cart bridge 并放入池                       [miniApp.js:844-858]

    bridgeList:        [cart]
    tabBarBridges:     { home -> Bridge_home, cart -> Bridge_cart }
    currentTabPath:    'pages/cart/cart'


switchTab /pages/home/home（命中池）

    1) bridgeList 中无非 tab 页可弹
    2) cart iframe 设 display:none
    3) 复用 Bridge_home，targetEl.style.display = ''   [miniApp.js:870]
    4) Bridge_home.pageShow()

    bridgeList:        [home]                          ← detail 没有"复活"——
    tabBarBridges:     { home, cart }                   这是 WeChat semantics 关键点
    currentTabPath:    'pages/home/home'
```

> ⚠️ 注意：在 WeChat semantics 下 `detail` 永远找不回来；native-host semantics 下因为 `tabStacks['pages/home/home']` 在 `switchTab` 离开 home 时被快照保存（`page-stack-controller.ts:90-93`），切回 home 会还原 `[home, detail]`。

### 3.3 reLaunch 为什么要合并 Set？

`miniApp.js:578` 用 `new Set([...bridgeList, ...tabBarBridges.values()])` 去重。原因：当前 tab 页同时存在于 `bridgeList[0]` 和 `tabBarBridges[currentTabPath]`，是同一个 Bridge 引用；不去重会被 `destroy()` 两次。

## 4. 生命周期触发详表

### 4.1 一页表（native-host reducer）

下表「事件」列只列页面栈相关生命周期 effect（reducer 产出的 `pageShow` / `pageHide` / `pageUnload`，配套 `closePage`）；时机均为 reducer 同步产出。

| 路由动作         | 当前页 (top before)   | 目标页 (top after)                  | 被弹 / 被替换页                  | 旧 tab 页（仅 switchTab）          |
|------------------|-----------------------|-------------------------------------|---------------------------------|-----------------------------------|
| `navigateTo`     | `pageHide`            | 新页 mount → `pageShow`              | —                               | —                                 |
| `navigateBack(1)`| —                     | `pageShow`                          | `pageUnload` + `closePage`      | —                                 |
| `navigateBack(δ>1)`| —                   | `pageShow`                          | 每个被弹页一次 `pageUnload` + `closePage` | —                       |
| `redirectTo`     | —                     | 新页 mount → `pageShow`              | 旧 top：`pageUnload` + `closePage` | —                              |
| `reLaunch`       | —                     | 新页 mount → `pageShow`              | 当前可见栈 + 全部 tab 子栈全员 `pageUnload` + `closePage` | 同左            |
| `switchTab` (restore) | `pageHide`       | `pageShow`（还原子栈栈顶）           | —（沿途页都活在子栈里）          | 子栈整段快照保留，**不发 closePage** |
| `switchTab` (lazy)| `pageHide`           | 新页 mount → `pageShow`              | —                               | 子栈整段快照保留，**不发 closePage** |

### 4.2 容易踩坑的点

- **`navigateBack(delta)` 越界**：`reduceNavigateBack` 显式 clamp：`Math.min(Math.max(1, delta), stack.length - 1)`（`page-stack-controller.ts:127-130`）。`delta` 超过深度直接弹到栈底，不抛错。
- **`reLaunch` 对栈底 entry 也发 `pageUnload`**：是——`reduceReLaunch` 把当前可见栈 + 全部 tab 子栈全员 unload + closePage。
- **`switchTab` 对子栈页只切显隐、不发 closePage**：离开的 tab 子栈整段快照进 `tabStacks`，页面 `<webview>` 不卸载；切回时整段还原。
- **同名 bridgeId 在 reLaunch 中的防御**：`reduceReLaunch` 显式从 unload 集合里删去 `newEntry.bridgeId`（`page-stack-controller.ts:190`），防止"新页面和旧页面 ID 撞车导致新页被错卸"。

## 5. URL 同步与自动化读取

> native-host 不做 URL 同步——页面栈是 DeviceShell 的内部状态。§5.1 描述的 HashRouter URL 编码是 upstream dimina-fe 的机制，仅作参考；自动化在 native-host 下改读 render guest 自身的 `location.search`（§5.2）。

### 5.1 upstream 参考：HashRouter.syncStack

实现：`dimina/fe/packages/container/src/utils/hashRouter.js:90-93`

```js
static syncStack(appId, stack) {
  const search = this.buildRouteSearch(appId, stack)
  history.replaceState(null, '', `${window.location.pathname}${search ? `?${search}` : ''}`)
}
```

`buildRouteSearch`（`hashRouter.js:63-78`）只编两条信息：

- `entry = stack[0]`（入口页）
- `page  = stack[stack.length - 1]`（当前栈顶）

栈中间的页不写进 URL——刷新后会回到 entry + current 两层，**中间页丢失是规范行为**。

### 5.2 读：App.getCurrentPage / App.getPageStack

实现：`packages/devtools/src/main/services/automation/handlers/app.ts`。native-host 下两个 handler 都读 render guest 自身的状态：

```ts
appHandlers['App.getCurrentPage'] = async (ctx) => {
  // 读 active render guest 的 location.search，
  // render-host preload 把 pagePath（+ per-page query）编码在那里。
  const page = await readNativeActivePage(ctx)
  return { pageId: 1, path: page?.pagePath ?? '', query: page?.query ?? {} }
}
```

- `readNativeActivePage`（`app.ts:27-39`）拿 `getActivePageWc(ctx)`，读该 render guest 自己的 `location.search`，从 `pagePath` 参数里 `decodePageSpec` 解出 `{ pagePath, query }`，固定返回 `pageId: 1`。automator 是远程协议、需要 OOP-safe 的"事实"信道，所以读 guest URL 而不是直接读 reducer 的 `ShellState`。

`App.getPageStack`（`app.ts:55-88`）优先用 `ctx.bridge.getPageStack?.()`——DeviceShell 经 `PAGE_STACK` 上报的完整有序栈（bottom→top）；首个信号前（或不带该 accessor 的 mock 里）降级返回**单条目栈**，即当前可见页。

`App.callWxMethod`（`app.ts:90-128`）的导航不是 DOM 点击，而是把真正的 `wx.<method>` 跑在隐藏的 service 窗口里（`serviceWc.executeJavaScript('wx.<method>(...)')`，`app.ts:103-110`），让导航走与运行中小程序相同的路径，再由 DeviceShell 驱动页面栈。

## 6. native-host 的 per-tab 子栈

### 6.1 设计来源

参考 iOS `DMPNavigator` + `DMPTabBarContainerView` 的"按需创建 + 持久缓存"模型——每个 tab 是一根独立的导航栈，`switchTab` 不抹平另一个 tab 内的 `navigateTo` 堆积。这与 WeChat 默认行为相反，但对 native 容器（iOS / Harmony）才是用户体感期待。native-host 的 Native Bridge 协议与窗口拓扑见 [`./simulator-refactor.md`](./simulator-refactor.md)。

### 6.2 数据结构与几何关系

```ts
ShellState = {
  stack:           PageEntry[],                     // 当前 active 子栈（可见）
  tabStacks:       Record<pagePath, PageEntry[]>,   // 全部 tab 的快照子栈
  currentTabPath:  string | null,
}
```

不变量（由 reducer 共同维护）：

1. 若 `currentTabPath ≠ null`，则 `tabStacks[currentTabPath]` **始终等于** `stack`——也就是 active tab 的子栈和可见栈是同一份引用快照（`page-stack-controller.ts:108-110`、`page-stack-controller.ts:140-142`）。
2. 非 active tab 的子栈被 `switchTab` 离开时定格（`snapshotCurrentTabStack`，`page-stack-controller.ts:90-93`）。
3. `reLaunch` 后 `tabStacks` 重建——只剩新 entry 一项（若它是 tab）（`page-stack-controller.ts:192-194`）。

### 6.3 enumerateMounted

把"DOM 中必须保留 mount 的页面"穷举出来：

```ts
enumerateMounted(state) = uniqueByBridgeId(
  state.stack ∪ Object.values(state.tabStacks).flat()
)
// 只有 state.stack 的栈顶 visible:true，其余 visible:false
```

实现 `page-stack-controller.ts:281-295`。Renderer 据此决定每页 `<webview>` 的显隐。

### 6.4 switchTab 流程图

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
    │      cached restore     → pageShow(newTop)                 │
    │      lazy create       → 由 renderer init path 自己触发    │
    │      ❗ 永不发 closePage：所有子栈都活着                      │
    └─────────────────────────────────────────────────────────┘
```

实现：`page-stack-controller.ts:220-264`。

### 6.5 与 WeChat 参考语义的差异（再强调）

| 场景：home → navTo detail → switchTab cart → switchTab home |
|---|
| **WeChat / upstream dimina-fe**：detail 在第一次 switchTab 时被 destroy；切回 home 仅看到 home。|
| **native-host**：detail 进入 `tabStacks['pages/home/home']` 快照；切回 home 还原 `[home, detail]`，detail 重新可见。|

## 7. 错误与降级

### 7.1 拒绝条件（native-host reducer）

| API           | 拒绝条件                                         | 拒绝表现                                         |
|---------------|--------------------------------------------------|-------------------------------------------------|
| `navigateTo`  | 目标是 tabBar 页                                 | `fail({ errMsg: 'navigateTo:fail can not navigateTo a tabbar page' })` |
| `redirectTo`  | 目标是 tabBar 页                                 | `fail({ errMsg: 'redirectTo:fail can not redirectTo a tabbar page' })` |
| `switchTab`   | 目标不是 tabBar 页                              | `fail({ errMsg: 'switchTab:fail not a tabBar page: <path>' })` |
| `navigateBack`| 栈深度 < 2                                       | `reduceNavigateBack` 返回 `{ error }`，host adapter 译成 `errMsg` |
| 任何 reducer  | 目标 path 非法 / 不在 modules                    | `fail({ errMsg: '<api>:fail <msg>' })`     |

> errMsg 字符串与 WeChat 规范、与 upstream dimina-fe（`miniApp.js`）保持一致，便于自动化断言用正则匹配。

### 7.2 共性约定

- 所有拒绝走 `fail` 回调 + `complete` 回调，**不抛异常**到调用方。
- `errMsg` 格式严格遵循 `${api}:fail <reason>`，与 WeChat 一致。
- native-host 的 `reduceNavigateBack` 拒绝返回 `{ error: string }` 而非抛错（`page-stack-controller.ts:124-126`）；host adapter 翻译成 `errMsg`。

## 8. 测试入口

- 单测：`packages/devtools/src/simulator/device-shell/page-stack-controller.test.ts`，43 个 case 覆盖五个 reducer 的纯函数行为（含 lifecycle effects 顺序、tabStacks 同步、reLaunch 全清等）。
- e2e：`packages/devtools/e2e/native-host-page-stack.spec.ts`（5 API + 生命周期 + 深度限制）、`native-host-current-page.spec.ts`（`App.getCurrentPage` / `getPageStack` 上报）。

## 9. 延伸阅读

- `packages/devtools/docs/simulator-refactor.md` —— Native Bridge 协议 / native-host 窗口拓扑。
- `packages/devtools/docs/workbench-model.md` —— Workspace / Project 与 simulator 的上下层关系。
- [`./tab-bar.md`](./tab-bar.md) —— tab 渲染、badge / reddot、动态 API。
- [`./electron-container.md`](./electron-container.md) —— host process 与 renderer 的进程边界、`<webview>` 载体。
