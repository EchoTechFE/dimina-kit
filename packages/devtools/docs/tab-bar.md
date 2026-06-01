# TabBar

> TabBar 是小程序底部（或顶部）的多 tab 切换栏，dimina-kit 里有 **两套渲染实现**（dimina-fe DOM 与 native-host React），配置同源、协议同源、对外行为同源。
>
> 配套文档：Bridge Envelope 协议见 [`./simulator-refactor.md`](./simulator-refactor.md)；per-tab 子栈语义见 [`./page-stack.md`](./page-stack.md)。
>
> 关联代码：`src/shared/bridge-channels.ts`、`src/simulator/device-shell/tab-bar.tsx`、
> `src/simulator/device-shell/tab-bar-state.ts`、`src/main/ipc/bridge-router.ts`、
> `dimina/fe/packages/container/src/pages/miniApp/miniApp.js`

## 摘要（TL;DR）

dimina-kit 的 TabBar 有 **两套渲染实现**：默认架构走 dimina-fe `MiniApp` 的 DOM + 事件委托 + 原地 patch（`miniApp.js`），native-host 架构走 `DeviceShell` 的 React + 纯函数 reducer（`tab-bar.tsx` / `tab-bar-state.ts`）。两边的配置同源（编译期 `app.json` 的 `tabBar` 搬进 `app-config.json`，运行时读出，契约类型是 `TabBarConfig` / `TabBarItem`，定义在 `bridge-channels.ts:133-148`）、协议同源（8 个动态 API + `switchTab`，errMsg 字符串两边保持一致）、对外行为同源。关键差异：dimina-fe `switchTab` 切走会销毁非顶 tab 的非顶页面，native-host 用 `tabStacks` 保留每个 tab 的完整子栈（对齐 iOS / Harmony）。native-host 的动态 API 走 `bridge-router.ts` 的 `handleSimulatorApi` → `TAB_ACTION` → `applyTabAction` → `setState` 这条链路，再回灌 `notifyNavCallback`。自动化测试从 simulator top-window 的 wx mirror（`main.tsx:225-237`）进入。

## 这个文档解决什么

dimina-kit 里有 **两套** TabBar 渲染实现，配置同源、协议同源、对外行为同源，
但内部是 DOM 渲染 vs React 渲染两条独立路径。本文梳理：

1. 配置如何从源码进到运行时；
2. 两种实现的差异、能力对比；
3. 8 个动态 API + `switchTab` 怎么被驱动、谁负责副作用；
4. 自动化测试通过哪条 wx 表面进入；
5. 已知的样式 / 行为对齐 gap。

## 1. 从配置到运行时

> 一句话：mini-program 的 `app.json` 里 `tabBar` 字段在编译期被搬进
> `app-config.json` 的 `app.tabBar`，运行时被 `MiniApp` / `DeviceShell` 读出来变成状态。

### 1.1 流水图

```
                  build (dimina compiler)
   ┌──────────────┐    │    ┌────────────────────────┐
   │   app.json   │────▼───►│ app-config.json        │
   │  tabBar:{…}  │         │ { app: { tabBar:{…}}}  │
   └──────────────┘         └─────────────┬──────────┘
                                          │  load at runtime
                            ┌─────────────┴────────────────┐
                            │                              │
                ┌───────────▼────────────┐      ┌──────────▼───────────────┐
                │ dimina-fe MiniApp      │      │ native-host DeviceShell  │
                │ (default arch)         │      │ (simulator React)        │
                │                        │      │                          │
                │ tabBarConfig (raw)     │      │ TabBarConfig (typed)     │
                │ tabBarBadges / RedDots │      │ TabBarState (reducer)    │
                │ tabBarEl (real DOM)    │      │ <TabBar … />             │
                └────────────────────────┘      └──────────────────────────┘
```

### 1.2 类型

`TabBarConfig` 与 `TabBarItem` 定义在 `src/shared/bridge-channels.ts:133-148`，
是 main / simulator / preload 之间唯一的契约：

