---
name: dimina-kit-worktree-build
description: 在 dimina-kit 的 git worktree/沙箱中准备 submodule、双 pnpm workspace、native-host/compiler 产物和 Playwright e2e。用于非主工作目录构建、缺 dist、字段全 undefined、Playwright 双版本或 pawl exit 2。
---

# dimina-kit worktree 构建

本仓库的 `dimina/` 是 submodule，`dimina/fe` 是独立 pnpm workspace。新 worktree 不会自动具有 submodule 内容、两套依赖和构建产物。

## 准备

在目标 worktree 中依次执行：

```bash
git -C <worktree> submodule update --init dimina
pnpm -C <worktree>/dimina/fe install
pnpm -C <worktree> install
```

记录：主仓库 HEAD、`dimina` submodule HEAD、两份 lockfile hash、Node/pnpm 版本。缺一项时不要把后续红灯直接归因于代码。

## 按改动面构建

- kit devtools：使用 `pnpm -C <worktree>/packages/devtools build`，它包含 container、main、preload、renderer、simulator、native-host 和 workbench。
- 只需要某个 devtools 产物时使用对应 `build:*`，但测试报告必须写明未构建的部分。
- kit compiler：`pnpm -C <worktree>/packages/compiler build:node` 或 `build`。compiler 测试脚本通常会先调用 `scripts/build-compiler.js`，不要绕过该层直接测旧 dist。
- 修改了 `dimina/fe` 源码时，必须在当前 worktree 内重建使用它的 container/native-host/compiler 产物。

## 产物来源

当前仓库还没有统一 artifact manifest，因此默认不从其他 checkout/worktree rsync `dist`。只有能够同时证明主仓库 HEAD、submodule HEAD、相关 dirty diff、lockfile 和工具链一致时才可临时复用，并把证据写入验证报告；缺任何一项就本地重建。

“文件存在”不证明产物新鲜。native-host e2e 大片字段为 `undefined` 时，先检查 bundle 与 submodule/源码是否匹配。

## 常见环境事实

- `build:container` 报 submodule 未初始化：先补 `git submodule update --init dimina`。
- 缹 vite/依赖：确认 `dimina/fe` 和根 workspace 都已 install。
- `dist/pool.node.js`、`MODULE_NOT_FOUND`、TS2307：对应 compiler/devkit 产物未构建。
- Playwright “two different versions”：只使用当前 worktree 自己的 `node_modules/.bin/playwright`。
- pawl exit 2：工件缺失或测量链失败，是“无法测量”，不是普通回归。

不要通过 checkout 主分支 lockfile、stash 用户改动或复制来源不明的 dist 修环境。需要干净基线时只使用已有独立工作区；没有就记录“预存与否未验证”。

## 验证

完整交付走 `<worktree>/scripts/gate.sh`；e2e 额外读取本次结构化 reporter、测试数和 skip。禁止通过 `| head`/`| tail` 判断成败。Electron/模拟器进程由本次任务负责清理。
