# 刘海 / 灵动岛、`env(safe-area-inset-*)` 与 JS `safeArea`（native-host simulator）

simulator 要把选中的设备当真机来模拟，做到三件事：

1. 设备外壳画出**刘海 / 灵动岛**和状态栏（时间、信号、电池），和选中的机型一致。
2. 贴边布局的小程序页面里，CSS `env(safe-area-inset-top|right|bottom|left)` 解析成该机型的真实内边距，吸顶头部、tabBar、action sheet 像真机一样避开刘海和 Home 指示条。
3. JS 侧 `wx.getSystemInfoSync().safeArea` 和 CSS 内边距来自同一份机型数据。

## 单一数据源：`@devicekit/devices` 机型表

机型数据不再写在 devtools 里。`@devicekit/devices` 提供 171 台机型的 `DeviceProfile`，每条带 `os`、`screen`（竖屏尺寸）、`pixelRatio`、`statusBarHeight`、`safeAreaInsets`，横屏机型另带 `safeAreaInsetsLandscape`。刘海/灵动岛不再靠 `notchType` 枚举描述，而是由 `@devicekit/frame` 根据机型名和屏幕类别自己画。

devtools 只用其中几个入口：

| 入口 | 用途 |
|---|---|
| `CLASSIC_DEVICES` | 工具栏设备下拉只列这份精选子集（≤20 台，同一批对象，按 iOS → Android → HarmonyOS 分组） |
| `findDevice(name)` / `DEFAULT_DEVICE` | 按名字回查机型；找不到时回落到默认机型 |
| `resolveDevice` / `statusBarHeightFor` / `safeAreaInsetsFor` | 按当前横竖屏解析出已经旋转过的数值 |
| `PLATFORM_DEFAULTS` | 第一份设备信息到达前，DeviceShell 用平台默认状态栏高度占位 |

## 设备信息流

```
工具栏设备 / 横竖屏选择（renderer，use-device.ts）
  → setNativeDeviceInfo(NativeDeviceInfo)          ipc-schemas.ts 校验
    ├→ bridge 缓存 + DEVICE_CHANGE → simulator WCV（DeviceShell → <device-frame>）
    ├→ safe-area service 对每个 render-host guest 重发 CDP override
    └→ HostEnvUpdate → service-host hostEnvSnapshot（getSystemInfoSync 等同步 API）
```

`NativeDeviceInfo`（`packages/dimina-electron-runtime/src/shared/runtime-types.ts`）里的数值**已经按当前方向解析好**：横屏时 `screenWidth/screenHeight` 已交换，`safeAreaInsets` 是横屏那一组。字段：

- `device`：机型表里的名字，自定义或旧版 payload 没有这项；
- `platform`：`'ios' | 'android' | 'harmony'`，`orientation`：`'portrait' | 'landscape'`；
- `screenWidth`、`screenHeight`、`pixelRatio`、`statusBarHeight`、`safeAreaInsets`。

`deviceInfoToHostEnv`（`packages/dimina-electron-runtime/src/shared/host-env.ts`）是**唯一**从设备数值推导窗口信息的地方，同步 `getSystemInfoSync`、异步 `getSystemInfo`、spawn 时的 host-env 快照和 fe 的 `hostEnvUpdate` 都用它的结果：`windowWidth = screenWidth`、`windowHeight = screenHeight − safeAreaInsets.top − safeAreaInsets.bottom`（与 dimina iOS / Android / Harmony 三端 native 一致）、`screenTop = statusBarHeight`，并透传 `safeAreaInsets`、`deviceOrientation` 和下文的 `safeArea` 矩形。切设备时 bridge 的 `setDevice` 会对每个运行中的小程序发 `hostEnvUpdate` 给 service（fe 的 `host-env.js` 合并快照），所以 `wx.getWindowInfo()` 不重启也跟着变。

## 视觉：状态栏、刘海、Home 指示条

`src/simulator/device-shell/device-shell.tsx` 不再自己画状态栏。它把 `NativeDeviceInfo` 交给 `@devicekit/frame/react` 的 `DeviceFrame`：

- `device` 有名字时按名字取表；没有名字时用 `fallbackProfile()` 把当前方向的数值反算回竖屏 `DeviceProfile`，交给 `deviceProfile` 属性；
- `orientation`、`embedded`、`statusBarTextStyle` 直接透传。状态栏文字颜色由 `MiniAppFrame` 的 `statusBar` render prop 通过 `StatusBarTextStyleBridge` 在 effect 里回传，避免渲染期 setState。

`MiniAppFrame` 只需要知道顶部要让出 `statusBarHeight`（取 `safeAreaInsets.top`）、底部要让出 `bottomInset`（取 `safeAreaInsets.bottom`），刘海、灵动岛和 Home 指示条都由 frame 画。NavigationBar 的平台样式跟随 `device.platform`（iOS 用 iOS 样式，Android/HarmonyOS 用 Android 样式），只有设备到达前回落到 `miniApp.platform`。

外壳几何由 `frameOuterSize(profile, orientation)` 决定（屏幕尺寸 + 2 × 边框），renderer 的面板宽度和自动缩放都从它推导，见 `project-runtime/lib/device-geometry.ts`。

## CSS `env(safe-area-inset-*)` 注入：CDP `Emulation.setSafeAreaInsetsOverride`

`env(safe-area-inset-*)` 由 UA 定义，作者样式改不了，所以走 CDP。`src/main/services/safe-area/index.ts` 在 simulator WCV 的 `did-attach-webview` 时对每个 render-host guest 发 `Emulation.setSafeAreaInsetsOverride`，这是 guest `WebContents` 可用的最早时刻，页面还没绘制。

