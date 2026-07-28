# Contributing

支持 AI 辅助贡献，AI 辅助生成的 commit 必须添加 co-authored-by 字段，提交者对代码负责。

CI 含一道防劣化关卡（`pnpm pawl:check`）：复杂度、类型逃逸、类型覆盖率、文件长度只能持平或变好；用法见 [`tools/pawl`](./tools/pawl/README.md)。
