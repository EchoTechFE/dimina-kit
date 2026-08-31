# Contributing

欢迎给 dimina-kit 提交 issue 和 PR。这是仓库级别的贡献指南；只想给桌面工具 `@dimina-kit/devtools` 贡献代码，还可以看它自己的[贡献者指南](./packages/devtools/docs/contributing.md)（代码结构、按模块的构建命令、调试与安全边界）。

## 准备环境

克隆时带上 submodule（编译器构建要读 `dimina/` 子模块的源码），装两遍依赖：

```bash
git clone --recurse-submodules https://github.com/EchoTechFE/dimina-kit.git
cd dimina-kit
pnpm install
pnpm -C dimina/fe install
```

环境要求见根 [README](./README.md#从源码构建)（Node 版本、pnpm 版本）。`dimina/` 是 git submodule，本仓库不修改它的内容。

## 分支与提交

- 从 `main` 切分支，命名 `<type>/<summary>`（如 `fix/devtools-console-denoise`、`feat/host-layout-slots`）。
- 提交信息遵循 Conventional Commits：`<type>(<scope>): <说明>`，`type` 用 `feat`/`fix`/`chore`/`docs`/`refactor`/`style`/`test`/`ci` 等，`scope` 可选（通常是包名，如 `devtools`、`compiler`），说明可以用中文。
- 支持 AI 辅助生成代码，但 AI 辅助生成的 commit 必须带 `Co-authored-by` 字段，提交者对代码负责。

## 提交 PR 前

从仓库根目录跑一遍全量门禁：

```bash
./scripts/gate.sh
```

它按 `lint → typecheck → test → pawl:check` 顺序跑完根 `package.json` 里的对应脚本，任一步失败就停在那一步并打印日志路径。也可以单独跑其中一步（`pnpm lint`、`pnpm check-types`、`pnpm test`、`pnpm test:coverage`）。

`pawl:check` 是防劣化关卡：新增或扩写 `packages/*/src/**/*.{ts,tsx}` 时，文件长度（阈值 500 行）、类型逃逸、认知复杂度等维度只能持平或变好，用法见 [`tools/pawl`](./tools/pawl/README.md)。

## PR 要求

- 一个 PR 只做一件可独立验证的事；不要在同一个 PR 里混无关的重构和 lint 修复。
- PR 描述清楚说明改了什么、为什么改；涉及行为变化的改动附上验证方式（跑了哪些测试、e2e 或手工验证步骤）。
- CI（`.github/workflows/ci.yml`）会跑 lint、typecheck、测试和防劣化关卡，请确保本地 `./scripts/gate.sh` 先过一遍再推送。
