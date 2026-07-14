# Claude Code Rules

## 设计与修复原则（Design principles）

- **模型承认现实**：数据结构与运行时现实不符（如单值 map 承载多对多关系）时改模型本身，不用特判/补丁续命——补丁数量会随现实复杂度无限增长。
- **单一真相源**：同一份状态或判断只允许一个权威（一个判据函数、一个状态机、一个调度器）。发现两处各自判断/各自管理同一事实，即是重构信号，不是加第三处的理由。
- **同类 bug 第二次出现即建权威抽象**：让这类错误"结构上犯不了"（如监听器统一登记、注入统一过闸），而不是再修一个实例。
- **状态与事实同步**：状态标记在事实发生的那一刻置位（如资源"已使用"在导航发生时标记），不等整个流程成功——迟置位的标记会在错误路径上撒谎。
- **防退化靠结构与精确计数**：资源泄漏用所有者出具的账本 + 精确计数断言（churn 后须一分不差回基线），不依赖粗粒度指标（总内存）；运行时警告即测试失败，不当日志噪声。
- **每个发现的问题都固化测试**：修复必须附带红→绿验证过的回归测试（单测或 e2e），否则不算修完。

## Submodule Protection

- **DO NOT** modify any files under the `dimina/` submodule directory unless explicitly approved by the developer.
- If a task appears to require changes to `dimina/` submodule code, **ask the developer first** before making any modifications.
- When possible, implement changes in `packages/devtools/`, `packages/devkit/`, or other workspace packages instead of modifying the submodule.

## 提交前必跑 lint（Lint gate）

- 改完代码、提交/开 PR **之前**，在受影响的包里跑一次 `pnpm lint`（devtools 的 CI `verify` 门禁是 `eslint . --max-warnings 0`，**1 个 warning 也会让 CI 红**）。typecheck / test 全绿不代表 lint 过。
- 还要在仓库根跑一次 `pnpm ratchet:check`（CI 同名门禁，独立于 lint；引擎是 [pawl](https://github.com/tiangong-dev/pawl)，`pnpm ratchet:*` 是 `pawl {check,record,diff}` 的别名）。它按 baseline 卡八项**只能持平或变好**：`cognitive-complexity` / `file-length`（**单文件 > 500 行就计数，包括新增测试文件**）/ `type-coverage` / `type-escapes`（`as any` / `@ts-` 等）/ `code-duplication` / `circular-deps` / `test-report`（各套件通过测试数）/ `test-coverage`（各套件 lines 覆盖率，全 src 分母，±1 个百分点容差）。任一维度变差即红（有容差的维度超出容差才红）；无法诚实测量（adapter 崩溃/超时/缺工件）则退出码 2，绝不当成"测得零"。新文件别越过 500 行。`test-report` / `test-coverage` 读 `pnpm test` 产出的工件（`test-report*.json` / `coverage/coverage-summary.json`），本地没跑过测试时会 fail loud 提示先跑。维度用 exec adapter 委托给 `tools/ratchet/adapters/`（见 `tools/ratchet/README.md`）；配置在 `pawl.yaml`，baseline 是仓库根的 `pawl.snapshot.json`。
- 新增根目录构建脚本（`build-*.mjs` / `build-*.js`）后，记得把文件名加进 `packages/devtools/eslint.config.js` 那份**按文件名授予 `globals.node` 的白名单**，否则 `process` 等会触发 `no-undef`。

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
