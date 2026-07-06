/**
 * fs-core worker — ProjectFS 单写者权威（P0，同 origin 形态）。
 *
 * 持久层（OPFS，无物化文件树）：
 *   <projectId>/blobs/<h2>/<sha256>   内容寻址、不可变、写后 flush
 *   <projectId>/manifests/<gen>.json  compaction 产物（CRC 记录在 superblock）
 *   <projectId>/wal.<startGen>        分段 append-only 日志，禁止原地重写/truncate
 *   <projectId>/superblock            双槽定长 64B×2；只写非当前槽，flush 后翻转
 *
 * WAL 记录成帧：
 *   [u32 len][u64 gen][u32 epoch][u8 opcode][u16 metaLen][meta JSON][u32 crc32][u8 0xC1]
 *   len = len 字段之后的字节数；crc 覆盖 gen..meta 末尾。
 *
 * 写序（WAL-first）：blob flush → append(+组提交 flush) → 应用镜像 → ack(opId) → 广播。
 * ack 语义：已 ack 必恢复；未 ack 可能恢复 —— opId 幂等消歧。
 */

const enc = new TextEncoder()
const dec = new TextDecoder()

// ───────────────────────── crc32（查表法） ─────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xffffffff
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

async function sha256hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ───────────────────────── 常量 ─────────────────────────
const OP = { WRITE: 1, RM: 2, MV: 3, MKDIR: 4, CHECKPOINT: 5, RESTORE: 6 }
const OP_NAME = { 1: 'write', 2: 'rm', 3: 'mv', 4: 'mkdir', 5: 'checkpoint', 6: 'restore' }
// §4.7 restore 冲突检查只关心"写类"操作（改变文件内容/存在性），checkpoint 本身不算
const WRITE_OPCODES = new Set([OP.WRITE, OP.RM, OP.MV, OP.RESTORE])
const INLINE_MAX = 4096          // payload ≤4KB 内联进 WAL 记录
const GROUP_WINDOW_MS = 50       // 人类写组提交窗口
const SEGMENT_ROTATE_BYTES = 4 * 1024 * 1024
const OPID_WINDOW = 1024
// P4 turn 能力：agent 写必须在有效 turn 内（fs-core 侧执法，不信任调用方透传）
const TURN_DEFAULT_TTL_MS = 120000
const TURN_MAX_OPS = 1000        // per-turn 限额（跑飞的 agent 刹车）
const AUDIT_CAP = 4096           // 内存审计环（fs_diff 的数据源；重启由 WAL 回放重建）
// P5 checkpoint LRU：保留最近 N 个；被淘汰者的 blob 在下次 compaction GC 回收
const CHECKPOINT_KEEP = 20
const SB_MAGIC = 0x44574331      // 'DWC1'
const SLOT_SIZE = 64
const DERIVED_PREFIXES = ['node_modules/', '.checkpoints/']

// ───────────────────────── superblock 槽编解码 ─────────────────────────
// 布局：magic u32 | epoch u32 | compactGen f64 | walStartGen f64 | manifestCrc u32 | pad→60 | crc32 u32
function encodeSlot(s) {
  const buf = new ArrayBuffer(SLOT_SIZE)
  const dv = new DataView(buf)
  dv.setUint32(0, SB_MAGIC)
  dv.setUint32(4, s.epoch)
  dv.setFloat64(8, s.compactGen)
  dv.setFloat64(16, s.walStartGen)
  dv.setUint32(24, s.manifestCrc)
  dv.setUint32(60, crc32(new Uint8Array(buf, 0, 60)))
  return new Uint8Array(buf)
}
function decodeSlot(bytes) {
  if (bytes.length < SLOT_SIZE) return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, SLOT_SIZE)
  if (dv.getUint32(60) !== crc32(bytes, 0, 60)) return null
  if (dv.getUint32(0) !== SB_MAGIC) return null
  return {
    epoch: dv.getUint32(4),
    compactGen: dv.getFloat64(8),
    walStartGen: dv.getFloat64(16),
    manifestCrc: dv.getUint32(24),
  }
}

// ───────────────────────── WAL 记录编解码 ─────────────────────────
function frameRecord(gen, epoch, opcode, meta) {
  const metaBytes = enc.encode(JSON.stringify(meta))
  const len = 8 + 4 + 1 + 2 + metaBytes.length + 4 + 1
  const buf = new ArrayBuffer(4 + len)
  const dv = new DataView(buf)
  const u8 = new Uint8Array(buf)
  dv.setUint32(0, len)
  dv.setBigUint64(4, BigInt(gen))
  dv.setUint32(12, epoch)
  dv.setUint8(16, opcode)
  dv.setUint16(17, metaBytes.length)
  u8.set(metaBytes, 19)
  const crcEnd = 19 + metaBytes.length
  dv.setUint32(crcEnd, crc32(u8, 4, crcEnd))
  dv.setUint8(crcEnd + 4, 0xc1)
  return u8
}
/** 解析一条记录；返回 {rec, next} 或 null（framing/CRC/commit 任一失败）。 */
function parseRecord(u8, off) {
  if (off + 4 > u8.length) return null
  const dv = new DataView(u8.buffer, u8.byteOffset)
  const len = dv.getUint32(off)
  if (len < 20 || off + 4 + len > u8.length) return null
  const gen = Number(dv.getBigUint64(off + 4))
  const epoch = dv.getUint32(off + 12)
  const opcode = dv.getUint8(off + 16)
  const metaLen = dv.getUint16(off + 17)
  const metaStart = off + 19
  const crcAt = metaStart + metaLen
  if (crcAt + 5 !== off + 4 + len) return null
  if (dv.getUint32(crcAt) !== crc32(u8, off + 4, crcAt)) return null
  if (dv.getUint8(crcAt + 4) !== 0xc1) return null
  let meta
  try { meta = JSON.parse(dec.decode(u8.subarray(metaStart, crcAt))) } catch { return null }
  return { rec: { gen, epoch, opcode, meta }, next: off + 4 + len }
}

