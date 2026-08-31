# TabBar

> TabBar 是小程序底部（或顶部）的多 tab 切换栏。devtools simulator 只有一套渲染实现——native-host 的 `DeviceShell`（React + 纯函数 reducer）。
>
> 配套文档：Bridge Envelope 协议见 [`./native-bridge-protocol.md`](./native-bridge-protocol.md)；per-tab 子栈语义见 [`./page-stack.md`](./page-stack.md)。

>
> 关联代码：`packages/dimina-electron-runtime/src/shared/bridge-channels.ts`、`packages/dimina-electron-runtime/src/simulator-ui/tab-bar.tsx`、
> `packages/dimina-electron-runtime/src/simulator-ui/tab-bar-state.ts`、`packages/dimina-electron-runtime/src/main/ipc/bridge-router.ts`

## 摘要（TL;DR）

devtools 的 TabBar 渲染走 native-host 的 `DeviceShell`：React + 纯函数 reducer（`tab-bar.tsx` / `tab-bar-state.ts`）。配置来自编译期 `app.json` 的 `tabBar` 搬进 `app-config.json`，运行时读出，契约类型是 `TabBarConfig` / `TabBarItem`（定义在 `bridge-channels.ts`）。`switchTab` 用 `tabStacks` 保留每个 tab 的完整子栈（upstream web 容器会卸掉非 tab 页，差异见 §4.1）。动态 API 走 `bridge-router.ts` 的 `handleSimulatorApi` → `TAB_ACTION` → `applyTabAction` → `setState` 这条链路，再回灌 `notifyNavCallback`。自动化测试经 `App.callWxMethod` 进入：native-host 下权威的 `wx.*` 跑在隐藏的 service-host 窗口，由 `automation/handlers/app.ts` 用 `serviceWc.executeJavaScript('wx.<method>(...)')` 驱动（`app.ts` 的 native-host 分支），不存在 simulator top-window 的 `wx` mirror。

## 这个文档解决什么

本文梳理 native-host TabBar：

1. 配置如何从源码进到运行时；
2. React + reducer 的渲染路径；
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
                            ┌─────────────▼────────────────┐
                            │ native-host DeviceShell       │
                            │ (simulator React)             │
                            │                               │
                            │ TabBarConfig (typed)          │
                            │ TabBarState (reducer)         │
                            │ <TabBar … />                  │
                            └───────────────────────────────┘
```

### 1.2 类型

`TabBarConfig` 与 `TabBarItem` 定义在 `packages/dimina-electron-runtime/src/shared/bridge-channels.ts`，
是 main / simulator / preload 之间唯一的契约：

```ts
// bridge-channels.ts
export interface TabBarItem {
  pagePath: string
  text?: string
  iconPath?: string
  selectedIconPath?: string
}

// bridge-channels.ts
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
| `color` | string | 文字默认色（HexColor / rgba / hsla） | `<TabBar>` 行内 style，未选中项的 text.color |
| `selectedColor` | string | 文字选中色 | 同上，选中项的 text.color |
| `backgroundColor` | string | TabBar 容器底色 | `.dmb-tab-bar` 的 `backgroundColor` |
| `borderStyle` | `'black'\|'white'` | 上边框颜色（只接受这两个枚举） | borderTopColor，传 black ⇒ `#e0e0e0`，white ⇒ `#ffffff` |
| `position` | `'bottom'\|'top'` | 位置 | 未实现 top（见 §7） |
| `custom` | boolean | 启用自定义 tabBar（小程序自己渲染） | 当前不支持，仅类型透传 |
| `list[].pagePath` | string | tabBar 页路径，编译期已规范化无前导 `/` | 路由判定 / `tabBarPaths` 数组成员 |
| `list[].text` | string | 文本 | text 节点 |
| `list[].iconPath` | string | 默认图标，编译期改写为 server 根绝对路径 `/<appId>/main/static/…` | `resolveIcon` 直接拼到 `resourceBaseUrl`（保留 `<appId>` 段） |
| `list[].selectedIconPath` | string | 选中图标 | 选中态切换显隐 |

## 2. 渲染实现（DeviceShell React）

> 一句话：native-host 的 DeviceShell 是 React + reducer 纯函数 + props/dispatch。

### 2.1 组件与 reducer

- `packages/dimina-electron-runtime/src/simulator-ui/tab-bar.tsx` —— React 组件，从 `state` + props 渲染。
- `packages/dimina-electron-runtime/src/simulator-ui/tab-bar-state.ts` —— 纯函数 reducer
  `applyTabAction(prev, action)`，输入旧 state + action，返回新 state +
  `{ ok, errMsg }`，MiniAppFrame 拿到 ack 后回灌 `notifyNavCallback`。
- 接入点在 `packages/dimina-electron-runtime/src/simulator-ui/miniapp-frame.tsx`：监听
  `SIMULATOR_EVENTS.TAB_ACTION` → `applyTabAction` → `setState` →
  React 自然重渲染。
