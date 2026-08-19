# 屏幕方向验收矩阵

本文列出页面方向功能的成员全集、预期行为与当前覆盖状态。每个端、配置和入口独立登记，不使用其他成员的结论代替。

原生端最近一次模拟器验证为 2026-08-19（resize 语义返工后重跑，2026-08-17 那一轮跑的是旧语义、结果已作废）。逐项证据（截图、页面自报几何、logcat/hilog 生命周期序列）：Android 13 项在
`dimina-test/results/android-reverify-20260818/`；iOS 15 项在 `dimina-test/results/ios-matrix-r2c-20260819/`，
另有 iOS 复验在 `ios-reverify-20260818/`；HarmonyOS 的 firstframe / fault-injection / host-handoff 三支在
`dimina-test/results/landscape-rework-20260818/`。汇总判决见该目录的 `RESULTS.md`。
驱动脚本为该仓库的 `scripts/orientation-matrix-{android,ios,harmony}.sh`。物理真机仍未覆盖。
这三支矩阵走的都是方向请求成功的路径；请求被平台拒绝的路径由
`scripts/orientation-fault-injection-harmony.sh` 单独覆盖，见下面的「方向请求失败时的页面可见性」。

## 维度全集

| 维度 | 取值 |
| --- | --- |
| 设备方向 | portrait / landscape |
| app 级 `window.pageOrientation` | 缺省 / portrait / auto / landscape |
| 页面级 `pageOrientation` | 缺省 / portrait / auto / landscape |
| 路由入口 | 冷启动 / navigateTo / navigateBack / redirectTo / switchTab / reLaunch / 退出重开 |
| 页面类型 | 普通页 / tab 页 / tab 子栈内页 |
| 生命周期 | 首次显示 / 隐藏 / 恢复显示 / 卸载 / 前后台 / 进程重建 |
| 窗口变化 | 设备旋转 / TabBar 显隐 / 分屏 / 折叠 / 多任务 |

## 宿主能力开关

原生页面方向能力默认关闭；模拟器产品内默认启用。

| 端 | 默认状态 | 显式启用 | 关闭态行为 | 状态 |
| --- | --- | --- | --- | --- |
| Android | 关闭 | `setPageOrientationEnabled(true)` | 保持原 Activity 方向和 resize 生命周期 | 已覆盖 |
| iOS | 关闭 | `setup(..., pageOrientationEnabled: true)` | 不注册方向监听，不改变窗口方向 | 已覆盖 |
| HarmonyOS | 关闭 | `DMPApp.init(..., { pageOrientationEnabled: true })` | 不注册方向监听，不调用窗口方向接口 | 已覆盖 |
| 模拟器 | 启用 | 无需配置 | 不适用 | 已覆盖 |

Android library manifest 保留原有竖屏策略；显式启用的宿主需要自行覆盖 `DiminaActivity` 的方向与 `configChanges`。

## 配置优先级

页面合法配置优先于 app 合法配置；两级都没有合法值时使用 `portrait`。非法值等同于缺省。

| app 级 \ 页面级 | 缺省 | portrait | auto | landscape |
| --- | --- | --- | --- | --- |
| 缺省 | portrait | portrait | auto | landscape |
| portrait | portrait | portrait | auto | landscape |
| auto | auto | portrait | auto | landscape |
| landscape | landscape | portrait | auto | landscape |

| 配置分支 | 状态 |
| --- | --- |
| 两级缺省回落 portrait | 已覆盖 |
| app 级 portrait / auto / landscape | 已覆盖 |
| 页面级 portrait / auto / landscape | 已覆盖 |
| 页面级固定方向覆盖 app 级固定方向 | 已覆盖 |
| 页面级 auto 覆盖 app 级固定方向 | 已覆盖 |
| 页面非法值回落 app 级 | 已覆盖 |
| app 非法值回落 portrait | 已覆盖 |

## 冷启动与退出

| 设备方向 | 首页有效配置 | 首页显示 | 退出后设备方向 | 状态 |
| --- | --- | --- | --- | --- |
| portrait | portrait | portrait | portrait | 已覆盖 |
| portrait | landscape | landscape | portrait | 已覆盖 |
| portrait | auto | portrait | portrait | 已覆盖 |
| landscape | portrait | portrait | landscape | 已覆盖 |
| landscape | landscape | landscape | landscape | 已覆盖 |
| landscape | auto | landscape | landscape | 已覆盖 |

