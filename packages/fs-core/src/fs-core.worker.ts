/**
 * fs-core worker — ProjectFS 单写者权威（同 origin 形态）。
 *
 * 持久层（OPFS，无物化文件树）：
 *   <projectId>/blobs/<h2>/<sha256>   内容寻址、不可变、写后 flush
 *   <projectId>/manifests/<gen>.json  compaction 产物（CRC 记录在 superblock）
 *   <projectId>/wal.<startGen>        分段 append-only 日志，禁止原地重写/truncate
 *   <projectId>/superblock            双槽定长 64B×2；只写非当前槽，flush 后翻转
 *
 * WAL 记录成帧见 worker-lib/wal-codec.ts。
 * 写序（WAL-first）：blob flush → append(+组提交 flush) → 应用镜像 → ack(opId) → 广播。
 * ack 语义：已 ack 必恢复；未 ack 可能恢复 —— opId 幂等消歧。
 *
 * 该类本身只保留字段声明 + 派发（handleRpc）+ 入口（self.onmessage）；每个方法体
 * 都委托给 fs-core-recovery.ts（启动/恢复/只读查询）或 fs-core-write-ops.ts
 * （写路径/compaction）里的同名自由函数（第一个参数是本实例），这是纯粹的物理
 * 拆分（file-length），方法名/调用方式对外不变。
 */
import * as recovery from './fs-core-recovery.js'
import * as writeOps from './fs-core-write-ops.js'
import type { WalRecord } from './worker-lib/wal-codec.js'
import { rpcErr, type MirrorEntry, type Respond, type TurnState, type WindowOp, type WorkerError } from './worker-lib/engine-shared.js'
import type {
  CheckpointArgs, DiffArgs, EditArgs, MvArgs, ReadArgs, RestoreArgs, RmArgs, TurnBeginArgs, TurnEndArgs, WriteArgs,
} from './worker-lib/rpc-types.js'
import type { CoreWireMessage, FsCoreMode } from './worker-lib/protocol.js'

/** FileSystemFileHandle.move() postdates this TS lib version's ambient types
 * (feature-detected at the call site via `if (fh.move) …`, matching the
 * runtime's own defensive check). */
declare global {
  interface FileSystemFileHandle {
    move?(name: string): Promise<void>
  }
}

// ───────────────────────── core 主体 ─────────────────────────
export class FsCore {
  mode: FsCoreMode = 'starting'
  mirror = new Map<string, MirrorEntry>()
  checkpoints = new Map<string, { h: string; gen: number }>()
  opIds = new Map<string, { gen: number }>()
  appendedGen = 0
  walGen = 0
  memGen = 0
  ackGen = 0
  compactGen = 0
  epoch = 0
  walStartGen = 1
  staged = new Map<string, MirrorEntry | null>()
  windowOps: WindowOp[] = []
  flushTimer: ReturnType<typeof setTimeout> | null = null
  chain: Promise<unknown> = Promise.resolve()
  clientPort: { postMessage: (msg: unknown) => void } | null = null
  queryPort: MessagePort | null = null
  releaseLock: (() => void) | null = null
  walHandle: FileSystemSyncAccessHandle | null = null
  walOffset = 0
  sbHandle: FileSystemSyncAccessHandle | null = null
  currentSlot = 0
  turn: TurnState | null = null // {turnId, cpId, expiresAt, ops} —— 内存态：worker 重启即失效（安全默认）
  auditLog: Array<{ gen: number; opcode: number; actor?: string; turnId?: string; path?: string; from?: string; to?: string; cpId?: string }> = [] // 环形
  // 纵深加固令牌门：只有内核持有的
  // 随机令牌，一次性置位（armAgentToken）。null = 未 arm（门不生效，checkTurn 不额外校验）——
  // 保证不起内核的裸 fs 场景（fs 域单测/工具，如 test:fs-smoke/test:fs-wal 直连 client）零回归。
  // 同 worker 重启即失效（内存态，不落 WAL/持久层），与 this.turn 同一安全默认。
  agentToken: string | null = null

  projectId!: string
  root!: FileSystemDirectoryHandle
  bc!: BroadcastChannel
  lastSegStart!: number
  lastSegValidEnd!: number
  manifestCrc!: number
  // 写者锁排队中（granted/仲裁失败时复位）——requestHandover 据此判断是否需要重新排队
  writerLockQueued = false
  // 写者锁已持有（granted 一刻置位；排干释放/升级失败清理时复位）。granted 与
  // mode='writer' 之间有异步窗口（recover/开句柄）——requestHandover 据此避免
  // 在升级在途时再排一个陈旧锁请求
  writerLockHeld = false
  // 交接请求合并标志：一个 pending 周期内重复 requestHandover 不追加锁请求/不重复广播；
  // becomeWriter（自己赢了）或 handover-done 广播（别人赢了）复位
  handoverRequested = false

