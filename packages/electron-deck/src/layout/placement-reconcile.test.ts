import { describe, expect, it } from 'vitest'
import {
  createInitialState,
  reconcile,
  type ActualView,
  type Bounds,
  type DesiredView,
  type Placement,
  type PlacementSnapshot,
  type ReconcilerState,
  type ViewOp,
} from './placement-reconcile.js'

// The reconciler is domain-neutral: view ids are opaque strings and per-view
// host specifics ride on the Extra type parameter. These tests pin an example
// Extra (a simulator-style zoom) to exercise passthrough.
type Zoom = { zoom?: number }

const B = (x: number, y: number, width: number, height: number): Bounds => ({
  x,
  y,
  width,
  height,
})

const visible = (b: Bounds): Placement => ({ visible: true, bounds: b })
const hidden: Placement = { visible: false }

const dv = (
  viewId: string,
  placement: Placement,
  layer: number,
  extra?: Zoom,
): DesiredView<Zoom> => ({ viewId, placement, layer, ...(extra ? { extra } : {}) })

const snap = (
  generation: number,
  epoch: number,
  views: DesiredView<Zoom>[],
): PlacementSnapshot<Zoom> => ({ generation, epoch, views })

const kinds = (ops: ViewOp<Zoom>[]): string[] => ops.map((o) => o.kind)

/** Index of the first op of `kind` (optionally for a given viewId), else -1. */
const at = (ops: ViewOp<Zoom>[], kind: string, viewId?: string): number =>
  ops.findIndex(
    (o) =>
      o.kind === kind && (viewId === undefined || ('viewId' in o && o.viewId === viewId)),
  )

const actual = (
  attached: boolean,
  vis: boolean,
  bounds?: Bounds,
  extra?: Zoom,
): ActualView<Zoom> => ({ attached, visible: vis, ...(bounds ? { bounds } : {}), ...(extra ? { extra } : {}) })

/** Run one reconcile from empty so a test can start from a realistic state
 *  where a view is already attached+visible. */
const afterInitial = (views: DesiredView<Zoom>[]): ReconcilerState<Zoom> =>
  reconcile(createInitialState<Zoom>(), snap(0, 0, views)).state

describe('reconcile — stale rejection (edge-triggered corruption cannot be replayed)', () => {
  const prev = (): ReconcilerState<Zoom> => ({
    generation: 0,
    lastEpoch: 5,
    desired: new Map([['A', dv('A', visible(B(0, 0, 100, 100)), 0)]]),
    actual: new Map([['A', actual(true, true, B(0, 0, 100, 100))]]),
  })

  it('drops a snapshot whose epoch equals lastEpoch (no ops)', () => {
    const { ops } = reconcile(prev(), snap(0, 6 - 1, [dv('A', visible(B(9, 9, 9, 9)), 0)]))
    expect(ops).toEqual([])
  })

  it('drops a snapshot whose epoch is older than lastEpoch (no ops)', () => {
    const { ops } = reconcile(prev(), snap(0, 2, [dv('A', visible(B(9, 9, 9, 9)), 0)]))
    expect(ops).toEqual([])
  })

  it('does not let a stale snapshot pollute desired/actual', () => {
    const { state } = reconcile(prev(), snap(0, 5, [dv('A', visible(B(9, 9, 9, 9)), 0)]))
    // The stale frame tried to move A to 9,9,9,9 — it must be ignored.
    expect(state.desired.get('A')?.placement).toEqual(visible(B(0, 0, 100, 100)))
    expect(state.actual.get('A')?.bounds).toEqual(B(0, 0, 100, 100))
  })
})

describe('reconcile — generation reset (renderer restart rebuilds the table)', () => {
  const prev = (): ReconcilerState<Zoom> => ({
    generation: 0,
    lastEpoch: 5,
    desired: new Map([
      ['A', dv('A', visible(B(0, 0, 10, 10)), 0)],
      ['B', dv('B', visible(B(0, 0, 10, 10)), 1)],
    ]),
    actual: new Map([
      ['A', actual(true, true, B(0, 0, 10, 10))],
      ['B', actual(true, true, B(0, 0, 10, 10))],
    ]),
  })

  it('clears view ids that are absent from the new generation', () => {
    const { state } = reconcile(prev(), snap(1, 0, [dv('C', visible(B(0, 0, 20, 20)), 0)]))
    expect(state.desired.has('A')).toBe(false)
    expect(state.desired.has('B')).toBe(false)
    expect(state.actual.has('A')).toBe(false)
    expect(state.actual.has('B')).toBe(false)
    expect(state.generation).toBe(1)
  })

  it('attaches the new generation view', () => {
    const { ops } = reconcile(prev(), snap(1, 0, [dv('C', visible(B(0, 0, 20, 20)), 0)]))
    expect(at(ops, 'attach', 'C')).toBeGreaterThanOrEqual(0)
  })
})

