# VS Code 工作台载体对比：A1（自建 code-oss web）vs A2（@codingame/monaco-vscode-api）

> 决策前提（已锁定，不在本文重新论证）：dimina devtools 走**完整 VS Code 工作台**进 webview/WebContentsView，**已排除 OpenSumi**。本文只在 A1 / A2 二选一。
>
> 调研性质：只读 + 联网核实，未改源码、未启动 app。数据来源标注在每节。日期 2026-06-23。

---

## 0. 两个候选是什么

- **A1 — 自建 code-oss web（vscode-web）**：clone 整棵 `microsoft/vscode`，用其自带 gulp / `code-web` 链构建 web 版，自托管成一坨静态产物。微信开发者工具的 `vseditor` 就是这条路的实物。
- **A2 — `@codingame/monaco-vscode-api`**：微软 VS Code 源码被 CodinGame 重打成 npm 包。核心三件套：
  - `monaco-editor@npm:@codingame/monaco-vscode-editor-api`（别名 `monaco-editor`）
  - `vscode@npm:@codingame/monaco-vscode-extension-api`（别名 `vscode`，给扩展 import）
  - 几十个 opt-in `@codingame/monaco-vscode-*-service-override` 包，按需拼工作台。
  - 配 `monaco-languageclient` 跑 LSP。

---

## 1. 磁盘实测：微信 vseditor（= A1 的实物参考）

路径：`/Applications/wechatwebdevtools.app/Contents/Resources/package.nw/js/libs/vseditor/`

| 项 | 实测值 | 说明 |
|---|---|---|
| 整树 | **119 MB** | assets/bundled/extensions/src/static/webview-resource |
| `bundled/` | **27 MB** | 运行时核心 |
| `bundled/editor.bundled.js` | **14.8 MB** | 工作台主 bundle（单文件） |
| `bundled/ext.bundled.js` | 5.2 MB | 扩展宿主 |
| `bundled/shareprocess.bundled.js` | 5.3 MB | shared process |
| 内置扩展 | ~50 个目录 | 含微信自有 `emmet-wxml`（`publisher: wechat.miniprogram`，`onLanguage:wxml`） |

**关键判断：这是完整 code-oss workbench，不是裸 monaco。** `editor.bundled.js` 里能 grep 到：`workbench.action.terminal`(340)、`activitybar`(32)、`PanelPart`(10)、`quickInput`(239=命令面板)、`settingsEditor`(26)、`workbench.action.showCommands`(5)，以及 `welcomeGettingStarted` / `welcomeWalkthrough` 等 contrib chunk。活动栏 / 侧边栏 / 面板 / 命令面板 / 设置 UI / 集成终端全在。

> 注意：微信 vseditor 仍是 `microsoft/vscode` 自建产物的形态（A1），不是 A2。它证明 A1 路线可落地，也给了 A1 footprint 的真实下界。

---

## 2. A2 实测：npm 安装与产物体量（npm registry，2026-06-23）

| 包 | 版本 | unpackedSize | fileCount | 角色 |
|---|---|---|---|---|
| `@codingame/monaco-vscode-editor-api` | **34.0.3** | 0.47 MB | 58 | `monaco-editor` 别名（裸编辑器 API） |
| `@codingame/monaco-vscode-extension-api` | 34.0.3 | 0.07 MB | 5 | `vscode` 别名（给扩展 import） |
| `@codingame/monaco-vscode-api`（meta，含全部 service-override） | 34.0.3 | **33.96 MB** | **5082** | 全量服务包合集 |
| `@codingame/monaco-editor-wrapper` | 30.0.1 | 12.94 MB | 482 | 高层封装（features/workbench、features/viewPanels） |

- A2 当前对应 **vscode 1.124.2**（取自仓库 `package.json` 的 `config.version: "1.124.2"`，commit `6928394f...`）—— 紧跟当前正式版。
- 产物体量级别与 A1 同档：拼全量工作台后核心运行时也是几十 MB（meta 包 unpacked ~34MB，与 vseditor 27MB bundled 同量级）。**体积不是区分维度**——两者都是"完整 VS Code"，差异在交付形态不在大小。

