/**
 * fs-core 写路径 —— WAL append、turn/checkpoint/restore 执法、compaction。
 * 从 fs-core.worker.ts 抽出（file-length + cognitive-complexity 双重考量）。
 * 每个导出函数的第一个参数 `core` 是宿主 FsCore 实例；`this.` 机械替换为
 * `core.`，行为逐字保留。依赖 OPFS/Worker 专属 API，见 fs-core-recovery.ts
 * 头部同样的说明——不追求 lib 中立，从主 tsconfig.json 里排除。
 */
import type { FsCore } from './fs-core.worker.js'
import { crc32, enc, frameRecord } from './worker-lib/wal-codec.js'
import { DERIVED_PREFIXES, normalizePath } from './worker-lib/paths.js'
import {
  AUDIT_CAP, CHECKPOINT_KEEP, GROUP_WINDOW_MS, OP, OP_NAME, OPID_WINDOW, rpcErr, SEGMENT_ROTATE_BYTES,
  TURN_DEFAULT_TTL_MS, TURN_MAX_OPS, WRITE_OPCODES,
  type AuditEntry, type MirrorEntry, type OpIdResult, type Respond,
} from './worker-lib/engine-shared.js'
import type {
  CheckpointArgs, EditArgs, MvArgs, RestoreArgs, RmArgs, TurnBeginArgs, TurnEndArgs, WriteArgs,
} from './worker-lib/rpc-types.js'

// ── 写路径基础设施 ──
export function enqueue<T>(core: FsCore, fn: () => T | Promise<T>): Promise<T> {
  const run = core.chain.then(fn) as Promise<T>
  core.chain = run.catch(() => {}) // 链条不断；错误在 fn 内部转为 RPC error
  return run
}

/** 校验+成帧+append —— 同一同步块，无让出点（能力/CAS/turn 二次校验就在这里）。 */
export function appendSync(core: FsCore, opcode: number, meta: Record<string, unknown>, checks?: () => void): number {
  if (core.mode !== 'writer') throw rpcErr('readonly', 'fs-core is ' + core.mode)
  if (checks) checks()
  if (core.walOffset > SEGMENT_ROTATE_BYTES) throw rpcErr('rotate-needed', 'internal') // 上游先 rotate
  const gen = core.appendedGen + 1
  const frame = frameRecord(gen, core.epoch, opcode, meta)
  const n = core.walHandle!.write(frame, { at: core.walOffset })
  if (n !== frame.length) throw new Error('WAL partial write')
  core.walOffset += frame.length
  core.appendedGen = gen
  core.audit({ gen, opcode, actor: meta.actor as string | undefined, turnId: meta.turnId as string | undefined, path: meta.path as string | undefined, from: meta.from as string | undefined, to: meta.to as string | undefined, cpId: meta.cpId as string | undefined })
  return gen
}

export function audit(core: FsCore, entry: AuditEntry): void {
  core.auditLog.push(entry)
  if (core.auditLog.length > AUDIT_CAP) core.auditLog.splice(0, core.auditLog.length - AUDIT_CAP)
}

/** turn 执法（agent 专属）：在 append 前的同一同步块内调用，无让出点，
 * 撤销（turnEnd/过期）与写入之间不存在竞态窗口。human 写不受限。
 * 纵深加固（第二道锁）：门已
 * arm（core.agentToken !== null）时，即使 turnId 猜对/偷到、turn 仍活跃，也必须携带匹配
 * 的 agentToken，否则拒绝 —— 威胁模型是"B realm 内代码拿到裸 window.__FS_CLIENT 后伪造
 * {actor:'agent', turnId} 直写"，令牌只有内核持有（kernel.js 闭包，从不落 window）。
 * 校验顺序刻意放在 turn 有效性判定之后：turnId 完全不匹配/已过期的旧行为（'turn-closed'）
 * 保持不变（fs 域既有 e2e 的等价断言不回归），令牌门只在"turn 确实活跃且 turnId 匹配"这一步
 * 追加第二道拒绝，精确对应上述伪造场景。 */
