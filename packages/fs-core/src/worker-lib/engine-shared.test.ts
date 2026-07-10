import { describe, expect, it } from 'vitest'
import { epochFloor, rpcErr } from './engine-shared.js'
import type { WalRecord } from './wal-codec.js'

describe('rpcErr', () => {
  it('builds an Error carrying a code', () => {
    const e = rpcErr('not-found', 'missing thing')
    expect(e).toBeInstanceOf(Error)
    expect(e.message).toBe('missing thing')
    expect(e.code).toBe('not-found')
    expect(e.extra).toBeUndefined()
  })

  it('attaches optional extra fields', () => {
    const e = rpcErr('restore-conflict', 'boom', { humanPaths: ['a.txt'] })
    expect(e.extra).toEqual({ humanPaths: ['a.txt'] })
  })
})

describe('epochFloor', () => {
  const rec = (epoch: number): WalRecord => ({ gen: 1, epoch, opcode: 1, meta: {} })

  it('returns 0 for an empty replay list (epoch floor before anything replayed)', () => {
    expect(epochFloor([])).toBe(0)
  })

  it('returns the last replayed record\'s epoch', () => {
    expect(epochFloor([rec(0), rec(2), rec(2)])).toBe(2)
  })
})
