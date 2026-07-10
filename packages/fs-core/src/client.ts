/**
 * ProjectFsClient — 主线程侧 ProjectFS 封装（P0，同 origin）。
 * 起 fs-core / fs-query 两个 worker，牵好 core→query 的 diff 端口，
 * 暴露 Promise API；写请求自动带 opId，超时重试幂等（同 opId 重发）。
 */
const WRITE_TIMEOUT_MS = 8000

type Mode = 'starting' | 'writer' | 'readonly' | 'draining' | 'dead'

/**
 * Loosely-shaped dynamic message bag flowing over the fs-core worker's main
 * port: both the WELCOME/PONG/event messages (`event()`/`welcome()` in
 * fs-core.worker.ts) and the RPC reply messages (`respond()`/`fail()` there)
 * land here, distinguished at runtime by which optional fields are present.
 * One flat interface (rather than a narrowed union) matches how the code
 * actually reads it — every field is optional and independently checked.
 */
export interface CoreMessage {
  type?: string
  evt?: string
  error?: string
  mode?: Mode
  readonly?: boolean
  gen?: number
  id?: number
  ok?: boolean
  result?: unknown
  code?: string
  humanPaths?: string[]
  auditGap?: boolean
  actor?: string
  paths?: string[]
  count?: number
  restore?: string
  t?: number
}

interface PendingEntry {
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
  timer: ReturnType<typeof setTimeout> | null
}

interface QPendingEntry {
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
}

interface DiffResult {
  turnId: string
  changes: Array<{ gen: number; op: string; path?: string; from?: string; to?: string }>
  cpId: string | undefined
  auditWindow: { cap: number; sinceGen: number }
}

interface StatusResult {
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
}

export class ProjectFsClient {
  projectId!: string
  clientId!: string
  core!: Worker
  query!: Worker
  pending!: Map<number, PendingEntry>
  qPending!: Map<number, QPendingEntry>
  changeCbs!: Set<(evt: CoreMessage) => void>
  modeCbs!: Set<(mode: Mode) => void>
  _mode!: Mode
  seq!: number
  welcome: CoreMessage | null = null
  pingTimer!: ReturnType<typeof setInterval>
  lastPong!: number
  private _retried?: boolean

  /** 测试用：抹掉一个项目的全部持久层（只能在无 core 运行时调用）。 */
  static async wipe(projectId: string): Promise<void> {
    const root = await navigator.storage.getDirectory()
    try { await root.removeEntry(projectId, { recursive: true }) } catch {}
  }

  static async connect({
    projectId,
    coreUrl = '/ide/fs/fs-core.worker.js',
    queryUrl = '/ide/fs/fs-query.worker.js',
    clientId = 'c-' + Math.random().toString(36).slice(2, 10),
  }: {
    projectId: string
    coreUrl?: string
    queryUrl?: string
    clientId?: string
  }): Promise<ProjectFsClient> {
    const c = new ProjectFsClient()
    c.projectId = projectId
    c.clientId = clientId
    c.core = new Worker(coreUrl, { type: 'module' })
    c.query = new Worker(queryUrl, { type: 'module' })
    c.pending = new Map() // id -> {resolve, reject, timer}
    c.qPending = new Map()
    c.changeCbs = new Set()
    c.modeCbs = new Set()
    c._mode = 'starting'
    c.seq = 0
    c.welcome = null

    const chan = new MessageChannel()
    const welcomed = new Promise<CoreMessage>((resolve, reject) => {
      c.core.onmessage = (e) => c._onCoreMessage(e.data, resolve, reject)
      c.core.onerror = (e) => reject(new Error('fs-core worker error: ' + e.message))
    })
    c.query.onmessage = (e) => c._onQueryMessage(e.data)
    c.query.postMessage({ type: 'init', corePort: chan.port2 }, [chan.port2])
    c.core.postMessage({ type: 'HELLO', projectId, clientId, capabilityRequest: { mode: 'rw' }, queryPort: chan.port1 }, [chan.port1])
    c.welcome = await welcomed
    c._setMode(c.welcome.mode || (c.welcome.readonly ? 'readonly' : 'writer'))

    c.pingTimer = setInterval(() => { try { c.core.postMessage({ type: 'PING', t: Date.now() }) } catch {} }, 10000)
    c.lastPong = Date.now()
    return c
  }

