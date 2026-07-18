# Claude Code Rules

## 设计与修复原则（Design principles）

- **模型承认现实**：数据结构与运行时现实不符（如单值 map 承载多对多关系）时改模型本身，不用特判/补丁续命——补丁数量会随现实复杂度无限增长。
- **单一真相源**：同一份状态或判断只允许一个权威（一个判据函数、一个状态机、一个调度器）。发现两处各自判断/各自管理同一事实，即是重构信号，不是加第三处的理由。
- **同类 bug 第二次出现即建权威抽象**：让这类错误"结构上犯不了"（如监听器统一登记、注入统一过闸），而不是再修一个实例。
- **状态与事实同步**：状态标记在事实发生的那一刻置位（如资源"已使用"在导航发生时标记），不等整个流程成功——迟置位的标记会在错误路径上撒谎。
- **迟到的异步结果用单调 generation/epoch 戳作废**：可被更新请求取代的异步操作（open/close、worker 回复、布局快照）发起时打单调戳；结果到达先比对当前权威 generation，不匹配就静默丢弃（不重放、不复活、不触发副作用），别靠 promise 取消或时序假设——否则旧结果会复活成 zombie（旧 editor 复活 / 旧帧覆盖新布局）。销毁同理：owner 显式同步推终态（一次"空"快照 / reconcile），别让下游靠 `'closed'` / `'destroyed'` / ResizeObserver 事件反推——那类事件会丢、会合并、会晚到。
- **防退化靠结构与精确计数**：资源泄漏用所有者出具的账本 + 精确计数断言（churn 后须一分不差回基线），不依赖粗粒度指标（总内存）；运行时警告即测试失败，不当日志噪声。
- **每个发现的问题都固化测试**：修复必须附带红→绿验证过的回归测试（单测或 e2e），否则不算修完。

## 工程执行经验（吸收自上游 dimina `docs/Experience-Review.md`，下游适配）

上游把长期经验沉淀在 `dimina/docs/Experience-Review.md`（`dimina/AGENTS.md` 指向它）。涉及框架/渲染/编译/native 语义的任务先读原文；以下是对本 devtools 直接适用的提炼：

- **在正确的层级修问题**：先判定 bug 属上游框架/编译器/运行时/native，还是 kit 适配层（devtools/devkit/simulator/compiler shim）。属上游语义的能力，在 kit 的 adapter/shim 层补齐或上报上游，**绝不在 demo / 业务代码里打补丁**；业务侧加一行只当定位线索，最终把能力补回正确层级。
- **禁止硬编码作为长期方案**：路径（`/wx`、`/dd`）、字段名、固定延时、固定高度/偏移、平台目录都不写死；从编译产物、配置、运行时状态、API 返回、平台能力或官方规范推导。为单一 case 加特判前，先证明它是框架语义的一部分。
- **语义对齐微信/官方，不凭直觉重写**：小程序生命周期、组件/属性 observer、API 行为、service/render 双线程消息顺序，优先查微信官方文档与上游源码/编译产物；跨端差异查平台适配层，不假设各端实现一致。兼容语义 > 局部代码简洁。
- **不用延时掩盖时序问题**：`setTimeout` / 多次 `nextTick` / 固定 animation frame 绕过时序 = 只暴露了 bug，不是修复。画清 service/render 双线程里 事件产生→注册→消费→渲染→测量 的链路，让顺序本身成立。
- **验证覆盖相邻回归 + 视觉验收**：改框架/渲染至少验证原始复现 + 相邻组件 + 同链路历史回归点；UI/渲染问题以最终画面/DOM/截图为准，"构建成功 / 无异常"不算完成，"无报错但内容为空"是失败。
- **先读当前状态，不凭记忆**：开工先看 `git status`、相关源码、编译产物、日志、最近提交、submodule HEAD；"之前正常最近坏了"走 git diff / history / bisect，不擅自回滚用户改动。
- **日志是定位工具不是实现**：需要时加统一前缀 + 结构化字段 + 关键时序点，修复后移除临时调试日志，只留必要异常 / 可观测点。

## Submodule Protection

- **DO NOT** modify any files under the `dimina/` submodule directory unless explicitly approved by the developer.
- If a task appears to require changes to `dimina/` submodule code, **ask the developer first** before making any modifications.
- When possible, implement changes in `packages/devtools/`, `packages/devkit/`, or other workspace packages instead of modifying the submodule.
- **一旦获批修改 `dimina/` 代码，必须遵循上游 `dimina/AGENTS.md`**（`dimina/docs/Experience-Review.md`），保持与上游工程约定一致。

## 提交前必跑 lint（Lint gate）

