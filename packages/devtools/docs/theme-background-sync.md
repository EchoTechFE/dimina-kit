# 主题切换与窗口背景同步

> 关联代码：`src/main/utils/theme.ts`、`src/main/app/app.ts`、`src/main/services/settings/index.ts`

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

## 设计

一个集中式监听器 —— `installThemeBackgroundSync()`（位于 `theme.ts`）：

- 注册**单个** `nativeTheme` 的 `updated` 事件监听器；
- 每次主题变化，遍历 `BrowserWindow.getAllWindows()`，给每个未销毁的窗口
  调用 `setBackgroundColor(themeBg())`；
- 返回一个 `Disposable`，在 `app.ts` 的 `setup()` 里注册一次、交给 `context.registry`
  随生命周期销毁。

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
         ┌─────────────┴──────────────┐
         ▼                            ▼
  Chromium 刷新                 installThemeBackgroundSync
  prefers-color-scheme          的监听器
  → 渲染层 CSS 重绘              → getAllWindows() 逐窗口
   （自动，无需 JS）              setBackgroundColor(themeBg())
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
