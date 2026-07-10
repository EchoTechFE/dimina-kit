/**
 * WAL 编解码（纯函数，lib 中立）—— crc32、superblock 槽、WAL 记录成帧/解析。
 * 从 fs-core.worker.ts 抽出：不含任何 OPFS/Worker 专属 API，可被主 tsconfig
 * （DOM lib）与 tsconfig.worker.json（WebWorker lib）两个 program 同时编译，
 * 因此 zip.ts（主 program 侧）与 fs-core.worker.ts（worker program 侧）
 * 都能 import 同一份 crc32/CRC_TABLE 实现（消除重复代码）。
 *
 * WAL 记录成帧：
 *   [u32 len][u64 gen][u32 epoch][u8 opcode][u16 metaLen][meta JSON][u32 crc32][u8 0xC1]
 *   len = len 字段之后的字节数；crc 覆盖 gen..meta 末尾。
 */
export const enc = new TextEncoder()
export const dec = new TextDecoder()

// ───────────────────────── crc32（查表法） ─────────────────────────
export const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
export function crc32(bytes: Uint8Array, start = 0, end: number = bytes.length): number {
  let c = 0xffffffff
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export async function sha256hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export interface SlotInfo {
  epoch: number
  compactGen: number
  walStartGen: number
  manifestCrc: number
}

const SB_MAGIC = 0x44574331 // 'DWC1'
export const SLOT_SIZE = 64

// ───────────────────────── superblock 槽编解码 ─────────────────────────
// 布局：magic u32 | epoch u32 | compactGen f64 | walStartGen f64 | manifestCrc u32 | pad→60 | crc32 u32
export function encodeSlot(s: SlotInfo): Uint8Array {
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
export function decodeSlot(bytes: Uint8Array): SlotInfo | null {
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

/** WAL 记录的 meta 载荷形状 —— 各 opcode 只填自己用到的字段（落 WAL 的持久
 * 线格式，字段名/结构不可随意变更，见 fs-core.worker.ts 里对应 op* 方法）。 */
export interface WalMeta {
  opId?: string
  path?: string
  from?: string
  to?: string
  actor?: string
  turnId?: string
  ifMatch?: number | null
  payload?: { inline?: string; h?: string }
  cpId?: string
  h?: string
}

export interface WalRecord {
  gen: number
  epoch: number
  opcode: number
  meta: WalMeta
}

// ───────────────────────── WAL 记录编解码 ─────────────────────────
export function frameRecord(gen: number, epoch: number, opcode: number, meta: unknown): Uint8Array {
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
export function parseRecord(u8: Uint8Array, off: number): { rec: WalRecord; next: number } | null {
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
  let meta: WalMeta
  try { meta = JSON.parse(dec.decode(u8.subarray(metaStart, crcAt))) as WalMeta } catch { return null }
  return { rec: { gen, epoch, opcode, meta }, next: off + 4 + len }
}