- CSS class（`packages/dimina-electron-runtime/src/simulator-ui/tab-bar.css`）：`.dmb-tab-bar`
  / `__item` / `__icon-slot` / `__text` / `__badge` / `__red-dot`（一套 BEM）。

### 2.2 关键实现点

| 能力 | native-host (React) |
| --- | --- |
| 渲染方式 | React + props/dispatch |
| 图标 default/selected | 一张 `<img>`，按 selected 取 url |
| 动态 API 落地 | `applyTabAction` 纯函数 → setState |
| 颜色校验 | `sanitizeColor`（`tab-bar-state.ts`） |
| 子栈语义 | `ShellState.tabStacks` 每个 tab 独立子栈 |

## 3. 8 个动态 API

> 一句话：8 个动态 API 都由 `applyTabAction` 返回 success/fail 结果，再由 bridge-router 回调 service。

### 3.1 API 总览

| API | 关键入参 | success errMsg | fail errMsg（典型） | 状态副作用 |
| --- | --- | --- | --- | --- |
| `setTabBarStyle` | color / selectedColor / backgroundColor / borderStyle | `setTabBarStyle:ok` | `setTabBarStyle:fail tabBar not configured` | 改 config；不重渲，仅刷颜色/边框 |
| `setTabBarItem` | index, text?, iconPath?, selectedIconPath? | `setTabBarItem:ok` | `setTabBarItem:fail invalid index <n>` | 改 `config.list[i]`；React 重渲该项图标 |
| `showTabBar` | — | `showTabBar:ok` | — | `visible = true`（`tabBarApiVisible = true`） |
| `hideTabBar` | — | `hideTabBar:ok` | — | `visible = false` |
| `setTabBarBadge` | index, text | `setTabBarBadge:ok` | `setTabBarBadge:fail invalid index <n>` | `badges[i]=text`，同时清掉 `redDots[i]` |
| `removeTabBarBadge` | index | `removeTabBarBadge:ok` | `removeTabBarBadge:fail invalid index <n>` | `badges[i]=''` |
| `showTabBarRedDot` | index | `showTabBarRedDot:ok` | `showTabBarRedDot:fail invalid index <n>` | `redDots[i]=true`，同时清掉 `badges[i]` |
| `hideTabBarRedDot` | index | `hideTabBarRedDot:ok` | `hideTabBarRedDot:fail invalid index <n>` | `redDots[i]=false` |

> 注意：badge 与 redDot **互斥** —— 设了 badge 自动清 redDot，反之亦然。
> 这条约束在 reducer 里严格遵守（`tab-bar-state.ts`）。

### 3.2 入口位置

service runtime 发出的 `dmb:simulator-api` 在 `packages/dimina-electron-runtime/src/main/ipc/bridge-router.ts` 的
`handleSimulatorApi` 被分类，命中 `TAB_ACTION_NAMES` 后包成 `TabActionPayload`
发到 simulator window；simulator 端 `device-shell.tsx` 收到后调 `applyTabAction`，
最终走 `tab-bar-state.ts` 的 switch。

### 3.3 动态 API 执行序列（native-host）

