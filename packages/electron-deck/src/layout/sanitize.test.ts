/**
 * `sanitizeFlexibleWeights` (flexible-weight healing).
 *
 * Contract spec for `sanitizeFlexibleWeights`, exported from `./index.js`.
 *
 * CONTRACT (pinned here; the implementation MUST match these):
 *
 *  1. PURE: returns a NEW tree; the input is NEVER mutated.
 *  2. Walks EVERY split node in the tree (recursively, to any nesting depth).
 *  3. For each split, the "FLEXIBLE" children are those whose constraint is
 *     `null` (or whose split carries no `constraints` array at all). A flexible
 *     child whose weight `sizes[i]` is <= 0 (or below a tiny positive threshold)
 *     is HEALED — its weight is raised to a sensible MINIMUM POSITIVE value.
 *  4. PX-SIZED children (constraint NON-null — `fixedPx` OR `minPx`) keep their
 *     weight UNTOUCHED, even if it is 0 / negative.
 *  5. An already-healthy tree (every flexible weight already > the threshold)
 *     comes back SEMANTICALLY IDENTICAL: weights unchanged (serialize-equal).
 *
 * The threshold + the exact post-heal weight are the implementer's choice; the
 * tests only pin the OBSERVABLE contract: healed flexible weight > 0, px weights
 * frozen, purity, recursion, healthy-tree no-op. A traversal helper
 * (`flexibleWeights`) collects every split's flexible-child weights so "all
 * flexible weights are now > 0" is asserted across the WHOLE tree, not one node.
 */
import { describe, expect, it } from 'vitest'
import { sanitizeFlexibleWeights, serializeLayout } from './index.js'
import type {
  LayoutNode,
  LayoutTree,
  SizeConstraint,
  SplitNode,
} from './types.js'

// ── builders ──────────────────────────────────────────────────────────────

function tabs(id: string, panels: string[]): LayoutNode {
  return { kind: 'tabs', id, panels, active: panels[0]! }
}

function tree(root: LayoutNode): LayoutTree {
  return { version: 1, root }
}

/**
 * A row/column split with explicit per-child weights and OPTIONAL per-child
 * constraints (null = flexible). `constraints` omitted entirely => every child
 * is flexible (legacy weight-only split).
 */
function split(
  id: string,
  orientation: 'row' | 'column',
  children: LayoutNode[],
  sizes: number[],
  constraints?: (SizeConstraint | null)[],
): SplitNode {
  const base: SplitNode = { kind: 'split', id, orientation, children, sizes }
  return constraints ? { ...base, constraints } : base
}

// ── traversal helper: collect every FLEXIBLE child's weight, tree-wide ──────
//
// A child i is flexible when the split has no `constraints` array, or
// `constraints[i]` is null/undefined. PX-sized children (non-null constraint)
// are EXCLUDED — their weights are out of scope for the heal.
function flexibleWeights(t: LayoutTree): number[] {
  const out: number[] = []
  const walk = (n: LayoutNode): void => {
    if (n.kind !== 'split') return
    n.children.forEach((child, i) => {
      const c = n.constraints ? n.constraints[i] ?? null : null
      if (c === null) out.push(n.sizes[i]!)
      walk(child)
    })
  }
  walk(t.root)
  return out
}

/** The weight at a named split's child index, after a heal. */
function weightAt(t: LayoutTree, splitId: string, index: number): number {
  let found: number | undefined
  const walk = (n: LayoutNode): void => {
    if (n.kind !== 'split') return
    if (n.id === splitId) found = n.sizes[index]
    n.children.forEach(walk)
  }
  walk(t.root)
  if (found === undefined) throw new Error(`split ${splitId} not found`)
  return found
}

function frozenCopy(t: LayoutTree): LayoutTree {
  return JSON.parse(JSON.stringify(t)) as LayoutTree
}

// ── cases ───────────────────────────────────────────────────────────────────

