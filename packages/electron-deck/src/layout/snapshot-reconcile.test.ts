import { describe, it, expect } from 'vitest'
import { reconcile, createInitialState } from './placement-reconcile.js'
import type { Placement } from './placement-reconcile.js'
import { cleanSnapshot, dispatchOps } from './snapshot-reconcile.js'
import type { Authorizer } from './snapshot-reconcile.js'

// ── Test fixtures ─────────────────────────────────────────────────────────────

const B0 = { x: 0, y: 0, width: 100, height: 100 }
const B1 = { x: 50, y: 50, width: 200, height: 200 }

// A raw view element with an extra.slotToken field.
function rawView(token: string, placement: unknown = { visible: false }, rawViewId = 'raw-id') {
  return { viewId: rawViewId, placement, extra: { slotToken: token } }
}

// A raw snapshot skeleton; merges overrides on top.
function rawSnap(overrides: Record<string, unknown> = {}): unknown {
  return { generation: 1, epoch: 0, views: [], ...overrides }
}

// ── cleanSnapshot ─────────────────────────────────────────────────────────────

describe('cleanSnapshot', () => {
  describe('rejects invalid raw shapes', () => {
    const passAll: Authorizer = () => ({ viewId: 'v', layer: 0 })

    it('returns null for null', () => {
      expect(cleanSnapshot(null, passAll)).toBeNull()
    })

    it('returns null for an array', () => {
      expect(cleanSnapshot([1, 2, 3], passAll)).toBeNull()
    })

    it('returns null when generation is absent', () => {
      expect(cleanSnapshot({ epoch: 0, views: [] }, passAll)).toBeNull()
    })

    it('returns null when generation is negative', () => {
      expect(cleanSnapshot({ generation: -1, epoch: 0, views: [] }, passAll)).toBeNull()
    })

    it('returns null when generation is a non-integer', () => {
      expect(cleanSnapshot({ generation: 1.5, epoch: 0, views: [] }, passAll)).toBeNull()
    })

    it('returns null when epoch is absent', () => {
      expect(cleanSnapshot({ generation: 0, views: [] }, passAll)).toBeNull()
    })

    it('returns null when epoch is negative', () => {
      expect(cleanSnapshot({ generation: 0, epoch: -1, views: [] }, passAll)).toBeNull()
    })

    it('returns null when views is not an array', () => {
      expect(cleanSnapshot({ generation: 0, epoch: 0, views: 'oops' }, passAll)).toBeNull()
    })
  })

  describe('per-view filtering', () => {
    it('discards views whose slotToken the authorizer cannot resolve', () => {
      const rejectAll: Authorizer = () => null
      const raw = rawSnap({ views: [rawView('unknown-tok')] })
      // All views discarded from a non-empty list → whole snapshot rejected.
      expect(cleanSnapshot(raw, rejectAll)).toBeNull()
    })

    it('discards views with visible:true but missing bounds', () => {
      const auth: Authorizer = (tok) => (tok === 'k' ? { viewId: 'v', layer: 0 } : null)
      const raw = rawSnap({ views: [rawView('k', { visible: true /* no bounds */ })] })
      expect(cleanSnapshot(raw, auth)).toBeNull()
    })

    it('discards views with a non-finite bound coordinate', () => {
      const auth: Authorizer = (tok) => (tok === 'k' ? { viewId: 'v', layer: 0 } : null)
      const raw = rawSnap({
        views: [rawView('k', { visible: true, bounds: { x: Infinity, y: 0, width: 100, height: 100 } })],
      })
      expect(cleanSnapshot(raw, auth)).toBeNull()
    })

    it('viewId in the result comes from the authorizer, never from the raw view field', () => {
      const auth: Authorizer = (tok) =>
        tok === 'real-tok' ? { viewId: 'real', layer: 3 } : null
      // Raw carries a different (attacker-supplied) viewId field.
      const raw = rawSnap({
        views: [{ viewId: 'attacker', placement: { visible: false }, extra: { slotToken: 'real-tok' } }],
      })
      const result = cleanSnapshot(raw, auth)
      expect(result).not.toBeNull()
      expect(result!.views[0]!.viewId).toBe('real')
      expect(result!.views[0]!.layer).toBe(3)
    })

    it('keeps valid views and silently drops invalid ones in the same snapshot', () => {
      const auth: Authorizer = (tok) =>
        tok === 'good' ? { viewId: 'v-good', layer: 0 } : null
      const raw = rawSnap({
        views: [rawView('bad'), rawView('good', { visible: false })],
      })
      const result = cleanSnapshot(raw, auth)
      expect(result).not.toBeNull()
      expect(result!.views).toHaveLength(1)
      expect(result!.views[0]!.viewId).toBe('v-good')
    })
  })

  describe('empty views array vs all-discarded', () => {
    it('returns a CleanSnapshot (not null) when views is an empty array', () => {
      const raw = rawSnap({ views: [] })
      const result = cleanSnapshot(raw, () => null)
      expect(result).not.toBeNull()
      expect(result!.views).toHaveLength(0)
    })

    it('returns null when views is non-empty but every view is discarded', () => {
      const rejectAll: Authorizer = () => null
      const raw = rawSnap({ views: [rawView('tok-a'), rawView('tok-b')] })
      expect(cleanSnapshot(raw, rejectAll)).toBeNull()
    })

    it('deduplicates views mapping to the same viewId, keeping the first', () => {
      let callCount = 0
      // Both tokens resolve to the same viewId but with incrementing layer.
      const auth: Authorizer = () => ({ viewId: 'shared', layer: callCount++ })
      const raw = rawSnap({
        views: [
          rawView('tok-1', { visible: false }),
          rawView('tok-2', { visible: false }),
        ],
      })
      const result = cleanSnapshot(raw, auth)
      expect(result).not.toBeNull()
      expect(result!.views).toHaveLength(1)
      // First view wins (layer === 0, not 1).
      expect(result!.views[0]!.layer).toBe(0)
    })
  })

  describe('generation and epoch pass-through', () => {
    it('copies generation and epoch from the raw snapshot verbatim', () => {
      const auth: Authorizer = () => ({ viewId: 'v', layer: 0 })
      const raw = { generation: 99, epoch: 42, views: [rawView('tok', { visible: false })] }
      const result = cleanSnapshot(raw as unknown, auth)
      expect(result).not.toBeNull()
      expect(result!.generation).toBe(99)
      expect(result!.epoch).toBe(42)
    })
  })
})

