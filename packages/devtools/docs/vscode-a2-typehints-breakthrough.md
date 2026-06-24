# A2 工作台：真项目编辑 + wxml LSP + dd/wx 类型提示（已 PASS）

记录 A2（`@codingame/monaco-vscode-api`）VS Code 工作台在 Electron WebContentsView 中达成的编辑器能力，及攻破 dd/wx 类型墙的真因与修复。验证物在 `packages/devtools/spike/vscode-a2/`。

## 验证结论（真机 Electron + CDP，productionized build）

| 能力 | 结果 | 证据 |
|---|---|---|
| 工作台 + 扩展宿主在 WCV 真跑 | ✅ | `__A2_STATUS=exthost-alive`，命令 ping/pong 往返 |
| 真项目编辑（file:// memfs 镜像磁盘 193 文件） | ✅ | workspace folder=`file:///workspace`；编辑→保存→回刷磁盘 `diskHasMarker:true` |
| wxml 语言支持（语法/补全/hover） | ✅ | 88 补全、`<view>` hover「视图容器，最基础的块级容器，类似 div」 |
| dd/wx 类型提示 | ✅ | 补全 `getLocation/miniProgram/openLocation`；hover `const dd: Dimina.DD`（非 any）；`wx` 别名同命中 |

## 为什么 workspace 用 `file://` 而非自定义 scheme

web tsserver 只把 `file://` 根当作真实 TS/JS 项目根——会加载 `jsconfig.json` 与 ambient `.d.ts`。自定义 scheme（如 `diminafs:`）下退化成 inferred project，忽略工程配置与 ambient 库，`dd` 解析成 `any`。故把磁盘项目镜像进 `file:///workspace/`（保存监听器把改动回刷磁盘，编辑仍是真的）。

## ambient 类型注入：`@types` 约定（workspace 内隐藏的 node_modules/@types）

dd/wx 的 ambient `.d.ts` 必须以**真实文件**的形式存在于 **workspace 根之内**（web tsserver 同步架构要求 VFS 预先填充、对 root 外同 scheme 路径抛 `AccessOutsideOfRootError`、虚拟注入进不了 program——见下「类型墙」节）。采用官方 `@types`/typeRoots 约定（orta, microsoft/vscode#172887）把它们落在 TS 模块解析能自动发现的位置：`file:///workspace/node_modules/@types/<name>/{package.json,index.d.ts}`（实现见 `spike/vscode-a2/src/typings-injection.ts`）。

真机实测（monaco-vscode-api@34 web tsserver，`dd.` 目标 = 68 项）确定的行为：

- **无 config 或 jsconfig**：inferred `.js` project 自动收纳所有 `node_modules/@types/*`，**无需任何 config**。
- **用户自带 tsconfig**：`.js` 下 `@types` **不会**自动生效，需把包名追加进 `compilerOptions.types`（memfs 镜像，**绝不**写回磁盘）。仅 `files`/`typeRoots`/裸 `typeRoots:['node_modules/@types']` 均不解此 case；追加 `types` 是最小一键修法。
- **边界**：用户若显式设 `types:[]` 主动关掉自动 `@types`，我们仍追加我们的包名（否则注入的工具链静默失效）。
- **`^/ts-typings` 不是虚拟前缀**：在 monaco-vscode-api 下它被当字面目录名 `^` 写进 `file:///workspace/^/...`，故弃用 typeRoots 变体。

落地：
- 内置 dd/wx → `node_modules/@types/dimina/{package.json(types:index.d.ts),index.d.ts}`。
- `files.exclude: { node_modules: true }` 把整个 `node_modules/` 从 Explorer/搜索隐藏（UI-only，tsserver 照读）。dimina 项目编辑器根无真实 `node_modules`，隐藏不损失。
- `flushFileWorkspaceSaveToDisk` 跳过 `node_modules/**` 与 `jsconfig.json`/`tsconfig.json`，保证注入与合并只活在 memfs，用户磁盘项目零污染。

