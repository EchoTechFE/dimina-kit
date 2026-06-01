# Page Stack 设计文档

> 适用模块：dimina-fe `MiniApp`（默认模拟器）与 `src/simulator/device-shell/page-stack-controller.ts`（native-host 模式）。
>
> 本文目标：把"页面栈"这一跨容器、跨架构的概念，用一份文档把规范、两套实现、生命周期、URL 同步、降级行为都讲透。
> 与 tab-bar 相关的视觉 / 配置细节单独由 [`./tab-bar.md`](./tab-bar.md) 承载，本文聚焦 `navigateTo` / `navigateBack` / `redirectTo` / `reLaunch` 这 4 个 API 与多 tab 子栈的交互。

---

## 0. 一图速览

```
   ┌──────────────────────────────────────────────────────────┐
   │             dimina-kit 同一份页面栈语义的两种载体              │
   ├──────────────────────────┬───────────────────────────────┤
   │   dimina-fe / MiniApp     │   native-host / Shell         │
   │   (WeChat semantics)      │   (iOS / Harmony semantics)   │
   ├──────────────────────────┼───────────────────────────────┤
   │   this.bridgeList[]       │   ShellState.stack[]          │
   │       (单条可见栈)         │       (单条可见栈)              │
   │                          │                               │
   │   tabBarBridges:          │   tabStacks:                  │
   │     Map<path, Bridge>    │     Record<path, PageEntry[]> │
   │       (tab 池：tab 页缓存) │       (tab 子栈：每 tab 一条完整栈) │
   │                          │                               │
   │   switchTab → 弹掉非 tab    │   switchTab → snapshot 旧栈 +  │
   │   页，复用 tab 页 iframe    │   还原 / 懒建目标 tab 子栈        │
   └──────────────────────────┴───────────────────────────────┘
```

---

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

### 1.4 默认 / native-host 两种语义谁服从谁

| 维度                          | dimina-fe（默认）        | native-host（DIMINA_NATIVE_HOST=1） |
|-------------------------------|--------------------------|-------------------------------------|
| 跟随平台                       | WeChat（无每-tab 子栈）   | iOS / Harmony（每-tab 子栈）         |
| switchTab 后是否保留旧 tab 上的 navigateTo 页 | 否（被弹掉）            | 是（保留在 `tabStacks[prevTab]`）    |
| 实现入口                      | `dimina/fe/.../miniApp.js` | `page-stack-controller.ts`           |

---

## 2. 两种实现并存

### 2.1 默认架构（dimina-fe MiniApp）

文件：`dimina/fe/packages/container/src/pages/miniApp/miniApp.js`。

核心字段（见 `miniApp.js:31-48`）：

```js
this.bridgeList = []           // 当前可见的页面栈，按入栈时间排序
this.tabBarBridges = new Map() // pagePath -> Bridge：tab 页的懒加载持久池
this.currentTabPath = null     // 当前激活的 tab 路径
```

四个路由 API 的实现位置（行号对当前 commit 的快照）：

| API           | 实现位置                              | 关键副作用                                       |
|---------------|--------------------------------------|--------------------------------------------------|
| `navigateTo`  | `miniApp.js:482-553`                 | 创建 bridge → push → 动画 → `_syncHash`           |
| `navigateBack`| `miniApp.js:705-756`                 | pop top → 旧页 destroy → 上一页 `pageShow` → `_syncHash` |
| `redirectTo`  | `miniApp.js:651-703`                 | 复用 top bridge 但 `destroy + reset + start`，**栈深不变** |
| `reLaunch`    | `miniApp.js:555-643`                 | 销毁 `bridgeList ∪ tabBarBridges`（用 Set 去重），重建 root |
| `switchTab`   | `miniApp.js:767-894`                 | 弹掉非 tab 页 + 旧 tab `display:none`（不销毁）+ 命中或懒建目标 tab |

每次路由操作完成后都会调用 `_syncHash()`（`miniApp.js:372-378`），把栈序列化写回 URL：

