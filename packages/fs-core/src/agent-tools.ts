/**
 * Agent 工具面 —— MCP 形状的工具表包装 ProjectFsClient。
 *
 * 设计立场：Agent 拿到的不是裸 FS，而是这张工具表 +（宿主铸造的）
 * turn 能力。要点：
 *  - execute 自动注入 {actor:'agent', turnId}：turnId 由 beginTurn 铸造并闭包持有，
 *    不出现在工具参数里 —— 模型伪造不了别的 turn。
 *  - 真正的执法在 fs-core（checkTurn 与 WAL append 同一同步块）；这里只是便利面。
 *  - inputSchema 用简化记法（对外交付 Agent 集成时再换成正式 JSON Schema + MCP server 包装）。
 *  - fs_read 返回完整内容，绝不截断（上游 8000 字符腰斩教训）。
 *
 * `AgentToolsFs` only declares the methods this file actually calls on the
 * ProjectFsClient handle it's given (structurally, so any object shaped like
 * it — including test mocks — works without importing the concrete class).
 */
export interface AgentToolsFs {
  read(path: string): unknown
  ls(): unknown
  glob(pattern: string): unknown
  grep(pattern: string, opts?: Record<string, unknown>): unknown
  write(path: string, content: string, opts?: Record<string, unknown>): unknown
  edit(path: string, old: string, next: string, opts?: Record<string, unknown>): unknown
  mv(from: string, to: string, opts?: Record<string, unknown>): unknown
  rm(path: string, opts?: Record<string, unknown>): unknown
  checkpoint(opts?: Record<string, unknown>): unknown
  restore(cpId: string, opts?: Record<string, unknown>): unknown
  diff(turnId?: string): unknown
  turnBegin(turnId: string, opts?: Record<string, unknown>): Promise<Record<string, unknown>>
  turnEnd(turnId: string): unknown
}

export interface AgentTool {
  name: string
  description: string
  inputSchema: unknown
  // Method shorthand (not an arrow-typed property): TS checks method members
  // bivariantly, so each tool below can implement `execute` with its own
  // narrower, concrete parameter shape (e.g. `({ path }: { path: string })`)
  // instead of every implementation having to accept `unknown[]` directly.
  execute(...args: unknown[]): unknown
  dangerous?: boolean
}

export function createAgentTools(fs: AgentToolsFs): {
  tools: AgentTool[]
  byName: Record<string, AgentTool>
  beginTurn(opts?: Record<string, unknown>): Promise<{ turnId: string } & Record<string, unknown>>
  endTurn(): Promise<unknown>
  readonly activeTurn: string | null
} {
  let turnSeq = 0
  let activeTurn: string | null = null

  /** 铸造一轮写能力：fs-core 侧自动打 checkpoint 锚（返回 {cpId, expiresAt}）。 */
  async function beginTurn(opts: Record<string, unknown> = {}) {
    const turnId = 't-' + Date.now().toString(36) + '-' + ++turnSeq
    const r = await fs.turnBegin(turnId, opts)
    activeTurn = turnId
    return { turnId, ...r }
  }

  /** 结束（撤销）当前 turn；之后任何 agent 写都会被 fs-core 拒绝（turn-closed）。 */
  async function endTurn() {
    if (!activeTurn) return { closed: false }
    const turnId = activeTurn
    activeTurn = null
    return fs.turnEnd(turnId)
  }

  const agentOpts = () => ({ actor: 'agent', turnId: activeTurn })
  // E is inferred fresh per call from whatever concrete `execute` is passed
  // (e.g. `({ path }: { path: string }) => …`) rather than checked against one
  // fixed function type, so each tool below keeps its own narrow parameter
  // shape; assigning it into the returned object's `execute` member is safe
  // because AgentTool.execute is a method (bivariant), not an arrow-typed
  // property.
  function T<E extends (...args: never[]) => unknown>(name: string, description: string, inputSchema: unknown, execute: E, extra?: Record<string, unknown>): AgentTool {
    return { name, description, inputSchema, execute, ...extra }
  }

  const tools: AgentTool[] = [
    // 读/查询（路由 fs-query，不占写路径）
    T('fs_read', '读文件，返回完整内容与版本 rev（绝不截断）', { path: 'string' },
      ({ path }: { path: string }) => fs.read(path)),
    T('fs_ls', '列出项目全部文件路径', {},
      () => fs.ls()),
    T('fs_glob', '按 glob 模式匹配文件路径', { pattern: 'string' },
      ({ pattern }: { pattern: string }) => fs.glob(pattern)),
    T('fs_grep', '按正则搜索文件内容，返回 {path, lineNo, line} 命中行', { pattern: 'string', glob: 'string?', limit: 'number?' },
      ({ pattern, ...o }: { pattern: string; [k: string]: unknown }) => fs.grep(pattern, o)),
    // 写（fs-core 执法：必须在有效 turn 内）
    T('fs_write', '写整文件；可带 ifMatch(rev) 做 CAS 前置校验', { path: 'string', content: 'string', ifMatch: 'number?' },
      ({ path, content, ifMatch }: { path: string; content: string; ifMatch?: number }) => fs.write(path, content, { ...agentOpts(), ifMatch })),
    T('fs_edit', '精确替换：old 在文件中必须唯一匹配', { path: 'string', old: 'string', next: 'string' },
      ({ path, old, next }: { path: string; old: string; next: string }) => fs.edit(path, old, next, agentOpts())),
    T('fs_mv', '移动/重命名文件', { from: 'string', to: 'string' },
      ({ from, to }: { from: string; to: string }) => fs.mv(from, to, agentOpts())),
    T('fs_rm', '删除文件', { path: 'string' },
      ({ path }: { path: string }) => fs.rm(path, agentOpts())),
    // 回滚面
    T('fs_checkpoint', '手动创建快照锚点（turn 开始时已自动有一个）', {},
      () => fs.checkpoint(agentOpts())),
    T('fs_restore', '回滚到指定 checkpoint（本身是一条可再撤销的写）；若 checkpoint 之后有人类编辑，默认拒绝并返回 restore-conflict{humanPaths}，需 force:true 确认覆盖', { cpId: 'string', force: 'boolean?' },
      ({ cpId, force }: { cpId: string; force?: boolean }) => fs.restore(cpId, { ...agentOpts(), force }),
      { dangerous: true }),
    T('fs_diff', '列出某轮 turn 的全部改动（默认当前 turn）', { turnId: 'string?' },
      ({ turnId }: { turnId?: string } = {}) => fs.diff(turnId ?? activeTurn ?? undefined)),
  ]

  return {
    tools,
    byName: Object.fromEntries(tools.map((t) => [t.name, t])),
    beginTurn,
    endTurn,
    get activeTurn() { return activeTurn },
  }
}