export function checkTurn(core: FsCore, actor: string | undefined, turnId: string | undefined, agentToken: string | undefined): void {
  if (actor !== 'agent') return
  const t = core.turn
  if (!t || t.turnId !== turnId) throw rpcErr('turn-closed', 'agent write requires an active turn (got ' + turnId + ')')
  if (Date.now() > t.expiresAt) { core.turn = null; throw rpcErr('turn-closed', 'turn expired: ' + turnId) }
  if (core.agentToken !== null && agentToken !== core.agentToken) {
    throw rpcErr('agent-token-required', 'agent write requires a valid agent token')
  }
  if (++t.ops > TURN_MAX_OPS) throw rpcErr('turn-quota', 'per-turn op quota exceeded (' + TURN_MAX_OPS + ')')
}

/** 令牌门铸造：一次性置位，已置位后收到不同令牌一律拒绝（防篡改，攻击者二次 arm 顶不掉内核
 * 铸造的原令牌）；同令牌重放幂等 ok（kernel 重连/重试安全）。错误信息不回显任何令牌值。 */
export function armAgentToken(core: FsCore, token: unknown): { armed: boolean; idempotent?: boolean } {
  if (typeof token !== 'string' || !token) throw rpcErr('bad-args', 'agent token must be a non-empty string')
  if (core.agentToken === null) { core.agentToken = token; return { armed: true } }
  if (core.agentToken === token) return { armed: true, idempotent: true }
  throw rpcErr('agent-token-gate-armed', 'agent token gate already armed with a different token')
}

/** restore 冲突执法：非 force 时在 appendSync 同步块内调用，无让出点。
 * auditLog 是容量 AUDIT_CAP 的环——若其最老条目已晚于 baseGen+1，说明 (baseGen, 最老审计]
 * 区间的历史已被丢弃（compaction 或环覆盖），无法证明期间没有人类写，一律保守拒绝。 */
export function checkRestoreConflict(core: FsCore, baseGen: number): void {
  const oldestGen = core.auditLog.length ? core.auditLog[0]!.gen : core.appendedGen + 1
  if (oldestGen > baseGen + 1) {
    throw rpcErr('restore-conflict', 'audit log does not cover baseGen ' + baseGen, { humanPaths: [], auditGap: true })
  }
  const humanPaths: string[] = []
  const seen = new Set<string>()
  for (const e of core.auditLog) {
    if (e.gen <= baseGen || e.actor !== 'human' || !WRITE_OPCODES.has(e.opcode)) continue
    const p = e.opcode === OP.MV ? (e.to || e.from) : e.opcode === OP.RESTORE ? '(restore:' + e.cpId + ')' : e.path
    if (p && !seen.has(p)) { seen.add(p); humanPaths.push(p) }
  }
  if (humanPaths.length) throw rpcErr('restore-conflict', 'human edits since baseGen ' + baseGen, { humanPaths })
}

export function curOf(core: FsCore, path: string): MirrorEntry | null { return core.staged.has(path) ? core.staged.get(path) ?? null : core.mirror.get(path) || null }

export function checkWrite(core: FsCore, path: unknown, ifMatch: unknown, _actor: string | undefined): string {
  const norm = normalizePath(path)
  if (!norm) throw rpcErr('bad-path', 'invalid path: ' + path)
  for (const p of DERIVED_PREFIXES) if (norm.startsWith(p)) throw rpcErr('derived-readonly', norm + ' is derived area')
  if (core.mode === 'draining') throw rpcErr('draining', 'writer is handing over')
  const cur = core.curOf(norm)
  if (ifMatch === null && cur) throw rpcErr('cas-mismatch', norm + ' already exists')
  if (typeof ifMatch === 'number' && (!cur || cur.rev !== ifMatch)) {
    throw rpcErr('cas-mismatch', norm + ' rev=' + (cur ? cur.rev : 'none') + ' ifMatch=' + ifMatch)
  }
  return norm
}

/** 段超阈值 → 影子 compaction（物化 manifest + 新段 + superblock 翻转），
 * 而不是裸换段：WAL 长度被真正回收，重放成本有上界。 */
export async function rotateIfNeeded(core: FsCore): Promise<void> {
  if (core.walOffset <= SEGMENT_ROTATE_BYTES) return
  await core.compactNow()
}

