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
| `@dimina-kit/fs-core/sync/binary-sidecar` | 二进制侧车：分类（NUL 嗅探）、`{size, sha256}` 索引、echo 判据、可选 bytes 保留 + `overlay()` 合并 |
| `@dimina-kit/fs-core/sync/watch-expander` | watch 批扩展 helper（stat 级核对，供 TruthPort 适配器组装 `changes`） |
| `@dimina-kit/fs-core/protocol` | 线上契约：错误码/事件名/消息形状（消费方按符号匹配，不抄 worker 源码字符串；`/client` 亦有 re-export） |
| `@dimina-kit/fs-core/worker-files` | Node 侧 worker 产物清单：`FS_CORE_WORKER_FILES` + `resolveWorkerFiles()`（ESM/CJS 双形态） |
| `@dimina-kit/fs-core/zip` | 快照打包为 ZIP |

## 两套磁盘机制的划界（永不合流）

- **`/disk-mirror`**：OPFS 真相源 → 本地目录的**单向导出**（File System Access，防抖全量比对写盘）。适用于"fs-core 即真相源"的宿主（如 qdmp-web-workbench）想把内容落到本地磁盘。
- **`/sync`**：**外部真相源 ↔ fs-core 账本的双向对账引擎**（TruthPort 抽象外部真相源；echo 判据、FIFO 序列化、二进制侧车）。适用于"磁盘才是真相源、fs-core 只记账"的宿主（如 dimina-kit workbench 经 `/__fs` 桥 + SSE watch）。
- 一个宿主真需要双向时，正确姿势是给 `/sync` 写一个 poll 形态的 TruthPort 适配器，而不是把 `/disk-mirror` 养成第二个同步引擎。

## 使用

```js
import { ProjectFsClient } from '@dimina-kit/fs-core/client'

// 宿主需把 dist/fs-core.worker.js 与 dist/fs-query.worker.js 部署到可访问 URL，
// client 以 module worker 加载它们。coreUrl/queryUrl 的缺省值 /ide/fs/ 是最初
// dwc 宿主的部署形状；其它宿主都应显式传入自己的 URL。文件名/位置的单一权威
// 见 `@dimina-kit/fs-core/worker-files` 的 resolveWorkerFiles()。
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