- 改完代码、提交/开 PR **之前**，在受影响的包里跑一次 `pnpm lint`（devtools 的 CI `verify` 门禁是 `eslint . --max-warnings 0`，**1 个 warning 也会让 CI 红**）。typecheck / test 全绿不代表 lint 过。
- 还要在仓库根跑一次 `pnpm pawl:check`（CI 同名门禁，独立于 lint；引擎是 [pawl](https://github.com/tiangong-dev/pawl)，`pnpm pawl:*` 是 `pawl {check,record,diff}` 的别名）。它按 baseline 卡八项**只能持平或变好**：`cognitive-complexity` / `file-length`（**单文件 > 500 行就计数，包括新增测试文件**）/ `type-coverage` / `type-escapes`（`as any` / `@ts-` 等）/ `code-duplication` / `circular-deps` / `test-report`（各套件通过测试数）/ `test-coverage`（各套件 lines 覆盖率，全 src 分母，±1 个百分点容差）。任一维度变差即红（有容差的维度超出容差才红）；无法诚实测量（adapter 崩溃/超时/缺工件）则退出码 2，绝不当成"测得零"。新文件别越过 500 行。`test-report` / `test-coverage` 读 `pnpm test` 产出的工件（`test-report*.json` / `coverage/coverage-summary.json`），本地没跑过测试时会 fail loud 提示先跑。维度用 exec adapter 委托给 `tools/pawl/adapters/`（见 `tools/pawl/README.md`）；配置在 `pawl.yaml`，baseline 是仓库根的 `pawl.snapshot.json`。
- 新增根目录构建脚本（`build-*.mjs` / `build-*.js`）后，记得把文件名加进 `packages/devtools/eslint.config.js` 那份**按文件名授予 `globals.node` 的白名单**，否则 `process` 等会触发 `no-undef`。
- **判 gate 成败不要被管道骗**：管道会丢掉真实退出码（`cmd | tail` 的成败是 `tail` 的），命令链 / wrapper 也可能把非零码吞成 0，还有静默 skip（如未设 `HOT_RELOAD_STRESS=1` 时 stress spec 直接跳过却看似通过）。禁止用 `| tail` / `| head` 判 build / e2e / pawl / test 成败，改读完整输出末尾或结构化 reporter（playwright `stats.unexpected` / `test-report*.json`、vitest `test-report.json`、pawl 退出码本身）。（本机若装了透明命令代理如 rtk，它会进一步把非零码包装成 0，更要读 reporter。）
- **红了先复核干净基线再归因自己**：改动后 test / pawl / e2e 变红且怀疑是自己引入的回归时，先在干净 `origin/main`（或 `git stash`）跑同一条命令——本仓库历史多次出现 main 自身已破（合并事故、ratchet 快照过期、环境依赖缺失如 listr2）却被误判成新回归、白费排查。
- 在 worktree / 沙箱里构建或跑 e2e（含 `dimina` submodule）见 SKILL `dimina-kit-worktree-build`（前置步骤 + 误诊清单）。

## 注释规范（Comments）

注释只描述**问题本身 / 当前契约 / 不变量**，用**现在时**陈述代码"为什么这样、守护什么"。同样适用于测试的 `describe()` / `it()` 标题。

**不要写**（写了就删）：

- **作者 / 工具归属**：`codex`、`claude`、`Claude×codex`、`(codex m8)`、`by implementer`、`实现者补测`、`谁第几轮 review 发现的`。
- **阶段 / 流程标记**：`P0`–`P5`、`Phase N`、`Wave N`、`round-N`、`(BUG N)`、`condition N`、`PR #N`、指向文档的 `§章节号`。
- **过时的 TDD 红阶段标记**：`RED today`、`FAILING-FIRST`、`FAILING TDD spec`、`red phase`、`NOT-YET-WRITTEN/ADDED/WIRED`、`X does not exist yet`。功能实现、测试转绿后这些即失效——删掉，或改写成现在时描述测试守护的契约（如 `RED today: getFoo does not exist` → `Guards that getFoo exists`）。
- **无现实参考价值的历史叙述**：`previously we…`、`used to…`、`曾经`、`originally imported X from Y` 这类只讲"以前怎么写"的。

**要保留**：

- 解释"当前代码为何这样写"的**防回归理由**——保留理由本身，只剥掉归属 / 阶段编号。
- 描述**运行时瞬时状态**的正常英语，如 `writing a not-yet-existing file would throw ENOENT`、`if the path does not yet exist`（"not yet" 指运行时状态未发生，**不是**功能未实现）。
- 真实的技术细节、边界条件、不变量说明。

判断标准：读者只关心"这段代码 / 测试在解决什么问题"，不关心"谁在第几轮发现、当初是红是绿"。
