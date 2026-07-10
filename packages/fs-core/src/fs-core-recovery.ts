/**
 * fs-core 恢复/启动/只读查询路径 —— 从 fs-core.worker.ts 抽出（file-length +
 * cognitive-complexity 双重考量）。每个导出函数的第一个参数 `core` 是宿主
 * FsCore 实例；这里只是把原本内联在类里的方法体搬出来，`this.` 机械替换为
 * `core.`，行为逐字保留。依赖 OPFS/Worker 专属 API（FileSystemSyncAccessHandle
 * 等），不追求 lib 中立，因此不进 worker-lib/、且从主 tsconfig.json 里排除
 * （见 tsconfig.json 的 exclude）。
 */
import type { FsCore } from './fs-core.worker.js'
import {
  crc32, dec, decodeSlot, enc, encodeSlot, parseRecord, sha256hex, SLOT_SIZE,
  type SlotInfo, type WalRecord,
} from './worker-lib/wal-codec.js'
import { normalizePath } from './worker-lib/paths.js'
import type { CoreWireMessage } from './worker-lib/protocol.js'
import { epochFloor, OP, OPID_WINDOW, rpcErr, SEGMENT_ROTATE_BYTES, type MirrorEntry } from './worker-lib/engine-shared.js'

export { epochFloor }

// ── 启动：锁 → 恢复 → 打开写句柄 → 全量同步 query ──
export async function start(core: FsCore, projectId: string): Promise<void> {
  core.projectId = projectId
  core.root = await (await navigator.storage.getDirectory()).getDirectoryHandle(projectId, { create: true })
  core.bc = new BroadcastChannel('dwc:' + projectId)
  core.bc.onmessage = (e: MessageEvent) => core.onBroadcast(e.data)

  // 排队等锁；3s 拿不到先以只读服务，granted 后升级。禁止 steal。
  const granted = new Promise<Lock | null>((resolve) => {
    navigator.locks.request('dwc:writer:' + projectId, { mode: 'exclusive' }, (lock) => {
      resolve(lock)
      return new Promise<void>((release) => { core.releaseLock = release })
    }).catch(() => resolve(null))
  })
  const winner = await Promise.race([granted, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 3000))])
  if (winner === 'timeout') {
    await core.recover()
    core.mode = 'readonly'
    core.pushFullToQuery()
    core.welcome()
    granted.then(async (lock) => {
      if (!lock || core.mode === 'dead') return
      await core.enqueue(async () => { await core.becomeWriter() })
    })
    return
  }
  await core.becomeWriter()
  core.welcome()
}

export async function becomeWriter(core: FsCore): Promise<void> {
  await core.recover() // 旧写者可能刚交出——以盘上状态为准重建
  // epoch 递增写入候选槽（防御性护栏：记录归属可判别）
  core.sbHandle = await (await core.root.getFileHandle('superblock', { create: true })).createSyncAccessHandle()
  core.epoch += 1
  core.writeSuperblock()
  // 打开（或创建）最后一个 WAL 段，定位到有效前缀末尾
  const segName = 'wal.' + core.lastSegStart
  core.walHandle = await (await core.root.getFileHandle(segName, { create: true })).createSyncAccessHandle()
  core.walOffset = core.lastSegValidEnd
  core.mode = 'writer'
  core.pushFullToQuery()
  core.event({ evt: 'writer-granted', gen: core.memGen })
  // 启动补偿：上一世代积累的 WAL 已超阈值（如崩溃打断了 compaction）→ 立即整理
  if (core.walOffset > SEGMENT_ROTATE_BYTES) core.enqueue(() => core.compactNow())
}

export function writeSuperblock(core: FsCore): void {
  const cand = 1 - core.currentSlot
  const bytes = encodeSlot({ epoch: core.epoch, compactGen: core.compactGen, walStartGen: core.walStartGen, manifestCrc: core.manifestCrc || 0 })
  const n = core.sbHandle!.write(bytes, { at: cand * SLOT_SIZE })
  if (n !== SLOT_SIZE) throw new Error('superblock partial write: ' + n)
  core.sbHandle!.flush()
  core.currentSlot = cand
}

// ── 恢复：superblock 选槽 → manifest → 顺序回放 WAL 段（完整前缀截断） ──
async function loadSuperblockSlot(core: FsCore): Promise<SlotInfo> {
  let sb: SlotInfo | null = null
  try {
    const f = await (await core.root.getFileHandle('superblock')).getFile()
    const u8 = new Uint8Array(await f.arrayBuffer())
    const s0 = decodeSlot(u8.subarray(0, SLOT_SIZE))
    const s1 = u8.length >= 128 ? decodeSlot(u8.subarray(SLOT_SIZE, 2 * SLOT_SIZE)) : null
    if (s0 && s1) { sb = s1.compactGen > s0.compactGen || (s1.compactGen === s0.compactGen && s1.epoch >= s0.epoch) ? s1 : s0; core.currentSlot = sb === s1 ? 1 : 0 }
    else if (s0) { sb = s0; core.currentSlot = 0 }
    else if (s1) { sb = s1; core.currentSlot = 1 }
  } catch { /* 首次初始化 */ }
  if (!sb) {
    sb = { epoch: 0, compactGen: 0, walStartGen: 1, manifestCrc: 0 }
    core.currentSlot = 1 // 首个 writeSuperblock 落 slot0
  }
  return sb
}

