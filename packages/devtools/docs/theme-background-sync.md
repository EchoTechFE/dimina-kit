# 主题切换与窗口背景同步

> 关联代码：`src/main/utils/theme.ts`、`src/main/services/settings/index.ts`、
> `src/main/services/views/native-simulator-view.ts`、
> `src/main/services/views/workbench-view.ts`。

## 为什么需要主进程同步

renderer 的 CSS 会随 `prefers-color-scheme` 重绘，但 CSS 管不到 Electron
`BrowserWindow.backgroundColor`。窗口创建时的 `backgroundColor` 只提供首屏值；
主题变化后必须调用 `setBackgroundColor()`，否则原生 chrome 与网页交界处可能露出旧底色。

`applyTheme(theme)` 只负责设置 `nativeTheme.themeSource`
（`packages/devtools/src/main/services/settings/index.ts:109-119`）。
随后的 `nativeTheme.updated` 由各 surface owner 处理。

## BrowserWindow

`installThemeBackgroundSync()` 注册一个进程级 listener。每次主题变化：

1. 计算 `themeBg()`；
2. 遍历 `BrowserWindow.getAllWindows()`；
3. 跳过已销毁窗口；
4. 调 `win.setBackgroundColor(bg)`；
5. 向窗口 renderer 发送 `WorkbenchSettingsChannel.ThemeChanged`。

依据：`packages/devtools/src/main/utils/theme.ts:66-88`。listener 返回
`Disposable`，由 app context registry 统一销毁
（`packages/devtools/src/main/app/app.ts:505-509`）。

`ThemeChanged` 是 main renderer 的通用 JS 主题通知。VS Code editor 不在主 renderer
里，不能靠这条广播同步。

## simulator WebContentsView

simulator 是顶层 `WebContentsView`，不在
`BrowserWindow.getAllWindows()` 结果中。`native-simulator-view.ts` 因而在创建时
调用 `setBackgroundColor(simDeskBg())`，并单独订阅
`nativeTheme.updated`。listener 归该 simulator WebContents connection 所有，view
销毁时自动移除
（`packages/devtools/src/main/services/views/native-simulator-view.ts:254-286`）。

`simDeskBg()` 必须与 renderer 的 simulator desk 色保持一致，避免 resize 时露出不同颜色。

## VS Code workbench WebContentsView

workbench 也是顶层 WCV，由自己的 owner 同步两层颜色：

- WCV native surface：创建时和每次主题变化调用
  `workbenchView.setBackgroundColor(themeBg())`；
- 工作台网页：首次 load 用 `index.html?theme=<light|dark>`，运行时通过
  `executeJavaScript` 调 `window.__WB_SET_THEME(...)`。

依据：`packages/devtools/src/main/services/views/workbench-view.ts:57-79`、
`packages/devtools/src/main/services/views/workbench-view.ts:82-125`。
工作台完成 boot 后安装 `__WB_SET_THEME`
（`packages/workbench/src/main.ts:148-160`）。

workbench listener 只在 WCV 存活期间注册，并在 `detachWorkbench` 中移除
（`packages/devtools/src/main/services/views/workbench-view.ts:184-192`）。

## 数据流

```
设置面板 SetTheme
  -> applyTheme(theme)
  -> nativeTheme.updated
     -> installThemeBackgroundSync
        -> 所有 BrowserWindow.setBackgroundColor
        -> main renderer ThemeChanged
     -> native-simulator-view
        -> simulator WCV.setBackgroundColor
     -> workbench-view
        -> workbench WCV.setBackgroundColor
        -> window.__WB_SET_THEME
```

## 平台限制

应用内显式切换由 `nativeTheme.themeSource` 驱动，代码路径在各平台相同。

> 未验证：Electron issue
> [#48736](https://github.com/electron/electron/issues/48736) 所述的部分 Linux
> compositor 系统主题跟随问题是否仍存在。仓库代码只能确认应用内切换路径，不能证明
> 当前 Electron/Chromium 上游状态。