  // ── 启动/恢复/只读查询（fs-core-recovery.ts） ──
  start(projectId: string): Promise<void> { return recovery.start(this, projectId) }
  becomeWriter(): Promise<void> { return recovery.becomeWriter(this) }
  writeSuperblock(): void { recovery.writeSuperblock(this) }
  recover(): Promise<void> { return recovery.recover(this) }
  applyRecord(r: WalRecord): Promise<void> { return recovery.applyRecord(this, r) }
  epochFloor(replayed: WalRecord[]): number { return recovery.epochFloor(replayed) }
  ensureBlob(content: string): Promise<string> { return recovery.ensureBlob(this, content) }
  readBlob(h: string): Promise<string> { return recovery.readBlob(this, h) }
  opRead(args: ReadArgs): { content: string; rev: number; gen: number } { return recovery.opRead(this, args) }
  opLs(): { paths: string[]; gen: number } { return recovery.opLs(this) }
  opStatus() { return recovery.opStatus(this) }
  pushDiff(diff: Record<string, MirrorEntry | null>, gen: number): void { recovery.pushDiff(this, diff, gen) }
  pushFullToQuery(): void { recovery.pushFullToQuery(this) }
  event(e: CoreWireMessage): void { recovery.event(this, e) }
  welcome(): void { recovery.welcome(this) }
  onBroadcast(msg: { type?: string }): Promise<void> { return recovery.onBroadcast(this, msg) }
  requestHandover(): { requested?: true; mode?: FsCoreMode } { return recovery.requestHandover(this) }

  // ── 写路径/compaction（fs-core-write-ops.ts） ──
  enqueue<T>(fn: () => T | Promise<T>): Promise<T> { return writeOps.enqueue(this, fn) }
  appendSync(opcode: number, meta: Record<string, unknown>, checks?: () => void): number { return writeOps.appendSync(this, opcode, meta, checks) }
  audit(entry: { gen: number; opcode: number; actor?: string; turnId?: string; path?: string; from?: string; to?: string; cpId?: string }): void { writeOps.audit(this, entry) }
  checkTurn(actor: string | undefined, turnId: string | undefined, agentToken: string | undefined): void { writeOps.checkTurn(this, actor, turnId, agentToken) }
  armAgentToken(token: unknown): { armed: boolean; idempotent?: boolean } { return writeOps.armAgentToken(this, token) }
  checkRestoreConflict(baseGen: number): void { writeOps.checkRestoreConflict(this, baseGen) }
  curOf(path: string): MirrorEntry | null { return writeOps.curOf(this, path) }
  checkWrite(path: unknown, ifMatch: unknown, actor: string | undefined): string { return writeOps.checkWrite(this, path, ifMatch, actor) }
  rotateIfNeeded(): Promise<void> { return writeOps.rotateIfNeeded(this) }
  newSegment(startGen: number): Promise<void> { return writeOps.newSegment(this, startGen) }
  flushWindow(): void { writeOps.flushWindow(this) }
  rememberOpId(opId: string, v: { gen: number }): void { writeOps.rememberOpId(this, opId, v) }
  scheduleFlush(immediate?: boolean): void { writeOps.scheduleFlush(this, immediate) }
  opWrite(args: WriteArgs, respond: Respond): Promise<void> { return writeOps.opWrite(this, args, respond) }
  opEdit(args: EditArgs, respond: Respond): Promise<void> { return writeOps.opEdit(this, args, respond) }
  opRm(args: RmArgs, respond: Respond): Promise<void> { return writeOps.opRm(this, args, respond) }
  opMv(args: MvArgs, respond: Respond): Promise<void> { return writeOps.opMv(this, args, respond) }
  makeCheckpoint(args: { opId?: string; actor?: string; turnId?: string }): Promise<{ cpId: string; gen: number }> { return writeOps.makeCheckpoint(this, args) }
  trimCheckpoints(): void { writeOps.trimCheckpoints(this) }
  opCheckpoint(args: CheckpointArgs, respond: Respond): Promise<void> { return writeOps.opCheckpoint(this, args, respond) }
  opTurnBegin(args: TurnBeginArgs, respond: Respond): Promise<void> { return writeOps.opTurnBegin(this, args, respond) }
  opTurnEnd(args: TurnEndArgs, respond: Respond): void { writeOps.opTurnEnd(this, args, respond) }
  opDiff(args: DiffArgs): { turnId: string | undefined; changes: Array<{ gen: number; op: string; path?: string; from?: string; to?: string }>; cpId: string | undefined; auditWindow: { cap: number; sinceGen: number } } { return writeOps.opDiff(this, args) }
  opRestore(args: RestoreArgs, respond: Respond): Promise<void> { return writeOps.opRestore(this, args, respond) }
  opCompact(args: unknown, respond: Respond): Promise<void> { return writeOps.opCompact(this, args, respond) }
  compactNow(): Promise<{ gen: number; skipped?: boolean }> { return writeOps.compactNow(this) }

