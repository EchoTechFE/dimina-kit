/**
 * Type declaration for client.js (kept as plain JS at runtime — this file is
 * type-layer only, colocated so `import ... from './client.js'` resolves it
 * without enabling allowJs repo-wide). Mirrors the public surface of
 * ProjectFsClient; internal fields/helpers (prefixed `_`) are intentionally
 * left untyped here since callers never touch them directly.
 */
export declare class ProjectFsClient {
  projectId: string
  clientId: string

  /** Test-only: wipes a project's entire persisted layer. */
  static wipe(projectId: string): Promise<void>

  static connect(opts: {
    projectId: string
    coreUrl?: string
    queryUrl?: string
    clientId?: string
  }): Promise<ProjectFsClient>

  write(path: string, content: string, opts?: Record<string, unknown>): Promise<unknown>
  edit(path: string, old: string, next: string, opts?: Record<string, unknown>): Promise<unknown>
  rm(path: string, opts?: Record<string, unknown>): Promise<unknown>
  mv(from: string, to: string, opts?: Record<string, unknown>): Promise<unknown>
  mkdir(path: string, opts?: Record<string, unknown>): Promise<unknown>
  checkpoint(opts?: Record<string, unknown>): Promise<unknown>
  restore(cpId: string, opts?: Record<string, unknown>): Promise<unknown>
  compact(): Promise<unknown>

  turnBegin(turnId: string, opts?: Record<string, unknown>): Promise<unknown>
  turnEnd(turnId: string): Promise<unknown>
  /** WAL actor/turnId 审计标注免费提供该 turn 的改动清单。`changes` 条目形状为
   * `{ gen, op, path?, from?, to? }`（对应 fs-core.worker.js opDiff() 的 `.map(...)`）。 */
  diff(turnId?: string): Promise<{
    turnId: string
    changes: Array<{ gen: number; op: string; path?: string; from?: string; to?: string }>
    cpId: string | undefined
    auditWindow: { cap: number; sinceGen: number }
  }>

  /** W4 纵深加固令牌门：特权方法，只应由内核在 boot 早期调用一次，把只有内核持有的随机令牌
   * 交给 fs-core；此后 actor:'agent' 的写类 op 必须在 opts 里携带匹配的 agentToken
   * （fs-core 侧强制，见 fs-core.worker.js checkTurn/armAgentToken）。 */
  armAgentTokenGate(token: string): Promise<{ armed: boolean; idempotent?: boolean }>

  read(path: string): Promise<{ content: string; rev?: number; gen: number }>
  ls(): Promise<{ paths: string[]; gen: number }>
  status(): Promise<{
    mode: string
    appendedGen: number
    walGen: number
    memGen: number
    ackGen: number
    compactGen: number
    epoch: number
    walStartGen: number
    checkpoints: string[]
    turn: { turnId: string; cpId: string; expiresAt: number; ops: number } | null
  }>
  snapshot(opts?: { gen?: number }): Promise<{ files: Record<string, string>; gen: number; stale: boolean }>
  grep(pattern: string, opts?: Record<string, unknown>): Promise<unknown>
  glob(pattern: string, opts?: Record<string, unknown>): Promise<unknown>
  queryRead(path: string, opts?: Record<string, unknown>): Promise<unknown>

  seed(files: Record<string, string>): Promise<{ seeded: boolean; count: number }>
  onChange(cb: (evt: any) => void): () => void
  destroy(): void
}