export async function newSegment(core: FsCore, startGen: number): Promise<void> {
  const name = 'wal.' + startGen
  const fh = await core.root.getFileHandle(name + '.tmp', { create: true })
  const sh = await fh.createSyncAccessHandle()
  sh.flush(); sh.close()
  if (fh.move) await fh.move(name)
  else { await core.root.getFileHandle(name, { create: true }); try { await core.root.removeEntry(name + '.tmp') } catch {} }
  core.walHandle = await (await core.root.getFileHandle(name)).createSyncAccessHandle()
  core.walOffset = 0
}

/** 组提交边界：flush WAL → 应用 staged → 推 diff → ack → 事件。 */
export function flushWindow(core: FsCore): void {
  if (core.flushTimer) { clearTimeout(core.flushTimer); core.flushTimer = null }
  if (!core.windowOps.length) return
  core.walHandle!.flush()
  core.walGen = core.appendedGen
  const diff: Record<string, MirrorEntry | null> = {}
  for (const [path, ent] of core.staged) {
    if (ent === null) core.mirror.delete(path)
    else core.mirror.set(path, ent)
    diff[path] = ent
  }
  core.staged.clear()
  core.memGen = core.walGen
  core.pushDiff(diff, core.memGen)
  const paths: string[] = []
  let actor = 'human'
  for (const w of core.windowOps) {
    core.ackGen = Math.max(core.ackGen, w.gen)
    // 缓存与 respond 同形（含 extra）——超时重试的重放必须携带首个响应的全部
    // 字段（cpId/turnId/expiresAt），见 engine-shared.ts 的 OpIdResult。
    if (w.opId) core.rememberOpId(w.opId, { gen: w.gen, rev: w.gen, ...w.extra })
    w.respond({ ok: true, result: { gen: w.gen, rev: w.gen, ...w.extra } })
    if (w.path) paths.push(w.path)
    if (w.actor === 'agent') actor = 'agent'
  }
  core.windowOps = []
  core.event({ evt: 'fs-change', gen: core.memGen, actor, ...(paths.length <= 32 ? { paths } : { count: paths.length }) })
  core.bc.postMessage({ type: 'fs-change', gen: core.memGen })
}

export function rememberOpId(core: FsCore, opId: string, v: OpIdResult): void {
  core.opIds.set(opId, v)
  if (core.opIds.size > OPID_WINDOW) core.opIds.delete(core.opIds.keys().next().value!)
}

export function scheduleFlush(core: FsCore, immediate?: boolean): void {
  if (immediate) { core.flushWindow(); return }
  if (!core.flushTimer) core.flushTimer = setTimeout(() => core.enqueue(() => core.flushWindow()), GROUP_WINDOW_MS)
}

// ── RPC 实现 ──
export async function opWrite(core: FsCore, { path, content, ifMatch, actor = 'human', turnId, agentToken, opId }: WriteArgs, respond: Respond): Promise<void> {
  if (typeof content !== 'string') throw rpcErr('bad-args', 'content must be string')
  await core.rotateIfNeeded()
  const payload = enc.encode(content).length <= 4096 ? { inline: content } : { h: await core.ensureBlob(content) }
  const norm = normalizePath(path) // 提前算好；真正校验在 appendSync 同步块内
  // agentToken 只用于 checkTurn 校验，绝不进 meta（meta 落 WAL，持久且经 fs_diff/审计环可读——
  // 令牌绝不可持久化或经任何读路径回显）。
  const meta = { opId, path: norm, actor, turnId, ifMatch, payload }
  const gen = core.appendSync(OP.WRITE, meta, () => { core.checkTurn(actor, turnId, agentToken); core.checkWrite(path, ifMatch, actor) })
  core.staged.set(norm!, { content, rev: gen })
  core.windowOps.push({ respond, gen, path: norm!, actor, opId })
  core.scheduleFlush(actor === 'agent')
}

export async function opEdit(core: FsCore, { path, old, next, ifMatch, actor = 'human', turnId, agentToken, opId }: EditArgs, respond: Respond): Promise<void> {
  const norm = normalizePath(path)
  const cur = norm && core.curOf(norm)
  if (!cur) throw rpcErr('not-found', String(path))
  const idx = cur.content.indexOf(old)
  if (idx === -1) throw rpcErr('edit-no-match', 'old string not found in ' + norm)
  if (cur.content.indexOf(old, idx + 1) !== -1) throw rpcErr('edit-ambiguous', 'old string not unique in ' + norm)
  const content = cur.content.slice(0, idx) + next + cur.content.slice(idx + old.length)
  return core.opWrite({ path, content, ifMatch: ifMatch !== undefined ? ifMatch : cur.rev, actor, turnId, agentToken, opId }, respond)
}

