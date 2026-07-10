import { describe, expect, it } from 'vitest'
import { crc32, decodeSlot, encodeSlot, frameRecord, parseRecord, sha256hex } from './wal-codec.js'

describe('crc32', () => {
  it('matches the well-known CRC-32 of "123456789" (0xCBF43926)', () => {
    const bytes = new TextEncoder().encode('123456789')
    expect(crc32(bytes)).toBe(0xcbf43926)
  })

  it('returns 0 for an empty input', () => {
    expect(crc32(new Uint8Array(0))).toBe(0)
  })

  it('honors the start/end window', () => {
    const bytes = new TextEncoder().encode('xx123456789yy')
    expect(crc32(bytes, 2, 11)).toBe(0xcbf43926)
  })
})

describe('sha256hex', () => {
  it('matches the well-known SHA-256 of the empty string', async () => {
    const hex = await sha256hex(new Uint8Array(0))
    expect(hex).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })
})

describe('superblock slot encode/decode', () => {
  it('round-trips a slot', () => {
    const slot = { epoch: 7, compactGen: 42, walStartGen: 43, manifestCrc: 0xdeadbeef }
    const decoded = decodeSlot(encodeSlot(slot))
    expect(decoded).toEqual(slot)
  })

  it('rejects a corrupted slot (bad CRC)', () => {
    const bytes = encodeSlot({ epoch: 1, compactGen: 2, walStartGen: 3, manifestCrc: 4 })
    bytes[0] = bytes[0]! ^ 0xff // flip a byte inside the magic — CRC no longer matches
    expect(decodeSlot(bytes)).toBeNull()
  })

  it('rejects a too-short buffer', () => {
    expect(decodeSlot(new Uint8Array(10))).toBeNull()
  })
})

describe('WAL record frame/parse', () => {
  it('round-trips a record through frameRecord → parseRecord', () => {
    const meta = { path: 'a.txt', actor: 'human', payload: { inline: 'hi' } }
    const frame = frameRecord(5, 1, 1, meta)
    const parsed = parseRecord(frame, 0)
    expect(parsed).not.toBeNull()
    expect(parsed!.rec).toEqual({ gen: 5, epoch: 1, opcode: 1, meta })
    expect(parsed!.next).toBe(frame.length)
  })

  it('parses back-to-back records at sequential offsets', () => {
    const a = frameRecord(1, 0, 1, { path: 'a' })
    const b = frameRecord(2, 0, 2, { path: 'a' })
    const buf = new Uint8Array(a.length + b.length)
    buf.set(a, 0); buf.set(b, a.length)
    const first = parseRecord(buf, 0)!
    expect(first.rec.gen).toBe(1)
    const second = parseRecord(buf, first.next)!
    expect(second.rec.gen).toBe(2)
    expect(second.next).toBe(buf.length)
  })

  it('returns null on a truncated buffer', () => {
    const frame = frameRecord(1, 0, 1, { path: 'a' })
    expect(parseRecord(frame.subarray(0, frame.length - 1), 0)).toBeNull()
  })

  it('returns null when the trailing CRC is corrupted', () => {
    const frame = frameRecord(1, 0, 1, { path: 'a' })
    frame[frame.length - 2] = frame[frame.length - 2]! ^ 0xff
    expect(parseRecord(frame, 0)).toBeNull()
  })

  it('returns null when the commit byte is wrong', () => {
    const frame = frameRecord(1, 0, 1, { path: 'a' })
    frame[frame.length - 1] = 0x00
    expect(parseRecord(frame, 0)).toBeNull()
  })
})
