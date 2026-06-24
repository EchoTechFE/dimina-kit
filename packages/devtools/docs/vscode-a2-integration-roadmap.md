# A2 工作台进产品集成路线图

把已验证 ready 的 A2 VS Code 工作台（`spike/vscode-a2/`）集成进 shipping devtools，达到产品 ready。基于三份接缝映射（构建/WCV/ViewAnchor、#35 Monaco+HMR+源链接、qdmp 契约）综合而成。

## 总策略：A2 为唯一编辑器（用户拍板「不要共存」2026-06-24）

**最终决策**：A2 工作台是 devtools **唯一**编辑器，无条件启用，**删除 in-renderer Monaco**（PR #35 产物）。撤掉曾经的 opt-in 双路径（`editorViewConfig.enabled` 开关 + dock 槽 native/dom 切换 + getEditorViewMode 查询）。

> 历史：先前为安全/向后兼容采用过 opt-in 共存（enabled 开关），用户明确否决（不要共存）。`editorViewConfig` 保留但仅余 `bundleDir?`/`extensionsDir?` 微调项；`enabled` 字段删除。qdmp 升级即获 A2 编辑器（这是预期的 breaking，用户已接受）。

切换内容：dock 'editor' 槽恒为 workbench-a2 native；COI server+WCV+SAB 无条件启动；删 `monaco-editor` 目录与 npm 依赖；删 GetEditorViewMode 通道/API；保留 `enforceWithinProjectRoot`（COI /__fs 复用）。

**硬切换已完成并验证（2026-06-24）**：check-types 0 / lint 净 / vitest **1646 绿**（删 16 个 Monaco 测试）/ dock-layout-split + project-runtime 111 测试绿（含新契约 'editor 是 native 槽'）。删 `src/renderer/modules/main/features/monaco-editor/`（15 文件）+ `monaco-editor` npm 依赖；`build:a2` 已入主 `build` 链（A2 现为强制编辑器，`pnpm build` 必产 workbench-a2）。保留项（无害死代码，最小爆炸半径）：`registerProjectFsIpc`（`enforceWithinProjectRoot` 被 COI 复用）+ open-in-editor 的 renderer fallback。qdmp 升级即获 A2（无需 opt-in）；SAB-gate patch 由 build:a2 prebuild 应用。

## 已完成（本分支 feat/vscode-webview-workbench，未提交）

- ✅ dd/wx 类型墙攻破（SAB-gate patch）+ I4 真项目编辑 + I5 wxml LSP，真机全验证
- ✅ `build:a2`：`spike/vscode-a2` 经参数化 `A2_OUT_DIR` 产出 `dist/workbench-a2`（base `./`），devtools package.json 已加该 script
- ✅ SAB 开关安全性已验（纯增量，不污染 simulator/console WCV）

## Phase 1 — I3 在产品内托管 A2 工作台（集成生死线，可逆）

1. **主进程 COI server**（端口 0/127.0.0.1）：从 `spike/vscode-a2/coi-server.mjs` 端口化成 TS 模块（`src/main/services/workbench-coi-server.ts`）。
   - 静态服务 `dist/workbench-a2`（COOP same-origin / COEP require-corp / CORP same-origin）。
   - `/__fs/*` 桥接到**活跃项目根**（`ctx.workspace.getProjectPath()`），复用 `project-fs.ts` 的 `enforceWithinProjectRoot`/realpath/TOCTOU 守卫（单一沙箱实现，不另造）。
   - 独立 server 实例，不碰现有 `dimina-resource-server`（后者发 CORP cross-origin 给 simulator，二者头需求冲突）。
