# devtools 内置编辑器集成（Monaco）

> 编辑器是 **renderer 内嵌的 Monaco 组件**，作为项目窗口 dockable 布局里的一个 DOM 面板。
> 配套文档：[`project-window-layout.md`](./project-window-layout.md) —— editor 是 `<DockView>` 渲染的七个 dock 面板之一（simulator / **editor** / wxml / appdata / storage / console / compile）。

## 摘要（TL;DR）

dimina-kit devtools 的代码编辑器是 **Monaco**（VS Code 的编辑器组件），作为一个普通 React 组件直接挂在主 renderer 里，是 dockable 布局里的一个 DOM 面板（用户可拖拽 re-dock）。它读写当前活跃 dimina 项目的文件（经沙盒化的 `project:fs:*` IPC），提供 wxml/wxss 语法高亮 + wxml 补全/悬浮 + 主题同步 + 自动保存（debounce）与保存状态指示。

Monaco 由 vite 和其余 renderer 代码一起打包：没有独立 `WebContentsView` overlay、没有自定义 protocol、没有 Web Worker 扩展宿主。devtools 定位是**可被 host 嵌入的、以 simulator+调试为中心的轻量 SDK**，编辑器只需"好用的代码编辑 + wxml 智能"，Monaco 正是这个尺寸的原语。

## 1. 架构总览

```
┌──────────────────── Electron 主进程 ────────────────────────────────┐
│  app/app.ts setup():                                                │
│    registerProjectFsIpc(ctx)   ← project:fs:* 沙盒 IPC（读写活跃项目） │
│  services/views/view-manager.ts                                     │
│    setSimulatorDevtoolsBounds  ← Console DevTools overlay（仍是 overlay）│
│    （editor 已不在这里——它是 renderer 组件，非 overlay）             │
└────────────────────────────────────────────────────────────────────┘
        ▲ project:fs:readFile/writeFile/listFiles/getRoot（invoke）
        │  ctx.senderPolicy（主窗口可信）+ enforceWithinProjectRoot 沙盒
┌──────────────────── 主 renderer（React）────────────────────────────┐
│  project-runtime.tsx → <DockView> → editor DOM 面板渲染：            │
│    renderDomPanel('editor') → <MonacoEditor projectPath={...} />    │
│  features/monaco-editor/                                            │
│    components/MonacoEditor.tsx   文件树 + 编辑器 split，开/存文件     │
│    components/FileTree.tsx       由扁平路径列表构建的折叠树           │
│    hooks/useMonacoEditor.ts      editor 实例生命周期 + per-file model │
│    monaco-env.ts                 vite `?worker` 接 monaco 语言 worker │
│    language/register.ts          注册 wxml(Monarch) + wxss→css        │
│    language/wxml-monarch.ts      wxml Monarch tokenizer + 语言配置    │
│    language/wxml-lsp.ts          wxml completion/hover providers      │
│    language/wxml-data.ts         tag/attr/枚举值 元数据               │
│    theme.ts                      dimina light/dark → monaco setTheme  │
│    services/file-service.ts      project:fs:* 的 renderer 封装        │
└────────────────────────────────────────────────────────────────────┘
```

编辑器不涉及：自定义 protocol、独立窗口 / WebContentsView overlay、Web Worker 扩展宿主、editor preload bridge、单独的静态产物、webpack 构建。Monaco 由 vite 和其余 renderer 代码一起打包。

## 2. 编辑器组件（`features/monaco-editor/`）

### 2.1 MonacoEditor.tsx
editor cell 的内容：左侧 `FileTree`(上方一行显示项目名 / hover 全路径 / 保存状态)+ 右侧 Monaco 编辑器。根 div 带 `data-area="editor"`（布局/测试据此定位）。

- root 直接用 `projectPath` prop(renderer 已知活跃项目),**不走 `project:fs:getRoot` IPC**——后者在主进程刚打开项目、活跃路径未注册的窗口里会瞬时返回 `''`,导致文件树永久空(已修)。`listFiles` 带重试(≤12 次×300ms)骑过同一窗口(沙盒在 `ENOACTIVE` 时被 `listProjectFiles` 吞成 `[]`)。
- 点击文件 → `readFile` → `useMonacoEditor.openModel(absPath, content, language)`,切文件前先 `flushPendingSave` 把待存改动落盘。
- 编辑内容 → debounce 500ms → `writeFile` 持久化（`SAVE_DEBOUNCE_MS = 500`）。切文件 / 组件卸载会 flush 未到点的 pending 写；**项目关闭/切换**瞬间的 flush 也不丢——主进程 `writeFile` 用 last-closed root 兜底（见 §3）。窗口整体关闭/应用退出再挂 `beforeunload` flush，且走**同步**写 `writeProjectFileSync`（`project:fs:writeFileSync`，`sendSync` 阻塞页面销毁直到字节落盘）——硬退出时不再丢失防抖窗口内的最后一笔编辑。（常见路径仍走上面的异步卸载 flush，renderer 存活、无需阻塞。）
- 进项目自动打开入口文件（`app.json` / `app.js` / `app.ts` / `app.wxss` 优先，否则第一个文件）；自动打开走的 `readFile` 带重试(`OPEN_RETRY_ATTEMPTS=12` × `OPEN_RETRY_DELAY_MS=300`),**只重试瞬态的 `ENOACTIVE`**(活跃项目尚未注册)——`ENOENT`/`EACCES`/`EINVAL` 立即抛出,所以手动点缺失/禁止的文件不会卡;读到内容立即返回,故正常点文件无延迟。随后在 Monaco 实例 `ready()` 前再等(同 budget),骑过冷启动竞态。重试期间若 `openSeq` 或 root 变化即放弃(见 `services/retry.ts`)。