```js
_syncHash() {
  const stack = this.bridgeList.map((b) => {
    const pagePath = b.opts.pagePath.startsWith('/') ? b.opts.pagePath.slice(1) : b.opts.pagePath
    return { pagePath, query: b.opts.query || {} }
  })
  HashRouter.syncStack(this.appId, stack)
}
```

### 2.2 native-host 架构

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

### 2.3 能力对比

| 维度                          | dimina-fe（默认）                            | native-host                                       |
|-------------------------------|----------------------------------------------|---------------------------------------------------|
| 每页页面载体                  | 1 `<iframe>` / page                          | 1 `<webview partition="persist:simulator">` / page（`device-shell.tsx:254-267`） |
| Tab 子栈语义                  | 无（switchTab 弹掉非 tab 页）                | 有（switchTab snapshot + restore）                |
| URL 同步                      | `HashRouter.syncStack` 写 `location.search`  | 无 URL 同步（host 内部状态）                       |
| 路由回调路径                  | `success` / `fail` / `complete` 透传到 jscore | host 派发 `SideEffect`，由 IPC adapter 回 ack       |
| 单测覆盖                       | 间接通过 e2e                                  | 43 case 单测（纯函数）                             |

---

## 3. bridgeList 与 bridge 缓存（默认架构）

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

---

## 4. 生命周期触发详表

### 4.1 一页表

下表「事件」列只列页面栈相关生命周期；时机 = 同步指 reducer / push 立即触发，动画后指等 transitionend。

| 路由动作         | 当前页 (top before)              | 目标页 (top after)                                                | 被弹 / 被替换页                  | 旧 tab 页（仅 switchTab）          |
|------------------|---------------------------------|-----------------------------------------------------------------|-------------------------------|-----------------------------------|
| `navigateTo`     | `pageHide`（同步，slide-out 时） | `onLoad` → `onReady` → `pageShow`（同步）                          | —                             | —                                 |
| `navigateBack(1)`| —                               | `pageShow`（同步）                                                | `destroy()`→`onUnload`（同步） | —                                 |
| `navigateBack(δ>1)`| —                             | `pageShow`（同步）                                                | 每个被弹页一次 `onUnload`        | —                                 |
| `redirectTo`     | —                               | `onLoad` → `pageShow`（同步，复用旧 bridge 但 `resetStatus`）       | 旧 top：`destroy()`→`onUnload`  | —                                 |
| `reLaunch`       | —                               | `onLoad` → `pageShow`（异步，createBridge 完成后）                  | `bridgeList ∪ tabBarBridges` 全员 `destroy`→`onUnload` | 同左 |
| `switchTab` (cache hit) | `pageHide`（同步）         | `pageShow`（同步，复用池中 Bridge）                                | 旧栈所有非 tab 页：`destroy`→`onUnload` | iframe `display:none`（不 unload）|
| `switchTab` (miss)| `pageHide`（同步）              | `onLoad` → `pageShow`（懒建后）                                  | 旧栈所有非 tab 页：`destroy`→`onUnload` | iframe `display:none`            |

### 4.2 容易踩坑的点

- **`navigateBack(delta)` 越界**：
  - **dimina-fe**：源码（`miniApp.js:705-756`）只看 `bridgeList.length < 2` 就直接 `return`，**不对 delta clamp**——传 `delta=99` 会跑完一遍循环然后停。其实代码内部并没读 `delta` 参数（默认弹 1）；这是 dimina-fe 当前的实现细节，与 WeChat 规范有偏差。
  - **native-host**：`reduceNavigateBack` 显式 clamp：`Math.min(Math.max(1, delta), stack.length - 1)`（`page-stack-controller.ts:127-130`）。`delta` 超过深度直接弹到栈底，不抛错。