2. **SAB 开关进 app 启动**：`app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer')`（已验证对 simulator/console WCV 无副作用）。
3. **WCV 载体**：`view-manager.ts` 加 `attachWorkbenchA2(coiUrl)`/`setWorkbenchA2Bounds(bounds)`/`detachWorkbenchA2()`，镜像 console overlay 模式（`new WebContentsView` + `addChildView` + `setBounds` + `raiseTopOverlays` 保持在 settings/popover 之下）。
4. **dockview 接入**：`dock-layout.ts` 的 'editor' 槽在 `editorViewConfig.enabled` 时注册为 native（`nativeRef:{id:'workbench-a2'}`）而非 DOM(MonacoEditor)；`project-runtime.tsx` 用 console 的 ViewAnchor 绑定模式（`useViewAnchor`/`createPlacementAnchor` + `publishWorkbenchA2Bounds`）。
5. **IPC + API**：`ipc-channels.ts` 加 `ViewChannel.WorkbenchA2Bounds`；`view-api.ts` 加 `publishWorkbenchA2Bounds`；主进程 handler 转 `viewManager.setWorkbenchA2Bounds`。
6. **验证**：真机 Electron 启 devtools，'editor' 槽显示 A2 工作台 + dd/wx 类型 + wxml + 编辑真项目；切项目/拖拽列宽 bounds 跟随。

### Phase 1 状态：✅ 落地 + 运行时真机验证 PASS

全部 gated 在 `editorViewConfig.enabled`，纯增量向后兼容（关/缺省时 React Monaco 路径 byte-identical）。check-types 0 / lint 净 / vitest 1662 全绿 / 未改测试。改动：
- `workbench-coi-server.ts`（新）、`view-manager.ts`（attach/setBounds/detach + teardown 接 disposeAll）、`app.ts`（COI server 生命周期 + SAB 开关）、`dock-layout.ts`（'editor' 槽 native/dom 切换）、`project-runtime.tsx`（workbenchMode + ViewAnchor 绑定，console 模式抽成共享 `bindOverlayAnchor`）、`ipc-channels.ts`/`view-api.ts`/`app-api.ts`/`ipc/app.ts`/`ipc/views.ts`（`ViewChannel.WorkbenchA2Bounds` + `AppChannel.GetEditorViewMode`）、`shared/types.ts`（`EditorViewConfig`）。
- **真机验证（生产 COI server 模块 + devtools 构建的 workbench bundle，Electron 端到端）**：`exthost-alive` + 项目经生产 `/__fs` 沙箱桥镜像 193 文件 + `fsReaddir` 返回真项目树 + dd/wx 补全 `[getLocation,miniProgram,openLocation,dd]` 命中。
- **待办**：全 app-shell 启动 e2e（dockview 真渲染 workbench 进 'editor' 槽 + bounds 跟随）—— 受本 sandbox build 限制（build:container 卡死 / devkit dist 缺失）暂缓，非代码缺口（bounds/dockview 接线与生产级 console overlay 同构 + 1662 单测覆盖）。
- 渲染层 `getEditorViewMode()` 查询包 try/catch：主进程查询失败→安全回落 Monaco（也让缺该 export 的既有 mock 静默回落，未改测试）。

## Phase 2 — I6 集成桥

- **保存→HMR：已确认白嫖**。`createProjectWatcher`（devkit/src/index.ts:259-293）监听的就是活跃项目根 `projectPath`（= A2 `/__fs/write` 的目标 `getProjectPath()`），listen add/change/unlink → `rebuildScheduler.schedule()` → `onRebuild` → `projectStatus` 推送；ignore 仅忽略 projectPath 下点开头段，A2 写的 wxml/js 普通文件不被忽略。**无需额外接线**（项目以 watch=true 打开时）。
- **open-in-editor：✅ 落地 + 真机验证 PASS**。`view-manager.ts` 加 `openFileInWorkbench(rel, line, col)`（executeJavaScript 驱动工作台 vscode API `openTextDocument(file:///workspace/<rel>)` + `showTextDocument` + selection，1-based→0-based 转换）；`onOpenUrl`（wireOpenInEditor）在工作台已挂时先走它、否则回落 `ctx.notify.editorOpenFile`。验证：1-based(3,5)→打开 app.js + 光标 0-based(2,4) 精确命中。复用现有 `resolveProjectEditorTarget` 映射，无需改 open-in-editor.ts 注入脚本。
- **主题同步**：剩余 polish（devtools 主题 → 工作台 `workbench.colorTheme`，可经 attach 时 URL query 传初值 + 运行时 updateUserConfiguration）。

