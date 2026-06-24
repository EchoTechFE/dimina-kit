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