```ts
// bridge-channels.ts:133
export interface TabBarItem {
  pagePath: string
  text?: string
  iconPath?: string
  selectedIconPath?: string
}

// bridge-channels.ts:140
export interface TabBarConfig {
  color?: string
  selectedColor?: string
  backgroundColor?: string
  borderStyle?: 'black' | 'white'
  position?: 'bottom' | 'top'
  custom?: boolean
  list: TabBarItem[]
}
```

### 1.3 字段语义

| 字段 | 类型 | 语义 | 落地点 |
| --- | --- | --- | --- |
| `color` | string | 文字默认色（HexColor / rgba / hsla） | dimina-fe `_updateTabBarSelection` text.color；React `<TabBar>` 行内 style |
| `selectedColor` | string | 文字选中色 | 同上，选中项的 text.color |
| `backgroundColor` | string | TabBar 容器底色 | `.dimina-tabbar` / `.dmb-tab-bar` 的 `backgroundColor` |
| `borderStyle` | `'black'\|'white'` | 上边框颜色（只接受这两个枚举） | borderTopColor，传 black ⇒ `#e0e0e0`，white ⇒ `#ffffff` |
| `position` | `'bottom'\|'top'` | 位置 | dimina-fe 永远 bottom；React 也未实现 top（见 §7） |
| `custom` | boolean | 启用自定义 tabBar（小程序自己渲染） | 当前两套实现都未支持，仅类型透传 |
| `list[].pagePath` | string | tabBar 页路径，编译期已规范化无前导 `/` | 路由判定 / `tabBarPaths` 数组成员 |
| `list[].text` | string | 文本 | text 节点 |
| `list[].iconPath` | string | 默认图标，相对包根 | dimina-fe `_resolveTabBarIcon` 拼接到 Vite BASE_URL；React `resolveIcon` 拼接 `resourceBaseUrl` |
| `list[].selectedIconPath` | string | 选中图标 | 选中态切换显隐 |

## 2. 两种渲染实现

> 一句话：默认架构（dimina-fe MiniApp）是 DOM + 事件委托 + 原地 patch；native-host
> 架构（DeviceShell）是 React + reducer 纯函数 + props/dispatch。

### 2.1 默认架构（dimina-fe MiniApp）

入口在 `dimina/fe/packages/container/src/pages/miniApp/miniApp.js`：

- `_initTabBar()`（`miniApp.js:900`）解析 `app.tabBar`，初始化
  `tabBarPaths` / `tabBarBadges` / `tabBarRedDots` / `tabBarApiVisible`。
- `_renderTabBar()`（`miniApp.js:916-986`）一次性构建 DOM 并挂载，使用 `document.createElement`，
  避免 `innerHTML` 拼接被配置中的引号污染。
- CSS class（`miniApp.scss:641-720`）：
  - `.dimina-tabbar` —— 根容器
  - `.dimina-tabbar-item` —— 单个 tab 项
  - `.dimina-tabbar-text` —— 文本
  - `.dimina-tabbar-badge` —— 角标（隐藏靠 `hidden` 属性）
  - `.dimina-tabbar-red-dot` —— 红点
- 事件监听**单点挂在 `.dimina-tabbar` 根上**（`miniApp.js:970-977`），
  通过 `e.target.closest('.dimina-tabbar-item')` 反查命中项 ——
  增删 tab 不需要重绑事件。

### 2.2 native-host 架构（DeviceShell React）

- `src/simulator/device-shell/tab-bar.tsx` —— React 组件，从 `state` + props 渲染。
- `src/simulator/device-shell/tab-bar-state.ts` —— 纯函数 reducer
  `applyTabAction(prev, action)`，输入旧 state + action，返回新 state +
  `{ ok, errMsg }`，DeviceShell 拿到 ack 后回灌 `notifyNavCallback`。
- 接入点在 `src/simulator/device-shell/device-shell.tsx:119-134`：监听
  `SIMULATOR_EVENTS.TAB_ACTION` → `applyTabAction` → `setState` →
  React 自然重渲染。