## 下游接入：贡献自定义 API 类型

下游宿主（如 qdmp）经已有的 `/__contrib` web 扩展机制，在其扩展 `package.json` 声明 ambient 类型：

```jsonc
{
  "name": "qdmp-editor",
  "publisher": "qdmp",
  "browser": "./extension.js",       // 可选：同扩展也能带命令/语言/视图
  "diminaWorkbench": { "typings": ["types/qdmp.d.ts"] }
}
```

boot 时（`registerContributedExtensions` → `collectTypings`）：
- 校验每个 typings 路径**必须**在该扩展自己的 `files` 清单内（拒绝路径穿越 / 读取 COI 上的无关文件）；
- 从其同源 `/__contrib/<dir>/<path>` 取内容，把该扩展声明的多个 `.d.ts` 拼成一个 `@types/<sanitized-dir>/index.d.ts` 包（按扩展 dir 命名空间，互不冲突）；
- 与内置 `@types/dimina` 同走 `@types` 自动发现 / 用户 tsconfig `types` 合并那条路径。

净效果：下游 `qdmp.` 等自定义 API 获得补全/hover/类型检查，且 `node_modules/**` 同被那条 `files.exclude` 隐藏、不落用户磁盘。实测：声明 `qdmp.d.ts` 后 `qdmp.` 补全命中 `customApiAlpha/customApiBeta`，`dd.` 仍 68 项不受影响。

## 为什么不用「tsserver plugin 零文件注入」（已调研 + 实测否决）

「写真实文件」唯一的代价是 memfs 里有一个隐藏的 `node_modules/@types/`。曾评估能否用 tsserver plugin 做到**连隐藏文件都不要**（纯虚拟注入）。结论：技术可行但不采用。

- **可行性已实测**：plugin 能加载进 web tsserver（`importPlugin` 经 `fetch` 取 `package.json` 的 `browser` 字段再 `import()`），且用内部 API `projectService.getOrCreateScriptInfoForNormalizedPath(path,false,undefined,ts.ScriptKind.TS)` + `scriptInfo.attachToProject` + `project.addRoot` + `updateGraph` 能让虚拟 `.d.ts` 真进 `getProgram().getSourceFiles()`，`dd.` 补全 + hover 均通。
- **否决理由**：(1) 这套 API 全是 `@internal`，随 TS / monaco-vscode-api 版本可能改名/删除 → 升级时类型提示**静默全失**，每版需回归；(2) 需 patch 5.8MB minified 的 vendored `tsserver.web.js`（改写 `importPlugin` 的 probe，把 `extension-file://` 重写到同源），脆弱；(3) `getExternalFiles` 这条「半公开」路喂不出全局 ambient（只 `attachToProject`、不进 `rootFilesMap`），没有中间档，零文件只能落到最深的内部 API。
- **社区定位**：维护者 CGNonofr 明确 `addExtraLib` 对 web tsserver by-design 无效；官方且唯一推荐就是「真实文件 + tsconfig/`@types` 引用」（vscode.dev / Theia / monaco-languageclient / @typescript/vfs / 微信 api-typings / Taro 全是这条）。plugin 零文件注入**无社区先例**。

故采用 `@types` 真实文件（A'）——维护者+全行业标准、只依赖稳定的文件机制、版本升级稳健。结论由真机隔离 harness 实测（plugin 注入可行性 + `@types` 各变体行为矩阵）+ 多源联网调研（CodinGame/monaco-vscode-api issues、microsoft/TypeScript#47600、orta vscode#172887）交叉验证得出。

## dd/wx 类型墙：真因与修复

**症状**：同文件内 `declare const dd2; dd2.` 补全正常（单文件模式），但跨文件 import、triple-slash 引用、jsconfig 发现、ambient `dimina.d.ts` 全部失效，`dd` 恒为 `any`。