- **`reLaunch` 是否对栈底 entry 也触发 `onUnload`**：是。`miniApp.js:578-583` 把 `bridgeList[0]` 也 `destroy`，等价 `onUnload`。
- **`switchTab` 对 tab 页只触发 `onShow`/`onHide`，不触发 `onLoad`/`onUnload`**：tab iframe 在池里持久存在，只是 `display:none ↔ ''` 切换（`miniApp.js:829-830`、`miniApp.js:870`）；新 tab 首次进入会触发完整 `onLoad`，之后切来切去只 `pageShow` / `pageHide`。
- **同名 bridgeId 在 reLaunch 中的防御**：`reduceReLaunch` 显式从 unload 集合里删去 `newEntry.bridgeId`（`page-stack-controller.ts:190`），防止"新页面和旧页面 ID 撞车导致新页被错卸"。

---

## 5. URL 同步机制

### 5.1 写：HashRouter.syncStack

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

实现：`packages/devtools/src/main/services/automation/handlers/app.ts:41-75`。两个 handler 都按 `ctx.bridge?.isNativeHost()` 分流：

```ts
appHandlers['App.getCurrentPage'] = async (ctx) => {
  if (ctx.bridge?.isNativeHost()) {
    // native-host：读 active render guest 的 location.search，
    // render-host preload 把 pagePath（+ per-page query）编码在那里。
    const page = await readNativeActivePage(ctx)
    return { pageId: 1, path: page?.pagePath ?? '', query: page?.query ?? {} }
  }
  // 默认架构：完全通过读顶层 location.search 还原当前页。
  const route = await readRoute(ctx)
  const iframeCount = await evalInSim(ctx, `document.querySelectorAll('iframe').length`)
  return {
    pageId: iframeCount,
    path: route?.current.pagePath ?? '',
    query: route?.current.query ?? {},
  }
}
```

- **默认架构（else 分支）**：完全通过读顶层 `location.search` 还原当前页——不直接读 `bridgeList`，因为 automator 是远程协议、需要 OOP-safe 的"事实"信道。`pageId` 取 iframe 数量。
- **native-host 分支**：`readNativeActivePage`（`app.ts:27-39`）拿 `getActivePageWc(ctx)`，读该 render guest 自己的 `location.search`，从 `pagePath` 参数里 `decodePageSpec` 解出 `{ pagePath, query }`，固定返回 `pageId: 1`。

`App.getPageStack` 同样分流（`app.ts:55-75`）。默认架构按上游 `HashRouter.parseSearch` 还原 `[entry]` 或 `[entry, current]` 两层；native-host 分支只能返回**单条目栈**——bridge handle 只暴露 *active* 页的 `bridgeId`、不暴露完整有序栈，所以这是 native-host 下记录在 `app.ts:58-60` 的已知 **LIMITATION**（完整多页栈上报留待后续）。

`App.callWxMethod`（`app.ts:77-179`）的 native-host 分支：导航不是 DOM 点击，而是把真正的 `wx.<method>` 跑在隐藏的 service 窗口里（`serviceWc.executeJavaScript('wx.<method>(...)')`，`app.ts:84-94`），让导航走与运行中小程序相同的路径，再由 DeviceShell 驱动页面栈。

### 5.3 ⚠️ 已知缺陷：URL 滞后

在 `packages/devtools/e2e/tabbar.spec.ts:613-639` 这个 test 里，连续多次 `switchTab` 之后观察到：DOM 里已经显示 HOME，但 `location.search?page=` 还卡在前一个 tab。

```text
home → navigateTo detail → switchTab cart → switchTab home
                                            ^^^^^^^^^^^^^^^
                                            DOM 已切回 home，但 location.search
                                            的 page 参数仍指向 cart（或更早）
```

直接症状：`miniProgram.currentPage().path` 返回过期值（DOM 已切回 home，但 `location.search` 的 `page` 仍指向旧 tab，`App.getCurrentPage` 据此还原出 stale path）。该 test 只断 DOM、不再断 `cp.path`（见 `tabbar.spec.ts` 末尾内联说明）。

---

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

实现 `page-stack-controller.ts:281-295`。Renderer 据此决定 `iframe.style.display`。

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

### 6.5 与默认架构的差异（再强调）