> 注:`project:fs:getRoot` 通道仍保留(见 §3,可独立查活跃 root),只是 MonacoEditor 取 root 改用 prop。

#### 保存状态指示器
自动保存对用户不可见,所以 `MonacoEditor` 维护一个 `SaveStatus`(`idle | dirty | saving | saved | error`)并在文件树头部右侧渲染(`data-testid="save-status"`):

| 状态 | 文案 | 触发 |
|---|---|---|
| `dirty` | 编辑中… | 内容改动,debounce 计时中 |
| `saving` | 保存中… | `writeFile` in-flight |
| `saved` | 已保存 | 写成功 |
| `error` | 保存失败 | 写失败(同时 `console.warn`) |

指示器**只观测、不改写保存时序**;且状态更新经 `setStatusFor(rel, ...)` 守卫——只有当描述的文件仍是当前打开文件时才落地,避免切文件后迟到的 success/error 把"已保存"盖到新文件上。

### 2.2 useMonacoEditor.ts
绑定一个 Monaco 实例到容器 ref：mount 时 `installMonacoEnvironment()` + `ensureDiminaLanguages()` + `applyMonacoTheme()` + `monaco.editor.create`；per-file model 缓存（`monaco.Uri.file(absPath)`），切文件复用 model 保留 undo/视图状态；unmount 释放 editor + models。

### 2.3 monaco-env.ts（vite worker 接线，关键）
Monaco 把语言服务（css/json/ts/html 校验+补全）放在 web worker。`self.MonacoEnvironment.getWorker` 必须在 `monaco.editor.create` 前设置；用 vite 的 `?worker` import（`monaco-editor/esm/vs/.../*.worker?worker`）把每个 worker 编译成独立 chunk（Electron file:// 下可用，因 vite 产出真实 worker chunk 而非 CDN 引用）。构建验证：`dist/renderer/assets/{editor,css,json,ts,html}.worker-*.js` 均产出。
> 顶部 `/// <reference types="vite/client" />` 声明 `*?worker` 模块，保证 `tsc` 通过。

## 3. 文件访问：`project:fs:*`（沙盒）

`src/main/ipc/project-fs.ts`：

| Channel | 入参 | 出参 |
|---|---|---|
| `project:fs:getRoot` | `()` | 活跃项目绝对路径，无项目时 `''` |
| `project:fs:readFile` | `[absPath]` | utf-8 内容 |
| `project:fs:writeFile` | `[absPath, content]` | void（父目录自动 mkdir -p）|
| `project:fs:writeFileSync` | `[absPath, content]` | `{ ok, code?, message? }`（同步阻塞写，**同一沙盒**；仅 editor beforeunload flush 用，经 `IpcRegistry.handleSync` + `sendSync`）|
| `project:fs:listFiles` | `[rootAbsPath]` | POSIX 相对路径数组（跳过 node_modules/.git/dist…，cap 5000）|