// ───────────────────────── 路径监狱 ─────────────────────────
function normalizePath(p) {
  if (typeof p !== 'string' || !p || p.includes('\0') || p.includes('\\')) return null
  if (p.startsWith('/')) return null
  const parts = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') return null
    parts.push(seg)
  }
  return parts.length ? parts.join('/') : null
}

// ───────────────────────── core 主体 ─────────────────────────
class FsCore {
  constructor() {
    this.mode = 'starting'        // starting | writer | readonly | draining | dead
    this.mirror = new Map()       // path -> {content, rev}
    this.checkpoints = new Map()  // cpId -> blobHash(map JSON)
    this.opIds = new Map()        // opId -> {gen}（LRU 窗口 OPID_WINDOW）
    this.appendedGen = 0
    this.walGen = 0
    this.memGen = 0
    this.ackGen = 0
    this.compactGen = 0
    this.epoch = 0
    this.walStartGen = 1
    this.staged = new Map()       // path -> {content,rev} | null（窗口内已 append 未 flush）
    this.windowOps = []           // [{respond, gen, path, actor}]
    this.flushTimer = null
    this.chain = Promise.resolve()
    this.clientPort = null
    this.queryPort = null
    this.releaseLock = null
    this.walHandle = null
    this.walOffset = 0
    this.sbHandle = null
    this.currentSlot = 0
    this.turn = null              // {turnId, cpId, expiresAt, ops} —— 内存态：worker 重启即失效（安全默认）
    this.auditLog = []            // [{gen, opcode, actor, turnId, path, from, to, cpId}] 环形
    // W4 纵深加固令牌门（docs/k3-terminal-split-plan.md §6 替代方案 A / §8.3）：只有内核持有的
    // 随机令牌，一次性置位（armAgentToken）。null = 未 arm（门不生效，checkTurn 不额外校验）——
    // 保证不起内核的裸 fs 场景（fs 域单测/工具，如 test:fs-smoke/test:fs-wal 直连 client）零回归。
    // 同 worker 重启即失效（内存态，不落 WAL/持久层），与 this.turn 同一安全默认。
    this.agentToken = null
  }

  // ── 启动：锁 → 恢复 → 打开写句柄 → 全量同步 query ──
  async start(projectId) {
    this.projectId = projectId
    this.root = await (await navigator.storage.getDirectory()).getDirectoryHandle(projectId, { create: true })
    this.bc = new BroadcastChannel('dwc:' + projectId)
    this.bc.onmessage = (e) => this.onBroadcast(e.data)

    // 排队等锁；3s 拿不到先以只读服务，granted 后升级。禁止 steal。
    const granted = new Promise((resolve) => {
      navigator.locks.request('dwc:writer:' + projectId, { mode: 'exclusive' }, (lock) => {
        resolve(lock)
        return new Promise((release) => { this.releaseLock = release })
      }).catch(() => resolve(null))
    })
    const winner = await Promise.race([granted, new Promise((r) => setTimeout(() => r('timeout'), 3000))])
    if (winner === 'timeout') {
      await this.recover()
      this.mode = 'readonly'
      this.pushFullToQuery()
      this.welcome()
      granted.then(async (lock) => {
        if (!lock || this.mode === 'dead') return
        await this.enqueue(async () => { await this.becomeWriter() })
      })
      return
    }
    await this.becomeWriter()
    this.welcome()
  }

  async becomeWriter() {
    await this.recover() // 旧写者可能刚交出——以盘上状态为准重建
    // epoch 递增写入候选槽（防御性护栏：记录归属可判别）
    this.sbHandle = await (await this.root.getFileHandle('superblock', { create: true })).createSyncAccessHandle()
    this.epoch += 1
    this.writeSuperblock()
    // 打开（或创建）最后一个 WAL 段，定位到有效前缀末尾
    const segName = 'wal.' + this.lastSegStart
    this.walHandle = await (await this.root.getFileHandle(segName, { create: true })).createSyncAccessHandle()
    this.walOffset = this.lastSegValidEnd
    this.mode = 'writer'
    this.pushFullToQuery()
    this.event({ evt: 'writer-granted', gen: this.memGen })
    // 启动补偿：上一世代积累的 WAL 已超阈值（如崩溃打断了 compaction）→ 立即整理
    if (this.walOffset > SEGMENT_ROTATE_BYTES) this.enqueue(() => this.compactNow())
  }

  writeSuperblock() {
    const cand = 1 - this.currentSlot
    const bytes = encodeSlot({ epoch: this.epoch, compactGen: this.compactGen, walStartGen: this.walStartGen, manifestCrc: this.manifestCrc || 0 })
    const n = this.sbHandle.write(bytes, { at: cand * SLOT_SIZE })
    if (n !== SLOT_SIZE) throw new Error('superblock partial write: ' + n)
    this.sbHandle.flush()
    this.currentSlot = cand
  }