export async function opRm(core: FsCore, { path, actor = 'human', turnId, agentToken, opId }: RmArgs, respond: Respond): Promise<void> {
  await core.rotateIfNeeded()
  const gen = core.appendSync(OP.RM, { opId, path: normalizePath(path), actor, turnId }, () => {
    core.checkTurn(actor, turnId, agentToken)
    const norm = core.checkWrite(path, undefined, actor)
    if (!core.curOf(norm)) throw rpcErr('not-found', norm)
  })
  core.staged.set(normalizePath(path)!, null)
  core.windowOps.push({ respond, gen, path: normalizePath(path)!, actor, opId })
  core.scheduleFlush(true)
}

export async function opMv(core: FsCore, { from, to, actor = 'human', turnId, agentToken, opId }: MvArgs, respond: Respond): Promise<void> {
  await core.rotateIfNeeded()
  const nf = normalizePath(from)!; const nt = normalizePath(to)!
  const gen = core.appendSync(OP.MV, { opId, from: nf, to: nt, actor, turnId }, () => {
    core.checkTurn(actor, turnId, agentToken)
    core.checkWrite(from, undefined, actor); core.checkWrite(to, undefined, actor)
    if (!core.curOf(nf)) throw rpcErr('not-found', nf)
    if (core.curOf(nt)) throw rpcErr('cas-mismatch', nt + ' exists')
  })
  const e = core.curOf(nf)!
  core.staged.set(nf, null)
  core.staged.set(nt, { content: e.content, rev: gen })
  core.windowOps.push({ respond, gen, path: nt, actor, opId })
  core.scheduleFlush(true)
}

/** checkpoint 物化（干净边界 + blob 去重近乎免费）。调用方须在 enqueue 串行链内。 */
export async function makeCheckpoint(core: FsCore, { opId, actor, turnId }: { opId?: string; actor?: string; turnId?: string }): Promise<{ cpId: string; gen: number }> {
  core.flushWindow() // checkpoint 基于干净边界
  await core.rotateIfNeeded()
  const map: Record<string, string> = {}
  for (const [path, ent] of core.mirror) map[path] = await core.ensureBlob(ent.content)
  const h = await core.ensureBlob(JSON.stringify(map))
  const cpId = 'cp-' + (core.appendedGen + 1)
  const gen = core.appendSync(OP.CHECKPOINT, { opId, cpId, h, actor, turnId }, () => {
    if (core.mode === 'draining') throw rpcErr('draining', 'handing over')
  })
  core.checkpoints.set(cpId, { h, gen })
  core.trimCheckpoints()
  return { cpId, gen }
}

/** checkpoint LRU：Map 按插入序，裁掉最老的（活跃 turn 的锚点必然在最近 N 个内）。 */
export function trimCheckpoints(core: FsCore): void {
  while (core.checkpoints.size > CHECKPOINT_KEEP) {
    core.checkpoints.delete(core.checkpoints.keys().next().value!)
  }
}

export async function opCheckpoint(core: FsCore, { actor = 'human', turnId, agentToken, opId }: CheckpointArgs, respond: Respond): Promise<void> {
  // actor:'agent' 的 checkpoint 同其余写类 op 一样受 turn 执法（否则 turn 外可伪造 agent
  // checkpoint 审计记录）。opTurnBegin 铸造自己的锚点时直调 makeCheckpoint，不经这里。
  core.checkTurn(actor, turnId, agentToken)
  const { cpId, gen } = await core.makeCheckpoint({ opId, actor, turnId })
  core.windowOps.push({ respond, gen, actor, opId, extra: { cpId } })
  core.scheduleFlush(true)
}

