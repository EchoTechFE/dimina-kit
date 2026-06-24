# A2 工作台进产品集成路线图

把已验证 ready 的 A2 VS Code 工作台（`spike/vscode-a2/`）集成进 shipping devtools，达到产品 ready。基于三份接缝映射（构建/WCV/ViewAnchor、#35 Monaco+HMR+源链接、qdmp 契约）综合而成。

## 总策略：A2 为唯一编辑器（用户拍板「不要共存」2026-06-24）

**最终决策**：A2 工作台是 devtools **唯一**编辑器，无条件启用，**删除 in-renderer Monaco**（PR #35 产物）。撤掉曾经的 opt-in 双路径（`editorViewConfig.enabled` 开关 + dock 槽 native/dom 切换 + getEditorViewMode 查询）。

> 历史：先前为安全/向后兼容采用过 opt-in 共存（enabled 开关），用户明确否决（不要共存）。`editorViewConfig` 保留但仅余 `bundleDir?`/`extensionsDir?` 微调项；`enabled` 字段删除。qdmp 升级即获 A2 编辑器（这是预期的 breaking，用户已接受）。

切换内容：COI server+WCV+SAB 无条件启动；删 `monaco-editor` 目录与 npm 依赖；删 GetEditorViewMode 通道/API；保留 `enforceWithinProjectRoot`（COI /__fs 复用）。

**editor 面板模型修正（rebase 后定型）**：'editor' 槽是 **dom 结构面板**（与 simulator 对称：`kind:'dom'`、`draggable:false`、`hideTab:true`），其 body 是 `components/editor-panel.tsx`——一个 `data-area="editor"` 的全尺寸 div，用 `createPlacementAnchor` 把工作台主进程 WCV 锚到它上面（publish→`publishWorkbenchA2Bounds`）。**不是 native slot**（曾短暂用 native/console 模式，但结构面板契约要求 dom body `[data-deck-panel-body="editor"]`，且与 simulator 对称更干净）。
**懒加载（boot 性能）**：工作台 WCV 的重加载（10MB bundle + ext-host）不在 app boot 关键路径——`app.ts` 只 `setWorkbenchA2Source(coiUrl)` 存 URL，`view-manager.setWorkbenchA2Bounds` 在 'editor' 槽**首次可见**（首个非零 bounds）时才懒 `attachWorkbenchA2`。eager 加载会拖慢 preload/窗口就绪、撞 e2e 启动健康检查导致 relaunch。
**build 解阻塞**：worktree 不自动 init `dimina` submodule（空）→`build:container`/`build:native-host` 失败；解=`git submodule update --init dimina` + 从主仓 rsync 预构建产物（`dimina/fe/packages/{service,render,common,container}/dist` + `packages/devkit/fe/dimina-fe-container`）绕过卡死的 `build:container`。

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
- **主题同步：✅ 落地**。attach 时 `index.html?theme=light|dark` 传初值；运行时 devtools `nativeTheme 'updated'` → `pushWorkbenchTheme()` → `executeJavaScript` 调工作台 `__A2_SET_THEME` → `updateUserConfiguration` 翻 `workbench.colorTheme`（Light/Dark Modern）。实测 `vs-dark`↔`vs` 实时翻转。

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

**注入方式定稿（A'：官方 `@types` 约定）**：dd/wx 写成 `file:///workspace/node_modules/@types/dimina/`，靠 TS 模块解析自动发现（无 config 时零配置文件；用户自带 tsconfig 时把包名合并进 `compilerOptions.types`，仅 memfs 不落盘）。经穷举（plugin 零文件注入实测可行但因依赖 `@internal` API + vendored patch 版本脆弱而否决）+ 联网调研（维护者+全行业一致用真实文件，无 plugin 先例）定下此路。详见 `vscode-a2-typehints-breakthrough.md`。`files.exclude:{node_modules:true}` 隐藏注入。实测 `dd.`=68 + hover `const dd: Dimina.DD`（真类型非 any）。

### 目标#2 下游开放 editor 能力（插件/下游控制权）✅ 机制落地
`EditorViewConfig.extensionsDir`：宿主（devtools / 经 launch 配置的 qdmp）提供一个 VS Code **web** 扩展目录。框架 COI server 经 `/__contrib/` 服务 + `/__contrib/index.json` 清单（含每个扩展 package.json + 文件列表）；工作台 boot 时 `registerContributedExtensions()`（`spike/vscode-a2/src/contributed-extensions.ts`）拉清单、`registerExtension`（LocalWebWorker, system）+ `registerFileUrl` 每个文件 → `/__contrib/<dir>/<file>`。下游无需 fork bundle 即可贡献语言/命令/视图。best-effort：无 extensionsDir/拉取失败/单扩展坏不阻塞 boot。

