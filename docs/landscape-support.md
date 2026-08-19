# 横竖屏支持

本文说明 Dimina Kit 模拟器与 Android、iOS、HarmonyOS 原生容器的页面方向行为。上游 SDK 接入方式见 [`dimina/docs/page-orientation.md`](../dimina/docs/page-orientation.md)。当前仅覆盖 WebView 渲染路径。

配置、设备方向与路由入口的覆盖状态见 [`landscape-orientation-matrix.md`](./landscape-orientation-matrix.md)。

## 配置

| 配置 | 位置 | 取值 | 默认 |
| --- | --- | --- | --- |
| `pageOrientation` | `app.json` 的 `window` 段或页面 `.json` | `portrait` / `auto` / `landscape` | `portrait` |

页面合法配置优先于 app 配置；页面没有合法配置时回落到 `app.json.window.pageOrientation`；两级都没有合法值时使用 `portrait`。非法值等同于未配置。

有效方向按以下规则计算：

```text
effective = configured === 'auto' ? deviceOrientation : configured
```

`resizable` 属于 iPad、PC 等可调整窗口大小的设备能力，不在当前支持范围内。

## 窗口尺寸回调

支持以下公开回调：

- `Page.onResize(result)`
- 组件 `pageLifetimes` 里声明的 `resize`
- `wx.onWindowResize(listener)`
- `wx.offWindowResize(listener?)`

回调对象为：

```js
{
  size: { windowWidth, windowHeight },
  deviceOrientation: 'portrait' | 'landscape'
}
```

`wx.offWindowResize()` 传入注册时的同一个函数引用时精确移除该监听；不传参数时移除当前小程序会话通过该 API 注册的全部窗口监听。监听属于小程序会话，不随注册页面卸载。

## 事件派发

宿主在两种时候上报：一是窗口尺寸真的变了（与上一次结算的尺寸比较，相同就不报），二是每次路由落地——后者不看尺寸变没变，落到哪一页就报哪一页。
两条通道的判据都在 service 层，上报在 16ms 窗口内合并结算。

1. `wx.onWindowResize` 会把这次的宽、高、方向和上一次比较，三者都没变就不触发。比较基准由整个小程序共用，不是每页一份；初值为空，所以第一次上报一定会触发一次。
2. 页面的 `onResize` 与组件的 `resize` 只发给这次上报点到的那一页，不因为尺寸和上次相同就跳过。
3. 固定方向页面两条通道一起抑制；`auto` 页面按上面两条判据派发。被抑制的上报仍然推进 app 级基线，
   也仍然刷新 `wx.getWindowInfo` / `getSystemInfoSync` 读到的窗口事实。
4. 隐藏页不接收页面和组件 resize。
5. 页面在结算前隐藏、卸载或重新显示时，旧显示周期登记的 resize 失效。
6. `deviceOrientation` 缺失时按 `windowWidth > windowHeight` 推导。

## 模拟器几何

横屏通过重新计算设备和页面几何实现，不对页面做 CSS 旋转：

- 横屏时交换 `screenWidth` 与 `screenHeight`。
- 手机横屏时状态栏高度为 0。
- 导航栏和 tabBar 高度不随方向变化。
- `windowWidth` 为当前屏幕宽度。
- `windowHeight` 扣除页面实际占用的导航栏、tabBar 和安全区空间。
- `navigationStyle: 'custom'` 时导航栏不占据页面布局空间。
- rpx 按当前窗口宽度换算。

CSS `env(safe-area-inset-*)` 与同步系统信息使用同一份逐页方向几何。不同方向的隐藏 tab 子栈不会覆盖当前页面的安全区状态。

## 原生宿主能力开关

原生页面方向能力默认关闭。旧宿主只升级 SDK 时，不注册方向专用监听、不调用系统方向接口，也不改变原有 resize 生命周期。

显式启用方式：

- Android：`setPageOrientationEnabled(true)`
- iOS：`setup(..., pageOrientationEnabled: true)`
- HarmonyOS：`DMPApp.init(..., { pageOrientationEnabled: true })`

Android 的配置字段不改变既有 data class 构造器；`MiniApp.openApp` 和 `DiminaActivity.launch` 保留原有 JVM 调用形状。

## 路由和几何时序

- 进入固定方向页面时切换到该页方向。
- 返回、重定向、重启或切换 tab 后，以落点页面自己的配置重新计算方向。
- `auto` 页面始终根据当前设备方向计算。
- 页面恢复显示时，目标页面几何先写入 host-env，再派发 `pageShow`。
- TabBar 显隐先发布新窗口几何，再确认 API 调用；一次显隐只发布一次 resize。
- 被新请求替代的异步方向或路由结果通过单调 generation/epoch 失效，不复活旧页面或旧几何。

## 设备方向与退出恢复

`portrait` 和 `landscape` 为固定方向；`auto` 跟随系统允许的方向。模拟器固定方向页面禁用旋转控件；设备方向在小程序会话之间保留。

- Android 的方向请求属于 `DiminaActivity`；Activity 退出后由宿主 Activity 决定方向。
- iOS 小程序页面与宿主共用 `UIWindowScene`；退出后由宿主页面决定方向，不保证恢复进入前的精确横竖方向。
- HarmonyOS 小程序与宿主共用窗口；最后一个小程序退出后请求 `UNSPECIFIED`。宿主此前动态设置的 preferred orientation 无法精确恢复。

## 已知限制

- iOS 当前只支持一个活跃 `UIWindowScene`。
- iOS 无法读取系统旋转锁状态，`auto` 可能根据物理姿态切换方向。
- iOS 宿主必须允许 Portrait、LandscapeLeft、LandscapeRight，并使用 `DMPNavigationController` 或实现 `DMPPageOrientationForwarding`。
- HarmonyOS 宿主外层 `Navigation` 必须使用 `NavigationMode.Stack`。
- 横屏 safe area 会移动到对应屏幕边缘；不同设备形态仍需分别校验。
- `navigateTo` 跨方向时，会话级 host-env 在被盖住页面的 `onHide` 执行前已经切到目标页面几何；目标页面的 `pageShow` 始终读取自己的几何。
- 左右横屏、前后台恢复、进程重建、分屏、折叠屏和 iPad 多任务尚未完整覆盖。

## 当前覆盖状态

模拟器已覆盖配置优先级、冷启动、设备旋转、重复旋转、跨方向路由、Tab 子栈恢复、快速重入、TabBar 显隐几何和页面状态回收。

Android、iOS、HarmonyOS 已覆盖配置解析、窗口方向、resize 与主要路由入口。各端仍需在发布门禁中持续覆盖重复前进/返回、前后台、系统旋转及对应真机设备形态；未覆盖项保持显式标记，不跨端推断。
