# @dimina-kit/devkit

`@dimina-kit/devkit` 把一个 Dimina 小程序项目编译成可预览的网页，并负责预览服务器、文件监听和重新编译。它既可以单独使用，也是 `@dimina-kit/devtools` 的默认编译后端。

## 安装

```bash
pnpm add @dimina-kit/devkit
```

## 快速开始

```ts
import { openProject } from '@dimina-kit/devkit'

const session = await openProject({
  projectPath: '/absolute/path/to/miniapp',
  port: 0,
  sourcemap: true,
  onRebuild: info => console.log('重新编译完成', info),
  onBuildError: error => console.error('重新编译失败', error),
})

console.log(`预览地址：http://127.0.0.1:${session.port}`)
console.log(session.appInfo)

await session.close()
```

`openProject()` 会先完成一次编译，再启动预览服务器。初次编译失败时，它会直接 reject，不会返回一个只能访问到 404 的会话。

## `openProject()` 参数

只有 `projectPath` 必填。路径会在内部转成绝对路径。

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `projectPath` | 必填 | 小程序项目目录 |
| `port` | `0` | 预览服务器端口；`0` 表示自动选择可用端口 |
| `sourcemap` | `false` | 是否让编译器生成 sourcemap |
| `fileTypes` | — | 在内置 `wx*`、`dd*` 文件类型之外追加模板、样式和视图脚本扩展名 |
| `simulatorDir` | — | 提供后启用 `/simulator` 静态资源路由 |
| `containerDir` | 包内置容器 | 覆盖 H5 容器静态资源目录 |
| `outputDir` | 系统临时目录中的项目哈希路径 | 最终编译产物目录，与 `outputRoot` 互斥 |
| `outputRoot` | — | 产物目录的父目录；devkit 在其下按 `sha1(resolve(projectPath)).slice(0, 12)` 建子目录，与 `outputDir` 互斥、同传会报错 |
| `watch` | `true` | 是否监听文件并自动重新编译 |
| `autoReload` | `true` | watcher 编译成功后是否刷新预览；纯样式改动会走样式热更新 |
| `onRebuild` | — | 重新编译成功后的回调，参数包含 `changedPaths`、`styleOnly`，显式 `session.rebuild()` 还会带 `explicit: true` |
| `onBuildError` | — | watcher 或 `session.rebuild()` 编译失败后的回调 |
| `onLog` | — | 接收过滤后的逐行编译日志，形状为 `{ stream, text }` |
| `onWatcherError` | — | 会话已经启动后，文件监听器停止工作的通知 |

`watch: false` 只关闭自动监听；`session.rebuild()` 仍可使用。`autoReload: false` 也不会关闭编译或 `onRebuild`，它只阻止 devkit 主动刷新预览页面。

## 返回的会话

```ts
interface ProjectSession {
  appInfo: { appId: string; name: string; path: string }
  port: number
  rebuild(): Promise<void>
  close(): Promise<void>
}
```

- `rebuild()` 和文件监听共用同一个调度器，不会并发运行两次编译。
- watcher 编译失败时会话保持可用，修正文件后可以继续编译。
- `rebuild()` 失败时，该 Promise reject；同一个错误也会交给 `onBuildError`。
- `close()` 会停止文件监听、编译子进程和预览服务器。

## 可选：预热编译进程

桌面应用可以在打开项目前准备一个与项目无关的编译进程，减少第一次编译前的进程启动和模块加载时间：

```ts
import { enableCompileWorkerStandby } from '@dimina-kit/devkit'

const standby = enableCompileWorkerStandby()

// 应用退出时：
await standby.dispose()
```

预热失败会回退到普通的冷启动路径，不会改变 `openProject()` 的成功或失败语义。这个开关作用于当前进程；调用 `dispose()` 后不再补充新的备用编译进程。

## 其他公开入口

根入口还导出编译日志过滤、重新编译调度和编译 worker 相关工具。文件监听忽略目录可从 `@dimina-kit/devkit/watch-ignore` 导入。完整名称以发布包中的 `dist/index.d.ts` 和 `dist/watch-ignore.d.ts` 为准。

## 在仓库中开发

```bash
pnpm --filter @dimina-kit/devkit build
pnpm --filter @dimina-kit/devkit check-types
pnpm --filter @dimina-kit/devkit test
```

## License

MIT