**下游自定义 API 类型贡献**：扩展 `package.json` 声明 `"diminaWorkbench":{"typings":["types/x.d.ts"]}`（路径须 ∈ 该扩展 `files`，防穿越），boot 时收集并落成 `node_modules/@types/<sanitized-dir>/` 包，与内置 dd/wx 同走目标#1 的 `@types` 注入。实测下游 `qdmp.` 自定义 API 补全命中。

### 目标#3 侧边栏更多能力
**最终采用标准 VS Code 资源管理器（非自定义分栏）**。早期做过 dimina 专属侧边栏（Pages/App Config TreeView）但被用户否决——它替代了文件树、用户要的是正常项目文件树。故改为引入 `@codingame/monaco-vscode-explorer-service-override`：标准资源管理器渲染 `file:///workspace` 项目文件树（点文件打开、内容正常）。完整 VS Code 侧边栏（资源管理器/搜索等）原生具备，下游还能经 `/__contrib` 扩展贡献自己的视图（目标#2 机制）。`dimina-sidebar.ts` 已不注册。

## 对抗 review（Claude + codex）+ 修复（2026-06-24）

两路独立对抗审查交叉验证，确证并已修复的真问题：
- **切项目存错项目（数据 bug，P0）**：`openProject(B)` 不 dispose views，工作台 boot 只镜像一次 → `file:///workspace` 仍显示 A 但 `/__fs` 写入落 B。修：`workspace-service.openProject` 在已有活跃 session 时 `detachWorkbenchA2()`，复用懒加载重挂 + 重镜像新项目。
- **`/__fs`+`/__contrib` symlink 逃逸**：原只用词法 `enforceWithinProjectRoot`（不解析 symlink）。修：`project-fs.ts` 导出 realpath 守卫（`O_NOFOLLOW` + realpath 复检 + `assertWritableAncestor`），COI server 全部 op 复用（单一沙箱）；`/__contrib` 同样 realpath。
- **`/__fs` 增删改无 method/origin 守卫**（任意 localhost GET 删文件）：修 mutator 要求非 GET + `Sec-Fetch-Site` same-origin + `Origin` host==Host；`/__fs/write` 32MiB body 上限。
- **`joinRel` bug**：`/__fs` 相对路径被 `path.resolve` 解析到主进程 cwd 而非项目根 → `joinRel(root, rel)` 修正。
- **补全丢 snippet/textEdit**（插入字面 `${1}`/重复括号）：两处 provider 加 `SnippetString` + `textEdit` range（区分 `TextEdit`/`InsertReplaceEdit`）。
- **open-in-editor boot 吞点击**：`openFileInWorkbench` await 真实结果 + 10×150ms 重试；file URI 分段 `encodeURIComponent`。
- **bundleDir/启动健壮性**：bundleDir 从 `devtoolsPackageRoot` 解析；bundle 缺失 `existsSync` 检测则跳过编辑器装配（不起空壳）；COI `close()` 改 await。

review verified clean（无需再查）：懒加载竞态 / EditorPanel anchor 生命周期 / COI 绑 127.0.0.1 / COOP-COEP 头（含错误路径）/ 双 attach 守卫 / 坐标转换 / SAB-gate patch 幂等 / qdmp 契约。合并后 check-types 0 / lint 净 / vitest 1701（含新 COI 12）/ build:a2。

## 编辑器 polish 定稿（用户体验项）

真机体验后修的编辑器 chrome / 语言项（`spike/vscode-a2/src/main.ts` 的 `buildUserConfig` 集中下发，每次主题翻转一并重应用，因 `updateUserConfiguration` 整体替换 user config）：
- **wxss 高亮**：装 `@codingame/monaco-vscode-css-default-extension` + `files.associations:{'*.wxss':'css','*.wxs':'javascript'}` → `.wxss` 按 css 高亮（无专用 wxss 语法，css 足够近）。
- **隐藏账户头像**：注入 CSS 隐藏活动栏 `codicon-accounts-view-bar-icon` 的 action-item（嵌入式编辑器无登录/同步，账户是死 chrome）；设置齿轮保留。
- **隐藏顶部标题栏**：`window.commandCenter:false` + `workbench.layoutControl.enabled:false` + `window.customTitleBarVisibility:'never'`（命令中心搜索/前进后退/布局切换是独立窗口 chrome，docked 编辑器里冗余）。
- **空文件 bug 修复**：工作台懒加载早于项目编译就绪时镜像会拿到空树 → `mirrorDiskToFileWorkspace` 改为轮询项目根直到非空（~30s 预算）再镜像一次。
- 主题同步 / 标准资源管理器 / `@types` 类型注入见上文各节。

## 关键复用合约（稳定，不改）

- `ProjectFsChannel.{ListFiles,ReadFile,WriteFile,WriteFileSync}` + `project-fs.ts` 沙箱守卫 —— A2 的 `/__fs` 桥复用。
- 保存→HMR 链（devkit `onRebuild` → workspace-service → projectStatus）—— 逻辑不动。
- ViewAnchor（`useViewAnchor`/`createPlacementAnchor`）—— A2 bounds 同步复用 console 模式。