- CSS class（`src/simulator/device-shell/tab-bar.css`）：`.dmb-tab-bar`
  / `__item` / `__icon-slot` / `__text` / `__badge` / `__red-dot`，
  与 dimina-fe 完全独立的一套 BEM。

### 2.3 能力对比

| 能力 | dimina-fe (default) | native-host (React) |
| --- | --- | --- |
| 渲染方式 | DOM API + 事件委托 | React + props/dispatch |
| 图标 default/selected | 两张 `<img>` 都挂载，display 切换 | 一张 `<img>`，按 selected 取 url |
| 动态 API 落地 | `MiniApp.setTabBar*` 实例方法直接改 DOM | `applyTabAction` 纯函数 → setState |
| 颜色校验 | `_sanitizeCssColor`（实例方法） | `sanitizeColor`（`tab-bar-state.ts:179-188`，等价实现） |
| 子栈语义 | 单条 `bridgeList` + `tabBarBridges` Map 缓存非顶 tab | `ShellState.tabStacks` 每个 tab 独立子栈 |

## 3. 8 个动态 API

> 一句话：8 个动态 API 在两边都各自实现，errMsg 字符串保持一致，所以同一份 e2e
> 用例可以跨两条实现跑。

### 3.1 API 总览

| API | 关键入参 | success errMsg | fail errMsg（典型） | 状态副作用 |
| --- | --- | --- | --- | --- |
| `setTabBarStyle` | color / selectedColor / backgroundColor / borderStyle | `setTabBarStyle:ok` | `setTabBarStyle:fail tabBar not configured` | 改 config；不重渲，仅刷颜色/边框 |
| `setTabBarItem` | index, text?, iconPath?, selectedIconPath? | `setTabBarItem:ok` | `setTabBarItem:fail invalid index <n>` | 改 `config.list[i]`；DOM 端重建该项图标 |
| `showTabBar` | — | `showTabBar:ok` | — | `visible = true`（`tabBarApiVisible = true`） |
| `hideTabBar` | — | `hideTabBar:ok` | — | `visible = false` |
| `setTabBarBadge` | index, text | `setTabBarBadge:ok` | `setTabBarBadge:fail invalid index <n>` | `badges[i]=text`，同时清掉 `redDots[i]` |
| `removeTabBarBadge` | index | `removeTabBarBadge:ok` | `removeTabBarBadge:fail invalid index <n>` | `badges[i]=''` |
| `showTabBarRedDot` | index | `showTabBarRedDot:ok` | `showTabBarRedDot:fail invalid index <n>` | `redDots[i]=true`，同时清掉 `badges[i]` |
| `hideTabBarRedDot` | index | `hideTabBarRedDot:ok` | `hideTabBarRedDot:fail invalid index <n>` | `redDots[i]=false` |

> 注意：badge 与 redDot **互斥** —— 设了 badge 自动清 redDot，反之亦然。
> 这条约束在两个实现里都被严格遵守（`miniApp.js:1305`、`tab-bar-state.ts:131-156`）。

### 3.2 入口位置

- **默认架构**：实例方法直接挂在 `MiniApp` 上 ——
  `setTabBarBadge`（`miniApp.js:1296`）、`setTabBarStyle`（`miniApp.js:1209`）、
  `setTabBarItem`（`miniApp.js:1249`）、`showTabBar`（`miniApp.js:1280`）、
  `hideTabBar`（`miniApp.js:1288`）、`removeTabBarBadge`（`miniApp.js:1319`）、
  `showTabBarRedDot`（`miniApp.js:1338`）、`hideTabBarRedDot`（`miniApp.js:1361`）。
- **native-host**：service runtime 发出的 `dmb:simulator-api` 在
  `src/main/ipc/bridge-router.ts` 的 `handleSimulatorApi`（`:864`）被分类，命中
  `TAB_ACTION_NAMES`（`:853-862`）后包成 `TabActionPayload` 发到 simulator window
  （`:906-915`）；simulator 端 `device-shell.tsx:119-134` 收到后调
  `applyTabAction`，最终走 `tab-bar-state.ts:46-83` 的 switch。

### 3.3 动态 API 执行序列（native-host）

