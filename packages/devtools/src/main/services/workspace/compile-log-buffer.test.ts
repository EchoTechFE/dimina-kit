/**
 * CompileLogBuffer — cursor-readable ring buffer over compile log lines.
 *
 * Contracts pinned here:
 *  - seq is 1-based, monotonic, and survives clear() — a stale cursor from
 *    before a clear reads the NEW compile's lines instead of duplicating
 *  - read() is oldest-first forward pagination: entries with seq > afterSeq,
 *    capped at limit, nextCursor = last returned seq (unchanged when empty)
 *  - stream filter applies before the limit cap
 *  - capacity eviction drops the oldest entries
 */
import { describe, it, expect } from 'vitest'
import { createCompileLogBuffer } from './compile-log-buffer.js'

function line(text: string, stream: 'stdout' | 'stderr' = 'stdout') {
  return { at: 0, stream, text }
}

describe('CompileLogBuffer', () => {
  it('assigns 1-based monotonic seq and pages forward by cursor', () => {
    const buf = createCompileLogBuffer()
    buf.append(line('a'))
    buf.append(line('b'))
    buf.append(line('c'))

    const first = buf.read({ limit: 2 })
    expect(first.entries.map((e) => [e.seq, e.text])).toEqual([[1, 'a'], [2, 'b']])
    expect(first.nextCursor).toBe(2)

    const second = buf.read({ afterSeq: first.nextCursor, limit: 2 })
    expect(second.entries.map((e) => e.text)).toEqual(['c'])
    expect(second.nextCursor).toBe(3)

    // Nothing new: cursor is returned unchanged so polling is idempotent.
    const third = buf.read({ afterSeq: second.nextCursor })
    expect(third.entries).toEqual([])
    expect(third.nextCursor).toBe(3)
  })

  it('filters by stream without disturbing the cursor arithmetic', () => {
    const buf = createCompileLogBuffer()
    buf.append(line('out1', 'stdout'))
    buf.append(line('err1', 'stderr'))
    buf.append(line('out2', 'stdout'))
    buf.append(line('err2', 'stderr'))

    const errs = buf.read({ stream: 'stderr' })
    expect(errs.entries.map((e) => e.text)).toEqual(['err1', 'err2'])
    // nextCursor is the last MATCHED seq — a follow-up read resumes after it.
    expect(errs.nextCursor).toBe(4)
    expect(buf.read({ afterSeq: errs.nextCursor, stream: 'stderr' }).entries).toEqual([])
  })

  it('evicts oldest entries past capacity but never reuses seq', () => {
    const buf = createCompileLogBuffer(3)
    for (const t of ['a', 'b', 'c', 'd', 'e']) buf.append(line(t))

    const all = buf.read({ limit: 100 })
    expect(all.entries.map((e) => [e.seq, e.text])).toEqual([[3, 'c'], [4, 'd'], [5, 'e']])
  })

  it('clear() drops entries but keeps the seq counter, so stale cursors stay valid', () => {
    const buf = createCompileLogBuffer()
    buf.append(line('old1'))
    buf.append(line('old2'))
    const cursor = buf.read({}).nextCursor
    expect(cursor).toBe(2)

    buf.clear()
    expect(buf.read({}).entries).toEqual([])

    buf.append(line('new1'))
    // The pre-clear cursor reads exactly the new compile's lines — no
    // duplicates, no gap-skipping surprises.
    const after = buf.read({ afterSeq: cursor })
    expect(after.entries.map((e) => [e.seq, e.text])).toEqual([[3, 'new1']])
  })
})