  handleRpc(msg: { id: number; opId?: string; args?: Record<string, unknown>; op: string }): void {
    const respond: Respond = (r) => this.clientPort!.postMessage({ id: msg.id, ...r })
    const fail = (e: WorkerError) => respond({ ok: false, code: e.code || 'internal', error: e.message || String(e), ...(e.extra || {}) })
    // opId 幂等：已知 opId 直接返回既有结果
    if (msg.opId && this.opIds.has(msg.opId)) {
      const known = this.opIds.get(msg.opId)!
      respond({ ok: true, result: { ...known, rev: known.gen, idempotent: true } })
      return
    }
    const a: Record<string, unknown> = { ...msg.args, opId: msg.opId }
    // Each op's real shape is narrower than the dynamic bag above (required fields
    // that msg.args may or may not actually carry) — the RPC layer trusts the wire
    // contract, same as the pre-typed-args code this replaces did via `any`; the
    // double cast through `unknown` documents that this is an intentional widening,
    // not an accidental one.
    const table: Record<string, () => void | Promise<void>> = {
      write: () => this.opWrite(a as unknown as WriteArgs, respond),
      edit: () => this.opEdit(a as unknown as EditArgs, respond),
      rm: () => this.opRm(a as unknown as RmArgs, respond),
      mv: () => this.opMv(a as unknown as MvArgs, respond),
      mkdir: () => { respond({ ok: true, result: { gen: this.memGen } }) }, // 目录隐式，保留 API
      checkpoint: () => this.opCheckpoint(a as unknown as CheckpointArgs, respond),
      restore: () => this.opRestore(a as unknown as RestoreArgs, respond),
      compact: () => this.opCompact(a, respond),
      turnBegin: () => this.opTurnBegin(a as unknown as TurnBeginArgs, respond),
      turnEnd: () => this.opTurnEnd(a as unknown as TurnEndArgs, respond),
      diff: () => respond({ ok: true, result: this.opDiff(a as DiffArgs) }),
      read: () => respond({ ok: true, result: this.opRead(a as unknown as ReadArgs) }),
      ls: () => respond({ ok: true, result: this.opLs() }),
      status: () => respond({ ok: true, result: this.opStatus() }),
      // 令牌门铸造：纯内存状态置位，无 I/O、不让出，
      // 不入 WAL 序列化链——同步分支即可（同 read/ls/status），不打扰组提交/恢复逻辑。
      armAgentTokenGate: () => respond({ ok: true, result: this.armAgentToken(a.token) }),
      // 协作交接发起（readonly 端）：广播 + 必要时重新排队锁，纯内存/信道操作，
      // 不碰 WAL——同步分支（升级本身走 becomeWriter 的 enqueue 路径）。
      requestHandover: () => respond({ ok: true, result: this.requestHandover() }),
    }
    const fn = table[msg.op]
    if (!fn) { fail(rpcErr('bad-op', String(msg.op))); return }
    if (['write', 'edit', 'rm', 'mv', 'checkpoint', 'restore', 'compact', 'turnBegin', 'turnEnd'].includes(msg.op)) {
      this.enqueue(async () => { try { await fn() } catch (e) { fail(e as WorkerError) } })
    } else {
      try { fn() } catch (e) { fail(e as WorkerError) }
    }
  }
}

// ───────────────────────── 入口 ─────────────────────────
const core = new FsCore()
self.onmessage = async (e: MessageEvent) => {
  const msg = e.data
  if (msg.type === 'HELLO') {
    core.clientPort = self // 单客户端形态：直接用 worker 主端口
    core.queryPort = msg.queryPort || null
    try {
      await core.start(msg.projectId)
    } catch (err) {
      const stack = err instanceof Error ? err.stack : undefined
      self.postMessage({ type: 'FATAL', error: String(stack || err) })
    }
    return
  }
  if (msg.type === 'PING') { self.postMessage({ type: 'PONG', t: msg.t }); return }
  if (msg.id !== undefined) core.handleRpc(msg)
}
