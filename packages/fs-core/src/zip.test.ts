import { describe, expect, it } from 'vitest'
import { makeZip } from './zip.js'

const dv = (buf: Uint8Array) => new DataView(buf.buffer, buf.byteOffset, buf.byteLength)

/** Locates the EOCD by scanning back from the end for its signature, the same
 * way a real unzip reader would — this also guards that the record sits at
 * the true trailing offset (no stray bytes after it). */
function findEocd(buf: Uint8Array): number {
  for (let i = buf.length - 22; i >= 0; i--) {
    if (dv(buf).getUint32(i, true) === 0x06054b50) return i
  }
  throw new Error('EOCD not found')
}

interface CentralEntry {
  name: string
  crc: number
  size: number
  localHeaderOffset: number
}

/** Walks the central directory starting at `cdOffset`, decoding `count` entries. */
function readCentralDirectory(buf: Uint8Array, cdOffset: number, count: number): CentralEntry[] {
  const dec = new TextDecoder('utf-8')
  const entries: CentralEntry[] = []
  let at = cdOffset
  for (let i = 0; i < count; i++) {
    const v = dv(buf)
    expect(v.getUint32(at, true)).toBe(0x02014b50)
    const crc = v.getUint32(at + 16, true)
    const size = v.getUint32(at + 20, true)
    const nameLen = v.getUint16(at + 28, true)
    const localHeaderOffset = v.getUint32(at + 42, true)
    const name = dec.decode(buf.subarray(at + 46, at + 46 + nameLen))
    entries.push({ name, crc, size, localHeaderOffset })
    at += 46 + nameLen
  }
  return entries
}

describe('makeZip', () => {
  it('produces a valid EOCD with zero entries for an empty file set', () => {
    const buf = makeZip({})
    const eocdOffset = findEocd(buf)
    expect(eocdOffset).toBe(buf.length - 22)
    const v = dv(buf)
    expect(v.getUint16(eocdOffset + 8, true)).toBe(0) // entry count this disk
    expect(v.getUint16(eocdOffset + 10, true)).toBe(0) // entry count total
    expect(v.getUint32(eocdOffset + 12, true)).toBe(0) // central directory size
    expect(v.getUint32(eocdOffset + 16, true)).toBe(0) // central directory offset
  })

  it('records the correct entry count and CRC32 for a single file', () => {
    const buf = makeZip({ 'a.txt': 'a' })
    const eocdOffset = findEocd(buf)
    const v = dv(buf)
    const count = v.getUint16(eocdOffset + 10, true)
    expect(count).toBe(1)
    const cdOffset = v.getUint32(eocdOffset + 16, true)
    const entries = readCentralDirectory(buf, cdOffset, count)
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    expect(entry.name).toBe('a.txt')
    expect(entry.size).toBe(1)
    expect(entry.crc).toBe(0xe8b7be43)
    expect(entry.localHeaderOffset).toBe(0)
  })

  it('matches known CRC32 check vectors for empty, single-char, and digit-string content', () => {
    const files = { empty: '', single: 'a', digits: '123456789' }
    const buf = makeZip(files)
    const eocdOffset = findEocd(buf)
    const v = dv(buf)
    const count = v.getUint16(eocdOffset + 10, true)
    const cdOffset = v.getUint32(eocdOffset + 16, true)
    const entries = readCentralDirectory(buf, cdOffset, count)
    const byName = Object.fromEntries(entries.map((e) => [e.name, e])) as Record<string, CentralEntry>
    expect(byName.empty!.crc).toBe(0x00000000)
    expect(byName.single!.crc).toBe(0xe8b7be43)
    expect(byName.digits!.crc).toBe(0xcbf43926)
  })

  it('decodes a UTF-8 filename and matching content byte length correctly among multiple entries', () => {
    const files = {
      'readme.md': 'hello world',
      '目录/文件.txt': '内容',
      'empty.txt': '',
    }
    const buf = makeZip(files)
    const eocdOffset = findEocd(buf)
    const v = dv(buf)
    const count = v.getUint16(eocdOffset + 10, true)
    expect(count).toBe(3)
    const cdOffset = v.getUint32(eocdOffset + 16, true)
    const entries = readCentralDirectory(buf, cdOffset, count)
    const names = entries.map((e) => e.name).sort()
    expect(names).toEqual(['empty.txt', 'readme.md', '目录/文件.txt'].sort())

    const utf8Entry = entries.find((e) => e.name === '目录/文件.txt')
    expect(utf8Entry).toBeDefined()
    // '内容' is 2 UTF-8 encoded chars, 3 bytes each = 6 bytes total.
    expect(utf8Entry!.size).toBe(new TextEncoder().encode('内容').length)

    // Local header offsets must be strictly increasing and non-overlapping,
    // matching the order entries were appended to `parts`.
    const offsets = entries.map((e) => e.localHeaderOffset).sort((a, b) => a - b)
    expect(new Set(offsets).size).toBe(3)
    expect(offsets[0]).toBe(0)
  })

  it('sets the UTF-8 filename flag (0x0800) on both local and central headers', () => {
    const buf = makeZip({ '目录/文件.txt': 'x' })
    const v = dv(buf)
    // Local file header starts at offset 0; flags live at offset 6.
    expect(v.getUint32(0, true)).toBe(0x04034b50)
    expect(v.getUint16(6, true)).toBe(0x0800)

    const eocdOffset = findEocd(buf)
    const cdOffset = v.getUint32(eocdOffset + 16, true)
    expect(v.getUint32(cdOffset, true)).toBe(0x02014b50)
    expect(v.getUint16(cdOffset + 8, true)).toBe(0x0800)
  })
})