模拟器的小程序方向不写回设备方向。Android 退出后由宿主 Activity 决定方向；iOS 退出后由宿主页面决定方向；HarmonyOS 最后一个小程序退出后请求 `UNSPECIFIED`。

## 路由入口

每个入口都按落点页面自己的有效配置重新计算方向。

| 入口 | 场景 | 预期 | 模拟器 | Android | iOS | HarmonyOS |
| --- | --- | --- | --- | --- | --- | --- |
| navigateTo | 竖屏页 → 横屏页 | 切到横屏 | 已覆盖 | 已覆盖 | 已覆盖 | 已覆盖 |
| navigateBack(1) | 横屏页 → 竖屏页 | 切回竖屏 | 已覆盖 | 已覆盖 | 已覆盖 | 已覆盖 |
| navigateBack(delta>1) | 跨过不同方向的中间页 | 使用最终落点页方向 | 已覆盖 | 已覆盖 | 已覆盖 | 已覆盖 |
| redirectTo | 跨方向替换栈顶 | 使用新栈顶方向 | 已覆盖 | 已覆盖 | 已覆盖 | 已覆盖 |
| reLaunch | 跨方向清空页面栈 | 使用新根页方向 | 已覆盖 | 已覆盖 | 已覆盖 | 已覆盖 |
| switchTab | 切到未访问 tab | 使用目标 tab 配置 | 已覆盖 | 已覆盖 | 已覆盖 | **未验证** |
| switchTab | 恢复缓存 tab 子栈 | 使用恢复后栈顶页配置 | 已覆盖 | 已覆盖 | 已覆盖 | **未验证** |
| 重复进入和返回 | 同一路径执行两轮以上 | 每轮方向一致且状态不残留 | 已覆盖 | 已覆盖 | 已覆盖 | 已覆盖 |

**switchTab 这两行此前是错标的**：真机探针用的 `fe/example/base/app.json` 里根本没有 `tabBar`，
宿主判不出目标是 tab 页，那几步实际执行的是 `navigateTo` / `navigateBack`（容器日志里能直接看到发出的是
`{"name":"navigateTo"}`）。Android 与 iOS 已分别由 `orientation-matrix-android-prepare.sh` 的 `WITH_TABBAR=1`
和 `orientation-matrix-ios-prepare.sh` 注入纯文字 tabBar 后重跑坐实；HarmonyOS 尚未补同样的准备步骤，
在补上之前这两行按**未验证**记。

几何上报与 `pageShow` 的先后**逐端不同，且是刻意的**：三端 native 在 `pageShow` **之后**上报（几何取自当时活的
窗口，pageShow 之前它还是上一页的），kit 模拟器在 `pageShow` **之前**发布（它的 `getSystemInfoSync` 读主进程
缓存的 hostEnv 快照，必须先写进去 `onShow` 才读得到落点页尺寸）。service 因此不要求登记收件人时该页已经 show。
被替换或清除的页面不会在后续返回操作中复活。

## 设备旋转

| 场景 | 预期 | 模拟器 | Android | iOS | HarmonyOS |
| --- | --- | --- | --- | --- | --- |
| auto 页旋转一次 | 跟随设备并派发一次 resize | 已覆盖 | 已覆盖 | 部分覆盖 | 部分覆盖 |
| auto 页连续旋转 | 每次变化独立结算 | 已覆盖 | 已覆盖 | 部分覆盖 | 部分覆盖 |
| 固定页旋转设备 | 页面保持固定方向且不派发 resize | 已覆盖 | 已覆盖 | 部分覆盖 | 部分覆盖 |
| 固定页期间设备方向变化后返回 auto 页 | auto 页使用当前设备方向 | 已覆盖 | 已覆盖 | 部分覆盖 | 部分覆盖 |
| 系统旋转锁关闭自动旋转 | auto 尊重系统策略，固定方向仍生效 | 不适用 | 已覆盖 | 未完整覆盖 | 未完整覆盖 |
| landscapeLeft ↔ landscapeRight | 几何和安全区保持正确 | 未覆盖 | 未覆盖 | 未覆盖 | 未覆盖 |

iOS 无法读取系统旋转锁状态；当前 `auto` 可能根据物理姿态切换方向。

## resize 回调

