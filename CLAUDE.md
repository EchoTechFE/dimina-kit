# Claude Code Rules

## Submodule Protection

- **DO NOT** modify any files under the `dimina/` submodule directory unless explicitly approved by the developer.
- If a task appears to require changes to `dimina/` submodule code, **ask the developer first** before making any modifications.
- When possible, implement changes in `packages/devtools/`, `packages/devkit/`, or other workspace packages instead of modifying the submodule.

## 提交前必跑 lint（Lint gate）

- 改完代码、提交/开 PR **之前**，在受影响的包里跑一次 `pnpm lint`（devtools 的 CI `verify` 门禁是 `eslint . --max-warnings 0`，**1 个 warning 也会让 CI 红**）。typecheck / test 全绿不代表 lint 过。
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