  // ── 恢复：superblock 选槽 → manifest → 顺序回放 WAL 段（完整前缀截断） ──
  async recover() {
    this.mirror.clear(); this.checkpoints.clear(); this.opIds.clear()
    this.auditLog = []; this.turn = null
    let sb = null
    try {
      const f = await (await this.root.getFileHandle('superblock')).getFile()
      const u8 = new Uint8Array(await f.arrayBuffer())
      const s0 = decodeSlot(u8.subarray(0, SLOT_SIZE))
      const s1 = u8.length >= 128 ? decodeSlot(u8.subarray(SLOT_SIZE, 2 * SLOT_SIZE)) : null
      if (s0 && s1) { sb = s1.compactGen > s0.compactGen || (s1.compactGen === s0.compactGen && s1.epoch >= s0.epoch) ? s1 : s0; this.currentSlot = sb === s1 ? 1 : 0 }
      else if (s0) { sb = s0; this.currentSlot = 0 }
      else if (s1) { sb = s1; this.currentSlot = 1 }
    } catch { /* 首次初始化 */ }
    if (!sb) {
      sb = { epoch: 0, compactGen: 0, walStartGen: 1, manifestCrc: 0 }
      this.currentSlot = 1 // 首个 writeSuperblock 落 slot0
    }
    this.epoch = sb.epoch
    this.compactGen = sb.compactGen
    this.walStartGen = sb.walStartGen
    this.manifestCrc = sb.manifestCrc

    let gen = 0
    if (this.compactGen > 0) {
      const f = await (await (await this.root.getDirectoryHandle('manifests')).getFileHandle(this.compactGen + '.json')).getFile()
      const bytes = new Uint8Array(await f.arrayBuffer())
      if (crc32(bytes) !== this.manifestCrc) throw new Error('manifest CRC mismatch (gen ' + this.compactGen + ')')
      const m = JSON.parse(dec.decode(bytes))
      for (const [path, ent] of Object.entries(m.files)) {
        this.mirror.set(path, { content: await this.readBlob(ent.h), rev: ent.rev })
      }
      for (const [cpId, entry] of Object.entries(m.checkpoints || {})) this.checkpoints.set(cpId, entry)
      gen = m.gen
    }

    // 列出 ≥ walStartGen 的段，按 startGen 升序回放；段边界优先于段内垃圾尾
    const segs = []
    for await (const [name] of this.root.entries()) {
      const m = /^wal\.(\d+)$/.exec(name)
      if (m && +m[1] >= this.walStartGen) segs.push(+m[1])
    }
    segs.sort((a, b) => a - b)
    this.lastSegStart = segs.length ? segs[segs.length - 1] : this.walStartGen
    this.lastSegValidEnd = 0
    const replayed = []
    for (let i = 0; i < segs.length; i++) {
      const stopBefore = i + 1 < segs.length ? segs[i + 1] : Infinity
      const f = await (await this.root.getFileHandle('wal.' + segs[i])).getFile()
      const u8 = new Uint8Array(await f.arrayBuffer())
      let off = 0
      while (off < u8.length) {
        const p = parseRecord(u8, off)
        if (!p || p.rec.gen !== gen + 1 || p.rec.gen >= stopBefore || p.rec.epoch < this.epochFloor(replayed)) break
        await this.applyRecord(p.rec)
        gen = p.rec.gen
        replayed.push(p.rec)
        const m = p.rec.meta
        this.audit({ gen, opcode: p.rec.opcode, actor: m.actor, turnId: m.turnId, path: m.path, from: m.from, to: m.to, cpId: m.cpId })
        off = p.next
        if (segs[i] === this.lastSegStart) this.lastSegValidEnd = off
      }
      if (segs[i] !== this.lastSegStart && off === 0) { /* 中间空段：允许，继续 */ }
    }
    this.appendedGen = this.walGen = this.memGen = this.ackGen = gen
    this.trimCheckpoints() // 回放会重新加回历史 checkpoint 记录 → 恢复后同样裁剪
    for (const r of replayed.slice(-OPID_WINDOW)) {
      if (r.meta.opId) this.rememberOpId(r.meta.opId, { gen: r.gen })
    }
    if (!segs.length) {
      // 确保首段存在（空段无害；真正写入偏移由 walOffset 管理）
      await this.root.getFileHandle('wal.' + this.walStartGen, { create: true })
    }
  }

  epochFloor(replayed) {
    return replayed.length ? replayed[replayed.length - 1].epoch : 0 // epoch 单调不减
  }

  async applyRecord(r) {
    const m = r.meta
    switch (r.opcode) {
      case OP.WRITE: {
        const content = m.payload.inline !== undefined ? m.payload.inline : await this.readBlob(m.payload.h)
        this.mirror.set(m.path, { content, rev: r.gen })
        break
      }
      case OP.RM: this.mirror.delete(m.path); break
      case OP.MV: {
        const e = this.mirror.get(m.from)
        if (e) { this.mirror.delete(m.from); this.mirror.set(m.to, { content: e.content, rev: r.gen }) }
        break
      }
      case OP.MKDIR: break // 目录隐式；记录仅为审计
      case OP.CHECKPOINT: this.checkpoints.set(m.cpId, { h: m.h, gen: r.gen }); break
      case OP.RESTORE: {
        const map = JSON.parse(await this.readBlob(m.h))
        const next = new Map()
        for (const [path, h] of Object.entries(map)) next.set(path, { content: await this.readBlob(h), rev: r.gen })
        this.mirror = next
        break
      }
    }
  }