  _onCoreMessage(msg: CoreMessage, resolveWelcome: ((v: CoreMessage) => void) | null, rejectWelcome: ((e: Error) => void) | null): void {
    if (msg.type === 'WELCOME') { this._handleWelcome(msg, resolveWelcome); return }
    if (msg.type === 'FATAL') { this._handleFatal(msg, rejectWelcome); return }
    if (msg.type === 'PONG') { this.lastPong = Date.now(); return }
    if (msg.evt) { this._handleEvt(msg); return }
    if (msg.id !== undefined) this._handleRpcReply(msg)
  }

  _handleWelcome(msg: CoreMessage, resolveWelcome: ((v: CoreMessage) => void) | null): void {
    if (resolveWelcome) resolveWelcome(msg)
  }

  _handleFatal(msg: CoreMessage, rejectWelcome: ((e: Error) => void) | null): void {
    this._setMode('dead')
    const err = new Error('fs-core fatal: ' + msg.error)
    if (rejectWelcome) rejectWelcome(err)
    for (const [, p] of this.pending) p.reject(err)
    this.pending.clear()
  }

  _handleEvt(msg: CoreMessage): void {
    if (msg.evt === 'writer-granted') this._setMode('writer')
    else if (msg.evt === 'writer-lost') this._setMode('readonly')
    for (const cb of this.changeCbs) { try { cb(msg) } catch {} }
  }

  _handleRpcReply(msg: CoreMessage): void {
    const p = this.pending.get(msg.id!)
    if (!p) return
    this.pending.delete(msg.id!)
    if (p.timer) clearTimeout(p.timer)
    if (msg.ok) p.resolve(msg.result)
    else p.reject(Object.assign(new Error(msg.error), { code: msg.code, ...(msg.humanPaths !== undefined ? { humanPaths: msg.humanPaths } : {}), ...(msg.auditGap !== undefined ? { auditGap: msg.auditGap } : {}) }))
  }

  _onQueryMessage(msg: CoreMessage): void {
    if (msg.id === undefined) return
    const p = this.qPending.get(msg.id)
    if (!p) return
    this.qPending.delete(msg.id)
    if (msg.ok) p.resolve(msg.result)
    else p.reject(Object.assign(new Error(msg.error), { code: msg.code }))
  }

