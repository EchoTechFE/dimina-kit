---
name: dimina-kit-worktree-build
description: 在 git worktree 或干净沙箱里构建 / 跑 e2e（含 dimina submodule）时的前置步骤与误诊清单。当你要在非主工作目录构建、跑 playwright e2e，或遇到 build:container 报 submodule 未初始化、native-host e2e 字段 undefined、devkit/compiler 测试因 dist 缺失而失败、pawl:check 退出码 2 时使用。
---

# dimina-kit worktree / 沙箱构建 runbook

本仓库把上游 `dimina/` 作为 **submodule**，且 `dimina/fe` 是一个**独立的 pnpm workspace**（不在根 `packages/*` 里）。全量 `pnpm build`（= `turbo run build`）里 `@dimina-kit/devtools` 的第一步就是 `build:container`（`node build-container.js`），它从 `dimina/fe/packages/container` 构建。新 worktree 不会自动带上这些，漏一步的典型表现是**看起来无关的另一个假故障**——所以先照下面做，再把红当真回归查。

## 一、标准搭建顺序（新 worktree 必做）

worktree 新建后 `dimina/` 是空的，`dimina/fe/node_modules` 也没有：

```bash
git submodule update --init dimina          # 漏这步：build-container.js 会 fail-fast 报 “dimina submodule is not initialized” 退出（历史上无此守卫时 pnpm 会向上走错 workspace、递归 turbo build 直到 OOM）
pnpm -C dimina/fe install                   # dimina/fe 是独立 pnpm workspace，必须单独装（用 -C 而非 cd：命令自包含，避免 cwd 继承误判）
pnpm install                                # 根 workspace
```

## 二、构建：两条路径，按“版本匹配”取舍

- **在 worktree 内真构建**（改了 submodule 内容、或需要与本 worktree 的 submodule commit 版本一致的容器时）：
  ```bash
  # build:container 若因 submodule 未就绪而报错退出，绕过它、逐个构建其余产物：
  pnpm -C packages/devtools run build:main
  pnpm -C packages/devtools run build:preload
  pnpm -C packages/devtools run build:renderer
  pnpm -C packages/devtools run build:simulator
  pnpm -C packages/devtools run build:native-host
  pnpm -C packages/devtools run build:workbench
  # 需要容器产物时强制构建：inputFingerprint 缓存本身会追踪 submodule HEAD + 工作区改动（改了就自动重建），DIMINA_FORCE_BUILD=1 只是强制绕过 fresh-cache 命中：
  DIMINA_FORCE_BUILD=1 node packages/devtools/build-container.js
  ```
- **复用已构建产物**（只改了 kit 代码、submodule commit 与某个已构建 checkout 一致时，最快）：从那个 checkout rsync 已构建的 dist，再逐个 `build:main/preload/renderer/simulator/native-host`（跳过 `build:container`）：
  ```
  packages/devtools/dist
  packages/devkit/fe/dimina-fe-container
  dimina/fe/packages/{service,common,render,container,compiler,components}/dist
  ```
  **⚠️ 版本必须匹配**：rsync 来的容器/服务产物版本要与本 worktree 的 submodule commit 一致，否则 native-host e2e 会整片返回 `undefined` 字段——这是环境性假失败，不是代码回归。唯一根治法是在 worktree 内构建版本匹配的容器。
- `dimina/fe` 已 init 但未装依赖时 `build:container` 会因缺 vite/依赖而构建失败。`@dimina-kit/compiler` 的 dist 依赖 submodule 源码；纯改 kit 时可直接拷主仓库 compiler dist。

## 三、误诊清单（出现下列现象，先回查上面漏没漏步骤，再当真回归）

- `build:container` 报 `dimina submodule is not initialized` 或异常退出 → submodule 没 `--init`（空 `dimina/fe`）。
- devkit / compiler 集成测试报 `dist/pool.node.js` 缺失、`MODULE_NOT_FOUND`、TS2307 → 对应包没 build（compiler 依赖 submodule 源码）。
- native-host e2e 字段全是 `undefined` → 容器产物与本 worktree submodule commit 版本不匹配。
- `pawl:check` 退出码 2 → 只跑了部分包、缺工件，是 **fail-loud 不是回归**（pawl 缺工件绝不当“测得零”）。
- playwright 报 “two different versions” → 根的 `.bin/playwright` 与 worktree 自己 `node_modules/.pnpm/playwright` 混用了；统一用 worktree 自己的 `.bin/playwright`。
- 多分支合并后 lint 报 eslint 未声明 devDep / `MODULE_NOT_FOUND` → `git checkout origin/main -- pnpm-lock.yaml` 重置后重装。

## 四、判成败别被管道骗

gate 类命令（build / e2e / pawl / test）**禁止**用 `| tail` / `| head` 判通过与否——管道丢真实退出码，命令链 / wrapper 也可能把非零码吞成 0，还有静默 skip（如未设 `HOT_RELOAD_STRESS=1` 时 stress spec 直接跳过却看似通过）。判成败读**完整输出末尾**或结构化 reporter：playwright `stats.unexpected` / `test-report*.json`、vitest `test-report.json`、pawl 退出码本身。多步命令用 `pnpm -C` / `git -C` / 绝对路径（自包含，别依赖 cwd 继承）。详见 CLAUDE.md「提交前必跑 lint」段。
