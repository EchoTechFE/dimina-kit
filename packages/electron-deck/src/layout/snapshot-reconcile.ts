// Main-side glue between an untrusted renderer snapshot and the level-triggered
// reconcile core. Two pure steps, each independently testable:
//
//   1. cleanSnapshot(raw, authorize) — validate + AUTHORIZE a raw wire payload
//      into a trusted CleanSnapshot (or reject it whole). The renderer publishes
//      a window-level table keyed by opaque slot tokens; this derives each view's
//      real identity from the token registry (never trusting the renderer-reported
//      viewId) and drops anything it can't authorize.
//
//   2. dispatchOps(ops, state, resolveApply) — collapse the reconciler's rich op
//      stream onto a host whose per-view sink is the two-state
//      `applyPlacement({visible:true,bounds} | {visible:false})` (an electron-deck
//      ViewHandle). z-order is compositor zone-fixed here, so reorder ops are
//      skipped; final geometry is read from the reconciled `actual` so a bare
//      restore (visibility flipped, bounds unchanged) still carries its bounds.
//
// Domain note: this file IS electron-deck-specific (it knows the ViewHandle sink
// shape), unlike the domain-neutral reconcile core it sits on top of.

import type { Bounds, Placement, ReconcilerState, ViewOp } from './placement-reconcile.js'

export interface CleanView {
  viewId: string
  placement: Placement
  layer: number
}

export interface CleanSnapshot {
  generation: number
  epoch: number
  views: CleanView[]
}

// Resolve a renderer-supplied slot token to the identity the host granted it.
// Returns null when the token is unknown OR not authorized to this sender — the
// caller builds an authorizer that has already bound the check to a senderId, so
// anti-spoof (a valid token replayed by a different wc) lives here as a null.
export type Authorizer = (slotToken: string) => { viewId: string; layer: number } | null

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isValidBounds(v: unknown): v is Bounds {
  if (v === null || typeof v !== 'object') return false
  const b = v as Record<string, unknown>
  // x/y may be ANY finite number (a negative origin is legitimate scroll-follow);
  // width/height must be finite AND non-negative (0 is a valid empty view; a
  // negative extent is garbage).
  return (
    isFiniteNumber(b.x) &&
    isFiniteNumber(b.y) &&
    isFiniteNumber(b.width) && b.width >= 0 &&
    isFiniteNumber(b.height) && b.height >= 0
  )
}

function isValidPlacement(v: unknown): v is Placement {
  if (v === null || typeof v !== 'object') return false
  const p = v as Record<string, unknown>
  if (p.visible === true) return isValidBounds(p.bounds)
  if (p.visible === false) return true
  return false
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0
}

// Read a view's slot token from the raw wire shape. The renderer stamps it into
// `extra.slotToken` (the reconcile core's per-view Extra channel).
function readSlotToken(rawView: Record<string, unknown>): string | null {
  const extra = rawView.extra
  if (extra === null || typeof extra !== 'object') return null
  const token = (extra as Record<string, unknown>).slotToken
  return typeof token === 'string' && token.length > 0 ? token : null
}

/**
 * Validate + authorize a raw renderer snapshot into a trusted CleanSnapshot.
 *
 * Returns null (REJECT — caller must NOT reconcile) when:
 *   - the payload is malformed (missing/!int generation/epoch, views not an array);
 *   - `views` is NON-EMPTY but every entry is dropped by authorization/validation
 *     — a fully-rejected snapshot must never be read as "the renderer wants
 *     everything detached" (that would tear down live views on a transient where
 *     tokens momentarily fail to resolve).
 *
 * Returns an EMPTY CleanSnapshot (not null) when `views` is genuinely empty — the
 * renderer removed all its views, a legitimate signal the caller reconciles into
 * detach ops.
 *
 * Each surviving view takes its `viewId`/`layer` from the AUTHORIZER, never from
 * the renderer-reported fields (a valid token must not be splice-able onto a
 * forged viewId to poison the reconciler key). Duplicate viewIds keep the first.
 */
// Authorize + validate ONE raw view into a CleanView, or null to drop it (not an
// object, no/unknown/unauthorized token, malformed placement, or a duplicate
// viewId already seen). Kept separate so cleanSnapshot stays a simple collect loop.
function cleanOneView(rawView: unknown, authorize: Authorizer, seen: Set<string>): CleanView | null {
  if (rawView === null || typeof rawView !== 'object' || Array.isArray(rawView)) return null
  const rv = rawView as Record<string, unknown>
  const token = readSlotToken(rv)
  if (token === null) return null
  const grant = authorize(token)
  if (grant === null) return null // unknown / unauthorized token
  if (!isValidPlacement(rv.placement)) return null
  if (seen.has(grant.viewId)) return null // duplicate viewId → keep the first
  seen.add(grant.viewId)
  return { viewId: grant.viewId, placement: rv.placement, layer: grant.layer }
}

export function cleanSnapshot(raw: unknown, authorize: Authorizer): CleanSnapshot | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const snap = raw as Record<string, unknown>
  if (!isNonNegInt(snap.generation) || !isNonNegInt(snap.epoch)) return null
  if (!Array.isArray(snap.views)) return null

  const rawViews = snap.views
  const views: CleanView[] = []
  const seen = new Set<string>()
  for (const rawView of rawViews) {
    const cleaned = cleanOneView(rawView, authorize, seen)
    if (cleaned) views.push(cleaned)
  }

  // A non-empty raw that fully fails authorization is rejected wholesale.
  if (rawViews.length > 0 && views.length === 0) return null

  return { generation: snap.generation, epoch: snap.epoch, views }
}

/**
 * Collapse reconcile ops onto a two-state per-view sink. Gathers the viewIds any
 * op touched (reorder excluded — deck z-order is compositor zone-fixed), then for
 * each reads the reconciled end-state from `state.actual`: attached+visible+bounds
 * → apply({visible:true,bounds}); otherwise apply({visible:false}). Reading from
 * `actual` (not the op itself) means a bare restore still carries its bounds.
 *
 * Each apply runs in its own try/catch: one throwing sink (e.g. a destroyed native
 * view) must not abort the rest of the dispatch.
 */
export function dispatchOps(
  ops: ViewOp[],
  state: ReconcilerState,
  resolveApply: (viewId: string) => ((p: Placement) => void) | null,
): void {
  const touched = new Set<string>()
  for (const op of ops) {
    if (op.kind === 'reorder') continue
    touched.add(op.viewId)
  }
  for (const viewId of touched) {
    const apply = resolveApply(viewId)
    if (!apply) continue
    const a = state.actual.get(viewId)
    const placement: Placement =
      a && a.attached && a.visible && a.bounds
        ? { visible: true, bounds: a.bounds }
        : { visible: false }
    try {
      apply(placement)
    } catch (err) {
      console.error(`[electron-deck] applyPlacement for view "${viewId}" threw:`, err)
    }
  }
}