async function loadManifestState(core: FsCore, compactGen: number): Promise<number> {
  if (compactGen <= 0) return 0
  const f = await (await (await core.root.getDirectoryHandle('manifests')).getFileHandle(compactGen + '.json')).getFile()
  const bytes = new Uint8Array(await f.arrayBuffer())
  if (crc32(bytes) !== core.manifestCrc) throw new Error('manifest CRC mismatch (gen ' + compactGen + ')')
  const m = JSON.parse(dec.decode(bytes))
  for (const [path, ent] of Object.entries(m.files) as Array<[string, { h: string; rev: number }]>) {
    core.mirror.set(path, { content: await core.readBlob(ent.h), rev: ent.rev })
  }
  for (const [cpId, entry] of Object.entries(m.checkpoints || {}) as Array<[string, { h: string; gen: number }]>) core.checkpoints.set(cpId, entry)
  return m.gen
}

async function listWalSegmentNumbers(core: FsCore): Promise<number[]> {
  const segs: number[] = []
  for await (const [name] of core.root.entries()) {
    const m = /^wal\.(\d+)$/.exec(name)
    if (m && +m[1]! >= core.walStartGen) segs.push(+m[1]!)
  }
  segs.sort((a, b) => a - b)
  return segs
}

function shouldStopReplay(p: { rec: WalRecord; next: number } | null, gen: number, stopBefore: number, replayed: WalRecord[]): boolean {
  if (!p) return true
  if (p.rec.gen !== gen + 1) return true
  if (p.rec.gen >= stopBefore) return true
  if (p.rec.epoch < epochFloor(replayed)) return true
  return false
}

/** 单个 WAL 段的回放；返回段内推进后的 gen。isLastSeg 时把有效前缀末尾写回
 * core.lastSegValidEnd（原 recover() 内联逻辑，行为不变）。 */
async function replaySegment(core: FsCore, segNum: number, stopBefore: number, gen: number, replayed: WalRecord[], isLastSeg: boolean): Promise<number> {
  const f = await (await core.root.getFileHandle('wal.' + segNum)).getFile()
  const u8 = new Uint8Array(await f.arrayBuffer())
  let off = 0
  while (off < u8.length) {
    const p = parseRecord(u8, off)
    if (shouldStopReplay(p, gen, stopBefore, replayed)) break
    await core.applyRecord(p!.rec)
    gen = p!.rec.gen
    replayed.push(p!.rec)
    const m = p!.rec.meta
    core.audit({ gen, opcode: p!.rec.opcode, actor: m.actor, turnId: m.turnId, path: m.path, from: m.from, to: m.to, cpId: m.cpId })
    off = p!.next
    if (isLastSeg) core.lastSegValidEnd = off
  }
  // 中间空段（!isLastSeg && off === 0）：允许，继续——无需额外处理。
  return gen
}

async function replayWalSegments(core: FsCore, segs: number[], gen0: number): Promise<{ finalGen: number; replayed: WalRecord[] }> {
  let gen = gen0
  const replayed: WalRecord[] = []
  for (let i = 0; i < segs.length; i++) {
    const stopBefore = i + 1 < segs.length ? segs[i + 1]! : Infinity
    gen = await replaySegment(core, segs[i]!, stopBefore, gen, replayed, segs[i] === core.lastSegStart)
  }
  return { finalGen: gen, replayed }
}

export async function recover(core: FsCore): Promise<void> {
  core.mirror.clear(); core.checkpoints.clear(); core.opIds.clear()
  core.auditLog = []; core.turn = null

  const sb = await loadSuperblockSlot(core)
  core.epoch = sb.epoch
  core.compactGen = sb.compactGen
  core.walStartGen = sb.walStartGen
  core.manifestCrc = sb.manifestCrc

  let gen = await loadManifestState(core, core.compactGen)

  // 列出 ≥ walStartGen 的段，按 startGen 升序回放；段边界优先于段内垃圾尾
  const segs = await listWalSegmentNumbers(core)
  core.lastSegStart = segs.length ? segs[segs.length - 1]! : core.walStartGen
  core.lastSegValidEnd = 0
  const { finalGen, replayed } = await replayWalSegments(core, segs, gen)
  gen = finalGen

  core.appendedGen = core.walGen = core.memGen = core.ackGen = gen
  core.trimCheckpoints() // 回放会重新加回历史 checkpoint 记录 → 恢复后同样裁剪
  for (const r of replayed.slice(-OPID_WINDOW)) {
    if (r.meta.opId) core.rememberOpId(r.meta.opId, { gen: r.gen })
  }
  if (!segs.length) {
    // 确保首段存在（空段无害；真正写入偏移由 walOffset 管理）
    await core.root.getFileHandle('wal.' + core.walStartGen, { create: true })
  }
}

