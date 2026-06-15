# 主题切换与窗口背景同步

> 关联代码：`src/main/utils/theme.ts`、`src/main/app/app.ts`、`src/main/services/settings/index.ts`、`src/main/services/views/view-manager.ts`、`src/renderer/modules/main/features/monaco-editor/hooks/useMonacoEditor.ts`

## 这个文档解决什么

DevTools 支持浅色 / 深色 / 跟随系统三种主题。这里记录一个**容易被忽略的细节**：
切换主题时，原生窗口的背景色（`BrowserWindow` 的 `backgroundColor`）需要被显式同步，
否则会在 Windows / Linux 上露出一条旧主题色的发丝线。

## 问题

Electron 窗口的 `backgroundColor` **只在创建时取一次值，之后永久冻结**。

它负责的是「原生窗口区域中、还没被网页内容覆盖的部分」的底色 —— 比如原生菜单栏与
WebContents 之间的接缝。主题切换后：

- 网页内容会重绘（见下方「为什么 CSS 不够」），
- 但窗口 `backgroundColor` 仍是旧主题色。

于是在原生 chrome 与网页的交界处露出旧底色：

| 平台 | 表现 |
| --- | --- |
| Windows | 深色模式下，原生菜单栏与网页之间出现一条浅色（`#fafafa`）发丝线 |
| Linux | 同 Windows（GTK 同样是窗口内菜单栏），属同一缺陷 |
| macOS | 不显形（全局菜单栏，无窗口内菜单/内容接缝）；仅潜在表现为 resize 时闪一下旧色 |

这是一个**跨平台缺陷**，只是在 Windows 上最显形 —— 修复因此也不做平台分支。

## 为什么 CSS 不够

渲染层主题完全由 CSS `@media (prefers-color-scheme)` 驱动（见 `src/renderer/design.css`）。
`nativeTheme.themeSource` 一变，Chromium 会同步刷新该媒体查询，网页内容立即重绘。

但 `prefers-color-scheme` **只管网页内容，管不到原生窗口的 `backgroundColor`**。
Electron 官方 Dark Mode 教程也只演示 CSS 方案，未覆盖这一层 —— 这正是缺陷的来源。
原生窗口底色只能用 `win.setBackgroundColor()` 手动更新。

### 还有一类「CSS 管不到」：渲染层里用 JS 定主题的组件

CSS 媒体查询会随 `themeSource` 自动重算，但**用 JS API 设主题的组件不会**——
典型是 Monaco 编辑器（`monaco.editor.setTheme(...)`）。它在挂载时按当前色调应用一次，
之后需要一个事件来重新应用。

直觉做法是在渲染层监听 `window.matchMedia('(prefers-color-scheme: dark)')` 的 `change`
事件——**但这条路对应用内切换无效**：Electron / Chromium 在**代码显式赋值
`nativeTheme.themeSource`** 时，会更新 `matchMedia(...).matches` 的值并重算 CSS，
**却不派发该 `MediaQueryList` 的 `change` 事件**（只有真·操作系统级主题变化才派发）。
所以渲染层拿不到 JS 信号。

解决办法：让 main 在它本来就有的 `nativeTheme 'updated'` 处**主动广播**给渲染层。
`installThemeBackgroundSync()` 在同步窗口底色的同一轮里，向每个存活窗口
`webContents.send(WorkbenchSettingsChannel.ThemeChanged, isDark)`；渲染层用
`onThemeChanged(isDark => applyMonacoTheme(isDark))`（`shared/api/settings-api.ts`）订阅，
Monaco 编辑器在 `useMonacoEditor` 里据此重应用主题。这条广播覆盖「应用内切换」与
「macOS/Windows 的系统主题变化」；仅 Linux + 跟随系统 + OS 改主题这一路径失效，
与下方窗口底色的已知限制同源。

## 设计

一个集中式监听器 —— `installThemeBackgroundSync()`（位于 `theme.ts`）：

- 注册**单个** `nativeTheme` 的 `updated` 事件监听器；
- 每次主题变化，遍历 `BrowserWindow.getAllWindows()`，给每个未销毁的窗口
  调用 `setBackgroundColor(themeBg())`，**并** `webContents.send(ThemeChanged, isDark)`
  广播给渲染层（见上节，供 Monaco 等 JS 消费者重应用主题）；
- 返回一个 `Disposable`，在 `app.ts` 的 `setup()` 里注册一次、交给 `context.registry`
  随生命周期销毁。

### `WebContentsView` 不在覆盖范围内 —— 模拟器 desk 单独同步

集中式监听器只遍历 `BrowserWindow`。模拟器是一个**顶层 `WebContentsView`**（非窗口），
它的 `backgroundColor`（手机背后那块 desk 底）同样会被创建时冻结。`view-manager.ts` 的
`attachNativeSimulator` 因此就近用同一套机制补一份：创建时
`setBackgroundColor(simDeskBg())`，并自己订阅 `nativeTheme 'updated'` 重刷，监听器由该
WebContents 的 connection 持有、随视图销毁自动摘除。`simDeskBg()`（深 `#121212` /
浅 `#e8e8e8`）必须与渲染层 `--color-sim-bg` 和模拟器页 `.device-shell-root` 保持一致——
三层是同色，才能让高度 resize 跟随时不露出错色条。

窗口创建时仍传 `backgroundColor: themeBg()` 作为初始值，避免创建瞬间闪白；
此后的每次变化都由这个监听器接管。

选择集中式（而非每个窗口各自注册）的原因：只有一个 `nativeTheme` 监听器、
新增窗口零成本自动覆盖、不会因为漏写而退化。

### 数据流

```
用户在设置面板切换主题
        │
        ▼
  SetTheme IPC ──▶ applyTheme(theme)
                       │   nativeTheme.themeSource = theme
                       ▼
                 nativeTheme 触发 'updated'
                       │
     ┌─────────────────┼────────────────────────────┐
     ▼                 ▼                            ▼
Chromium 刷新     installThemeBackgroundSync   view-manager 的
prefers-color-     的监听器                     模拟器 desk 监听器
scheme            ├─ getAllWindows() 逐窗口      → setBackgroundColor(
→ 渲染层 CSS 重绘  │   setBackgroundColor(themeBg())   simDeskBg())
 （自动，无需 JS）  └─ webContents.send(
                       ThemeChanged, isDark)
                       → 渲染层 onThemeChanged
                       → Monaco 重应用主题
```

## 已知限制

在 Linux 上，`updated` 事件**不会**因「操作系统级」的主题切换而触发
（[electron/electron#25925](https://github.com/electron/electron/issues/25925)），
只对代码里显式赋值 `nativeTheme.themeSource` 触发。

影响范围：

- **应用内切换主题**（设置面板选浅色/深色）走 `applyTheme()` 的显式赋值，
  在所有平台（含 Linux）都正常 —— 不受此限制影响。
- 仅「主题设为『跟随系统』+ 用户在 Linux 上改了操作系统主题」这一条路径会失效。
  且这是 Electron 上游限制：此时连渲染层的 `prefers-color-scheme` 都不会更新，
  整个应用都不响应 —— 不是窗口背景这一层能解决的问题。
