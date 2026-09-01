# Dimina Kit

> [Dimina](https://github.com/didi/dimina) 小程序的开发者工具集：一个可以调试小程序的桌面应用，以及构成它的那些可以单独使用的包。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/EchoTechFE/dimina-kit)

![Dimina DevTools](./docs/devtools.png)

## 这是什么

Dimina 是滴滴开源的小程序框架。dimina-kit 提供围绕它的开发期工具：

- **一个 Electron 桌面工具**（`@dimina-kit/devtools`）——打开小程序项目、在模拟器里运行、用 Chrome DevTools 调试，另有 WXML / AppData / Storage / Console 面板和一个内嵌的 VS Code 编辑器。
- **一组可独立使用的包**——编译、预览服务、热更新、原生视图布局这些能力都各自成包，可以脱离桌面工具，装进你自己的 Electron 宿主或 Node 工具链。

如果你只想调试小程序，看 [快速开始](#快速开始)；如果你想把其中某块能力嵌进自己的产品，看 [包一览](#包一览)。

## 快速开始

想直接用的话，[Releases](https://github.com/EchoTechFE/dimina-kit/releases) 里有打好的桌面工具：macOS（`.dmg`，Intel / Apple Silicon 各一份）、Windows（`.zip`）、Linux（`.tar.gz`）。

### 从源码构建

**环境要求**：Node 24（见 [`.node-version`](./.node-version)）、pnpm 9.15.9。

```bash
# 1. 克隆，注意带上 submodule —— 编译器构建会读取 dimina 子模块的源码
git clone --recurse-submodules https://github.com/EchoTechFE/dimina-kit.git
cd dimina-kit

# 2. 安装依赖：工作区一次，dimina/fe 一次
pnpm install
pnpm -C dimina/fe install

# 3. 构建 H5 容器，再构建全部包
pnpm --filter @dimina-kit/devtools build:container
pnpm build

# 4. 启动
pnpm --filter @dimina-kit/devtools start
```

日常开发用 `pnpm --filter @dimina-kit/devtools dev`，它会先构建，然后带 watch 启动 Electron。

只想用编译和 H5 预览、不需要桌面工具的话，`@dimina-kit/devkit` 可以直接从 npm 装：

```bash
pnpm add @dimina-kit/devkit
```

```typescript
import { openProject } from '@dimina-kit/devkit'

const session = await openProject({ projectPath: '/path/to/miniapp', port: 0 })
console.log(`预览地址: http://localhost:${session.port}`)
```

## 包一览

面向使用者的包：

| 包 | 说明 |
| --- | --- |
| [`@dimina-kit/devtools`](./packages/devtools) | Electron 桌面开发者工具本体：模拟器、Chrome DevTools 接入、内置调试面板、内嵌编辑器 |
| [`@dimina-kit/devkit`](./packages/devkit) | 编译小程序 + 起 H5 容器预览服务 + 文件监听热更新。可独立使用，也是 devtools 的编译后端 |
| [`@dimina-kit/compiler`](./packages/compiler) | dmcc 编译器的浏览器 / Node 双端打包产物，文件系统由调用方注入，因此可以在浏览器里编译 |
| [`@dimina-kit/electron-runtime`](./packages/dimina-electron-runtime) | 可嵌入的 dimina 小程序运行时，让任意 Electron 宿主跑小程序 |

面向宿主集成的基础设施：

| 包 | 说明 |
| --- | --- |
| [`@dimina-kit/electron-deck`](./packages/electron-deck) | Electron 装配框架：`electronDeck()` 单入口接管窗口、原生视图叠放、IPC 与生命周期 |
| [`@dimina-kit/workbench`](./packages/workbench) | 内嵌式 VS Code 编辑器（`@codingame/monaco-vscode-api`），带 WXML 语言特性与 dimina 配置的 JSON Schema |
| [`@dimina-kit/inspect`](./packages/inspect) | 与宿主无关的 WXML 树提取与检查：Vue 运行时遍历、稳定 id、DOM 变更观察 |
| [`@dimina-kit/view-anchor`](./packages/view-anchor) | 让主进程的原生视图（Electron `WebContentsView`）持续对齐某个 DOM 元素的几何位置 |
| [`@dimina-kit/design`](./packages/design) | devtools 那套外观：CSS 变量、基础样式、electron-deck 皮肤、Tailwind preset |
| [`@dimina-kit/fs-core`](./packages/fs-core) | 零依赖的 OPFS WAL 文件系统内核，供 Web 端使用 |

仓库内部使用、不发布：`@dimina-kit/eslint-config`、`@dimina-kit/typescript-config`，以及防劣化工具 [`tools/pawl`](./tools/pawl)。

## 仓库结构

```
packages/     上面列出的所有包
dimina/       dimina 上游框架（git submodule，本仓库不修改它）
tools/pawl    防劣化门禁工具
scripts/      仓库级脚本
```

pnpm workspace + turbo。常用命令都在仓库根目录跑：

```bash
pnpm build          # 构建全部包
pnpm test           # 跑全部单元测试
pnpm lint           # ESLint
pnpm check-types    # TypeScript 类型检查
pnpm pawl:check     # 防劣化门禁（复杂度 / 类型逃逸 / 类型覆盖率 / 文件长度）
```

## Contributing

欢迎 issue 和 PR，先读 [CONTRIBUTING.md](./CONTRIBUTING.md)。

CI 会跑 lint、类型检查、测试和一道防劣化门禁——这些指标只允许持平或变好。

## License

[MIT](./LICENSE) © EchoTechFE and dimina-kit contributors

第三方依赖的许可声明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