// ── dispatchOps ───────────────────────────────────────────────────────────────

describe('dispatchOps', () => {
  function mkView(id: string, p: Placement = { visible: true, bounds: B0 }) {
    return { viewId: id, placement: p, layer: 0 }
  }

  it('a setBounds op causes apply to receive visible:true with the new bounds', () => {
    const s0 = createInitialState()
    const { state: s1 } = reconcile(s0, {
      generation: 1, epoch: 0,
      views: [mkView('v1', { visible: true, bounds: B0 })],
    })
    const { state: s2, ops } = reconcile(s1, {
      generation: 1, epoch: 1,
      views: [mkView('v1', { visible: true, bounds: B1 })],
    })

    const calls: Placement[] = []
    dispatchOps(ops, s2, (id) => (id === 'v1' ? (p: Placement) => { calls.push(p) } : null))

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ visible: true, bounds: B1 })
  })

  it('a detach op (view removed from snapshot) causes apply to receive visible:false', () => {
    const s0 = createInitialState()
    const { state: s1 } = reconcile(s0, { generation: 1, epoch: 0, views: [mkView('v1')] })
    const { state: s2, ops } = reconcile(s1, { generation: 1, epoch: 1, views: [] })

    const calls: Placement[] = []
    dispatchOps(ops, s2, (id) => (id === 'v1' ? (p: Placement) => { calls.push(p) } : null))

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ visible: false })
  })

  it('a setVisible:false op causes apply to receive visible:false', () => {
    const s0 = createInitialState()
    const { state: s1 } = reconcile(s0, { generation: 1, epoch: 0, views: [mkView('v1')] })
    const { state: s2, ops } = reconcile(s1, {
      generation: 1, epoch: 1,
      views: [mkView('v1', { visible: false })],
    })

    const calls: Placement[] = []
    dispatchOps(ops, s2, (id) => (id === 'v1' ? (p: Placement) => { calls.push(p) } : null))

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ visible: false })
  })

  it('a bare setVisible:true (restore with unchanged bounds) causes apply to receive visible:true with stored bounds', () => {
    const s0 = createInitialState()
    const { state: s1 } = reconcile(s0, {
      generation: 1, epoch: 0,
      views: [mkView('v1', { visible: true, bounds: B0 })],
    })
    const { state: s2 } = reconcile(s1, {
      generation: 1, epoch: 1,
      views: [mkView('v1', { visible: false })],
    })
    // Restore with same bounds — reconciler emits only setVisible:true (no setBounds).
    const { state: s3, ops } = reconcile(s2, {
      generation: 1, epoch: 2,
      views: [mkView('v1', { visible: true, bounds: B0 })],
    })

    const calls: Placement[] = []
    dispatchOps(ops, s3, (id) => (id === 'v1' ? (p: Placement) => { calls.push(p) } : null))

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ visible: true, bounds: B0 })
  })

  it('a reorder op does not trigger any apply call', () => {
    const s0 = createInitialState()
    // Attaching two new views generates a reorder op alongside setBounds/attach.
    const { state: s1, ops } = reconcile(s0, {
      generation: 1, epoch: 0,
      views: [
        mkView('v1', { visible: true, bounds: B0 }),
        mkView('v2', { visible: true, bounds: B0 }),
      ],
    })

    let callCount = 0
    dispatchOps(ops, s1, (_id) => (_p: Placement) => { callCount++ })

    // ops: setBounds(v1), attach(v1), setBounds(v2), attach(v2), reorder([v1,v2])
    // touched = {v1, v2}; reorder has no viewId and is skipped → exactly 2 calls.
    expect(callCount).toBe(2)
  })

  it('skips without throwing when resolveApply returns null', () => {
    const s0 = createInitialState()
    const { state, ops } = reconcile(s0, { generation: 1, epoch: 0, views: [mkView('v1')] })
    expect(() => dispatchOps(ops, state, () => null)).not.toThrow()
  })

  it('per-view apply errors are isolated — other views still receive apply', () => {
    const s0 = createInitialState()
    const { state, ops } = reconcile(s0, {
      generation: 1, epoch: 0,
      views: [
        mkView('v1', { visible: true, bounds: B0 }),
        mkView('v2', { visible: true, bounds: B0 }),
        mkView('v3', { visible: true, bounds: B0 }),
      ],
    })

    const called: string[] = []
    dispatchOps(ops, state, (id) => {
      if (id === 'v1') return (_p: Placement) => { called.push('v1') }
      if (id === 'v2') return (_p: Placement) => { throw new Error('boom') }
      if (id === 'v3') return (_p: Placement) => { called.push('v3') }
      return null
    })

    expect(called).toContain('v1')
    expect(called).toContain('v3')
  })
})
