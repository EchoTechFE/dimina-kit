// Level-triggered reconciler that converges a host's native-view mount state
// toward a renderer-declared desired placement. The renderer is the single
// source of truth: it publishes a window-level snapshot (one monotonic epoch
// per commit tick, one generation per renderer lifetime); this pure core diffs
// the snapshot against the last-applied actual state and emits an ordered op
// list. A lost or spurious per-view edge is self-correcting because every
// reconcile re-derives the whole actual state from the desired snapshot, so the
// worst case degrades from a stuck view to a one-tick flicker.
//
// Domain-neutral: view ids are opaque strings and per-view host specifics ride
// on the `Extra` type parameter (e.g. a simulator's zoom), so the same core
// serves any electron-deck host. Side-effect free — it only computes ops; a
// thin host executor applies them. See devtools docs/view-placement-reconciler.md.

import type { Bounds, Placement } from '@dimina-kit/view-anchor'

export type { Bounds, Placement }

export interface DesiredView<Extra = unknown> {
  viewId: string
  placement: Placement
  // z-order; larger paints on top.
  layer: number
  // Host-specific extras carried through to setBounds (e.g. simulator zoom).
  extra?: Extra
}

export interface PlacementSnapshot<Extra = unknown> {
  // Renderer lifetime id; a higher generation resets the whole table.
  generation: number
  // Window-level monotonic tick; all views in one commit share one epoch.
  epoch: number
  // The full desired table for this tick (a level, not a delta).
  views: DesiredView<Extra>[]
}

export type ViewOp<Extra = unknown> =
  | { kind: 'setBounds'; viewId: string; bounds: Bounds; extra?: Extra }
  | { kind: 'attach'; viewId: string }
  | { kind: 'setVisible'; viewId: string; visible: boolean }
  | { kind: 'detach'; viewId: string }
  | { kind: 'reorder'; order: string[] }

export interface ActualView<Extra = unknown> {
  attached: boolean
  visible: boolean
  bounds?: Bounds
  extra?: Extra
}

export interface ReconcilerState<Extra = unknown> {
  generation: number
  lastEpoch: number
  desired: Map<string, DesiredView<Extra>>
  actual: Map<string, ActualView<Extra>>
}

export function createInitialState<Extra = unknown>(): ReconcilerState<Extra> {
  return {
    generation: 0,
    lastEpoch: -1,
    desired: new Map(),
    actual: new Map(),
  }
}

// Integer-snap so sub-pixel jitter (100.4 vs 100.6) never emits a setBounds op.
function roundBounds(b: Bounds): Bounds {
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.round(b.width),
    height: Math.round(b.height),
  }
}