```
service runtime          main process                   simulator window
─────────────────        ────────────────               ─────────────────
wx.setTabBarBadge({…})
   │
   └── bridge.publish ─► CHANNELS.SERVICE_INVOKE
                            │
                            ├── handleSimulatorApi
                            │   (bridge-router.ts:864)
                            │
                            ├── name ∈ TAB_ACTION_NAMES
                            │   (bridge-router.ts:853 decl / :906 check)
                            │
                            └── send(E.TAB_ACTION, payload) ─► useEffect listener
                                                                  (device-shell.tsx:119)
                                                                    │
                                                                    ├── applyTabAction(prev, {kind:'apply',…})
                                                                    │   (tab-bar-state.ts:46)
                                                                    │
                                                                    ├── setState(next)
                                                                    │   ⇒ React 重渲染 <TabBar>
                                                                    │
                                                                    └── miniApp.notifyNavCallback({ok,errMsg,callbacks})
                            ◄── NAV_CALLBACK
                            │
                            └── sendCallback(success/fail/complete) ─► service runtime
                                                                          ↓
                                                                       wx.setTabBarBadge.success({…})
```

默认架构等价地把 `simulator-api` 直接发到 `MiniApp` 实例方法，省略
TAB_ACTION → applyTabAction 这一段，DOM 在实例方法里同步 patch。

完整 envelope 路由见 [`./simulator-refactor.md`](./simulator-refactor.md) 的 Bridge Envelope 协议参考一节。

## 4. switchTab 与页面栈交互（WeChat semantics）

> 一句话：`switchTab` 在跳到 tabBar 页前必须 pop 掉所有非 tabBar 页，
> 这是 WeChat 的硬约束；两种实现都遵守，但**栈结构不同**。

### 4.1 默认架构（dimina-fe）

行为定义在 `miniApp.js:767-893`，参考字段说明在 `miniApp.js:46-50`：

```
tabBarBridges = Map<pagePath, Bridge>   // 懒加载、持久缓存的 tab 池
bridgeList = Bridge[]                   // 当前栈：栈顶可见、栈底通常是当前 tab 页
currentTabPath = string | null
```

`switchTab` 流程（`miniApp.js:799-885`）：

1. 从栈顶往下 `pop` 并销毁所有非 tabBar 页面（`miniApp.js:810-819`）；
2. 旧 tab bridge 调 `pageHide`，DOM `display:none`，从 `bridgeList` 拿出来
   但**仍保留在 `tabBarBridges` 中**（`miniApp.js:822-836`）；
3. 目标 tab：命中 `tabBarBridges` ⇒ 复用；未命中 ⇒ `createBridge` 懒加载 ⇒
   存入 `tabBarBridges`（`miniApp.js:839-858`）；
4. 入栈 + `pageShow` + `_setTabBarVisible(true)` + `_updateTabBarSelection`。

注意：**所有非顶 tab 的非顶页面在 `switchTab` 期间被销毁** —— 用户在 tab A 上
`navigateTo` 出去的页面，切到 tab B 再切回 A 时已经不在了。

### 4.2 native-host 架构（per-tab 子栈）

native-host 的 React 实现保留了每个 tab 各自的**完整子栈**，对齐 iOS / Harmony 行为，
不像 dimina-fe 那样切走就销毁。

定义在 `src/simulator/device-shell/page-stack-controller.ts:26-35`：

```ts
export interface ShellState {
  stack: PageEntry[]                            // 当前可见栈
  tabStacks: Record<string, PageEntry[]>        // 每 tab 一条独立子栈
  currentTabPath: string | null
}
```

`reduceSwitchTab`（`page-stack-controller.ts:220-264`）：先把当前 `stack`
快照进 `tabStacks[currentTabPath]`，再用 `tabStacks[targetTabPath]` 整段恢复 ——
**包括目标 tab 之前 navigateTo 出去那一摞**。

