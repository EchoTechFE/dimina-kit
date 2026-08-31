# VS Code 工作台的 dd/wx 类型提示

## 当前实现

工作台源码位于 `packages/workbench/`。它把活动项目镜像到
`file:///workspace` 的内存文件系统；web tsserver 因而能把该 URI 当作项目根，
读取项目配置和 ambient 类型
（`packages/workbench/src/workspace/disk-workspace-source.ts:1-18`、
`packages/workbench/src/fs-bridge.ts:11-18`）。

dd/wx 类型以真实 memfs 文件写入：

```
file:///workspace/node_modules/@types/dimina/package.json
file:///workspace/node_modules/@types/dimina/index.d.ts
```

写入逻辑在 `packages/workbench/src/typings-injection.ts:78-114`。这些文件只存在于
工作台 memfs；保存回磁盘时会跳过 `node_modules/**` 和被工作台调整过的项目配置，
不会污染用户项目
（`packages/workbench/src/fs-bridge.ts:75-99`）。

## 配置文件处理

如果 workspace 内存在 `tsconfig.json` 或 `jsconfig.json`，
`seedAmbientTypings` 会在 memfs 副本里把内置和下游类型包名合并进
`compilerOptions.types`。已有顺序保留，包名去重；即使用户原来写了
`types: []`，工作台仍加入自身提供的类型
（`packages/workbench/src/typings-injection.ts:85-132`）。

没有 config 时不额外创建配置文件；inferred project 直接发现
`node_modules/@types/*`
（`packages/workbench/src/typings-injection.ts:123-132`）。

## 下游类型

宿主可通过 `EditorViewConfig.extensionsDir` 提供 VS Code web 扩展
（`packages/devtools/src/shared/types.ts:283-292`）。扩展在
`package.json` 中声明：

```jsonc
{
  "name": "host-editor",
  "publisher": "host",
  "browser": "./extension.js",
  "diminaWorkbench": {
    "typings": ["types/host.d.ts"]
  }
}
```

`registerContributedExtensions` 只接受 manifest 文件清单中的 typings 路径，
把同一扩展声明的内容合成独立的 `@types/<sanitized-name>` 包，再和内置
`@types/dimina` 一起注入
（`packages/workbench/src/contributed-extensions.ts:56-120`、
`packages/workbench/src/boot.ts:463-477`）。

## TypeScript web 扩展运行条件

工作台的项目级 IntelliSense 依赖 `SharedArrayBuffer`。当前接线同时提供：

- Electron 启动开关 `--enable-features=SharedArrayBuffer`
  （`packages/devtools/src/main/app/app.ts:425-429`）。
- 工作台文档的 COOP/COEP/CORP 响应头
  （`packages/devtools/src/main/services/workbench-coi-server.ts:72-76`）。
- 对 TypeScript language-features 扩展的 gate patch；构建脚本把能力检查改为
  `typeof SharedArrayBuffer !== 'undefined'`
  （`packages/workbench/scripts/patch-ts-ext.mjs:1-48`）。
- ext-host、editor 与 textmate 使用独立 worker URL
  （`packages/workbench/src/monaco-environment.ts:1-35`）。

workbench 构建在 prebuild 阶段运行 patch，devtools 的 `build:workbench` 再调用
`@dimina-kit/workbench` 的 app build
（`packages/workbench/package.json:47-55`、
`packages/devtools/build-workbench.mjs:15-23`）。

patch 为什么必要、以及为什么改的是能力检查而不是去满足 `crossOriginIsolated`，
写在脚本自己的文件头里（`packages/workbench/scripts/patch-ts-ext.mjs:1-16`）：
扩展把项目级 IntelliSense 门控在 `globalThis.crossOriginIsolated` 上，而 Electron
即使发齐 COOP/COEP 也翻不动这个值；它真正依赖的是 SharedArrayBuffer + Atomics，
那个 Electron 用启动开关单独提供。要判断这个 patch 还需不需要，读那段文件头。

## 相关能力

WXML completion/hover 与 dimina JSON schemas 在工作台启动时独立注册；其中一个失败
不会跳过另一个
（`packages/workbench/src/boot.ts:430-446`）。

工作台 boot 完成后先填充 workspace 和 ambient typings，再安装自动保存并探测扩展宿主
（`packages/workbench/src/boot.ts:463-484`）。
