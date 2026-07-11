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
- **未来 poll 适配器须自持的不变量**（引擎只服务 push 形态宿主，不内置 poll 侧机制）：poll 宿主自己驱动出站扫描（读账本→写真相源），因此必须自己防"刚从真相源灌入的变更被自己的出站扫描原样回写"——抑制记录须**一次性消费**（命中即清除，不是常驻内容缓存）、匹配须区分文本/字节/删除三种形态、且**绝不能把真相源"读不到"（瞬时 I/O 失败）推断为删除**。

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

### 多标签页单写者与协作交接

同一 `projectId` 只有一个写者（Web Locks 排队，禁 steal）：后开的标签页 3s 拿不到锁即以
readonly 服务（`fs.mode === 'readonly'`，经 `onModeChange` 订阅变化），锁 granted 后自动升级。
readonly 端可调 `fs.requestHandover()` 主动请求交接——现任写者排干释放，本端随之升级
（结果经 `writer-granted` 事件/`onModeChange` 回报）。何时发起是宿主的 UI 策略（如在
"另一个标签页持有写权"提示上放"在此接管"动作），fs-core 只提供机制、绝不自动重发。
锁仲裁本身失败（Web Locks 层异常，非"被人占着"）一律 FATAL——绝不无锁当写者，也绝不静默
滞留 readonly。

## Worker 产物约束

`dist/fs-core.worker.js` 与 `dist/fs-query.worker.js` 是单文件自包含 ESM（无 import 语句、零依赖），宿主按字面文件名从 `dist/` 拷贝/托管即可；以 module worker（`{ type: 'module' }`）加载。

需要 OPFS（`navigator.storage.getDirectory`）与 `createSyncAccessHandle`（worker 内），即 Chromium ≥ 102 一类环境；不依赖 COI。

## License

MIT