describe('reconcile — diff-only (a stable declaration produces no work)', () => {
  it('emits no ops when the next snapshot repeats the current desired state', () => {
    const prev = afterInitial([dv('A', visible(B(0, 0, 100, 100)), 0)])
    const { ops } = reconcile(prev, snap(0, 1, [dv('A', visible(B(0, 0, 100, 100)), 0)]))
    expect(ops).toEqual([])
  })
})

describe('reconcile — bounds integerization (subpixel jitter is not an op)', () => {
  it('does not emit setBounds when bounds differ only sub-pixel', () => {
    const prev = afterInitial([dv('A', visible(B(0, 0, 100, 100)), 0)])
    const { ops } = reconcile(prev, snap(0, 1, [dv('A', visible(B(0.4, 0.4, 100.4, 100.4)), 0)]))
    expect(at(ops, 'setBounds', 'A')).toBe(-1)
  })

  it('emits setBounds when integerized bounds actually change', () => {
    const prev = afterInitial([dv('A', visible(B(0, 0, 100, 100)), 0)])
    const { ops } = reconcile(prev, snap(0, 1, [dv('A', visible(B(0, 0, 101, 100)), 0)]))
    expect(at(ops, 'setBounds', 'A')).toBeGreaterThanOrEqual(0)
  })
})

describe('reconcile — first show (position before mount, then order)', () => {
  it('emits setBounds strictly before attach for a newly shown view', () => {
    const { ops } = reconcile(
      createInitialState<Zoom>(),
      snap(0, 0, [dv('A', visible(B(1, 2, 3, 4)), 0)]),
    )
    const sb = at(ops, 'setBounds', 'A')
    const att = at(ops, 'attach', 'A')
    expect(sb).toBeGreaterThanOrEqual(0)
    expect(att).toBeGreaterThan(sb)
  })

  it('emits a reorder after the first attach (attach set changed)', () => {
    const { ops } = reconcile(
      createInitialState<Zoom>(),
      snap(0, 0, [dv('A', visible(B(1, 2, 3, 4)), 0)]),
    )
    expect(at(ops, 'reorder')).toBeGreaterThan(at(ops, 'attach', 'A'))
  })
})

describe('reconcile — hide is setVisible(false), never detach', () => {
  it('emits setVisible(false) and no detach when a view goes hidden', () => {
    const prev = afterInitial([dv('A', visible(B(0, 0, 100, 100)), 0)])
    const { ops } = reconcile(prev, snap(0, 1, [dv('A', hidden, 0)]))
    const sv = ops.find((o) => o.kind === 'setVisible' && o.viewId === 'A')
    expect(sv).toEqual({ kind: 'setVisible', viewId: 'A', visible: false })
    expect(kinds(ops)).not.toContain('detach')
  })
})

describe('reconcile — transient self-heal (a hidden blip never wedges a view)', () => {
  it('restores to attached+visible+bounds after visible→hidden→visible without re-attach', () => {
    // Step 1: first show.
    let state = reconcile(
      createInitialState<Zoom>(),
      snap(0, 0, [dv('A', visible(B(5, 5, 50, 50)), 0)]),
    ).state

    // Step 2: a transient hidden frame.
    const step2 = reconcile(state, snap(0, 1, [dv('A', hidden, 0)]))
    state = step2.state
    expect(step2.ops.find((o) => o.kind === 'setVisible' && o.viewId === 'A')).toEqual({
      kind: 'setVisible',
      viewId: 'A',
      visible: false,
    })
    // A blip must not tear the view down.
    expect(kinds(step2.ops)).not.toContain('detach')

    // Step 3: the level returns to visible — recovery is setVisible(true), no re-attach.
    const step3 = reconcile(state, snap(0, 2, [dv('A', visible(B(5, 5, 50, 50)), 0)]))
    expect(step3.ops.find((o) => o.kind === 'setVisible' && o.viewId === 'A')).toEqual({
      kind: 'setVisible',
      viewId: 'A',
      visible: true,
    })
    expect(at(step3.ops, 'attach', 'A')).toBe(-1)

    const a = step3.state.actual.get('A')
    expect(a?.attached).toBe(true)
    expect(a?.visible).toBe(true)
    expect(a?.bounds).toEqual(B(5, 5, 50, 50))
  })
})