// ── turn 能力：铸造（checkpoint 锚 + 激活）→ 执法（checkTurn）→ 撤销 ──
export async function opTurnBegin(core: FsCore, { turnId, ttlMs, opId }: TurnBeginArgs, respond: Respond): Promise<void> {
  if (!turnId || typeof turnId !== 'string') throw rpcErr('bad-args', 'turnId required')
  if (core.turn && Date.now() <= core.turn.expiresAt) {
    throw rpcErr('turn-active', 'a turn is already active: ' + core.turn.turnId)
  }
  // 铸造即锚定回滚点；铸造与激活在同一 enqueue 串行任务内，无并发写插入
  const { cpId, gen } = await core.makeCheckpoint({ opId, actor: 'agent', turnId })
  const expiresAt = Date.now() + (ttlMs || TURN_DEFAULT_TTL_MS)
  core.turn = { turnId, cpId, expiresAt, ops: 0 }
  core.windowOps.push({ respond, gen, actor: 'agent', opId, extra: { turnId, cpId, expiresAt } })
  core.scheduleFlush(true)
}

export function opTurnEnd(core: FsCore, { turnId }: TurnEndArgs, respond: Respond): void {
  const active = !!(core.turn && core.turn.turnId === turnId)
  const ops = active ? core.turn!.ops : 0
  if (active) core.turn = null // 单线程同步置位：撤销即刻生效，无竞态窗口
  respond({ ok: true, result: { turnId, closed: active, ops } })
}

/** fs_diff：内存审计环里该 turn 的全部改动（WAL actor/turnId 标注免费提供）。 */
export function opDiff(core: FsCore, { turnId }: { turnId?: string }): { turnId: string | undefined; changes: Array<{ gen: number; op: string; path?: string; from?: string; to?: string }>; cpId: string | undefined; auditWindow: { cap: number; sinceGen: number } } {
  const changes = core.auditLog
    .filter((e) => e.turnId === turnId && e.opcode !== OP.CHECKPOINT)
    .map((e) => ({ gen: e.gen, op: OP_NAME[e.opcode]!, path: e.path, from: e.from, to: e.to }))
  const cpId = core.turn && core.turn.turnId === turnId ? core.turn.cpId
    : (core.auditLog.find((e) => e.turnId === turnId && e.opcode === OP.CHECKPOINT) || {}).cpId
  return { turnId, changes, cpId, auditWindow: { cap: AUDIT_CAP, sinceGen: core.auditLog.length ? core.auditLog[0]!.gen : core.memGen } }
}

/** restore 冲突策略：payload 支持 {cpId, baseGen?, force?}。baseGen 缺省时
 * 从 checkpoint 自身记录的 gen 推导（checkpoint 创建时已存 {h, gen}）。非 force 时在
 * appendSync 同步块内做冲突检查（见 checkRestoreConflict）；force:true 全部跳过。
 * turn 执法（checkTurn）不受 force 影响——agent 场景仍必须在活跃 turn 内。 */
export async function opRestore(core: FsCore, { cpId, baseGen, force = false, actor = 'human', turnId, agentToken, opId }: RestoreArgs, respond: Respond): Promise<void> {
  core.flushWindow()
  await core.rotateIfNeeded()
  const entry = core.checkpoints.get(cpId)
  if (!entry) throw rpcErr('not-found', 'checkpoint ' + cpId)
  const effectiveBaseGen = typeof baseGen === 'number' ? baseGen : entry.gen
  const map = JSON.parse(await core.readBlob(entry.h)) as Record<string, string>
  const files: Record<string, string> = {}
  for (const [path, bh] of Object.entries(map)) files[path] = await core.readBlob(bh)
  const gen = core.appendSync(OP.RESTORE, { opId, cpId, h: entry.h, actor, turnId }, () => {
    core.checkTurn(actor, turnId, agentToken)
    if (core.mode === 'draining') throw rpcErr('draining', 'handing over')
    if (!force) core.checkRestoreConflict(effectiveBaseGen)
  })
  core.walHandle!.flush()
  core.walGen = gen
  const next = new Map<string, MirrorEntry>()
  for (const [path, content] of Object.entries(files)) next.set(path, { content, rev: gen })
  core.mirror = next
  core.memGen = core.walGen
  core.ackGen = gen
  // 缓存与 respond 同形（restore 无 rev、带 restored）——见 OpIdResult。
  if (opId) core.rememberOpId(opId, { gen, restored: Object.keys(files).length })
  core.pushFullToQuery()
  respond({ ok: true, result: { gen, restored: Object.keys(files).length } })
  core.event({ evt: 'fs-change', gen, actor, count: Object.keys(files).length, restore: cpId })
  core.bc.postMessage({ type: 'fs-change', gen })
}