| 维度 | dimina-fe | native-host |
| --- | --- | --- |
| 切走非顶 tab | 复用，但只保留 tab 页 bridge | 整段子栈快照保留 |
| 切回 tab A | A 是干净的 tab 页 | A 恢复到离开时的栈顶（可能在某个详情页上） |
| 内存模型 | 一条 `bridgeList` + `tabBarBridges` Map | `stack` + `tabStacks` 字典 |

更多页栈语义见 [`./page-stack.md`](./page-stack.md)。

### 4.3 `_updateTabBarSelection`

`miniApp.js:1134-1151` 是默认架构的选中态切换逻辑：

- 文字颜色：选中 ⇒ `selectedColor`，否则 `color`；
- 图标：`dimina-tabbar-icon-default` / `dimina-tabbar-icon-selected` 互斥
  `display: none / block`；
- class：选中项加 `dimina-tabbar-item--selected`。

native-host 在 React 里靠 props 派生选中态（`tab-bar.tsx:30-71`），无独立函数。

## 5. 自动化测试通路

> 一句话：service worker 里的 `wx` 是给 mini-app 源码用的，automator 要从 simulator
> top-window 上拿到 `wx`，所以我们在 simulator 入口手工把 15 个方法（routing 5 + navigation-bar 2 + tab-bar 8）挂上去。

### 5.1 为什么需要 mirror

miniprogram-automator 的 `App.callWxMethod(name, …args)` 实现是
`wx[name](...args)`，**绑定到 simulator 顶层 window**，不是 mini-app 的
service worker。我们没法改 dimina-fe 把它的 service-side `wx` 拷到 top window
（不动 submodule），所以在 simulator 入口手工建一个 automation-only mirror。

入口在 `src/simulator/main.tsx:225-237`：

```ts
// main.tsx:225
const exposedWxMethods = [
  // Routing
  'navigateTo', 'navigateBack', 'redirectTo', 'reLaunch', 'switchTab',
  // NavigationBar dynamic APIs
  'setNavigationBarTitle', 'setNavigationBarColor',
  // TabBar dynamic APIs
  'showTabBar', 'hideTabBar',
  'setTabBarBadge', 'removeTabBarBadge',
  'showTabBarRedDot', 'hideTabBarRedDot',
  'setTabBarItem', 'setTabBarStyle',
] as const
```

每个方法都是 `MiniApp` 实例方法的 `.bind(miniApp)` 副本，对真实 service 侧 wx
零侵入。

### 5.2 设计 trade-off

| 方案 | 取舍 |
| --- | --- |
| ✅ simulator top-window mirror | 不动 submodule；每次新增 API 要手工挂；只影响 automator，不污染业务运行时 |
| ❌ 改 dimina-fe 暴露 window.wx | 违反 submodule 保护；service 侧逻辑泄露到 top window |
| ❌ 走 IPC 跑一圈再回 service | 多一层异步；automator timeout 调高反而掩盖真实 bug |

### 5.3 测试覆盖

- e2e：`e2e/tabbar.spec.ts` 共 12 个 case，覆盖渲染、点击切换、`switchTab`、
  badge / redDot、`setTabBarItem`、`setTabBarStyle`、show/hide。
- 单测：`src/simulator/device-shell/tab-bar-state.test.ts` 30 个 case，
  覆盖 `applyTabAction` 的所有 8 个 API + reset + visibility 分支 +
  index 越界 + 颜色 sanitize + badge/redDot 互斥。

## 6. 样式与 CSS transition 注意点

> 一句话：dimina-fe 的文字颜色带 200ms 过渡动画，自动化测试读 computed style
> 时要 poll，否则会拿到中间插值。

### 6.1 transition 引发的中间值

`.dimina-tabbar-text` 在 `miniApp.scss:684-689` 声明了：

```scss
.dimina-tabbar-text {
  font-size: …;
  transition: color 0.2s ease;
}
```

`setTabBarStyle` / `switchTab` 改 `text.style.color` 会触发动画，
立刻 `getComputedStyle` 拿到的是 200ms 内的插值。e2e 用 `expect.poll` 兜过去
（`e2e/tabbar.spec.ts:693-707`）：