| 场景：home → navTo detail → switchTab cart → switchTab home |
|---|
| **dimina-fe**：detail 在第一次 switchTab 时被 destroy；切回 home 仅看到 home。|
| **native-host**：detail 进入 `tabStacks['pages/home/home']` 快照；切回 home 还原 `[home, detail]`，detail 重新可见。|

---

## 7. 错误与降级

### 7.1 拒绝矩阵

| API           | 拒绝条件                                         | 实现                                               | 拒绝表现                                         |
|---------------|--------------------------------------------------|----------------------------------------------------|-------------------------------------------------|
| `navigateTo`  | 目标是 tabBar 页                                 | `miniApp.js:489-494`                               | `onFail({ errMsg: 'navigateTo:fail can not navigateTo a tabbar page' })` |
| `navigateTo`  | 动画未结束（防抖）                                | `miniApp.js:497-500`                               | 直接 `return`，无回调（**与规范不一致**）             |
| `redirectTo`  | 目标是 tabBar 页                                 | `miniApp.js:658-663`                               | `onFail({ errMsg: 'redirectTo:fail can not redirectTo a tabbar page' })` |
| `switchTab`   | 目标不是 tabBar 页                              | `miniApp.js:775-779`                               | `onFail({ errMsg: 'switchTab:fail not a tabBar page: <path>' })` |
| `switchTab`   | 动画未结束                                       | `miniApp.js:782-786`                               | `onFail({ errMsg: 'switchTab:fail busy' })`     |
| `navigateBack`| 栈深度 < 2                                       | `miniApp.js:706-708`                               | 直接 `return`，无回调                            |
| `navigateTo`  | 栈深达到上限（规范 10）                            | dimina-fe 当前**未在源码强制**；只在 `e2e/page-stack.spec.ts:943-1009` 探测  | 规范期望 `onFail`；当前实现可能放过                 |
| 任何 reducer  | 目标 path 非法 / 不在 modules                    | `reLaunch` 用 try/catch 兜（`miniApp.js:632-642`）| `onFail({ errMsg: 'reLaunch:fail <msg>' })`     |

### 7.2 共性约定

- 所有拒绝走 `fail` 回调 + `complete` 回调，**不抛异常**到调用方。
- `errMsg` 格式严格遵循 `${api}:fail <reason>`，与 WeChat 一致，便于自动化断言用正则匹配。
- native-host 的 `reduceNavigateBack` 拒绝返回 `{ error: string }` 而非抛错（`page-stack-controller.ts:124-126`）；host adapter 翻译成 `errMsg`。

### 7.3 防抖与回调遗失

`miniApp.js:497-500`、`miniApp.js:710-714` 的 `webviewAnimaEnd` 防抖在某些路径上**没回 `onFail`/`onComplete`**，调用方 success/fail/complete 都不会触发，存在用户脚本"挂起"风险。

---

## 8. 测试入口

- 单测：`packages/devtools/src/simulator/device-shell/page-stack-controller.test.ts`，43 个 case 覆盖五个 reducer 的纯函数行为（含 lifecycle effects 顺序、tabStacks 同步、reLaunch 全清等）。
- e2e：
  - `packages/devtools/e2e/page-stack.spec.ts`：现存 5 API + 生命周期 + 深度限制 + URL 同步检查（共 17 个 test）。
  - `packages/devtools/e2e/tabbar.spec.ts`：WeChat semantics 路径下 `switchTab` 的栈行为，含 §5.3 描述的 URL 滞后 workaround。

---

## 9. 延伸阅读

- `packages/devtools/docs/simulator-refactor.md` —— Native Bridge 协议 / native-host 窗口拓扑。
- `packages/devtools/docs/workbench-model.md` —— Workspace / Project 与 simulator 的上下层关系。
- [`./tab-bar.md`](./tab-bar.md) —— tab 渲染、badge / reddot、动态 API。
- [`./electron-container.md`](./electron-container.md) —— host process 与 renderer 的进程边界、`<webview>` 载体。