来源：`registry.npmjs.org/<pkg>/latest`（直接查 registry，权威）；仓库 `package.json`（`config.version`）。

---

## 3. 逐维度对照表

| # | 维度 | A1（自建 code-oss web） | A2（monaco-vscode-api） | 对我们的含义 |
|---|---|---|---|---|
| 1 | **完整工作台** | 天然完整（vseditor 已证：活动栏/侧栏/面板/命令面板/设置/终端全在） | 可拼到完整：`workbench-service-override`（整套布局，与 editor/views 互斥）+ `views/terminal/search/scm/markers/theme/keybindings/configuration/quickaccess/...` service-override；`editor-wrapper/features/workbench` + `features/viewPanels`（timeline/outline/output/markers/explorer）。命令面板=quickaccess（F1/⌘⇧P）。**缺的需自己确认**：部分高级面板（debug UI、settings GUI 编辑器完整度）需逐个 opt-in 验证，不像 A1 默认全给 | A1 = 开箱即全，调试空间小；A2 = 拼装，需一份"打开哪些 service-override"的清单，多一道集成验证，但换来按需裁剪能力 |
| 2 | **扩展宿主 / LSP** | web ext-host（Web Worker，跑在 iframe）。wxml LSP 走标准 VS Code 扩展：`vscode-html-languageservice`+customData，dd/wx 类型用 TS extension 的 `addExtraLib` 等价 | **同机制**——`extensions-service-override` 提供 webworker extension host（worker in iframe）。LSP 经 `monaco-languageclient`。wxml 扩展打成标准 VS Code web extension 即可，落地方式与 A1 一致 | **此维度两者等价**。我们只有 1 个自有 wxml 扩展，无论哪条路都写成同一个 web extension。现有 devtools 已有 `wxml-monarch`/`wxml-lsp` 的 monaco-API 版（见 `editor-integration.md`），迁到真扩展两路工作量相同 |
| 3 | **crossOriginIsolated 约束** | 需要 COOP `same-origin` + COEP `require-corp` → `crossOriginIsolated===true` → SharedArrayBuffer（TS 工程级 intellisense / web worker ext-host 依赖） | **完全相同**——CodinGame 官方 Troubleshooting 明确：TS language features 的工程级 intellisense 需 SharedArrayBuffer，需 crossOriginIsolated，需带头服务资源 | **两者通用，不是区分维度。** 关键工程结论（前序原型已证）：custom protocol 拿不到 crossOriginIsolated，需 **in-process http server** 发 COOP/COEP 头。这条对 A1/A2 都成立，是 webview 载体的共同前置工作，与选谁无关 |
| 4 | **体积 / footprint** | 整树 119MB / bundled 27MB / editor.bundled.js 14.8MB（vseditor 实测） | meta 包 unpacked ~34MB / 5082 文件；editor-api 别名 0.47MB；wrapper 12.9MB。拼全量后运行时同量级 | **同档，不区分。** 都是"完整 VS Code"的体量。真正影响最终包大小的是 tree-shaking/裁剪，A2 因 service-override 是 opt-in，理论上更易裁，但拼全工作台后省不下来 |
| 5 | **构建复杂度** | clone vscode → gulp（`yarn gulp vscode-reh-web-*-min`）→ node-gyp 编原生模块、需 Python、推荐 **8GB RAM**、实际 mac/linux only。**与我们 vite/esbuild 栈完全分裂**，是第二条独立构建链 | `npm/pnpm install` + 现有 bundler 配 service-override。**与现有栈同源**：devtools renderer 已是 **vite 8 + monaco-editor 0.55.1**，A2 的 editor-api 就是 `monaco-editor` 的别名，等于原地升级 + 加 override，无新构建链 | **A2 完胜。** 我们 renderer 当前 `build:renderer = vite build`、依赖 `monaco-editor ^0.55.1`。A2 是这条链的自然延伸；A1 要新引入 gulp+node-gyp+8GB 的离线构建链，与 pnpm/turbo/vite/esbuild 工作流割裂 |
| 6 | **维护负担** | 养一个 vscode fork：submodule + `patches/` + 每次 upstream bump 做 rebase（code-server 是范本，明确需**专职/准专职投入**）。改动越多，rebase 越痛 | 跟 `@codingame` 的 major：版本号≈vscode 版本（当前 34.x ↔ vscode 1.124），**节奏极快**（33.0.9 → 34.0.3 约几周内连发），major 常带 breaking。但 breaking 是"升 npm 依赖改适配"，不是"重打 fork" | **量级：A1 ≈ 持续 0.3–0.5 人周/月稳态 + 每次大 bump 数人日 rebase；A2 ≈ 跟版本时每个 major 0.5–2 人日适配 service-override / API 变更。** A2 把"维护 fork"换成"跟依赖 major"，对只有 1 个自有扩展的我们更划算 |
| 7 | **Marketplace / 扩展生态** | **被禁微软官方 Marketplace**（ToS/许可），只能 Open VSX。与 code-server/VSCodium 同约束 | **同约束**——非微软发行版均不得连官方 Marketplace，走 Open VSX | **两者相同，且对我们几乎无影响**：我们只需 1 个自有 wxml 扩展，本地内置安装即可，不依赖任何 marketplace。此维度不区分 |
| 8 | **对 qdmp npm 嵌入契约的冲击** | 一坨静态产物 + 独立构建链。devtools 作为可嵌入 npm 包时，要么把 119MB 静态产物随包发，要么消费方自己跑 vscode 构建——**破坏"纯 npm 消费"契约** | npm 依赖，走现有 renderer 打包。嵌入方 `pnpm install` 即拉到，与现有 `monaco-editor` 依赖同性质 | **A2 完胜。** 记忆库 `project_qdmp_workbench_integration`：qdmp 要的是 `launch() + 纯 npm 消费`。A1 的离线构建产物对这个契约破坏最大；A2 只是多几个 npm 依赖 |
| 9 | **活跃度 / 风险** | 上游 = microsoft/vscode（极活跃），但**耦合风险=你 fork 的漂移**：patch 与 upstream 冲突随时间累积 | npm 最新 34.0.3（19 天内从 33.x 连发），维护者活跃、紧跟 vscode 正式版；风险=major 频繁 breaking、第三方单一维护方依赖 | A1 风险是"自己背 fork 漂移"；A2 风险是"绑一个第三方包的发版节奏"。对小团队，A2 的外部依赖风险可控（包成熟、被 monaco-languageclient 等广泛采用），优于自养 fork |