  // ── blob 存取 ──
  async ensureBlob(content) {
    const bytes = enc.encode(content)
    const h = await sha256hex(bytes)
    const d2 = await (await this.root.getDirectoryHandle('blobs', { create: true })).getDirectoryHandle(h.slice(0, 2), { create: true })
    try { await d2.getFileHandle(h); return h } catch { /* 不存在则写入 */ }
    const fh = await d2.getFileHandle(h, { create: true })
    const sh = await fh.createSyncAccessHandle()
    sh.write(bytes); sh.flush(); sh.close()
    return h
  }
  async readBlob(h) {
    const f = await (await (await (await this.root.getDirectoryHandle('blobs')).getDirectoryHandle(h.slice(0, 2))).getFileHandle(h)).getFile()
    return f.text()
  }

  // ── 写路径 ──
  enqueue(fn) {
    const run = this.chain.then(fn)
    this.chain = run.catch(() => {}) // 链条不断；错误在 fn 内部转为 RPC error
    return run
  }

  /** 校验+成帧+append —— 同一同步块，无让出点（能力/CAS/turn 二次校验就在这里）。 */
  appendSync(opcode, meta, checks) {
    if (this.mode !== 'writer') throw rpcErr('readonly', 'fs-core is ' + this.mode)
    if (checks) checks()
    if (this.walOffset > SEGMENT_ROTATE_BYTES) throw rpcErr('rotate-needed', 'internal') // 上游先 rotate
    const gen = this.appendedGen + 1
    const frame = frameRecord(gen, this.epoch, opcode, meta)
    const n = this.walHandle.write(frame, { at: this.walOffset })
    if (n !== frame.length) throw new Error('WAL partial write')
    this.walOffset += frame.length
    this.appendedGen = gen
    this.audit({ gen, opcode, actor: meta.actor, turnId: meta.turnId, path: meta.path, from: meta.from, to: meta.to, cpId: meta.cpId })
    return gen
  }

  audit(entry) {
    this.auditLog.push(entry)
    if (this.auditLog.length > AUDIT_CAP) this.auditLog.splice(0, this.auditLog.length - AUDIT_CAP)
  }

  /** turn 执法（agent 专属）：在 append 前的同一同步块内调用，无让出点，
   * 撤销（turnEnd/过期）与写入之间不存在竞态窗口。human 写不受限。
   * W4 纵深加固（第二道锁，docs/k3-terminal-split-plan.md §6 替代方案 A / §8.3）：门已
   * arm（this.agentToken !== null）时，即使 turnId 猜对/偷到、turn 仍活跃，也必须携带匹配
   * 的 agentToken，否则拒绝 —— 威胁模型是"B realm 内代码拿到裸 window.__FS_CLIENT 后伪造
   * {actor:'agent', turnId} 直写"，令牌只有内核持有（kernel.js 闭包，从不落 window）。
   * 校验顺序刻意放在 turn 有效性判定之后：turnId 完全不匹配/已过期的旧行为（'turn-closed'）
   * 保持不变（fs 域既有 e2e 的等价断言不回归），令牌门只在"turn 确实活跃且 turnId 匹配"这一步
   * 追加第二道拒绝，精确对应 blocker #6 的伪造场景。 */
  checkTurn(actor, turnId, agentToken) {
    if (actor !== 'agent') return
    const t = this.turn
    if (!t || t.turnId !== turnId) throw rpcErr('turn-closed', 'agent write requires an active turn (got ' + turnId + ')')
    if (Date.now() > t.expiresAt) { this.turn = null; throw rpcErr('turn-closed', 'turn expired: ' + turnId) }
    if (this.agentToken !== null && agentToken !== this.agentToken) {
      throw rpcErr('agent-token-required', 'agent write requires a valid agent token')
    }
    if (++t.ops > TURN_MAX_OPS) throw rpcErr('turn-quota', 'per-turn op quota exceeded (' + TURN_MAX_OPS + ')')
  }

  /** 令牌门铸造：一次性置位，已置位后收到不同令牌一律拒绝（防篡改，攻击者二次 arm 顶不掉内核
   * 铸造的原令牌）；同令牌重放幂等 ok（kernel 重连/重试安全）。错误信息不回显任何令牌值。 */
  armAgentToken(token) {
    if (typeof token !== 'string' || !token) throw rpcErr('bad-args', 'agent token must be a non-empty string')
    if (this.agentToken === null) { this.agentToken = token; return { armed: true } }
    if (this.agentToken === token) return { armed: true, idempotent: true }
    throw rpcErr('agent-token-gate-armed', 'agent token gate already armed with a different token')
  }

