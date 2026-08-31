# @dimina-kit/fs-core

`@dimina-kit/fs-core` 是运行在浏览器 Worker 中的项目文件账本。它把文本文件写入 OPFS，用 WAL 记录修改，并在多个标签页之间保证同一项目只有一个写者。宿主还可以用 checkpoint、turn 和同步引擎实现 agent 修改审计、回滚和磁盘双向同步。

这个包没有根入口。请按用途从 `@dimina-kit/fs-core/client`、`/sync` 等子路径导入。

## 安装

```bash
pnpm add @dimina-kit/fs-core
```

运行环境需要提供 module Worker、OPFS 和 Web Locks。包本身没有运行时依赖。

## 部署 Worker

`ProjectFsClient` 会启动两个 module Worker。宿主需要把构建产物中的这两个文件部署到同源 URL：

- `dist/fs-core.worker.js`
- `dist/fs-query.worker.js`

Node 构建脚本可以用 `@dimina-kit/fs-core/worker-files` 读取权威文件名和包内路径：

```ts
import { createRequire } from 'node:module'
import { resolveWorkerFiles } from '@dimina-kit/fs-core/worker-files'

const require = createRequire(import.meta.url)
const workers = resolveWorkerFiles(
  require.resolve('@dimina-kit/fs-core/client'),
)
```

不要依赖 `ProjectFsClient.connect()` 内置的 `/ide/fs/` URL，除非宿主确实按这个路径部署。其他宿主应显式传入两个 URL。

## 快速开始

```ts
import {
  ProjectFsClient,
  isFsCoreErrorCode,
} from '@dimina-kit/fs-core/client'

const fs = await ProjectFsClient.connect({
  projectId: 'demo-project',
  coreUrl: '/workers/fs-core.worker.js',
  queryUrl: '/workers/fs-query.worker.js',
})

await fs.write('app.json', '{"pages":["pages/index/index"]}')
const { content, gen } = await fs.read('app.json')
console.log(content, gen)

try {
  await fs.write('app.json', '{}')
}
catch (error) {
  if (isFsCoreErrorCode(error, 'readonly')) {
    console.log('另一个标签页持有写权')
  }
}

fs.destroy()
```

## 常用 API

`ProjectFsClient` 把 core worker 和 query worker 的消息封装成 Promise：

| 类别 | 方法 |
| --- | --- |
| 文本写入 | `write`、`edit`、`rm`、`mv`、`mkdir` |
| 读取与查询 | `read`、`ls`、`snapshot`、`grep`、`glob`、`queryRead` |
| 恢复 | `checkpoint`、`restore`、`compact` |
| Agent turn | `turnBegin`、`turnEnd`、`diff`、`armAgentTokenGate` |
| 多标签页 | `mode`、`onModeChange`、`requestHandover` |
| 生命周期 | `onChange`、`destroy` |

写方法会自动生成 `opId`。写入超时后的重试继续使用同一个 `opId`，worker 可以返回先前结果而不重复执行副作用。错误码和事件名由 `/client` 与 `/protocol` 导出，调用方应使用 `isFsCoreErrorCode()` 等符号判断，不要匹配错误文本。

## 多标签页写权

同一 `projectId` 通过 Web Locks 选出一个 writer。后打开的标签页拿不到锁时进入 `readonly`，仍可读取和查询：

```ts
const unsubscribe = fs.onModeChange((mode) => {
  console.log('当前模式：', mode)
})

if (fs.mode === 'readonly') {
  await fs.requestHandover()
}

unsubscribe()
```

`requestHandover()` 只请求当前 writer 排干并交出锁。交出写权的一端不会自动再抢回来；宿主应把这个动作放在明确的用户操作后。

## Agent turn 与回滚

Agent 写入可以被限制在一个有期限的 turn 中：

```ts
const turn = await fs.turnBegin('turn-42', { ttlMs: 60_000 })

await fs.write('pages/index/index.js', 'Page({})', {
  actor: 'agent',
  turnId: turn.turnId,
})

const changes = await fs.diff(turn.turnId)
await fs.turnEnd(turn.turnId)

// 需要撤销时：
await fs.restore(turn.cpId)
```

`turnBegin()` 会同时创建 checkpoint。`@dimina-kit/fs-core/agent-tools` 可把这些能力包装成 `fs_read`、`fs_write`、`fs_restore` 等工具，并由宿主固定当前 `turnId`。

## 与磁盘同步

`@dimina-kit/fs-core/sync` 适合“磁盘是事实来源、fs-core 负责记账”的宿主。宿主提供一个 `TruthPort`，再把外部变更交给同步引擎：

```ts
import { createSyncEngine } from '@dimina-kit/fs-core/sync'

const engine = createSyncEngine(fs, truthPort, {
  applyToEditor: async (relativePath, bytes) => {
    // bytes === null 表示删除
  },
  onDegraded: event => console.error('文件同步降级', event),
})

await engine.populateLedger()
engine.start()
```

二进制文件可配合 `/sync/binary-sidecar` 保存尺寸和哈希；外部 watcher 的批量事件可先交给 `/sync/watch-expander` 展开。若 OPFS 才是事实来源，只需要把文件单向写到本地目录，可使用 `/disk-mirror`，不要同时让两套机制负责双向同步。

## 公开子路径

| 子路径 | 用途 |
| --- | --- |
| `/client` | `ProjectFsClient`、调用参数和结果类型、错误码 helper |
| `/agent-tools` | 把账本操作包装成 agent 工具 |
| `/disk-mirror` | 把 OPFS 账本单向写到 File System Access 目录 |
| `/zip` | `makeZip()`，把文本文件集合打成 ZIP |
| `/sync` | `createSyncEngine()` 与 `TruthPort` 契约 |
| `/sync/binary-sidecar` | 二进制文件的尺寸、哈希和可选字节缓存 |
| `/sync/watch-expander` | 展开并核对 watcher 变更批次 |
| `/protocol` | worker 消息、事件和错误码契约 |
| `/worker-files` | Worker 文件名与包内路径 |

## 在仓库中开发

```bash
pnpm --filter @dimina-kit/fs-core build
pnpm --filter @dimina-kit/fs-core check-types
pnpm --filter @dimina-kit/fs-core test
```

## License

MIT