  _rpc<T = unknown>(op: string, args: Record<string, unknown>, { opId, timeout }: { opId?: string; timeout?: number } = {}): Promise<T> {
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      const entryResolve = resolve as (v: unknown) => void
      const timer = timeout
        ? setTimeout(() => {
            // 超时重试一次：同 opId 幂等（fs-core 对已知 opId 返回既有结果）
            if (opId && !this._retried) {
              const retryId = ++this.seq
              this.pending.set(retryId, { resolve: entryResolve, reject, timer: setTimeout(() => { this.pending.delete(retryId); reject(new Error(op + ' timeout (after retry)')) }, timeout) })
              this.pending.delete(id)
              this.core.postMessage({ id: retryId, op, args, opId })
            } else {
              this.pending.delete(id)
              reject(new Error(op + ' timeout'))
            }
          }, timeout)
        : null
      this.pending.set(id, { resolve: entryResolve, reject, timer })
      this.core.postMessage({ id, op, args, opId })
    })
  }

  _qrpc<T = unknown>(op: string, args: Record<string, unknown>): Promise<T> {
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      this.qPending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.query.postMessage({ id, op, args })
    })
  }

  _writeOp<T = unknown>(op: string, args: Record<string, unknown>): Promise<T> {
    return this._rpc<T>(op, args, { opId: crypto.randomUUID(), timeout: WRITE_TIMEOUT_MS })
  }

  // ── 写 API（{actor:'human'|'agent', turnId, ifMatch} 透传）──
  write(path: string, content: string, opts: Record<string, unknown> = {}): Promise<unknown> { return this._writeOp('write', { path, content, ...opts }) }
  edit(path: string, old: string, next: string, opts: Record<string, unknown> = {}): Promise<unknown> { return this._writeOp('edit', { path, old, next, ...opts }) }
  rm(path: string, opts: Record<string, unknown> = {}): Promise<unknown> { return this._writeOp('rm', { path, ...opts }) }
  mv(from: string, to: string, opts: Record<string, unknown> = {}): Promise<unknown> { return this._writeOp('mv', { from, to, ...opts }) }
  mkdir(path: string, opts: Record<string, unknown> = {}): Promise<unknown> { return this._writeOp('mkdir', { path, ...opts }) }
  checkpoint(opts: Record<string, unknown> = {}): Promise<unknown> { return this._writeOp('checkpoint', { ...opts }) }
  /** opts: {baseGen?, force?} 透传给 fs-core（§4.7 restore 冲突策略）；baseGen 缺省时
   * fs-core 从 checkpoint 自身记录的 gen 推导。 */
  restore(cpId: string, opts: Record<string, unknown> = {}): Promise<unknown> { return this._writeOp('restore', { cpId, ...opts }) }
  compact(): Promise<unknown> { return this._rpc('compact', {}, { timeout: 30000 }) }

  // ── P4 turn 能力：铸造（附带 checkpoint 锚）→ agent 写执法 → 撤销 ──
  turnBegin(turnId: string, opts: Record<string, unknown> = {}): Promise<unknown> { return this._writeOp('turnBegin', { turnId, ...opts }) }
  turnEnd(turnId: string): Promise<unknown> { return this._writeOp('turnEnd', { turnId }) }
  /** 该 turn 的改动清单（WAL actor/turnId 审计标注免费提供）。 */
  diff(turnId?: string): Promise<DiffResult> { return this._rpc<DiffResult>('diff', { turnId }) }

  /** W4 纵深加固令牌门（docs/k3-terminal-split-plan.md §6 替代方案 A / §8.3）：特权方法，只应
   * 由内核（kernel.js createKernel）在 boot 早期调用一次，把只有内核持有的随机令牌交给 fs-core；
   * 此后 actor:'agent' 的写类 op 必须在 opts 里携带匹配的 agentToken（fs-core 侧强制，见
   * fs-core.worker.js checkTurn/armAgentToken）。无 opId/超时重试——一次性 admin 调用，非写路径
   * 幂等本就由 fs-core 的 armAgentToken 自身保证（同令牌重放 ok，不同令牌拒绝）。 */
  armAgentTokenGate(token: string): Promise<{ armed: boolean; idempotent?: boolean }> { return this._rpc('armAgentTokenGate', { token }) }

  // ── 读 API：小读走 core（权威），查询/快照走 query（不占写路径）──
  read(path: string): Promise<{ content: string; rev?: number; gen: number }> { return this._rpc('read', { path }) }
  ls(): Promise<{ paths: string[]; gen: number }> { return this._rpc('ls', {}) }
  status(): Promise<StatusResult> { return this._rpc<StatusResult>('status', {}) }
  snapshot(opts: { gen?: number } = {}): Promise<{ files: Record<string, string>; gen: number; stale: boolean }> { return this._qrpc('snapshot', opts) }
  grep(pattern: string, opts: Record<string, unknown> = {}): Promise<unknown> { return this._qrpc('grep', { pattern, ...opts }) }
  glob(pattern: string, opts: Record<string, unknown> = {}): Promise<unknown> { return this._qrpc('glob', { pattern, ...opts }) }
  queryRead(path: string, opts: Record<string, unknown> = {}): Promise<unknown> { return this._qrpc('read', { path, ...opts }) }

  /** 空项目时批量写入种子文件；非空则跳过。返回 {seeded, count}。 */
  async seed(files: Record<string, string>): Promise<{ seeded: boolean; count: number }> {
    const { paths } = await this.ls()
    if (paths.length) return { seeded: false, count: paths.length }
    const entries = Object.entries(files)
    for (let i = 0; i < entries.length; i += 50) {
      await Promise.all(entries.slice(i, i + 50).map(([p, c]) => this.write(p, c, { actor: 'human' })))
    }
    return { seeded: true, count: entries.length }
  }

  onChange(cb: (evt: CoreMessage) => void): () => void {
    this.changeCbs.add(cb)
    return () => this.changeCbs.delete(cb)
  }

  /** 当前单写者状态：starting(HELLO 未回)|writer(持写者租约)|readonly(排队中或已交出)|
   * draining(worker 侧过渡态，client 不会长时间观察到——见 fs-core.worker.js onBroadcast，
   * 收敛为 readonly 再广播事件)|dead(FATAL，worker 已不可用)。由 WELCOME 与
   * writer-granted/writer-lost 事件驱动，供宿主向用户呈现"另一个标签页持有写权"之类提示。 */
  get mode(): Mode { return this._mode }

  _setMode(mode: Mode): void {
    if (this._mode === mode) return
    this._mode = mode
    for (const cb of this.modeCbs) { try { cb(mode) } catch {} }
  }

  /** 订阅 mode 变化（writer ⇄ readonly ⇄ dead）；返回退订函数。 */
  onModeChange(cb: (mode: Mode) => void): () => void {
    this.modeCbs.add(cb)
    return () => this.modeCbs.delete(cb)
  }

  destroy(): void {
    clearInterval(this.pingTimer)
    this._setMode('dead')
    this.core.terminate()
    this.query.terminate()
  }
}