## Phase 3 — I7 契约 + 迁移

- **`editorViewConfig` 契约**：`shared/types.ts` 加 `EditorViewConfig{enabled, htmlPath?}` + `editorServerPort?`（可选、向后兼容）。`launch()` 签名不变。
- **qdmp opt-in**：qdmp `index.ts` 的 `devtoolsConfig` 加 `editorViewConfig:{enabled:true}`（一行，框架处理 COI server）。
- **patch 产品化**：SAB-gate 走 `pnpm patch @codingame/monaco-vscode-typescript-language-features-default-extension@34.0.3` + `patchedDependencies`（注：minified 单行文件，prebuild 脚本比 pnpm patch 存全行 diff 更轻；二选一，倾向构建期脚本）。
- **硬删 #35（迁移 Phase 3，默认翻转后）**：删 `monaco-editor/` 目录 + `project-runtime.tsx` MonacoEditor 挂载；`project:fs:*` 沙箱保留（A2 复用）。

## Phase 4 — I8 卫生 + CI

- A2 deps 从 spike 独立 node_modules 并入 devtools 依赖管理（与 renderer monaco 0.55.1 共存：A2 用 `@codingame/monaco-vscode-editor-api`，物理隔离不冲突）；`build:a2` 并入主 `build` 链。
- CI worker 守卫：dist worker.js 必须含 `extensionHostWorkerMain`（防 rolldown 内联回潮）。
- 离线：不设 `extensionsGallery`（否则连 open-vsx）。

## 三个原始目标的实质推进（不止「结构性可用」）

用户强调集成之外也要实质做深最初三目标。

### 目标#1 类型提示深化
dd/wx ambient 类型从 dimina 真源大幅补全（全部真实 API）、wxml 组件属性级补全、dimina 配置文件（app.json/page.json/project.config.json）JSON schema。产物在 `spike/vscode-a2/src/`（dimina-dts.ts 扩展 / wxml-meta.ts 属性 / dimina-json-schemas.ts）。

### 目标#2 下游开放 editor 能力（插件/下游控制权）✅ 机制落地
`EditorViewConfig.extensionsDir`：宿主（devtools / 经 launch 配置的 qdmp）提供一个 VS Code **web** 扩展目录。框架 COI server 经 `/__contrib/` 服务 + `/__contrib/index.json` 清单（含每个扩展 package.json + 文件列表）；工作台 boot 时 `registerContributedExtensions()`（`spike/vscode-a2/src/contributed-extensions.ts`）拉清单、`registerExtension`（LocalWebWorker, system）+ `registerFileUrl` 每个文件 → `/__contrib/<dir>/<file>`。下游无需 fork bundle 即可贡献语言/命令/视图。best-effort：无 extensionsDir/拉取失败/单扩展坏不阻塞 boot。

### 目标#3 侧边栏更多能力
dimina 专属侧边栏 web 扩展（`spike/vscode-a2/src/dimina-sidebar.ts`）：Activity Bar 视图容器 + 「Pages」TreeView（运行时读 `file:///workspace/app.json` 列主包/子包页面，点击打开源文件）+ 「App Config」只读树（window/tabBar 概览）；监听 app.json 保存自刷新。

## 关键复用合约（稳定，不改）

- `ProjectFsChannel.{ListFiles,ReadFile,WriteFile,WriteFileSync}` + `project-fs.ts` 沙箱守卫 —— A2 的 `/__fs` 桥复用。
- 保存→HMR 链（devkit `onRebuild` → workspace-service → projectStatus）—— 逻辑不动。
- ViewAnchor（`useViewAnchor`/`createPlacementAnchor`）—— A2 bounds 同步复用 console 模式。