```ts
// e2e/tabbar.spec.ts:693
// element has a `transition: color 0.2s ease` CSS rule, so getComputedStyle
// returns the *interpolated* colour during the transition window.
```

native-host 的 `.dmb-tab-bar__text` 没声明 transition，测试时不需要 poll —— 但
e2e 走的是默认架构那条路径，所以 poll 仍然要保留。

### 6.2 `--dimina-tabbar-height`

TabBar 的真实高度（含 `env(safe-area-inset-bottom)`）通过 `ResizeObserver`
实时同步给 CSS 变量：

- 写入：`miniApp.js:1056-1060` 的 `_syncTabBarHeightVar()`，
  `el.style.setProperty('--dimina-tabbar-height', ...)`。
- 读出：tab 页 webview 自身用 `bottom: <height>px` 留白
  （`miniApp.js:1071`）。

设计要点：**webviews 容器保持全屏，只有 tab 页 webview 自己预留底部**，
这样隐藏 tabBar 跳到非 tab 页时不会触发所有页面的整体 reflow。
native-host 的 React 实现里 TabBar 是 `device-shell` 的 flex 兄弟节点，靠
flex 占位，没有同步 CSS 变量的需要。

## 7. 已知 gap / 局限

> 一句话：两套实现在边角行为上没完全对齐，且 dimina-fe 简化掉了一些 WeChat 旧字段。

| Gap | 现状 | 影响 |
| --- | --- | --- |
| `setTabBarStyle({ position })` | dimina-fe 没实现 `position: 'top'`（WeChat 旧字段） | 真机能切顶部，simulator 不能；本地极少用到 |
| hover / press 反馈 | dimina-fe 通过 CSS 提供颜色过渡；React 端没接 `:active` / hover 样式 | 自动化测试无感，肉眼可察 |
| `setTabBarItem(iconPath)` 重建图标 DOM | dimina-fe 在 `_replaceTabBarItemIcons` 里替换 `<img>` 节点（`miniApp.js:1180-1192`） | 如果用户的 iconPath 是大图 / 慢加载，切换时会闪一下；持续动画图标会被打断 |
| `custom: true`（自定义 tabBar 组件） | 两边都不支持 | 业务想自渲染 tabBar 时只能改 submodule |
| native-host 子栈缓存策略 | 当前无上限，长会话会持有所有 tab 的所有子栈 | 内存压力；如果 simulator 长跑做演示要注意 |

## 参考索引（grep 友好）

| 主题 | 文件:行 |
| --- | --- |
| `TabBarConfig` / `TabBarItem` 类型 | `src/shared/bridge-channels.ts:133-148` |
| `TabActionPayload` 协议 | `src/shared/bridge-channels.ts:332-346` |
| TabBar React 组件 | `src/simulator/device-shell/tab-bar.tsx:14-74` |
| `applyTabAction` reducer | `src/simulator/device-shell/tab-bar-state.ts:46-83` |
| Main 端分发 TAB_ACTION | `src/main/ipc/bridge-router.ts:853-915`（`TAB_ACTION_NAMES` / `handleSimulatorApi`） |
| `_renderTabBar` DOM 构建 | `dimina/fe/.../miniApp.js:916-986` |
| `switchTab` 流程 | `dimina/fe/.../miniApp.js:767-893` |
| `_updateTabBarSelection` 选中态切换 | `dimina/fe/.../miniApp.js:1134-1151` |
| `setTabBarBadge` 实例方法 | `dimina/fe/.../miniApp.js:1296-1317` |
| `--dimina-tabbar-height` 同步 | `dimina/fe/.../miniApp.js:1056-1078` |
| `.dimina-tabbar-text` transition | `dimina/fe/.../miniApp.scss:684-689` |
| Top-window wx mirror | `src/simulator/main.tsx:225-237` |
| e2e 用例 | `e2e/tabbar.spec.ts:399-735` |
| reducer 单测 | `src/simulator/device-shell/tab-bar-state.test.ts` |

> Bridge Envelope 协议见 [`simulator-refactor.md`](./simulator-refactor.md)；per-tab 子栈语义见 [`page-stack.md`](./page-stack.md)。