// 影子 compaction：新 blob → manifest → 新段(.tmp→rename) → superblock 翻转 → GC
export async function opCompact(core: FsCore, _args: unknown, respond: Respond): Promise<void> {
  const r = await core.compactNow()
  respond({ ok: true, result: r })
}

async function buildManifestFiles(core: FsCore): Promise<Record<string, { h: string; rev: number }>> {
  const files: Record<string, { h: string; rev: number }> = {}
  for (const [path, ent] of core.mirror) files[path] = { h: await core.ensureBlob(ent.content), rev: ent.rev }
  return files
}

async function writeManifestFile(core: FsCore, G: number, manifestBytes: Uint8Array): Promise<FileSystemDirectoryHandle> {
  const mDir = await core.root.getDirectoryHandle('manifests', { create: true })
  const mh = await (await mDir.getFileHandle(G + '.json', { create: true })).createSyncAccessHandle()
  mh.write(manifestBytes); mh.flush(); mh.close()
  return mDir
}

async function listAllSegmentNumbers(core: FsCore): Promise<number[]> {
  const oldSegs: number[] = []
  for await (const [name] of core.root.entries()) {
    const m = /^wal\.(\d+)$/.exec(name)
    if (m) oldSegs.push(+m[1]!)
  }
  return oldSegs
}

async function removeOldSegments(core: FsCore, oldSegs: number[]): Promise<void> {
  for (const s of oldSegs) { try { await core.root.removeEntry('wal.' + s) } catch {} }
}

/** 引用集合 = manifest files ∪ checkpoint map 及其内部 hash（GC 前置计算）。 */
async function computeReferencedBlobs(core: FsCore, files: Record<string, { h: string; rev: number }>): Promise<Set<string>> {
  const referenced = new Set<string>(Object.values(files).map((f) => f.h))
  for (const entry of core.checkpoints.values()) {
    referenced.add(entry.h)
    try { for (const bh of Object.values(JSON.parse(await core.readBlob(entry.h)) as Record<string, string>)) referenced.add(bh) } catch {}
  }
  return referenced
}

async function gcUnreferencedBlobs(core: FsCore, referenced: Set<string>): Promise<void> {
  try {
    const blobs = await core.root.getDirectoryHandle('blobs')
    for await (const [d2name, d2] of blobs.entries()) {
      void d2name
      if (d2.kind !== 'directory') continue
      for await (const [name] of (d2 as FileSystemDirectoryHandle).entries()) {
        if (!referenced.has(name)) { try { await (d2 as FileSystemDirectoryHandle).removeEntry(name) } catch {} }
      }
    }
  } catch {}
}

async function gcOldManifests(core: FsCore, mDir: FileSystemDirectoryHandle, keepName: string): Promise<void> {
  try {
    for await (const [name] of mDir.entries()) {
      if (name !== keepName) { try { await mDir.removeEntry(name) } catch {} }
    }
  } catch {}
}

/** 必须在 enqueue 串行链内调用（写路径 rotateIfNeeded / 手动 compact RPC / 启动补偿）。 */
export async function compactNow(core: FsCore): Promise<{ gen: number; skipped?: boolean }> {
  core.flushWindow()
  const G = core.memGen
  if (G === core.compactGen) return { gen: G, skipped: true }
  const files = await buildManifestFiles(core)
  const checkpoints = Object.fromEntries(core.checkpoints)
  const manifestBytes = enc.encode(JSON.stringify({ gen: G, epoch: core.epoch, files, checkpoints }))
  const mDir = await writeManifestFile(core, G, manifestBytes)
  const oldSegs = await listAllSegmentNumbers(core)
  core.walHandle!.close()
  await core.newSegment(G + 1)
  core.lastSegStart = G + 1
  core.manifestCrc = crc32(manifestBytes)
  core.compactGen = G
  core.walStartGen = G + 1
  core.writeSuperblock() // 原子翻转点：此后恢复走新 manifest+新段
  // GC：旧段 + 无引用 blob（引用 = manifest files ∪ checkpoint map 及其内部 hash）
  await removeOldSegments(core, oldSegs)
  const referenced = await computeReferencedBlobs(core, files)
  await gcUnreferencedBlobs(core, referenced)
  // 旧 manifest 清理（保留当前）
  await gcOldManifests(core, mDir, G + '.json')
  return { gen: G }
}
