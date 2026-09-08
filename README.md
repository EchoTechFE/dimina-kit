# Dimina Kit

> 为 [Dimina](https://github.com/didi/dimina) 小程序准备的开发者工具：既能直接调试，也能把编译、预览和运行能力接入自己的产品。

[![CI](https://github.com/EchoTechFE/dimina-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/EchoTechFE/dimina-kit/actions/workflows/ci.yml)
[![Latest Release](https://img.shields.io/github/v/release/EchoTechFE/dimina-kit)](https://github.com/EchoTechFE/dimina-kit/releases/latest)
[![Release Downloads](https://img.shields.io/github/downloads/EchoTechFE/dimina-kit/total)](https://github.com/EchoTechFE/dimina-kit/releases)
[![npm](https://img.shields.io/npm/v/%40dimina-kit/devkit)](https://www.npmjs.com/package/@dimina-kit/devkit)
[![Node](https://img.shields.io/badge/node-24-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-12.3.4-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

![Dimina DevTools](./docs/devtools.png)

[下载桌面工具](https://github.com/EchoTechFE/dimina-kit/releases) · [使用开发包](#嵌入开发包) · [产品主页](https://echotechfe.github.io/dimina-kit/)

## 选择你的用法

### 直接调试小程序

下载 [Dimina DevTools](https://github.com/EchoTechFE/dimina-kit/releases)：macOS 提供 Intel 和 Apple Silicon 的 `.dmg`，Windows 提供 `.zip`，Linux 提供 `.tar.gz`。打开项目后，可以在同一窗口使用模拟器、WXML、AppData、Storage、Console 和编译面板；AppData 支持编辑后写回，也可接入 Chrome DevTools，并用内嵌编辑器修改代码。

### 接入自己的产品

把编译、H5 预览、热更新或 Electron 运行能力接进自己的宿主或 Node 工具链。面向此类使用场景的包见 [包一览](#包一览)。

## 从源码启动

**环境要求**：Node 24（见 [`.node-version`](./.node-version)）、pnpm 12.3.4。

```bash
# 1. 克隆，注意带上 submodule —— 编译器构建会读取 dimina 子模块的源码
git clone --recurse-submodules https://github.com/EchoTechFE/dimina-kit.git
cd dimina-kit

# 2. 安装依赖：两个 workspace 会按各自 packageManager 选择 pnpm 版本
pnpm install
(cd dimina/fe && pnpm install --no-frozen-lockfile)

# 3. 构建 H5 容器，再构建全部包
pnpm --filter @dimina-kit/devtools build:container
pnpm build

# 4. 启动
pnpm --filter @dimina-kit/devtools start
```

日常开发用 `pnpm --filter @dimina-kit/devtools dev`，它会先构建，然后带 watch 启动 Electron。

## 嵌入开发包

只需要编译和 H5 预览、不需要桌面工具时，直接从 npm 安装 `@dimina-kit/devkit`：

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
| [`@devicekit/devices`](https://www.npmjs.com/package/@devicekit/devices) | 手机和平板的机型表：屏幕、像素比、状态栏、安全区、挖孔、UA，以及页面可用尺寸的换算。不碰 DOM。已独立为开源项目（[EchoTechFE/devicekit](https://github.com/EchoTechFE/devicekit)） |
| [`@devicekit/frame`](https://www.npmjs.com/package/@devicekit/frame) | `<device-frame>` 自定义元素：画机身、状态栏和挖孔，留出标题栏和 tab 栏，报出 webview 该摆在哪。已独立为开源项目（[EchoTechFE/devicekit](https://github.com/EchoTechFE/devicekit)） |
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