  /** §4.7 restore 冲突执法：非 force 时在 appendSync 同步块内调用，无让出点。
   * auditLog 是容量 AUDIT_CAP 的环——若其最老条目已晚于 baseGen+1，说明 (baseGen, 最老审计]
   * 区间的历史已被丢弃（compaction 或环覆盖），无法证明期间没有人类写，一律保守拒绝。 */
  checkRestoreConflict(baseGen) {
    const oldestGen = this.auditLog.length ? this.auditLog[0].gen : this.appendedGen + 1
    if (oldestGen > baseGen + 1) {
      throw rpcErr('restore-conflict', 'audit log does not cover baseGen ' + baseGen, { humanPaths: [], auditGap: true })
    }
    const humanPaths = []
    const seen = new Set()
    for (const e of this.auditLog) {
      if (e.gen <= baseGen || e.actor !== 'human' || !WRITE_OPCODES.has(e.opcode)) continue
      const p = e.opcode === OP.MV ? (e.to || e.from) : e.opcode === OP.RESTORE ? '(restore:' + e.cpId + ')' : e.path
      if (p && !seen.has(p)) { seen.add(p); humanPaths.push(p) }
    }
    if (humanPaths.length) throw rpcErr('restore-conflict', 'human edits since baseGen ' + baseGen, { humanPaths })
  }

  curOf(path) { return this.staged.has(path) ? this.staged.get(path) : this.mirror.get(path) || null }

  checkWrite(path, ifMatch, actor) {
    const norm = normalizePath(path)
    if (!norm) throw rpcErr('bad-path', 'invalid path: ' + path)
    for (const p of DERIVED_PREFIXES) if (norm.startsWith(p)) throw rpcErr('derived-readonly', norm + ' is derived area')
    if (this.mode === 'draining') throw rpcErr('draining', 'writer is handing over')
    const cur = this.curOf(norm)
    if (ifMatch === null && cur) throw rpcErr('cas-mismatch', norm + ' already exists')
    if (typeof ifMatch === 'number' && (!cur || cur.rev !== ifMatch)) {
      throw rpcErr('cas-mismatch', norm + ' rev=' + (cur ? cur.rev : 'none') + ' ifMatch=' + ifMatch)
    }
    return norm
  }

  /** 段超阈值 → 影子 compaction（物化 manifest + 新段 + superblock 翻转），
   * 而不是裸换段：WAL 长度被真正回收，重放成本有上界（P1 compaction 上线）。 */
  async rotateIfNeeded() {
    if (this.walOffset <= SEGMENT_ROTATE_BYTES) return
    await this.compactNow()
  }

  async newSegment(startGen) {
    const name = 'wal.' + startGen
    const fh = await this.root.getFileHandle(name + '.tmp', { create: true })
    const sh = await fh.createSyncAccessHandle()
    sh.flush(); sh.close()
    if (fh.move) await fh.move(name)
    else { await this.root.getFileHandle(name, { create: true }); try { await this.root.removeEntry(name + '.tmp') } catch {} }
    this.walHandle = await (await this.root.getFileHandle(name)).createSyncAccessHandle()
    this.walOffset = 0
  }

