/**
 * Behavior tests for the `debugTap` observability primitive described in
 * packages/workbench/docs/foundation.md §7.
 *
 * Contract under test (the implementation in `./debug-tap.js` is in place; these
 * tests pin its behavior):
 *
 *   createDebugTap(options?: { enabled?: boolean; capacity?: number }): DebugTap
 *
 *   interface DebugTap {
 *     readonly enabled: boolean
 *     record(entry: DebugTapEntry): void   // NO-OP when disabled (hot path)
 *     entries(): readonly DebugTapEntry[]   // snapshot, oldest -> newest
 *     clear(): void
 *   }
 *
 *   interface DebugTapEntry {
 *     ts: number                       // supplied by CALLER (primitive never
 *                                      // calls Date.now() — forbidden in this pkg)
 *     channel: string
 *     direction: 'in' | 'out'
 *     connectionId?: number
 *     appSessionId?: string
 *     durationMs?: number
 *     error?: string
 *     summary?: string
 *   }
 *
 * §7 says it is a flag-gated ring buffer hung off the single dispatch
 * chokepoint, so the gate must be OFF by default (near-free hot path) and the
 * buffer must be bounded so a long-lived session cannot leak memory.
 *
 * NOTE: tests pass explicit, monotonic `ts` (1, 2, 3, ...) — never Date.now() —
 * because the workbench package forbids reading wall-clock time inside the
 * primitive; the caller owns the timestamp.
 */
import { describe, it, expect } from 'vitest'

import { createDebugTap, type DebugTap, type DebugTapEntry } from './debug-tap.js'

/** Build a well-formed entry with a caller-supplied monotonic `ts`. */
function entry(ts: number, over: Partial<DebugTapEntry> = {}): DebugTapEntry {
  return {
    ts,
    channel: 'service:invoke',
    direction: 'in',
    ...over,
  }
}

describe('createDebugTap', () => {
  describe('default = OFF (flag-gated, hot path near-free)', () => {
    it('is disabled by default and record() is a no-op leaving entries() empty', () => {
      const tap = createDebugTap()

      expect(tap.enabled).toBe(false)

      tap.record(entry(1))
      tap.record(entry(2, { direction: 'out' }))
      tap.record(entry(3))

      expect(tap.entries()).toEqual([])
      expect(tap.entries()).toHaveLength(0)
    })

    it('stays a no-op when explicitly constructed with enabled:false', () => {
      const tap = createDebugTap({ enabled: false, capacity: 8 })
      expect(tap.enabled).toBe(false)
      tap.record(entry(1))
      expect(tap.entries()).toEqual([])
    })
  })

  describe('enabled getter reflects the option', () => {
    it('is true when enabled:true', () => {
      expect(createDebugTap({ enabled: true }).enabled).toBe(true)
    })

    it('is false when enabled:false', () => {
      expect(createDebugTap({ enabled: false }).enabled).toBe(false)
    })
  })

  describe('when enabled', () => {
    it('appends records and returns them oldest -> newest', () => {
      const tap = createDebugTap({ enabled: true })

      const a = entry(1, { channel: 'a', direction: 'in', connectionId: 7 })
      const b = entry(2, { channel: 'b', direction: 'out', appSessionId: 's1' })
      const c = entry(3, { channel: 'c', direction: 'in', durationMs: 12, summary: 'ok' })

      tap.record(a)
      tap.record(b)
      tap.record(c)

      const got = tap.entries()
      expect(got).toHaveLength(3)
      // oldest first, newest last
      expect(got.map((e) => e.ts)).toEqual([1, 2, 3])
      expect(got[0]).toMatchObject({ channel: 'a', direction: 'in', connectionId: 7 })
      expect(got[1]).toMatchObject({ channel: 'b', direction: 'out', appSessionId: 's1' })
      expect(got[2]).toMatchObject({ channel: 'c', direction: 'in', durationMs: 12, summary: 'ok' })
    })

    it('preserves the optional error field', () => {
      const tap = createDebugTap({ enabled: true })
      tap.record(entry(1, { error: 'boom', direction: 'out' }))
      expect(tap.entries()[0]).toMatchObject({ error: 'boom', direction: 'out' })
    })
  })

  describe('ring buffer eviction', () => {
    it('keeps only the most recent N when recording N+K (oldest evicted)', () => {
      const capacity = 3
      const tap = createDebugTap({ enabled: true, capacity })

      // record 3 + 2 = 5 entries; ts 1..5
      for (let ts = 1; ts <= 5; ts++) {
        tap.record(entry(ts))
      }

      const got = tap.entries()
      expect(got).toHaveLength(capacity)
      // ts 1 and 2 evicted; exact surviving contents = 3,4,5 oldest->newest
      expect(got.map((e) => e.ts)).toEqual([3, 4, 5])
    })

    it('exactly at capacity keeps everything', () => {
      const tap = createDebugTap({ enabled: true, capacity: 4 })
      for (let ts = 1; ts <= 4; ts++) tap.record(entry(ts))
      expect(tap.entries().map((e) => e.ts)).toEqual([1, 2, 3, 4])
    })
  })

  describe('default capacity is finite (bounded, no leak)', () => {
    it('caps at 1000 when no capacity option is given', () => {
      const tap = createDebugTap({ enabled: true })

      // record well past the default bound
      const total = 1000 + 500
      for (let ts = 1; ts <= total; ts++) {
        tap.record(entry(ts))
      }

      const got = tap.entries()
      expect(got).toHaveLength(1000)
      // newest is the last recorded; oldest is exactly 1000 back from it
      expect(got[got.length - 1]!.ts).toBe(total)
      expect(got[0]!.ts).toBe(total - 1000 + 1)
    })
  })

  describe('clear()', () => {
    it('empties the buffer and recording after clear works', () => {
      const tap = createDebugTap({ enabled: true })
      tap.record(entry(1))
      tap.record(entry(2))
      expect(tap.entries()).toHaveLength(2)

      tap.clear()
      expect(tap.entries()).toEqual([])

      tap.record(entry(3))
      const got = tap.entries()
      expect(got.map((e) => e.ts)).toEqual([3])
    })
  })

  describe('entries() returns an immutable snapshot', () => {
    it('a held snapshot does not change when record() is called afterward', () => {
      const tap = createDebugTap({ enabled: true })
      tap.record(entry(1))
      tap.record(entry(2))

      const snapshot = tap.entries()
      expect(snapshot).toHaveLength(2)

      // mutate the buffer after taking the snapshot
      tap.record(entry(3))
      tap.record(entry(4))

      // the previously-held snapshot must be unaffected
      expect(snapshot).toHaveLength(2)
      expect(snapshot.map((e) => e.ts)).toEqual([1, 2])

      // and a fresh read reflects the new state
      expect(tap.entries().map((e) => e.ts)).toEqual([1, 2, 3, 4])
    })

    it('callers cannot corrupt internal state by mutating a returned snapshot', () => {
      const tap = createDebugTap({ enabled: true })
      tap.record(entry(1))

      const snapshot = tap.entries() as DebugTapEntry[]
      // attempt to push into the returned array; even if it succeeds locally it
      // must not affect the tap's own buffer
      try {
        snapshot.push(entry(99))
      } catch {
        // frozen array is an acceptable stronger guarantee
      }

      expect(tap.entries().map((e) => e.ts)).toEqual([1])
    })
  })
})