---

## 4. 各自的"最小可行原型"（第一步装/建什么）

### A1 MVP（自建 code-oss web）
1. `git clone https://github.com/microsoft/vscode`（或加为 submodule），checkout 一个稳定 tag。
2. 装构建依赖：Node + Python + 原生工具链（mac/linux），预留 ~8GB RAM。
3. `yarn` →（web 形态）`yarn gulp vscode-web-min` / `vscode-reh-web-*-min`，产出静态 workbench（参照 vseditor 的 `bundled/` 形态）。
4. 改 `product.json` / publicPath，让产物能被 Electron 自定义 protocol / in-process http server 加载。
5. 起 **in-process http server** 发 COOP/COEP 头 → 验证 `crossOriginIsolated===true`。
6. 写 `patches/` 注入 dimina 定制（wxml 扩展、品牌、裁剪）。
> 产出形态：一坨需随包/随构建链交付的静态产物 + 一份 patch 集。

### A2 MVP（monaco-vscode-api）
1. 在 devtools renderer 里：
   ```
   pnpm add @codingame/monaco-vscode-editor-api @codingame/monaco-vscode-extension-api \
            @codingame/monaco-editor-wrapper monaco-languageclient
   # 关键别名（package.json）
   "monaco-editor": "npm:@codingame/monaco-vscode-editor-api@^34",
   "vscode": "npm:@codingame/monaco-vscode-extension-api@^34"
   ```
   （现有 `monaco-editor ^0.55.1` 被别名替换；vite 8 栈不变）