function sameBounds(a: Bounds | undefined, b: Bounds | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

function sameExtra<Extra>(a: Extra | undefined, b: Extra | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

function visibleBounds<Extra>(dv: DesiredView<Extra>): Bounds {
  // Caller guarantees dv.placement.visible === true.
  return roundBounds((dv.placement as { visible: true; bounds: Bounds }).bounds)
}

function setBoundsOp<Extra>(id: string, dv: DesiredView<Extra>): ViewOp<Extra> {
  return {
    kind: 'setBounds',
    viewId: id,
    bounds: visibleBounds(dv),
    ...(dv.extra !== undefined ? { extra: dv.extra } : {}),
  }
}

// Attached views ordered bottom→top by layer; id is a stable tie-break so a
// same-layer set never reorders spuriously.
function computeOrder<Extra>(
  actual: Map<string, ActualView<Extra>>,
  desired: Map<string, DesiredView<Extra>>,
): string[] {
  const attached = [...actual.entries()]
    .filter(([, a]) => a.attached)
    .map(([id]) => id)
  attached.sort((id1, id2) => {
    const l1 = desired.get(id1)?.layer ?? 0
    const l2 = desired.get(id2)?.layer ?? 0
    if (l1 !== l2) return l1 - l2
    return id1 < id2 ? -1 : id1 > id2 ? 1 : 0
  })
  return attached
}

// A view declared in the snapshot no longer being present means it must be
// removed: detach any still-attached actual whose id left the desired table.
function scanDetached<Extra>(
  actual: Map<string, ActualView<Extra>>,
  desired: Map<string, DesiredView<Extra>>,
  ops: ViewOp<Extra>[],
): boolean {
  let attachSetChanged = false
  for (const id of [...actual.keys()]) {
    if (desired.has(id)) continue
    if (actual.get(id)?.attached) {
      ops.push({ kind: 'detach', viewId: id })
      attachSetChanged = true
    }
    actual.delete(id)
  }
  return attachSetChanged
}

interface Buckets {
  hides: string[]
  shows: string[]
  restores: string[]
  updates: string[]
}

// Classify one desired view against the current actual, WRITE its next actual,
// and record which op bucket(s) it lands in. Returns whether it newly attached
// (which changes the attach set → forces a reorder).
function classifyView<Extra>(
  id: string,
  dv: DesiredView<Extra>,
  actual: Map<string, ActualView<Extra>>,
  buckets: Buckets,
): boolean {
  const a = actual.get(id)
  if (!dv.placement.visible) {
    if (a?.attached && a.visible) buckets.hides.push(id)
    actual.set(id, { attached: a?.attached ?? false, visible: false, bounds: a?.bounds, extra: a?.extra })
    return false
  }
  const bounds = visibleBounds(dv)
  if (!a || !a.attached) {
    buckets.shows.push(id)
    actual.set(id, { attached: true, visible: true, bounds, extra: dv.extra })
    return true
  }
  if (!a.visible) buckets.restores.push(id)
  if (!sameBounds(a.bounds, bounds) || !sameExtra(a.extra, dv.extra)) buckets.updates.push(id)
  actual.set(id, { attached: true, visible: true, bounds, extra: dv.extra })
  return false
}

// Fixed op order avoids attach-then-resize / squashed-toolbar flicker:
// detach → hide → (setBounds→attach per new view) → restore visibility →
// update bounds of already-visible views → one reorder if the attach set moved.
function emitOps<Extra>(
  desired: Map<string, DesiredView<Extra>>,
  actual: Map<string, ActualView<Extra>>,
  buckets: Buckets,
  ops: ViewOp<Extra>[],
  attachSetChanged: boolean,
): void {
  for (const id of buckets.hides) ops.push({ kind: 'setVisible', viewId: id, visible: false })
  buckets.shows.sort((a, b) => (desired.get(a)?.layer ?? 0) - (desired.get(b)?.layer ?? 0))
  for (const id of buckets.shows) {
    ops.push(setBoundsOp(id, desired.get(id)!))
    ops.push({ kind: 'attach', viewId: id })
  }
  for (const id of buckets.restores) ops.push({ kind: 'setVisible', viewId: id, visible: true })
  for (const id of buckets.updates) ops.push(setBoundsOp(id, desired.get(id)!))
  if (attachSetChanged) ops.push({ kind: 'reorder', order: computeOrder(actual, desired) })
}

export function reconcile<Extra = unknown>(
  prev: ReconcilerState<Extra>,
  snapshot: PlacementSnapshot<Extra>,
): { state: ReconcilerState<Extra>; ops: ViewOp<Extra>[] } {
  // Reject a snapshot from an OLDER generation outright. Main assigns strictly
  // monotonic per-renderer generations, so a lower generation is a late in-flight
  // snapshot from a previous renderer lifetime; honoring it would let it poison
  // lastEpoch/actual AFTER a higher-generation reset already landed (e.g. a
  // pre-reload frame arriving on the same wc after reload bumped the generation).
  if (snapshot.generation < prev.generation) {
    return { state: { ...prev }, ops: [] }
  }

  // Reject a stale snapshot (same generation, epoch not advanced) without
  // touching desired/actual. New object so callers never alias prev.
  if (snapshot.generation === prev.generation && snapshot.epoch <= prev.lastEpoch) {
    return { state: { ...prev }, ops: [] }
  }

  // A higher generation is a fresh renderer: forget the old actual entirely so
  // stale ids can't linger, then rebuild from the snapshot.
  const resetGeneration = snapshot.generation > prev.generation
  const actual = new Map<string, ActualView<Extra>>()
  if (!resetGeneration) {
    for (const [id, a] of prev.actual) actual.set(id, { ...a })
  }

  const desired = new Map<string, DesiredView<Extra>>()
  for (const v of snapshot.views) desired.set(v.viewId, v)

  const ops: ViewOp<Extra>[] = []
  let attachSetChanged = scanDetached(actual, desired, ops)

  const buckets: Buckets = { hides: [], shows: [], restores: [], updates: [] }
  for (const [id, dv] of desired) {
    if (classifyView(id, dv, actual, buckets)) attachSetChanged = true
  }

  emitOps(desired, actual, buckets, ops, attachSetChanged)

  return {
    state: {
      generation: snapshot.generation,
      lastEpoch: snapshot.epoch,
      desired,
      actual,
    },
    ops,
  }
}