- **沙盒（多道关，含 symlink 加固）**：
  - **词法关** `enforceWithinProjectRoot(abs, root)` —— 双侧 `path.resolve` + 容器检查（`root + path.sep` 防 `/foo/bar` ⊂ `/foo/bar2`）；无项目抛 `ENOACTIVE`、空路径 / 含 NUL 字节抛 `EINVAL`、词法越界（`..`）抛 `EACCES`。这是不碰 fs 的廉价首关。
  - **realpath 关** `resolveWithinProjectRoot` —— 词法关通过后，对 root 与目标**双侧 `fs.realpath`** 再查一次容器关系，堵死 symlink 逃逸（root 内一个指向外部的软链 `proj/link -> ../secret` 解析后落在 root 外 → `EACCES`）。目标尚不存在（首次写）时改 realpath 其父目录再拼 basename。
  - **写前祖先关** `assertWritableAncestor` —— 写入在 `mkdir` **之前**，从写目标向上找到最深的已存在祖先目录、`fs.realpath` 后校验仍在 root 内。这堵死 `mkdir -p` 副作用泄漏：若 `proj/escape -> /outside`，仅靠词法关会让 `mkdir -p proj/escape/new` 跟着软链在沙盒外建目录、再被事后检查拒绝；先校验最深祖先则零 mkdir 直接拒。合法深写（`proj/a/b/c.txt`，`a`/`b` 未建）向上走到 root 本身、通过，照常 `mkdir -p` 建 in-root 中间目录。
  - **TOCTOU 关（两层纵深防御）**：
    - **`O_NOFOLLOW`（最终组件）** —— `readFile`/`writeFile` 对已 realpath 解析的路径以 `fs.open(..., O_NOFOLLOW)` 打开、并对返回的 `FileHandle` 读写（不再按路径名二次打开、`finally` 必 close）。挡住"realpath 校验 → open 之间，**最终组件**被换成 symlink"的竞态；对**已存在**的 symlink 无行为影响（realpath 在 open 前已解析，in-root symlink 仍被跟随，out-of-root 已在 realpath 关被拒）。
    - **open 后复检（中段组件）** —— open 之后、返回字节(读)/写入(写)**之前**，对解析路径再 `fs.realpath` + 容器复检（`assertOpenedWithinRoot`）。`O_NOFOLLOW` 只保护最终组件,中段父目录在同一窗口被换成 symlink 仍会被跟随——复检捕获它并拒（`EACCES`）。`writeFile` 据此以 `O_CREAT` 但**不带 `O_TRUNC`** 打开,复检通过后才 `write@0 + truncate`,故被检出的 race 绝不写入越界内容(最坏在越界位置留一个 `O_CREAT` 建的零字节文件)。
    - **残留**：仅"软链只在 open 期间在位、复检前又换回"的完美时序 double-swap 能规避;可证明地关闭它需 `openat`/`F_GETPATH` 级逐段解析(可移植 Node 无),dev-tool 威胁模型下已接受(主窗口本就可信、无对手竞速本地 FS)。
  - 活跃 root 每次调用从 `ctx.workspace.getProjectPath()` 现取（项目切换即时生效）。**`writeFile` 例外**：额外接受"刚关闭项目的 root"——`pickWriteRoot(absPath, { current, lastClosed })` 在 current / `workspace.lastClosedProjectPath`（关项目时记录、开下一项目时清零，永不累积）中选包含该路径的 root、优先 current。这样项目**关闭/切换的瞬间**、组件卸载时 flush 的 in-flight 写（其路径属刚关项目，而 current root 已被 `closeProject` 清空）不会丢失。选中 last-closed 后仍走上面全部沙盒关（`..`/symlink/`mkdir` 侧信道照拒），边界不放松；`readFile`/`listFiles` 不扩展，读取面只认 current。
  - **同步写镜像** `writeFileSync`（+ `resolveWithinProjectRootSync` / `assertWritableAncestorSync` / `assertOpenedWithinRootSync`）—— 为 editor 的 `beforeunload` 同步 flush 提供与异步 `writeFile` **逐行等价**的沙盒(复用同一批纯词法 helper,只 fs 调用换 sync)。两条路径必须保持锁步,任何偏差都会重开同步路径上的逃逸口(已有 async≡sync 的 parity 测试钉死)。
- **sender policy**：用标准 `ctx.senderPolicy`（主窗口可信）。Monaco 在主 renderer，无需独立 view 的 allow-list。同步通道经 `IpcRegistry.handleSync` 同样受 policy 把关，且**任何**路径(policy 拒绝 / policy 自身抛 / handler 抛)都必落一个 `{ ok:false }` 哨兵到 `event.returnValue`——否则被阻塞的 renderer 会永久挂起。
- renderer 侧封装：`features/monaco-editor/services/file-service.ts`（经 `@/shared/api/ipc-transport` 的 `invoke`/`invokeStrict`/`sendSync` 透传，preload 暴露 `sendSync`）。

## 4. WXML / WXSS 语言支持

`language/register.ts` 的 `ensureDiminaLanguages()`（幂等）：