2. 选 service-override 拼工作台：`workbench`(整布局) 或 `views`+`editor`，加 `extensions / files / quickaccess / search / terminal / theme / keybindings / configuration / textmate / languages`。
3. 起 **in-process http server** 发 COOP/COEP 头（同 A1 的前置）→ 验证 `crossOriginIsolated`。
4. 用 `editor-wrapper/features/workbench` + `features/viewPanels` 快速点亮活动栏/侧栏/面板。
5. wxml LSP：把现有 monaco-API 版（`features/monaco-editor/language/*`）改写成一个 web extension（`vscode-html-languageservice`+customData，dd/wx 类型用 `addExtraLib` 等价），装进内置扩展目录。
> 产出形态：纯 npm 依赖 + 现有 vite 产物，嵌入方 `pnpm install` 即得。

---

## 5. 推荐

**推荐 A2（`@codingame/monaco-vscode-api`）。**

**一句话理由**：devtools renderer 现在就是 **vite 8 + monaco-editor 0.55.1**，A2 的 editor-api 是 `monaco-editor` 的直接别名 —— 选 A2 等于"原地升级 + opt-in 拼工作台"，与现有栈和 qdmp"纯 npm 消费"契约同源；而 A1 要额外背一条 gulp+node-gyp+8GB、mac/linux-only 的离线构建链和一个需持续 rebase 的 vscode fork，对只有 1 个自有 wxml 扩展的团队是纯负担。

**九维度里只有 4 个真正区分 A1/A2**（其余 5 个两者相同）：
- 完整工作台（#1）：A1 开箱全、A2 需拼但能拼全 → A1 略优，但差距是一份 override 清单。
- 构建复杂度（#5）：**A2 完胜**（同栈 vs 第二条独立构建链）。
- 维护负担（#6）：**A2 优**（跟 npm major vs 养 fork rebase）。
- npm 嵌入契约（#8）：**A2 完胜**（npm 依赖 vs 静态产物破契约）。

三个"通用、不区分"的维度需提前认账：**crossOriginIsolated（#3）= 必须起 in-process http server 发 COOP/COEP，custom protocol 不行**；**Marketplace（#7）= 只能 Open VSX**（对我们无影响）；**体积（#4）= 都几十 MB 同档**。

**粗工量级别**：
- A2 落地到"可用完整工作台进 webview"：**约 1.5–3 人周**（依赖别名替换 + service-override 拼装 + COOP/COEP http server + wxml 扩展迁移 + e2e 验证）。稳态维护每个 major **0.5–2 人日**。
- A1 同等目标：**约 3–5 人周起**（建第二条构建链 + product.json/patch + COOP/COEP + 扩展），且稳态维护 **持续 0.3–0.5 人周/月 + 大 bump 数人日 rebase**，是 A2 的数倍。

> 唯一让人重新考虑 A1 的场景：如果未来需要 A2 尚未 opt-in 暴露的深度工作台特性（如完整 debug UI），届时再评估"在 A2 上补 service-override"vs"切 A1"。当前 1 个 wxml 扩展的需求下，A2 明显更省。

---

## 6. 数据来源

- vseditor 磁盘实测：`/Applications/wechatwebdevtools.app/Contents/Resources/package.nw/js/libs/vseditor/`（本机 du/grep）
- A2 版本/体量：`registry.npmjs.org/@codingame/monaco-vscode-*/latest`（2026-06-23 查）；vscode 版本取自仓库 `package.json` `config.version: 1.124.2`
- service-override 清单：CodinGame/monaco-vscode-api README + Wiki「List of service overrides」
- crossOriginIsolated/SharedArrayBuffer：CodinGame Wiki Troubleshooting；web.dev COOP/COEP 文档
- Marketplace 约束：code-server FAQ / Open VSX（许可禁连官方 Marketplace）
- vscode 自建构建要求：microsoft/vscode「How to Contribute」Wiki（gulp、node-gyp、Python、~8GB）
- 现有 devtools 栈：本仓库 `packages/devtools/package.json`（vite 8 / monaco-editor ^0.55.1 / esbuild）、`docs/editor-integration.md`
- OpenSumi lite 对照（已排除，仅作 footprint 参考）：`packages/devtools/_spike/opensumi-lite/SPIKE_REPORT.md`