export async function applyRecord(core: FsCore, r: WalRecord): Promise<void> {
  const m = r.meta
  switch (r.opcode) {
    case OP.WRITE: {
      const content = m.payload?.inline !== undefined ? m.payload.inline : await core.readBlob(m.payload!.h!)
      core.mirror.set(m.path!, { content, rev: r.gen })
      break
    }
    case OP.RM: core.mirror.delete(m.path!); break
    case OP.MV: {
      const e = core.mirror.get(m.from!)
      if (e) { core.mirror.delete(m.from!); core.mirror.set(m.to!, { content: e.content, rev: r.gen }) }
      break
    }
    case OP.MKDIR: break // 目录隐式；记录仅为审计
    case OP.CHECKPOINT: core.checkpoints.set(m.cpId!, { h: m.h!, gen: r.gen }); break
    case OP.RESTORE: {
      const map = JSON.parse(await core.readBlob(m.h!)) as Record<string, string>
      const next = new Map<string, MirrorEntry>()
      for (const [path, h] of Object.entries(map)) next.set(path, { content: await core.readBlob(h), rev: r.gen })
      core.mirror = next
      break
    }
  }
}

// ── blob 存取 ──
export async function ensureBlob(core: FsCore, content: string): Promise<string> {
  const bytes = enc.encode(content)
  const h = await sha256hex(bytes)
  const d2 = await (await core.root.getDirectoryHandle('blobs', { create: true })).getDirectoryHandle(h.slice(0, 2), { create: true })
  try { await d2.getFileHandle(h); return h } catch { /* 不存在则写入 */ }
  const fh = await d2.getFileHandle(h, { create: true })
  const sh = await fh.createSyncAccessHandle()
  sh.write(bytes); sh.flush(); sh.close()
  return h
}
export async function readBlob(core: FsCore, h: string): Promise<string> {
  const f = await (await (await (await core.root.getDirectoryHandle('blobs')).getDirectoryHandle(h.slice(0, 2))).getFileHandle(h)).getFile()
  return f.text()
}

// ── 读类 ──
export function opRead(core: FsCore, { path }: { path: string }): { content: string; rev: number; gen: number } {
  const norm = normalizePath(path)
  const e = norm && core.mirror.get(norm)
  if (!e) throw rpcErr('not-found', String(path))
  return { content: e.content, rev: e.rev, gen: core.memGen } // P0：镜像在内存，64KB 路由约束成为空转（见 §2.1）
}
export function opLs(core: FsCore): { paths: string[]; gen: number } { return { paths: [...core.mirror.keys()].sort(), gen: core.memGen } }
export function opStatus(core: FsCore): {
  mode: string; appendedGen: number; walGen: number; memGen: number; ackGen: number; compactGen: number; epoch: number; walStartGen: number
  checkpoints: string[]; turn: { turnId: string; cpId: string; expiresAt: number; ops: number } | null
} {
  const { mode, appendedGen, walGen, memGen, ackGen, compactGen, epoch, walStartGen } = core
  return {
    mode, appendedGen, walGen, memGen, ackGen, compactGen, epoch, walStartGen,
    checkpoints: [...core.checkpoints.keys()],
    turn: core.turn ? { turnId: core.turn.turnId, cpId: core.turn.cpId, expiresAt: core.turn.expiresAt, ops: core.turn.ops } : null,
  }
}

// ── query 同步 / 事件 ──
export function pushDiff(core: FsCore, diff: Record<string, MirrorEntry | null>, gen: number): void {
  if (!core.queryPort) return
  const wire: Record<string, { content: string; rev: number } | null> = {}
  for (const [p, ent] of Object.entries(diff)) wire[p] = ent ? { content: ent.content, rev: ent.rev } : null
  core.queryPort.postMessage({ gen, diff: wire })
}
export function pushFullToQuery(core: FsCore): void {
  if (!core.queryPort) return
  const files: Record<string, { content: string; rev: number }> = {}
  for (const [p, ent] of core.mirror) files[p] = { content: ent.content, rev: ent.rev }
  core.queryPort.postMessage({ gen: core.memGen, full: true, files })
}
export function event(core: FsCore, e: CoreWireMessage): void { if (core.clientPort) core.clientPort.postMessage(e) }
export function welcome(core: FsCore): void {
  core.event({ type: 'WELCOME', epoch: core.epoch, memGen: core.memGen, readonly: core.mode !== 'writer', mode: core.mode })
}

// ── 协作交接（禁 steal）──
export async function onBroadcast(core: FsCore, msg: { type?: string }): Promise<void> {
  if (msg.type === 'handover-request' && core.mode === 'writer') {
    core.mode = 'draining'
    await core.enqueue(async () => {
      core.flushWindow()
      core.walHandle!.close(); core.walHandle = null
      core.sbHandle!.close(); core.sbHandle = null
      core.mode = 'readonly'
      if (core.releaseLock) { core.releaseLock(); core.releaseLock = null }
      core.bc.postMessage({ type: 'handover-done', gen: core.memGen })
      core.event({ evt: 'writer-lost', gen: core.memGen })
    })
  }
}