- `wc.debugger` 会话不归 safe-area 管，走共享的 `CdpSessionBroker`（`src/main/services/cdp-session/index.ts`）。`wc.debugger` 是单 owner API，没有 broker 时多个消费者会互相抢会话。safe-area 每个 guest 拿一个 `CdpSessionLease`，在上面 `send('Emulation.setSafeAreaInsetsOverride', { insets })`。`insets` 带全部 8 个字段（`top/topMax/right/rightMax/bottom/bottomMax/left/leftMax`，base 等于 max），漏掉 `*Max` 会让 `env(safe-area-max-inset-*)` 停在 0。
- 每个 guest 的页面策略（`isTabPage` 来自 URL 的 `isTab=1`，`isCustomNav` 来自 `navStyle=custom`，两者都由 `dmb-resource-url.ts` 按页面的 `windowConfig` 写进 render-host URL）在 `will-attach-webview` 时读出并存下（`parseGuestPageInsetPolicy`）（`did-attach` 时 `getURL()` 还是空），设备切换重发时复用；guest `destroyed` 时清掉。lease 在 broker `onDetach` 时丢弃，下次 override 重新申请。
- **重发时机**：(1) guest attach（页面栈新页面），(2) 设备或横竖屏切换（对所有已 attach 的 guest 重发）。
- **只注入 webview 真正贴着的边**，页面自己的 `env()` padding 不会和外壳已覆盖的区域重复计算（`guestInsets()`）：
  - `top`：自定义导航栏页（`navigationStyle: custom`，页面全出血到屏幕顶部）取设备当前方向的 `safeAreaInsets.top`；默认导航栏页为 0，因为 webview 本来就从外壳导航栏下方开始，三端 native 也是这样。
  - `bottom`：tab 页为 0（外壳 tabBar 的背景延伸到底部内边距，页面内容不贴底）；非 tab 页取 `safeAreaInsets.bottom`（页面全出血到设备底部，自己用 `env(safe-area-inset-bottom)` 避让）。
  - `left` / `right`：直接取设备当前方向的 `safeAreaInsets.left/right`，横屏灵动岛机型不再是 0。
- **`webContents.debugger` 独占**。外部工具（`--remote-debugging-port`）已经 attach 时 `attach()` 会抛错，只记警告、内边距保持 0，没有纯 CSS 回退。

## 底部安全区：一个机制

Home 指示条由 frame 画，是绝对定位的透明覆盖层，不占布局空间。底部安全区由谁填充取决于页面：

- tab 页：外壳 tabBar 的背景延伸过底部内边距（`padding-bottom = safeAreaInsets.bottom`，`tab-bar.tsx`），指示条压在 tabBar 颜色上。
- 非 tab 页：页面 webview 全出血到设备底部，指示条压在页面内容上。

因为 tab 页已经由外壳让出底部，其 `env(safe-area-inset-bottom)` 被覆盖成 0，避免页面重复避让。

## JS `safeArea`

`safeArea` 是屏幕坐标下的矩形，不是内边距，由 `deviceInfoToHostEnv` 生成并随快照下发：

```
left   = insets.left
top    = insets.top
right  = screenWidth  − insets.right
bottom = screenHeight − insets.bottom
width  = right − left
height = windowHeight   （= screenHeight − insets.top − insets.bottom）
```

`src/service-host/sync-impls/system-info.ts` 收到带 `safeArea` 的快照时原样透出，同时输出 `screenTop` 和 `deviceOrientation`；旧版快照没有 `safeArea` 时才退回按 `safeAreaInsets` 或 `statusBarHeight` 自行推导。`wx.getWindowInfo()` 由上游 service 的 `hostEnvResolvers` 从同一份快照挑字段，因此含 `safeArea` 和 `screenTop`。

已知差异：`platform` 对 HarmonyOS 机型给的是 `harmony`，微信和 dimina native 都是 `ohos`。

## 关键文件

| 文件 | 作用 |
|---|---|
| [`@devicekit/devices`](https://www.npmjs.com/package/@devicekit/devices) | 机型表、`CLASSIC_DEVICES`、`resolveDevice` / `statusBarHeightFor` / `safeAreaInsetsFor` |
| [`@devicekit/frame`](https://www.npmjs.com/package/@devicekit/frame) | `<device-frame>`：外壳、状态栏、刘海/灵动岛、Home 指示条、`frameOuterSize` |
| `src/renderer/.../project-runtime/controllers/use-device.ts` | 设备/横竖屏选择 → `NativeDeviceInfo` → `setNativeDeviceInfo` |
| `src/renderer/.../project-runtime/lib/device-geometry.ts` | 由 `frameOuterSize` 推导面板宽度 |
| `src/main/ipc/simulator.ts` | `SetDeviceInfo` → bridge 缓存 → `DEVICE_CHANGE`；`deviceInfoToHostEnv` |
| `packages/dimina-electron-runtime/src/shared/host-env.ts` | `deviceInfoToHostEnv` / `makeHostEnvUpdateMessage`（`NativeDeviceInfo` → `HostEnvSnapshot`） |
| `src/main/services/safe-area/index.ts` | 每个 guest 的 `Emulation.setSafeAreaInsetsOverride`（含 left/right） |
| `src/simulator/device-shell/device-shell.tsx` | 把 `NativeDeviceInfo` 接到 `DeviceFrame` + `MiniAppFrame` |
| `src/service-host/sync-impls/system-info.ts` | `getSystemInfoSync().safeArea` / `deviceOrientation` |
