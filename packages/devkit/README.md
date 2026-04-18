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
| `outputDir`    | `string`                 | --      | 编译产物输出目录，默认 `<os.tmpdir()>/dimina-kit/<projectPath 哈希前 12 位>`（每个项目独立） |
| `onRebuild`    | `() => void`             | --      | 文件变更触发重新编译后的回调                                                                 |
| `onBuildError` | `(err: unknown) => void` | --      | 编译出错时的回调                                                                             |

#### 返回值 ProjectSession

| 字段      | 类型                  | 说明                                |
| --------- | --------------------- | ----------------------------------- |
| `appInfo` | `AppInfo`             | 应用信息（`appId`、`name`、`path`） |
| `port`    | `number`              | 实际监听的端口                      |
| `close`   | `() => Promise<void>` | 关闭文件监听和预览服务器            |

---

## 工作流程

1. 调用 `@dimina/compiler` 编译小程序项目
2. 启动基于 Express 的 H5 容器预览服务器（含 CORS、SPA fallback、可选 live-reload）
3. 通过 chokidar 监听项目目录变更，自动触发增量编译和页面刷新

---

## 构建

```bash
pnpm build              # 编译 TypeScript（src -> dist）
pnpm check-types        # 类型检查
```

---

## License

MIT
