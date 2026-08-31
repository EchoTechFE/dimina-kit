# VS Code 工作台生产集成

> 本文件只记录 shipping devtools 的当前接线。编辑器能力见
> [`editor-integration.md`](./editor-integration.md)，类型注入细节见
> [`vscode-workbench-typehints.md`](./vscode-workbench-typehints.md)。

## 产品形态

- VS Code 工作台是唯一编辑器；`EditorViewConfig` 没有 `enabled` 字段
  （`packages/devtools/src/shared/types.ts:273-293`）。
- renderer 的 `editor` 面板是结构性 DOM 槽，`EditorPanel` 只发布 placement；
  主进程 WCV 承载编辑器内容
  （`packages/devtools/src/renderer/modules/main/features/project-runtime/components/editor-panel.tsx:7-95`）。
- 工作台源码在 `packages/workbench/`；devtools 构建把它输出到
  `dist/vscode-workbench`
  （`packages/devtools/build-workbench.mjs:3-24`）。

## 主进程接线

`app.ts` 为工作台启用 `SharedArrayBuffer`，启动本机 COI server，
并把 server URL 交给 view manager
（`packages/devtools/src/main/app/app.ts:425-429`、
`packages/devtools/src/main/app/app.ts:821-857`）。

工作台 WCV 首次可见时才创建；项目打开期间可用 generation-bound hold 延后创建，
3 秒上限后自动放行。hold 只延后尚未创建的 WCV，不隐藏已经存在的编辑器
（`packages/devtools/src/main/services/views/workbench-view.ts:38-55`、
`packages/devtools/src/main/services/views/workbench-view.ts:135-182`）。

## 文件与项目身份

- `/__fs/*` 把活动项目映射给工作台，写操作要求非 GET 且同源
  （`packages/devtools/src/main/services/workbench-coi-server.ts:158-183`、
  `packages/devtools/src/main/services/workbench-coi-server.ts:291-315`）。
- `/__project` 按请求返回当前 `appId` 和项目路径；工作台用它区分固定
  `file:///workspace` 下的不同项目
  （`packages/devtools/src/main/services/workbench-coi-server.ts:342-348`）。
- 项目切换会 detach 旧 WCV，新文档重新镜像当前项目；工作台不复用旧项目的 memfs。

## 宿主扩展

`EditorViewConfig.bundleDir` 可替换工作台 bundle；
`EditorViewConfig.extensionsDir` 可提供 VS Code web 扩展
（`packages/devtools/src/shared/types.ts:278-293`）。

COI server 只扫描 `extensionsDir` 的直接子目录，并从
`/__contrib/index.json` 发布 manifest；工作台按清单注册扩展。扩展可在
`package.json#diminaWorkbench.typings` 声明 ambient 类型，声明路径必须出现在
该扩展的文件清单内
（`packages/devtools/src/main/services/workbench-coi-server.ts:323-349`、
`packages/workbench/src/contributed-extensions.ts:56-120`）。

## 用户可见能力

- 标准 VS Code Explorer、搜索、命令与编辑器由
  `packages/workbench/src/boot.ts:17-77` 的 service overrides 和默认扩展提供。
- WXML 补全/hover 与 dimina JSON schema 在
  `packages/workbench/src/boot.ts:430-446` 注册。
- dd/wx 与下游类型写入 memfs 的 `node_modules/@types`
  （`packages/workbench/src/typings-injection.ts:78-132`）。
- open-in-editor 通过工作台的 VS Code API 打开
  `file:///workspace/<rel>`
  （`packages/devtools/src/main/services/views/workbench-view.ts:195-257`）。
- 首屏和运行时主题分别由 URL query 与 `__WB_SET_THEME` 同步
  （`packages/devtools/src/main/services/views/workbench-view.ts:57-79`、
  `packages/devtools/src/main/services/views/workbench-view.ts:118-125`）。

## 构建约束

devtools 的 `build` 必须包含 `build:workbench`；后者调用
`@dimina-kit/workbench` 的 `build:app`
（`packages/devtools/package.json:89-93`、
`packages/devtools/build-workbench.mjs:15-23`）。

TypeScript web 扩展的 gate patch 由
`packages/workbench/scripts/patch-ts-ext.mjs` 在 workbench 构建链中应用；运行时同时依赖
Chromium `SharedArrayBuffer` feature 与 COOP/COEP 文档头
（`packages/workbench/package.json:47-55`、
`packages/devtools/src/main/app/app.ts:425-429`、
`packages/devtools/src/main/services/workbench-coi-server.ts:72-76`）。