| 场景 | 预期 | 状态 |
| --- | --- | --- |
| auto 页窗口几何变化 | `Page.onResize` 和组件 `resize` 各派发一次 | 已覆盖 |
| app 级窗口基线变化 | `wx.onWindowResize` 派发一次 | 已覆盖 |
| 几何重复 | 页面通道可按宿主上报派发，窗口通道不重复派发 | 已覆盖 |
| 固定方向页设备旋转 | 页面和窗口通道都保持沉默 | 已覆盖 |
| 16ms 内连续上报 | 合并并使用最后一份几何 | 已覆盖 |
| resize 结算前页面隐藏或卸载 | 不派发给旧页面 | 已覆盖 |
| resize 结算前 hide → show | 旧 generation 失效；只有新上报可进入新显示周期 | 已覆盖 |
| `offWindowResize(listener)` | 精确移除同一函数引用 | 已覆盖 |
| `offWindowResize()` | 清空当前会话的窗口监听 | 已覆盖 |
| 页面卸载 | app 级窗口监听保持有效 | 已覆盖 |
| 页面隐藏期间窗口方向变化后返回 | 见下表：能押后 pageShow 的页面只看到最终几何、不补发 resize；押不了的页面必须补发一次 | HarmonyOS 两条分支各有红绿探针；Android 与 iOS 仅代码级 |
| 同一份几何被宿主重复上报 | 窗口几何变化这条路径会与上次结算的几何比较，相同就不再上报；路由落地这条路径不做比较，每次都上报当前页 | HarmonyOS 已覆盖（红绿）；Android 由 `WindowGeometryLedger` 承担（`decide` 纯判定，基线只经 `record` 推进）；iOS 只在真实旋转上报 |

## TabBar 与页面几何

| 场景 | 预期 | 状态 |
| --- | --- | --- |
| tab 页显示 TabBar | `windowHeight` 扣除 TabBar 占用空间 | 模拟器已覆盖；Android 成立，iOS 和 HarmonyOS 不成立 |
| `hideTabBar` | ack 前发布增大的窗口高度 | 已覆盖 |
| `showTabBar` | ack 前发布缩小的窗口高度 | 已覆盖 |
| 单次显隐 | 只发布一次 resize | 已覆盖 |
| 修改文字、图标或角标 | 不改变页面窗口高度 | 已覆盖 |
| 横屏 tab 子栈切换 | 安全区、方向和窗口高度属于当前栈顶页 | 已覆盖 |

## 时序与状态回收

| 场景 | 预期 | 状态 |
| --- | --- | --- |
| navigateTo 尚未完成时 navigateBack | 最终栈和方向收敛，不留孤儿页 | 已覆盖 |
| 快速连续 navigateTo / navigateBack | 按调度顺序提交，迟到结果失效 | 已覆盖 |
| 页面恢复显示 | resize 早于 `pageShow` | 已覆盖 |
| 方向请求被后续页面替代 | 旧 generation 不产生副作用 | 已覆盖 |
| 方向请求被平台拒绝 | 页面可见性不依赖请求成败，pageShow 仍放行 | 见下表逐端登记 |
| 方向请求被受理但窗口方向已经是目标值 | 不会有几何事件，pageShow 由请求返回后重取判据放行 | HarmonyOS 已修（代码级）；Android/iOS 判据只读已生效事实，不适用 |
| 方向请求被受理但窗口自始至终不转 | 无解信号，pageShow 会挂起 | **未覆盖**：三端都只能靠超时兜底，本轮不引入 |
| 页面反复打开和关闭 | 方向状态数量与存活页面数量一致 | 已覆盖 |
| tab 子栈反复切换 | 缓存页不重复登记，也不误释放 | 已覆盖 |
| 会话销毁 | 清理窗口监听、页面方向状态和待处理请求 | 已覆盖 |

## 方向请求失败时的页面可见性

押后的 pageShow 必须由某个一定会到来的事实放行。平台请求被拒绝时窗口不会变化，等待窗口回调就是
永久挂起，所以每一端都要各自登记它靠什么收敛。

| 端 | 押后判据 | 请求被拒时的兜底 | 覆盖 |
| --- | --- | --- | --- |
| HarmonyOS | `requestsNewOrientation`（有没有正在飞的请求） | `DMPPageLifecycle.onShow` 在请求结局上自行放行 | 故障注入已覆盖（`dimina-test/results/landscape-fix-verify-20260817/harmony-fault-injection/`，红绿双向）；单测只覆盖到 `settleOrientationRequest` 纯函数，编排层未覆盖 |
| iOS | 页面声明的方向 mask 与实际窗口尺寸不一致 | `handleGeometryUpdateFailure` 释放挂起的 pageShow | 单测覆盖 `shouldReleasePageShowAfterOrientationFailure`；未做故障注入 |
| Android | 已生效的 `deviceOrientation` 与实际布局长宽关系不一致 | 不适用：判据只读已生效的事实，不依赖飞行中的请求 | — |