  /** 组提交边界：flush WAL → 应用 staged → 推 diff → ack → 事件。 */
  flushWindow() {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null }
    if (!this.windowOps.length) return
    this.walHandle.flush()
    this.walGen = this.appendedGen
    const diff = {}
    for (const [path, ent] of this.staged) {
      if (ent === null) this.mirror.delete(path)
      else this.mirror.set(path, ent)
      diff[path] = ent
    }
    this.staged.clear()
    this.memGen = this.walGen
    this.pushDiff(diff, this.memGen)
    const paths = []
    let actor = 'human'
    for (const w of this.windowOps) {
      this.ackGen = Math.max(this.ackGen, w.gen)
      if (w.opId) this.rememberOpId(w.opId, { gen: w.gen })
      w.respond({ ok: true, result: { gen: w.gen, rev: w.gen, ...w.extra } })
      if (w.path) paths.push(w.path)
      if (w.actor === 'agent') actor = 'agent'
    }
    this.windowOps = []
    this.event({ evt: 'fs-change', gen: this.memGen, actor, ...(paths.length <= 32 ? { paths } : { count: paths.length }) })
    this.bc.postMessage({ type: 'fs-change', gen: this.memGen })
  }

  rememberOpId(opId, v) {
    this.opIds.set(opId, v)
    if (this.opIds.size > OPID_WINDOW) this.opIds.delete(this.opIds.keys().next().value)
  }

  scheduleFlush(immediate) {
    if (immediate) { this.flushWindow(); return }
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.enqueue(() => this.flushWindow()), GROUP_WINDOW_MS)
  }

  // ── RPC 实现 ──
  async opWrite({ path, content, ifMatch, actor = 'human', turnId, agentToken, opId }, respond) {
    if (typeof content !== 'string') throw rpcErr('bad-args', 'content must be string')
    await this.rotateIfNeeded()
    const payload = enc.encode(content).length <= INLINE_MAX ? { inline: content } : { h: await this.ensureBlob(content) }
    const norm = normalizePath(path) // 提前算好；真正校验在 appendSync 同步块内
    // agentToken 只用于 checkTurn 校验，绝不进 meta（meta 落 WAL，持久且经 fs_diff/审计环可读——
    // 令牌绝不可持久化或经任何读路径回显）。
    const meta = { opId, path: norm, actor, turnId, ifMatch, payload }
    let gen
    gen = this.appendSync(OP.WRITE, meta, () => { this.checkTurn(actor, turnId, agentToken); return this.checkWrite(path, ifMatch, actor) })
    this.staged.set(norm, { content, rev: gen })
    this.windowOps.push({ respond, gen, path: norm, actor, opId })
    this.scheduleFlush(actor === 'agent')
  }

  async opEdit({ path, old, next, ifMatch, actor = 'human', turnId, agentToken, opId }, respond) {
    const norm = normalizePath(path)
    const cur = norm && this.curOf(norm)
    if (!cur) throw rpcErr('not-found', String(path))
    const idx = cur.content.indexOf(old)
    if (idx === -1) throw rpcErr('edit-no-match', 'old string not found in ' + norm)
    if (cur.content.indexOf(old, idx + 1) !== -1) throw rpcErr('edit-ambiguous', 'old string not unique in ' + norm)
    const content = cur.content.slice(0, idx) + next + cur.content.slice(idx + old.length)
    return this.opWrite({ path, content, ifMatch: ifMatch !== undefined ? ifMatch : cur.rev, actor, turnId, agentToken, opId }, respond)
  }

  async opRm({ path, actor = 'human', turnId, agentToken, opId }, respond) {
    await this.rotateIfNeeded()
    let gen
    gen = this.appendSync(OP.RM, { opId, path: normalizePath(path), actor, turnId }, () => {
      this.checkTurn(actor, turnId, agentToken)
      const norm = this.checkWrite(path, undefined, actor)
      if (!this.curOf(norm)) throw rpcErr('not-found', norm)
    })
    this.staged.set(normalizePath(path), null)
    this.windowOps.push({ respond, gen, path: normalizePath(path), actor, opId })
    this.scheduleFlush(true)
  }

  async opMv({ from, to, actor = 'human', turnId, agentToken, opId }, respond) {
    await this.rotateIfNeeded()
    const nf = normalizePath(from); const nt = normalizePath(to)
    let gen
    gen = this.appendSync(OP.MV, { opId, from: nf, to: nt, actor, turnId }, () => {
      this.checkTurn(actor, turnId, agentToken)
      this.checkWrite(from, undefined, actor); this.checkWrite(to, undefined, actor)
      if (!this.curOf(nf)) throw rpcErr('not-found', nf)
      if (this.curOf(nt)) throw rpcErr('cas-mismatch', nt + ' exists')
    })
    const e = this.curOf(nf)
    this.staged.set(nf, null)
    this.staged.set(nt, { content: e.content, rev: gen })
    this.windowOps.push({ respond, gen, path: nt, actor, opId })
    this.scheduleFlush(true)
  }

  /** checkpoint 物化（干净边界 + blob 去重近乎免费）。调用方须在 enqueue 串行链内。 */
  async makeCheckpoint({ opId, actor, turnId }) {
    this.flushWindow() // checkpoint 基于干净边界
    await this.rotateIfNeeded()
    const map = {}
    for (const [path, ent] of this.mirror) map[path] = await this.ensureBlob(ent.content)
    const h = await this.ensureBlob(JSON.stringify(map))
    const cpId = 'cp-' + (this.appendedGen + 1)
    const gen = this.appendSync(OP.CHECKPOINT, { opId, cpId, h, actor, turnId }, () => {
      if (this.mode === 'draining') throw rpcErr('draining', 'handing over')
    })
    this.checkpoints.set(cpId, { h, gen })
    this.trimCheckpoints()
    return { cpId, gen }
  }

  /** P5 LRU：Map 按插入序，裁掉最老的（活跃 turn 的锚点必然在最近 N 个内）。 */
  trimCheckpoints() {
    while (this.checkpoints.size > CHECKPOINT_KEEP) {
      this.checkpoints.delete(this.checkpoints.keys().next().value)
    }
  }

  async opCheckpoint({ actor = 'human', turnId, agentToken, opId }, respond) {
    // actor:'agent' 的 checkpoint 同其余写类 op 一样受 turn 执法（否则 turn 外可伪造 agent
    // checkpoint 审计记录）。opTurnBegin 铸造自己的锚点时直调 makeCheckpoint，不经这里。
    this.checkTurn(actor, turnId, agentToken)
    const { cpId, gen } = await this.makeCheckpoint({ opId, actor, turnId })
    this.windowOps.push({ respond, gen, actor, opId, extra: { cpId } })
    this.scheduleFlush(true)
  }

  // ── P4 turn 能力：铸造（checkpoint 锚 + 激活）→ 执法（checkTurn）→ 撤销 ──
  async opTurnBegin({ turnId, ttlMs, opId }, respond) {
    if (!turnId || typeof turnId !== 'string') throw rpcErr('bad-args', 'turnId required')
    if (this.turn && Date.now() <= this.turn.expiresAt) {
      throw rpcErr('turn-active', 'a turn is already active: ' + this.turn.turnId)
    }
    // 铸造即锚定回滚点；铸造与激活在同一 enqueue 串行任务内，无并发写插入
    const { cpId, gen } = await this.makeCheckpoint({ opId, actor: 'agent', turnId })
    const expiresAt = Date.now() + (ttlMs || TURN_DEFAULT_TTL_MS)
    this.turn = { turnId, cpId, expiresAt, ops: 0 }
    this.windowOps.push({ respond, gen, actor: 'agent', opId, extra: { turnId, cpId, expiresAt } })
    this.scheduleFlush(true)
  }

  opTurnEnd({ turnId }, respond) {
    const active = !!(this.turn && this.turn.turnId === turnId)
    const ops = active ? this.turn.ops : 0
    if (active) this.turn = null // 单线程同步置位：撤销即刻生效，无竞态窗口
    respond({ ok: true, result: { turnId, closed: active, ops } })
  }

  /** fs_diff：内存审计环里该 turn 的全部改动（WAL actor/turnId 标注免费提供）。 */
  opDiff({ turnId }) {
    const changes = this.auditLog
      .filter((e) => e.turnId === turnId && e.opcode !== OP.CHECKPOINT)
      .map((e) => ({ gen: e.gen, op: OP_NAME[e.opcode], path: e.path, from: e.from, to: e.to }))
    const cpId = this.turn && this.turn.turnId === turnId ? this.turn.cpId
      : (this.auditLog.find((e) => e.turnId === turnId && e.opcode === OP.CHECKPOINT) || {}).cpId
    return { turnId, changes, cpId, auditWindow: { cap: AUDIT_CAP, sinceGen: this.auditLog.length ? this.auditLog[0].gen : this.memGen } }
  }

  /** §4.7 restore 冲突策略：payload 支持 {cpId, baseGen?, force?}。baseGen 缺省时
   * 从 checkpoint 自身记录的 gen 推导（checkpoint 创建时已存 {h, gen}）。非 force 时在
   * appendSync 同步块内做冲突检查（见 checkRestoreConflict）；force:true 全部跳过。
   * turn 执法（checkTurn）不受 force 影响——agent 场景仍必须在活跃 turn 内。 */
  async opRestore({ cpId, baseGen, force = false, actor = 'human', turnId, agentToken, opId }, respond) {
    this.flushWindow()
    await this.rotateIfNeeded()
    const entry = this.checkpoints.get(cpId)
    if (!entry) throw rpcErr('not-found', 'checkpoint ' + cpId)
    const effectiveBaseGen = typeof baseGen === 'number' ? baseGen : entry.gen
    const map = JSON.parse(await this.readBlob(entry.h))
    const files = {}
    for (const [path, bh] of Object.entries(map)) files[path] = await this.readBlob(bh)
    const gen = this.appendSync(OP.RESTORE, { opId, cpId, h: entry.h, actor, turnId }, () => {
      this.checkTurn(actor, turnId, agentToken)
      if (this.mode === 'draining') throw rpcErr('draining', 'handing over')
      if (!force) this.checkRestoreConflict(effectiveBaseGen)
    })
    this.walHandle.flush()
    this.walGen = gen
    const next = new Map()
    for (const [path, content] of Object.entries(files)) next.set(path, { content, rev: gen })
    this.mirror = next
    this.memGen = this.walGen
    this.ackGen = gen
    if (opId) this.rememberOpId(opId, { gen })
    this.pushFullToQuery()
    respond({ ok: true, result: { gen, restored: Object.keys(files).length } })
    this.event({ evt: 'fs-change', gen, actor, count: Object.keys(files).length, restore: cpId })
    this.bc.postMessage({ type: 'fs-change', gen })
  }

  // 影子 compaction：新 blob → manifest → 新段(.tmp→rename) → superblock 翻转 → GC
  async opCompact(_args, respond) {
    const r = await this.compactNow()
    respond({ ok: true, result: r })
  }

  /** 必须在 enqueue 串行链内调用（写路径 rotateIfNeeded / 手动 compact RPC / 启动补偿）。 */
  async compactNow() {
    this.flushWindow()
    const G = this.memGen
    if (G === this.compactGen) return { gen: G, skipped: true }
    const files = {}
    for (const [path, ent] of this.mirror) files[path] = { h: await this.ensureBlob(ent.content), rev: ent.rev }
    const checkpoints = Object.fromEntries(this.checkpoints)
    const manifestBytes = enc.encode(JSON.stringify({ gen: G, epoch: this.epoch, files, checkpoints }))
    const mDir = await this.root.getDirectoryHandle('manifests', { create: true })
    const mh = await (await mDir.getFileHandle(G + '.json', { create: true })).createSyncAccessHandle()
    mh.write(manifestBytes); mh.flush(); mh.close()
    const oldSegs = []
    for await (const [name] of this.root.entries()) {
      const m = /^wal\.(\d+)$/.exec(name)
      if (m) oldSegs.push(+m[1])
    }
    this.walHandle.close()
    await this.newSegment(G + 1)
    this.lastSegStart = G + 1
    this.manifestCrc = crc32(manifestBytes)
    this.compactGen = G
    this.walStartGen = G + 1
    this.writeSuperblock() // 原子翻转点：此后恢复走新 manifest+新段
    // GC：旧段 + 无引用 blob（引用 = manifest files ∪ checkpoint map 及其内部 hash）
    for (const s of oldSegs) { try { await this.root.removeEntry('wal.' + s) } catch {} }
    const referenced = new Set(Object.values(files).map((f) => f.h))
    for (const entry of this.checkpoints.values()) {
      referenced.add(entry.h)
      try { for (const bh of Object.values(JSON.parse(await this.readBlob(entry.h)))) referenced.add(bh) } catch {}
    }
    try {
      const blobs = await this.root.getDirectoryHandle('blobs')
      for await (const [d2name, d2] of blobs.entries()) {
        if (d2.kind !== 'directory') continue
        for await (const [name] of d2.entries()) {
          if (!referenced.has(name)) { try { await d2.removeEntry(name) } catch {} }
        }
      }
    } catch {}
    // 旧 manifest 清理（保留当前）
    try {
      for await (const [name] of mDir.entries()) {
        if (name !== G + '.json') { try { await mDir.removeEntry(name) } catch {} }
      }
    } catch {}
    return { gen: G }
  }

  // ── 读类 ──
  opRead({ path }) {
    const norm = normalizePath(path)
    const e = norm && this.mirror.get(norm)
    if (!e) throw rpcErr('not-found', String(path))
    return { content: e.content, rev: e.rev, gen: this.memGen } // P0：镜像在内存，64KB 路由约束成为空转（见 §2.1）
  }
  opLs() { return { paths: [...this.mirror.keys()].sort(), gen: this.memGen } }
  opStatus() {
    const { mode, appendedGen, walGen, memGen, ackGen, compactGen, epoch, walStartGen } = this
    return {
      mode, appendedGen, walGen, memGen, ackGen, compactGen, epoch, walStartGen,
      checkpoints: [...this.checkpoints.keys()],
      turn: this.turn ? { turnId: this.turn.turnId, cpId: this.turn.cpId, expiresAt: this.turn.expiresAt, ops: this.turn.ops } : null,
    }
  }

  // ── query 同步 / 事件 ──
  pushDiff(diff, gen) {
    if (!this.queryPort) return
    const wire = {}
    for (const [p, ent] of Object.entries(diff)) wire[p] = ent ? { content: ent.content, rev: ent.rev } : null
    this.queryPort.postMessage({ gen, diff: wire })
  }
  pushFullToQuery() {
    if (!this.queryPort) return
    const files = {}
    for (const [p, ent] of this.mirror) files[p] = { content: ent.content, rev: ent.rev }
    this.queryPort.postMessage({ gen: this.memGen, full: true, files })
  }
  event(e) { if (this.clientPort) this.clientPort.postMessage(e) }
  welcome() {
    this.event({ type: 'WELCOME', epoch: this.epoch, memGen: this.memGen, readonly: this.mode !== 'writer', mode: this.mode })
  }

  // ── 协作交接（禁 steal）──
  async onBroadcast(msg) {
    if (msg.type === 'handover-request' && this.mode === 'writer') {
      this.mode = 'draining'
      await this.enqueue(async () => {
        this.flushWindow()
        this.walHandle.close(); this.walHandle = null
        this.sbHandle.close(); this.sbHandle = null
        this.mode = 'readonly'
        if (this.releaseLock) { this.releaseLock(); this.releaseLock = null }
        this.bc.postMessage({ type: 'handover-done', gen: this.memGen })
        this.event({ evt: 'writer-lost', gen: this.memGen })
      })
    }
  }

  handleRpc(msg) {
    const respond = (r) => this.clientPort.postMessage({ id: msg.id, ...r })
    const fail = (e) => respond({ ok: false, code: e.code || 'internal', error: e.message || String(e), ...(e.extra || {}) })
    // opId 幂等：已知 opId 直接返回既有结果
    if (msg.opId && this.opIds.has(msg.opId)) {
      respond({ ok: true, result: { ...this.opIds.get(msg.opId), rev: this.opIds.get(msg.opId).gen, idempotent: true } })
      return
    }
    const a = { ...msg.args, opId: msg.opId }
    const table = {
      write: () => this.opWrite(a, respond),
      edit: () => this.opEdit(a, respond),
      rm: () => this.opRm(a, respond),
      mv: () => this.opMv(a, respond),
      mkdir: () => { respond({ ok: true, result: { gen: this.memGen } }) }, // 目录隐式，保留 API
      checkpoint: () => this.opCheckpoint(a, respond),
      restore: () => this.opRestore(a, respond),
      compact: () => this.opCompact(a, respond),
      turnBegin: () => this.opTurnBegin(a, respond),
      turnEnd: () => this.opTurnEnd(a, respond),
      diff: () => respond({ ok: true, result: this.opDiff(a) }),
      read: () => respond({ ok: true, result: this.opRead(a) }),
      ls: () => respond({ ok: true, result: this.opLs() }),
      status: () => respond({ ok: true, result: this.opStatus() }),
      // W4 令牌门铸造（§6 替代方案 A / §8.3）：纯内存状态置位，无 I/O、不让出，
      // 不入 WAL 序列化链——同步分支即可（同 read/ls/status），不打扰组提交/恢复逻辑。
      armAgentTokenGate: () => respond({ ok: true, result: this.armAgentToken(a.token) }),
    }
    const fn = table[msg.op]
    if (!fn) { fail(rpcErr('bad-op', String(msg.op))); return }
    if (['write', 'edit', 'rm', 'mv', 'checkpoint', 'restore', 'compact', 'turnBegin', 'turnEnd'].includes(msg.op)) {
      this.enqueue(async () => { try { await fn() } catch (e) { fail(e) } })
    } else {
      try { fn() } catch (e) { fail(e) }
    }
  }
}

function rpcErr(code, message, extra) { const e = new Error(message); e.code = code; if (extra) e.extra = extra; return e }

// ───────────────────────── 入口 ─────────────────────────
const core = new FsCore()
self.onmessage = async (e) => {
  const msg = e.data
  if (msg.type === 'HELLO') {
    core.clientPort = self // 单客户端 P0：直接用 worker 主端口
    core.queryPort = msg.queryPort || null
    try {
      await core.start(msg.projectId)
    } catch (err) {
      self.postMessage({ type: 'FATAL', error: String((err && err.stack) || err) })
    }
    return
  }
  if (msg.type === 'PING') { self.postMessage({ type: 'PONG', t: msg.t }); return }
  if (msg.id !== undefined) core.handleRpc(msg)
}