describe('reconcile — fixed op order within one snapshot', () => {
  it('orders hide → setBounds(new) → attach(new) → reorder', () => {
    // X already attached+visible; Y is newly shown in the same snapshot while X hides.
    const prev = afterInitial([dv('X', visible(B(0, 0, 100, 100)), 0)])
    const { ops } = reconcile(
      prev,
      snap(0, 1, [dv('X', hidden, 0), dv('Y', visible(B(10, 10, 20, 20)), 1)]),
    )
    const hideX = at(ops, 'setVisible', 'X')
    const sbY = at(ops, 'setBounds', 'Y')
    const attY = at(ops, 'attach', 'Y')
    const reorder = at(ops, 'reorder')
    expect(hideX).toBeGreaterThanOrEqual(0)
    expect(sbY).toBeGreaterThan(hideX)
    expect(attY).toBeGreaterThan(sbY)
    expect(reorder).toBeGreaterThan(attY)
  })
})

describe('reconcile — layer reorder', () => {
  it('reorders by ascending layer when the attach set changes', () => {
    // A on top (layer 20), B on bottom (layer 10), both newly attached.
    const { ops } = reconcile(
      createInitialState<Zoom>(),
      snap(0, 0, [dv('A', visible(B(0, 0, 10, 10)), 20), dv('B', visible(B(0, 0, 10, 10)), 10)]),
    )
    const reorder = ops.find((o) => o.kind === 'reorder')
    expect(reorder).toBeDefined()
    // Ascending layer → bottom first, top last.
    expect(reorder && reorder.kind === 'reorder' && reorder.order).toEqual(['B', 'A'])
  })

  it('does not reorder when only bounds change (attach set unchanged)', () => {
    const prev = afterInitial([dv('A', visible(B(0, 0, 100, 100)), 0)])
    const { ops } = reconcile(prev, snap(0, 1, [dv('A', visible(B(5, 5, 100, 100)), 0)]))
    expect(kinds(ops)).not.toContain('reorder')
  })
})

describe('reconcile — extra passthrough (host specifics ride through)', () => {
  it('carries extra on the setBounds of a newly shown view', () => {
    const { ops } = reconcile(
      createInitialState<Zoom>(),
      snap(0, 0, [dv('A', visible(B(0, 0, 100, 100)), 0, { zoom: 2 })]),
    )
    const sb = ops.find((o) => o.kind === 'setBounds' && o.viewId === 'A')
    expect(sb && sb.kind === 'setBounds' && sb.extra).toEqual({ zoom: 2 })
  })

  it('emits setBounds carrying the new extra when only extra changes', () => {
    const prev = afterInitial([dv('A', visible(B(0, 0, 100, 100)), 0, { zoom: 1 })])
    const { ops } = reconcile(
      prev,
      snap(0, 1, [dv('A', visible(B(0, 0, 100, 100)), 0, { zoom: 3 })]),
    )
    const sb = ops.find((o) => o.kind === 'setBounds' && o.viewId === 'A')
    expect(sb && sb.kind === 'setBounds' && sb.extra).toEqual({ zoom: 3 })
  })
})

describe('reconcile — idempotent & pure', () => {
  it('returns identical ops when called twice with the same prev + snapshot', () => {
    const prev = afterInitial([dv('A', visible(B(0, 0, 100, 100)), 0)])
    const s = snap(0, 1, [dv('A', visible(B(9, 9, 30, 30)), 0)])
    const first = reconcile(prev, s)
    const second = reconcile(prev, s)
    expect(second.ops).toEqual(first.ops)
  })

  it('does not mutate prev.desired in place', () => {
    const prev = afterInitial([dv('A', visible(B(0, 0, 100, 100)), 0)])
    const before = prev.desired.get('A')?.placement
    reconcile(prev, snap(0, 1, [dv('A', visible(B(1, 1, 1, 1)), 0)]))
    expect(prev.desired.get('A')?.placement).toEqual(before)
  })

  it('returns a new state object and a new desired Map', () => {
    const prev = afterInitial([dv('A', visible(B(0, 0, 100, 100)), 0)])
    const { state } = reconcile(prev, snap(0, 1, [dv('A', visible(B(0, 0, 100, 100)), 0)]))
    expect(state).not.toBe(prev)
    expect(state.desired).not.toBe(prev.desired)
  })
})