describe('sanitizeFlexibleWeights — heals non-positive flexible weights', () => {
  it('a row split with flexible weights [0, 100] heals the 0 to a positive value, keeps the other', () => {
    // Bug guarded: a persisted layout where a divider was dragged to collapse a
    // flexible pane to weight 0 leaves it with NO share of leftover space —
    // restoring it should revive that pane to a usable minimum, not a 0-width
    // sliver.
    const t = tree(
      split('s0', 'row', [tabs('g0', ['a']), tabs('g1', ['b'])], [0, 100]),
    )
    const out = sanitizeFlexibleWeights(t)

    // child 0 healed to a positive (and sensible-minimum) weight.
    expect(weightAt(out, 's0', 0)).toBeGreaterThan(0)
    // child 1 survives as a positive weight (relation stays sane; exact value
    // is the implementer's choice, but it must not have been zeroed).
    expect(weightAt(out, 's0', 1)).toBeGreaterThan(0)
    // every flexible weight tree-wide is now strictly positive.
    expect(flexibleWeights(out).every((w) => w > 0)).toBe(true)
  })

  it('a negative flexible weight [-5, 50] is raised to a positive value', () => {
    const t = tree(
      split('s0', 'row', [tabs('g0', ['a']), tabs('g1', ['b'])], [-5, 50]),
    )
    const out = sanitizeFlexibleWeights(t)

    expect(weightAt(out, 's0', 0)).toBeGreaterThan(0)
    expect(weightAt(out, 's0', 1)).toBeGreaterThan(0)
    expect(flexibleWeights(out).every((w) => w > 0)).toBe(true)
  })

  it('a healthy tree [60, 40] comes back semantically identical (sizes unchanged)', () => {
    const t = tree(
      split('s0', 'row', [tabs('g0', ['a']), tabs('g1', ['b'])], [60, 40]),
    )
    const out = sanitizeFlexibleWeights(t)

    // weights untouched, and the whole tree serializes to the same string.
    expect(weightAt(out, 's0', 0)).toBe(60)
    expect(weightAt(out, 's0', 1)).toBe(40)
    expect(serializeLayout(out)).toBe(serializeLayout(t))
  })

  it('ONLY the flexible child heals; the px-sized (minPx) sibling weight is left untouched', () => {
    // split: child 0 = { minPx: 375 } weight 1 (px-sized), child 1 = null weight
    // 0 (flexible). Only index 1 heals; index 0's weight stays exactly 1.
    const t = tree(
      split(
        's0',
        'row',
        [tabs('g0', ['a']), tabs('g1', ['b'])],
        [1, 0],
        [{ minPx: 375 }, null],
      ),
    )
    const out = sanitizeFlexibleWeights(t)

    // px child weight FROZEN.
    expect(weightAt(out, 's0', 0)).toBe(1)
    // flexible child healed.
    expect(weightAt(out, 's0', 1)).toBeGreaterThan(0)
    // the only flexible child tree-wide (index 1) is now positive.
    expect(flexibleWeights(out)).toEqual([weightAt(out, 's0', 1)])
    expect(flexibleWeights(out).every((w) => w > 0)).toBe(true)
  })

  it('recurses: a 0-weight flexible child of a NESTED split is healed', () => {
    // root row split [sim(minPx) | nested column split]; the nested split has a
    // flexible child at weight 0 that must heal even though it is one level deep.
    const nested = split(
      'inner',
      'column',
      [tabs('g-editor', ['editor']), tabs('g-debug', ['debug'])],
      [70, 0],
    )
    const t = tree(
      split(
        'root',
        'row',
        [tabs('g-sim', ['sim']), nested],
        [1, 6],
        [{ minPx: 375 }, null],
      ),
    )
    const out = sanitizeFlexibleWeights(t)

    // the nested 0-weight flexible child healed.
    expect(weightAt(out, 'inner', 1)).toBeGreaterThan(0)
    // its healthy sibling stayed positive; every flexible weight is positive.
    expect(weightAt(out, 'inner', 0)).toBeGreaterThan(0)
    expect(flexibleWeights(out).every((w) => w > 0)).toBe(true)
  })

  it('multiple flexible children all at 0 [0, 0, 0] all heal to positive (degenerate even split ok)', () => {
    const t = tree(
      split(
        's0',
        'row',
        [tabs('g0', ['a']), tabs('g1', ['b']), tabs('g2', ['c'])],
        [0, 0, 0],
      ),
    )
    const out = sanitizeFlexibleWeights(t)

    expect(weightAt(out, 's0', 0)).toBeGreaterThan(0)
    expect(weightAt(out, 's0', 1)).toBeGreaterThan(0)
    expect(weightAt(out, 's0', 2)).toBeGreaterThan(0)
    expect(flexibleWeights(out)).toHaveLength(3)
    expect(flexibleWeights(out).every((w) => w > 0)).toBe(true)
  })

  it('is PURE — the input tree is not mutated', () => {
    const t = tree(
      split('s0', 'row', [tabs('g0', ['a']), tabs('g1', ['b'])], [0, 100]),
    )
    const before = frozenCopy(t)
    const out = sanitizeFlexibleWeights(t)

    // input untouched (deep-equal to its pre-call snapshot)...
    expect(t).toEqual(before)
    // ...and a fresh object was returned (not the same reference).
    expect(out).not.toBe(t)
    // sanity: the heal DID change the output (so purity isn't trivially "no-op").
    expect((out.root as SplitNode).sizes[0]).toBeGreaterThan(0)
    expect((t.root as SplitNode).sizes[0]).toBe(0)
  })
})