```
service runtime          main process                   simulator window
─────────────────        ────────────────               ─────────────────
wx.setTabBarBadge({…})
   │
   └── bridge.publish ─► CHANNELS.SERVICE_INVOKE
                            │
                            ├── handleSimulatorApi
                            │   (bridge-router.ts)
                            │
                            ├── name ∈ TAB_ACTION_NAMES
                            │   (bridge-router.ts)
                            │
                            └── send(E.TAB_ACTION, payload) ─► useEffect listener
                                                                  (device-shell.tsx)
                                                                    │
                                                                    ├── applyTabAction(prev, {kind:'apply',…})
                                                                    │   (tab-bar-state.ts)
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

完整 envelope 路由见 [`./native-bridge-protocol.md`](./native-bridge-protocol.md) 的 Bridge Envelope 协议参考一节。

## 4. switchTab 与页面栈交互

> 一句话：native-host 用 per-tab 子栈保留每个 tab 的完整页面栈。

### 4.1 native-host 的 per-tab 子栈

native-host 的 React 实现保留每个 tab 各自的**完整子栈**。

定义在 `packages/dimina-electron-runtime/src/simulator-ui/page-stack-controller.ts`：

```ts
export interface ShellState {
  stack: PageEntry[]                            // 当前可见栈
  tabStacks: Record<string, PageEntry[]>        // 每 tab 一条独立子栈
  currentTabPath: string | null
}
```

`reduceSwitchTab`（`page-stack-controller.ts`）：先把当前 `stack`
快照进 `tabStacks[currentTabPath]`，再用 `tabStacks[targetTabPath]` 整段恢复 ——
**包括目标 tab 之前 navigateTo 出去那一摞**。

这里和 upstream 的 web 容器不一样，排查「同一份小程序在 simulator 和网页里表现不同」时先看这条：
upstream `MiniApp.switchTab` 会「隐藏 / 卸载非 tab 页面（从栈顶往下，遇到 tab 页停止）」
（`dimina/fe/packages/container-sdk/src/pages/miniApp/miniApp.ts:1558` 起），
用户在 tab A 上 `navigateTo` 出去的页面，切到 B 再切回 A 就没了；native-host 会把它整段还回来。
微信真机的行为本文未验证，不要拿这两条任何一条当微信语义用。

### 4.2 选中态切换

native-host 在 React 里靠 props 派生选中态（`tab-bar.tsx`），无独立函数：
选中项文字取 `selectedColor`，未选中取 `color`；图标按 selected 取
`selectedIconPath` / `iconPath`；选中项加 `--selected` modifier 类。

## 5. 自动化测试通路

> 一句话：权威的 `wx` 跑在隐藏的 service-host 窗口里（simulator / render-guest 上下文没有 `wx`），所以 automator 调用的 `wx.*` 直接在那儿执行。

### 5.1 wx 在哪里执行

miniprogram-automator 的 `App.callWxMethod(name, …args)` 经 ws 到 main 进程的
`automation/handlers/app.ts`。native-host 下 handler 用
`ctx.bridge.getServiceWc().executeJavaScript('wx.<method>(...)')` 在 service-host
窗口里跑——和运行中小程序用的是同一份权威 `wx`：

- 路由方法（navigateTo / redirectTo / reLaunch / switchTab / navigateBack）：在
  service-host 跑，由 DeviceShell 驱动页面栈；
- tab-bar / navigation-bar 等非路由方法：同样在 service-host `wx` 上调用并取返回值。

不需要把 `wx` 镜像到 simulator top window，也不动 submodule。

### 5.2 测试覆盖

- e2e：`e2e/native-host-wx-method.spec.ts`（automator 经 `callWxMethod` 驱动 tab-bar / 路由）、
  `packages/dimina-electron-runtime/e2e/native-host-device.spec.ts`（含 tab-bar 渲染、点击切换、badge / redDot / show-hide）。
- 单测：`packages/dimina-electron-runtime/src/simulator-ui/tab-bar-state.test.ts` 30 个 case，
  覆盖 `applyTabAction` 的所有 8 个 API + reset + visibility 分支 +
  index 越界 + 颜色 sanitize + badge/redDot 互斥。

## 6. 样式与布局注意点

### 6.1 选中态颜色无 transition

native-host 的 `.dmb-tab-bar__text` 没声明 CSS transition，`setTabBarStyle` /
`switchTab` 改颜色后 `getComputedStyle` 立刻拿到的就是终值，自动化读 computed
style 不需要 poll 中间插值。

### 6.2 TabBar 高度

native-host 的 React 实现里 TabBar 是 `device-shell` 的 flex 兄弟节点，靠 flex
占位（含 `env(safe-area-inset-bottom)` 的安全区留白），不需要同步 CSS 变量。

## 7. 已知 gap / 局限

| Gap | 现状 | 影响 |
| --- | --- | --- |
| `setTabBarStyle({ position })` | 未处理 `position` | simulator 运行时不能动态切换顶部/底部 |
| hover / press 反馈 | React 端没接 `:active` / hover 样式 | 自动化测试无感，肉眼可察 |
| `custom: true`（自定义 tabBar 组件） | 不支持 | simulator 不会挂载业务自定义 TabBar |
| native-host 子栈缓存策略 | 当前无上限，长会话会持有所有 tab 的所有子栈 | 内存压力；如果 simulator 长跑做演示要注意 |

## 参考索引（grep 友好）

| 主题 | 文件 |
| --- | --- |
| `TabBarConfig` / `TabBarItem` 类型 | `packages/dimina-electron-runtime/src/shared/bridge-channels.ts` |
| `TabActionPayload` 协议 | `packages/dimina-electron-runtime/src/shared/bridge-channels.ts` |
| TabBar React 组件 | `packages/dimina-electron-runtime/src/simulator-ui/tab-bar.tsx` |
| `applyTabAction` reducer | `packages/dimina-electron-runtime/src/simulator-ui/tab-bar-state.ts` |
| Main 端分发 TAB_ACTION | `packages/dimina-electron-runtime/src/main/ipc/bridge-router.ts`（`TAB_ACTION_NAMES` / `handleSimulatorApi`） |
| automator wx 执行（service-host） | `src/main/services/automation/handlers/app.ts`（`App.callWxMethod`） |
| e2e 用例 | `packages/dimina-electron-runtime/e2e/native-host-device.spec.ts`、`e2e/native-host-wx-method.spec.ts` |
| reducer 单测 | `packages/dimina-electron-runtime/src/simulator-ui/tab-bar-state.test.ts` |
| upstream `switchTab`（非运行时，仅作行为对照） | `dimina/fe/packages/container-sdk/src/pages/miniApp/miniApp.ts` |

> Bridge Envelope 协议见 [`native-bridge-protocol.md`](./native-bridge-protocol.md)；per-tab 子栈语义见 [`page-stack.md`](./page-stack.md)。
