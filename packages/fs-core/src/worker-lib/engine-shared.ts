/**
 * fs-core 引擎共享定义（lib 中立）—— opcode 语义、调优常量、内存态记录形状、
 * RPC 错误构造。被 fs-core.worker.ts 及其拆出的 fs-core-recovery.ts /
 * fs-core-write-ops.ts 三方共用；纯类型/常量声明，不含任何 DOM/WebWorker
 * 专属全局引用，可被主 tsconfig（DOM lib）与 tsconfig.worker.json
 * （WebWorker lib）两个 program 同时编译。
 */
import type { WalRecord } from './wal-codec.js'
import type { FsCoreErrorCode } from './protocol.js'

export const OP = { WRITE: 1, RM: 2, MV: 3, MKDIR: 4, CHECKPOINT: 5, RESTORE: 6 } as const
export const OP_NAME: Record<number, string> = { 1: 'write', 2: 'rm', 3: 'mv', 4: 'mkdir', 5: 'checkpoint', 6: 'restore' }
// restore 冲突检查只关心"写类"操作（改变文件内容/存在性），checkpoint 本身不算
export const WRITE_OPCODES = new Set<number>([OP.WRITE, OP.RM, OP.MV, OP.RESTORE])
export const INLINE_MAX = 4096          // payload ≤4KB 内联进 WAL 记录
export const GROUP_WINDOW_MS = 50       // 人类写组提交窗口
export const SEGMENT_ROTATE_BYTES = 4 * 1024 * 1024
export const OPID_WINDOW = 1024
// turn 能力：agent 写必须在有效 turn 内（fs-core 侧执法，不信任调用方透传）
export const TURN_DEFAULT_TTL_MS = 120000
export const TURN_MAX_OPS = 1000        // per-turn 限额（跑飞的 agent 刹车）
export const AUDIT_CAP = 4096           // 内存审计环（fs_diff 的数据源；重启由 WAL 回放重建）
// checkpoint LRU：保留最近 N 个；被淘汰者的 blob 在下次 compaction GC 回收
export const CHECKPOINT_KEEP = 20

export interface MirrorEntry {
  content: string
  rev: number
}

export interface AuditEntry {
  gen: number
  opcode: number
  actor?: string
  turnId?: string
  path?: string
  from?: string
  to?: string
  cpId?: string
}

export interface TurnState {
  turnId: string
  cpId: string
  expiresAt: number
  ops: number
}

export interface WindowOp {
  respond: (r: Record<string, unknown>) => void
  gen: number
  path?: string
  actor?: string
  opId?: string
  extra?: Record<string, unknown>
}

export type Respond = (r: Record<string, unknown>) => void

export interface WorkerError extends Error {
  code?: FsCoreErrorCode
  extra?: Record<string, unknown>
}

/** `code` is typed against the exported wire contract (worker-lib/protocol.ts),
 * so the set of codes this worker can throw and the set consumers can match on
 * are the same list by construction. */
export function rpcErr(code: FsCoreErrorCode, message: string, extra?: Record<string, unknown>): WorkerError {
  const e = new Error(message) as WorkerError
  e.code = code
  if (extra) e.extra = extra
  return e
}

/** 供 fs-core-recovery.ts 的回放循环使用；纯函数（无副作用）。 */
export function epochFloor(replayed: WalRecord[]): number {
  return replayed.length ? replayed[replayed.length - 1]!.epoch : 0 // epoch 单调不减
}
