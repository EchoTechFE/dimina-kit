# Dimina DevKit

Dimina 小程序开发工具包。提供项目编译、H5 容器预览服务、文件监听热更新等能力，可独立使用或作为 `@dimina-kit/devtools` 的编译后端。

---

## 安装

```bash
pnpm add @dimina-kit/devkit
```

---

## 使用

### openProject

核心 API。编译小程序项目并启动 H5 容器预览服务器：

```typescript
import { openProject } from '@dimina-kit/devkit'

const session = await openProject({
  projectPath: '/path/to/miniapp',
  port: 0, // 0 = 自动分配可用端口
  sourcemap: true,
  onRebuild: () => console.log('重新编译完成'),
  onBuildError: (err) => console.error('编译失败', err),
})

console.log(`预览地址: http://localhost:${session.port}`)
console.log(`应用信息:`, session.appInfo)

// 结束时关闭会话
await session.close()
```

#### 参数

| 字段           | 类型                     | 默认值  | 说明                                                                                         |
| -------------- | ------------------------ | ------- | -------------------------------------------------------------------------------------------- |
| `projectPath`  | `string`                 | 必填    | 小程序项目绝对路径                                                                           |
| `port`         | `number`                 | `0`     | 预览服务器端口，`0` 表示自动分配                                                             |
| `sourcemap`    | `boolean`                | `false` | 是否生成 sourcemap                                                                           |
| `simulatorDir` | `string`                 | --      | 模拟器外壳静态资源目录；不传则不启用 `/simulator` 路由                                       |
| `containerDir` | `string`                 | --      | H5 容器静态资源目录；不传则使用内置 `dimina-fe-container`                                    |
| `outputDir`    | `string`                 | --      | 编译产物输出目录，默认 `<os.tmpdir()>/dimina-kit/<projectPath 哈希前 12 位>`（每个项目独立） |
| `watch`        | `boolean`                | `true`  | 为 `false` 时跳过 chokidar 文件监听 / 自动重编译循环                                        |
| `onRebuild`    | `() => void`             | --      | 文件变更触发重新编译后的回调                                                                 |
| `onBuildError` | `(err: unknown) => void` | --      | watch 重编译出错时的回调；**初次编译失败不走这里，而是直接 reject `openProject` 本身**（见下） |
| `onLog`        | `(entry) => void`        | --      | 逐行编译日志回调；`entry = { stream: 'stdout' \| 'stderr', text }`，已经过内置噪音过滤（`filterDmccLogLine`） |

#### 返回值 ProjectSession

| 字段      | 类型                  | 说明                                |
| --------- | --------------------- | ----------------------------------- |
| `appInfo` | `AppInfo`             | 应用信息（`appId`、`name`、`path`） |
| `port`    | `number`              | 实际监听的端口                      |
| `close`   | `() => Promise<void>` | 关闭文件监听和预览服务器            |

#### 失败语义

- **初次编译失败 → `openProject` reject**，错误即编译失败原因（`[compiler] stage "…" failed: …`）；不会带着 project.config.json 的兜底 appId 启动一个必然 404 的会话。reject 前编译日志行已全部送达 `onLog`，已启动的编译子进程会被清理。
- **watch 重编译失败 → `onBuildError(err)`**，会话保持存活，修复文件保存后自动重编译恢复。
- **Electron 打包分发**：编译路径需要 oxc-parser 的运行时绑定实际存在于分发包内（`@oxc-parser/binding-<platform>-<arch>` 或 `@oxc-parser/binding-wasm32-wasi` 之一），它们不是宿主的直接依赖，容易被 electron-builder 依赖收集丢弃——缺失时每次编译都会以 `Cannot find native binding` 失败（错误信息会附带打包提示）。详见 `@dimina-kit/compiler` README 的打包注意一节。

### enableCompileWorkerStandby（热备胎，可选加速器）

进程级开关：预先 fork 一个**项目无关**的编译子进程并预热编译器（不 chdir、不编译任何项目），之后每次 `openProject` 自动领养它——首编省掉 fork + 编译器加载（实测 ~1.6s）；每次 `session.close()` 后自动补一个新备胎。**纯加速器**：备胎的任何失效（悄悄死亡、健康检查失败、崩溃熔断）都自动退化为原有的冷 fork 路径，绝不影响 openProject 的成败。

```typescript
import { enableCompileWorkerStandby } from '@dimina-kit/devkit'

const standby = enableCompileWorkerStandby({
  onEvent: ev => console.log('[standby]', ev.type, ev.pid ?? '', ev.reason ?? ''),
})
// …应用退出时：
await standby.dispose() // 杀掉备胎；之后 openProject 永远走冷路径，不再补胎
```

稳定性设计（面向发布到用户机器）：领养前 ping/pong 健康检查（默认 1s 超时，卡死的备胎会被杀掉而不是交出去）；意外死亡自动补胎，但 30 秒内连死 3 次触发熔断（`degraded`，本次会话内永久停用，防 fork 风暴）；`onEvent` 暴露完整生命周期（`spawned` / `prewarmed` / `adopted` / `health-check-failed` / `died` / `degraded`）供接入诊断。未调用此 API 时行为与之前完全一致。

---

## 工作流程

1. 在 fork 出的长驻编译子进程中调用 `@dimina-kit/compiler/pool-node`(dmcc 兼容的常驻编译池)编译小程序项目（cwd 隔离：`chdir` 只发生在子进程内，宿主进程 cwd 不被污染；编译器崩溃不会拖垮宿主，下次重编译自动重新 fork 恢复）
2. 子进程的 stdout/stderr 按行管道回父进程，经 `filterDmccLogLine` 过滤噪音后通过 `onLog` 回调送出
3. 启动基于 Express 的 H5 容器预览服务器（含 CORS、SPA fallback、可选 live-reload）
4. 通过 chokidar 监听项目目录变更，自动触发增量编译和页面刷新；编译进行中的变更不会丢失，会在当前编译结束后合并为恰好一次尾随重编译（trailing rebuild）

---

## 构建

```bash
pnpm build              # 编译 TypeScript（src -> dist）
pnpm check-types        # 类型检查
```

---

## License

MIT