- **WXSS**：`.wxss` 注册到 Monaco 内置 `css` 语言（tokenizer + worker 校验/补全随 monaco-editor 自带），对齐微信开发者工具把 `.wxss` 当 CSS。`languageForPath('.wxss')` → `'css'`。
- **WXML**：注册 `wxml` 语言 + `setMonarchTokensProvider(wxmlMonarchLanguage)` + 语言配置。
  - **Monarch（非 TextMate）**：纯 Monaco 不原生吃 TextMate（要 Oniguruma WASM），wxml 是 HTML-like + `{{}}` 插值 + `wx:` 指令 + `bind*/catch*` 事件，用 Monarch 表达足够且零 WASM 成本（`language/wxml-monarch.ts`）。
  - **wxml LSP**（`language/wxml-lsp.ts`，纯 `monaco.languages.register*` API）：`registerCompletionItemProvider`（标签名/属性名/属性枚举值/`wx:`指令/事件）+ `registerHoverProvider`（组件与属性文档）。元数据在 `language/wxml-data.ts`。

## 5. 主题

`theme.ts`：`defineDiminaThemes()` 基于 monaco `vs`/`vs-dark` 定义 `dimina-light`/`dimina-dark`；`applyMonacoTheme(isDark)` 在 mount 时按当前模式 setTheme。`isDarkMode()` 读 `documentElement` 的 dark class / `prefers-color-scheme`。

## 6. 与 ProjectWindowLayout 的关系

editor 是 dockable 布局里的 `editor` DOM 面板：普通 React 子节点，由 React 自行挂载/卸载，**不是 overlay、不发 bounds、不经 view-manager**。`<DockView>` 经 `renderDomPanel('editor')` 直接渲染 `<MonacoEditor/>`，不挂任何 native anchor。整套布局里仍是主进程 overlay 的只有两个原生面板——simulator（设备 WCV）与 console（Console DevTools，`view:simulator:devtools-bounds` + `setSimulatorDevtoolsBounds`），各由一个 `view-anchor`（`@dimina-kit/view-anchor`）锚点同步 bounds——与 editor 无关。布局拓扑/拖拽 re-dock/序列化逻辑见 `project-window-layout.md`。

## 7. 构建

Monaco 由 vite 随 renderer 一起打包（`pnpm build:renderer`）；语言 worker 经 `?worker` 产出独立 chunk。没有单独的 editor 构建步骤、没有 editor preload。

## 8. 已知限制 / 后续

| # | 限制 | 说明 |
|---|---|---|
| 1 | 无文件监听 | 外部改同一文件编辑器看不到；后续可加 watch + 重载 model |
| 2 | 无多 tab / 搜索 / 命令面板 / 设置 UI | MVP 范围只做 file tree + 单编辑区 + wxml/wxss + 主题；这些是后续增量（dimina 自建壳逐步补） |
| 3 | `listFiles` cap 5000 | 巨型项目截断；后续可 lazy load tree |
| 4 | wxml LSP 无专测 | `wxml-lsp.ts` 是纯 `monaco.languages.register*` API，可补一个能在 vitest 跑的 provider 单测做回归网 |
| 5 | wxml Monarch | 覆盖常见语法；若需更精细高亮可后续升级到 vscode-textmate |

## 9. 文件清单

| 文件 | 角色 |
|---|---|
| `src/renderer/modules/main/features/monaco-editor/components/MonacoEditor.tsx` | editor cell：文件树 + Monaco，开/存文件 |
| `.../monaco-editor/components/FileTree.tsx` | 扁平路径 → 折叠树 |
| `.../monaco-editor/hooks/useMonacoEditor.ts` | editor 实例 + per-file model 生命周期 |
| `.../monaco-editor/monaco-env.ts` | vite `?worker` MonacoEnvironment |
| `.../monaco-editor/language/register.ts` | 注册 wxml/wxss + `languageForPath` |
| `.../monaco-editor/language/wxml-monarch.ts` | wxml Monarch tokenizer + 配置 |
| `.../monaco-editor/language/wxml-lsp.ts` | wxml completion/hover |
| `.../monaco-editor/language/wxml-data.ts` | wxml tag/attr/枚举值元数据 |
| `.../monaco-editor/theme.ts` | dimina ↔ monaco 主题 |
| `.../monaco-editor/services/file-service.ts` | `project:fs:*` renderer 封装 |
| `.../monaco-editor/services/retry.ts` | 冷启动 `ENOACTIVE` 瞬态错误的 bounded retry（`readWithRetry`）|
| `src/main/ipc/project-fs.ts` | 沙盒化项目文件 IPC（symlink 加固：双侧 realpath + 写前祖先校验 + NUL 拒绝）|
| `src/shared/ipc-channels.ts` | `ProjectFsChannel` |
| `src/renderer/.../project-runtime/layout/dock-layout.ts` | editor 在 panel registry 登记为 DOM 面板、出现在默认 dock 树里 |
| `src/renderer/.../project-runtime.tsx` | `renderDomPanel('editor') → <MonacoEditor/>`（DOM 面板，无 native anchor）|

> editor 在 dockable 布局里的拖拽 re-dock/序列化不在本文 —— 见 [`project-window-layout.md`](./project-window-layout.md)。
