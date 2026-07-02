# @dimina-kit/web-compiler

把小程序源码编译成 dimina 产物的编译器——**不需要真实文件系统**，因此既能在浏览器（Web Worker）里跑，也能在 Node 里跑。

它本身不重写编译逻辑：真正干活的是 `dimina` 子模块 fe workspace 里的 `@dimina/compiler`，那套代码通篇 `import fs from 'node:fs'` + `fs.xxx`。本包把 `node:fs` 换成一个**转发 shim**，并且**自己不带任何 fs 实现**——**由下游注入一个 `node:fs` 替代品**（`compileMiniApp({ fs })`），compiler 一行不改就跑在你的 fs 上；项目目录（`workPath`）也由下游指定。最省事的 fs 就是 [memfs](https://github.com/streamich/memfs)。

产出两个自包含 bundle：

| 入口 | 产物 | 运行环境 | wasm 工具链 |
| --- | --- | --- | --- |
| `@dimina-kit/web-compiler` | `dist/compile-core.node.js` | Node | 原生 esbuild/oxc 保持 external，运行时从 node_modules 解析 |
| `@dimina-kit/web-compiler/browser` | `dist/compile-core.browser.js` | 浏览器 / Worker | 不打包，由宿主 worker 注入（见下） |

## 用法

### API

```ts
compileMiniApp(options: {
  fs: DiminaFs        // 必填：下游注入的 node:fs 替代品，已 seed 好项目源码
  workPath?: string   // 项目根（下游 seed 源码的目录），默认 '/work'
}): Promise<{
  appId: string
  name: string
  files: Record<string, string>   // 产物：相对产物根的路径 → 内容
}>

initToolchain(): Promise<void>     // 占位，保持 API 稳定；浏览器版由宿主注入 wasm 工具链
```

`fs` 是唯一入口：compiler 的每一次读写都落到你传入的 fs 上，产物也写回它、编译完由本包遍历取出。下游要实现的同步子集（基于 compiler 的实际调用面）：

```ts
interface DiminaFs {
  // 读
  existsSync(path): boolean
  readFileSync(path, 'utf8'): string
  readdirSync(path): string[]
  readdirSync(path, { withFileTypes: true }): Dirent[]   // Dirent 带 isDirectory()/isFile()
  statSync(path): { isFile(): boolean; isDirectory(): boolean }
  // 写（compiler 把产物写回 fs）
  writeFileSync(path, data): void
  mkdirSync(path, { recursive }): void
  copyFileSync(src, dest): void
  rmSync(path, { recursive, force }): void
}
```

> 全部**同步**：`compileMiniApp` 可达的编译路径上 compiler 只用同步 fs（唯一的 callback 版 `fs.readdir` 在 CLI/watch 路径，不经此入口）。所以异步后端（网络 / IndexedDB 的异步 API）实现不了 `readFileSync`。

### Node（用 memfs 当 fs）

memfs 完整实现了上面的契约，`Volume.fromJSON(files, cwd)` 的第二参就是项目目录，键写相对路径即可：

```js
import { Volume, createFsFromVolume } from 'memfs'
import { compileMiniApp } from '@dimina-kit/web-compiler'

const workPath = '/project'                    // 项目目录由下游决定
const vol = Volume.fromJSON({
  'app.json': JSON.stringify({ pages: ['pages/index/index'] }),
  'pages/index/index.js': 'Page({})',
  'pages/index/index.wxml': '<view>hello</view>',
  'pages/index/index.wxss': '.x{color:red}',
}, workPath)

const { appId, name, files } = await compileMiniApp({
  fs: createFsFromVolume(vol),
  workPath,
})
```

Node 下 compiler 的原生 `esbuild` / `oxc-parser` 等保持 external，运行时需能从 node_modules 解析（做法见 `scripts/kit-resolve-hook.js`）。

### 浏览器 / Worker

浏览器 bundle 刻意不打包 wasm 工具链（把 esbuild-wasm、oxc-parser 的 wasm 内联进单个 bundle 会破坏它们的运行时）。宿主 worker **先注入 wasm hook，再建 fs、编译**：

```js
// 1. 宿主以 pristine 方式加载 wasm 工具链并挂到全局
globalThis.__esbuildTransform = (input, options) => esbuild.transform(input, options)
globalThis.__oxcParseSync = oxcParseSync

// 2. worker 自带 memfs（或任意 DiminaFs 实现），seed 源码
import { Volume, createFsFromVolume } from 'memfs'
import { compileMiniApp, initToolchain } from '@dimina-kit/web-compiler/browser'

await initToolchain()                          // no-op，仅为兼容保留
const vol = Volume.fromJSON(files, '/project') // files: { 相对路径: 内容 }
const result = await compileMiniApp({ fs: createFsFromVolume(vol), workPath: '/project' })
```

## fs 契约与约定

- **本包不带 fs 实现。** `src/shims/fs.js` 是个转发层，`compileMiniApp({ fs })` 在一次编译期间把 compiler 的 `fs.xxx` 指向你的 fs（`setFs`/`resetFs`）；不注入则任何 `fs.*` 调用直接抛错。
- **项目目录由下游定。** `workPath`（默认 `/work`）就是你 seed 源码的目录；产物写在编译器的 `targetPath` 下，本包遍历 `fs` 把该前缀下的文件读出、还原成相对路径返回。
- **只走文本。** 键=相对路径、值=文本内容；二进制资源（图片等）要由你的 fs 自己写进去——本包只负责编译，不搬运二进制。
- **产物写回同一个 fs。** compiler `writeFileSync` 把产物写进你的 fs，所以传入的 fs 必须可写。
- **同步契约，不需要 `fs.promises`。** `DiminaFs` 只要求上面那些**同步**方法——`compileMiniApp` 的编译路径不碰任何 async fs，所以你的 fs 实现**不必**提供 `promises`。（本包为满足 `node:fs/promises` 这个别名保留了一个 `.promises` 门面，只是把调用转发到你 fs 的 `promises`；当前编译路径一次都不会走到它。）反过来，纯异步后端——只有 Promise 版读写、没有同步方法——**没法**当 fs 用，因为 `readFileSync` 这类同步调用是硬要求。

`@dimina/compiler` 自己并不知道 fs 被换掉了。

## 依赖前置

编译器实体源码在 `dimina` 子模块里，dart-sass 等在其 fe workspace。构建前确保子模块已初始化、依赖已装：

```bash
git submodule update --init dimina
pnpm install
```

## 构建

```bash
pnpm --filter @dimina-kit/web-compiler build          # node + browser
pnpm --filter @dimina-kit/web-compiler build:browser  # 仅浏览器版
pnpm --filter @dimina-kit/web-compiler build:node     # 仅 node 版
```

## 测试

测试里用 memfs 扮演「下游 fs」：

```bash
pnpm --filter @dimina-kit/web-compiler test:node   # Layer1: 编译 base 示例、校验产物
pnpm --filter @dimina-kit/web-compiler test:appid  # appId fallback 守卫
```

## 结构

- `src/compile-core.js` — 内联编排 dmcc 的 compile 函数；校验并 `setFs` 注入的 fs、编译后遍历 fs 收产物。相对路径引用同仓 `dimina` 子模块的 compiler 源码。
- `src/browser-entry.js` — 浏览器入口，`compileMiniApp()` + `initToolchain()`。
- `src/shims/fs.js` — **无后端的 fs 转发层**（`setFs`/`resetFs`/`getFs`）；compiler 所有 `fs.xxx` 走它，未注入即抛错。
- `src/shims/*` — 其余 node 内置与原生依赖的浏览器替身（oxc/esbuild/less/…）。
- `scripts/build-compiler.js` — esbuild 打包（含 onLoad 给 logic-compiler 追加导出，不改子模块源码）。
- `scripts/{register-kit,kit-resolve-hook}.js` — node 测试用的 ESM resolve hook（从 dimina-kit workspace 根解析 bare 依赖）。