**诊断**：
1. ext-host 的 `vscode.workspace.fs` 能读到 memfs 里的 d.ts/jsconfig（readDirectory/readFile 全成功）——FS 桥不是问题。
2. `@vscode/typescript-language-features` web 扩展把 project-wide IntelliSense（跨文件 / jsconfig / ambient）硬门控在：
   ```js
   isProjectWideIntellisenseOnWebEnabled() { return Vn() && this._configuration.webProjectWideIntellisenseEnabled }
   function Vn() { return pt() && !!globalThis.crossOriginIsolated }   // pt(): 非 node 且 uiKind===Web
   ```
   `webProjectWideIntellisenseEnabled` 默认 true，`pt()` 在 ext-host worker 里为 true，**唯一卡点是 `globalThis.crossOriginIsolated`**。
3. Electron 41 拿不到 `crossOriginIsolated===true`（即便 COOP/COEP 头齐全，electron#35905 closed not-planned）。

**关键洞察**：project-wide IntelliSense 真正依赖的是 `SharedArrayBuffer`+`Atomics`（tsserver worker 与 ext-host worker 间的同步 FS 读取），`crossOriginIsolated` 只是它的代理。而 Electron 用 `--enable-features=SharedArrayBuffer` 开关**独立提供了 SAB**，且实测 SAB 经 `postMessage` 跨 worker 传输、`Atomics` 往返在 `crossOriginIsolated===false` 下**完全可用**（probe：worker 写 42 → 主线程共享内存读到 42）。

**修复**（原则性正确：查真依赖而非代理）：
```js
- function Vn(){return pt()&&!!globalThis.crossOriginIsolated}
+ function Vn(){return pt()&&(typeof SharedArrayBuffer!=="undefined")}
```
改完 `dd.` 补全从「12 次重试仍失败」变为「1 次瞬时命中」。

**patch 落点**：`node_modules/@codingame/monaco-vscode-typescript-language-features-default-extension/resources/extension.js`（经 `new URL('./resources/extension.js', import.meta.url)` 作为 asset 加载，Vite copy 进 dist）。

**可复现性**：
- spike：幂等脚本 `scripts/patch-ts-ext.mjs` 接进 `prebuild` npm hook，`npm run build` 自动应用（已验证：还原 node_modules → build 自动重打）。
- 正式集成：走 `pnpm patch @codingame/monaco-vscode-typescript-language-features-default-extension@34.0.3` + `patchedDependencies`，随安装持久化。

## 必备运行条件

- Electron 启动开关：`--enable-features=SharedArrayBuffer`。**已验证对其它 WCV 无副作用（纯增量）**：普通 WCV（无 COI 头，模拟 simulator/console）下 `crossOriginIsolated` 仍为 false（无 COEP 泄漏）、SAB 仅变为可用、跨源子资源加载不被 COEP 拦截。COEP/COOP 是 per-document（来自工作台自己服务发的头），不会污染加载其它源的 WCV。故此开关可安全进 app 启动。
- 同源服务 + COOP same-origin / COEP require-corp 头（spike 的 `coi-server.mjs`；现有 dimina-resource-server 发的是 CORP cross-origin，工作台需另起或参数化）。
- ext-host / editor / textmate worker 用 Vite `?worker&url` 后缀产出独立 worker 资产（否则 rolldown 内联导致 ext-host 起不来）。

## 三个原始目标的达成度

1. **类型提示** ✅ —— 完整真 tsserver project-wide IntelliSense（dd/wx + 跨文件 + 工程配置）。
2. **对下游开放编辑器能力** ✅（结构性）—— web 扩展宿主已证活，下游可加载 web 扩展。
3. **侧边栏更多能力** ✅（结构性）—— 完整 VS Code 工作台侧边栏（资源管理器/搜索等）原生具备。

剩余为**集成工程**（非编辑器能力本身）：WCV 接 dockview 布局 + ViewAnchor、open-in-editor/保存→HMR/主题桥、qdmp npm 嵌入契约重谈、A2 依赖卫生（与 renderer monaco 0.55.1 共存、打进 devtools 构建、SAB 开关进 app 启动）。
