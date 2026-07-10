/**
 * Contract tests for the binary side-car: classification, the size+sha256
 * index, echo judgement, bytes retention, overlay precedence, and change
 * events — the one authority every host's "binary never enters the string
 * ledger" handling builds on.
 */
import { describe, expect, it, vi } from 'vitest'
import { bytesEqual, createBinarySidecar, looksBinary } from './binary-sidecar.js'

const png = (...bytes: number[]) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, ...bytes])

describe('looksBinary', () => {
  it('classifies by a NUL byte in the first 8192 bytes', () => {
    expect(looksBinary(png())).toBe(true)
    expect(looksBinary(new TextEncoder().encode('plain text'))).toBe(false)
  })

  it('does not scan past the sniff window', () => {
    const big = new Uint8Array(10000).fill(0x61)
    big[9500] = 0 // NUL beyond the 8192-byte window
    expect(looksBinary(big)).toBe(false)
  })
})

describe('bytesEqual', () => {
  it('compares byte-for-byte', () => {
    expect(bytesEqual(png(1), png(1))).toBe(true)
    expect(bytesEqual(png(1), png(2))).toBe(false)
    expect(bytesEqual(png(), png(1))).toBe(false)
  })
})

describe('createBinarySidecar — index + echo judgement', () => {
  it('put() records a new entry and reports changed', async () => {
    const sc = createBinarySidecar()
    expect(await sc.put('a.png', png(1))).toBe(true)
    expect(sc.has('a.png')).toBe(true)
    const entry = sc.entry('a.png')
    expect(entry?.size).toBe(6)
    expect(entry?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(sc.size).toBe(1)
  })

  it('put() of identical bytes is an echo: unchanged, no event', async () => {
    const sc = createBinarySidecar()
    const onChange = vi.fn()
    await sc.put('a.png', png(1))
    sc.onChange(onChange)
    expect(await sc.put('a.png', png(1))).toBe(false)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('put() of different same-length bytes IS a change (sha decides, not size)', async () => {
    const sc = createBinarySidecar()
    await sc.put('a.png', png(1))
    expect(await sc.put('a.png', png(2))).toBe(true)
  })

  it('remove() reports whether an entry existed and emits null once', () => {
    const sc = createBinarySidecar()
    const onChange = vi.fn()
    sc.onChange(onChange)
    expect(sc.remove('ghost.png')).toBe(false)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('index-only sidecar retains no bytes and refuses overlay()', async () => {
    const sc = createBinarySidecar()
    await sc.put('a.png', png(1))
    expect(sc.bytes('a.png')).toBeUndefined()
    expect(sc.toRecord()).toEqual({})
    expect(() => sc.overlay({})).toThrow(/retainBytes/)
  })
})

describe('createBinarySidecar — retainBytes host shape', () => {
  it('retains bytes and overlays them UNDER the ledger files (ledger wins)', async () => {
    const sc = createBinarySidecar({ retainBytes: true })
    await sc.put('img/a.png', png(1))
    await sc.put('both.txt', png(9))
    const merged = sc.overlay({ 'app.json': '{}', 'both.txt': 'ledger text' })
    expect(merged['img/a.png']).toEqual(png(1))
    expect(merged['app.json']).toBe('{}')
    expect(merged['both.txt']).toBe('ledger text')
  })

  it('reset() reseeds silently-cleared state with the new entries', async () => {
    const sc = createBinarySidecar({ retainBytes: true })
    await sc.put('old.png', png(1))
    await sc.reset({ 'new.png': png(2) })
    expect(sc.has('old.png')).toBe(false)
    expect(sc.keys()).toEqual(['new.png'])
    expect(sc.bytes('new.png')).toEqual(png(2))
  })

  it('onChange fires for effective put/remove, unsubscribes cleanly, and a throwing subscriber cannot break the mutation', async () => {
    const sc = createBinarySidecar({ retainBytes: true })
    const seen: Array<[string, Uint8Array | null]> = []
    sc.onChange(() => {
      throw new Error('subscriber bug')
    })
    const off = sc.onChange((rel, bytes) => seen.push([rel, bytes]))
    await sc.put('a.png', png(1))
    sc.remove('a.png')
    expect(seen).toEqual([
      ['a.png', png(1)],
      ['a.png', null],
    ])
    expect(sc.has('a.png')).toBe(false)
    off()
    await sc.put('b.png', png(2))
    expect(seen).toHaveLength(2)
  })

  it('clear() is a silent session reseed: no per-entry removal events', async () => {
    const sc = createBinarySidecar({ retainBytes: true })
    await sc.put('a.png', png(1))
    const onChange = vi.fn()
    sc.onChange(onChange)
    sc.clear()
    expect(sc.size).toBe(0)
    expect(sc.toRecord()).toEqual({})
    expect(onChange).not.toHaveBeenCalled()
  })
})
