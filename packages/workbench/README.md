# @dimina-kit/workbench

Dimina 的内嵌式 VS Code 工作台编辑器，基于 [`@codingame/monaco-vscode-api`](https://github.com/CodinGame/monaco-vscode-api)（v34）。在 devtools 与 web 客户端之间共用同一套编辑器：WXML 语言特性、`dd`/`wx` 类型提示、dimina 配置文件（app.json / 页面 *.json / project.config.json）的 JSON Schema、自动保存。

宿主之间唯一的差异是**工作区文件源**，通过 `WorkspaceSource` 注入；其余（服务装配、worker 接线、用户配置、主题）都在包内。

## 两种消费形态

### 1. 源码 API（宿主自己用 Vite 打包）

```ts
import { bootWorkbench, inMemorySeedSource } from '@dimina-kit/workbench'

await bootWorkbench({
  container: document.getElementById('workbench')!,
  workspace: inMemorySeedSource({ fetchUrl: '/demo/base-app.json' }),
  theme: 'dark',
})
```

宿主的 `vite.config` 合入共享预设即可——`@dimina-kit/workbench/vite` 以**构建后的 JS** 发布（纯 Node 模块，可直接从 vite.config 里 import，不会有 `.ts` 加载报错）：

```ts
import { defineConfig, mergeConfig } from 'vite'
import { workbenchVitePreset } from '@dimina-kit/workbench/vite'

export default defineConfig(mergeConfig(workbenchVitePreset(), {
  // 宿主自己的配置
}))
```

预设一次性覆盖 monaco/vscode 的全部打包细节，宿主无需手动接线：CSS 内联、worker ES 输出、`@codingame/*` + `monaco-editor` + `vscode` 的 `resolve.dedupe`（避免第二份 service 实例）、dev 下 ext-host iframe 与 `onig.wasm` 的静态资源服务、以及默认扩展包的 `optimizeDeps` 取舍。

> 注意：主入口 `@dimina-kit/workbench`（`bootWorkbench` 等）**以 TS 源码消费**，由宿主自己的
> Vite 打包，且只在浏览器 + Vite 环境可用（纯 Node `import`/`require` 会失败）。它引用
> `?worker&url` worker 与浏览器全局（`MonacoEnvironment`/`document`），这类导入若以 dist 依赖
> 进入 `node_modules`，会被宿主 Vite 的 `optimizeDeps`（esbuild 预打包）处理，而 esbuild 不识别
> `?worker&url` 后缀；作为宿主自己 Vite 管线里的一方 TS 源码处理才正确。故主入口发源码、只有上面
> 那个纯 Node 的 vite 预设发 dist。

`features`（默认全开）可按需关闭单项：`wxml` / `jsonSchemas` / `ambientTypings` / `contributedExtensions`。

`fileTypes`（自定义文件类型）让宿主把品牌扩展名映射进编辑器：形如 `{ template: ['qdml'], style: ['qdss'], viewScript: ['qds'] }`（与 dmcc 编译器 `build()` 的 `options.fileTypes` **同形**），`template→wxml`、`style→css`、`viewScript→javascript`，经 `files.associations` 下发；与内置扩展名冲突的项被忽略。devtools 侧由主进程 `WorkbenchAppConfig.fileTypes` 经 COI server 的 `/__filetypes` 端点交给 `src/main.ts` 注入。

### 2. 预构建静态 bundle（devtools COI server 沿用）

```bash
pnpm --filter @dimina-kit/workbench build   # → dist/（index.html + workers + assets，base './'）
```

入口 `src/main.ts` 是 devtools 的磁盘镜像编辑器（文件源是激活的项目，经 COI `/__fs` 桥读写），由 devtools 的 COI server 以 COOP/COEP 头部提供。`WORKBENCH_OUT_DIR` 可覆盖输出目录（devtools 的 `build:workbench` 据此把 bundle 直接产到 `dist/vscode-workbench`）。

## 工作区文件源

- `diskMirrorSource({ fsBaseUrl })` — 把磁盘上的真实 dimina 项目镜像进 `file:///workspace`，保存回写磁盘（devtools）。
- `inMemorySeedSource({ files | fetchUrl })` — 把固定文件表 seed 进内存工作区，无回写（web）。

实现 `WorkspaceSource` 接口即可接入新的文件源。

## License

[MIT](../../LICENSE) © EchoTechFE
