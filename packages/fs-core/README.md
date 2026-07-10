# @dimina-kit/fs-core

浏览器端 OPFS WAL 文件系统内核：单写者权威（Web Locks 选主）、WAL-first 写序、checkpoint/restore 回滚、agent 写权 turn 门控，零运行时依赖。

## 安装

```bash
npm i @dimina-kit/fs-core
```

## 入口

| 子路径 | 用途 |
| --- | --- |
| `@dimina-kit/fs-core/client` | `ProjectFsClient.connect({ projectId })`：读写/快照/grep/glob、`mode`/`onModeChange`（多标签页单写者可见性）、turn API |
| `@dimina-kit/fs-core/agent-tools` | fs_read/fs_write/fs_restore 等 agent 工具面（fs-core 侧 turn 执法） |
| `@dimina-kit/fs-core/disk-mirror` | File System Access 目录镜像（防抖增量写盘，`pick(handle)` 可注入已授权句柄） |
| `@dimina-kit/fs-core/sync` | 磁盘↔账本同步引擎（TruthPort 适配外部真相源） |
| `@dimina-kit/fs-core/zip` | 快照打包为 ZIP |

## 使用

```js
import { ProjectFsClient } from '@dimina-kit/fs-core/client'

// 宿主需把 dist/fs-core.worker.js 与 dist/fs-query.worker.js 部署到可访问 URL
// （默认约定 /ide/fs/ 下），client 以 module worker 加载它们。
const fs = await ProjectFsClient.connect({
  projectId: 'my-project',
  coreUrl: '/ide/fs/fs-core.worker.js',
  queryUrl: '/ide/fs/fs-query.worker.js',
})
await fs.write('app.json', '{}')
const { content } = await fs.read('app.json')
```

## Worker 产物约束

`dist/fs-core.worker.js` 与 `dist/fs-query.worker.js` 是单文件自包含 ESM（无 import 语句、零依赖），宿主按字面文件名从 `dist/` 拷贝/托管即可；以 module worker（`{ type: 'module' }`）加载。

需要 OPFS（`navigator.storage.getDirectory`）与 `createSyncAccessHandle`（worker 内），即 Chromium ≥ 102 一类环境；不依赖 COI。

## License

MIT
