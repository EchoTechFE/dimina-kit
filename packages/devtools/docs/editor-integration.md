# devtools 内置编辑器集成（VS Code 工作台）

> 编辑器是主进程 `WebContentsView` 中运行的 VS Code 工作台。renderer 的
> `editor` dock 面板只提供 DOM 占位和 placement anchor。

## 当前结构

`EditorViewConfig` 只允许覆盖工作台 bundle 目录或提供下游 web 扩展目录；
编辑器始终启用，没有 Monaco fallback
（`packages/devtools/src/shared/types.ts:273-293`、
`packages/devtools/src/shared/types.ts:325-332`）。

`editor` 在 dock registry 中仍登记为结构性 DOM 面板，但它渲染的是空的
`EditorPanel`。`EditorPanel` 用 `createPlacementAnchor` 把槽位的
`Placement` 写进窗口级 publisher；真正内容由主进程 WCV 绘制
（`packages/devtools/src/renderer/modules/main/features/project-runtime/layout/dock-layout.ts:83-102`、
`packages/devtools/src/renderer/modules/main/features/project-runtime/components/editor-panel.tsx:7-95`）。

## 启动与放置

devtools 启动时：

1. 默认从 `packages/devtools/dist/vscode-workbench` 取 bundle；可由
   `editorViewConfig.bundleDir` 覆盖。
2. bundle 中没有 `index.html` 时跳过工作台服务并记录警告。
3. bundle 存在时启动仅监听本机的 HTTP 服务，并设置 COOP/COEP/CORP 头。
4. `workbench-view.ts` 保存服务 URL，直到 editor 槽第一次发布非零 placement 才创建 WCV。

依据：`packages/devtools/src/main/app/app.ts:821-857`、
`packages/devtools/src/main/services/workbench-coi-server.ts:72-76`、
`packages/devtools/src/main/services/views/workbench-view.ts:30-55`。

创建 WCV 时，`attachWorkbench`：

- 使用 `contextIsolation:true`、`nodeIntegration:false`；
- 把 WCV 注册进 placement reconciler，而不是直接由 renderer 管 bounds；
- 用 `index.html?theme=<light|dark>` 传首屏主题；
- 把外部弹窗和跨源导航交给系统浏览器。

依据：`packages/devtools/src/main/services/views/workbench-view.ts:82-128`。

## 构建归属

工作台源码位于 `packages/workbench/`。devtools 的
`build:workbench` 调 `@dimina-kit/workbench` 的 `build:app`，
并把产物写入 `packages/devtools/dist/vscode-workbench`
（`packages/devtools/build-workbench.mjs:3-24`、
`packages/devtools/package.json:89-93`）。

`SharedArrayBuffer` 是 web TypeScript 扩展宿主的运行条件。devtools 在创建 app
前加入 Chromium feature switch；工作台 HTTP 服务给文档设置隔离头
（`packages/devtools/src/main/app/app.ts:425-429`、
`packages/devtools/src/main/services/workbench-coi-server.ts:72-76`）。

## 项目文件与保存

工作台把活动项目镜像到固定的 `file:///workspace` 内存文件系统，再通过同源
`/__fs/*` bridge 读写磁盘。bridge 复用 `project-fs.ts` 的路径校验和
symlink 防护，而不是由 renderer 直接调用 `project:fs:*`
（`packages/workbench/src/workspace/disk-workspace-source.ts:1-18`、
`packages/devtools/src/main/services/workbench-coi-server.ts:291-315`）。

`ProjectFsChannel` 仍保留，包括 beforeunload 所需的同步写通道；它也是
COI 文件 bridge 的沙盒实现来源，不代表 Monaco 仍存在
（`packages/devtools/src/main/ipc/project-fs.ts:41-45`、
`packages/devtools/src/main/ipc/project-fs.ts:626-637`）。

项目切换时工作台 WCV 会销毁并按新项目重新创建，避免固定
`file:///workspace` 指向旧项目。工作区身份由 COI 服务的 `/__project`
按请求读取活动项目，而不是写进首次 attach URL
（`packages/devtools/src/main/services/views/workbench-view.ts:118-123`、
`packages/devtools/src/main/services/workbench-coi-server.ts:342-348`）。

## 语言能力与扩展

`packages/workbench/src/boot.ts` 注册 WXML 语言支持、dimina JSON schemas、
TypeScript/CSS/JSON 等工作台扩展，并在填充 workspace 后启动自动保存
（`packages/workbench/src/boot.ts:430-484`）。

dd/wx ambient 类型以真实 memfs 文件写到
`file:///workspace/node_modules/@types/dimina/`。若存在
`tsconfig.json` 或 `jsconfig.json`，只修改 memfs 副本中的
`compilerOptions.types`；不写回用户磁盘
（`packages/workbench/src/typings-injection.ts:1-20`、
`packages/workbench/src/typings-injection.ts:101-132`）。

宿主可通过 `EditorViewConfig.extensionsDir` 提供 VS Code web 扩展。COI 服务从
`/__contrib/` 发布清单和文件，工作台在启动时注册扩展并收集其声明的 ambient typings
（`packages/devtools/src/shared/types.ts:283-292`、
`packages/workbench/src/boot.ts:463-477`）。

## open-in-editor 与主题

`openFileInWorkbench(relPath, line, column)` 把项目相对路径编码成
`file:///workspace/<rel>`，再通过工作台暴露的 VS Code API 打开文档；输入坐标是
1-based，`vscode.Position` 使用 0-based
（`packages/devtools/src/main/services/views/workbench-view.ts:195-257`）。

首次主题由 URL query 传入。运行时主题变化由 `workbench-view.ts` 监听
`nativeTheme.updated`，同步 WCV 背景并调用 `window.__WB_SET_THEME`；
工作台在启动完成后安装该 setter
（`packages/devtools/src/main/services/views/workbench-view.ts:57-79`、
`packages/workbench/src/main.ts:148-160`）。

## 关键文件

| 文件 | 角色 |
|---|---|
| `packages/devtools/src/main/services/views/workbench-view.ts` | WCV 生命周期、主题、open-in-editor |
| `packages/devtools/src/main/services/workbench-coi-server.ts` | bundle、`/__fs`、`/__contrib`、`/__project` |
| `packages/devtools/src/renderer/modules/main/features/project-runtime/components/editor-panel.tsx` | editor 槽 placement anchor |
| `packages/workbench/src/boot.ts` | VS Code 工作台初始化与语言能力 |
| `packages/workbench/src/typings-injection.ts` | dd/wx 与下游 ambient typings |
| `packages/devtools/src/main/ipc/project-fs.ts` | 文件沙盒与同步写通道 |