HarmonyOS 的判据依赖请求本身，这正是它需要显式兜底、而 Android 不需要的原因。

## 返回页的几何：pageShow 结算还是补发 resize

微信的语义是：隐藏期间的窗口变化不给隐藏页补发 `Page.onResize`，返回页的几何在 `pageShow` 结算。
能不能做到这一点，取决于容器**能不能证明窗口接下来一定会变**——只有能证明时才敢把 pageShow 押到几何落地。

| 端 / 页面类型 | 能否证明窗口会变 | pageShow 时机 | 返回时是否补发 resize |
| --- | --- | --- | --- |
| Android 全屏 | 能：判据只读已经布局出来的几何 | 几何落地后 | 否 |
| Android 多窗口（分屏 / 自由窗口 / 画中画） | **不能**：系统忽略 `setRequestedOrientation` | 立即 | **是** |
| iOS（全部） | 能：页面方向 mask 与窗口尺寸比对 | 几何落地后 | 否 |
| HarmonyOS 固定方向页（全屏窗口） | 能：目标方向 ≠ 当前 `deviceOrientation` | 几何落地后 | 否 |
| HarmonyOS auto 页 | **不能**：auto 请求的是「跟随传感器」，容器读不到设备姿态 | 立即（否则可能永远等不到几何事件） | **是** |
| HarmonyOS 非全屏窗口 | **不能**：`getWindowStatus()` 不是 `FULL_SCREEN` 时窗口不跟方向请求转；读不到窗口状态同样按不能算 | 立即 | **是** |

「不能证明」的那几行不是跨端偏差而是同一条判据的必然分岔：押后 pageShow 的前提是容器能**证明**窗口接下来一定会变，
证明不了就不押后。代价是 JS `onShow` 读到那一刻仍未转过来的几何（HarmonyOS auto 页真机实测 `w=816 h=349`），
窗口转到位后由补发的 `onResize` 纠正；反过来押错了则是 pageShow 永远没有放行者。
iOS 另有一条兜底：方向请求被平台拒绝时释放挂起的 pageShow 并补报一次当前几何。
判据与取证以 `dimina-test/results/landscape-rework-20260818/RESULTS.md` 为准（resize 语义返工后的那一轮）；
更早的 `landscape-fix-verify-20260817/RESULTS.md` F3/F4/F5 一节记录了押后判据的原始取证，
其中关于「相同几何要不要重复上报」的结论已被返工推翻。

## 已知跨端偏差

| 项 | Android | iOS | HarmonyOS | 说明 |
| --- | --- | --- | --- | --- |
| tab 页 `windowHeight` 扣除 TabBar | 成立 | 不成立 | 不成立 | iOS `DMPUIManager`、HarmonyOS `DMPDeviceUtils.buildMetrics` 都按窗口高减安全区计算，没有 TabBar 项；与微信的实测比对尚未做 |

## 原生平台约束

| 平台 | 当前约束 |
| --- | --- |
| Android | 宿主必须覆盖 `DiminaActivity` manifest 配置；非 tab 页面由独立 Activity 承载 |
| iOS | 只支持一个活跃 `UIWindowScene`；宿主必须转发页面方向 mask |
| HarmonyOS | 外层 `Navigation` 必须使用 `NavigationMode.Stack`；退出只能恢复为 `UNSPECIFIED` |

## 尚未完整覆盖

| 维度 | Android | iOS | HarmonyOS | 模拟器 |
| --- | --- | --- | --- | --- |
| 物理真机完整路由矩阵 | 未完整覆盖 | 未完整覆盖 | 未完整覆盖 | 不适用 |
| 左右横屏安全区 | 未覆盖 | 未覆盖 | 未覆盖 | 仅对称模型 |
| 前后台期间旋转 | 未完整覆盖 | 未完整覆盖 | 未完整覆盖 | 不适用 |
| 进程或页面容器重建 | 未完整覆盖 | 未完整覆盖 | 未完整覆盖 | 未完整覆盖 |
| 分屏和自由窗口 | 未覆盖 | 未覆盖 | 未覆盖 | 未覆盖 |
| 折叠屏展开与合拢 | 未覆盖 | 不适用 | 未覆盖 | 未覆盖 |
| iPad 多任务 | 不适用 | 未覆盖 | 不适用 | 未覆盖 |

未覆盖成员保持显式标记，不由其他平台、入口或设备形态的状态推断。
