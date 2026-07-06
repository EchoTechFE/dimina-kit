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
  diff(turnId?: string): Promise<{ changes: unknown[] }>

  read(path: string): Promise<{ content: string; rev?: number }>
  ls(): Promise<{ paths: string[] }>
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
